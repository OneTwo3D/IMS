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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  readVar,
  runShipped,
  seedLiveInstallation,
  writeInstalledEnv,
} from './install-shell-rig.ts'
import { type Cluster, cleanLibpqEnv, currentUser, freePort, pgBinDir, startCluster } from './real-postgres-cluster.ts'
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
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres > "\${APP_DIR}/reader.out" 2>&1 || true
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
// 14. THE TRANSPORT: a hostssl rule is what a real install matches, and what the reader must read
// ---------------------------------------------------------------------------

test('r41: the reader negotiates TLS the way libpq prefers, so it reads the hostssl record psql matched', async () => {
  // THE GAP A GREEN SUITE WOULD HAVE HIDDEN. An `initdb` cluster ships `ssl = off`, so every test
  // above negotiates in the clear. DEBIAN'S PACKAGED CLUSTER SHIPS `ssl = on`, and libpq's default
  // `sslmode=prefer` -- which is what every psql this installer runs uses -- therefore negotiates
  // TLS on every real installation. `hostssl` and `hostnossl` are DIFFERENT RECORDS, so a reader
  // that skipped the SSLRequest would read one rule while the psql beside it authenticated under
  // another.
  //
  // The cluster below admits SSL connections under `scram-sha-256` and REJECTS everything else, so
  // the reader has to negotiate TLS to learn anything at all: in the clear the server would answer
  // its startup message with an ErrorResponse and no method would be readable.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. skip the SSLRequest in scripts/lib/pg-auth-request.mjs and send the startup message
  //      straight down the socket: the server refuses the connection outright, the reader answers
  //      method=none, the gate refuses and the rotation refuses. This test fails on the reader
  //      assertions, on the run's status and on ROTATED, and test 15 fails with it — those two are
  //      the only TLS-capable clusters in the suite, which is exactly why they exist.
  //   2. answer `N` unconditionally instead of reading the server's byte: identical failures.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  let cluster: Cluster | undefined
  try {
    cluster = startCluster(root, 'live', await freePort(), '127.0.0.1', [
      'hostssl all all 127.0.0.1/32 scram-sha-256',
      'hostnossl all all 127.0.0.1/32 reject',
    ], { ssl: true })
    seedLiveInstallation(cluster)
    writeInstalledEnv(root, cluster.port, 'live-password')

    // PRECONDITIONS, MEASURED FROM OUTSIDE THE SHELL because pg_endpoint_psql cannot state an
    // sslmode: only the TLS transport reaches a rule at all here, and that rule checks the password.
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), false,
      'precondition: a cleartext connection must reach no usable record')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), true,
      'precondition: and the TLS record must accept the live credential')

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^ssl=yes$/m, 'the reader must have negotiated TLS, as sslmode=prefer does')
    assert.match(reader, /^method=scram-sha-256$/m, 'and therefore read the hostssl record rather than being refused in the clear')

    assert.equal(run.status, 0, `the endpoint psql actually uses is the one that must be measured:\n${run.output}`)
    assert.match(run.output, /GATE_PROBE_DB=postgres/)
    assert.match(run.output, /ROTATED=true/)
    // THE ALTER LANDED, CHECKED OVER THE TRANSPORT THIS CLUSTER ADMITS. connectWithDriver() is not
    // used here and that is deliberate: node-postgres does NOT negotiate TLS unless told to, so on a
    // cluster built to reject cleartext it would fail for a reason that has nothing to do with the
    // credential. The application driver is exercised on ordinary clusters by tests 10 and 12.
    assert.equal(psqlWithSslMode(cluster.port, 'rotated-secret', 'one_two_inventory', 'require'), true,
      'the rotated credential must open the application database')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'one_two_inventory', 'require'), false,
      'and the previous one must not')
    assert.match(envDatabaseUrl(root), /rotated-secret/, 'and the published file must name what the ALTER installed')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 14b. THE SPLIT THE PIN CLOSES: the probe stays on the record the reader read
// ---------------------------------------------------------------------------

test('r42: on a hostssl/hostnossl split the pinned probe does not fall back, and the rotation proceeds', async () => {
  // WHAT THIS TEST USED TO SAY, AND WHY IT NO LONGER SAYS IT. Under r41 the probes ran on libpq's
  // default `sslmode=prefer`, which does not mean "use TLS" — it means try TLS, AND IF THAT
  // CONNECTION FAILS, RETRY WITHOUT IT. So on this cluster a psql handed a WRONG password was
  // refused by scram over TLS, dropped to the clear, and was let in by `trust`; the reader, which
  // never fails an authentication, stopped at the hostssl record and reported an entirely
  // admissible `scram-sha-256`. The negative control caught it — and that was the whole of the
  // defence, which is r42's finding: two instruments answering about two different transports
  // happen to cover each other HERE, and do not on the cluster in test 17.
  //
  // SO THE DIVERGENCE IS REMOVED RATHER THAN CAUGHT. The reader reports the route it took as the
  // libpq setting that reproduces it, and every credential-bearing probe is pinned to that value —
  // `require` here — plus `gssencmode=disable`. There is no second record for a failed
  // authentication to select, so the endpoint is admitted, and admitting it is CORRECT: the
  // reconciliation that follows an interruption runs on the same pin and is answered by the same
  // scram record.
  //
  // BOTH SIDES OF THAT ARE MEASURED IN ONE RUN, on one cluster, so the claim is not a comment:
  // the unpinned connection falls back to `trust`, and the pinned one does not.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `route=(...)` assignment from pg_endpoint_psql() so nothing is pinned: the
  //      unpinned and pinned measurements become identical (`yes`/`yes`), the negative control
  //      refuses the endpoint as it did under r41, and this test fails on UNPINNED/PINNED, on the
  //      run's status, on GATE_PROBE_DB and on ROTATED. Test 17 fails with it, on the outage.
  //   2. pin `sslmode` but not `gssencmode`: nothing here changes — this cluster negotiates no
  //      GSSAPI. Recorded so the next reader does not look for that half here; it is covered by
  //      the shape of the code and by test 16's report assertion, not by a cluster.
  //   3. make pinFor() in scripts/lib/pg-auth-request.mjs return 'prefer': the gate refuses every
  //      endpoint, because db_endpoint_checks_role_verifier() admits only `require` and `disable`
  //      — a route it cannot pin to is not a route. This test fails on status, GATE_PROBE_DB and
  //      ROTATED, and so does every other test in the file whose rotation or reconciliation has to
  //      SUCCEED: 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 17 and 18 (thirteen in all, measured).
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

    const run = runShipped({ ...installVars(cluster, root), DB_PASSWORD: 'rotated-secret' }, `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      # WHAT libpq DOES WITH THE SAME FOUR VALUES AND NO PIN — the divergence itself, through the
      # SHIPPED pg_endpoint_psql with the route left empty, which is exactly what r41 ran.
      if ( DB_ENDPOINT_ROUTE_SSLMODE=""; pg_endpoint_psql "\${DB_USER}" "a-password-nothing-has-ever-set" postgres -tAc 'SELECT 1' ) >/dev/null 2>&1; then
        echo "UNPINNED_FELL_BACK_TO_TRUST=yes"
      else
        echo "UNPINNED_FELL_BACK_TO_TRUST=no"
      fi
      # AND WHAT IT DOES ON THE READER'S ROUTE, through the shipped probe.
      if on_route postgres require db_endpoint_accepts_password postgres "a-password-nothing-has-ever-set"; then
        echo "PINNED_FELL_BACK_TO_TRUST=yes"
      else
        echo "PINNED_FELL_BACK_TO_TRUST=no"
      fi
      ${REINSTALL_BODY}
      FENCE_ARMED=true
      DB_FENCE_UP=true
      rotate_database_password_in_fenced_window
      echo "GATE_PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
      echo "ROTATED=\${DB_ROLE_CREDENTIALS_ROTATED}"
    `)
    const reader = Buffer.from(readVar(run.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^method=scram-sha-256$/m, 'the reader reads the hostssl record')
    assert.match(reader, /^sslmode=require$/m, 'and states the route it read it on, as the setting that reproduces it')
    assert.match(run.output, /UNPINNED_FELL_BACK_TO_TRUST=yes/, 'unpinned, a failed TLS authentication lands on the hostnossl record')
    assert.match(run.output, /PINNED_FELL_BACK_TO_TRUST=no/, 'and pinned to the reader\'s route it cannot')

    assert.equal(run.status, 0, `pinned to one record, this endpoint is exactly what it announced:\n${run.output}`)
    assert.match(run.output, /GATE_PROBE_DB=postgres/, 'so the gate admits it')
    assert.match(run.output, /ROTATED=true/, 'and the rotation proceeds')
    // AND THE ALTER LANDED, CHECKED OVER THE TRANSPORT THE PIN NAMES. connectWithDriver() is not
    // used here for the reason test 14 gives: node-postgres negotiates no TLS unless told to.
    assert.equal(psqlWithSslMode(cluster.port, 'rotated-secret', 'one_two_inventory', 'require'), true,
      'the rotated credential must open the application database over the pinned route')
    assert.match(envDatabaseUrl(root), /rotated-secret/, 'and the published file must name what the ALTER installed')
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
// 17. THE LOAD-BEARING ONE FOR r42: two instruments pass, and the answer is false
// ---------------------------------------------------------------------------

test('r42: encrypted SCRAM over cleartext RADIUS is reconciled automatically, and is NOT with the pin removed', async () => {
  // CODEX'S SCENARIO, BUILT. Every earlier test in this file has ONE record per endpoint, so the
  // reader and the probe could not disagree about which one they met. This cluster has two, split
  // by transport, and both of r41's instruments behave impeccably on it:
  //
  //   hostssl  all all 127.0.0.1/32 scram-sha-256     <- the role's own credential
  //   hostnossl all all 127.0.0.1/32 radius           <- a directory holding the CURRENT password
  //
  //   The reader negotiates TLS, stops at the hostssl record and reports `scram-sha-256`, which is
  //   true. The negative control's random password fails scram over TLS, libpq drops to the clear,
  //   and RADIUS refuses it too -- so the NO is satisfied, by the other record. The positive is
  //   accepted over TLS -- so the YES is satisfied, by the first. THE GATE PASSES.
  //
  //   Then the ALTER commits and the run dies before `.env` is published. Under r41 the next run
  //   asks the same endpoint about both candidates on `sslmode=prefer`: the NEW password is
  //   accepted by scram over TLS, and the OLD one fails scram, falls back, and is accepted by the
  //   DIRECTORY, which never heard of an ALTER ROLE. Both candidates read as live,
  //   resolve_live_role_password() returns 2, and the run refuses -- correctly, given what it was
  //   shown. The installation is stopped, fenced, and now needs a person, off the back of a
  //   pre-ALTER gate that said the journal would be reconcilable.
  //
  // BOTH OUTCOMES ARE MEASURED HERE, ON ONE CLUSTER, IN THIS ORDER: the r41 code path refuses (the
  // outage), and the shipped one resolves. The refusal runs FIRST because it leaves the journal in
  // place -- the die() says so -- which is exactly the state the second run must recover from.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. delete the `route=(...)` assignment from pg_endpoint_psql(): the shipped run becomes the
  //      unpinned run, and this test fails on the second run's status, on PROBE_DB, on
  //      INSTALLED_B64 and on JOURNAL_LEFT. Test 14b fails with it.
  //   2. drop the route guard from db_endpoint_accepts_password() but keep the pin: no change --
  //      the guard is what makes an UNPROVEN endpoint unprobeable, and here the method gate has
  //      proven it. Test 16's report assertion is what covers that line.
  //   3. make db_endpoint_checks_role_verifier() accept an `unknown` sslmode: no change here
  //      either, since this reader reports `require`. Recorded so the next reader does not look
  //      for it in this test.
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
    writeInstalledEnv(root, cluster.port, 'live-password')

    // PRECONDITIONS, MEASURED FROM OUTSIDE THE SHELL: the two transports are two records, and the
    // one underneath is a directory that knows the CURRENT password and only that.
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), true,
      'precondition: the hostssl record must check the role\'s own credential and accept it')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), true,
      'precondition: and the hostnossl record must be a directory holding that same password')
    assert.equal(psqlWithSslMode(cluster.port, 'a-password-nothing-has-ever-set', 'postgres', 'disable'), false,
      'precondition: which refuses everything else, so the negative control is satisfied by it')

    const interrupted = writeInterruptedJournal(cluster, root, 'rotated-secret', 'postgres')
    assert.equal(interrupted.status, 0, interrupted.output)
    // The ALTER committed; the run died before `.env` was replaced. Boundary (2): the only safe
    // answer is to FINISH the transition.
    cluster.psql(['-c', "ALTER USER imsuser WITH PASSWORD 'rotated-secret'"])

    // AND NOW THE TWO RECORDS DISAGREE, which is the whole finding.
    assert.equal(psqlWithSslMode(cluster.port, 'rotated-secret', 'postgres', 'require'), true,
      'precondition: scram has the new password')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'require'), false,
      'precondition: and not the old one')
    assert.equal(psqlWithSslMode(cluster.port, 'live-password', 'postgres', 'disable'), true,
      'precondition: while the directory still has the old one, because it never heard of the ALTER')

    // ---- RUN 1: r41's probe, restored verbatim. THIS IS THE OUTAGE.
    const unpinned = runShipped(installVars(cluster, root), `
      ${R41_UNPINNED_PROBE}
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    assert.equal(unpinned.status, 9, `unpinned, both candidates are accepted and the run must refuse:\n${unpinned.output}`)
    assert.match(unpinned.output, /accepts BOTH recorded candidates/, 'and say that is what it saw')
    assert.match(unpinned.output, /LEFT IN PLACE/, 'leaving the journal, which is what makes run 2 possible')
    assert.equal(journalValue(root, 'probe_database'), 'postgres', 'and the record is still there to be read')

    // ---- RUN 2: the shipped probe, pinned to the reader's route.
    const pinned = runShipped(installVars(cluster, root), `
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres > "\${APP_DIR}/reader.out" 2>&1 || true
      echo "READER_B64=$(base64 -w0 < "\${APP_DIR}/reader.out")"
      ${NEXT_RUN_BODY}
      echo "PROBE_DB=\${DB_ROTATION_PROBE_DATABASE}"
    `)
    const reader = Buffer.from(readVar(pinned.output, 'READER_B64'), 'base64').toString('utf8')
    assert.match(reader, /^method=scram-sha-256$/m, 'the reader reads the hostssl record')
    assert.match(reader, /^sslmode=require$/m, 'and names the route that reproduces it')

    assert.equal(pinned.status, 0, `pinned to that route, only scram answers and the ALTER is visible:\n${pinned.output}`)
    assert.match(pinned.output, /PROBE_DB=postgres/, 'the same endpoint answers')
    assert.match(pinned.output, /has the NEW password: the ALTER committed/, 'and it reaches the right answer')
    assert.equal(decodeVar(pinned.output, 'INSTALLED_B64'), 'rotated-secret')
    assert.match(pinned.output, /JOURNAL_LEFT=no/, 'the transition is finished, so the record is cleared')
    assert.match(envDatabaseUrl(root), /rotated-secret/, 'and the published file names what the server has')
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
      node "$(db_auth_request_probe_path)" --host="\${DB_HOST}" --port="\${DB_PORT}" --user="\${DB_USER}" --database=postgres > "\${APP_DIR}/reader.out" 2>&1 || true
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
// 20. A METHOD WITHOUT A TRANSPORT IS NOT AN ADMISSION
// ---------------------------------------------------------------------------

test('r42: an admissible method read over an unstated route is refused, and the report says which half was missing', () => {
  // THE ONE CASE THE SHIPPED READER CANNOT PRODUCE TODAY, WHICH IS WHY IT NEEDS A TEST. pinFor()
  // answers `require`, `disable` or `unknown`, and `unknown` only on a connection that failed —
  // where the exit status already refuses. So the branch in db_endpoint_checks_role_verifier() that
  // refuses an admissible METHOD carrying an unusable ROUTE is unreachable through the shipped
  // reader, and would sit there unexercised until somebody taught the reader a fourth answer.
  //
  // A READER IS EXACTLY WHAT THAT CONTRACT IS WITH, so the test supplies one. Two stubs, differing
  // in ONE LINE — the route — through IMS_AUTH_REQUEST_PROBE, which the shipped path already
  // exposes for the regressions and which cannot produce an exemption: pointing it somewhere else
  // produces a refusal, never an admission.
  //
  // NO CLUSTER AND NO CONNECTION. db_endpoint_checks_role_verifier() runs a program and parses its
  // output; it sends no password and opens no psql. The port below is deliberately one nothing is
  // listening on, so a version of this that DID connect would fail rather than quietly pass.
  //
  // MUTATION ROUTES (each measured by making the change and re-running):
  //   1. add `prefer` to the `case` in db_endpoint_checks_role_verifier(): PREFER_ADMITTED becomes
  //      `yes`, PREFER_ROUTE becomes `prefer`, and this test fails on both. Nothing else in the
  //      suite fails, because the shipped reader never says `prefer` — which is the point.
  //   2. drop the `case` entirely and publish whatever the reader said: identical failures, and
  //      the report assertion fails too.
  const root = mkdtempSync(join(tmpdir(), 'ims-probe-'))
  try {
    const reader = (sslmode: string) =>
      `process.stdout.write('transport=tcp\\nssl=yes\\nsslmode=${sslmode}\\nmethod=scram-sha-256\\nverifier=role\\ndetail=a stub reader\\n')\n`
    writeFileSync(join(root, 'reader-prefer.mjs'), reader('prefer'))
    writeFileSync(join(root, 'reader-require.mjs'), reader('require'))

    const run = runShipped({
      APP_DIR: root,
      APP_USER: currentUser(),
      DB_HOST: '127.0.0.1',
      // A port nothing holds: this path must not open a connection, and if it ever does it fails.
      DB_PORT: '1',
      DB_NAME: 'one_two_inventory',
      DB_USER: 'imsuser',
    }, `
      DB_PROBE_REPORT=""
      IMS_AUTH_REQUEST_PROBE="\${APP_DIR}/reader-prefer.mjs"
      if db_endpoint_checks_role_verifier postgres; then echo "PREFER_ADMITTED=yes"; else echo "PREFER_ADMITTED=no"; fi
      echo "PREFER_ROUTE=\${DB_PROBE_SSLMODE}"
      echo "REPORT_B64=$(printf '%s' "\${DB_PROBE_REPORT}" | base64 -w0)"
      # THE CONTROL: the SAME stub with one word changed. If this did not qualify, the refusal
      # above would be about something else entirely.
      IMS_AUTH_REQUEST_PROBE="\${APP_DIR}/reader-require.mjs"
      if db_endpoint_checks_role_verifier postgres; then echo "REQUIRE_ADMITTED=yes"; else echo "REQUIRE_ADMITTED=no"; fi
      echo "REQUIRE_ROUTE=\${DB_PROBE_SSLMODE}"
      echo "REQUIRE_ENDPOINT=\${DB_PROBE_ROUTE_DATABASE}"
    `)
    assert.equal(run.status, 0, run.output)
    assert.match(run.output, /PREFER_ADMITTED=no/, 'a route that cannot be pinned to is not a route')
    assert.match(run.output, /PREFER_ROUTE=$/m, 'and nothing is published, so no probe can run on it')
    const report = Buffer.from(readVar(run.output, 'REPORT_B64'), 'base64').toString('utf8')
    assert.match(report, /did not name the TRANSPORT it read it on/, 'the report names the half that was missing')
    assert.match(report, /hostssl and hostnossl are different records/, 'and why that is not a formality')

    assert.match(run.output, /REQUIRE_ADMITTED=yes/, 'control: the same method with a usable route qualifies')
    assert.match(run.output, /REQUIRE_ROUTE=require/, 'and the route is published as the reader stated it')
    assert.match(run.output, /REQUIRE_ENDPOINT=postgres/, 'bound to the endpoint it was read on')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
