/**
 * o3d-2sm1.5 r40 — A SUCCESSFUL CONNECTION IS NOT PROOF THAT THE PASSWORD IS LIVE. Codex HIGH.
 *
 * THE FINDING. r39's `db_password_authenticates` opened a connection with a candidate password and
 * read a successful `SELECT 1` as proof the role holds it. Whether that inference is valid is not a
 * property of this installer at all — it is decided by `pg_hba.conf`, per database, per host, per
 * role, and PostgreSQL supports rules under which it is false in BOTH directions:
 *
 *   * `trust` on the endpoint accepts EVERY password. The probe cannot fail, so it "proves"
 *     whichever candidate was tried first — `new` — and the reconciliation publishes a `.env`
 *     naming a credential the `ALTER` may never have set.
 *   * a revoked CONNECT refuses the SESSION rather than the password, so a role holding exactly the
 *     right credential reads as dead. THE INSTALLER'S OWN CONNECTION FENCE DOES THIS to the
 *     application database, and an interrupted rotation leaves that fence standing — so the
 *     endpoint most likely to be asked is the one most likely to lie this way.
 *
 * THE FIX UNDER TEST IS A NEGATIVE CONTROL. An endpoint is admitted as evidence only after it has
 * been shown, on that endpoint, in that run, to REFUSE a freshly minted random password and ACCEPT
 * one asserted live. A probe that has not demonstrated it can reject is not evidence.
 *
 * WHY THIS FILE BUILDS ITS OWN pg_hba RULES. The finding is that the installer's model of what a
 * successful connection means was wrong across supported configurations. A test written from the
 * same model — one that only ever runs against the default scram cluster — agrees with the defect
 * and reports green. So the clusters here are real, and their authentication rules are the subject:
 * `trust` on the maintenance database, `trust` everywhere, and a revoked CONNECT.
 *
 * MINTSOFT/XERO/WOOCOMMERCE: nothing here touches any of them. Every server in this file is an
 * `initdb` cluster created in a temporary directory and destroyed in a `finally`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  NEXT_RUN_BODY,
  REINSTALL_BODY,
  SHIPPED_ROTATION_UP_TO_THE_CLEAR,
  connectWithDriver,
  decodeVar,
  envDatabaseUrl,
  installVars,
  journalValue,
  runShipped,
  seedLiveInstallation,
  writeInstalledEnv,
} from './install-shell-rig.ts'
import { type Cluster, freePort, startCluster } from './real-postgres-cluster.ts'

/** A `trust` rule covering ONLY the maintenance database — the endpoint the rotation relies on. */
const TRUST_POSTGRES_ONLY = ['host postgres all 127.0.0.1/32 trust']
/** A `trust` rule covering everything, which is what a lax development box actually looks like. */
const TRUST_EVERYTHING = ['host all all 127.0.0.1/32 trust']

/** The journal an interrupted rotation leaves, written by the SHIPPED writer. */
function writeInterruptedJournal(cluster: Cluster, root: string, newPassword: string, probeDatabase: string) {
  return runShipped({ ...installVars(cluster, root), DB_PASSWORD: newPassword }, `
    ${REINSTALL_BODY}
    FENCE_ARMED=true
    DB_FENCE_UP=true
    write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" "${probeDatabase}" || exit 7
  `)
}

// ---------------------------------------------------------------------------
// 1. THE LOAD-BEARING ONE: a trust rule on the probe endpoint refuses the rotation
// ---------------------------------------------------------------------------

test('r40: a trust rule on the probe endpoint makes the rotation REFUSE, not proceed', async () => {
  // THE ROTATION IS THE STEP WITH NO UNDO, and its only safety net is a journal the next run
  // reconciles BY ASKING THE SERVER. On a cluster where the endpoint that reconciliation will have
  // to use cannot tell one password from another, that net is a guess — so the rotation must not
  // happen at all. Refusing costs nothing: no `ALTER` has been issued, the role still holds the
  // credential its clients have, and `.env` still names it.
  //
  // THE CLUSTER IS THE TEST. `host postgres all 127.0.0.1/32 trust` is prepended to pg_hba.conf, so
  // it wins over the scram default for the maintenance database and only for it. That is the exact
  // configuration under which r39's probe could not fail.
  //
  // AND THE VACUITY IS MEASURED, not assumed: the run reports what a bare connection attempt with a
  // password nothing knows does on that endpoint. If that came back refused, this cluster would not
  // be the configuration the finding is about and every assertion below would be meaningless.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the db_endpoint_is_password_sensitive gate from
  //      rotate_database_password_in_fenced_window(): the rotation proceeds, this test fails on its
  //      status assertion, on ROTATED_ANYWAY and on the live-credential assertion. Test 2 fails
  //      with it; no other file in the repo notices.
  //   2. keep the gate but drop the NEGATIVE CONTROL from db_endpoint_is_password_sensitive() —
  //      i.e. return 0 as soon as the positive password connects. Under `trust` the positive
  //      always connects, so the gate passes and the rotation proceeds: same three failures. This
  //      is the route that matters, because it is the one a fix that "looks right" takes.
  //   3. keep the control but drop the POSITIVE half: the gate then passes on any endpoint that
  //      refuses a random password, including one behind a revoked CONNECT. Nothing here fails;
  //      test 5 is what catches it.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', TRUST_POSTGRES_ONLY)
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      # PRECONDITION, MEASURED: on this cluster a password nothing can know is ACCEPTED by the
      # maintenance database. That is the whole content of the finding, and if it were false this
      # test would be measuring the ordinary scram configuration.
      if db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "CONTROL_ACCEPTED_ON_POSTGRES=yes"
      else
        echo "CONTROL_ACCEPTED_ON_POSTGRES=no"
      fi
      # ...and the application database still checks, so the cluster is not simply open.
      if db_endpoint_accepts_password one_two_inventory "a-password-nothing-has-ever-set"; then
        echo "CONTROL_ACCEPTED_ON_APP_DB=yes"
      else
        echo "CONTROL_ACCEPTED_ON_APP_DB=no"
      fi
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)

    assert.match(run.output, /CONTROL_ACCEPTED_ON_POSTGRES=yes/, 'precondition: the trust rule must make the probe endpoint accept anything')
    assert.match(run.output, /CONTROL_ACCEPTED_ON_APP_DB=no/, 'precondition: and the rule must be scoped to that one database')

    assert.equal(run.status, 9, `the rotation must refuse on an endpoint that cannot discriminate:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and must not continue past the refusal')
    assert.match(run.output, /cannot show that ANY unfenced endpoint would be able to tell afterwards which password the role has/, 'for the reason the finding names')
    assert.match(run.output, /'postgres' ACCEPTED a random 32-byte password/, 'and it reports the negative control that failed')
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'and says what state the role is in')
    assert.match(run.output, /GRANT CONNECT ON DATABASE postgres/, 'and what the operator does about it')

    // AND THE REFUSAL IS TRUE. The application database still checks passwords, so this is a real
    // question there rather than another trust acceptance.
    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'the role must still have the credential its clients hold',
    )
    assert.throws(
      () => cluster!.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'rotated-secret', database: 'one_two_inventory' }),
      /password authentication failed/,
      'and the requested password must not have reached the server',
    )
    assert.equal(envDatabaseUrl(root), `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`, 'and .env still agrees with it')
    assert.throws(() => journalValue(root, 'marker_complete'), /ENOENT/, 'and no journal was written: the gate is BEFORE the durable act')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The other half of the same rule: reconciliation refuses rather than adopting
// ---------------------------------------------------------------------------

test('r40: under trust the reconciliation REFUSES rather than adopting the candidate it tried first', async () => {
  // THE VACUITY PROBLEM AT ITS SHARPEST. The `ALTER` did NOT run — the server still holds the OLD
  // password — and the journal records both candidates. Under `trust` every endpoint accepts both,
  // so r39's reconciliation took the first success it got, which was `new`, and published a `.env`
  // naming a credential the server was never given. On this cluster that URL happens to connect,
  // which is precisely why the defect is invisible until the rule is tightened, the role is used
  // from another host, or the fence is released.
  //
  // The run must refuse, name the endpoints and say what each did, and LEAVE THE JOURNAL — which is
  // the only remaining record of the two candidates.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. restore r39's `if db_password_authenticates "${new_password}"` first-success-wins body in
  //      reconcile_interrupted_role_rotation(): the run succeeds, adopts `rotated-secret`, and
  //      publishes it. This test fails on its status assertion, on ADOPTED and on JOURNAL_LEFT —
  //      alone in the repo, because every other reconciliation test runs on a scram cluster where
  //      first-success-wins happens to give the right answer.
  //   2. drop the negative control from db_endpoint_is_password_sensitive(): both candidates
  //      connect, the endpoint is admitted, and resolve_live_role_password() returns the AMBIGUOUS
  //      verdict instead. The run still refuses, but with the wrong message — this test fails on
  //      its "cannot tell one password from another" assertion and not on its status. Recorded
  //      because the distinction is the finding: refusing by luck is not refusing by rule.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', TRUST_EVERYTHING)
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.equal(journalValue(root, 'marker_complete'), '1', 'precondition: a complete journal was published')

    const next = runShipped(installVars(cluster, root), `
      if db_endpoint_accepts_password postgres "nothing-has-ever-set-this"; then
        echo "CLUSTER_IS_OPEN=yes"
      else
        echo "CLUSTER_IS_OPEN=no"
      fi
      ${NEXT_RUN_BODY}
      echo "ADOPTED=$(printf '%s' "\${DB_ROTATION_RECONCILED_PASSWORD}" | base64 | tr -d '\\n')"
    `)
    assert.match(next.output, /CLUSTER_IS_OPEN=yes/, 'precondition: this cluster must accept any password, or the test is about nothing')

    assert.equal(next.status, 9, `a probe that cannot refuse must not decide:\n${next.output}`)
    assert.match(next.output, /could not find a single endpoint able to tell one password from another/, 'for the reason the finding names')
    assert.match(next.output, /'postgres' ACCEPTED a random 32-byte password/, 'and it reports the maintenance database')
    assert.match(next.output, /'one_two_inventory' ACCEPTED a random 32-byte password/, 'and the application database')
    assert.match(next.output, /LEFT IN PLACE/, 'and the record is kept')
    assert.doesNotMatch(next.output, /ADOPTED=/, 'nothing past the refusal ran')

    // THE ADOPTION IT DID NOT MAKE WOULD HAVE BEEN WRONG. The ALTER never ran, so the credential
    // r39 would have published is one this server has never been given.
    assert.equal(
      Buffer.from(journalValue(root, 'old_password_b64')!, 'base64').toString('utf8'),
      'live-password',
      'the candidates survive the refusal',
    )
    assert.equal(Buffer.from(journalValue(root, 'new_password_b64')!, 'base64').toString('utf8'), 'rotated-secret')
    assert.equal(envDatabaseUrl(root), `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`, 'and .env was not republished')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. A recorded endpoint is a starting point, not an authority
// ---------------------------------------------------------------------------

test('r40: a recorded probe endpoint that has gone trust is discarded, and a discriminating one answers', async () => {
  // "REUSE THAT EXACT ENDPOINT" IS NOT "BELIEVE THAT EXACT ENDPOINT". The journal names the place
  // the rotating run proved, so reconciliation asks it FIRST — but the proof is re-established
  // every time, because pg_hba.conf can change between the two runs and an endpoint that has since
  // become `trust` would otherwise answer with the same authority it earned when it still checked.
  //
  // Here the ALTER DID commit, `postgres` has since gone `trust`, and the application database is
  // reachable and still checks. The right answer is `new`, established on `one_two_inventory`.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make resolve_live_role_password() `return 1` instead of `continue` when an endpoint fails
  //      the sensitivity pair: the recorded endpoint is trust, the loop stops there, and the run
  //      refuses. This test fails on its status assertion, alone.
  //   2. drop the recorded endpoint from db_probe_endpoint_candidates() (start the list at
  //      `postgres` unconditionally): NOTHING here fails, because the recorded endpoint IS
  //      `postgres`. Test 6 is what asserts the recording; recorded here so the next reader does
  //      not look for it in this test.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', TRUST_POSTGRES_ONLY)
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    // The ALTER committed and the run died before `.env` was replaced: boundary (2).
    cluster.psql(['-c', "ALTER USER imsuser WITH PASSWORD 'rotated-secret'"])

    const next = runShipped(installVars(cluster, root), `
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /server has the NEW password/, 'the discriminating endpoint must give the right answer')
    assert.match(next.output, /PROBE_DB=one_two_inventory/, 'and it must be the endpoint that could discriminate, not the recorded one')
    assert.match(next.output, /Established on 'one_two_inventory', which refused a random password/, 'and the success must say where and on what evidence')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser', 'and the file the service restarts from opens a connection')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The converse: an endpoint that refuses the SESSION, not the password
// ---------------------------------------------------------------------------

test('r40: a revoked CONNECT on the maintenance database does not strand a recoverable installation', async () => {
  // THE OTHER DIRECTION OF THE SAME FINDING. `postgres` refuses `imsuser` outright — a hardened
  // site that has revoked PUBLIC CONNECT on the maintenance database — so BOTH candidates fail
  // there and neither failure says anything about a password. r39 read the first endpoint's answer
  // and moved on to the second, which happened to work; the risk in r40's stricter rule is that
  // "cannot be shown password-sensitive" starts refusing sites that were fine. It must not.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. reduce db_probe_endpoint_candidates() to `postgres` alone: no endpoint can be shown
  //      password-sensitive and the run refuses. This test fails on its status assertion, alone —
  //      and that failure is the whole reason the fallback exists.
  //   2. treat "refused everything" as password-sensitivity (drop the positive half of the pair):
  //      `postgres` is admitted, reports that neither candidate is live, and the run either adopts
  //      nothing or refuses. This test fails on PROBE_DB and on INSTALLED_B64.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    // The hardened site: nothing but the superuser may open the maintenance database.
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC'])

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', '')
    assert.equal(interrupted.status, 0, interrupted.output)

    const next = runShipped(installVars(cluster, root), `
      if db_endpoint_accepts_password postgres "live-password"; then
        echo "POSTGRES_REACHABLE=yes"
      else
        echo "POSTGRES_REACHABLE=no"
      fi
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.match(next.output, /POSTGRES_REACHABLE=no/, 'precondition: the maintenance database must refuse the LIVE password, or this test is about nothing')

    assert.equal(next.status, 0, `an endpoint that refuses the session must not strand the run:\n${next.output}`)
    assert.match(next.output, /still has the OLD password/, 'the application database can still answer, and does')
    assert.match(next.output, /PROBE_DB=one_two_inventory/, 'on the endpoint that proved it could')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'live-password')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. A rotation that would leave nothing able to reconcile it does not happen
// ---------------------------------------------------------------------------

test('r40: a rotation refuses when the role cannot reach any UNFENCED endpoint at all', async () => {
  // THE SAME REFUSAL FROM THE OPPOSITE CAUSE, and the reason the sensitivity pair needs BOTH
  // halves. Here `postgres` refuses a random password — so the negative control passes — and
  // refuses the live one too, because CONNECT has been revoked. An endpoint that has only ever said
  // no has not been shown able to say yes, and a rotation journalled against it could not be
  // reconciled: the application database is behind the fence this very run is holding.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. drop the POSITIVE half of db_endpoint_is_password_sensitive(): `postgres` is admitted on
  //      the strength of refusing a random password, the rotation proceeds, and this test fails on
  //      its status assertion, on ROTATED_ANYWAY and on the live-credential assertion. Alone.
  //   2. let the rotation gate fall back to ${DB_NAME}: it is behind the fence when a
  //      reconciliation runs, so the rotation would succeed here and strand the next run. This test
  //      fails on its status assertion; nothing else does, which is why the gate names `postgres`
  //      explicitly rather than reusing the reconciliation's candidate list.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC'])

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      if db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "CONTROL_ACCEPTED=yes"
      else
        echo "CONTROL_ACCEPTED=no"
      fi
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.match(run.output, /CONTROL_ACCEPTED=no/, 'precondition: this endpoint CAN refuse — it is the positive half that is missing')

    assert.equal(run.status, 9, `a rotation with no reconcilable endpoint must refuse:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and must not continue past the refusal')
    assert.match(run.output, /'postgres' refused the random password AND the candidate/, 'and it must say which half of the pair failed')
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'and what state the role is in')

    assert.equal(
      cluster.psql(['-c', 'SELECT 1'], { host: '127.0.0.1', user: 'imsuser', password: 'live-password', database: 'one_two_inventory' }),
      '1',
      'the role must still have the credential its clients hold',
    )
    assert.throws(() => journalValue(root, 'marker_complete'), /ENOENT/, 'and no journal was written')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. What a successful rotation records, and that the next run reads it
// ---------------------------------------------------------------------------

test('r40: a rotation records the endpoint it proved, and the reconciliation reads it back', async () => {
  // THE RECORDING HALF. The endpoint the rotating run proved is written into the journal so the
  // reconciliation asks the same place rather than deriving one of its own — a value derived twice
  // is a value that can be derived differently twice. It is also the one line in that file an
  // operator reading it by hand needs, because it names the pg_hba rule the answer depends on.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. drop the probe_database line from write_role_rotation_journal(): this test fails on the
  //      journal assertion, alone — the reconciliation still works, because the candidate list
  //      starts at `postgres` anyway, which is exactly why the recording needs its own assertion.
  //   2. write it BEFORE marker_complete is not a thing — the marker is written last by
  //      construction; a reader that stops at the first missing key would be a different defect.
  //      Recorded as not-applicable so the next reader does not go looking.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // The SHIPPED rotation, truncated one statement before the journal is cleared, so what is
    // measured is what the real sequence wrote.
    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      DB_PROBE_REPORT=""
      db_endpoint_is_password_sensitive postgres "\${DB_PASSWORD_EFFECTIVE}" || exit 6
      DB_ROTATION_PROBE_DATABASE=postgres
      write_role_rotation_journal "\${DB_PASSWORD_EFFECTIVE}" "\${DB_PASSWORD}" "\${DB_ROTATION_PROBE_DATABASE}" || exit 7
      ${SHIPPED_ROTATION_UP_TO_THE_CLEAR.replace('write_role_rotation_journal', '# already written: write_role_rotation_journal')}
      echo "AT_THE_CLEAR"
    `)
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.equal(journalValue(root, 'probe_database'), 'postgres', 'the journal must name the endpoint the rotation proved')
    assert.equal(journalValue(root, 'journal_version'), '2', 'and say which format that is')

    const next = runShipped(installVars(cluster, root), `
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /PROBE_DB=postgres/, 'and the reconciliation must answer on it')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. An endpoint that CAN discriminate and says yes to both is not an answer either
// ---------------------------------------------------------------------------

test('r40: a discriminating endpoint that accepts BOTH candidates is refused, not resolved to new', async () => {
  // THE THIRD OUTCOME. `resolve_live_role_password` refuses when an endpoint that DID reject a
  // random password nonetheless accepts both recorded candidates: two different passwords cannot
  // both be the role's, so the server is not answering the way a password check answers, and
  // preferring `new` because it connected is the defect this round removes.
  //
  // CONSTRUCTED, AND SAID SO. No pg_hba rule produces this on a normal cluster — that is the point,
  // it is the outcome that should not happen — so it is reached by journalling the SAME password as
  // both candidates through the shipped writer. Everything downstream is the shipped reconciliation.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `return 2` branch and let the `new_ok` arm win: the run succeeds and adopts a
  //      candidate on an ambiguous reading. This test fails on its status assertion and on
  //      JOURNAL_LEFT, alone in the repo.
  //   2. move the negative control BEFORE the candidate probes: no behaviour here changes (the
  //      control is refused either way) but the run costs one extra connection on every endpoint
  //      that refuses both candidates. Recorded as a no-op so the ordering is not mistaken for
  //      load-bearing.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = runShipped(installVars(cluster, root), `
      ${REINSTALL_BODY}
      write_role_rotation_journal "live-password" "live-password" postgres || exit 7
    `)
    assert.equal(interrupted.status, 0, interrupted.output)

    const next = runShipped(installVars(cluster, root), NEXT_RUN_BODY)
    assert.equal(next.status, 9, `an ambiguous reading must not resolve:\n${next.output}`)
    assert.match(next.output, /accepts BOTH recorded candidates/, 'for the reason the finding names')
    assert.match(next.output, /an endpoint that DID refuse a random password/, 'and it says the control passed, so the ambiguity is real')
    assert.match(next.output, /LEFT IN PLACE/, 'and the record is kept')
    assert.doesNotMatch(next.output, /INSTALLED_B64/, 'nothing past the refusal ran')
    assert.equal(readFileSync(join(root, '.env'), 'utf8').includes('live-password'), true, 'and .env was not republished')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
