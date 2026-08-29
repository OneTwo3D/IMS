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
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  type Cluster,
  cleanLibpqEnv,
  currentUser,
  freePort,
  shippedFunction,
  startCluster,
} from './real-postgres-cluster.ts'

const REPO = process.cwd()
const INSTALL_SOURCE = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')

/**
 * Everything the credential decision is made of, lifted whole out of the shipped script.
 *
 * classify_database_credential_rotation() is in this list because r38 turned four straight-line
 * statements into a function precisely so that it could be: a regression that re-implements the
 * ordering it is checking proves only that its author can write the ordering twice.
 */
const SHIPPED = [
  'libpq_env_unset_args',
  'db_local_socket_dir',
  'pg_local_psql',
  'unquote_env_value',
  'existing_env',
  'load_existing_env',
  'mask_secret',
  'prompt',
  'installed_database_password',
  'prompt_db_password',
  'ensure_database_role_exists',
  'classify_database_credential_rotation',
  'provision_database_role_and_privileges',
  'write_env_database_url',
  'rotate_database_password_in_fenced_window',
]
  .map((name) => shippedFunction(INSTALL_SOURCE, name))
  .join('\n')

interface Run {
  readonly status: number
  readonly output: string
}

/** The shipped functions, in a shell given exactly the variables install.sh gives them. */
function runShipped(vars: Record<string, string>, body: string): Run {
  const assignments = Object.entries(vars)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')
  const script = `
exec 2>&1
set -uo pipefail
success() { echo "OK: $*"; }
warn()    { echo "WARN: $*"; }
info()    { echo "INFO: $*"; }
header()  { echo "HEADER: $*"; }
error()   { echo "ERROR: $*" >&2; }
die()     { error "$*"; exit 9; }
# install.sh runs the local statements as the postgres OS user; here the cluster belongs to
# whoever is running the tests, so the privilege transition is the identity function.
run_as_user() { shift; "$@"; }
BOLD=""
RESET=""
NON_INTERACTIVE=true
INSTALL_POSTGRES=y
APP_NAME="one-two-inventory"
DATABASE_URL=""
DB_ROLE_PREEXISTED=false
DB_ROLE_CREDENTIALS_ROTATED=false
DB_PASSWORD_INSTALLED=""
DB_PASSWORD_EFFECTIVE=""
DB_PASSWORD_ROTATION_PENDING=false
DB_FENCE_UP=false
FENCE_ARMED=false
ENV_FILE_STATE=absent
declare -A EXISTING_ENV=()
${assignments}
${SHIPPED}
${body}
`
  const env = cleanLibpqEnv()
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------------------
// A client that is CONNECTED ALREADY, and stays connected across the run
// ---------------------------------------------------------------------------

interface HeldSession {
  alive(): boolean
  finish(): Promise<{ code: number | null; stdout: string; stderr: string }>
}

/**
 * The predecessor, modelled as what it actually is: a process that authenticated BEFORE the
 * installer started and goes on issuing statements while it runs.
 *
 * psql reading its script from a pipe executes each statement as it arrives, so the session is
 * genuinely open for the whole of the installer run rather than being opened and closed around
 * it. It is not enough on its own — an already-authenticated backend survives an ALTER USER, and
 * that is exactly why the finding is about NEW connections — so every test that holds one also
 * opens a fresh connection afterwards.
 */
async function holdSession(cluster: Cluster, user: string, password: string, database: string): Promise<HeldSession> {
  const env = cleanLibpqEnv()
  env.PGPASSWORD = password
  const child = spawn('psql', [
    '-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(cluster.port), '-U', user, '-d', database,
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  let exited = false
  let code: number | null = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('exit', (status) => { exited = true; code = status })

  child.stdin.write("SELECT 'session-opened';\n")
  const deadline = Date.now() + 15_000
  while (!stdout.includes('session-opened')) {
    if (exited) throw new Error(`the held session never opened (exit ${code}): ${stdout}${stderr}`)
    if (Date.now() > deadline) throw new Error(`the held session did not answer in time: ${stdout}${stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return {
    alive: () => !exited,
    async finish() {
      if (!exited) {
        child.stdin.write("SELECT 'still-authenticated';\n")
        child.stdin.end()
        await new Promise<void>((resolve) => {
          if (exited) resolve()
          else child.on('exit', () => resolve())
        })
      }
      return { code, stdout, stderr }
    },
  }
}

/** The `.env` a previous run of this installer left behind. */
function writeInstalledEnv(appDir: string, port: number, password: string): string {
  const contents = [
    '# One Two Inventory — generated by install.sh',
    'NODE_ENV=production',
    'APP_PORT=3000',
    'AUTH_SECRET=an-auth-secret',
    'SETTINGS_ENCRYPTION_KEY=a-settings-key',
    'CRON_SECRET=a-cron-secret',
    '',
    `DATABASE_URL=postgresql://imsuser:${password}@127.0.0.1:${port}/one_two_inventory`,
    // IN THE SAME FILE ON PURPOSE. It ends in the same fourteen characters as the line above, so
    // an unanchored match rewrites the deploy admin's credential too — and that is the connection
    // the fence itself is held with.
    `DEPLOY_ADMIN_DATABASE_URL=postgresql://deployadmin:admin-password@127.0.0.1:${port}/one_two_inventory`,
    'NEXT_PUBLIC_APP_URL=https://ims.example.test',
    '',
  ].join('\n')
  const path = join(appDir, '.env')
  writeFileSync(path, contents)
  chmodSync(path, 0o600)
  return contents
}

/** The connection the BUILD is handed, opened the way the build opens it. */
function connectAs(cluster: Cluster, url: string): string {
  const match = /^postgresql:\/\/([^:]+):(.*)@([^@/]+):(\d+)\/(.+)$/.exec(url)
  assert.ok(match, `the composed DATABASE_URL must state role, password, host, port and database: ${url}`)
  const [, user, password, host, port, database] = match
  assert.equal(port, String(cluster.port), 'the URL must name the cluster under test')
  return cluster.psql(['-c', "SELECT 'build-connected'"], { host, user, password, database })
}

function readVar(output: string, name: string): string {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(output)
  assert.ok(match, `the run must print ${name}=:\n${output}`)
  return match[1]
}

const REINSTALL_BODY = `
  load_existing_env "\${APP_DIR}/.env"
  prompt_db_password
  ensure_database_role_exists
  classify_database_credential_rotation
  provision_database_role_and_privileges
  echo "COMPOSED_URL=\${DATABASE_URL}"
  echo "ROLE_PREEXISTED=\${DB_ROLE_PREEXISTED}"
  echo "ROTATION_PENDING=\${DB_PASSWORD_ROTATION_PENDING}"
  echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
`

/** The live installation the fence exists for: a role somebody is using, a database it owns. */
function seedLiveInstallation(cluster: Cluster): void {
  cluster.psql(['-c', "CREATE ROLE imsuser LOGIN PASSWORD 'live-password'"])
  cluster.psql(['-c', 'CREATE DATABASE one_two_inventory OWNER imsuser'])
}

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
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. restore the r37 prompt — `prompt DB_PASSWORD "Database password" "$(openssl rand -hex 16)"
  //      "secret"` in place of the prompt_db_password() call. DB_PASSWORD_INSTALLED is never
  //      consulted, the composed URL carries a random secret, and this test fails on the
  //      composed-URL assertion. Test 2 fails too (its rotation stops being distinguishable from
  //      the default) and test 5 fails; tests 3, 4 and 6 stay green.
  //   2. restore the r37 ALTER inside provision_database_role_and_privileges(). The fresh
  //      connection with the live password is refused and this test fails on it, alone in this
  //      file — the other five never let provision_ see a pre-existing role with a live client.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  let held: HeldSession | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    const envBefore = writeInstalledEnv(root, cluster.port, 'live-password')

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

    // The environment file is not rewritten by a run that changes nothing.
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), envBefore, '.env must be byte-identical after a no-change re-install')

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
  //      unconditionally — i.e. compose the URL from the target password, which is what the
  //      pre-r38 script did. The composed URL carries the new secret, connectAs() is refused, and
  //      this test fails on it. Test 3 fails too (its .env comparison); the rest stay green.
  //   2. restore the r37 ALTER inside provision_database_role_and_privileges(). The live password
  //      stops working, this test fails on its live-credential assertion, and test 1 fails as
  //      well — which is right: both are statements about the same defect.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  let held: HeldSession | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    const envBefore = writeInstalledEnv(root, cluster.port, 'live-password')
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

    assert.equal(readFileSync(join(root, '.env'), 'utf8'), envBefore, '.env must still name the credential the server has')

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

test('r38: the rotation happens inside the stopped, fenced window and rewrites exactly one .env line', async () => {
  // WHAT AN EXPLICIT ROTATION NOW DOES. Same run as test 2, continued past the point where
  // install.sh has installed the reboot fence, fenced cron, stopped the service, confirmed the
  // port is free, raised the connection fence and had check-db-writers.mjs confirm no other
  // backend. FENCE_ARMED and DB_FENCE_UP are what the shipped script has set by then.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the write_env_database_url() call from
  //      rotate_database_password_in_fenced_window(). The server has the new password and .env
  //      still names the old one; this test fails on its .env assertion, alone.
  //   2. drop the `^` anchor from write_env_database_url()'s grep and awk patterns.
  //      DEPLOY_ADMIN_DATABASE_URL matches too, the count is 2 rather than 1, the function dies,
  //      and this test fails on the run status — with the deploy admin's credential intact,
  //      which is the point of asserting the count instead of substituting blindly.
  //   3. make the ALTER a no-op (`SELECT 1;`). The new password never reaches the server and this
  //      test fails on the new-credential assertion; no other test in this file goes near it.
  const root = mkdtempSync(join(tmpdir(), 'ims-cred-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    const envBefore = writeInstalledEnv(root, cluster.port, 'live-password')

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
      },
      `${REINSTALL_BODY}
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

    // ...AND THE ENVIRONMENT FILE AGREES, in exactly one line.
    const envAfter = readFileSync(join(root, '.env'), 'utf8')
    const before = envBefore.split('\n')
    const after = envAfter.split('\n')
    assert.equal(after.length, before.length, 'no line may be added or dropped')
    const changed = before.map((line, index) => [line, after[index]] as const).filter(([a, b]) => a !== b)
    assert.equal(changed.length, 1, `exactly one line may change: ${JSON.stringify(changed)}`)
    assert.equal(
      changed[0][1],
      `DATABASE_URL=postgresql://imsuser:rotated-secret@127.0.0.1:${cluster.port}/one_two_inventory`,
      'and it is DATABASE_URL, carrying the new credential',
    )
    assert.match(
      envAfter,
      new RegExp(`^DEPLOY_ADMIN_DATABASE_URL=postgresql://deployadmin:admin-password@127\\.0\\.0\\.1:${cluster.port}/one_two_inventory$`, 'm'),
      'the deploy admin connection — the one the fence itself is held with — must be untouched',
    )
    assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600, 'and the rewritten file must still be mode 600')
    assert.equal(readVar(run.output, 'FINAL_URL'), changed[0][1].slice('DATABASE_URL='.length), 'the run and the file must name the same URL')
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
  //      and this test fails on both its status assertion and its live-credential assertion. No
  //      other test in this file sets FENCE_ARMED=false and then rotates.
  //   2. delete the `${DB_FENCE_UP} || die` line: the second case exits 0 and this test fails the
  //      same way. Deleting BOTH fails this test twice and leaves the other five green.
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
  // operator has changed DB_USER would compose a URL that cannot authenticate, and — worse —
  // would make a genuine first credential for a NEW role look like a rotation of somebody's live
  // one. So all four are compared and anything that differs answers "nothing installed".
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `[[ "${user}" == "${want_user}" ]] || return 1` comparison from
  //      installed_database_password(). The new role is created with imsuser's password, the
  //      composed URL carries it, and this test fails on its composed-URL assertion — alone.
  //   2. delete the port comparison and run the same body with DB_PORT bumped by one: the same
  //      assertion fails. It is checked here rather than in its own test because the four
  //      comparisons are one decision.
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
        // The operator has moved the application to its own role.
        DB_USER: 'ims_second',
        DB_PASSWORD: 'a-password-for-the-new-role',
        IMS_PG_SOCKET_DIR: cluster.socket,
      },
      REINSTALL_BODY,
    )
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /ROLE_PREEXISTED=false/, 'precondition: this run created the new role')
    assert.match(run.output, /ROTATION_PENDING=false/, 'creating a role is never a rotation')
    assert.equal(
      readVar(run.output, 'COMPOSED_URL'),
      `postgresql://ims_second:a-password-for-the-new-role@127.0.0.1:${cluster.port}/one_two_inventory`,
      'the new role gets the password it was given, never the one the previous role had',
    )
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'ims_second', password: 'a-password-for-the-new-role', database: 'one_two_inventory' }),
      '1',
      'and the server agrees',
    )
    // The role the .env was about is untouched.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'and the role the environment file was about keeps its own credential',
    )
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
  //      performed the rotation. The build/stop/fence ordering assertions fail and this is the
  //      only test in this file that notices, which is exactly why it exists.
  //   2. put `ALTER USER "${DB_USER}" WITH PASSWORD '${DB_PASSWORD}';` back into
  //      provision_database_role_and_privileges(): the "no password statement" assertion fails
  //      here, and tests 1 and 2 fail behaviourally.
  //   3. replace the prompt_db_password() call on the local-database branch with a bare
  //      `prompt DB_PASSWORD ... "$(openssl rand -hex 16)"`: the single-prompt assertion fails.
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
