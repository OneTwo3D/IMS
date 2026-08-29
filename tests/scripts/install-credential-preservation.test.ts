/**
 * o3d-2sm1.5 r38 — THE INSTALLER USED TO ROTATE A LIVE DATABASE CREDENTIAL BY DEFAULT.
 *
 * THE FINDING. scripts/install.sh took the fenced cutover path, called
 * provision_database_role_and_privileges(), and that function ALTERed the password of a role it
 * had NOT created — before `prisma generate`, before `npm run build`, and long before
 * `systemctl stop`. The predecessor was still serving, still holding its old DATABASE_URL. Its
 * established sessions survived; every NEW or RECYCLED connection it opened for the rest of the
 * build hit "password authentication failed". If the build then failed, the script deliberately
 * left that service running — by then possibly unable to serve at all.
 *
 * AND IT WAS THE ORDINARY PATH, NOT AN EXOTIC ONE. The local-database prompt defaulted
 * DB_PASSWORD to `openssl rand -hex 16`, a NEW secret on every invocation, so an operator
 * pressing Enter through a routine re-install rotated the live credential as a side effect of
 * running the script. REDIS_URL and REDIS_PASSWORD had recovered their installed values for
 * rounds; DATABASE_URL had not.
 *
 * WHAT THIS FILE PROVES, against real PostgreSQL clusters:
 *
 *   1. an ordinary re-install preserves the installed credential, and a client connected before
 *      the run is still connected and still authenticating after it — INCLUDING new connections,
 *      which is the pool turnover the finding is actually about;
 *   2. an explicit rotation changes NOTHING on this side of the stop, and the credential the
 *      build is handed is the OLD one — the one the server actually has;
 *   3. the rotation happens inside the stopped, fenced window, and ${APP_DIR}/.env follows it in
 *      the same step, in exactly one line;
 *   4. the rotation's window guards fail closed rather than open;
 *   5. the recovery is scoped to one role on one endpoint, so it cannot hand a password to a
 *      connection it does not belong to;
 *   6. the SHIPPED script has the order these tests run.
 *
 * REAL CLUSTERS, FOR THE REASON install-database-endpoint-binding.test.ts GIVES: every assertion
 * here is about whether a SERVER still accepts a password. A fake psql would assert that this
 * file's author can write "authentication failed" twice.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  INSTALL_SOURCE,
  type HeldSession,
  REINSTALL_BODY,
  connectAs,
  envDatabaseUrl,
  holdSession,
  readVar,
  runShipped,
  seedLiveInstallation,
  writeInstalledEnv,
} from './install-shell-rig.ts'
import { type Cluster, currentUser, freePort, shippedFunction, startCluster } from './real-postgres-cluster.ts'

// ---------------------------------------------------------------------------
// 1. THE LOAD-BEARING ONE: an ordinary re-install over a live database
// ---------------------------------------------------------------------------

test('r38: an ordinary re-install preserves the installed credential across the whole pre-stop window', async () => {
  // THE FINDING, RUN AS THE ROUTINE CASE. No password is supplied on the invocation at all —
  // which under --non-interactive, and under an operator pressing Enter, is the same thing. Before
  // r38 that meant `openssl rand -hex 16`, an ALTER USER, and a live service that could no longer
  // open a connection.
  //
  // THE PROOF IS TAKEN THREE WAYS, because only the third is the finding:
  //   * a session opened BEFORE the run is still alive and still answering after it — an
  //     already-authenticated backend, which even the broken build kept;
  //   * a FRESH connection with the live password succeeds — the pool turnover the finding names,
  //     and the thing the broken build refused;
  //   * the URL this run composed, which is what MIGRATION_DATABASE_URL hands `prisma generate`
  //     and `npm run build`, opens a connection of its own.
  //
  // MUTATION ROUTES (each measured by making the change and re-running, and the co-failures
  // below are what was OBSERVED rather than what was expected):
  //   1. stop recovering — force DB_PASSWORD_INSTALLED="" at the top of prompt_db_password(),
  //      which is r37's `openssl rand -hex 16` default reached by the shortest edit. This test
  //      fails on its composed-URL assertion, and so do tests 2, 3 and 4, because every one of
  //      them is a statement about a run that knows what the installed credential was. Test 5,
  //      which is about a connection that has none, and test 6, which reads the source, stay
  //      green.
  //   2. restore the r37 ALTER inside provision_database_role_and_privileges(). The fresh
  //      connection with the live password is refused and this test fails on it; tests 2, 4 and
  //      6 fail as well, along with the adopted-fence test in
  //      install-database-endpoint-binding.test.ts. Tests 3 and 5 stay green.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  let held: HeldSession | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // The predecessor, connected and serving before the installer starts.
    held = await holdSession(cluster, 'imsuser', 'live-password', 'one_two_inventory')

    const run = runShipped(
      {
        APP_DIR: root,
        APP_USER: currentUser(),
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      REINSTALL_BODY,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /ROLE_PREEXISTED=true/, 'precondition: the role was already there, so an ALTER was possible')
    assert.match(run.output, /ROTATION_PENDING=false/, 'a re-install that was not asked to change anything asks for no rotation')
    assert.match(run.output, /ROTATED=false/, 'and nothing rotated')

    // THE ASSERTION THE FINDING TURNS ON. A NEW connection, which is what a recycled pool member
    // is, with the credential the live installation holds.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'a NEW connection with the installed credential must still authenticate: this is the pool turnover the finding is about',
    )

    // And the credential the build is handed is that same working one.
    const composed = readVar(run.output, 'COMPOSED_URL')
    assert.equal(
      composed,
      `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`,
      'the URL handed to prisma generate and npm run build must be the credential the server has',
    )
    assert.equal(connectAs(cluster, composed), 'build-connected', 'and it must actually open a connection')

    // AND SO DOES THE FILE THE PREDECESSOR WOULD RESTART FROM. install.sh writes .env before the
    // build, and a run that dies at the build leaves the old service up with that file as its
    // environment — so a .env naming a credential the server does not have is the same outage one
    // reboot later.
    const written = envDatabaseUrl(root)
    assert.equal(written, composed, 'the environment file written before the build names the same credential the run is using')
    assert.equal(connectAs(cluster, written), 'build-connected', 'and that credential authenticates')

    // The session that was open throughout is still the same session, and still authenticated.
    assert.ok(held.alive(), 'the predecessor process must not have been dropped during the run')
    const finished = await held.finish()
    assert.equal(finished.code, 0, `the held session must end cleanly: ${finished.stdout}${finished.stderr}`)
    assert.match(finished.stdout, /session-opened/, 'precondition: it really was connected before the run')
    assert.match(finished.stdout, /still-authenticated/, 'and it was still able to issue statements after it')
  } finally {
    await held?.finish().catch(() => undefined)
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. An EXPLICIT rotation: nothing moves before the stop, and the build keeps a working credential
// ---------------------------------------------------------------------------

test('r38: an explicit rotation changes nothing before the stop, and the build gets the OLD credential', async () => {
  // THE ORDERING CONSTRAINT r37 ESTABLISHED, HONOURED. The build runs BEFORE the stop by design,
  // so that a release which will not compile costs no outage, and it is handed DATABASE_URL. A
  // rotation therefore cannot simply move later unless something says which credential the build
  // uses. It does: DB_PASSWORD_EFFECTIVE stays the INSTALLED password until the ALTER happens, so
  // DATABASE_URL, ${APP_DIR}/.env and MIGRATION_DATABASE_URL all name a credential that works.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make classify_database_credential_rotation() set DB_PASSWORD_EFFECTIVE="${DB_PASSWORD}"
  //      on the rotation branch — i.e. compose the URL from the target password, which is what
  //      the pre-r38 script effectively did. The composed URL carries the credential the server
  //      does not have, connectAs() is refused, and this test fails on it. Tests 3 and 4 fail
  //      too, because both of them run this same classification before doing their own work;
  //      tests 1, 5 and 6 stay green, as does every test in the other two installer files.
  //   2. restore the r37 ALTER inside provision_database_role_and_privileges(). The live password
  //      stops working and this test fails on its live-credential assertion; test 1 fails too,
  //      which is right — both are statements about the same defect.
  //   3. stop recovering the installed credential (route 1 of test 1): ROTATION_PENDING is never
  //      set, and this test fails on that assertion.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  let held: HeldSession | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    held = await holdSession(cluster, 'imsuser', 'live-password', 'one_two_inventory')

    const run = runShipped(
      {
        APP_DIR: root,
        APP_USER: currentUser(),
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        // The operator asks for a rotation, by supplying a password that is not the installed one.
        DB_PASSWORD: 'rotated-secret',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      REINSTALL_BODY,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /ROTATION_PENDING=true/, 'a different password is a rotation request')
    assert.match(run.output, /ROTATED=false/, 'and it has NOT happened yet: nothing has been stopped')

    // The server still has the credential its clients hold...
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'the live credential must still authenticate for the whole pre-stop window',
    )
    // ...and does NOT have the new one.
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and the requested password must not have reached the server yet',
    )

    // WHICH CREDENTIAL THE BUILD USES, STATED AND PROVEN: the old one.
    const composed = readVar(run.output, 'COMPOSED_URL')
    assert.equal(
      composed,
      `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`,
      'the build is handed the installed credential, not the one being rotated to',
    )
    assert.equal(connectAs(cluster, composed), 'build-connected', 'and it opens a connection, so the build can run')

    const written = envDatabaseUrl(root)
    assert.equal(written, composed, 'and the environment file written for the build names it too')
    assert.equal(connectAs(cluster, written), 'build-connected', 'so a predecessor restarted from that file would still work')

    assert.ok(held.alive(), 'the predecessor must still be connected')
    const finished = await held.finish()
    assert.equal(finished.code, 0, `${finished.stdout}${finished.stderr}`)
    assert.match(finished.stdout, /still-authenticated/, 'and still able to work')
  } finally {
    await held?.finish().catch(() => undefined)
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The rotation itself, inside the window
// ---------------------------------------------------------------------------

test('r38: the rotation happens inside the stopped, fenced window and moves exactly one .env line', async () => {
  // WHAT AN EXPLICIT ROTATION NOW DOES. Same run as test 2, continued past the point where
  // install.sh has installed the reboot fence, fenced cron, stopped the service, confirmed the
  // port is free, raised the connection fence and had check-db-writers.mjs confirm no other
  // backend. FENCE_ARMED and DB_FENCE_UP are what the shipped script has set by then.
  //
  // THE FILE IS RE-WRITTEN, NOT EDITED. install.sh owns ${APP_DIR}/.env and holds every value in
  // it, so the rotation calls the same write_app_env_file() the pre-build write used rather than
  // reaching into a file the application account owns — which is what
  // tests/scripts/deploy-order.test.ts forbids, and rightly. The snapshot taken here is therefore
  // the SHIPPED writer's own output before the rotation, and the comparison is between two runs
  // of the same function: everything except the credential has to be identical.
  //
  // MUTATION ROUTES (each measured by making the change and re-running; each fails THIS TEST
  // ALONE across both installer test files):
  //   1. delete the write_app_env_file() call from rotate_database_password_in_fenced_window().
  //      The server has the new password and .env still names the old one; the changed-line
  //      assertion fails.
  //   2. delete the DATABASE_URL recomposition line above that call. The file is re-written from
  //      a DATABASE_URL that still carries the old password, so nothing changes in it and the
  //      same assertion fails — this is why the two statements sit together.
  //   3. make the ALTER a no-op (`SELECT 1;`). The new password never reaches the server and the
  //      new-credential assertion fails.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const adminUrl = `postgresql://deployadmin:admin-password@127.0.0.1:${cluster.port}/one_two_inventory`
    const run = runShipped(
      {
        APP_DIR: root,
        APP_USER: currentUser(),
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        DB_USER: 'imsuser',
        DB_PASSWORD: 'rotated-secret',
        IMS_PG_SOCKET_DIR: cluster.socket,
        // Carried through the heredoc so the comparison below can prove the privileged connection
        // — the one the fence itself is held with — survives the second write untouched.
        DEPLOY_ADMIN_DATABASE_URL: adminUrl,
      },
      `${REINSTALL_BODY}
        # The environment file as it stands for the whole build window.
        cp "\${APP_DIR}/.env" "\${APP_DIR}/env.during-build"
        # What install.sh has done by the time it calls this: stopped, fenced, drained.
        FENCE_ARMED=true
        DB_FENCE_UP=true
        rotate_database_password_in_fenced_window
        echo "FINAL_URL=\${DATABASE_URL}"
        echo "FINAL_ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
        echo "FINAL_PENDING=\${DB_PASSWORD_ROTATION_PENDING}"
      `,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /FINAL_ROTATED=true/, 'the rotation happened')
    assert.match(run.output, /FINAL_PENDING=false/, 'and is no longer pending, so nothing can perform it twice')

    // The server now has the new credential and not the old one.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      '1',
      'the requested password must be the one the server has',
    )
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and the old one must be gone — otherwise the rotation did nothing',
    )

    // PRECONDITION: the file that stood through the build named the OLD credential, so this
    // comparison is between two DIFFERENT states and not between a file and itself.
    assert.equal(
      envDatabaseUrl(root, 'env.during-build'),
      `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`,
      'precondition: the build window ran on the installed credential',
    )

    // ...AND THE ROTATION MOVED EXACTLY ONE LINE OF IT.
    const before = readFileSync(join(root, 'env.during-build'), 'utf8').split('\n')
    const after = readFileSync(join(root, '.env'), 'utf8').split('\n')
    assert.equal(after.length, before.length, 'no line may be added or dropped')
    const changed = before.map((line, index) => [line, after[index]] as const).filter(([a, b]) => a !== b)
    assert.equal(changed.length, 1, `exactly one line may change: ${JSON.stringify(changed)}`)
    assert.equal(
      changed[0][1],
      `DATABASE_URL=postgresql://imsuser:rotated-secret@127.0.0.1:${cluster.port}/one_two_inventory`,
      'and it is DATABASE_URL, carrying the new credential',
    )
    assert.equal(
      readVar(run.output, 'FINAL_URL'),
      changed[0][1].slice('DATABASE_URL='.length),
      'the run and the file must name the same URL',
    )
    assert.match(
      readFileSync(join(root, '.env'), 'utf8'),
      new RegExp(`^DEPLOY_ADMIN_DATABASE_URL=${adminUrl.replace(/[.]/g, '\\.')}$`, 'm'),
      'the deploy admin connection — the one the fence itself is held with — must be untouched',
    )
    assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600, 'and the rewritten file must still be mode 600')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The window guards
// ---------------------------------------------------------------------------

test('r38: the rotation refuses outside the stopped, fenced window and leaves the credential alone', async () => {
  // A GUARD NOBODY HAS SEEN FAIL IS NOT A GUARD. Both refusals are reached here, on a real
  // server, and the credential is asserted afterwards — the r38 defect is precisely a rotation
  // that ran where these now refuse.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `${FENCE_ARMED} || die` line: the first case exits 0, ALTERs the password,
  //      and this test fails on both its status assertion and its live-credential assertion —
  //      ALONE in both files. No other test sets FENCE_ARMED=false and then rotates.
  //   2. delete the `${DB_FENCE_UP} || die` line: the second case exits 0 and this test fails the
  //      same way, again alone.
  //   3. restore the r37 ALTER in provision_database_role_and_privileges(), or stop recovering
  //      the installed credential: this test fails on its live-credential assertion too, because
  //      the refusals it exercises are only meaningful over a role that still has its password.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const vars = {
      APP_DIR: root,
      APP_USER: currentUser(),
      DB_HOST: '127.0.0.1',
      DB_PORT: String(cluster.port),
      DB_NAME: 'one_two_inventory',
      DB_USER: 'imsuser',
      DB_PASSWORD: 'rotated-secret',
      IMS_PG_SOCKET_DIR: cluster.socket,
    }

    const nothingStopped = runShipped(vars, `${REINSTALL_BODY}
      FENCE_ARMED=false
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.equal(nothingStopped.status, 9, `a rotation with nothing stopped must refuse:\n${nothingStopped.output}`)
    assert.doesNotMatch(nothingStopped.output, /ROTATED_ANYWAY/, 'and must not continue past the refusal')
    assert.match(nothingStopped.output, /has not stopped anything/, 'for the reason the finding names')
    assert.match(nothingStopped.output, /password is UNCHANGED/, 'and it says what state the role is in')

    const nothingFenced = runShipped(vars, `${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=false
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.equal(nothingFenced.status, 9, `a rotation with no fence must refuse:\n${nothingFenced.output}`)
    assert.doesNotMatch(nothingFenced.output, /ROTATED_ANYWAY/, 'and must not continue past the refusal')
    assert.match(nothingFenced.output, /connection fence is NOT up/, 'for the reason the finding names')

    // AND BOTH REFUSALS ARE TRUE: the role still has the password its clients hold.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'a refusal that says the password is unchanged has to be right about that',
    )
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and nothing may have half-applied the rotation',
    )
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The recovery is about ONE connection
// ---------------------------------------------------------------------------

test('r38: the installed password is recovered only for the same role, host, port and database', async () => {
  // A PASSWORD IS NOT A PROPERTY OF A HOST. Recovering the previous run's secret after the
  // operator has changed DB_USER, DB_HOST, DB_PORT or DB_NAME would hand a NEW role somebody
  // else's live credential — and would make a genuine first password look like a rotation of a
  // connection this run has never seen. So all four are compared, and anything that differs
  // answers "nothing installed", which takes the first-install path.
  //
  // NO PASSWORD IS SUPPLIED ON THE INVOCATION, deliberately. That is what makes the comparison
  // load-bearing: with one supplied, prompt() keeps it and the recovery cannot affect the
  // outcome, so the test would pass on a function that compared nothing. Measured, not reasoned
  // about — the first version of this test did supply one and every comparison mutation below
  // left it green.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete `[[ "${user}" == "${want_user}" ]] || return 1` from
  //      installed_database_password(). The new role is created with imsuser's live password, the
  //      composed URL carries it, and this test fails on BOTH the behavioural assertion and
  //      WRONG_USER — alone in this file.
  //   2. delete the host, port or database comparison: this test fails on WRONG_HOST, WRONG_PORT
  //      or WRONG_DB respectively, alone in this file. Those three are asserted against the
  //      function directly because the behavioural half can only exercise one of the four at a
  //      time, and four clusters to prove one decision is four chances to prove something else.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped(
      {
        APP_DIR: root,
        APP_USER: currentUser(),
        DB_HOST: '127.0.0.1',
        DB_PORT: String(cluster.port),
        DB_NAME: 'one_two_inventory',
        // The operator has moved the application to its own role, and supplies no password: the
        // installer must mint one rather than inherit the other role's.
        DB_USER: 'ims_second',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      `${REINSTALL_BODY}
        installed="postgresql://imsuser:live-password@127.0.0.1:\${DB_PORT}/one_two_inventory"
        echo "MATCH=$(installed_database_password "\${installed}" imsuser 127.0.0.1 "\${DB_PORT}" one_two_inventory || echo REFUSED)"
        echo "WRONG_USER=$(installed_database_password "\${installed}" ims_second 127.0.0.1 "\${DB_PORT}" one_two_inventory || echo REFUSED)"
        echo "WRONG_HOST=$(installed_database_password "\${installed}" imsuser 127.0.0.2 "\${DB_PORT}" one_two_inventory || echo REFUSED)"
        echo "WRONG_PORT=$(installed_database_password "\${installed}" imsuser 127.0.0.1 1 one_two_inventory || echo REFUSED)"
        echo "WRONG_DB=$(installed_database_password "\${installed}" imsuser 127.0.0.1 "\${DB_PORT}" some_other_database || echo REFUSED)"
      `,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /ROLE_PREEXISTED=false/, 'precondition: this run created the new role')
    assert.match(run.output, /ROTATION_PENDING=false/, 'creating a role is never a rotation')

    // THE ASSERTION THE COMPARISON EXISTS FOR: the new role did not inherit the old one's secret.
    const composed = readVar(run.output, 'COMPOSED_URL')
    assert.doesNotMatch(composed, /live-password/, 'a new role must never be given the credential the previous one used')
    assert.match(
      composed,
      new RegExp(`^postgresql://ims_second:[0-9a-f]{32}@127\\.0\\.0\\.1:${cluster.port}/one_two_inventory$`),
      'it gets a freshly minted one, which is what a first credential for a role is',
    )
    assert.equal(connectAs(cluster, composed), 'build-connected', 'and the server has that credential')
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'ims_second', password: 'live-password', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and specifically NOT the other role\'s',
    )
    // The role the .env was actually about is untouched.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'and the role the environment file was about keeps its own credential',
    )

    // The four comparisons, asked of the shipped function directly.
    assert.equal(readVar(run.output, 'MATCH'), 'live-password', 'the same connection recovers the installed password')
    for (const probe of ['WRONG_USER', 'WRONG_HOST', 'WRONG_PORT', 'WRONG_DB']) {
      assert.equal(readVar(run.output, probe), 'REFUSED', `${probe}: a URL that names a different connection is not this connection's credential`)
    }
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The shipped order
// ---------------------------------------------------------------------------

test('r38: the shipped order is the tested order — the rotation sits behind the build, the stop and the fence', () => {
  // THE TESTS ABOVE RUN AN ORDER THIS FILE WROTE. This one asserts the SHIPPED script has the
  // same one, so they cannot go on passing while install.sh drifts back.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. move the `rotate_database_password_in_fenced_window` call up to just after
  //      `provision_database_role_and_privileges` on the fenced path — i.e. back to where r37
  //      performed the rotation. The build/stop/fence ordering assertions fail, and THIS TEST IS
  //      THE ONLY ONE IN EITHER FILE THAT NOTICES: the behavioural tests call the functions
  //      themselves and cannot see where the script calls them. That is exactly why it exists.
  //   2. put `ALTER USER "${DB_USER}" WITH PASSWORD '${DB_PASSWORD}';` back into
  //      provision_database_role_and_privileges(): assertion (a) fails here, and tests 1, 2 and 4
  //      fail behaviourally.
  const lines = INSTALL_SOURCE.split('\n')
  const indexOfLine = (predicate: (line: string) => boolean, what: string): number => {
    const index = lines.findIndex(predicate)
    assert.notEqual(index, -1, `precondition: install.sh must contain ${what}`)
    return index
  }

  // (a) provision_database_role_and_privileges() sets no password at all any more.
  const provision = shippedFunction(INSTALL_SOURCE, 'provision_database_role_and_privileges')
  for (const mutation of [/ALTER\s+USER/i, /ALTER\s+ROLE/i, /WITH\s+PASSWORD/i]) {
    assert.doesNotMatch(provision, mutation, `nothing matching ${mutation} may run before the predecessor is stopped`)
  }

  // (b) the rotation has exactly one call site, and it is behind everything that makes it safe.
  const callSites = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line === 'rotate_database_password_in_fenced_window')
  assert.equal(callSites.length, 1, 'exactly one call site: the drain-verified, fenced window')
  const rotation = callSites[0].index

  const prismaGenerate = indexOfLine((line) => line.includes('npx prisma generate --schema'), 'the prisma generate step')
  const build = indexOfLine((line) => line.includes('npm run build --prefix'), 'the build step')
  const stop = indexOfLine((line) => line.includes('systemctl stop "${APP_NAME}.service"'), 'the service stop')
  const armed = indexOfLine((line) => line.trim() === 'FENCE_ARMED=true', 'the arming transition')
  const fence = indexOfLine((line) => line.trim() === 'fence_db_connections', 'the connection fence')
  const drain = indexOfLine((line) => line.includes('check-db-writers.mjs'), 'the drain probe')
  const migrate = indexOfLine((line) => line.trim() === 'CUTOVER_STEP="migrate"', 'the migration step')

  for (const [what, index] of [['prisma generate', prismaGenerate], ['the build', build], ['the stop', stop], ['the arming flag', armed], ['the connection fence', fence], ['the drain probe', drain]] as const) {
    assert.ok(rotation > index, `${what} must come BEFORE the credential rotation (rotation at ${rotation}, ${what} at ${index})`)
  }
  assert.ok(rotation < migrate, 'and the rotation must be inside the window, before the migration runs')

  // (c) the password is prompted in exactly one place, and that place is the recovering one.
  const promptSites = lines.filter((line) => /^\s*prompt\s+DB_PASSWORD\b/.test(line))
  assert.equal(promptSites.length, 3, 'the three prompt calls all live inside prompt_db_password()')
  const promptFunction = shippedFunction(INSTALL_SOURCE, 'prompt_db_password')
  for (const site of promptSites) {
    assert.ok(promptFunction.includes(site), `every DB_PASSWORD prompt must be inside prompt_db_password(): ${site}`)
  }
  assert.match(promptFunction, /DB_PASSWORD_INSTALLED/, 'and it consults the installed credential first')
})
