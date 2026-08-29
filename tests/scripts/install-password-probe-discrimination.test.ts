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
 * AND r41 PUT A SECOND QUESTION IN FRONT OF THAT ONE — whose password the endpoint is checking,
 * asked of the server. It changed what these first nine tests measure, so their mutation notes were
 * re-measured rather than re-read: a `trust` endpoint is now dropped by the method gate before the
 * control is reached, so removing the control no longer breaks any of them. Test 15 is the only
 * test in this file that still catches that removal, and it exists for exactly that reason. The
 * r41 block below the ninth test says the rest.
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
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  NEXT_RUN_BODY,
  REINSTALL_BODY,
  REPO,
  SHIPPED_ROTATION_UP_TO_THE_CLEAR,
  connectWithDriver,
  decodeVar,
  envDatabaseUrl,
  installVars,
  journalValue,
  readVar,
  runShipped,
  seedLiveInstallation,
  writeInstalledEnv,
} from './install-shell-rig.ts'
import { type Cluster, cleanLibpqEnv, currentUser, freePort, pgBinDir, startCluster } from './real-postgres-cluster.ts'
import { sliceRange } from './redis-url-wire-harness.ts'
import { type RadiusVerifier, radiusHbaLine, startRadiusVerifier } from './radius-verifier.ts'

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
  //   1. disable the gate in rotate_database_password_in_fenced_window() (`if true; then` over
  //      the endpoint search): the rotation proceeds, and this test fails on its status assertion,
  //      on ROTATED_ANYWAY and on the live-credential assertion. Tests 5 and 8 fail with it.
  //   2. keep the gate but drop the NEGATIVE CONTROL from db_endpoint_discriminates_passwords() —
  //      i.e. return 0 as soon as the positive password connects. NOTHING HERE FAILS ANY MORE, and
  //      that is r41's doing: `trust` is refused one step earlier, by the method gate, because the
  //      server answers AuthenticationOk and names a rule that checks no password at all. This was
  //      the route that mattered in r40 and it is now covered by test 15 ALONE — measured, and
  //      recorded here so the next reader does not look for it in this test.
  //   3. keep the control but drop the POSITIVE half: the gate then passes on any endpoint that
  //      refuses a random password, including one behind a revoked CONNECT. Nothing here fails;
  //      tests 5, 8 and 10 are what catch it.
  //   4. drop the `datname <> :'dbname'` exclusion from db_connectable_databases_except_app(): the
  //      application database — which still checks passwords — becomes a candidate, the gate is
  //      satisfied by it, and the rotation proceeds. Same three failures here, and test 5 with it.
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
      if on_route postgres disable db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "CONTROL_ACCEPTED_ON_POSTGRES=yes"
      else
        echo "CONTROL_ACCEPTED_ON_POSTGRES=no"
      fi
      # ...and the application database still checks, so the cluster is not simply open.
      if on_route one_two_inventory disable db_endpoint_accepts_password one_two_inventory "a-password-nothing-has-ever-set"; then
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
    // r41: under `trust` the endpoint is now discarded ONE STEP EARLIER than it was in r40 — the
    // server answers the startup message with AuthenticationOk, naming a rule that checks no
    // password at all, so the method gate drops it before the negative control is ever run. The
    // negative-control sentence is therefore no longer the one an operator sees here, and this
    // assertion follows the code rather than the other way round.
    assert.match(run.output, /'postgres' does not authenticate 'imsuser' against PostgreSQL's own role credential/, 'and it reports the endpoint that was refused')
    assert.match(run.output, /the matched pg_hba method reads as 'trust'/, 'naming the method the SERVER said it matched')
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
  //   1. restore r39's first-success-wins body in reconcile_interrupted_role_rotation() — probe
  //      `new` on postgres then the application database, take the first success, then `old`. The
  //      run succeeds, adopts `rotated-secret`, and publishes it. This test fails on its status
  //      assertion, on ADOPTED and on JOURNAL_LEFT. It is the widest-blast-radius mutation
  //      measured on this branch — SEVEN tests fail, including r39's own boundary (4) and every
  //      probe test that depends on WHICH endpoint answered — which is the right shape for
  //      reverting the finding itself.
  //   2. drop the negative control from db_endpoint_discriminates_passwords(): NOTHING here fails
  //      any more. In r40 both candidates connected under `trust`, the endpoint was admitted and
  //      the run refused with the wrong message; in r41 the method gate has already dropped a
  //      `trust` endpoint before the control is reached. Test 15 is the only test in this file that
  //      still catches that removal — measured.
  //   3. turn BOTH `|| continue`s in resolve_live_role_password() into `|| return 1`: the loop
  //      stops at the first endpoint it cannot use, which here is `postgres`, so the run refuses
  //      for the right reason and the wrong endpoints are never reported. This test fails on its
  //      second endpoint assertion, with tests 3 and 10.
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
      if on_route postgres disable db_endpoint_accepts_password postgres "nothing-has-ever-set-this"; then
        echo "CLUSTER_IS_OPEN=yes"
      else
        echo "CLUSTER_IS_OPEN=no"
      fi
      ${NEXT_RUN_BODY}
      echo "ADOPTED=$(printf '%s' "\${DB_ROTATION_RECONCILED_PASSWORD}" | base64 | tr -d '\\n')"
    `)
    assert.match(next.output, /CLUSTER_IS_OPEN=yes/, 'precondition: this cluster must accept any password, or the test is about nothing')

    assert.equal(next.status, 9, `a probe that cannot refuse must not decide:\n${next.output}`)
    assert.match(next.output, /could not find a single endpoint that both checks POSTGRESQL'S OWN role credential for 'imsuser' and can tell one password from another/, 'for the reason the finding names')
    // r41: both endpoints are `trust`, and `trust` is now refused at the method gate — the server
    // asks for no password at all — so both report the matched method rather than the acceptance
    // of the random control.
    assert.match(next.output, /'postgres' does not authenticate 'imsuser' against PostgreSQL's own role credential/, 'and it reports the maintenance database')
    assert.match(next.output, /'one_two_inventory' does not authenticate 'imsuser' against PostgreSQL's own role credential/, 'and the application database')
    assert.match(next.output, /the matched pg_hba method reads as 'trust'/, 'naming what the server said it matched')
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
  //      the method gate or the sensitivity pair: the recorded endpoint is trust, the loop stops
  //      there, and the run refuses. This test fails on its status assertion, with tests 2 and 10.
  //   2. drop the recorded endpoint from db_probe_endpoint_candidates(): NOTHING here fails,
  //      because the recorded endpoint is `postgres`, which the derived list reaches first anyway.
  //      Test 9 is the one that discriminates the record from the derivation; recorded here so the
  //      next reader does not look for it in this test.
  //   3. drop the negative control: NOTHING here fails any more. In r40 `postgres` was admitted on
  //      its trust acceptance and the run refused with the AMBIGUOUS verdict; in r41 the method
  //      gate drops it first, so the control never sees it. Test 15 is the only test left that
  //      catches the control's removal — measured, and recorded so it is not looked for here.
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
    assert.match(next.output, /Established on 'one_two_inventory', whose matched pg_hba rule the server named as scram-sha-256 or md5/, 'and the success must say where and on what evidence')
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
  //   1. drop `"${DB_NAME}"` from the end of db_probe_endpoint_candidates(): the application
  //      database is never asked, no endpoint can be shown password-sensitive, and the run refuses.
  //      This test fails on its status assertion — and that failure is the whole reason the
  //      application database is on the list at all, as a LAST RESORT rather than a first choice.
  //      Three other tests fail with it, all for the same reason.
  //   2. restore r39's first-success-wins reconciliation: `postgres` refuses both candidates, the
  //      fallback probes the application database with no control at all, and the run answers
  //      `old` — the right password, from an endpoint it never showed could discriminate, and
  //      recorded as having come from `postgres`. This test fails on PROBE_DB, which is the only
  //      assertion here that can see the difference. Six other tests fail with it.
  //   3. drop the POSITIVE half of the sensitivity pair: nothing here fails. `postgres` refuses
  //      the control AND both candidates, so `resolve_live_role_password` skips it before the pair
  //      is consulted at all. Tests 5, 8 and 10 are what catch that route; recorded so the next
  //      reader does not look for it here.
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
      if on_route postgres disable db_endpoint_accepts_password postgres "live-password"; then
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
  //      its status assertion, on ROTATED_ANYWAY and on the live-credential assertion. Test 8 fails
  //      with it.
  //   2. let the rotation gate reach ${DB_NAME}, by dropping the `datname <> :'dbname'` exclusion
  //      from db_connectable_databases_except_app(): the application database still checks
  //      passwords, so the gate is satisfied by an endpoint that will be BEHIND THE FENCE when a
  //      reconciliation runs, and the rotation succeeds here and strands the next run. This test
  //      fails on its status assertion, with test 1.
  //   3. disable the gate entirely: same three failures here, with tests 1 and 8.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC'])

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      if on_route postgres disable db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
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
  //      journal assertion. The reconciliation on THIS cluster still works, because the derived
  //      list starts at `postgres` anyway — which is exactly why the recording needs an assertion
  //      of its own — but tests 8 and 9 fail with it, and those are the two where the recorded
  //      endpoint is the only thing that reaches the right place.
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
  //   2. resolve the ambiguity to `old` instead of refusing (set `new_ok=false` where the
  //      `return 2` was): the run succeeds and adopts `live-password` — which on this cluster is
  //      the RIGHT password, reached by a rule that has no way of knowing that. This test fails on
  //      its status assertion, alone, which is the point: the refusal is the property, not which
  //      candidate a guess would have landed on.
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

// ---------------------------------------------------------------------------
// 8. The hardened site: the only password-checked endpoint is neither of the two obvious ones
// ---------------------------------------------------------------------------

test('r40: a site with no CONNECT on postgres rotates against a database the server named, and reconciles there', async () => {
  // THE OVER-REFUSAL THIS ROUND HAD TO AVOID. Revoking PUBLIC CONNECT on the maintenance database
  // is ordinary hardening, and a rotation gate that only ever asks `postgres` would refuse every
  // such site — trading r39's wrong answer for a wrong refusal. So the candidates are READ FROM THE
  // SERVER, and what this test proves is that the whole chain then works end to end on a cluster
  // where neither `postgres` nor the application database can answer:
  //
  //   the shipped gate picks a database the server named, RECORDS it, the rotation commits, the run
  //   is interrupted before the journal is cleared, THE FENCE GOES UP over the application database
  //   — which is the real state a reconciliation runs in — and the next run still resolves.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. reduce db_unfenced_probe_candidates() to `_unfenced=(postgres)`: the gate finds nothing,
  //      the rotation refuses, and this test fails on the interrupted run's status. Alone.
  //   2. drop the probe_database line from write_role_rotation_journal(): the reconciliation
  //      derives its own list, and neither `postgres` nor the fenced application database can
  //      answer, so the run refuses. This test fails on its status assertion, with tests 6 and 9.
  //   3. drop the POSITIVE half of the sensitivity pair, or disable the rotation gate: the gate
  //      settles on `postgres` — which refuses everything here — and records it, so the
  //      reconciliation would have nothing usable. This test fails on GATE_PROBE_DB, the first
  //      assertion that can see it, with test 5.
  //   4. drop the `datname <> :'dbname'` exclusion from db_connectable_databases_except_app():
  //      NOTHING here fails, because `ims_spare_probe` sorts before `one_two_inventory` and is
  //      chosen either way. Tests 1 and 5 are what catch that route.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    // The hardened site, and the one other database this cluster holds.
    cluster.psql(['-c', 'CREATE DATABASE ims_spare_probe'])
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC'])

    const interrupted = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    assert.equal(interrupted.status, 0, `the rotation must find an endpoint the server named:\n${interrupted.output}`)
    assert.match(interrupted.output, /GATE_PROBE_DB=ims_spare_probe/, 'and it must be the spare database, not the maintenance one and not the application one')
    assert.match(interrupted.output, /Rotation endpoint proven: on 'ims_spare_probe' the server itself named a/, 'and the run must say so')

    // The rotation completed here, so re-create the state a crash before the clear leaves: the
    // journal standing over a server that already has the new password.
    const rejournalled = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      ${REINSTALL_BODY}
      write_role_rotation_journal "live-password" "rotated-secret" ims_spare_probe || exit 7
    `)
    assert.equal(rejournalled.status, 0, rejournalled.output)
    assert.equal(journalValue(root, 'probe_database'), 'ims_spare_probe')

    // AND NOW THE FENCE, which is what a reconciliation actually runs under.
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE one_two_inventory FROM PUBLIC'])
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE one_two_inventory FROM imsuser'])

    const next = runShipped(installVars(cluster, root), `
      if on_route postgres disable db_endpoint_accepts_password postgres "rotated-secret"; then echo "POSTGRES_ANSWERS=yes"; else echo "POSTGRES_ANSWERS=no"; fi
      if on_route one_two_inventory disable db_endpoint_accepts_password one_two_inventory "rotated-secret"; then echo "APPDB_ANSWERS=yes"; else echo "APPDB_ANSWERS=no"; fi
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.match(next.output, /POSTGRES_ANSWERS=no/, 'precondition: the maintenance database must be closed to this role')
    assert.match(next.output, /APPDB_ANSWERS=no/, 'precondition: and the fence must be standing over the application database')

    assert.equal(next.status, 0, `the recorded endpoint must still answer:\n${next.output}`)
    assert.match(next.output, /PROBE_DB=ims_spare_probe/, 'on the endpoint the rotating run proved')
    assert.match(next.output, /server has the NEW password/)
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'and the record is cleared')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. "Reuse that exact endpoint" is a behaviour, not a comment
// ---------------------------------------------------------------------------

test('r40: the reconciliation asks the RECORDED endpoint, not the one it would have derived', async () => {
  // THE DISCRIMINATING CASE, and it exists because test 8 cannot be it: there, the recorded
  // endpoint is also the only one that works, so honouring the record and re-deriving a list give
  // the same answer and the record proves nothing.
  //
  // Here BOTH endpoints can discriminate. `postgres` is reachable and checks passwords, so a
  // reconciliation that derives its own list answers on `postgres`; the journal names
  // `ims_spare_probe`, so one that honours the record answers there. The credential resolved is
  // identical either way — WHICH ENDPOINT ANSWERED is the whole observable, and it is exactly the
  // property Codex asked for: the run that reconciles asks the place the run that rotated proved,
  // rather than one it derived for itself under whatever pg_hba.conf now says.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. drop the recorded endpoint from db_probe_endpoint_candidates() (iterate
  //      `"${unfenced[@]}" "${DB_NAME}"`): the list starts at `postgres`, which discriminates, so
  //      the run succeeds with the right password on the WRONG endpoint. This test fails on
  //      PROBE_DB and on the success message, alone in the repo.
  //   2. put the recorded endpoint LAST instead of first: same two failures, same test. Recorded
  //      because "the record is in the list somewhere" is not the property — being asked FIRST is.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')
    cluster.psql(['-c', 'CREATE DATABASE ims_spare_probe'])

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'ims_spare_probe')
    assert.equal(interrupted.status, 0, interrupted.output)
    assert.equal(journalValue(root, 'probe_database'), 'ims_spare_probe', 'precondition: the journal names the spare database')

    const next = runShipped(installVars(cluster, root), `
      # PRECONDITION: the endpoint a re-derived list would reach FIRST is fully able to answer, so
      # the assertion below is about which one was asked and not about which one could be.
      if db_endpoint_is_password_sensitive postgres "live-password"; then
        echo "POSTGRES_WOULD_ANSWER=yes"
      else
        echo "POSTGRES_WOULD_ANSWER=no"
      fi
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.match(next.output, /POSTGRES_WOULD_ANSWER=yes/, 'precondition: postgres must be able to discriminate, or the record is not what steered this')

    assert.equal(next.status, 0, next.output)
    assert.match(next.output, /PROBE_DB=ims_spare_probe/, 'the reconciliation must ask the endpoint the journal recorded')
    assert.match(next.output, /Established on 'ims_spare_probe'/, 'and say so')
    assert.match(next.output, /still has the OLD password/, 'and reach the right answer on it')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'live-password')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// r41 (Codex HIGH): WHOSE PASSWORD THE ENDPOINT IS CHECKING
//
// Everything above proves an endpoint can tell one password from another. None of it proves the
// password it tells apart is POSTGRESQL'S ROLE CREDENTIAL — the only thing `ALTER ROLE` changes.
// `ldap`, `pam`, `radius` and `bsd` are password-DEPENDENT and role-credential-INDEPENDENT: under
// every one of them the negative control refuses the random password, the positive half accepts the
// asserted one, and the endpoint is admitted while answering about somebody else's store.
//
// The five tests below are built on a REAL external verifier (tests/scripts/radius-verifier.ts) for
// the reason every cluster in this file is real: a stub that refuses everything would make the OLD
// probe fail on its positive half, so a regression written against it would pass on r40's code and
// prove nothing. The verifier here says YES to one password and NO to another, and the role's own
// password is a third thing — which is exactly the gap the outage falls into.
//
// A NOTE ON THE VERSIONS. What the tests measure is not this suite's PostgreSQL. It is the
// Authentication request message of protocol 3.0, which every version this installer meets — 14 on
// Ubuntu 22.04 through 17 on Debian 13 — sends in the same bytes. That is why the mechanism is the
// startup exchange and not `pg_hba_file_rules` (a rule listing is not a match), not a catalogue
// (none names the matched method of a live backend; verified on 17), and not libpq's
// `require_auth` (absent before libpq 16, which is half the estate).
// ---------------------------------------------------------------------------

/** The RADIUS secret and the two databases every test below is arranged around. */
const RADIUS_SECRET = 'a-radius-shared-secret'

/**
 * r41's db_endpoint_accepts_password(), RESTORED — the pin removed and nothing else changed.
 *
 * It is a copy of shipped bytes, which this file otherwise refuses to make. It is here as a
 * MUTATION and not as a model: test 17 runs it beside the shipped one, on one cluster, so that
 * "the pin is what makes the difference" is a measurement rather than a sentence in a comment. If
 * it ever drifts from what r41 shipped the test simply measures a different unpinned probe, which
 * is still an unpinned probe.
 */
const R41_UNPINNED_PROBE = `
db_endpoint_accepts_password() {
  local database="$1" password="$2"
  pg_endpoint_psql "\${DB_USER}" "\${password}" "\${database}" -tAc 'SELECT 1' >/dev/null 2>&1
}
`

/**
 * THE SHIPPED READER, RUN DIRECTLY ON A ROUTE THE TEST NAMES (r43).
 *
 * Its EXIT STATUS is a verdict — 1 for every method that is not the role's own — so a test that
 * used execFileSync's exception as a failure would be unable to measure the refusals at all. What
 * these call sites are after is the REPORT, which the reader writes on stdout on every path.
 */
function readerOn(port: number, sslmode: string, database = 'postgres'): string {
  try {
    return execFileSync('node', [
      join(REPO, 'scripts/lib/pg-auth-request.mjs'),
      '--host=127.0.0.1', `--port=${port}`, '--user=imsuser', `--database=${database}`,
      `--sslmode=${sslmode}`,
    ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? '')
  }
}

/**
 * r42's ROUTE DERIVATION, RESTORED — the reference point moved back from the application to the
 * reader, and nothing else changed.
 *
 * Through r42 there was no route to ASK for: the reader observed on libpq's default
 * `sslmode=prefer` and the caller pinned its probes to whatever came back. It is therefore the
 * restoration of the r41 reference point as well as the r42 one — r41 differs only in that its
 * probes were not pinned to it, which R41_UNPINNED_PROBE below restores separately. On every cluster this constant is used with,
 * `prefer` negotiates TLS — they all ship `ssl = on` and carry a `hostssl` record — so the route
 * r42 observed and pinned to is `require`, and asking for it reproduces r42's behaviour exactly:
 * the same record read, the same pin, the same admission. It is a MUTATION and not a model; it is
 * here so that "r42 succeeds and the application is still down" is a measurement.
 */
const R42_PROBE_ROUTE = `
db_application_route_sslmode() { printf 'require'; }
`

/** A connection that states its sslmode, which pg_endpoint_psql cannot: `hostnossl` needs one. */
function psqlWithSslMode(port: number, password: string, database: string, sslmode: string): boolean {
  try {
    execFileSync('psql', [
      '-X', '-w', '-q', '-tAc', 'SELECT 1',
      `postgresql://imsuser:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?sslmode=${sslmode}`,
    ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 10. THE LOAD-BEARING ONE: an external verifier is not admitted as evidence
// ---------------------------------------------------------------------------

test('r41: an endpoint whose rule is an EXTERNAL verifier is not admitted, and the right password is published', async () => {
  // CODEX'S SCENARIO, BUILT. `postgres` authenticates through RADIUS; the application database uses
  // scram. The RADIUS directory knows `live-password` and nothing else. The rotation to
  // `rotated-secret` COMMITTED and the run then died before `.env` was published — boundary (2),
  // where the only safe answer is to finish the transition.
  //
  // UNDER r40 THAT ENDPOINT IS EVIDENCE AND THE EVIDENCE IS WRONG. RADIUS refuses the random
  // control and accepts `live-password`, so `postgres` is admitted; it then refuses
  // `rotated-secret`, because a directory has never heard of an `ALTER ROLE`; so the reconciliation
  // concludes the ALTER did not commit, publishes the OLD password and CLEARS THE JOURNAL. The
  // application database now wants the new one. The service cannot start and the record that would
  // have recovered it has been deleted.
  //
  // BOTH HALVES OF THAT ARE MEASURED BELOW rather than asserted in a comment: that r40's pair passes
  // on the RADIUS endpoint, and that the role's real credential is refused there.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `db_endpoint_checks_role_verifier "${database}" || continue` line from
  //      resolve_live_role_password(): `postgres` is admitted on r40's pair, answers `old`, and the
  //      run publishes `live-password` and clears the journal. This test fails on PROBE_DB, on
  //      INSTALLED_B64, and on the driver connection at the end — which is the outage itself.
  //      Tests 2 and 11 fail with it.
  //   2. admit AuthenticationCleartextPassword in scripts/lib/pg-auth-request.mjs (return
  //      verifier 'role' for code 3): identical failures. This is the route a fix that "looks
  //      right" takes, because cleartext-against-postgres really is role-credential-checked — and
  //      the wire cannot tell it from this. Tests 11 and 13 fail with it.
  //   3. make db_endpoint_checks_role_verifier() return 0 whenever the reader cannot be run: the
  //      gate becomes advisory and route 1's failures reappear on any host without node. Test 15
  //      is what catches that directly.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  let radius: RadiusVerifier | undefined
  try {
    radius = await startRadiusVerifier(root, RADIUS_SECRET, 'imsuser', 'live-password')
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [radiusHbaLine('postgres', radius.port, RADIUS_SECRET)])
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    // The ALTER committed; the run died before `.env` was replaced.
    cluster.psql(['-c', "ALTER USER imsuser WITH PASSWORD 'rotated-secret'"])

    const next = runShipped(installVars(cluster, root), `
      # PRECONDITION 1, MEASURED: r40's pair PASSES on the RADIUS endpoint. If it did not, this
      # cluster would not be the configuration the finding is about.
      if on_route postgres disable db_endpoint_discriminates_passwords postgres "live-password"; then
        echo "R40_PAIR_PASSES_ON_RADIUS=yes"
      else
        echo "R40_PAIR_PASSES_ON_RADIUS=no"
      fi
      # PRECONDITION 2, MEASURED: and it is wrong. The role's ACTUAL credential — the one the ALTER
      # committed — is refused there, because the directory never heard of the ALTER.
      if on_route postgres disable db_endpoint_accepts_password postgres "rotated-secret"; then
        echo "RADIUS_KNOWS_THE_ROLES_PASSWORD=yes"
      else
        echo "RADIUS_KNOWS_THE_ROLES_PASSWORD=no"
      fi
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 | tr -d '\\n')"
    `)
    assert.match(next.output, /R40_PAIR_PASSES_ON_RADIUS=yes/, 'precondition: the external verifier must look exactly like a healthy endpoint to r40')
    assert.match(next.output, /RADIUS_KNOWS_THE_ROLES_PASSWORD=no/, 'precondition: and it must be answering about a different credential entirely')

    assert.equal(next.status, 0, `the run must resolve on the endpoint that checks the ROLE:\n${next.output}`)
    assert.match(next.output, /PROBE_DB=one_two_inventory/, 'the RADIUS endpoint must not be the one that answered')
    assert.match(next.output, /server has the NEW password/, 'and the answer must be the true one: the ALTER committed')
    assert.equal(decodeVar(next.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.match(next.output, /JOURNAL_LEFT=no/, 'the transition is finished, so the record goes')

    // AND THE REFUSAL IS EXPLAINED WHERE AN OPERATOR WOULD LOOK.
    const report = Buffer.from(decodeVar(next.output, 'REPORT_B64'), 'utf8').toString('utf8')
    assert.match(report, /'postgres' does not authenticate 'imsuser' against PostgreSQL's own role credential/, 'the report must name the endpoint that was dropped')
    assert.match(report, /the matched pg_hba method reads as 'password-or-external'/, 'and the method the server itself announced')
    assert.match(report, /`password`, `ldap`, `pam`, `radius` and `bsd` all ask for/, 'and why that message cannot be resolved further')

    // THE VERIFIER WAS ACTUALLY CONSULTED, so the endpoint really was external and this test is not
    // quietly measuring a cluster where the rule failed to load.
    const asked = radius.asked()
    assert.ok(asked.some((line) => line.startsWith('imsuser ')), `the RADIUS directory must have been asked about the role: ${JSON.stringify(asked)}`)
    assert.ok(asked.includes('imsuser accept'), 'and it must have ACCEPTED one of the passwords, which is what made r40 believe it')
    assert.ok(asked.includes('imsuser reject'), 'and refused another, which is what made r40 believe it was discriminating')

    // AND THE FILE THE SERVICE RESTARTS FROM OPENS A CONNECTION, which under r40 it would not.
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser')
  } finally {
    cluster?.stop()
    await radius?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11. And when the external verifier is the ONLY reachable endpoint: refuse, and keep the record
// ---------------------------------------------------------------------------

test('r41: with only an external verifier reachable the reconciliation REFUSES and keeps both candidates', async () => {
  // THE SAME CLUSTER WITH THE FENCE STANDING, which is the state a reconciliation actually runs in:
  // the interrupted run revoked CONNECT on the application database and never got to release it. So
  // the only endpoint `imsuser` can reach is the RADIUS one, and r40 would have taken its answer.
  //
  // THE ALTER DID NOT COMMIT here, and RADIUS says `live-password` — so r40's answer would have been
  // RIGHT BY LUCK and the journal would have been cleared on evidence that proves nothing. This
  // round refuses instead, because "the directory happens to agree today" is not a property any
  // future run can rely on, and clearing the journal is the irreversible half.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the method gate from resolve_live_role_password(): the RADIUS endpoint is admitted,
  //      the run resolves `old`, publishes it and CLEARS THE JOURNAL. This test fails on its status
  //      assertion, on JOURNAL_LEFT and on RECONCILED. Test 10 fails with it.
  //   2. admit AuthenticationCleartextPassword in the reader: identical failures.
  //   3. drop the negative control from db_endpoint_discriminates_passwords(): nothing here fails —
  //      the method gate has already refused the only endpoint that could answer. Tests 1, 2 and 3
  //      are what catch that route; recorded so the next reader does not look for it here.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  let radius: RadiusVerifier | undefined
  try {
    radius = await startRadiusVerifier(root, RADIUS_SECRET, 'imsuser', 'live-password')
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [radiusHbaLine('postgres', radius.port, RADIUS_SECRET)])
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    // THE FENCE, as the interrupted run left it: the application database is closed to the role.
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE one_two_inventory FROM PUBLIC'])
    cluster.psql(['-c', 'REVOKE CONNECT ON DATABASE one_two_inventory FROM imsuser'])

    const next = runShipped(installVars(cluster, root), `
      if on_route postgres disable db_endpoint_discriminates_passwords postgres "live-password"; then
        echo "R40_WOULD_HAVE_ANSWERED=yes"
      else
        echo "R40_WOULD_HAVE_ANSWERED=no"
      fi
      if on_route one_two_inventory disable db_endpoint_accepts_password one_two_inventory "live-password"; then
        echo "APP_DB_REACHABLE=yes"
      else
        echo "APP_DB_REACHABLE=no"
      fi
      ${NEXT_RUN_BODY}
    `)
    assert.match(next.output, /R40_WOULD_HAVE_ANSWERED=yes/, 'precondition: r40 would have adopted this endpoint, or this test is about nothing')
    assert.match(next.output, /APP_DB_REACHABLE=no/, 'precondition: and the fence must leave nothing else to ask')

    assert.equal(next.status, 9, `an answer from a directory is not an answer about the role:\n${next.output}`)
    assert.match(next.output, /could not find a single endpoint that both checks POSTGRESQL'S OWN role credential/, 'for the reason the finding names')
    assert.match(next.output, /an ldap, pam, radius or bsd rule answers confidently about a password held somewhere ALTER ROLE cannot reach/, 'and it says which shape of rule it refused')
    assert.match(next.output, /the matched pg_hba method reads as 'password-or-external'/, 'naming what the server itself announced')
    assert.match(next.output, /LEFT IN PLACE/, 'and the record is kept')
    assert.doesNotMatch(next.output, /RECONCILED=true/, 'nothing past the refusal ran')

    // BOTH CANDIDATES SURVIVE, which is the whole reason the refusal is preferable to the lucky
    // right answer: the next operator still has them.
    assert.equal(Buffer.from(journalValue(root, 'old_password_b64')!, 'base64').toString('utf8'), 'live-password')
    assert.equal(Buffer.from(journalValue(root, 'new_password_b64')!, 'base64').toString('utf8'), 'rotated-secret')
    assert.equal(envDatabaseUrl(root), `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`, 'and .env was not republished')
  } finally {
    cluster?.stop()
    await radius?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 12. THE OTHER SIDE OF IT: an ordinary scram-sha-256 endpoint still qualifies
// ---------------------------------------------------------------------------

test('r41: an ordinary scram-sha-256 endpoint still qualifies and the rotation proceeds', async () => {
  // THE COST OF THE RULE, MEASURED. A gate that refuses more than it should is this branch's other
  // failure mode — "a refusal whose precondition nobody can satisfy" — and every ordinary
  // installation this script performs runs on exactly the cluster below: initdb's default, which is
  // `scram-sha-256` for host connections. So this test is the one that would go red if the new gate
  // were too strict, and it drives the WHOLE rotation rather than the gate alone: the ALTER
  // commits, `.env` is republished, the journal is cleared, and the installed driver opens a
  // connection with the credential the file names.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make db_endpoint_checks_role_verifier() `return 1` unconditionally: no endpoint qualifies,
  //      the rotation refuses before the ALTER, and this test fails on the run's status, on ROTATED
  //      and on the driver connection. EVERY OTHER TEST IN THIS FILE FAILS WITH IT — sixteen of
  //      sixteen, measured — which is the correct blast radius for disabling the gate, and is why
  //      no other route can be mistaken for this one.
  //   2. require `verifier=external` instead of `verifier=role` in the reader's exit status: same
  //      failures here.
  //   3. point db_auth_request_probe_path() at ${APP_DIR} instead of the release's own lib
  //      directory: the reader is not there, the gate refuses, same failures. Test 15 is the one
  //      that states that refusal's message.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      # WHAT THE SERVER SAID, printed rather than inferred: this is the fact the whole gate rests on.
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^method=scram-sha-256$/m, 'precondition: the default cluster must present the method this gate admits')
    assert.match(reader, /^verifier=role$/m, 'and the reader must classify it as the role\'s own credential')
    assert.match(reader, /pg_authid\.rolpassword/, 'and say which secret that is')

    assert.equal(run.status, 0, `an ordinary cluster must still rotate:\n${run.output}`)
    assert.match(run.output, /GATE_PROBE_DB=postgres/, 'on the maintenance database, which is where the gate looks first')
    assert.match(run.output, /ROTATED=true/, 'and the ALTER must have run')
    assert.match(run.output, /Rotation endpoint proven: on 'postgres' the server itself named a/, 'and the run must say what it established')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser', 'and the published file must open a connection')
    assert.match(envDatabaseUrl(root), /rotated-secret/, 'with the credential the ALTER installed')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 13. THE NARROWING, STATED: `password` checks the role's own secret and is refused anyway
// ---------------------------------------------------------------------------

test('r41: a cleartext `password` rule is refused too, because the wire cannot tell it from ldap', async () => {
  // THIS IS THE PRICE OF THE MECHANISM AND IT IS PAID DELIBERATELY. `password` in pg_hba.conf
  // compares the supplied plaintext against pg_authid.rolpassword — it IS role-credential-checked,
  // and an answer from it would have been sound. But it asks for the plaintext with
  // AuthenticationCleartextPassword, which is the same message `ldap`, `pam`, `radius` and `bsd`
  // send, and must be: an external verifier can only be consulted with the plaintext. Nothing in
  // the protocol separates the safe one from the four unsafe ones, so all five are refused.
  //
  // The test exists so that the narrowing is a measured property and not a paragraph. It measures
  // that this endpoint genuinely DOES discriminate — r40's pair passes on it — and that the run
  // refuses regardless, naming the ambiguity as the reason.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. return verifier 'role' for authentication request 3 in scripts/lib/pg-auth-request.mjs:
  //      the endpoint is admitted, the rotation proceeds, and this test fails on its status
  //      assertion and on ROTATED_ANYWAY. Test 10 fails with it — which is the point: the two
  //      failures together are why the narrowing is not negotiable.
  //   2. drop the `password-or-external` branch entirely so the reader falls through to its
  //      unrecognised-code answer: this test still passes on status but fails on the two
  //      assertions that quote the explanation, which is what an operator has to act on.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', ['host postgres all 127.0.0.1/32 password'])
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      # PRECONDITION, MEASURED: r40's pair passes here. A cleartext rule really does check the
      # role's password, so this is a sound endpoint being refused for what it cannot prove.
      if on_route postgres disable db_endpoint_discriminates_passwords postgres "live-password"; then
        echo "R40_PAIR_PASSES=yes"
      else
        echo "R40_PAIR_PASSES=no"
      fi
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.match(run.output, /R40_PAIR_PASSES=yes/, 'precondition: a `password` rule must discriminate, or this test is not about the narrowing')

    assert.equal(run.status, 9, `an ambiguous authentication request is not evidence:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and nothing past the refusal ran')
    assert.match(run.output, /the matched pg_hba method reads as 'password-or-external'/, 'the refusal names what the server announced')
    assert.match(run.output, /an external verifier has to be handed the plaintext, so it must ask for the plaintext/, 'and why the five cannot be separated')
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'and says the role still holds the credential .env names')

    // AND THE ROLE IS UNTOUCHED, which is what makes refusing cheap.
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser')
    assert.match(envDatabaseUrl(root), /live-password/, 'the file still names the credential the server has')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE FOUR MUTATIONS THE r43 TESTS BELOW WERE MEASURED AGAINST
//
// Each was applied to the shipped bytes and the whole file re-run; the notes on the individual
// tests name these by number rather than repeating the blast radius five times.
//
//   M1  db_application_route_sslmode() prints `require` instead of `disable`.
//       19 of 21 FAIL. This is not "r42 restored" and must not be read as it: most clusters in
//       this file are `initdb` clusters with `ssl = off`, so a pinned `require` cannot complete a
//       handshake at all and the gate refuses everywhere. It is the blast radius of DISABLING the
//       gate, and it is recorded so that a later reader does not mistake it for a narrow one.
//   M2  r42 RESTORED FAITHFULLY: the route derivation prints `prefer` (libpq's own, which is what
//       r42 observed on) AND the reported-route comparison in db_endpoint_checks_role_verifier()
//       goes back to r42's `case "${sslmode}" in require|disable)`.
//       EXACTLY the five r43 tests fail -- 14, 14b, 14c, 17 and 20 -- and all sixteen pre-r43
//       tests pass. This is the discriminating mutation: it is the difference r43 makes, and
//       nothing else.
//   M3  the reader ignores its `--sslmode=` argument and sends the SSLRequest regardless
//       (`requested === 'disable'` replaced by `false`).
//       14, 14b, 14c and 17 fail; 20 does not, because it drives stub readers rather than the
//       shipped one. This is what makes "the reader is TOLD the route" a checked claim.
//   M4  the `route=(...)` assignment is deleted from pg_endpoint_psql(), so the psql probes are
//       unpinned while the reader is still aligned.
//       14b, 14c and 17 fail; 14 does not, because it refuses one step earlier on the method.
// ---------------------------------------------------------------------------

// 14. THE TRANSPORT: the route the APPLICATION takes is the one the reader must read (r43)
// ---------------------------------------------------------------------------

test('r43: a cluster only TLS can authenticate on is REFUSED, because the application never gets there', async () => {
  // WHAT THIS TEST USED TO SAY, AND WHY IT CHANGED. Through r42 it asserted that the reader
  // negotiates TLS the way libpq's `sslmode=prefer` does, so that it read the `hostssl` record
  // "the psql beside it" matched. Both halves were true and both were about the wrong connection:
  // the psql beside it is a PROBE, and the connection this whole gate exists to vouch for is the
  // APPLICATION'S. Its own closing comment said so out loud -- it skipped connectWithDriver()
  // because "node-postgres does NOT negotiate TLS unless told to" -- and then asserted the ALTER
  // with a TLS psql instead, which is the substitution that hid the outage.
  //
  // MEASURED, AGAINST THE INSTALLED DRIVER: `pg` 8.20.0 handed the URL compose_database_url()
  // produces puts the StartupMessage on the wire with no SSLRequest at all. On the cluster below --
  // `hostssl scram-sha-256` over `hostnossl reject` -- that connection is REJECTED. So there is no
  // credential this run could publish that would start the application, and the only correct
  // outcome is a refusal BEFORE the ALTER, with the role still holding what `.env` names.
  //
  // MUTATIONS (see the block above these tests; each was applied and the file re-run):
  //   M2 -- r42 restored: the reader is back on the TLS record, reads scram-sha-256, the gate
  //      passes and the rotation proceeds. This test fails on the reader's requested/ssl/method
  //      lines, on the run's status and on the two credential assertions at the end. THAT RUN IS
  //      THE OUTAGE: the ALTER lands and the application still cannot connect.
  //   M3 -- the reader sends the SSLRequest anyway: it reports `sslmode=require` against a
  //      `requested=disable` and the comparison refuses, so the run still refuses -- but for the
  //      wrong reason, and this test fails on the `ssl=not-offered` and `method=none` lines and on
  //      the server-quote assertion.
  //   M4 -- the psql pin removed: NO CHANGE here. The gate refuses one step earlier, on the
  //      method, so no probe is ever opened. 14b and 17 are what measure that line.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 scram-sha-256',
      'hostnossl all all 127.0.0.1/32 reject',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // PRECONDITIONS, MEASURED FROM OUTSIDE THE SHELL: only the TLS transport reaches a rule at all
    // here, and THE APPLICATION'S OWN DRIVER cannot reach one.
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), false,
      'precondition: a cleartext connection must reach no usable record')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), true,
      'precondition: and the TLS record must accept the live credential')
    await assert.rejects(
      connectWithDriver(`postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`),
      'precondition: and the installed driver, given the URL this installer emits, must be refused')

    // AND THE READER CAN STILL SEE THE TLS RECORD WHEN IT IS TOLD TO -- so what follows is a
    // decision about which route to observe, not an inability to observe the other one.
    const onRequire = readerOn(cluster.port, 'require')
    assert.match(onRequire, /^ssl=yes$/m, 'told `require`, the reader negotiates TLS')
    assert.match(onRequire, /^method=scram-sha-256$/m, 'and reads the hostssl record')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      echo "APP_ROUTE=$(db_application_route_sslmode)"
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    assert.match(run.output, /APP_ROUTE=disable/, 'the route the gate observes on is the driver\'s, and the shipped derivation says so')
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^requested=disable$/m, 'the reader is put on the application\'s route')
    assert.match(reader, /^ssl=not-offered$/m, 'and sends no SSLRequest, which is what the driver does')
    assert.match(reader, /^method=none$/m, 'so the hostnossl reject record answers it, and no method is readable there')

    assert.equal(run.status, 9, `the rotation must REFUSE rather than publish a credential the application cannot present:\n${run.output}`)
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'before the one step with no undo')
    // THE SERVER'S OWN WORDS FOR THE ROUTE THAT WAS TAKEN. It refused this connection under
    // `no encryption`, which is the hostnossl record and is the record the application meets.
    assert.match(run.output, /pg_hba\.conf rejects connection for host "127\.0\.0\.1", user "imsuser", database "postgres", no encryption/,
      'and the report quotes the server refusing the APPLICATION\'s transport, not a probe\'s')
    assert.doesNotMatch(run.output, /ROTATED=true/, 'the ALTER must not have run')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'one_two_inventory', 'require'), true,
      'so the role still holds the credential .env names')
    assert.equal(psqlWithSslMode(cluster.port, 'rotated-secret', 'one_two_inventory', 'require'), false,
      'and not the one that was asked for')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 14b. THE SPLIT ITSELF: a hostssl rule the PROBES satisfy over the hostnossl one the
//      APPLICATION takes, where the two disagree (r43)
// ---------------------------------------------------------------------------

test('r43: a hostssl rule the probes could satisfy does not vouch for the hostnossl one the application takes', async () => {
  // THE SCENARIO THE WHOLE ROUND IS ABOUT, IN ITS SIMPLEST FORM:
  //
  //   hostssl  all all 127.0.0.1/32 scram-sha-256   <- what a TLS probe meets. Impeccable.
  //   hostnossl all all 127.0.0.1/32 trust          <- what the APPLICATION meets. Checks nothing.
  //
  // Under r42 the reader observed on libpq's `prefer`, landed on the hostssl record, reported
  // `scram-sha-256`, and the psql probes were pinned to `require` and discriminated perfectly --
  // BOTH INSTRUMENTS PASS. Every one of those measurements is repeated below and every one of them
  // still holds. And none of them is about the connection the application makes: node-postgres,
  // handed the URL this installer emits, is admitted by `trust` with a password nothing has ever
  // set, which is measured here with the installed driver rather than argued.
  //
  // So an interrupted rotation on this cluster could never be reconciled from the endpoint the
  // application uses -- every candidate would be accepted -- and the gate must refuse BEFORE the
  // ALTER. It does, and the report names trust.
  //
  // MUTATIONS (see the block above these tests; each was applied and the file re-run):
  //   M2 -- r42 restored: the reader reads the hostssl record, the gate admits it, the rotation
  //      runs, and this test fails on the reader's requested/method lines, on the run's status and
  //      on the trust report assertion.
  //   M3 -- the reader sends the SSLRequest anyway: same failures on the reader lines; the run
  //      still refuses, on the route comparison rather than on trust.
  //   M4 -- the psql pin removed: R42_PAIR_ON_TLS becomes `refuses` -- unpinned, the control's
  //      random password fails scram, falls back to the clear and is let in by trust -- and this
  //      test fails on that precondition, which is r42's own claim being re-measured here.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 scram-sha-256',
      'hostnossl all all 127.0.0.1/32 trust',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // PRECONDITION, MEASURED: the two transports really are two different records.
    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'disable'), true,
      'precondition: the hostnossl record must be trust')
    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'require'), false,
      'precondition: and the hostssl record must check the password')
    // AND THE APPLICATION'S OWN DRIVER LANDS ON THE TRUST ONE. This is the measurement r42 never
    // made: the URL is the shape compose_database_url() emits and the password is one nothing set.
    assert.equal(
      await connectWithDriver(`postgresql://imsuser:a-password-nothing-has-ever-set@127.0.0.1:${cluster.port}/one_two_inventory`),
      'imsuser',
      'precondition: the installed driver is admitted by trust, so nothing it does is evidence about a password')

    // WHAT r42's INSTRUMENTS SAY HERE, RUN RATHER THAN RECALLED: both of them pass.
    const onRequire = readerOn(cluster.port, 'require')
    assert.match(onRequire, /^method=scram-sha-256$/m, 'on the TLS route the reader reads an admissible method')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      # r42's PROBE PAIR, on r42's route, through the SHIPPED functions: it discriminates.
      if on_route postgres require db_endpoint_discriminates_passwords postgres "live-password"; then
        echo "R42_PAIR_ON_TLS=passes"
      else
        echo "R42_PAIR_ON_TLS=refuses"
      fi
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    assert.match(run.output, /R42_PAIR_ON_TLS=passes/, 'r42\'s credential pair is satisfied on r42\'s route')

    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^requested=disable$/m, 'and the shipped gate observes on the application\'s route instead')
    assert.match(reader, /^method=trust$/m, 'where the server asks for no password at all')

    assert.equal(run.status, 9, `the endpoint the application uses cannot tell one password from another:\n${run.output}`)
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'so the rotation refuses before the step with no undo')
    assert.match(run.output, /the server asked for NO password at all \(AuthenticationOk\)/,
      'and the report says what the application\'s own route does')
    assert.doesNotMatch(run.output, /ROTATED=true/, 'nothing was altered')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'one_two_inventory', 'require'), true,
      'and the role still holds the credential .env names')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 14c. THE OTHER DIRECTION: the application's route is the GOOD one, and the gate says yes
// ---------------------------------------------------------------------------

test('r43: the gate VALIDATES the application\'s route, on a cluster where only the probe\'s route is useless', async () => {
  // THE SAME SPLIT, INVERTED, so that "aligned to the application" is shown to be a decision about
  // WHICH connection is authoritative and not a blanket new refusal:
  //
  //   hostssl  all all 127.0.0.1/32 trust           <- what a TLS probe would meet. Useless.
  //   hostnossl all all 127.0.0.1/32 scram-sha-256  <- what the APPLICATION meets. Sound.
  //
  // Under r42 the reader preferred TLS, read `trust`, and the gate refused a rotation that is
  // perfectly safe -- a refusal whose precondition the operator could not satisfy without turning
  // TLS off. Under r43 the observation is made where the application connects, the method is
  // scram-sha-256, the ALTER runs, and THE APPLICATION'S OWN DRIVER opens a connection with the
  // credential the published file names.
  //
  // MUTATIONS (see the block above these tests; each was applied and the file re-run):
  //   M2 -- r42 restored: the reader reads `trust` on the TLS record, the gate refuses a rotation
  //      that is perfectly safe, and this test fails on the run's status, on ROTATED and on the
  //      driver connection at the end. THIS IS THE REFUSAL r43 REMOVES.
  //   M3 -- the reader sends the SSLRequest anyway: it reads `trust` and reports `require` against
  //      `requested=disable`, so the comparison refuses; same failures, one line further on.
  //   M4 -- the psql pin removed: the probes run on `prefer`, land on the hostssl trust record and
  //      accept the negative control, so the discrimination half refuses. Same failures.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 trust',
      'hostnossl all all 127.0.0.1/32 scram-sha-256',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'require'), true,
      'precondition: the TLS record must be trust, so a probe on it proves nothing')
    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'disable'), false,
      'precondition: and the cleartext record must check the password')

    const onRequire = readerOn(cluster.port, 'require')
    assert.match(onRequire, /^method=trust$/m, 'r42\'s route reads trust here, which is why r42 refused')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^requested=disable$/m, 'the gate observes where the application connects')
    assert.match(reader, /^sslmode=disable$/m, 'and reports the same route back, which is what the comparison checks')
    assert.match(reader, /^method=scram-sha-256$/m, 'and finds the role\'s own credential there')

    assert.equal(run.status, 0, `a sound cleartext record must still rotate:\n${run.output}`)
    assert.match(run.output, /GATE_PROBE_DB=postgres/, 'on the maintenance database')
    assert.match(run.output, /ROTATED=true/, 'and the ALTER runs')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser',
      'and THE APPLICATION\'S OWN DRIVER opens a connection with the published credential')
    assert.match(envDatabaseUrl(root), /rotated-secret/, 'which is the one the ALTER installed')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 15. AN UNKNOWN REFUSES: no reader, no answer, no rotation
// ---------------------------------------------------------------------------

test('r41: a rotation refuses when the matched method cannot be established at all', async () => {
  // THIS BRANCH'S STANDING RULE, APPLIED TO THE NEW QUESTION. If the matched method cannot be
  // established, that is an unknown, and an unknown refuses — before the ALTER, so the role still
  // holds the credential its clients have and `.env` still names it. The alternative is a gate that
  // silently becomes advisory on any host where the reader is missing, which is the same defect as
  // a pin nobody checks.
  //
  // The cluster here is the ORDINARY one — the same default scram cluster that rotates happily in
  // test 12 — so the only difference between green and red is whether the question could be asked.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. make db_endpoint_checks_role_verifier() `return 0` when the reader is absent: the rotation
  //      proceeds, and this test fails on its status assertion and on ROTATED_ANYWAY. Nothing else
  //      fails, because every other test has a working reader — which is why this one exists.
  //   2. drop the `[[ -f "${probe}" ]]` check and let node fail instead: the run still refuses, but
  //      the report says whatever node's module loader said, so this test fails on the two
  //      assertions that quote the actionable sentence.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped({
      ...installVars(cluster, root),
      DB_PASSWORD: 'rotated-secret',
      IMS_AUTH_REQUEST_PROBE: join(root, 'no-such-reader.mjs'),
    }, `
      # PRECONDITION, MEASURED: this cluster is otherwise perfectly rotatable — r40's pair passes.
      if on_route postgres disable db_endpoint_discriminates_passwords postgres "live-password"; then
        echo "R40_PAIR_PASSES=yes"
      else
        echo "R40_PAIR_PASSES=no"
      fi
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    assert.match(run.output, /R40_PAIR_PASSES=yes/, 'precondition: only the missing reader may be what stops this run')

    assert.equal(run.status, 9, `an unestablished method is an unknown, and an unknown refuses:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and nothing past the refusal ran')
    assert.match(run.output, /was not asked which pg_hba rule matches it, because the reader that asks/, 'the report says what could not be done')
    assert.match(run.output, /Re-run the installer from a complete release checkout/, 'and what to do about it')
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'and that nothing was taken away')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 17. THE LOAD-BEARING ONE FOR r43: the gate publishes, and the APPLICATION cannot connect
// ---------------------------------------------------------------------------

test('r43: aligned to the probes, reconciliation publishes a credential the application\'s own route rejects', async () => {
  // CODEX'S SCENARIO, BUILT, AND THEN BUILT AGAIN ONE LAYER OUT.
  //
  //   hostssl  all all 127.0.0.1/32 scram-sha-256     <- the role's own credential
  //   hostnossl all all 127.0.0.1/32 radius           <- a directory holding the OLD password
  //
  // r41's instruments both passed on this cluster while answering about different transports, and
  // r42 removed that divergence by pinning every probe to the route the READER observed. It did
  // remove it -- run 2 below is r42's code and it reconciles cleanly, exactly as r42 claimed.
  //
  // AND THE APPLICATION IS STILL DOWN, WHICH IS r43'S FINDING. node-postgres, handed the URL
  // compose_database_url() emits, sends no SSLRequest: it is matched by the hostnossl record and
  // authenticated by RADIUS, which never heard of the ALTER and still holds `live-password`. So
  // r42 publishes the new SCRAM password, CLEARS THE JOURNAL -- destroying the only record of the
  // other candidate -- and leaves an installation whose application cannot start. That is measured
  // here with the installed driver against the file the run published, which is the assertion r42
  // substituted a TLS psql for.
  //
  // RUN 3 is the shipped r43 gate: it observes on the application's route, is answered by RADIUS
  // with AuthenticationCleartextPassword, refuses, and LEAVES THE JOURNAL so both candidates
  // survive for a person to settle. Nothing is published and nothing is destroyed.
  //
  // THE THREE RUNS SHARE ONE CLUSTER AND ONE JOURNAL, in this order, because each earlier one
  // leaves the state the next needs: runs 1 and 3 refuse and leave the journal in place, and run 2
  // is the only one that consumes it -- so it is run with a `.env` restored underneath it and its
  // effect is undone before run 3 begins.
  //
  // MUTATIONS (see the block above these tests; each was applied and the file re-run):
  //   M2 -- r42 restored: run 3 becomes run 2. It reconciles, publishes the SCRAM password and
  //      clears the journal, and this test fails on run 3's reader lines, on its status, on
  //      LEFT IN PLACE and on the final driver connection. THE OUTAGE, RESTORED.
  //   M3 -- the reader sends the SSLRequest anyway: run 3 refuses on the route comparison instead
  //      of on the method, and this test fails on its `method=password-or-external` line and on
  //      the report assertion that names the rule shape.
  //   M4 -- the psql pin removed: RUN 2 stops reconciling -- the old password fails scram, falls
  //      back to the clear and RADIUS accepts it, so both candidates read live -- and this test
  //      fails on run 2's status. Run 3 is unaffected: it refuses one step earlier, on the method.
  //      This is r42's own claim, still measured, one round on.
  //   Also measured, outside the four: make db_endpoint_checks_role_verifier() admit
  //   `password-or-external` as verifier=role and run 3 adopts whichever candidate RADIUS accepts;
  //   this test fails on run 3's status and on LEFT IN PLACE, and tests 10, 11 and 13 fail with it.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  let radius: RadiusVerifier | undefined
  try {
    radius = await startRadiusVerifier(root, RADIUS_SECRET, 'imsuser', 'live-password')
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 scram-sha-256',
      radiusHbaLine('all', radius.port, RADIUS_SECRET, 'hostnossl'),
    ], { ssl: true })
    seedLiveInstallation(cluster)
    const installedEnv = writeInstalledEnv(root, cluster.port, 'live-password')

    // PRECONDITIONS, MEASURED FROM OUTSIDE THE SHELL: the two transports are two records, and the
    // one underneath is a directory that knows the CURRENT password and only that.
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), true,
      'precondition: the hostssl record must check the role\'s own credential and accept it')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), true,
      'precondition: and the hostnossl record must be a directory holding that same password')
    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'disable'), false,
      'precondition: which refuses everything else, so the negative control is satisfied by it')
    // AND THE APPLICATION IS ON THE SECOND OF THOSE TWO — measured with the installed driver, on
    // the URL shape this installer emits, before anything has been rotated.
    assert.equal(
      await connectWithDriver(`postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/one_two_inventory`),
      'imsuser',
      'precondition: the driver connects on the cleartext route, which is the RADIUS one')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    // The ALTER committed; the run died before `.env` was replaced. Boundary (2): the only safe
    // answer is to FINISH the transition — IF anything here can say what the transition was.
    cluster.psql(['-c', "ALTER USER imsuser WITH PASSWORD 'rotated-secret'"])

    // AND NOW THE TWO RECORDS DISAGREE, which is the whole finding.
    assert.equal(psqlWithSslMode(cluster.port, 'rotated-secret', 'postgres', 'require'), true,
      'precondition: scram has the new password')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), false,
      'precondition: and not the old one')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), true,
      'precondition: while the directory still has the old one, because it never heard of the ALTER')

    // ---- RUN 1: r41, restored — the pre-r43 reference point AND the unpinned probe, which is what
    // r41 was. It refuses, because both candidates read as live.
    const unpinned = runShipped(installVars(cluster, root), `
      ${R42_PROBE_ROUTE}
      ${R41_UNPINNED_PROBE}
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.equal(unpinned.status, 9, `unpinned, both candidates are accepted and the run must refuse:\n${unpinned.output}`)
    assert.match(unpinned.output, /accepts BOTH recorded candidates/, 'and say that is what it saw')
    assert.match(unpinned.output, /LEFT IN PLACE/, 'leaving the journal, which is what makes the runs below possible')

    // ---- RUN 2: r42, restored — the reader observes on libpq's `prefer` and the probes follow it.
    // THIS RUN SUCCEEDS, AND THAT IS THE DEFECT.
    const r42 = runShipped(installVars(cluster, root), `
      ${R42_PROBE_ROUTE}
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.equal(r42.status, 0, `aligned to the reader, r42 reconciles and publishes:\n${r42.output}`)
    assert.match(r42.output, /has the NEW password: the ALTER committed/, 'it reaches the answer the SCRAM record gives')
    assert.match(r42.output, /JOURNAL_LEFT=no/, 'and CLEARS THE JOURNAL, so the other candidate is gone')
    const r42Url = envDatabaseUrl(root)
    assert.match(r42Url, /rotated-secret/, 'the published file names the SCRAM password')
    // THE ASSERTION r42 DID NOT MAKE. The file it published is handed to the installed driver,
    // opened the way the application opens it — and RADIUS refuses it.
    await assert.rejects(connectWithDriver(r42Url),
      (error: Error) => /password|authentication/i.test(error.message),
      'AND THE APPLICATION CANNOT CONNECT WITH IT: the route it takes is the directory, which holds the old password')
    assert.equal(await connectWithDriver(installedEnv.match(/^DATABASE_URL=(.*)$/m)![1]), 'imsuser',
      'while the credential r42 just discarded is the one that does work there')

    // Undo run 2 so run 3 meets the state run 1 left: the journal back, `.env` naming the old one.
    writeInstalledEnv(root, cluster.port, 'live-password')
    const restored = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(restored.status, 0, restored.output)

    // ---- RUN 3: the shipped r43 gate, aligned to the APPLICATION.
    const shipped = runShipped(installVars(cluster, root), `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    const reader = Buffer.from(readVar(shipped.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^requested=disable$/m, 'the reader is put on the application\'s own route')
    assert.match(reader, /^method=password-or-external$/m, 'where the RADIUS record answers, and the wire cannot name it')

    assert.equal(shipped.status, 9, `on the application's route nothing here is evidence, so the run must refuse:\n${shipped.output}`)
    assert.match(shipped.output, /an ldap, pam, radius or bsd rule answers confidently about a password held somewhere ALTER ROLE cannot reach/,
      'and say which shape of rule it refused')
    assert.match(shipped.output, /LEFT IN PLACE/, 'keeping BOTH candidates, which is what run 2 destroyed')
    assert.equal(journalValue(root, 'probe_database'), 'postgres', 'the journal is still readable')
    assert.match(envDatabaseUrl(root), /live-password/, 'and nothing was published over the file that still names a working credential')
    assert.equal(await connectWithDriver(envDatabaseUrl(root)), 'imsuser',
      'which the application can still use, so the refusal costs no availability at all')
  } finally {
    await radius?.stop()
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 18. WHAT THE NEGATIVE CONTROL IS STILL FOR: a reload between the two connections
// ---------------------------------------------------------------------------

test('r42: a pg_hba reload between the reader and the probe is caught by the negative control', async () => {
  // THE PIN CLOSES THE TRANSPORT DIVERGENCE AND NOTHING ELSE. The reader and the probe are still
  // two connections, and pg_hba.conf can change between them: `pg_ctl reload` is how every
  // configuration-management run on every host applies one. After it, the server that answered the
  // reader with `scram-sha-256` answers the probe with `trust` -- on the SAME transport, so no pin
  // can see it. A proxy or pooler on ${DB_HOST}:${DB_PORT} that speaks SASL without verifying
  // lands in the same place, and neither is reachable by any amount of route-binding.
  //
  // SO THIS IS THE TEST THAT KEEPS THE NEGATIVE CONTROL IN THE CODE. Since r41 the method gate
  // refuses a `trust` endpoint one step earlier, so the r40 tests no longer reach the control;
  // since r42 the fallback that test 14b used to exercise no longer happens. Without this test,
  // deleting the control would break nothing in the suite -- measured, which is why it is here.
  //
  // THE RELOAD IS INJECTED AT THE ONE INSTANT THAT MATTERS, by wrapping the SHIPPED method gate:
  // it runs, it succeeds, and only then is pg_hba rewritten and reloaded. Nothing about the gate
  // itself is replaced -- `declare -f` copies the shipped bytes -- and the flip happens once.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. drop the negative control from db_endpoint_discriminates_passwords() -- return 0 as soon
  //      as the positive password connects: `postgres` is admitted on the reader's word alone, the
  //      rotation proceeds against an endpoint that by then accepts anything, and this test fails
  //      on its status assertion, on ROTATED_ANYWAY and on the stored verifier having changed.
  //      NOTHING ELSE IN THE SUITE FAILS: measured, and it is the reason this test exists.
  //   2. drop the POSITIVE half instead: nothing here fails -- the random control already refuses
  //      this endpoint. Tests 5, 8 and 10 are what catch that.
  //   3. delete the method gate: nothing here fails either, for the same reason. Recorded so the
  //      next reader does not look for it here.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1')
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // THE ROLE'S STORED VERIFIER, BEFORE. Read over the socket as the cluster superuser, so that
    // "the ALTER did not happen" is an assertion about pg_authid and not about a log line.
    const verifierBefore = cluster.psql(['-tAc', "SELECT rolpassword FROM pg_authid WHERE rolname = 'imsuser'"])
    assert.ok(verifierBefore.startsWith('SCRAM-SHA-256$'), `precondition: the role must hold a SCRAM verifier: ${verifierBefore}`)

    const run = runShipped({
      ...installVars(cluster, root),
      DB_PASSWORD: 'rotated-secret',
      IMS_TEST_HBA: join(cluster.data, 'pg_hba.conf'),
      IMS_TEST_PGCTL: join(pgBinDir(), 'pg_ctl'),
      IMS_TEST_PGDATA: cluster.data,
    }, `
      # THE SHIPPED GATE, COPIED RATHER THAN REWRITTEN, and then wrapped.
      eval "shipped_checks_role_verifier() $(declare -f db_endpoint_checks_role_verifier | tail -n +2)"
      db_endpoint_checks_role_verifier() {
        local status=0
        shipped_checks_role_verifier "$@" || status=\${?}
        if [[ "\${status}" -eq 0 && ! -e "\${APP_DIR}/reloaded" ]]; then
          : > "\${APP_DIR}/reloaded"
          printf 'host all all 127.0.0.1/32 trust\\n' | cat - "\${IMS_TEST_HBA}" > "\${IMS_TEST_HBA}.new"
          mv "\${IMS_TEST_HBA}.new" "\${IMS_TEST_HBA}"
          "\${IMS_TEST_PGCTL}" -D "\${IMS_TEST_PGDATA}" reload >/dev/null 2>&1
          # A RELOAD IS ASYNCHRONOUS: SIGHUP returns before the postmaster has re-read the file.
          # Poll until a password nothing can know is accepted, so the test measures the control
          # and never a race. The connection is deliberately unpinned -- this cluster has one
          # record per transport, so it is a readiness probe and not a route.
          for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
            if ( DB_ENDPOINT_ROUTE_SSLMODE=""; pg_endpoint_psql "\${DB_USER}" "definitely-not-the-password" postgres -tAc 'SELECT 1' ) >/dev/null 2>&1; then
              echo "RELOADED_TO_TRUST=yes"
              break
            fi
            sleep 0.2
          done
        fi
        return "\${status}"
      }
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres --sslmode="$(db_application_route_sslmode)" > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "ROTATED_ANYWAY"
    `)
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^method=scram-sha-256$/m, 'precondition: before the reload the endpoint is a healthy scram one')
    assert.match(reader, /^sslmode=disable$/m, 'on the one transport this cluster has, so no pin could tell the two records apart')
    assert.match(run.output, /RELOADED_TO_TRUST=yes/, 'precondition: and the reload really did land between the reader and the probe')

    assert.equal(run.status, 9, `the control must refuse an endpoint that has become trust since the reader saw it:\n${run.output}`)
    assert.doesNotMatch(run.output, /ROTATED_ANYWAY/, 'and nothing past the refusal ran')
    assert.match(run.output, /'postgres' ACCEPTED a random 32-byte password/, 'naming the half of the gate that caught it')
    assert.match(run.output, /THE ALTER HAS NOT BEEN ISSUED/, 'and saying the role is untouched')
    assert.equal(
      cluster.psql(['-tAc', "SELECT rolpassword FROM pg_authid WHERE rolname = 'imsuser'"]),
      verifierBefore,
      'which pg_authid must agree with: the stored verifier is byte for byte what it was',
    )
    assert.match(envDatabaseUrl(root), /live-password/, 'and the environment file still names it')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 19. NO ROUTE, NO PROBE — and the refusal is the guard's, not the endpoint's
// ---------------------------------------------------------------------------

test('r42: a credential probe with no route established refuses, on an endpoint that accepts everything', async () => {
  // THE RULE r42 ADDS IS "PIN OR REFUSE", and both halves of it have to be a property of the CODE
  // rather than of the order the two callers in install.sh happen to use. Measured: with the
  // guards deleted and everything else left alone, the whole of the rest of this file still
  // passes — so without this test they would be exactly the thing this branch keeps calling out,
  // a guard that cannot fail.
  //
  // THE CLUSTER IS WHAT MAKES THE MEASUREMENT MEAN ANYTHING. `host all all 127.0.0.1/32 trust`
  // accepts every password on every database, so a connection opened here CANNOT be refused by the
  // server. A refusal is therefore the guard's, and the first line below measures that rather than
  // assuming it: routed, the very same call on the very same bytes succeeds.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `[[ -n "${DB_PROBE_SSLMODE}" ... ]] || return 1` line from
  //      db_endpoint_accepts_password(): UNROUTED_ACCEPTS becomes `yes` and this test fails on it.
  //      Nothing else in the suite fails — measured, on all eighteen other tests.
  //   2. delete the route check from db_endpoint_discriminates_passwords(): the pair still returns
  //      1, because its own two probes are refused by the guard above — so UNROUTED_PAIR does NOT
  //      move. What moves is the REPORT: it blames the endpoint for refusing both candidates
  //      instead of naming the question that was skipped, and this test fails on the report
  //      assertion. Nothing else in the suite fails.
  //   3. delete both: UNROUTED_ACCEPTS becomes `yes`, the pair is then satisfied by a `trust`
  //      endpoint, and this test fails on three assertions at once.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', TRUST_EVERYTHING)
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    const run = runShipped(installVars(cluster, root), `
      # PRECONDITION, MEASURED: with a route stated, this endpoint accepts a password nothing has
      # ever set. So every refusal below is manufactured here and not by the server.
      if on_route postgres disable db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "ROUTED_ACCEPTS=yes"
      else
        echo "ROUTED_ACCEPTS=no"
      fi
      # AND WITH NO READER HAVING SPOKEN, the same call on the same bytes refuses.
      if db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "UNROUTED_ACCEPTS=yes"
      else
        echo "UNROUTED_ACCEPTS=no"
      fi
      DB_PROBE_REPORT=""
      if db_endpoint_discriminates_passwords postgres "a-password-nothing-has-ever-set"; then
        echo "UNROUTED_PAIR=yes"
      else
        echo "UNROUTED_PAIR=no"
      fi
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
    `)
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /ROUTED_ACCEPTS=yes/, 'precondition: routed, this endpoint accepts anything')
    assert.match(run.output, /UNROUTED_ACCEPTS=no/, 'and unrouted the probe refuses rather than sending a credential')
    assert.match(run.output, /UNROUTED_PAIR=no/, 'so the pair cannot be satisfied by it either')
    const report = Buffer.from(readVar(run.output, 'REPORT_B64'), 'base64').toString('utf8')
    assert.match(report, /was not probed with a credential at all, because no reader has established which TRANSPORT/,
      'and the report names the question that was skipped, rather than blaming the endpoint for a refusal this run made')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 20. A METHOD READ ON SOMEBODY ELSE'S ROUTE IS NOT AN ADMISSION (r43)
// ---------------------------------------------------------------------------

test('r43: a method read on any route but the application\'s is refused, including one r42 would have pinned to', () => {
  // WHAT THE SHIPPED READER CANNOT PRODUCE TODAY, WHICH IS WHY IT NEEDS A STUB. The reader is TOLD
  // which route to take and reports the route it took, and it takes the one it was told; so the
  // branch in db_endpoint_checks_role_verifier() that refuses an admissible METHOD carrying the
  // WRONG ROUTE is unreachable through the shipped reader, and would sit there unexercised until
  // somebody taught the reader to ignore its argument — which is precisely the failure the
  // comparison exists to catch.
  //
  // A READER IS EXACTLY WHAT THAT CONTRACT IS WITH, so the test supplies three, differing in ONE
  // LINE, through IMS_AUTH_REQUEST_PROBE — which the shipped path already exposes for the
  // regressions and which cannot produce an exemption: pointing it somewhere else produces a
  // refusal, never an admission.
  //
  //   `prefer`   a route that cannot be pinned to at all. Refused, as it was under r42.
  //   `require`  A PERFECTLY GOOD PIN, AND THE ONE r42 ADMITTED. Refused here, because it is not
  //              the route the application takes — which is the whole of r43 in one assertion.
  //   `disable`  the application's own route. Admitted, and published.
  //
  // NO CLUSTER AND NO CONNECTION. db_endpoint_checks_role_verifier() runs a program and parses its
  // output; it sends no password and opens no psql. The port below is deliberately one nothing is
  // listening on, so a version of this that DID connect would fail rather than quietly pass.
  //
  // MUTATIONS (see the block above these tests; each was applied and the file re-run):
  //   M2 -- r42 restored: APP_ROUTE becomes `prefer`, REQUIRE_ADMITTED becomes `yes` and
  //      REQUIRE_ROUTE becomes `require`, and this test fails on all three. It is the only one of
  //      the five r43 tests that needs no cluster, so it is the one that isolates the comparison
  //      itself from everything the clusters also measure.
  //   M3 -- the reader sends the SSLRequest anyway: NO CHANGE. This test drives stub readers, not
  //      the shipped one. 14, 14b, 14c and 17 are what cover that line.
  //   M4 -- the psql pin removed: no change either; nothing here opens a psql.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  try {
    const reader = (sslmode: string) =>
      `process.stdout.write('requested=asked\\ntransport=tcp\\nssl=yes\\nsslmode=${sslmode}\\nmethod=scram-sha-256\\nverifier=role\\ndetail=a stub reader\\n')\n`
    writeFileSync(join(root, 'reader-prefer.mjs'), reader('prefer'))
    writeFileSync(join(root, 'reader-require.mjs'), reader('require'))
    writeFileSync(join(root, 'reader-disable.mjs'), reader('disable'))

    const run = runShipped({
      APP_DIR: root,
      APP_USER: currentUser(),
      DB_HOST: '127.0.0.1',
      // A port nothing holds: this path must not open a connection, and if it ever does it fails.
      DB_PORT: '1',
      DB_NAME: 'one_two_inventory',
      DB_USER: 'imsuser',
    }, `
      echo "APP_ROUTE=$(db_application_route_sslmode)"
      DB_PROBE_REPORT=""
      IMS_AUTH_REQUEST_PROBE="\${APP_DIR}/reader-prefer.mjs"
      if db_endpoint_checks_role_verifier postgres; then echo "PREFER_ADMITTED=yes"; else echo "PREFER_ADMITTED=no"; fi
      echo "PREFER_ROUTE=\${DB_PROBE_SSLMODE}"
      # THE ONE r42 WOULD HAVE TAKEN. Same method, a pinnable route, and still not the application's.
      DB_PROBE_REPORT=""
      IMS_AUTH_REQUEST_PROBE="\${APP_DIR}/reader-require.mjs"
      if db_endpoint_checks_role_verifier postgres; then echo "REQUIRE_ADMITTED=yes"; else echo "REQUIRE_ADMITTED=no"; fi
      echo "REQUIRE_ROUTE=\${DB_PROBE_SSLMODE}"
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
      # THE CONTROL: the SAME stub with one word changed. If this did not qualify, the refusals
      # above would be about something else entirely.
      IMS_AUTH_REQUEST_PROBE="\${APP_DIR}/reader-disable.mjs"
      if db_endpoint_checks_role_verifier postgres; then echo "DISABLE_ADMITTED=yes"; else echo "DISABLE_ADMITTED=no"; fi
      echo "DISABLE_ROUTE=\${DB_PROBE_SSLMODE}"
      echo "DISABLE_ENDPOINT=\${DB_PROBE_ROUTE_DATABASE}"
    `)
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /APP_ROUTE=disable/, 'precondition: the application\'s route is the cleartext one')
    assert.match(run.output, /PREFER_ADMITTED=no/, 'a route that cannot be pinned to is not a route')
    assert.match(run.output, /PREFER_ROUTE=$/m, 'and nothing is published, so no probe can run on it')
    assert.match(run.output, /REQUIRE_ADMITTED=no/, 'and neither is a pinnable route that is not the application\'s')
    assert.match(run.output, /REQUIRE_ROUTE=$/m, 'so nothing is published for that one either')
    const report = Buffer.from(readVar(run.output, 'REPORT_B64'), 'base64').toString('utf8')
    assert.match(report, /not on the transport the APPLICATION uses/, 'the report names whose route was missed')
    assert.match(report, /it was asked to read the rule on 'disable'/, 'and which route that was')
    assert.match(report, /hostssl and hostnossl being different records/, 'and why that is not a formality')

    assert.match(run.output, /DISABLE_ADMITTED=yes/, 'control: the same method on the application\'s route qualifies')
    assert.match(run.output, /DISABLE_ROUTE=disable/, 'and the route is published as the reader stated it')
    assert.match(run.output, /DISABLE_ENDPOINT=postgres/, 'bound to the endpoint it was read on')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 21. AND WHERE THE APPLICATION'S ROUTE ITSELF IS UNKNOWN, EVERYTHING REFUSES
// ---------------------------------------------------------------------------

test('r43: a DATABASE_URL the driver was not measured against stops the gate rather than defaulting it', () => {
  // THE STANDING RULE OF THIS BRANCH, APPLIED TO THE NEW REFERENCE POINT. `disable` is not a
  // constant in db_application_route_sslmode(): it asks the SHIPPED composer what URL this run
  // would publish and answers about that, so the derivation cannot drift away from the thing it
  // describes. A URL carrying a query string is one node-postgres was NOT measured against — the
  // driver reads `sslmode`, `ssl` and `uselibpqcompat` out of it and changes transport — so the
  // route is unknown, and an unknown refuses.
  //
  // The unreachable-today shape is reached here through DB_NAME, which is the only one of the four
  // identity values that compose_database_url() does not percent-encode. A password cannot do it:
  // url_encode_userinfo() keeps only the RFC 3986 unreserved set, so a `?` reaches the URL as
  // `%3F`, and the first assertion measures that rather than asserting it.
  //
  // MUTATIONS (measured):
  //   - delete the `*\?*) return 1` arm: UNKNOWN_ROUTE becomes `disable`, the gate goes on to
  //     observe on a route the driver would not take, and this test fails on both assertions about
  //     it. Nothing else in the suite fails, which is why this test exists.
  //   - make the function print a constant instead of asking the composer: identical failure, and
  //     ENCODED_ROUTE stops being evidence of anything.
  const run = runShipped({
    APP_DIR: '/nonexistent',
    APP_USER: currentUser(),
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',
    DB_NAME: 'one_two_inventory',
    DB_USER: 'imsuser',
  }, `
    echo "ORDINARY_ROUTE=$(db_application_route_sslmode || echo REFUSED)"
    # A PASSWORD CANNOT REACH THE QUERY STRING: the composer encodes the userinfo.
    echo "ENCODED_URL=$(compose_database_url "\${DB_USER}" 'a?b' "\${DB_HOST}" "\${DB_PORT}" "\${DB_NAME}")"
    ( DB_NAME='one_two_inventory?sslmode=require'
      # r44: the derivation PRINTS ITS REASON and returns 1, so the status is read separately
      # rather than through \`|| echo REFUSED\` -- the reason is now what the caller quotes.
      if unknown="$(db_application_route_sslmode)"
      then echo "UNKNOWN_ROUTE=admitted:\${unknown}"
      else echo "UNKNOWN_ROUTE=REFUSED:\${unknown}"
      fi
      DB_PROBE_REPORT=""
      if db_endpoint_checks_role_verifier postgres; then echo "UNKNOWN_ADMITTED=yes"; else echo "UNKNOWN_ADMITTED=no"; fi
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)" )
  `)
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /ORDINARY_ROUTE=disable/, 'precondition: the ordinary URL has a known route')
  assert.match(run.output, /ENCODED_URL=postgresql:\/\/imsuser:a%3Fb@/, 'and a `?` in the password cannot create a query string')
  assert.match(run.output, /UNKNOWN_ROUTE=REFUSED:/, 'a URL with a query string has no route this run has measured')
  assert.match(run.output, /UNKNOWN_ROUTE=REFUSED:.*carries a query string/,
    'and since r44 the derivation says WHICH of the several ways the route is unknowable this is')
  assert.match(run.output, /UNKNOWN_ADMITTED=no/, 'so no endpoint is asked which rule it matches')
  const report = Buffer.from(readVar(run.output, 'REPORT_B64'), 'base64').toString('utf8')
  assert.match(report, /cannot say which TRANSPORT the application's own connection takes/,
    'and the report names the question that could not be answered')
})

// ---------------------------------------------------------------------------
// 22. THE LOAD-BEARING ONE FOR r44: PGSSLMODE puts the application on the OTHER record
//
// THE FINDING (Codex HIGH). r43 answered `disable` because the composed URL has no query string.
// That is not why node-postgres connects in the clear: the URL leaves `ssl` undefined and the
// driver then reads `process.env.PGSSLMODE`. So a host that sets it — in the installer's own
// environment, in the manager's, or in the unit — has an application on `hostssl` while this gate
// reads, probes and rotates against `hostnossl`, which is the exact post-upgrade outage r43 exists
// to prevent, arriving through the door r43 did not look at.
//
// THE CLUSTER IS THE ONE CODEX NAMED, ROUND THE WAY THAT MAKES THE GATE WRONG RATHER THAN MERELY
// DIFFERENT:
//
//   hostssl   all all 127.0.0.1/32 trust            <- what the application meets. Checks nothing.
//   hostnossl all all 127.0.0.1/32 scram-sha-256    <- what the gate reads. Impeccable.
//
// EVERY PRECONDITION HERE IS MEASURED WITH THE INSTALLED DRIVER against that cluster, because the
// claim under test is about what pg does and not about what this file believes pg does.
// ---------------------------------------------------------------------------

/** What the INSTALLED driver does with one URL under one environment: does it get TLS, or in at all? */
async function driverTransport(url: string, overrides: Record<string, string | undefined>): Promise<string> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
    const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
    await client.end()
    return result.rows[0].ssl === true ? 'tls' : 'cleartext'
  } catch (error) {
    return `refused:${(error as { code?: string }).code ?? ''}`
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('r44: a PGSSLMODE in the environment puts the application on a record the gate never read', async () => {
  // MUTATIONS (each made locally and re-run; the route each one takes is stated):
  //   M1 -- delete the `db_application_route_env_refusal` call from db_application_route_sslmode().
  //         GATE_WITH_REQUIRE and GATE_WITH_NOVERIFY both become `admitted`: the gate reads the
  //         hostnossl scram-sha-256 record and vouches for it while the application is on the
  //         hostssl trust record (no-verify) or cannot authenticate at all (require). That is r43
  //         exactly, and it is the defect. This test is the only one in the suite that fails.
  //   M2 -- keep the call but drop PGSSLMODE from db_route_env_variables(): identical failure,
  //         which is what makes the LIST a checked claim rather than a comment.
  //   M3 -- have db_application_route_env_refusal() look only at the unit and not at this process:
  //         both gate cases become `admitted` again, because the environment that reaches the
  //         migration and the build is this one.
  const root = mkdtempSync(join(tmpdir(), 'ims-r44-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'split', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 trust',
      'hostnossl all all 127.0.0.1/32 scram-sha-256',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    const url = `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/postgres`

    // PRECONDITION 1: the split is real and BOTH records are reachable from this host.
    assert.equal(
      cluster.psql(['-tAc', "SELECT count(*) FROM pg_hba_file_rules WHERE type='hostssl' AND auth_method='trust'"]),
      '1', 'precondition: the hostssl record must be trust')
    assert.equal(
      cluster.psql(['-tAc', "SELECT count(*) FROM pg_hba_file_rules WHERE type='hostnossl' AND auth_method='scram-sha-256'"]),
      '1', 'precondition: and the hostnossl record must check the password')

    // PRECONDITION 2, MEASURED WITH THE INSTALLED DRIVER: what r43 asserts is true only while
    // nothing sets PGSSLMODE, and the driver takes the OTHER record the moment something does.
    assert.equal(await driverTransport(url, { PGSSLMODE: undefined }),
      'cleartext', 'precondition: with no PGSSLMODE the driver is matched by the hostnossl record — r43 measured this and it still holds')
    assert.equal(await driverTransport(url, { PGSSLMODE: 'no-verify' }),
      'tls', 'and with PGSSLMODE=no-verify the SAME URL is matched by the hostssl TRUST record instead')
    assert.equal(await driverTransport(url, { PGSSLMODE: 'require' }),
      'refused:DEPTH_ZERO_SELF_SIGNED_CERT',
      'and with PGSSLMODE=require it demands a CA-verified certificate — pg’s `require` is verify-full — so against a self-signed cluster it never authenticates at all')

    const vars = { ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }
    const gate = `
      DB_PROBE_REPORT=""
      if db_endpoint_checks_role_verifier postgres; then echo "$1=admitted"; else echo "$1=refused"; fi
      echo "$1_ROUTE=\${DB_PROBE_SSLMODE}"
      echo "$1_REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
    `
    const run = runShipped(vars, `
      gate() { ${gate} }
      # THE CONTROL FIRST, so a refusal below cannot be the cluster refusing.
      gate GATE_CLEAN
      ( export PGSSLMODE=require;   gate GATE_WITH_REQUIRE )
      ( export PGSSLMODE=no-verify; gate GATE_WITH_NOVERIFY )
      ( export PGREPLICATION=true;  gate GATE_WITH_REPLICATION )
      ( export NODE_PG_FORCE_NATIVE=1; gate GATE_WITH_NATIVE )
    `)
    assert.equal(run.status, 0, run.output)

    assert.match(run.output, /GATE_CLEAN=admitted/,
      'control: with nothing set, the hostnossl scram-sha-256 record IS the application’s and the gate admits it')
    assert.match(run.output, /GATE_CLEAN_ROUTE=disable/, 'and publishes the route it read it on')

    for (const label of ['GATE_WITH_REQUIRE', 'GATE_WITH_NOVERIFY', 'GATE_WITH_REPLICATION', 'GATE_WITH_NATIVE']) {
      assert.match(run.output, new RegExp(`^${label}=refused$`, 'm'),
        `${label}: the driver’s route is not the one this gate derived, so nothing may be read on it:\n${run.output}`)
      assert.match(run.output, new RegExp(`^${label}_ROUTE=$`, 'm'),
        `${label}: and no route is published, so no credential-bearing probe can run either`)
    }
    const withRequire = Buffer.from(readVar(run.output, 'GATE_WITH_REQUIRE_REPORT_B64'), 'base64').toString('utf8')
    assert.match(withRequire, /PGSSLMODE=require in its own environment/, 'the report names the variable and its value')
    assert.match(withRequire, /hostssl record is a different pg_hba record from a hostnossl one/, 'and why that decides the question')
    assert.match(withRequire, /Unset PGSSLMODE and re-run/, 'and what to do about it')
    const withNative = Buffer.from(readVar(run.output, 'GATE_WITH_NATIVE_REPORT_B64'), 'base64').toString('utf8')
    assert.match(withNative, /NODE_PG_FORCE_NATIVE=1/, 'and the same for the one that swaps the whole driver out')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 23. WHERE THE SERVICE WOULD GET ONE — all three places, and the reader is the shipped one
//
// `busctl` and `systemctl` are stubbed for the same reason the port resolution tests stub them
// (deploy-order.test.ts): the point is not whether busctl works, it is that everything which
// DECIDES is the shipped code. The renderings below are the shape systemd actually prints, taken
// read-only off THIS HOST: `as 7 "NODE_ENV=development" … "PORT=3000" …` for Environment= and
// `a(sb) 1 "/opt/ims/onetwo3d-ims/.env" true` for EnvironmentFiles= on ims-stage-dev.service.
// ---------------------------------------------------------------------------

interface RouteEnvOptions {
  readonly processEnv?: Record<string, string>
  readonly unsetEnvironment?: string
  readonly execStart?: string
  readonly loadState?: string
  readonly mode?: string
}

const HOST_EXECSTART = 'a(sasbttttuii) 1 "/opt/app/node_modules/.bin/next" 4 "/opt/app/node_modules/.bin/next" "start" "-p" "3000" false 0 0 0 0 0 0 0'
const HOST_UNSET = 'as 3 "PGSSLMODE" "PGREPLICATION" "NODE_PG_FORCE_NATIVE"'

function runRouteEnv(options: RouteEnvOptions): { status: number; output: string } {
  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  const lift = (name: string): string => {
    const start = source.indexOf(`\n${name}() {\n`)
    assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
    const end = source.indexOf('\n}\n', start)
    return source.slice(start + 1, end + 3)
  }
  const program = [
    'set -uo pipefail',
    'APP_NAME="one-two-inventory"; APP_DIR=/opt/app; APP_PORT=3000',
    'DB_USER=imsuser; DB_HOST=127.0.0.1; DB_PORT=5432; DB_NAME=one_two_inventory',
    'DB_SSLMODE=disable; DB_SSLROOTCERT=""',
    'BUS_STRINGS=(); BUS_UNIT_OBJECT=""',
    'ENV_ROUTE_GUARANTEE_REASON=""; UNIT_EXECSTART_REASON=""',
    'DB_ROUTE_DROPIN_NAME=zz-deploy-db-route.conf',
    ...Object.entries(options.processEnv ?? {}).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
    'busctl(){',
    '  case "$*" in',
    `    *LoadUnit*) printf '%s\\n' 'o "/org/freedesktop/systemd1/unit/one_2dtwo_2dinventory_2eservice"' ;;`,
    `    *Unit\\ LoadState*) printf '%s\\n' '${options.loadState ?? 's "loaded"'}' ;;`,
    `    *Service\\ UnsetEnvironment*) printf '%s\\n' '${options.unsetEnvironment ?? HOST_UNSET}' ;;`,
    `    *Service\\ ExecStart*) printf '%s\\n' '${options.execStart ?? HOST_EXECSTART}' ;;`,
    '    *) return 1 ;;',
    '  esac',
    '}',
    lift('bus_read_strings'),
    lift('bus_array_count'),
    lift('bus_unit_property'),
    lift('bus_unit_object'),
    lift('unit_route_env_guaranteed'),
    lift('unit_execstart_is_exactly'),
    lift('db_service_execstart_expected'),
    lift('url_encode_userinfo'),
    lift('db_sslmode_is_supported'),
    lift('db_sslmode_is_cleartext'),
    lift('db_url_route_query'),
    lift('compose_database_url'),
    lift('db_route_env_variables'),
    lift('db_route_env_alternative'),
    lift('db_route_env_effect'),
    lift('db_application_route_env_refusal'),
    lift('db_application_route_sslmode'),
    options.mode === undefined
      ? 'if route="$(db_application_route_sslmode)"; then echo "ROUTE=${route}"; else echo "REFUSED=${route}"; fi'
      : `if reason="$(db_application_route_env_refusal ${options.mode})"; then echo "GUARANTEED"; else echo "REFUSED=\${reason}"; fi`,
  ].join('\n')
  try {
    return {
      status: 0,
      output: execFileSync('bash', ['-c', program], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] }),
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------------------
// 23a. THE HOST'S OWN RENDERINGS, so the stubs above are systemd's shapes and not this file's
//
// Everything in 23b-23d is decided by the SHIPPED parsers reading a STUBBED busctl. That is only
// evidence if the strings the stub prints are the strings systemd prints. So they are taken here,
// READ-ONLY, off a unit this host really has: two `busctl get-property` calls, which start
// nothing and queue no job.
// ---------------------------------------------------------------------------

function hostUnitProperty(unit: string, property: string): string | null {
  try {
    const object = execFileSync('busctl', [
      'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().replace(/^o /, '').replace(/"/g, '')
    return execFileSync('busctl', [
      'get-property', 'org.freedesktop.systemd1', object, 'org.freedesktop.systemd1.Service', property,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

test('r45: the ExecStart and UnsetEnvironment renderings the parsers are given are the ones systemd prints', () => {
  // MUTATION ROUTE: change the signature `unit_execstart_is_exactly()` asks bus_array_count() for
  // -- say to `as`, the signature of the environment lists -- and this fails, because the
  // signature is READ OUT OF THE SHIPPED SOURCE and checked against what systemd really prints.
  // That is the r21 finding held in place: the element count is read from the data structure, and
  // a rendering of another shape is not an answer.
  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  const execStartSignature = /bus_array_count "\$rendering" '([^']+)'\)" \|\| ! bus_read_strings "\$rendering"; then/.exec(source)
  assert.ok(execStartSignature, 'precondition: unit_execstart_is_exactly() must name the signature it asks bus_array_count() for')
  const unsetSignature = /unit_route_env_guaranteed\(\)[\s\S]*?bus_array_count "\$rendering" '([^']+)'/.exec(source)
  assert.ok(unsetSignature, 'precondition: unit_route_env_guaranteed() must name the signature it asks for')
  //
  // IT IS SKIPPED, NOT FAILED, WHERE THERE IS NO SYSTEM BUS — CI containers without systemd are a
  // real place this suite runs, and a precondition that cannot be taken is not a defect. The
  // assertion that it WAS taken is the `probed` counter: a version of this that silently probed
  // nothing would report zero units and fail.
  const units = ['ims-stage-dev.service', 'ssh.service', 'cron.service', 'systemd-journald.service']
  let probed = 0
  for (const unit of units) {
    const execStart = hostUnitProperty(unit, 'ExecStart')
    const unsetEnvironment = hostUnitProperty(unit, 'UnsetEnvironment')
    if (execStart === null || unsetEnvironment === null) continue
    probed += 1
    assert.ok(execStart.startsWith(`${execStartSignature[1]} `),
      `${unit}: systemd renders ExecStart as ${execStart.slice(0, 24)}…, and the shipped reader asks bus_array_count() for ${execStartSignature[1]}`)
    assert.ok(unsetEnvironment.startsWith(`${unsetSignature[1]} `),
      `${unit}: systemd renders UnsetEnvironment as ${unsetEnvironment.slice(0, 12)}…, and the shipped reader asks for ${unsetSignature[1]}`)
  }
  if (probed === 0) {
    console.log('# skipped: no systemd bus on this host, so the renderings could not be taken from it')
    return
  }
  assert.ok(probed > 0, 'at least one real unit must have answered, or this test proved nothing')

  // AND THE STUB SHAPE MATCHES ONE OF THEM, field for field. `ims-stage-dev.service` on this host
  // renders `a(sasbttttuii) 1 "/usr/bin/npm" 8 "/usr/bin/npm" "run" "dev" ... false 0 0 0 0 0 0 0`;
  // HOST_EXECSTART is that shape with this installer's own command in it.
  assert.ok(HOST_EXECSTART.startsWith(`${execStartSignature[1]} 1 `),
    'the stubbed ExecStart rendering carries the signature the shipped reader asks for')
  assert.match(HOST_EXECSTART, /^\S+ 1 "\S+" \d+ (?:"[^"]*" )+false(?: 0){7}$/,
    'and the field order systemd prints, not an approximation of it')
  assert.ok(HOST_UNSET.startsWith(`${unsetSignature[1]} `),
    'and the stubbed UnsetEnvironment rendering carries the signature unit_route_env_guaranteed() asks for')
})

// ---------------------------------------------------------------------------
// 23b. THE INSTALLER'S OWN ENVIRONMENT is still refused — and nothing else is surveyed
//
// r44 refused three sources. Two of them (the manager's block, the unit's own directives and
// files) are now CLOSED rather than surveyed, by the UnsetEnvironment= directive systemd applies
// as the final step of composing the environment. What is left in `installer` mode is the one
// source no unit directive can reach: this process, whose environment the migration, the build
// and the connection fence inherit verbatim.
// ---------------------------------------------------------------------------

test('r45: the installer’s own environment still refuses, and now names the supported spelling', () => {
  // MUTATION ROUTES:
  //   M1 -- delete the `${!name+is-set}` branch from db_application_route_env_refusal(): all three
  //         refusal cases resolve to `ROUTE=disable`, which is r44's finding restored.
  //   M2 -- remove PGSSLMODE from db_route_env_variables(): the first case resolves, which is what
  //         makes the LIST a checked claim rather than a comment.
  //   M3 -- make db_route_env_alternative() return the same sentence for every name: the last
  //         assertion fails, because a WAL-sender variable would be offered a TLS spelling that
  //         does not exist.
  const cases: ReadonlyArray<{ label: string; env: Record<string, string>; says: RegExp }> = [
    { label: 'PGSSLMODE', env: { PGSSLMODE: 'require' }, says: /running with PGSSLMODE=require in its own environment/ },
    { label: 'PGREPLICATION', env: { PGREPLICATION: 'true' }, says: /WAL sender, which pg_hba matches on the replication keyword/ },
    { label: 'NODE_PG_FORCE_NATIVE', env: { NODE_PG_FORCE_NATIVE: '1' }, says: /replaces node-postgres with libpq/ },
  ]
  for (const scenario of cases) {
    const result = runRouteEnv({ processEnv: scenario.env })
    assert.match(result.output, /^REFUSED=/m, `${scenario.label}: this must refuse, not resolve:\n${result.output}`)
    assert.match(result.output, scenario.says, `${scenario.label}: the refusal must name the source:\n${result.output}`)
  }

  // THE WAY OUT IS NAMED, and only where there is one. That is the whole of the r45 MEDIUM: a
  // refusal whose only remediation is "delete the line that makes your database reachable" is not
  // a remediation.
  assert.match(runRouteEnv({ processEnv: { PGSSLMODE: 'require' } }).output,
    /state it as DB_SSLMODE=require \(or verify-ca \/ verify-full with DB_SSLROOTCERT=\)/,
    'the PGSSLMODE refusal names the supported spelling of the same intent')
  assert.doesNotMatch(runRouteEnv({ processEnv: { PGREPLICATION: 'true' } }).output,
    /DB_SSLMODE/,
    'and the two that have no supported spelling do not invent one')

  // THE CONTROL: a clean environment resolves, and it resolves to the route DB_SSLMODE names.
  assert.match(runRouteEnv({}).output, /^ROUTE=disable$/m, 'nothing set, and the derivation answers')

  // AND THE MODE IS ENUMERATED. A `[[ $mode == service ]] || return 0` would make every
  // misspelling of the stricter question take the weaker one silently — a start gate that checked
  // nothing and looked exactly like one that passed.
  //
  // MUTATION ROUTE: replace the `case` in db_application_route_env_refusal() with
  // `[[ "${mode}" == "service" ]] || return 0` and this resolves instead of refusing.
  const typo = runRouteEnv({ mode: 'servce' })
  assert.match(typo.output, /^REFUSED=/m, `an unrecognised mode is a refusal, not the weaker check:\n${typo.output}`)
  assert.match(typo.output, /programming error in this script/, 'and it says whose mistake it is')
})

// ---------------------------------------------------------------------------
// 23c. THE LOAD-BEARING ONE FOR r45's FIRST HIGH: a WILDCARD EnvironmentFile
//
// THE FINDING (Codex HIGH). r44 concluded "nothing sets PGSSLMODE" by opening every path in the
// unit's EnvironmentFiles= and grepping it. systemd.exec(5) documents that path as one that MAY BE
// A WILDCARD, and `[[ -e "/etc/ims/*.env" ]]` is false for a glob however many files it matches --
// so a file that DID set PGSSLMODE was read as absent. The same reader was also a point-in-time
// read of a mutable file: systemd opens it at exec, at the far end of a build and a migration.
//
// THE ANSWER IS NOT A BETTER READER. It is that nothing reads those files any more: the composed
// unit must carry `UnsetEnvironment=` naming all three, which systemd.exec(5) applies "as the
// final step ... immediately before it is passed to the executed process" -- after
// DefaultEnvironment=, `systemctl set-environment`, the manager's block, Environment=,
// EnvironmentFile= (wildcards included) and PAM alike.
// ---------------------------------------------------------------------------

test('r45: a wildcard EnvironmentFile that sets PGSSLMODE cannot reach the application', () => {
  // MUTATION ROUTES:
  //   M1 -- have unit_route_env_guaranteed() return 0 unconditionally: WILDCARD_NO_DIRECTIVE
  //         reports GUARANTEED, which is the shipped r44 behaviour and the defect.
  //   M2 -- accept an assignment as well as a bare name (drop the `== "$name"` to a prefix match):
  //         ASSIGNMENT_FORM reports GUARANTEED, and systemd would remove only `PGSSLMODE=require`
  //         while `PGSSLMODE=no-verify` from the wildcard file survived.
  //   M3 -- drop NODE_PG_FORCE_NATIVE from the directive the installer writes: TWO_OF_THREE
  //         reports GUARANTEED.
  const root = mkdtempSync(join(tmpdir(), 'ims-r45-wild-'))
  try {
    // PRECONDITION, MEASURED: this is exactly why the r44 reader said "absent". The glob is not a
    // path; the file it matches is, and it sets the variable.
    const glob = join(root, '*.env')
    writeFileSync(join(root, 'transport.env'), 'PGSSLMODE=no-verify\n')
    assert.equal(existsSync(glob), false,
      'precondition: a wildcard EnvironmentFile= path is not a file, so the r44 `[[ -e ]]` test was false for it')
    assert.equal(
      execFileSync('bash', ['-c', `shopt -s nullglob; for f in ${glob}; do grep -c '^PGSSLMODE=' "$f"; done`], { encoding: 'utf8' }).trim(),
      '1',
      'precondition: and the file it matches DOES set PGSSLMODE — so r44 read an absence that was not one')

    // AND THE SHIPPED GATE NO LONGER ASKS. The unit below loads that wildcard; what decides is
    // whether systemd states the directive back.
    const withoutDirective = runRouteEnv({ mode: 'service', unsetEnvironment: 'as 0' })
    assert.match(withoutDirective.output, /^REFUSED=/m,
      `WILDCARD_NO_DIRECTIVE: without the directive the start must refuse:\n${withoutDirective.output}`)
    assert.match(withoutDirective.output, /does not list PGSSLMODE as a bare name in UnsetEnvironment=/,
      'and say exactly which property is missing')
    assert.match(withoutDirective.output, /zz-deploy-db-route\.conf/, 'and which drop-in states it')

    const assignmentForm = runRouteEnv({ mode: 'service', unsetEnvironment: 'as 3 "PGSSLMODE=require" "PGREPLICATION" "NODE_PG_FORCE_NATIVE"' })
    assert.match(assignmentForm.output, /^REFUSED=/m,
      `ASSIGNMENT_FORM: UnsetEnvironment=PGSSLMODE=require removes ONE assignment, not the variable:\n${assignmentForm.output}`)

    const twoOfThree = runRouteEnv({ mode: 'service', unsetEnvironment: 'as 2 "PGSSLMODE" "PGREPLICATION"' })
    assert.match(twoOfThree.output, /^REFUSED=/m, 'TWO_OF_THREE: all three or none')
    assert.match(twoOfThree.output, /does not list NODE_PG_FORCE_NATIVE as a bare name/, 'and it names the one that is missing')

    // THE CONTROL, and the property the whole answer rests on: with the directive systemd states
    // back, the same unit — wildcard environment file and all — passes, because the variable is
    // removed from the composed environment whatever put it there.
    assert.match(runRouteEnv({ mode: 'service' }).output, /^GUARANTEED$/m,
      'control: the directive this installer writes is what makes the start admissible')

    // AND THE DIRECTIVE THE INSTALLER WRITES IS THE BARE-NAME FORM, checked against the shipped
    // here-doc rather than against this file's idea of it.
    const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
    assert.match(source, /^UnsetEnvironment=\$\{names\}$/m,
      'the drop-in emits UnsetEnvironment= with the names db_route_env_variables() lists')
    assert.match(source, /names="\$\(db_route_env_variables \| tr '\\n' ' '\)"/,
      'and those names come from the same list the check reads, so the two cannot drift')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 23d. THE LOAD-BEARING ONE FOR r45's SECOND HIGH: ExecStart is the layer the directive misses
//
// THE FINDING (Codex HIGH). UnsetEnvironment= is final over the environment systemd COMPOSES. It
// is not final over what the launched program does to its own environment one exec later, and
// `ExecStart=/usr/bin/env PGSSLMODE=no-verify …` is a drop-in that does exactly that. It appears
// in no Environment=, no PassEnvironment=, no UnsetEnvironment= and no EnvironmentFile=; it
// survives a rewrite of the base unit; and it puts the application on the `hostssl` record this
// run never authenticated against.
//
// So the two HIGHs need two mechanisms, and this is the second one: the composed ExecStart must be
// the command this installer wrote, string for string.
// ---------------------------------------------------------------------------

test('r45: a drop-in that wraps ExecStart in `env PGSSLMODE=…` is refused', () => {
  // MUTATION ROUTES:
  //   M1 -- delete the unit_execstart_is_exactly() call from db_application_route_env_refusal():
  //         every wrapper case reports GUARANTEED. That is the blind spot the file used to name
  //         and leave open.
  //   M2 -- compare only the command PATH and not the argv: WRAPPED_ARGV reports GUARANTEED,
  //         because `/usr/bin/env` is not the path — but `next start -p 3000 --keepAliveTimeout`
  //         style tampering, and any wrapper reached through the same binary, would not be caught.
  //   M3 -- drop the `count -ne 1` check: TWO_COMMANDS reports GUARANTEED, and systemd would run
  //         both.
  const wrapped = 'a(sasbttttuii) 1 "/usr/bin/env" 6 "/usr/bin/env" "PGSSLMODE=no-verify" "/opt/app/node_modules/.bin/next" "start" "-p" "3000" false 0 0 0 0 0 0 0'
  const wrapper = runRouteEnv({ mode: 'service', execStart: wrapped })
  assert.match(wrapper.output, /^REFUSED=/m, `WRAPPED: the start must refuse:\n${wrapper.output}`)
  assert.match(wrapper.output, /\/usr\/bin\/env/, 'and quote the command systemd would actually run')
  assert.match(wrapper.output, /PGSSLMODE=no-verify/, 'including the assignment the wrapper carries')
  assert.match(wrapper.output, /this installer wrote ExecStart=/, 'and say what it expected instead')

  // A WRAPPER REACHED THROUGH THE SAME BINARY: same path, different argv. This is what M2 misses.
  const sameBinary = 'a(sasbttttuii) 1 "/opt/app/node_modules/.bin/next" 5 "/opt/app/node_modules/.bin/next" "start" "-p" "3000" "--experimental-https" false 0 0 0 0 0 0 0'
  assert.match(runRouteEnv({ mode: 'service', execStart: sameBinary }).output, /^REFUSED=/m,
    'WRAPPED_ARGV: an argv this run did not write is a command this run has not read, whatever the binary is')

  // TWO COMMANDS: systemd runs both, and the first is a program nobody here read.
  const two = 'a(sasbttttuii) 2 "/usr/bin/env" 2 "/usr/bin/env" "PGSSLMODE=no-verify" false 0 0 0 0 0 0 0 "/opt/app/node_modules/.bin/next" 4 "/opt/app/node_modules/.bin/next" "start" "-p" "3000" false 0 0 0 0 0 0 0'
  const twoRun = runRouteEnv({ mode: 'service', execStart: two })
  assert.match(twoRun.output, /^REFUSED=/m, 'TWO_COMMANDS: this installer writes exactly one')
  assert.match(twoRun.output, /composed with 2 ExecStart= commands/, 'and the count comes from systemd’s own array')

  // AN UNREADABLE ANSWER IS AN UNKNOWN, AND UNKNOWNS REFUSE. `as 1 "..."` is the signature of the
  // ENVIRONMENT lists, so this is the shape a reader that asked the wrong property would get.
  const wrongSignature = runRouteEnv({ mode: 'service', execStart: 'as 1 "/opt/app/node_modules/.bin/next"' })
  assert.match(wrongSignature.output, /^REFUSED=/m, 'a rendering of another signature is not an answer')
  assert.match(wrongSignature.output, /would not answer readably for .* ExecStart=/, 'and it says so rather than comparing what it could not read')

  // A UNIT SYSTEMD DOES NOT HAVE CARRIES NO PROPERTY, so it cannot be started onto a checked one.
  assert.match(runRouteEnv({ mode: 'service', loadState: 's "not-found"' }).output, /^REFUSED=/m,
    'and a unit systemd has not loaded is a refusal, not a pass')

  // THE CONTROL: the exact command the installer's own here-doc writes.
  assert.match(runRouteEnv({ mode: 'service' }).output, /^GUARANTEED$/m,
    'control: the ExecStart this installer wrote is admitted')
  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  assert.match(source, /^ExecStart=\$\{APP_DIR\}\/node_modules\/\.bin\/next start -p \$\{APP_PORT\}$/m,
    'and the expectation db_service_execstart_expected() states is the line the unit here-doc emits')
})

// ---------------------------------------------------------------------------
// 24. THE SET IS THE DRIVER’S, AND IT IS MEASURED HERE RATHER THAN QUOTED
//
// The whole finding is a variable nobody enumerated. So the enumeration is a test: the installed
// `pg` is asked, through a recording Proxy over `process.env`, which variables it consults when
// handed exactly the URL compose_database_url() emits — and this fails the day it consults one
// this gate has not classified.
// ---------------------------------------------------------------------------

test('r44: the variables the installed driver consults are exactly the ones this gate classifies', () => {
  // MUTATION ROUTE: add a name to db_route_env_variables() that the driver does not read, or
  // remove one it does, and the last two assertions fail. Change the URL compose_database_url()
  // emits so that it stops stating (say) the port, and PGPORT appears in the measured set and the
  // first assertion fails — which is the r37 measurement, re-measured here instead of remembered.
  const probe = `
    const seen = new Set()
    const base = { ...process.env }
    const proxy = new Proxy(base, {
      get(target, key) { if (typeof key === 'string') seen.add(key); return target[key] },
      has(target, key) { if (typeof key === 'string') seen.add(key); return key in target },
    })
    Object.defineProperty(process, 'env', { value: proxy, configurable: true, writable: true })
    // The recorder is in place BEFORE the first require, because NODE_PG_FORCE_NATIVE is read at
    // module load (pg/lib/index.js) and the module cache means there is no second chance at it.
    require('pg')
    const ConnectionParameters = require('pg/lib/connection-parameters.js')
    new ConnectionParameters('postgresql://imsuser:pw@127.0.0.1:5432/one_two_inventory')
    console.log(JSON.stringify([...seen].filter((name) => /^(PG|NODE_PG)/.test(name)).sort()))
  `
  const consulted: string[] = JSON.parse(
    execFileSync('node', ['-e', probe], { encoding: 'utf8', cwd: REPO, env: cleanLibpqEnv() }).trim(),
  )
  // The URL states all five identity values, so the driver never falls back to their variables.
  for (const absent of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) {
    assert.ok(!consulted.includes(absent),
      `r37 measured that a complete URL leaves ${absent} unconsulted; it must still be true:\n${consulted.join(' ')}`)
  }
  // NODE_PG_FORCE_NATIVE is read at module load, not by ConnectionParameters, so the probe
  // re-requires `pg` with a cleared recorder to catch it in the same measurement.
  assert.deepEqual(consulted.sort(), [
    'NODE_PG_FORCE_NATIVE',
    'PGAPPNAME',
    'PGBINARY',
    'PGCLIENT_ENCODING',
    'PGCONNECT_TIMEOUT',
    'PGOPTIONS',
    'PGREPLICATION',
    'PGSSLMODE',
  ], 'the installed driver consults exactly these, and a new one is this finding again')

  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  const listed = execFileSync('bash', ['-c', `${source.slice(source.indexOf('\ndb_route_env_variables() {\n'), source.indexOf('\n}\n', source.indexOf('\ndb_route_env_variables() {\n')) + 3)}\ndb_route_env_variables`], { encoding: 'utf8' })
    .trim().split('\n')
  assert.deepEqual(listed, ['PGSSLMODE', 'PGREPLICATION', 'NODE_PG_FORCE_NATIVE'],
    'and the gate refuses exactly the ones that move which pg_hba record answers')
  for (const name of consulted) {
    assert.ok(source.includes(name), `${name} must at least be NAMED in the derivation’s argument, refused or not`)
  }
})

// ---------------------------------------------------------------------------
// 25. THE OTHER HALF OF "BEFORE RECONCILIATION AND STARTUP", THROUGH THE WHOLE START GATE
//
// 23c and 23d exercise the two new checks on their own. This runs them where they actually sit —
// inside require_start_identity_bound(), the one call site that is about to hand the units to
// systemd — so that "the start refuses" is a claim about the shipped start and not about a
// helper. The DATABASE_URL half (the snapshot binding, the file agreement) is unchanged and is
// asserted here as the control: it must still pass, or the transport checks would be masking it.
// ---------------------------------------------------------------------------

test('r45: the start gate refuses a transport the run never authenticated against', () => {
  // MUTATION ROUTES:
  //   M1 -- pass `installer` instead of `service` in require_start_identity_bound(): NO_DIRECTIVE
  //         and WRAPPED both report BOUND, because the installer half only looks at this process.
  //         That is r44's shipped behaviour and it is the finding.
  //   M2 -- delete the db_application_route_env_refusal() call entirely: PROCESS_ENV also reports
  //         BOUND.
  //   M3 -- move the transport check AFTER require_env_file_is_sole_definition(): every assertion
  //         here still passes, which is why the ORDER is not what this test claims — the claim is
  //         that all four refuse, and the control is that a clean unit binds.
  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  const lift = (name: string): string => {
    const start = source.indexOf(`\n${name}() {\n`)
    assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
    return source.slice(start + 1, source.indexOf('\n}\n', start) + 3)
  }
  const root = mkdtempSync(join(tmpdir(), 'ims-r45-start-'))
  try {
    const envPath = join(root, '.env')
    const snapshot = join(root, 'db-identity.env')
    const url = 'postgresql://imsuser:pw@127.0.0.1:5432/one_two_inventory'
    writeFileSync(envPath, `NODE_ENV=production\nDATABASE_URL=${url}\n`)
    writeFileSync(snapshot, `DATABASE_URL=${url}\n`)
    const run = (extra: string, unsetEnvironment = HOST_UNSET, execStart?: string): string => {
      const exec = (execStart ?? HOST_EXECSTART).replace(/\/opt\/app/g, root)
      const program = [
        'set -uo pipefail',
        `APP_NAME="one-two-inventory"; APP_DIR=${JSON.stringify(root)}; APP_PORT=3000`,
        'DB_USER=imsuser; DB_HOST=127.0.0.1; DB_PORT=5432; DB_NAME=one_two_inventory',
        'DB_SSLMODE=disable; DB_SSLROOTCERT=""',
        `DATABASE_URL=${JSON.stringify(url)}`,
        'BUS_STRINGS=(); BUS_ENV_IGNORE_FLAGS=(); BUS_UNIT_OBJECT=""',
        'ENV_VAR_SOURCE_REASON=""; DB_IDENTITY_SOURCE_REASON=""',
        'ENV_ROUTE_GUARANTEE_REASON=""; UNIT_EXECSTART_REASON=""',
        'DB_ROUTE_DROPIN_NAME=zz-deploy-db-route.conf',
        `DB_ENV_SNAPSHOT_FILE=${JSON.stringify(snapshot)}`,
        'DB_ENV_SNAPSHOT_DROPIN_NAME=zz-deploy-db-identity.conf',
        'DB_ENV_SNAPSHOT_PUBLISHED=true; DB_IDENTITY_REQUIRE_SNAPSHOT=false',
        extra,
        'busctl(){',
        '  case "$*" in',
        `    *LoadUnit*) printf '%s\\n' 'o "/x"' ;;`,
        `    *Unit\\ LoadState*) printf '%s\\n' 's "loaded"' ;;`,
        `    *Service\\ EnvironmentFiles*) printf '%s\\n' 'a(sb) 2 "${envPath}" false "${snapshot}" false' ;;`,
        `    *Service\\ Environment*) printf '%s\\n' 'as 0' ;;`,
        `    *Service\\ PassEnvironment*) printf '%s\\n' 'as 0' ;;`,
        `    *Service\\ UnsetEnvironment*) printf '%s\\n' '${unsetEnvironment}' ;;`,
        `    *Service\\ ExecStart*) printf '%s\\n' '${exec}' ;;`,
        `    *Service\\ PAMName*) printf '%s\\n' 's ""' ;;`,
        '    *) return 1 ;;',
        '  esac',
        '}',
        lift('bus_read_strings'), lift('bus_array_count'), lift('bus_unit_property'),
        lift('bus_element_names_variable'), lift('bus_read_env_ignore_flags'),
        lift('bus_unit_object'), lift('unit_route_env_guaranteed'),
        lift('unit_execstart_is_exactly'), lift('db_service_execstart_expected'),
        lift('unit_env_var_sole_source'), lift('env_file_is_sole_database_url_source'),
        lift('require_env_file_is_sole_definition'), lift('env_file_value'),
        lift('url_encode_userinfo'), lift('db_sslmode_is_cleartext'), lift('db_url_route_query'), lift('compose_database_url'),
        lift('db_route_env_variables'), lift('db_route_env_alternative'), lift('db_route_env_effect'),
        lift('db_application_route_env_refusal'), lift('require_start_identity_bound'),
        'if require_start_identity_bound; then echo "BOUND"; else echo "REFUSED=${DB_IDENTITY_SOURCE_REASON}"; fi',
      ].join('\n')
      try {
        return execFileSync('bash', ['-c', program], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string }
        return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
      }
    }

    // PROCESS_ENV: the source no unit directive can close.
    const withMode = run('export PGSSLMODE=require')
    assert.match(withMode, /^REFUSED=/m, `PROCESS_ENV: the start must refuse:\n${withMode}`)
    assert.match(withMode, /PGSSLMODE=require/, 'and name the variable')
    assert.match(withMode, /rotated its credential against that record/, 'and say why the start is the wrong moment to discover it')
    assert.match(withMode, /DB_SSLMODE=require/, 'and name the supported spelling of the same intent')

    // NO_DIRECTIVE: the unit systemd has loaded does not remove the transport variables, so what
    // any environment file, wildcard or not, says at exec is still the route.
    const noDirective = run('true', 'as 0')
    assert.match(noDirective, /^REFUSED=/m, `NO_DIRECTIVE: the start must refuse:\n${noDirective}`)
    assert.match(noDirective, /does not list PGSSLMODE as a bare name in UnsetEnvironment=/, 'and say which property is missing')

    // WRAPPED: the layer the directive cannot reach.
    const wrapped = run('true', HOST_UNSET,
      'a(sasbttttuii) 1 "/usr/bin/env" 6 "/usr/bin/env" "PGSSLMODE=no-verify" "/opt/app/node_modules/.bin/next" "start" "-p" "3000" false 0 0 0 0 0 0 0')
    assert.match(wrapped, /^REFUSED=/m, `WRAPPED: the start must refuse:\n${wrapped}`)
    assert.match(wrapped, /PGSSLMODE=no-verify/, 'and quote the assignment the wrapper carries')

    // THE CONTROL, and it is what stops any of the mutations above being answered by "refuse
    // everything": the unit this installer actually writes, with this run's snapshot loaded last,
    // still binds.
    const clean = run('true')
    assert.match(clean, /^BOUND$/m, `control: the unit this installer writes still binds:\n${clean}`)

    // AND THE DATABASE_URL HALF IS STILL LOAD-BEARING, so the transport checks are not masking it.
    writeFileSync(envPath, 'NODE_ENV=production\nDATABASE_URL=postgresql://imsuser:other@127.0.0.1:5432/one_two_inventory\n')
    const drifted = run('true')
    assert.match(drifted, /^REFUSED=/m, `control: a .env that no longer states this run's URL still refuses:\n${drifted}`)
    assert.match(drifted, /no longer states the DATABASE_URL this run fenced and migrated with/, 'for the reason it always did')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 26. THE LOAD-BEARING ONE FOR r45's MEDIUM: a TLS-ONLY EXTERNAL DATABASE, INSTALLED
//
// THE FINDING (Codex MEDIUM, and it blocks as hard as the two HIGHs). r44 refused every PGSSLMODE
// from every source and emitted a URL with no TLS configuration in it. docs/installation.md
// documents external PostgreSQL as supported, and a great many external clusters -- every managed
// one -- accept nothing but TLS. So a documented deployment became impossible, and the remediation
// the refusal printed ("remove PGSSLMODE") either left the application unable to connect at all or
// asked an operator to abandon a required trust boundary.
//
// WHAT WAS RIGHT ABOUT THE REFUSAL IS KEPT: an AMBIENT value is still refused, because it is
// invisible in the URL and therefore to every probe (23b). What is added is the supported
// spelling -- DB_SSLMODE -- which puts the transport IN the URL, where the derivation reads it and
// the reader and the psql probes are pinned to it.
//
// AND THE SEMANTICS QUESTION IS ANSWERED BY SELECTING THE DRIVER'S OWN, NOT BY REPRODUCING IT.
// r43 refused to emit `?sslmode=require` because on pg-connection-string that word means
// verify-full-against-Node's-CA-bundle, which is not libpq's `require` and which no psql pin
// reproduces. The emitted URL therefore also carries `uselibpqcompat=true`, the parameter the
// driver ships for exactly this purpose: it switches pg-connection-string to its libpq-compatible
// branch, where `require`, `verify-ca` and `verify-full` mean what libpq and psql mean by them.
// Every claim in the next test is MEASURED against the installed driver, on a real cluster on
// which the cleartext record REJECTS -- so a mistake anywhere in that chain is a failure here.
// ---------------------------------------------------------------------------

/** What the INSTALLED driver does with one URL: which user got in, over what transport, or why not. */
async function driverRoute(url: string): Promise<string> {
  const { default: pgModule } = await import('pg')
  const client = new pgModule.Client({ connectionString: url })
  try {
    await client.connect()
    const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
    await client.end()
    return result.rows[0].ssl === true ? 'tls' : 'cleartext'
  } catch (error) {
    return `refused:${(error as { code?: string }).code ?? (error as Error).message}`
  }
}

test('r45: a TLS-only external database is installable, and the gate validates the route it actually takes', async () => {
  // MUTATION ROUTES (each applied to scripts/install.sh and this file re-run):
  //   M1 -- drop `&uselibpqcompat=true` from db_url_route_query(). PRECONDITION_COMPAT fails
  //         immediately: the driver's `require` becomes verify-full against Node's CA bundle and
  //         the application connection is refused DEPTH_ZERO_SELF_SIGNED_CERT, while the psql
  //         probes -- which ARE libpq -- sail through. That is r43's divergence restored, and it
  //         is why the parameter is not decoration.
  //   M2 -- have db_application_route_sslmode() return `disable` regardless of DB_SSLMODE: the
  //         gate is REFUSED (the reader is told `disable`, the hostnossl record rejects, no method
  //         is read) and REQUIRE_ADMITTED fails. The run refuses rather than rotating, which is
  //         the safe direction -- but the deployment is impossible again, which is the finding.
  //   M3 -- remove PGSSLROOTCERT from pg_endpoint_psql()'s route array: VERIFY_FULL_ADMITTED
  //         fails, because the credential probe then verifies against libpq's default trust store
  //         (~/.postgresql/root.crt of the probing user) and cannot complete the handshake at all.
  //   M4 -- accept `no-verify` in db_sslmode_is_supported() and pass it through: the URL parses,
  //         but the reader dies on `--sslmode=no-verify` (it is not a libpq word) and the gate
  //         refuses. The supported set is the intersection of three clients on purpose.
  const root = mkdtempSync(join(tmpdir(), 'ims-r45-tls-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 scram-sha-256',
      'hostnossl all all 127.0.0.1/32 reject',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    const ca = join(cluster.data, 'server.crt')
    const plain = `postgresql://imsuser:live-password@127.0.0.1:${cluster.port}/postgres`

    // PRECONDITION 1: this is a database r44 could not install. The URL r44 emitted is REFUSED by
    // the cluster, so no credential this installer could publish would start the application.
    assert.match(await driverRoute(plain), /^refused:/,
      'precondition: the query-less URL r44 emitted is rejected by a TLS-only cluster — this is the deployment the blanket refusal stranded')

    // PRECONDITION 2, PRECONDITION_COMPAT: the difference the compatibility parameter makes,
    // measured with the installed driver rather than read out of its documentation.
    assert.match(await driverRoute(`${plain}?sslmode=require`), /^refused:DEPTH_ZERO_SELF_SIGNED_CERT$/,
      'precondition: without uselibpqcompat, pg’s `require` is verify-full against Node’s own CA bundle — r43 measured this and it still holds')
    assert.equal(await driverRoute(`${plain}?sslmode=require&uselibpqcompat=true`), 'tls',
      'PRECONDITION_COMPAT: with it, `require` means what libpq means — encrypted, certificate not verified — and the hostssl record answers')
    assert.equal(await driverRoute(`${plain}?sslmode=verify-full&uselibpqcompat=true&sslrootcert=${ca}`), 'tls',
      'and verify-full against the cluster’s own certificate completes, chain and hostname both')
    assert.match(await driverRoute(`${plain}?sslmode=verify-full&uselibpqcompat=true`), /^refused:/,
      'while verify-full WITHOUT the CA is refused — so the CA is load-bearing and not decoration')

    // AND THE URL THE SHIPPED COMPOSER EMITS IS EXACTLY THE ONE MEASURED ABOVE. This is what stops
    // the preconditions being a statement about strings this file invented.
    for (const [mode, rootcert, expected] of [
      ['require', '', `?sslmode=require&uselibpqcompat=true`],
      ['verify-full', ca, `?sslmode=verify-full&uselibpqcompat=true&sslrootcert=${ca}`],
      ['disable', '', ''],
    ] as ReadonlyArray<[string, string, string]>) {
      const composed = runShipped({ ...installVars(cluster, root), DB_SSLMODE: mode, DB_SSLROOTCERT: rootcert }, `
        echo "URL=$(compose_database_url "\${DB_USER}" "live-password" "\${DB_HOST}" "\${DB_PORT}" postgres)"
      `)
      assert.equal(composed.status, 0, composed.output)
      assert.match(readVar(composed.output, 'URL'), new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
        `the shipped composer emits the ${mode} URL the driver was measured on:\n${composed.output}`)
    }

    // REQUIRE_ADMITTED: the whole gate, on the route the application takes.
    const requireRun = runShipped({ ...installVars(cluster, root), DB_SSLMODE: 'require' }, `
      DB_PROBE_REPORT=""
      echo "ROUTE=$(db_application_route_sslmode)"
      if db_endpoint_checks_role_verifier postgres; then echo "GATE=admitted"; else echo "GATE=refused"; fi
      echo "PIN=\${DB_PROBE_SSLMODE}"
      if db_endpoint_is_password_sensitive postgres live-password; then echo "SENSITIVE=yes"; else echo "SENSITIVE=no"; fi
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
    `)
    assert.equal(requireRun.status, 0, requireRun.output)
    assert.match(requireRun.output, /^ROUTE=require$/m, 'the derivation answers the transport DB_SSLMODE names')
    assert.match(requireRun.output, /^GATE=admitted$/m,
      `REQUIRE_ADMITTED: the method is read on the hostssl record the application will be matched by:\n${requireRun.output}`)
    assert.match(requireRun.output, /^PIN=require$/m, 'and the credential probes are pinned to that same route')
    assert.match(requireRun.output, /^SENSITIVE=yes$/m,
      `and the negative control and the positive both run on it, over TLS:\n${Buffer.from(readVar(requireRun.output, 'REPORT_B64'), 'base64').toString('utf8')}`)

    // AND THE READER REPORTS THE ROUTE IT TOOK, which is what makes the pin a checked claim.
    const onRequire = readerOn(cluster.port, 'require')
    assert.match(onRequire, /^sslmode=require$/m, 'the reader states the route back')
    assert.match(onRequire, /^method=scram-sha-256$/m, 'and reads the hostssl record on it')

    // VERIFY_FULL_ADMITTED: the same, with the certificate actually verified — the case Codex
    // named as "certificate-verified transport", and the one that needs the CA to travel with the
    // mode into all three clients.
    const verifyRun = runShipped({ ...installVars(cluster, root), DB_SSLMODE: 'verify-full', DB_SSLROOTCERT: ca }, `
      DB_PROBE_REPORT=""
      echo "ROUTE=$(db_application_route_sslmode)"
      if db_endpoint_checks_role_verifier postgres; then echo "GATE=admitted"; else echo "GATE=refused"; fi
      echo "PIN=\${DB_PROBE_SSLMODE}"
      if db_endpoint_is_password_sensitive postgres live-password; then echo "SENSITIVE=yes"; else echo "SENSITIVE=no"; fi
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
    `)
    assert.equal(verifyRun.status, 0, verifyRun.output)
    assert.match(verifyRun.output, /^ROUTE=verify-full$/m, 'the derivation answers verify-full')
    assert.match(verifyRun.output, /^GATE=admitted$/m,
      `VERIFY_FULL_ADMITTED: the method is read over a VERIFIED connection:\n${Buffer.from(readVar(verifyRun.output, 'REPORT_B64'), 'base64').toString('utf8')}`)
    assert.match(verifyRun.output, /^PIN=verify-full$/m, 'and psql is pinned to verify-full with the same CA')
    assert.match(verifyRun.output, /^SENSITIVE=yes$/m, 'and the credential probes complete on it')

    // AND THE READER VERIFIES THE CERTIFICATE WHEN IT IS TOLD TO, rather than reporting a route it
    // did not take. Without the CA it cannot complete the handshake at all, which is the proof
    // that `verify-full` is not `require` wearing a different label.
    const verified = execFileSync('node', [
      join(REPO, 'scripts/lib/pg-auth-request.mjs'),
      '--host=127.0.0.1', `--port=${cluster.port}`, '--user=imsuser', '--database=postgres',
      '--sslmode=verify-full', `--sslrootcert=${ca}`,
    ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(verified, /^sslmode=verify-full$/m, 'the reader states verify-full back only when it took it')
    assert.match(verified, /^method=scram-sha-256$/m, 'and reads the record on it')
    let withoutCa = ''
    try {
      execFileSync('node', [
        join(REPO, 'scripts/lib/pg-auth-request.mjs'),
        '--host=127.0.0.1', `--port=${cluster.port}`, '--user=imsuser', '--database=postgres',
        '--sslmode=verify-full',
      ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      withoutCa = String((error as { stdout?: string }).stdout ?? '')
    }
    assert.match(withoutCa, /--sslrootcert= is required/, 'and it refuses to verify against a trust store nobody named')

    // READER_VERIFIES: handed a CA the cluster's certificate does NOT chain to, the reader must
    // fail the handshake. Without this the two assertions above pass just as well for a reader
    // that sets `rejectUnauthorized: false` and reports `verify-full` anyway -- which is a probe
    // claiming a route it did not take, and the r43 defect wearing a new label.
    const strangerCa = join(root, 'stranger-ca.pem')
    execFileSync('openssl', [
      'req', '-new', '-x509', '-days', '2', '-nodes', '-subj', '/CN=stranger',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', join(root, 'stranger.key'), '-out', strangerCa,
    ], { stdio: 'pipe' })
    let wrongCa = ''
    try {
      execFileSync('node', [
        join(REPO, 'scripts/lib/pg-auth-request.mjs'),
        '--host=127.0.0.1', `--port=${cluster.port}`, '--user=imsuser', '--database=postgres',
        '--sslmode=verify-full', `--sslrootcert=${strangerCa}`,
      ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      wrongCa = String((error as { stdout?: string }).stdout ?? '')
    }
    assert.match(wrongCa, /^method=unknown$/m,
      `READER_VERIFIES: a CA the server's certificate does not chain to must stop the handshake:\n${wrongCa}`)
    assert.match(wrongCa, /SELF_SIGNED_CERT_IN_CHAIN|unable to verify|self-signed certificate/i,
      'and the reason must be the certificate, not something else')

    // AND SO MUST THE APPLICATION'S OWN DRIVER, on the same wrong CA — which is what makes
    // "the reader and the driver are the same TLS client" a measured claim.
    assert.match(await driverRoute(`${plain}?sslmode=verify-full&uselibpqcompat=true&sslrootcert=${strangerCa}`), /^refused:/,
      'the installed driver refuses the same certificate against the same wrong CA')

    // VERIFY_CA, the third supported mode, and the one whose whole content is "the chain but not
    // the hostname". Both halves are measured: the wrong CA stops it (so the CA is checked) and
    // the right one lets it through even though the certificate's CN is `localhost` while the
    // connection is to 127.0.0.1 (so the hostname is not).
    //
    // MUTATION ROUTE: give verify-ca the `{ rejectUnauthorized: false }` options `require` gets,
    // in tlsOptionsFor() and in db_url_route_query()'s consumers alike -- CA_WRONG_UNDER_VERIFY_CA
    // then succeeds and this fails.
    let caWrong = ''
    try {
      execFileSync('node', [
        join(REPO, 'scripts/lib/pg-auth-request.mjs'),
        '--host=127.0.0.1', `--port=${cluster.port}`, '--user=imsuser', '--database=postgres',
        '--sslmode=verify-ca', `--sslrootcert=${strangerCa}`,
      ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      caWrong = String((error as { stdout?: string }).stdout ?? '')
    }
    assert.match(caWrong, /^method=unknown$/m,
      `CA_WRONG_UNDER_VERIFY_CA: verify-ca must still verify the chain:\n${caWrong}`)
    const caRight = readerOn(cluster.port, 'verify-ca').length > 0 ? execFileSync('node', [
      join(REPO, 'scripts/lib/pg-auth-request.mjs'),
      '--host=127.0.0.1', `--port=${cluster.port}`, '--user=imsuser', '--database=postgres',
      '--sslmode=verify-ca', `--sslrootcert=${ca}`,
    ], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] }) : ''
    assert.match(caRight, /^sslmode=verify-ca$/m, 'and it reports the mode it took')
    assert.match(caRight, /^method=scram-sha-256$/m,
      'and reaches the record even though the certificate names `localhost` and the connection is to 127.0.0.1 — which is what verify-ca means')
    const verifyCaRun = runShipped({ ...installVars(cluster, root), DB_SSLMODE: 'verify-ca', DB_SSLROOTCERT: ca }, `
      DB_PROBE_REPORT=""
      echo "ROUTE=$(db_application_route_sslmode)"
      if db_endpoint_checks_role_verifier postgres; then echo "GATE=admitted"; else echo "GATE=refused"; fi
      echo "PIN=\${DB_PROBE_SSLMODE}"
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
    `)
    assert.match(verifyCaRun.output, /^ROUTE=verify-ca$/m, 'the derivation answers verify-ca')
    assert.match(verifyCaRun.output, /^GATE=admitted$/m,
      `and the gate reads the method on it:\n${Buffer.from(readVar(verifyCaRun.output, 'REPORT_B64'), 'base64').toString('utf8')}`)
    assert.match(verifyCaRun.output, /^PIN=verify-ca$/m, 'and pins psql to it')

    // THE REFUSAL THAT REMAINS, AND ITS WAY OUT. An unsupported spelling is still refused — and the
    // message names the four that are supported rather than telling the operator to remove their
    // transport.
    const unsupported = runShipped({ ...installVars(cluster, root), DB_SSLMODE: 'no-verify' }, `
      if route="$(db_application_route_sslmode)"; then echo "ROUTE=\${route}"; else echo "REFUSED=\${route}"; fi
    `)
    assert.match(unsupported.output, /^REFUSED=/m, 'an unsupported mode refuses')
    assert.match(unsupported.output, /disable, require, verify-ca and verify-full/, 'and names the ones that are')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 27. AN UPGRADE OF A TLS-ONLY INSTALLATION STAYS ON TLS
//
// The transport is not written to `.env` as a variable of its own — it is part of the
// `DATABASE_URL` the installer composes — so on a re-run it has to be RECOVERED from that URL, for
// exactly the reason installed_database_password() has to be. If it were not, an unattended
// upgrade would re-publish a cleartext URL over a database that accepts nothing but TLS, and the
// service would come back unable to connect at all: a worse failure than a bad first install,
// because nobody has any reason to suspect the installer.
// ---------------------------------------------------------------------------

test('r45: an upgrade recovers the transport and the CA from the URL the previous run wrote', () => {
  // MUTATION ROUTES:
  //   M1 -- initialise DB_SSLMODE to `disable` at the top of install.sh instead of empty. Under
  //         --non-interactive, prompt() keeps whatever the variable already holds and reaches its
  //         default only when it is empty, so the recovered value is never used: RECOVERED_MODE
  //         becomes `disable` and this fails. That is the shape of the bug, and it is invisible
  //         interactively.
  //   M2 -- delete the installed_database_sslrootcert() call: RECOVERED_CA is empty and the
  //         verify-full validation then dies for want of a CA.
  //   M3 -- have installed_database_sslmode() accept any query string rather than only the one
  //         this installer composes: HAND_WRITTEN (a URL with a bare `?sslmode=require`, which is
  //         NOT what the composer emits and NOT libpq semantics under this driver) is recovered
  //         instead of ignored.
  const root = mkdtempSync(join(tmpdir(), 'ims-r45-upgrade-'))
  // mkdtemp gives 0700, and the published CA has to be reachable by every uid — which on a
  // production host it is, because /etc is 0755. Without this the ancestry walk is measuring the
  // temporary directory rather than the publication.
  chmodSync(root, 0o755)
  try {
    const ca = join(root, 'ca.pem')
    // DISTINCTIVE BYTES, because since r46 the recovered pathname is not what comes back out:
    // prompt_db_sslmode() publishes the CA and repoints DB_SSLROOTCERT at the published copy. The
    // only way left to prove WHICH file the recovery read is to read the bytes it published.
    const CA_BYTES = '-- the CA the previous run of this installer verified against --\n'
    writeFileSync(ca, CA_BYTES)
    const publishedCa = join(root, 'db-ca-published/db-ca.crt')
    const written = (query: string): string =>
      `NODE_ENV=production\nDATABASE_URL=postgresql://imsuser:pw@db.example.com:5432/one_two_inventory${query}\n`

    // THE GLOBALS ARE LIFTED, NOT DECLARED. The whole of M1 is which value install.sh gives
    // DB_SSLMODE before the prompts run, so a rig that assigned its own would be measuring the rig.
    // Same reason CAPTURE_TERMINATOR_ASSIGNMENT is lifted rather than retyped.
    //
    // r46: there are FOUR of them now — the two captures that take the caller's input and the two
    // declarations that erase it — and they are lifted IN SOURCE ORDER, because the order is the
    // subject. A capture written after the erase captures nothing.
    const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
    const globals = source.match(/^DB_SSL(?:MODE|ROOTCERT)(?:_SUPPLIED)?=.*$/gm) ?? []
    assert.equal(globals.length, 4,
      'precondition: scripts/install.sh must declare the two TLS inputs and the two captures of them, once each, at top level')

    // THE TRANSPORT IS SUPPLIED — OR NOT SUPPLIED — WHERE A CALLER SUPPLIES IT (r46): the PROCESS
    // ENVIRONMENT. Empty is the default here because "the operator said nothing" is the precondition
    // of every recovery assertion below, and because a `vars` assignment would land AFTER the
    // declarations that read the environment and so measure the rig instead of the script.
    const recover = (env: Record<string, string> = {}): { status: number; output: string } => runShipped(
      { APP_DIR: root, APP_USER: currentUser(), DB_HOST: 'db.example.com', DB_PORT: '5432', DB_NAME: 'one_two_inventory', DB_USER: 'imsuser' },
      `
        ${globals.join('\n')}
        load_existing_env "\${APP_DIR}/.env"
        prompt_db_sslmode
        echo "RECOVERED_MODE=\${DB_SSLMODE}"
        echo "RECOVERED_CA=\${DB_SSLROOTCERT}"
      `,
      { env: { DB_SSLMODE: '', DB_SSLROOTCERT: '', ...env } },
    )

    writeFileSync(join(root, '.env'), written(`?sslmode=verify-full&uselibpqcompat=true&sslrootcert=${ca}`))
    const verifyFull = recover()
    assert.equal(verifyFull.status, 0, verifyFull.output)
    assert.match(verifyFull.output, /^RECOVERED_MODE=verify-full$/m,
      `RECOVERED_MODE: an unattended upgrade must keep the transport the last run published:\n${verifyFull.output}`)
    assert.match(verifyFull.output, new RegExp(`^RECOVERED_CA=${publishedCa}$`, 'm'),
      'RECOVERED_CA: and it names the PUBLISHED copy, which is the one file all three readers open')
    assert.equal(readFileSync(publishedCa, 'utf8'), CA_BYTES,
      'RECOVERED_CA: and the bytes there are the ones the recovered path held, or the recovery read some other file')

    writeFileSync(join(root, '.env'), written('?sslmode=require&uselibpqcompat=true'))
    assert.match(recover().output, /^RECOVERED_MODE=require$/m, 'the same for the mode that verifies nothing')
    assert.match(recover().output, /^RECOVERED_CA=$/m, 'which carries no CA, and must not acquire one')

    // A CLEARTEXT INSTALLATION STAYS CLEARTEXT — which is every installation that existed before
    // this round, and the assertion that stops the recovery being "turn TLS on for everybody".
    writeFileSync(join(root, '.env'), written(''))
    assert.match(recover().output, /^RECOVERED_MODE=disable$/m, 'and a URL with no query string recovers `disable`')

    // HAND_WRITTEN: a query string this installer did not compose is not recovered. Under this
    // driver a bare `?sslmode=require` means verify-full against Node's own CA bundle, so reading
    // it as "the operator asked for libpq's require" would be the r43 divergence re-introduced by
    // the recovery path itself.
    writeFileSync(join(root, '.env'), written('?sslmode=require'))
    assert.match(recover().output, /^RECOVERED_MODE=disable$/m,
      'HAND_WRITTEN: only the shape this installer emits is recognised')

    // AND AN OPERATOR-SUPPLIED VALUE STILL WINS, because that is what --non-interactive means —
    // supplied through the PROCESS ENVIRONMENT (r46), which is the only place it can be supplied
    // from and the only place the erase this round removes could ever have been seen.
    writeFileSync(join(root, '.env'), written('?sslmode=require&uselibpqcompat=true'))
    assert.match(recover({ DB_SSLMODE: 'disable' }).output, /^RECOVERED_MODE=disable$/m,
      'an explicit DB_SSLMODE beats the recovered one')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 27b. THE MODE INSTALLATIONS ARE ACTUALLY AUTOMATED IN (o3d-2sm1.5 r46, Codex HIGH)
//
// Everything above measured prompt_db_sslmode() with the shell already carrying whatever the test
// wanted it to carry. The defect was one layer OUTSIDE that: `DB_SSLMODE=""` at script scope
// erased the caller's exported value before any prompt looked at it, so the whole of r45 was
// reachable by typing and by nothing else. `--non-interactive` is how an install is automated, so
// the supported configuration was unreachable in the mode that matters.
//
// This runs the SCRIPT'S OWN top-level statements — the argv parse that sets NON_INTERACTIVE, the
// four declarations in source order, and the whole `--- PostgreSQL ---` block — and supplies the
// transport SOLELY through the process environment the shell is started with. Nothing here assigns
// DB_SSLMODE inside the shell, because an assignment inside the shell is the thing that hid this.
// ---------------------------------------------------------------------------

/** The literal path install.sh publishes the CA to, read out of the script rather than retyped. */
function shippedLiteral(source: string, name: string): string {
  const match = new RegExp(`^${name}="([^"]*)"$`, 'm').exec(source)
  assert.ok(match, `precondition: scripts/install.sh must define ${name} as a double-quoted literal`)
  return match[1]
}

/**
 * The four top-level TLS statements, in source order.
 *
 * ORDER IS THE SUBJECT. A capture written after the erase captures the empty string, which is the
 * defect exactly; lifting them as a set and re-emitting them sorted would pass either way.
 */
function shippedTlsGlobals(source: string): string {
  const globals = source.match(/^DB_SSL(?:MODE|ROOTCERT)(?:_SUPPLIED)?=.*$/gm) ?? []
  assert.equal(globals.length, 4,
    'precondition: scripts/install.sh must declare the two TLS inputs and the two captures of them, once each, at top level')
  return globals.join('\n')
}

test('r46: a full --non-interactive install carries verify-full and its CA from the environment into the URL', () => {
  // MUTATION ROUTES:
  //   M1 -- restore the defect: delete the two DB_SSL*_SUPPLIED capture lines and read DB_SSLMODE
  //         directly in prompt_db_sslmode(). The declarations still erase the environment's value,
  //         the precedence selects the recovered one (nothing, on a first install) and then
  //         `disable`, and MODE= comes back `disable` with a URL carrying no TLS at all.
  //   M2 -- move the captures BELOW the two declarations. Same failure, and this is the shape the
  //         mistake actually takes when someone tidies the block.
  //   M3 -- delete `DB_SSLROOTCERT="${DB_CA_PUBLISHED_FILE}"`: CA= comes back as the operator's own
  //         0600 file, the published copy is never named, and the URL carries a trust root only
  //         root can open. (Test 27 fails on it too, on the same line.)
  //
  // AND THE ROUTE THAT LANDS ON TEST 27 INSTEAD, stated here because the two tests are one pair:
  // reversing the precedence so the RECOVERED value beats the supplied one passes here — a first
  // install has nothing to recover — and fails 27, where an explicit DB_SSLMODE must beat the URL
  // the previous run wrote. Neither test covers the precedence alone; both of them do.
  const root = mkdtempSync(join(tmpdir(), 'ims-r46-noninteractive-'))
  // mkdtemp gives 0700, and the published CA has to be reachable by every uid — which on a
  // production host it is, because /etc is 0755. Without this the ancestry walk is measuring the
  // temporary directory rather than the publication.
  chmodSync(root, 0o755)
  try {
    const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
    const ca = join(root, 'operator-ca.pem')
    writeFileSync(ca, '-- the operator’s own certificate authority --\n')

    // The entrypoint's own statements: how it decides it is non-interactive, what it declares
    // before any prompt runs, and the block that asks the question.
    const argvParse = sliceRange(source, 'NON_INTERACTIVE=false', '# ---------------------------------------------------------------------------')
    assert.match(argvParse, /--non-interactive/, 'precondition: the argv parse must be what sets NON_INTERACTIVE')
    const postgresBlock = sliceRange(source, 'info "--- PostgreSQL ---"', 'info "--- Redis ---"')
    assert.match(postgresBlock, /prompt_db_sslmode/, 'precondition: the PostgreSQL block must be where the transport is asked')

    const run = runShipped(
      { APP_DIR: root, APP_USER: currentUser() },
      `
        ${argvParse}
        ${shippedTlsGlobals(source)}
        ${postgresBlock}
        classify_database_credential_rotation
        echo "NON_INTERACTIVE=\${NON_INTERACTIVE}"
        echo "MODE=\${DB_SSLMODE}"
        echo "CA=\${DB_SSLROOTCERT}"
        echo "URL=\${DATABASE_URL}"
      `,
      {
        argv: ['--non-interactive'],
        env: {
          INSTALL_POSTGRES: 'n',
          DB_HOST: 'db.example.com',
          DB_PORT: '5432',
          DB_NAME: 'one_two_inventory',
          DB_USER: 'imsuser',
          DB_PASSWORD: 'a-password',
          DB_SSLMODE: 'verify-full',
          DB_SSLROOTCERT: ca,
          DB_CA_PUBLISH_DIR: join(root, 'published'),
        },
      },
    )

    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /^NON_INTERACTIVE=true$/m,
      `precondition: --non-interactive must be what this run is in:\n${run.output}`)
    assert.match(run.output, /^MODE=verify-full$/m,
      `MODE: the transport the caller exported must survive the declarations that used to erase it:\n${run.output}`)

    const published = join(root, 'published/db-ca.crt')
    assert.match(run.output, new RegExp(`^CA=${published}$`, 'm'),
      'CA: and it names the published copy, which is the file all three readers open')
    assert.equal(readFileSync(published, 'utf8'), readFileSync(ca, 'utf8'),
      'CA: whose bytes are the operator’s, or the CA that was validated is not the CA that is used')

    // BOTH TLS PARAMETERS, ON THE URL THE APPLICATION IS ACTUALLY HANDED. `uselibpqcompat=true` is
    // the half that makes `verify-full` mean libpq's verify-full rather than the driver's own
    // reading of it, so a URL with only `sslmode=` is a different transport wearing the same word.
    const url = readVar(run.output, 'URL')
    assert.ok(url.includes('sslmode=verify-full'), `URL must state the mode: ${url}`)
    assert.ok(url.includes('uselibpqcompat=true'), `URL must state the driver branch the mode is read in: ${url}`)
    assert.ok(url.includes(`sslrootcert=${published}`), `URL must state the published CA: ${url}`)

    // AND THE PATH IN THE URL IS THE LITERAL THE SCRIPT SHIPS, not whatever the test asked for:
    // the environment override above exists so a rig with no root can run this at all, and this
    // asserts the production path is the one the production run would use.
    const shippedDir = shippedLiteral(source, 'DB_CA_PUBLISH_DIR')
    assert.equal(shippedLiteral(source, 'DB_CA_PUBLISHED_FILE'), `\${DB_CA_PUBLISH_DIR}/db-ca.crt`,
      'the published file hangs off the published directory')
    assert.match(shippedDir, /^\/[A-Za-z0-9._/-]+$/,
      'the published directory must be absolute and inside the character set DB_SSLROOTCERT is validated against')
    assert.equal(shippedLiteral(source, 'DB_CA_PUBLISH_OWNER'), 'root:root',
      'and the published CA is root-owned, which is the whole of the immutability half of the finding')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 27c. THE CA IS VALIDATED AS THE WRONG PRINCIPAL (o3d-2sm1.5 r46, Codex MEDIUM)
//
// `[[ -r ]]` in a script that runs as root proves root can read the file. Three principals open
// this one: the authentication-request reader as root, the psql credential probes as `postgres`,
// and the SERVICE as ${APP_USER}. A CA at mode 0600 passes every check the installer makes and
// then fails when the application starts — after the migration, with the fence down.
//
// So the bytes are published rather than the pathname passed around, and what is asserted here is
// the property the finding is about: a source file NO OTHER UID CAN OPEN produces a published copy
// EVERY UID CAN OPEN, at a path only its owner can write. The permission bits are the whole answer
// and they are checkable without being root, which is what lets this run in CI at all.
// ---------------------------------------------------------------------------

test('r46: a CA readable only by its owner is published as a copy every uid can read and only root can write', () => {
  // MUTATION ROUTES:
  //   M1 -- publish with mode 600 instead of 644 (the mode publish_durable_file() defaults to, so
  //         this is what dropping the argument does): db_ca_path_is_open_to_every_uid() refuses,
  //         PUBLISH= is non-zero, and the run dies naming ${APP_USER}. That is the finding.
  //   M2 -- publish with mode 666: the same function refuses, because a trust root anyone can
  //         rewrite is the other half of the finding.
  //   M3 -- delete the digest comparison from verify_db_ca_published(): DIGEST_AFTER_TAMPER= comes
  //         back 0 and the tampered CA is accepted.
  //   M4 -- make verify_db_ca_published() iterate over nothing instead of over "$@": CALLED= comes
  //         back empty and UNREADABLE= comes back 0, so a principal that cannot open the CA is
  //         reported as one that can.
  const root = mkdtempSync(join(tmpdir(), 'ims-r46-ca-principal-'))
  // mkdtemp gives 0700, and the published CA has to be reachable by every uid — which on a
  // production host it is, because /etc is 0755. Without this the ancestry walk is measuring the
  // temporary directory rather than the publication.
  chmodSync(root, 0o755)
  try {
    const ca = join(root, 'root-only-ca.pem')
    writeFileSync(ca, '-- a CA the installer can read and nobody else can --\n')
    chmodSync(ca, 0o600)
    assert.equal(statSync(ca).mode & 0o077, 0,
      'precondition: the source CA must be unreadable by every uid but its owner — that is the defect’s input')

    const publishDir = join(root, 'published')
    const published = join(publishDir, 'db-ca.crt')
    const run = runShipped(
      { APP_DIR: root, APP_USER: currentUser(), DB_CA_PUBLISH_DIR: publishDir },
      `
        publish_db_ca ${JSON.stringify(ca)}; echo "PUBLISH=$?"
        echo "DIGEST=\${DB_CA_PUBLISHED_DIGEST}"
        verify_db_ca_published "\${APP_USER}"; echo "VERIFY=$?"

        # THE PRINCIPAL LOOP IS NOT VACUOUS, PROVED IN TWO HALVES.
        #
        # First, that it reaches the account the service runs as with the published path: an
        # instrumented run_as_user records the user it was asked to become, then does what the rig's
        # own stub does. A loop that never ran leaves CALLED empty.
        CALLS=""
        run_as_user() { CALLS="\${CALLS} $1"; shift; "$@"; }
        verify_db_ca_published "\${APP_USER}" >/dev/null 2>&1; echo "CALLED=\${CALLS}"

        # Second, that the loop ACTS on the answer. This host cannot make a 0644 file unreadable to
        # one uid and readable to another — that is what 0644 means — so the account's inability to
        # open it is modelled where the account is impersonated, which is exactly the failure the
        # finding describes: a CA the installer and the probes can read and the service cannot.
        run_as_user() { shift; return 1; }
        verify_db_ca_published "\${APP_USER}" >/dev/null 2>&1; echo "UNREADABLE=$?"
        run_as_user() { shift; "$@"; }

        # AND THE DIGEST IS WHAT SAYS THE BYTES ARE STILL THE ONES THAT WERE VALIDATED.
        printf '%s' "-- a different certificate authority --" > ${JSON.stringify(published)}
        verify_db_ca_published >/dev/null 2>&1; echo "DIGEST_AFTER_TAMPER=$?"
      `,
    )

    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /^PUBLISH=0$/m, `the validated CA must publish:\n${run.output}`)
    assert.match(run.output, /^VERIFY=0$/m,
      `VERIFY: the published copy must verify for the account the service runs as:\n${run.output}`)
    assert.match(run.output, /^DIGEST=[0-9a-f]{64}$/m, 'the publication must record the digest of what it published')
    assert.match(run.output, /^DIGEST_AFTER_TAMPER=1$/m,
      `DIGEST_AFTER_TAMPER: a trust root replaced after publication must be refused:\n${run.output}`)

    assert.equal(readVar(run.output, 'CALLED').trim(), currentUser(),
      `CALLED: the check must actually be performed AS the account the service runs as:\n${run.output}`)
    assert.match(run.output, /^UNREADABLE=1$/m,
      `UNREADABLE: a principal that cannot open the published CA must be refused:\n${run.output}`)

    // THE BITS, ASSERTED FROM OUTSIDE THE SHELL TOO. The shipped function checks them; this checks
    // that what it checked is what the finding asked for — 0644, and every directory component
    // other-executable, so every uid on the box can open the file and only its owner can write it.
    const mode = statSync(published).mode & 0o777
    assert.equal(mode, 0o644, `the published CA must be 0644, was 0${mode.toString(8)}`)
    for (let dir = resolve(publishDir); ; dir = dirname(dir)) {
      assert.notEqual(statSync(dir).mode & 0o001, 0,
        `${dir} must grant other-execute or no other uid can reach the published CA`)
      if (dir === '/') break
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 28. THE DIRECTIVE THAT IS ACTUALLY WRITTEN — and the `set -u` trap under it
//
// 23c proves the START refuses without the directive. This proves the installer WRITES the one
// that satisfies it, by running the shipped publisher with its writes stubbed and reading the
// bytes it hands to publish_durable_dropin(). Without this, "the drop-in states exactly that
// directive" is an assertion about a comment.
//
// IT ALSO COVERS A `set -u` TRAP FOUND WHILE ADDING THIS PUBLISHER. install.sh runs under
// `set -euo pipefail` and has no `--dry-run` flag, but publish_db_identity_snapshot() — lifted
// from deploy.sh at r23, where the flag exists — opens with `if $DRY_RUN; then`. install.sh never
// declared it. Bash EXITS on an unset expansion under `set -u`, and `f || die "..."` does not
// catch that: `set -e` is suppressed on the left of `||`, `set -u` is not. So every install died
// at "Setting up application service" — unit written, schema migrated, fence held, nothing
// started — with `DRY_RUN: unbound variable` and no explanation.
// ---------------------------------------------------------------------------

test('r45: the installer writes the UnsetEnvironment directive the start gate requires', () => {
  // MUTATION ROUTES:
  //   M1 -- delete the top-level `DRY_RUN=false` from install.sh: the shell dies on the unbound
  //         variable before the drop-in is written, and DIRECTIVE is never printed.
  //   M2 -- write the names as assignments (`UnsetEnvironment=PGSSLMODE=`): the directive no
  //         longer matches, and 23c's ASSIGNMENT_FORM is what says why that matters.
  //   M3 -- have publish_db_route_guarantee() build its list from a literal instead of
  //         db_route_env_variables(): NAMES_MATCH fails, because the two lists could then drift
  //         and the start gate would demand a name the drop-in does not state.
  const source = readFileSync(join(REPO, 'scripts/install.sh'), 'utf8')
  const lift = (name: string): string => {
    const start = source.indexOf(`\n${name}() {\n`)
    assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
    return source.slice(start + 1, source.indexOf('\n}\n', start) + 3)
  }
  const dryRun = source.match(/^DRY_RUN=.*$/gm) ?? []
  assert.equal(dryRun.length, 1, 'precondition: scripts/install.sh must declare DRY_RUN exactly once at top level')

  const program = [
    // THE SHIPPED FLAGS, because the trap this covers only exists under `set -u`.
    'set -euo pipefail',
    'APP_NAME="one-two-inventory"',
    'YELLOW=""; RESET=""',
    'DB_ROUTE_DROPIN_NAME=zz-deploy-db-route.conf',
    'DB_ROUTE_DROPIN_FILE=/dev/null',
    'error() { echo "ERROR: $*" >&2; }',
    'systemctl() { return 0; }',
    // The one write, replaced by a reader of exactly the bytes it would have written.
    'publish_durable_dropin() { echo "DROPIN_B64=$(base64 -w0)"; }',
    dryRun[0],
    lift('db_route_env_variables'),
    lift('publish_db_route_guarantee'),
    'publish_db_route_guarantee || echo "PUBLISH_FAILED"',
  ].join('\n')
  let output = ''
  try {
    output = execFileSync('bash', ['-c', program], { encoding: 'utf8', env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  assert.doesNotMatch(output, /unbound variable/,
    `the shipped publisher must not die on an unset variable under \`set -u\`:\n${output}`)
  assert.doesNotMatch(output, /PUBLISH_FAILED/, `and it must succeed:\n${output}`)
  const dropin = Buffer.from(readVar(output, 'DROPIN_B64'), 'base64').toString('utf8')
  assert.match(dropin, /^\[Service\]$/m, 'DIRECTIVE: it is a [Service] fragment')
  assert.match(dropin, /^UnsetEnvironment=PGSSLMODE PGREPLICATION NODE_PG_FORCE_NATIVE$/m,
    `DIRECTIVE: bare names, space-separated, all three:\n${dropin}`)

  // NAMES_MATCH: the drop-in states the list the start gate reads, because both come from
  // db_route_env_variables(). A literal in either place is two lists that can drift.
  const listed = execFileSync('bash', ['-c', `set -euo pipefail\n${lift('db_route_env_variables')}\ndb_route_env_variables`], { encoding: 'utf8' })
    .trim().split('\n')
  for (const name of listed) {
    assert.match(dropin, new RegExp(`^UnsetEnvironment=.*\\b${name}\\b`, 'm'),
      `NAMES_MATCH: the directive must name ${name}, which the start gate requires`)
  }
})
