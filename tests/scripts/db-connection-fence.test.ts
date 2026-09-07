import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

/**
 * BOTH HALVES OF THE DRIVER, asked DIRECTLY rather than re-exported from the script under test.
 *
 * `driverParse` is the STRING PARSER: it reads the URL and stops. `driverConnection` is the
 * CONNECTION: `pg/lib/connection-parameters.js` folds `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`
 * and its own defaults over the parser's output, and that is what `Connection#connect()` and
 * `getStartupConf()` are handed. The parity tests below assert the script against the SECOND one
 * and assert that the two DISAGREE on the URLs they use -- so agreeing with the connection is
 * measurably not agreeing with the parser, and the comparison cannot pass by accident.
 */
import pg from 'pg'
import { parse as driverParse } from 'pg-connection-string'

/** The final connection configuration, built exactly as `pg` builds it and never opened. */
function driverConnection(connectionString: string) {
  const client = new pg.Client({ connectionString })
  return {
    host: String(client.host ?? ''),
    port: Number(client.port),
    user: String(client.user ?? ''),
    database: String(client.database ?? ''),
  }
}

/** Set PG* environment variables for the length of one test and put back what was there. */
function withPgEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

import {
  REQUIRED_IDENTITY_OPTIONS,
  parseArgs,
  requireSuppliedIdentity,
  EXIT_ERROR,
  EXIT_FENCE_STANDING,
  EXIT_FENCE_UNPROVEN,
  EXIT_NOT_FENCEABLE,
  EXIT_OK,
  PUBLIC_GRANTEE,
  STATE_ABSENT,
  STATE_CORRUPT,
  STATE_COMPLETE_SENTINEL,
  STATE_PRESENT,
  STATE_UNREADABLE,
  FENCE_MODE_INITIAL,
  FENCE_MODE_RECOVERY,
  assessAuthorityDrift,
  // o3d-secops r26: the rule that settles an unstamped record, and the mode that drives it.
  LEGACY_FENCE_ABSENT,
  LEGACY_FENCE_AMBIGUOUS,
  LEGACY_FENCE_STANDS,
  assessLegacyFenceEvidence,
  doAuditAuthority,
  assessDatabaseIdentity,
  assessUnrecordedRelease,
  authorityFenceMode,
  classifyStateShape,
  doFence,
  doRelease,
  readState,
  assessEffectiveFence,
  assessMigrationRole,
  parseConnectionIdentity,
  buildMigrationConnectionString,
  listDirectConnectGrantees,
  buildGrantStatements,
  buildRevokeStatements,
  granteeHasConnect,
  aclPrivilegeRows,
  DATACL_PRIVILEGES_SQL,
  compareClusterIdentity,
  MACHINE_CHANNEL,
  EXIT_ALREADY_RELEASED,
  CLUSTER_IDENTITY_PROVEN,
  CLUSTER_IDENTITY_MISMATCH,
  CLUSTER_IDENTITY_NO_FINGERPRINT,
  CLUSTER_IDENTITY_UNVERIFIABLE,
  parseRoleFromConnectionString,
  // o3d-secops r31: the connection witness -- its key derivation, the observation both --fence and
  // --release make on their own connections, and where a witness is sent so the drain misses it.
  advisoryKeyForWitnessNonce,
  witnessLockIsHeld,
  witnessConnectionStrings,
  planConnectionFence,
  quoteIdent,
  verifyRelease,
} from '@/scripts/fence-db-connections.mjs'
import { protectedLibraryLines, writeFenceCheckout } from './fence-artefact-harness.ts'
import { Client } from 'pg'

import { cloneCluster, currentUser, freePort, startCluster } from './real-postgres-cluster.ts'
import { shellConstant, shellFunction } from './shell-symbol.ts'

/**
 * CAPTURING WHAT THE HELPER SAYS, WITHOUT TOUCHING THE RUNNER'S OWN STREAM (o3d-secops r30,
 * Codex LOW).
 *
 * WHAT WAS WRONG. Five helpers in this file captured output by REPLACING `process.stdout.write`
 * and `process.stderr.write` for the duration of an `await`. Those are process globals and the
 * test runner writes its TAP stream through the first of them: anything the runner emitted inside
 * that window was swallowed into the test's own buffer and never forwarded, so a file could report
 * fewer tests than it declared and still say zero failures. That is a helper able to delete tests
 * from a run, which is worse than any finding it was written to measure.
 *
 * WHAT IT IS NOW. Nothing process-global is replaced. The shipped code's MACHINE CHANNEL -- the
 * five `key=value` lines root reads out of a command substitution -- is a substitutable value in
 * the module under test, and its PROSE goes through `console.log` and `console.error`, which the
 * runner does not use for its report. So a capture reaches the subject and cannot reach the
 * reporter.
 *
 * `out` is the machine channel plus anything on console.log; `err` is console.error. Both are
 * restored in a `finally` that runs whether the body returned or threw.
 */
async function capturingFenceOutput<T>(body: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const machine = MACHINE_CHANNEL.write
  const log = console.log
  const error = console.error
  MACHINE_CHANNEL.write = (text: string) => { out.push(String(text)); return true }
  console.log = (...args: unknown[]) => { out.push(`${args.map(String).join(' ')}\n`) }
  console.error = (...args: unknown[]) => { err.push(`${args.map(String).join(' ')}\n`) }
  try {
    const value = await body()
    return { value, out: out.join(''), err: err.join('') }
  } finally {
    MACHINE_CHANNEL.write = machine
    console.log = log
    console.error = error
  }
}

/**
 * resolve_fence_script(), lifted verbatim out of a shipped entrypoint (o3d-2sm1.5 r32).
 *
 * It is the one place each entrypoint decides which bytes the fence runs, and it is what
 * refence_db_connections() calls. A harness that stubbed it would assert nothing about the
 * resolution the finding was about, and one that lifted db_fence_script_in_use() instead would
 * keep passing if the entrypoint stopped calling it.
 */
function liftedResolver(source: string): string {
  const start = source.indexOf('resolve_fence_script() {')
  assert.ok(start > 0, 'precondition: the entrypoint resolves through a function of its own')
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, 'precondition: and that function has an end')
  return source.slice(start, end + 3)
}

/**
 * The live half of the ROLE identity check, as every pre-existing case has it: the connection
 * logged in as the admin role and is running as that same role (o3d-2sm1.5, Codex r14 CRITICAL).
 * assessDatabaseIdentity() refuses without it, so the cases that are about the DATABASE half say
 * so by spreading this in; the cases that are about the role half override it deliberately.
 */
const ATTACHED_AS_ADMIN = { connectedLoginRole: 'deployadmin', connectedEffectiveRole: 'deployadmin' }

/**
 * THE FOUR VALUES THE CALLER SUPPLIES, in the shape `assessDatabaseIdentity()` now requires
 * (o3d-2sm1.5 r19). Nothing here derives them from a URL, because nothing in the helper does.
 */
function suppliedIdentity(overrides: Partial<Record<'appHost' | 'appPort' | 'appUser' | 'appDatabase', string>> = {}) {
  // stateOwnerUid TRAVELS WITH THE IDENTITY (o3d-secops r23). Since r23 every mode that acts on
  // the authority record proves first that only the publishing account could have written it, and
  // the caller says which uid that is — `--state-owner`, defaulted to 0 by parseArgs and set from
  // `id -u` by the entrypoints, for the reason publish_durable_file() asks `id -u` instead of
  // comparing against a literal: the property is "the privileged account that owns this install",
  // and asking is what lets these regressions run unprivileged.
  return { appHost: 'localhost', appPort: '5432', appUser: 'imsapp', appDatabase: 'onetwo3d_ims', stateOwnerUid: process.getuid?.() ?? 0, ...overrides }
}

/** The same four as command-line arguments, for the end-to-end runs. */
function identityArgs(overrides: Partial<Record<'appHost' | 'appPort' | 'appUser' | 'appDatabase', string>> = {}) {
  const identity = suppliedIdentity(overrides)
  return [
    `--app-host=${identity.appHost}`,
    `--app-port=${identity.appPort}`,
    `--app-user=${identity.appUser}`,
    `--app-database=${identity.appDatabase}`,
  ]
}

/**
 * Run the shipped script from a directory with no .env, and report what it said.
 *
 * THE APPLICATION'S IDENTITY IS ON THE COMMAND LINE (o3d-2sm1.5 r19). The script no longer works
 * out where the application connects — not from this process's environment, not from a dotenv
 * overlay, and not from systemd — so every run here passes the four values explicitly, and
 * `identity: null` is the "nothing was supplied" refusal.
 */
function runFenceScript(
  args: string[],
  env: Record<string, string | undefined>,
  identity: string[] | null = identityArgs({ appDatabase: 'ims' }),
) {
  // THE DIRECTORY IS REMOVED IN A `finally` (o3d-2sm1.5). This harness runs on every call in a
  // file of several dozen tests and used to remove nothing, so a single run left a directory per
  // call under /tmp. `finally` and not the happy path: the runs that fail are the ones a leaking
  // harness leaks, and this one is called far more often for its refusals than for its successes.
  const cwd = mkdtempSync(join(tmpdir(), 'ims-fence-'))
  try {
    // spawnSync, not execFileSync: the script's diagnostics go to STDERR so that stdout stays the
    // machine-readable channel `--print-migration-url` is captured through, and a test that could
    // only see stdout on success could not tell the two apart.
    const run = spawnSync(
      'node',
      [join(process.cwd(), 'scripts/fence-db-connections.mjs'), ...args, ...(identity ?? [])],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdout = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    return { status: run.status ?? -1, stdout, stderr, output: `${stdout}${stderr}` }
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}

// o3d-2sm1.2 — check-db-writers.mjs SNAPSHOTS pg_stat_activity and closes; the dump
// and the migration open their own connections afterwards, and nothing stops another
// client connecting in between. This is the continuous part, and the decisions it
// makes — whether a fence is even possible, and exactly what a release must restore —
// are asserted here rather than discovered against a production database.

/**
 * THE ACL AS THE DATABASE NOW HANDS IT OVER (o3d-secops r28, Codex HIGH).
 *
 * Every fixture in this file used to be a `datacl::text` string, because the helper took one apart
 * by hand. It does not any more: DATACL_PRIVILEGES_SQL asks aclexplode() for rows, so a fixture
 * that is a string would be answering a question nobody asks.
 *
 * AND THIS IS NOT A PARSER. It takes the entries already spelt out -- a grantee (empty for PUBLIC)
 * and the privilege letters -- and expands them. Writing the printed form here and taking it apart
 * again would put the defect back inside the test, which is the one place it would never be found.
 * What the REAL escaping does is measured against a REAL cluster; see the PostgreSQL test below.
 */
const PRIVILEGE_OF_LETTER: Record<string, string> = { C: 'CREATE', T: 'TEMPORARY', c: 'CONNECT' }
function aclRows(entries: ReadonlyArray<readonly [string, string]>) {
  return entries.flatMap(([grantee, letters], index) =>
    [...letters].map((letter) => ({
      // PUBLIC is grantee OID 0 and can never be a role; every named grantee gets an OID of its
      // own so that a role somebody called "PUBLIC" would still not be it.
      grantee_oid: grantee === '' ? '0' : String(16384 + index),
      grantee,
      privilege: PRIVILEGE_OF_LETTER[letter] ?? letter,
    })),
  )
}
/** The three readings every test in this file is about, named once. */
const ACL_UNFENCED = aclRows([['owner', 'CTc'], ['', 'Tc'], ['imsapp', 'c']])
const ACL_FENCED = aclRows([['owner', 'CTc']])
const ACL_MIXED = aclRows([['owner', 'CTc'], ['imsapp', 'c']])

function facts(overrides: Record<string, unknown> = {}) {
  return {
    appRole: 'imsapp',
    appRoleIsSuperuser: false,
    adminRole: 'deployadmin',
    adminIsSuperuser: true,
    adminIsOwner: false,
    publicHasConnect: true,
    appRoleHasConnect: false,
    appRoleHasEffectiveConnect: false,
    ...overrides,
  }
}

test('an ACL that could not be read is never read as "no privileges" (o3d-secops r28)', () => {
  // WHAT THIS REPLACES. Until r28 these functions took `datacl::text` and a NULL meant "the
  // defaults", spelt out here in JavaScript. The SQL expands the defaults now -- COALESCE(datacl,
  // acldefault('d', datdba)) -- so a null arriving HERE no longer means "the defaults": it means
  // the row was not there to read. Reading that as "nobody holds CONNECT" is fail-closed for every
  // caller (a release reports NOT restored, a fence plans nothing), where the old reading of the
  // same value said the owner and PUBLIC were fine.
  assert.deepEqual(aclPrivilegeRows(null), [])
  assert.deepEqual(aclPrivilegeRows(undefined), [])
  assert.equal(granteeHasConnect(null, PUBLIC_GRANTEE), false)
  assert.equal(granteeHasConnect(undefined, 'owner'), false)
  // AND A SHAPE IT CANNOT READ IS NOT SUMMARISED AS AN EMPTY ONE. A `datacl::text` string handed
  // to this by mistake is exactly the substitution this round removed, so it throws rather than
  // quietly answering a question about a value it did not understand.
  assert.throws(() => aclPrivilegeRows('{owner=CTc/owner}'), /aclexplode/)
})

test('an explicit ACL is read row by row, and PUBLIC is grantee OID 0 rather than a name', () => {
  const acl = aclRows([['owner', 'CTc'], ['', 'T'], ['imsapp', 'c']])
  assert.deepEqual(aclPrivilegeRows(acl).map((row) => row.grantee), ['owner', 'owner', 'owner', '', 'imsapp'])
  assert.equal(granteeHasConnect(acl, PUBLIC_GRANTEE), false, 'PUBLIC has TEMPORARY but not CONNECT')
  assert.equal(granteeHasConnect(acl, 'imsapp'), true)
  assert.equal(granteeHasConnect(acl, 'nobody'), false)

  // PUBLIC IS NOT A NAME. A role somebody created and called "PUBLIC" holds its own grants and is
  // not the pseudo-role the fence revokes from; only the OID separates them, which is why the OID
  // is carried and not just the printed name.
  const impostor = [{ grantee_oid: '16999', grantee: 'PUBLIC', privilege: 'CONNECT' }]
  assert.equal(granteeHasConnect(impostor, PUBLIC_GRANTEE), false,
    'a role NAMED "PUBLIC" is not the PUBLIC pseudo-role')
  assert.deepEqual(listDirectConnectGrantees(impostor), ['PUBLIC'], 'it is a named grantee like any other')
})

test('a role name PostgreSQL would have to quote is carried through untouched (o3d-secops r28)', () => {
  // THE HIGH THIS ROUND ANSWERS, at the unit. The old parser toggled on every quote and ignored
  // backslash escaping, so `we"ird`, `back\slash` and `comma,role` all came back as some other
  // name -- and a REVOKE aimed at a name the database does not have either aborts the fence or
  // hits the wrong role. There is nothing left to parse: the name arrives as a column value.
  const odd = aclRows([['we"ird', 'c'], ['back\slash', 'c'], ['comma,role', 'c'], ['imsapp', 'c']])
  assert.deepEqual(listDirectConnectGrantees(odd), ['we"ird', 'back\slash', 'comma,role', 'imsapp'])
  for (const name of ['we"ird', 'back\slash', 'comma,role']) {
    assert.equal(granteeHasConnect(odd, name), true, `${name} holds CONNECT and must be seen to`)
  }
  // AND THE STATEMENTS BUILT FROM THOSE NAMES QUOTE THEM PROPERLY, which is the other half of
  // being able to act on them at all.
  assert.deepEqual(buildRevokeStatements('imsdb', ['we"ird']), ['REVOKE CONNECT ON DATABASE "imsdb" FROM "we""ird";'])
})

test('the fence refuses when a revoke would fence nothing', () => {
  // A superuser bypasses database ACLs, so revoking CONNECT from one is decoration.
  const superApp = planConnectionFence(facts({ appRoleIsSuperuser: true }))
  assert.equal(superApp.fenceable, false)
  assert.match(superApp.reason, /SUPERUSER/)

  const noRole = planConnectionFence(facts({ appRole: '' }))
  assert.equal(noRole.fenceable, false)

  const alreadyClosed = planConnectionFence(facts({ publicHasConnect: false, appRoleHasConnect: false }))
  assert.equal(alreadyClosed.fenceable, false)
  assert.match(alreadyClosed.reason, /nothing to revoke/)
})

test('the fence refuses when it would lock the migration out with the application', () => {
  // No ACL can tell "the migration" apart from "the application" when both log in as
  // one role. Saying so is the point; proceeding as though fenced is the defect.
  const sameRole = planConnectionFence(facts({ adminRole: 'imsapp' }))
  assert.equal(sameRole.fenceable, false)
  assert.match(sameRole.reason, /DEPLOY_ADMIN_DATABASE_URL/)

  const unprivileged = planConnectionFence(facts({ adminIsSuperuser: false, adminIsOwner: false }))
  assert.equal(unprivileged.fenceable, false)
  assert.match(unprivileged.reason, /neither a superuser nor the database owner/)
})

test('a fenceable database revokes from PUBLIC as well as the role', () => {
  // Revoking from the role alone changes nothing while PUBLIC still holds CONNECT,
  // which is the default for every database Postgres creates.
  const plan = planConnectionFence(facts({ appRoleHasConnect: true }))
  assert.equal(plan.fenceable, true)
  assert.deepEqual(plan.revoke, [PUBLIC_GRANTEE, 'imsapp'])

  const ownerAdmin = planConnectionFence(facts({ adminIsSuperuser: false, adminIsOwner: true }))
  assert.equal(ownerAdmin.fenceable, true)
  assert.deepEqual(ownerAdmin.revoke, [PUBLIC_GRANTEE])
})

test('the fence records only what it revoked, so the release restores that and not "everything"', () => {
  const plan = planConnectionFence(facts({ appRoleHasConnect: false }))
  assert.deepEqual(plan.revoke, [PUBLIC_GRANTEE])
  assert.deepEqual(buildRevokeStatements('ims', plan.revoke), [
    'REVOKE CONNECT ON DATABASE "ims" FROM PUBLIC;',
  ])
  assert.deepEqual(buildGrantStatements('ims', plan.revoke), [
    'GRANT CONNECT ON DATABASE "ims" TO PUBLIC;',
  ])
})

test('identifiers are quoted, and an embedded quote cannot break out of one', () => {
  assert.equal(quoteIdent('one-two'), '"one-two"')
  assert.equal(quoteIdent('we"ird'), '"we""ird"')
  assert.deepEqual(buildRevokeStatements('a"b', ['ro"le']), [
    'REVOKE CONNECT ON DATABASE "a""b" FROM "ro""le";',
  ])
})

test('a release is only released when the database says the grants are back', () => {
  // The restore has to be as robust as the fence: reporting success without re-reading
  // the ACL would leave an application that cannot connect at all.
  const restored = verifyRelease(ACL_UNFENCED, [PUBLIC_GRANTEE, 'imsapp'])
  assert.equal(restored.released, true)

  const partial = verifyRelease(aclRows([['owner', 'CTc'], ['', 'T'], ['imsapp', 'c']]), [PUBLIC_GRANTEE, 'imsapp'])
  assert.equal(partial.released, false)
  assert.deepEqual(partial.missing, [PUBLIC_GRANTEE])

  // AND AN ANSWER THAT NEVER ARRIVED IS NOT A RESTORED ONE (o3d-secops r28). The verification
  // query finding no row -- the database renamed or dropped under the release -- used to fall into
  // the "NULL means the defaults" branch and report the owner and PUBLIC restored.
  const noAnswer = verifyRelease(undefined, [PUBLIC_GRANTEE, 'imsapp'])
  assert.equal(noAnswer.released, false, 'a release cannot be verified against an ACL nobody read')
  assert.deepEqual(noAnswer.missing, [PUBLIC_GRANTEE, 'imsapp'])
})

test('the role to fence is the one the application connects as', () => {
  assert.equal(parseRoleFromConnectionString('postgresql://imsapp:pw@localhost:5432/ims'), 'imsapp')
  assert.equal(parseRoleFromConnectionString('postgresql://one%20two@localhost/ims'), 'one two')
  assert.equal(parseRoleFromConnectionString('postgresql://localhost/ims'), '')
  assert.equal(parseRoleFromConnectionString(''), '')
  assert.equal(parseRoleFromConnectionString('not a url'), '')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.3 (Codex r2, HIGH) — INHERITED ROLE PRIVILEGES BYPASS THE FENCE.
//
// The plan examines DIRECT ACL entries for PUBLIC and the login role and then declares
// success. Postgres grants also arrive through role membership, so CONNECT can still be
// held after both revokes — and the fence would report armed while the application can
// still connect, which is worse than no fence because the whole deploy proceeds
// believing the door is shut. The answer is the same as revoking from PUBLIC: ask the
// database what is TRUE rather than reasoning about what you changed.
// ---------------------------------------------------------------------------

test('a fence that did not take is a failure, not an armed fence', () => {
  const took = assessEffectiveFence({ appRole: 'imsapp', stillConnects: false })
  assert.equal(took.fenced, true)

  const didNot = assessEffectiveFence({
    appRole: 'imsapp',
    stillConnects: true,
    grantingRoles: ['app_readers', 'ims_all'],
  })
  assert.equal(didNot.fenced, false)
  assert.match(didNot.reason, /THE FENCE DID NOT TAKE/)
  assert.match(didNot.reason, /app_readers, ims_all/, 'the roles that still grant CONNECT must be named')
})

test('a fence that did not take says so even when no granting role could be identified', () => {
  // has_database_privilege accounts for the superuser bit and for a grant made between
  // the read and the revoke, neither of which shows up as a role membership. Reporting
  // "fenced" because the search came back empty is the same defect one level in.
  const unexplained = assessEffectiveFence({ appRole: 'imsapp', stillConnects: true, grantingRoles: [] })
  assert.equal(unexplained.fenced, false)
  assert.match(unexplained.reason, /No role membership was identified/)
})

test('CONNECT held only through membership is refused as unfenceable, not reported as already closed', () => {
  // Both cases have nothing to revoke. One is a database already shut; the other is one
  // this script CANNOT shut, because the grant lives on a role shared with other
  // principals. Collapsing them would let a deploy read "nothing to revoke" as safe.
  const inherited = planConnectionFence(
    facts({ publicHasConnect: false, appRoleHasConnect: false, appRoleHasEffectiveConnect: true }),
  )
  assert.equal(inherited.fenceable, false)
  assert.match(inherited.reason, /through role membership/)
  assert.deepEqual(inherited.revoke, [])

  const genuinelyClosed = planConnectionFence(
    facts({ publicHasConnect: false, appRoleHasConnect: false, appRoleHasEffectiveConnect: false }),
  )
  assert.match(genuinelyClosed.reason, /nothing to revoke/)
})

test('the effective check is what the fence script actually asks the database', () => {
  // The assertion that matters is not that a pure function exists but that the SQL is
  // there: a plan verified only against parsed ACL text is the finding, not the fix.
  const source = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  assert.match(source, /has_database_privilege\(\$1, current_database\(\), 'CONNECT'\)/)
  assert.match(source, /assessEffectiveFence\(/)
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, HIGH) — THE "CONTINUOUS" FENCE COVERED EXACTLY TWO GRANTEES.
//
// It revoked from PUBLIC and the application role and then called the database held closed.
// Any third role with a direct CONNECT grant — monitoring, BI, a backup job, a second
// application — was terminated by the drain and RECONNECTED IMMEDIATELY, for the whole
// length of the migration, while the script's header and the docs claimed otherwise.
// ---------------------------------------------------------------------------

test('every named role holding CONNECT directly is listed, and PUBLIC is not one of them', () => {
  const acl = aclRows([['owner', 'CTc'], ['', 'Tc'], ['imsapp', 'c'], ['metabase', 'c'], ['readonly', 'T']])
  assert.deepEqual(listDirectConnectGrantees(acl), ['owner', 'imsapp', 'metabase'])
  assert.ok(!listDirectConnectGrantees(acl).includes(''), 'PUBLIC is handled separately')
  // A DEFAULT ACL IS THE SQL'S PROBLEM NOW (o3d-secops r28): COALESCE(datacl, acldefault('d',
  // datdba)) expands it server-side, so what arrives here is already the owner's own rows. What
  // arrives as nothing is nothing -- see the r28 test above for why that direction is the safe one.
  assert.deepEqual(listDirectConnectGrantees(aclRows([['owner', 'CTc'], ['', 'Tc']])), ['owner'])
  assert.deepEqual(listDirectConnectGrantees(null), [])
})

test('the fence revokes from a third grantee, not only from PUBLIC and the application role', () => {
  const plan = planConnectionFence(
    facts({
      appRoleHasConnect: true,
      directConnectGrantees: ['imsapp', 'metabase', 'backupbot'],
    }),
  )
  assert.equal(plan.fenceable, true)
  assert.deepEqual(
    plan.revoke,
    [PUBLIC_GRANTEE, 'imsapp', 'metabase', 'backupbot'],
    'a monitoring or BI role that keeps CONNECT is terminated by the drain and back a moment later',
  )
  assert.deepEqual(
    buildRevokeStatements('ims', plan.revoke).length,
    4,
    'and every one of them is a statement the fence actually runs',
  )
  assert.deepEqual(
    buildGrantStatements('ims', plan.revoke).length,
    4,
    'and one the release actually restores',
  )
})

test('the fence never revokes CONNECT from the role the deploy itself is connected as', () => {
  // Revoking from the admin would lock the deploy out of the recovery it has to run: the
  // migration, the drift check, the verification hook and the release all reconnect as it.
  const plan = planConnectionFence(
    facts({
      appRoleHasConnect: true,
      directConnectGrantees: ['imsapp', 'deployadmin'],
    }),
  )
  assert.deepEqual(plan.revoke, [PUBLIC_GRANTEE, 'imsapp'])
  assert.ok(!plan.revoke.includes('deployadmin'), 'the admin keeps CONNECT or the recovery has no connection')
})

test('a grantee is revoked once even when both the ACL and the app-role flag name it', () => {
  const plan = planConnectionFence(
    facts({ appRoleHasConnect: true, directConnectGrantees: ['imsapp'] }),
  )
  assert.deepEqual(plan.revoke, [PUBLIC_GRANTEE, 'imsapp'])
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, CRITICAL) — WHO THE MIGRATION RUNS AS.
//
// The fence forces the migration through the ADMIN connection, and whatever runs a CREATE
// owns what it creates. install.sh makes the APPLICATION role the database owner and this
// script refuses when admin == app, so the only fenceable configuration is a separate
// SUPERUSER admin — and every object a migration created was owned by that superuser with no
// grant to the application. The drift check, the verification hook and pg_dump all share the
// admin connection, so nothing in the pipeline could see it.
// ---------------------------------------------------------------------------

test('a superuser admin may run the migration as the application role', () => {
  const verdict = assessMigrationRole({
    adminRole: 'deployadmin',
    appRole: 'imsapp',
    adminIsSuperuser: true,
    adminCanSetAppRole: false,
  })
  assert.equal(verdict.usable, true)
})

test('a non-superuser admin may only do it if it is a member of the application role', () => {
  const member = assessMigrationRole({
    adminRole: 'owneradmin',
    appRole: 'imsapp',
    adminIsSuperuser: false,
    adminCanSetAppRole: true,
  })
  assert.equal(member.usable, true)

  const stranger = assessMigrationRole({
    adminRole: 'owneradmin',
    appRole: 'imsapp',
    adminIsSuperuser: false,
    adminCanSetAppRole: false,
  })
  assert.equal(stranger.usable, false, 'otherwise the migration would create objects owned by the admin')
  assert.match(stranger.reason, /permission denied/, 'and the refusal must name the symptom the operator would otherwise see')
  assert.match(stranger.reason, /GRANT imsapp TO owneradmin/, 'and the statement that fixes it')
})

test('a connection string with no role has nothing to run the migration as', () => {
  const verdict = assessMigrationRole({
    adminRole: 'deployadmin',
    appRole: '',
    adminIsSuperuser: true,
    adminCanSetAppRole: true,
  })
  assert.equal(verdict.usable, false)
})

test('the migration URL authenticates as the admin and runs as the application role', () => {
  const url = buildMigrationConnectionString('postgresql://deployadmin:pw@127.0.0.1:5432/ims', 'imsapp')
  const parsed = new URL(url)
  assert.equal(parsed.username, 'deployadmin', 'authentication stays the admin, which is what keeps the fence effective')
  assert.equal(parsed.pathname, '/ims')
  assert.equal(parsed.searchParams.get('options'), '-c role=imsapp', 'and the session runs as the application role')
})

test('the migration URL preserves the parameters already on the admin connection', () => {
  const url = buildMigrationConnectionString(
    'postgresql://deployadmin@h/ims?schema=public&options=-c%20statement_timeout%3D0',
    'imsapp',
  )
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('schema'), 'public')
  assert.equal(
    parsed.searchParams.get('options'),
    '-c statement_timeout=0 -c role=imsapp',
    'an existing options value is appended to, not overwritten',
  )
})

test('a space in a role name is escaped for libpq rather than splitting the options value', () => {
  // libpq splits `options` on whitespace, so an unescaped space would make `role=ims` and a
  // stray argument. And the value is percent-encoded, not form-encoded: `+` is not a space here.
  const url = buildMigrationConnectionString('postgresql://admin@h/ims', 'ims app')
  assert.ok(url.includes('options=-c%20role%3Dims%5C%20app'), url)
  assert.ok(!url.includes('+'), 'a form-encoded space would reach Postgres as a literal plus')
  assert.equal(new URL(url).searchParams.get('options'), '-c role=ims\\ app')
})

// o3d-2sm1.5 (Codex r5, MEDIUM) — THE FALLBACK REACHED THE CRITICAL THROUGH THE FIX.
//
// This used to assert that unparseable input came back UNCHANGED, which is a connection with
// no `role=` on it at all: the migration then ran as the ADMIN, creating objects the
// application cannot use, while the deploy log announced the application role. Silently
// correct-looking, and exactly the defect the `-c role=` mechanism exists to close.
test('an admin connection string that cannot be parsed is refused, not returned unchanged', () => {
  assert.throws(
    () => buildMigrationConnectionString('not a url', 'imsapp'),
    /cannot be parsed as a URL/,
    'returning it unchanged runs the migration as the admin while claiming otherwise',
  )
  assert.throws(() => buildMigrationConnectionString('', 'imsapp'), /No admin connection string/)
  assert.throws(() => buildMigrationConnectionString('postgresql://admin@h/ims', ''), /No application role/)
})

test('a role name carrying a tab or a newline is refused, because libpq splits options on those too', () => {
  // The escape covered `\`, space and `'`. libpq's option parser treats tab, newline, carriage
  // return, form feed and vertical tab as separators exactly as it treats a space, so `role=`
  // would be silently truncated and the migration would run as the admin.
  for (const whitespace of ['\t', '\n', '\r', '\f', '\v']) {
    assert.throws(
      () => buildMigrationConnectionString('postgresql://admin@h/ims', `ims${whitespace}app`),
      /contains whitespace that libpq/,
      `a role name containing ${JSON.stringify(whitespace)} must be refused, not escaped-and-hoped`,
    )
  }
  // A plain space is still escaped rather than refused: it is the one libpq's backslash
  // escape is documented to cover, and the assertion above it proves it round-trips.
  assert.equal(
    new URL(buildMigrationConnectionString('postgresql://admin@h/ims', 'ims app')).searchParams.get('options'),
    '-c role=ims\\ app',
  )
})

test('--print-migration-url exits non-zero rather than printing a URL with no role on it', () => {
  const result = runFenceScript(['--print-migration-url', '--app-role=imsapp'], {
    DEPLOY_ADMIN_DATABASE_URL: 'this is not a url',
    DATABASE_URL: 'postgresql://imsapp@127.0.0.1:5432/ims',
    DIRECT_URL: '',
  })
  assert.notEqual(result.status, 0, 'a URL the migration cannot run as the app role through is not a URL to emit')
  assert.match(result.output, /cannot be parsed as a URL/)
  assert.ok(!/^this is not a url$/m.test(result.output), 'and the unusable string must not be printed as if it were the answer')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r4, HIGH) — AN EMPTY FIRST READ SKIPPED THE DRAIN ENTIRELY.
//
// The terminate ran only if the FIRST read of pg_stat_activity found something, and the settle
// loop was skipped when it did not — so a single sample taken microseconds after the revoke
// committed was the whole proof that the room was empty. A backend that was mid-authentication
// when the revoke landed is not in pg_stat_activity yet and is attached a moment later.
//
// Structural, deliberately: the shape of the guard is the defect, and asserting it needs a live
// server that can race the revoke. What it asserts is that the terminate has NO length guard and
// that a read follows the loop.
// ---------------------------------------------------------------------------

test('the drain terminates unconditionally and confirms with a second read', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  const doFence = source.slice(source.indexOf('async function doFence('), source.indexOf('async function doRelease('))

  const terminate = doFence.indexOf('pg_terminate_backend')
  assert.notEqual(terminate, -1, 'the fence must drain what is already attached')

  // Nothing between the start of the drain section and the terminate may make it conditional
  // on a prior read having found backends.
  const beforeTerminate = doFence.slice(doFence.lastIndexOf('const deadline', terminate), terminate)
  assert.ok(
    !/if \(remaining\.length > 0\)/.test(beforeTerminate),
    'the terminate must not be skipped because one sample happened to be empty',
  )

  const afterLoop = doFence.slice(doFence.lastIndexOf('while (remaining.length > 0'))
  assert.match(
    afterLoop,
    /if \(remaining\.length === 0\)[\s\S]{0,200}otherClientBackends/,
    'and an empty result must be confirmed by a second read after a settle, not accepted first time',
  )
})

test('the fence refuses to call a database drained while anything is still attached', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  const doFence = source.slice(source.indexOf('async function doFence('), source.indexOf('async function doRelease('))
  assert.match(doFence, /Refusing to call the database drained/)
  // EXIT_FENCE_STANDING, not EXIT_ERROR: the revokes are committed by the time this is reached,
  // and the callers' sticky flag has to be able to tell that from a fence that revoked nothing
  // (o3d-2sm1.5, Codex r13 HIGH).
  assert.match(doFence, /return EXIT_FENCE_STANDING/)
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r11) — A DURABLE REVOKE MUST NOT OUTLIVE ITS ONLY RECOVERY RECORD.
//
//   HIGH  writeState() was a plain writeFileSync — no atomic replacement, no flush — and its
//         return was what permitted the PostgreSQL REVOKE transaction to commit. The
//         asymmetry is the whole finding: the REVOKE is committed and survives a power cut;
//         the file that undoes it does not. On recovery readState() returned null, `--release`
//         printed "nothing to release" and exited 0, while the application and every other
//         recorded grantee stayed locked out of the database.
//
// Two halves, and both are tested below: the record is published durably BEFORE BEGIN and a
// publication that cannot be proven aborts without revoking; and `--release` no longer reads
// a missing record as a proof that no fence is standing — it asks the database, which is
// where the durable half lives.
//
// The failure injection is real syscalls, not a mock: a state directory at mode 0500 fails
// the temporary's creation (BEFORE the rename, nothing visible), and one at mode 0300 lets
// the create, the write, the fsync and the RENAME all succeed and fails only the opening of
// the directory for the post-rename flush. Each test says which of the two it uses.
// ---------------------------------------------------------------------------

/** Directory permissions that fail publication on the PRE-RENAME side: no entry can be created. */
const NO_WRITE = 0o500
/**
 * Directory permissions that fail publication on the POST-RENAME side: write and traverse are
 * allowed, so the temporary is created, written, flushed and RENAMED into place; only opening
 * the directory to flush the entry the rename created is refused. At that instant the new
 * record is complete and readable at the authoritative path and its name is not proven
 * durable — the exact state a read-back cannot distinguish and a power loss undoes.
 */
const NO_READ = 0o300

/**
 * A throwaway state directory THAT IS REMOVED AGAIN (o3d-2sm1.5).
 *
 * It used to be a bare `mkdtempSync` with no removal anywhere, and twenty-four tests call it —
 * so one `npm run test:unit` left twenty-four directories under /tmp and the count only ever went
 * up. `t.after` runs whether the test passed or threw, and it runs at the END OF THAT TEST, so
 * this file holds one directory at a time rather than twenty-four. Taking the TestContext is what
 * makes that possible, which is why every caller now threads it.
 */
function stateDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ims-fence-state-'))
  // Never fail a test on its own tidy-up: a test that threw has already said something more
  // useful than an EBUSY from the removal.
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ } })
  return dir
}

/**
 * THE PRIVILEGED PUBLISHER, LIFTED OUT OF THE SHIPPED LIBRARY (o3d-secops r23).
 *
 * The helper has no writer for the authority record any more — that is the round's whole point —
 * so every fixture below that needs a VALID record is published by the same program root
 * publishes with, read out of scripts/lib/db-fence-protected.sh rather than re-implemented. A rig
 * that wrote its own would be proving that its author can write a JSON file, and the three
 * durability tests over it would be measuring the rig.
 */
const FENCE_LIBRARY = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
/** The cutover namespace library, for the one predicate the fence library reaches back for. */
const CUTOVER_NS_LIB_SOURCE = readFileSync(join(process.cwd(), 'scripts/lib/cutover-namespace.sh'), 'utf8')

/**
 * THE NAMES db_fence_authorise_plan() COMPOSES ITS FOURTH ARGUMENT FROM (o3d-secops r26).
 *
 * That argument is DISPLAY TEXT — the path of the resolution wrapper, printed in the refusal an
 * unstamped record produces and never executed — but the harnesses below lift ONE function at a
 * time rather than sourcing the library, and under `set -u` an unset name aborts the function
 * before it reaches `node`. So the declarations are carried, LIFTED FROM THE SHIPPED LINES rather
 * than typed here: a harness that invented a path would be exercising a message the library does
 * not print.
 *
 * ${DB_FENCE_SUDO_PREFIX} is the one that is not `readonly` and not a path — it is resolved from
 * PATH at load time — so it is declared empty, which is what the library leaves it as on a box
 * with no sudo.
 */
const FENCE_DISPLAY_DECLARATIONS = (() => {
  const lines = FENCE_LIBRARY.split('\n')
  const lifted = ['DB_FENCE_RECOVERY_DIR', 'DB_FENCE_RESOLVE_WRAPPER'].map((name) => {
    const declaration = lines.find((line) => line.startsWith(`readonly ${name}=`))
    assert.ok(declaration, `the shipped library must declare ${name} once, as a readonly`)
    return declaration.replace(/^readonly /, '')
  })
  return ["DB_FENCE_SUDO_PREFIX=''", ...lifted].join('\n')
})()
const AUTHORISE_PLAN_PROGRAM = (() => {
  // Read out of the library's own text between the heredoc markers. `shellFunction` would answer
  // for the function, and what is wanted is the PROGRAM the function emits — the same bytes
  // `node -e` is handed, so that a test over it is a test over what root runs.
  const opener = "  cat <<'AUTHORISE_PLAN_EOF'\n"
  const from = FENCE_LIBRARY.indexOf(opener)
  assert.notEqual(from, -1, 'the shipped library must emit the plan validator from one heredoc')
  const to = FENCE_LIBRARY.indexOf('\nAUTHORISE_PLAN_EOF\n', from)
  assert.notEqual(to, -1, 'and that heredoc must be terminated')
  return FENCE_LIBRARY.slice(from + opener.length, to + 1)
})()

/**
 * THE APPLIED STAMP, LIFTED THE SAME WAY (o3d-secops r25).
 *
 * A published authority and a STANDING fence are two different things now, and the difference is
 * this program's one write. Fixtures below that mean "a fence is standing" must therefore run it,
 * for the same reason they publish through the shipped validator rather than writing JSON: a rig
 * that stamped the field itself would be proving that its author can set a key.
 */
const MARK_APPLIED_PROGRAM = (() => {
  const opener = "  cat <<'MARK_APPLIED_EOF'\n"
  const from = FENCE_LIBRARY.indexOf(opener)
  assert.notEqual(from, -1, 'the shipped library must emit the applied stamp from one heredoc')
  const to = FENCE_LIBRARY.indexOf('\nMARK_APPLIED_EOF\n', from)
  assert.notEqual(to, -1, 'and that heredoc must be terminated')
  return FENCE_LIBRARY.slice(from + opener.length, to + 1)
})()

/** Run the shipped validator over `plan`, exactly as root does. Returns its exit status. */
function authorisePlan(plan: unknown, destination: string, database: string, appRole: string) {
  const run = spawnSync('node', ['-e', AUTHORISE_PLAN_PROGRAM, '--', database, appRole, destination], {
    input: `${JSON.stringify(plan)}\n`,
    encoding: 'utf8',
  })
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` }
}

/** Run the shipped applied stamp over `destination`, exactly as root does after a `--fence`. */
function markApplied(destination: string) {
  const run = spawnSync('node', ['-e', MARK_APPLIED_PROGRAM, '--', destination], { encoding: 'utf8' })
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` }
}

/** Publish a valid authority at `stateFile`, through the shipped validator, or throw. */
function publishAuthority(stateFile: string, state: Record<string, unknown> = SAMPLE_STATE) {
  const run = authorisePlan(state, stateFile, String(state.database), String(state.app_role))
  assert.equal(run.status, 0, `the fixture must publish through the shipped validator:\n${run.output}`)
}

/**
 * The record a fence that ACTUALLY STOOD leaves: published by root, and then stamped applied by
 * root once `--fence` reported the REVOKEs were (or might be) on the medium. This is what buys the
 * recovery rule; publishAuthority() alone no longer does, which is the whole of o3d-secops r25.
 */
function publishStandingAuthority(stateFile: string, state: Record<string, unknown> = SAMPLE_STATE) {
  publishAuthority(stateFile, state)
  const run = markApplied(stateFile)
  assert.equal(run.status, 0, `the fixture must be stamped applied through the shipped stamp:\n${run.output}`)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_applied, 1,
    'and a "standing fence" fixture that is not stamped applied is measuring the wrong thing')
}

const SAMPLE_STATE = {
  database: 'imsdb',
  owner_role: 'owner',
  app_role: 'imsapp',
  admin_role: 'deployadmin',
  revoked: ['PUBLIC', 'imsapp'],
  datacl_before: '{owner=CTc/owner,=Tc/owner,imsapp=c/owner}',
  fenced_at: '2026-08-27T00:00:00.000Z',
  undo_sql: ['GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;', 'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";'],
}

/**
 * The admin connection, faked at the wire. doFence() and doRelease() are driven for real over
 * it, so what is asserted is the ORDER of the shipped code's own effects: whether a REVOKE
 * ever reached the database, and what was on disk when it did.
 */
class FakeAdminClient {
  log: string[] = []
  fileAtBegin: string | null = null
  constructor(
    private readonly options: {
      stateFile?: string
      stillConnectsBefore?: boolean
      stillConnectsAfter?: boolean
      /** aclexplode()'s rows, as DATACL_PRIVILEGES_SQL returns them; see aclRows(). */
      datacl?: ReturnType<typeof aclRows> | null
      releasedDatacl?: ReturnType<typeof aclRows> | null
      /**
       * The ACL --release reads BEFORE its first GRANT (o3d-secops r29, Codex HIGH 2): is the
       * fence this record describes actually standing on the server that answered?
       *
       * IT DEFAULTS TO THE FENCED ACL because that is what a release is FOR -- every existing
       * release test in this file drives a record whose grantees have lost CONNECT, and a default
       * that said otherwise would be describing a different scenario from the one those tests
       * were written about. A test that wants the clone reading passes ACL_UNFENCED here.
       */
      standingDatacl?: ReturnType<typeof aclRows> | null
      /**
       * pg_control_system().system_identifier, and pg_database.oid (o3d-secops r28). The cluster
       * fingerprint: what a record carries and what the audit compares it with. `''` is a server
       * that would not say -- which is what an installation that has not granted EXECUTE on
       * pg_control_system() gives back, and is never treated as a match.
       */
      systemIdentifier?: string
      databaseOid?: string
      /** pg_control_system() refused: the server's own message, not a value. */
      systemIdentifierError?: string
      connectedDatabase?: string
      /** pg_postmaster_start_time() — the stamp that says WHICH CLUSTER this is (o3d-2sm1.5 r19). */
      postmaster?: string
      /** session_user — what this connection logged in as. */
      loginRole?: string
      /** current_user — what it is running as, which a SET ROLE can move away from the login role. */
      effectiveRole?: string
      attached?: { pid: number; application_name: string; usename: string }[]
      throwAfterCommit?: string
      /** COMMIT reaches the server and its acknowledgement never comes back. */
      failCommitAck?: string
      /**
       * ONE statement fails, and every other one is served normally (o3d-secops r30, Codex
       * MEDIUM). What a release killed between two GRANTs looks like from the wire: the point is
       * what the shipped code does NEXT, so the failure has to land mid-loop rather than at the
       * connection.
       */
      failStatement?: string
    } = {},
  ) {}

  private connectAsks = 0

  async query(text: string) {
    const sql = String(text).trim()
    this.log.push(sql)
    if (this.options.failStatement && sql === this.options.failStatement) {
      throw new Error(`the server went away before ${sql}`)
    }
    if (sql === 'COMMIT' && this.options.failCommitAck) {
      // THE COMMIT IS ON THE WIRE AND THE ANSWER NEVER ARRIVES. The revokes above are logged, so
      // the assertion can prove they were sent; what the caller never learns is whether they took.
      throw new Error(this.options.failCommitAck)
    }
    if (sql === 'BEGIN' && this.options.stateFile) {
      // The instant that matters: what the medium had been asked to hold before the
      // transaction that makes it necessary was even opened.
      this.fileAtBegin = existsSync(this.options.stateFile) ? readFileSync(this.options.stateFile, 'utf8') : null
    }
    if (sql.includes('AS database')) {
      return {
        rows: [
          {
            database: 'imsdb',
            postmaster: this.options.postmaster ?? '',
            admin_role: this.options.effectiveRole ?? 'deployadmin',
            admin_login_role: this.options.loginRole ?? 'deployadmin',
            owner_role: 'owner',
            datacl: '{owner=CTc/owner,=Tc/owner,imsapp=c/owner}',
            datacl_privileges: this.options.datacl ?? ACL_UNFENCED,
            database_oid: this.options.databaseOid ?? '16400',
            server_addr: '',
            server_port: '',
            admin_is_superuser: true,
            app_role_is_superuser: false,
            app_role_exists: 1,
            admin_can_set_app_role: true,
          },
        ],
      }
    }
    if (sql.includes('AS connected_database')) {
      return {
        rows: [
          {
            connected_database: this.options.connectedDatabase ?? 'imsdb',
            connected_login_role: this.options.loginRole ?? 'deployadmin',
            connected_effective_role: this.options.effectiveRole ?? 'deployadmin',
            connected_postmaster: this.options.postmaster ?? '',
          },
        ],
      }
    }
    if (sql.includes('AS still_connects')) {
      this.connectAsks += 1
      // The second ask is the post-COMMIT one, which is where a failure has to be reported as a
      // fence that is STANDING rather than as one that never happened.
      if (this.connectAsks === 2 && this.options.throwAfterCommit) throw new Error(this.options.throwAfterCommit)
      const answer =
        this.connectAsks === 1 ? (this.options.stillConnectsBefore ?? true) : (this.options.stillConnectsAfter ?? false)
      return { rows: [{ still_connects: answer }] }
    }
    // o3d-secops r28: the cluster fingerprint's two halves, each asked in a query of its own so
    // that a server which refuses the first still answers everything else.
    if (sql.includes('FROM pg_catalog.pg_control_system()')) {
      if (this.options.systemIdentifierError) throw new Error(this.options.systemIdentifierError)
      return { rows: [{ system_identifier: this.options.systemIdentifier ?? '' }] }
    }
    if (sql.includes('AS released_database_oid')) {
      return { rows: [{ released_database_oid: this.options.databaseOid ?? '16400' }] }
    }
    if (sql.includes('FROM pg_roles r')) return { rows: [] }
    if (sql.includes('pg_terminate_backend')) return { rows: [] }
    if (sql.includes('FROM pg_stat_activity')) return { rows: this.options.attached ?? [] }
    // o3d-secops r26: the one read `--audit-authority` makes. Its aliases are its own, so this
    // branch cannot be reached by any other mode's question and vice versa.
    if (sql.includes('AS audited_database')) {
      // o3d-secops r27: the audit binds its own identity now, so it asks this connection the same
      // two-part role question every other mode asks — session_user and current_user — and the
      // values come from the SAME options the other branches read, so a test can land this
      // connection as the wrong role here exactly as it can there.
      //
      // AND THE FIXTURE ANSWERS THE QUERY THAT WAS ASKED, not a shape. A fake that returns every
      // column whichever ones the SELECT names cannot notice one being dropped — and these two are
      // precisely what the identity gate consumes, so a read that quietly stopped asking for them
      // would go on passing every test in this file. Each is supplied only if its alias appears.
      // AND EVERY COLUMN GOES THROUGH IT, NOT ONLY THE TWO ROLE ONES (o3d-secops r28, Codex
      // MEDIUM). r27 routed the role aliases through `asked()` and went on fabricating the
      // database, the owner and -- the load-bearing one -- the ACL, whatever the SELECT named. A
      // fixture that answers a SHAPE cannot notice a column being dropped, so deleting the ACL
      // from the audit's read would have left every test here operating on an ACL the fixture
      // invented. There is no column below that a mutation can remove without a test going red.
      const asked = <T>(alias: string, value: T) => (sql.includes(`AS ${alias}`) ? { [alias]: value } : {})
      return {
        rows: [
          {
            ...asked('audited_database', this.options.connectedDatabase ?? 'imsdb'),
            ...asked('audited_login_role', this.options.loginRole ?? 'deployadmin'),
            ...asked('audited_effective_role', this.options.effectiveRole ?? 'deployadmin'),
            ...asked('audited_owner_role', 'owner'),
            ...asked('audited_datacl_privileges', this.options.datacl === undefined ? ACL_UNFENCED : this.options.datacl),
            ...asked('audited_database_oid', this.options.databaseOid ?? '16400'),
          },
        ],
      }
    }
    // o3d-secops r29: --release's PRE-GRANT read, on an alias of its own so that it cannot be
    // answered by the post-grant verification's branch below and vice versa. It is answered here
    // rather than left to fall through to `{ rows: [] }`, because a fixture that returns nothing
    // would make the gate that consumes it read "no grantee holds CONNECT" whatever the test set
    // up -- the fence would look standing in every test in this file, including the ones written
    // to prove it is not.
    if (sql.includes('AS standing_fence_privileges')) {
      return { rows: [{ standing_fence_privileges: this.options.standingDatacl === undefined ? ACL_FENCED : this.options.standingDatacl }] }
    }
    if (sql.includes('FROM pg_database d WHERE d.datname = $1')) {
      return { rows: [{ datacl_privileges: this.options.releasedDatacl ?? null, owner_role: 'owner' }] }
    }
    return { rows: [] }
  }

  get revokes() {
    return this.log.filter((sql) => sql.startsWith('REVOKE'))
  }

  get grants() {
    return this.log.filter((sql) => sql.startsWith('GRANT'))
  }
}

/** doFence() only ever fences over an explicit admin URL; give it one and put the env back. */
async function withAdminUrl<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  process.env.DEPLOY_ADMIN_DATABASE_URL = 'postgres://deployadmin@localhost/imsdb'
  // THE APPLICATION'S OWN URL, naming the same database (o3d-2sm1.5, Codex r13 CRITICAL). Every
  // mode now refuses unless the connection it opened can be SHOWN to be the application's
  // database, and the admin URL alone cannot show that. It used to be deleted here.
  process.env.DATABASE_URL = 'postgres://imsapp@localhost/imsdb'
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previous
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
}

test('the fence record is published atomically and ends with the completeness sentinel', (t) => {
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, SAMPLE_STATE)

    const body = readFileSync(stateFile, 'utf8')
    const keys = Object.keys(JSON.parse(body))
    assert.equal(
      keys[keys.length - 1],
      'state_complete',
      `the sentinel must be written LAST, or it proves nothing about the fields above it:\n${body}`,
    )
    assert.deepEqual(readdirSync(dir), ['db-connect-fence.json'], 'and no temporary may be left behind')

    const read = readState(stateFile)
    assert.equal(read.status, STATE_PRESENT)
    assert.deepEqual(read.state.revoked, ['PUBLIC', 'imsapp'], 'and it must round-trip what a release needs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readState tells a missing record apart from one that exists and cannot be used', (t) => {
  const dir = stateDir(t)
  try {
    const missing = join(dir, 'absent.json')
    assert.equal(readState(missing).status, STATE_ABSENT, 'nothing at the path is ABSENT, which proves nothing on its own')

    const torn = join(dir, 'torn.json')
    writeFileSync(torn, '{\n  "database": "imsdb",\n  "revoked": [\n    "PUB')
    assert.equal(readState(torn).status, STATE_CORRUPT, 'a truncated record is CORRUPT, not "no fence"')

    // The case the sentinel exists for: valid JSON, plausible shape, and no proof it is whole.
    const sentinelless = join(dir, 'no-sentinel.json')
    writeFileSync(sentinelless, JSON.stringify(SAMPLE_STATE))
    const read = readState(sentinelless)
    assert.equal(read.status, STATE_CORRUPT, 'a record with no completeness sentinel is CORRUPT')
    assert.match(read.detail ?? '', /sentinel/, 'and says why')

    const unreadable = join(dir, 'unreadable.json')
    writeFileSync(unreadable, JSON.stringify({ ...SAMPLE_STATE, state_complete: 1 }))
    chmodSync(unreadable, 0o000)
    assert.equal(
      readState(unreadable).status,
      process.getuid?.() === 0 ? STATE_PRESENT : STATE_UNREADABLE,
      'a record that cannot be opened is UNREADABLE, not "no fence"',
    )

    assert.equal(classifyStateShape({ state_complete: 1, database: 'imsdb', revoked: ['PUBLIC'] }), '')
    assert.match(classifyStateShape({ state_complete: 1, database: 'imsdb', revoked: [7] }), /grantees/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a publish that fails BEFORE the rename leaves the previous record byte for byte', (t) => {
  // FAILURE INJECTED ON THE PRE-RENAME SIDE: the directory refuses new entries, so the
  // temporary is never created and nothing is renamed. The last durable record must survive
  // exactly — the old writeFileSync would have truncated it in place at this instant.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, SAMPLE_STATE)
    const before = readFileSync(stateFile, 'utf8')

    chmodSync(dir, NO_WRITE)
    assert.throws(
      () => publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['something else entirely'] }),
      /EACCES|EPERM/,
      'a publication that cannot create its temporary must throw, not return quietly',
    )
    chmodSync(dir, 0o700)

    assert.equal(readFileSync(stateFile, 'utf8'), before, 'and the last durable record must be untouched')
    assert.deepEqual(readdirSync(dir), ['db-connect-fence.json'], 'with no temporary left behind')
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a publish whose POST-RENAME barrier fails throws, though the record is already visible', (t) => {
  // FAILURE INJECTED ON THE POST-RENAME SIDE: create, write, fsync and rename all succeed;
  // only the flush of the directory entry the rename created is refused. Any caller that read
  // the file back here would be satisfied. Only the throw tells the truth.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    chmodSync(dir, NO_READ)
    assert.throws(() => publishAuthority(stateFile, SAMPLE_STATE), /EACCES|EPERM/, 'an unprovable name must throw')
    chmodSync(dir, 0o700)

    // THE PRECONDITION, PROVED RATHER THAN ASSUMED: without it this could pass for a failure
    // on the other side of the barrier, where there is nothing to read back at all.
    const body = readFileSync(stateFile, 'utf8')
    assert.match(body, /"state_complete": 1/, 'the rename must have published the COMPLETE record before the throw')
    assert.deepEqual(JSON.parse(body).revoked, ['PUBLIC', 'imsapp'], 'and it must be the new content, fully readable')
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fence refuses to revoke when its record cannot be created at all', async (t) => {
  // PRE-RENAME side. Nothing is on disk and nothing may be revoked: a REVOKE is committed and
  // survives, so it must never outrun the record that undoes it.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    chmodSync(dir, NO_WRITE)
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
    chmodSync(dir, 0o700)

    assert.equal(code, EXIT_NOT_FENCEABLE, 'an unrecordable fence is NOT a fence')
    assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked')
    assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
    assert.equal(existsSync(stateFile), false, 'and no record may be left claiming a fence that was never applied')
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fence executes an authority it did not write, and revokes exactly what it names', async (t) => {
  // o3d-secops r23, Codex CRITICAL. THE PUBLICATION LEFT THIS PROCESS. It runs as ${APP_USER}, so
  // a record it can publish is a record that account can publish — and the record is what a later
  // `--release` builds `GRANT CONNECT` out of. Root publishes it (db_fence_authorise_plan, above),
  // and what is left here is an executor.
  //
  // The ordering property is unchanged and is now the SHELL's: db_fence_raise() publishes durably
  // and only then invokes `--fence`. What this test holds is the other half of it — that the
  // transaction revokes exactly the grantee list the authority names, and nothing derived here.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
  const client = new FakeAdminClient({ stateFile })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

  assert.equal(code, EXIT_OK, 'the happy path must still fence')
  assert.ok(client.fileAtBegin !== null, 'the record must exist before BEGIN, not after COMMIT')
  const atBegin = JSON.parse(client.fileAtBegin as string)
  assert.equal(atBegin.state_complete, 1, 'and be complete before BEGIN')
  assert.deepEqual(
    client.revokes,
    [
      'REVOKE CONNECT ON DATABASE "imsdb" FROM PUBLIC;',
      'REVOKE CONNECT ON DATABASE "imsdb" FROM "owner";',
      'REVOKE CONNECT ON DATABASE "imsdb" FROM "imsapp";',
    ],
    'and the transaction must revoke exactly what the AUTHORITY names',
  )
  // AND THE HELPER WROTE NOTHING. The record it acted on is byte-for-byte the one root published.
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fenced_at, SAMPLE_STATE.fenced_at,
    'the executor must not have republished the record it was given')
})

test('the fence refuses when nothing privileged has recorded what it would revoke', async (t) => {
  // THE REFUSAL THAT KEEPS THE OLD ASYMMETRY CLOSED (o3d-secops r23). A REVOKE is a committed
  // transaction that survives a power cut and the record is the only thing that undoes it. Once
  // this process stopped being the record's author, "no record" stopped being "start a fresh
  // fence" and became "nothing has authorised this".
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): delete the
  // `if (!existing)` arm from doFence() and the fence proceeds with `existing.revoked` undefined —
  // the run throws inside buildRevokeStatements() instead of refusing, and the caller's exit code
  // stops distinguishing "nothing was revoked" from "the revokes may be standing".
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const client = new FakeAdminClient({ stateFile })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

  assert.equal(code, EXIT_NOT_FENCEABLE, 'an unauthorised fence is NOT a fence')
  assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked')
  assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
  assert.equal(existsSync(stateFile), false, 'and this process may not write the record it was missing')
})

test('a grantee that appeared since the authority was published is refused, not revoked', async (t) => {
  // The append path, inverted by r23. This process used to APPEND to the record and carry on,
  // which it could do because it was the record's author. It is not, so a grantee the authority
  // does not name is a REFUSAL: revoking it would take CONNECT from a role nothing would restore.
  // A re-run re-plans and re-publishes, which is a whole-run cost and not a silent divergence.
  //
  // MUTATION ROUTE: delete the `appeared.length > 0` arm from doFence() and the run revokes from
  // `owner` — a role the record does not list — so `--release` afterwards leaves it locked out.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC'] })
  const before = readFileSync(stateFile, 'utf8')
  const client = new FakeAdminClient({ stateFile })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

  assert.equal(code, EXIT_NOT_FENCEABLE, 'a fence wider than its authority must abort')
  assert.deepEqual(client.revokes, [], 'and the newly appeared grantees must NOT be revoked')
  assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
  assert.equal(readFileSync(stateFile, 'utf8'), before, 'and the authority must be untouched by this process')
})

test('assessAuthorityDrift reports both set differences, and each mode says what it accepts', () => {
  // o3d-secops r24, Codex HIGH. THE RULES, READ AS RULES. doFence() decides only what to print;
  // what is acceptable is here, so that "checking for additions is not checking for equality" is a
  // statement about a function rather than about a branch of one that also opens transactions.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): drop `withdrawn` from the
  // `accepted` expression — which is r23's rule exactly — and the second case below reports an
  // initial fence over a stale authority as acceptable.
  const same = assessAuthorityDrift({ authorised: ['PUBLIC', 'imsapp'], current: ['imsapp', 'PUBLIC'], mode: FENCE_MODE_INITIAL })
  assert.deepEqual([same.appeared, same.withdrawn], [[], []], 'order is not a difference')
  assert.equal(same.accepted, true, 'an initial fence over an ACL that has not moved must proceed, or nothing ever fences')

  const lost = { authorised: ['PUBLIC', 'imsapp', 'analytics'], current: ['PUBLIC', 'imsapp'] }
  const lostInitial = assessAuthorityDrift({ ...lost, mode: FENCE_MODE_INITIAL })
  assert.deepEqual(lostInitial.withdrawn, ['analytics'], 'the OTHER direction of the difference is reported')
  assert.deepEqual(lostInitial.appeared, [], 'and it is invisible to the direction r23 asked about')
  assert.equal(lostInitial.accepted, false,
    'a role that lost CONNECT under an INITIAL authority is drift: the release would grant it back to somebody who removed it')

  const lostRecovery = assessAuthorityDrift({ ...lost, mode: FENCE_MODE_RECOVERY })
  assert.deepEqual(lostRecovery.withdrawn, ['analytics'], 'a recovery re-fence sees the same difference')
  assert.equal(lostRecovery.accepted, true,
    'and accepts it, because a standing fence is what took CONNECT from its own recorded grantees')

  // `appeared` IS FATAL IN BOTH MODES. Revoking a role no record names takes CONNECT from
  // something nothing would restore, and that is true however the fence came to be raised.
  const gained = { authorised: ['PUBLIC'], current: ['PUBLIC', 'analytics'] }
  for (const mode of [FENCE_MODE_INITIAL, FENCE_MODE_RECOVERY]) {
    const drift = assessAuthorityDrift({ ...gained, mode })
    assert.deepEqual(drift.appeared, ['analytics'], `${mode}: a new grantee is reported`)
    assert.equal(drift.accepted, false, `${mode}: and refused`)
  }

  // AN UNRECOGNISED MODE IS THE STRICT RULE, AND r26 REVERSED r24 TO GET HERE (Codex HIGH).
  //
  // r24 asserted the opposite of the first line below: a record with no `fence_mode` resolved to
  // RECOVERY, on the argument that it could only be a fence raised before that field existed and
  // therefore standing. The predecessor published its record BEFORE running the fence, so a record
  // of that vintage is equally what a publication killed before `BEGIN` left — the reading dates
  // the writer and not the fence. `recovery` is the rule with the privilege in it (it accepts
  // recorded grantees missing from the ACL, and `--release` then GRANTs CONNECT back to them), so
  // it is given only to a record that actually says `recovery`.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): put the comparison back the way
  // r24 had it — `record.fence_mode === FENCE_MODE_INITIAL ? INITIAL : RECOVERY` — and the first
  // and third lines below both report `recovery`.
  assert.equal(authorityFenceMode({ revoked: ['PUBLIC'] }), FENCE_MODE_INITIAL,
    'a record carrying no mode at all cannot show a fence stands, so it gets the rule that assumes none does')
  assert.equal(authorityFenceMode({ fence_mode: FENCE_MODE_RECOVERY }), FENCE_MODE_RECOVERY)
  assert.equal(authorityFenceMode({ fence_mode: FENCE_MODE_INITIAL }), FENCE_MODE_INITIAL)
  // AND A RECORD CANNOT TALK ITS WAY INTO THE LAX RULE BY MISSPELLING IT EITHER.
  assert.equal(authorityFenceMode({ fence_mode: 'RECOVERY' }), FENCE_MODE_INITIAL)
  assert.equal(authorityFenceMode(null), FENCE_MODE_INITIAL)

  // AND assessAuthorityDrift() RESOLVES THE UNKNOWN THE SAME WAY, since it is the function that
  // acts on the mode: a caller that passed nothing must not be handed the tolerance.
  const unknownMode = assessAuthorityDrift({ ...lost, mode: undefined })
  assert.equal(unknownMode.mode, FENCE_MODE_INITIAL, 'an unrecognised mode resolves strict')
  assert.equal(unknownMode.accepted, false, 'and a withdrawn grantee under it is drift, not a standing fence')
})

test('a grantee REMOVED between the plan and an initial fence aborts it (o3d-secops r24)', async (t) => {
  // THE FINDING. r23 asked one direction of the set difference — had a grantee APPEARED? — and read
  // "nothing appeared" as "the authority still describes the ACL". A role that LOSES CONNECT in the
  // window leaves that comparison empty: the stale list was accepted whole, its REVOKE was a no-op
  // nobody noticed, and `--release` afterwards issued GRANT CONNECT to every role the record named,
  // handing database access back to one an administrator had deliberately removed.
  //
  // ROUTE: the shipped doFence() over an authority root published as INITIAL — that is what it
  // stamps when nothing is at the destination — naming a grantee the live ACL does not carry.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): drop `withdrawn` from
  // assessAuthorityDrift()'s `accepted`, which is r23's rule, and this fence proceeds — it commits
  // three REVOKEs including the no-op for `analytics`, and returns 0.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp', 'analytics'] })
  const published = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(published.fence_mode, FENCE_MODE_INITIAL,
    'the fixture must be an INITIAL authority, or this measures the recovery rule by accident')
  const before = readFileSync(stateFile, 'utf8')

  // The live ACL carries PUBLIC, owner and imsapp and has never carried `analytics`: somebody took
  // CONNECT from it between the plan and now.
  const client = new FakeAdminClient({ stateFile })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

  assert.equal(code, EXIT_NOT_FENCEABLE, 'a fence whose authority no longer describes the ACL must abort')
  assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked')
  assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
  assert.equal(readFileSync(stateFile, 'utf8'), before, 'and the authority must be untouched by this process')

  // AND THE HARM IT AVERTS, EXHIBITED RATHER THAN DESCRIBED: had the fence gone ahead, the record
  // would have been the standing authority and the release builds GRANT CONNECT straight out of it
  // — including for the role somebody had just removed.
  // o3d-secops r30: `standingDatacl` is stated here rather than defaulted. The default is
  // ACL_FENCED, which leaves the OWNER holding CONNECT -- and `owner` is in this record's list, so
  // the pre-grant reading would be MIXED, which r30 refuses (Codex HIGH 2). This fixture is about
  // a stale record being granted back in full, so it states the ACL a standing fence over THIS
  // list leaves: not one of the four holds CONNECT.
  const releasing = new FakeAdminClient({ stateFile, releasedDatacl: ACL_UNFENCED, standingDatacl: aclRows([['other', 'c']]) })
  await withAdminUrl(() => doRelease(releasing as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.ok(releasing.grants.includes('GRANT CONNECT ON DATABASE "imsdb" TO "analytics";'),
    `a release grants back everything the record names, which is why the record may not be stale:\n${releasing.grants.join(' | ')}`)
})

test('a recovery re-fence executes an authority whose grantees have already lost CONNECT', async (t) => {
  // THE OTHER HALF, WITHOUT WHICH THE FIX ABOVE IS A REGRESSION. A fence that is already standing
  // has taken CONNECT from every grantee its record names — its own earlier run did it — so on a
  // re-apply `withdrawn` is not drift, it is the expected shape, and a bare equality rule would
  // make a standing fence impossible to re-apply or release.
  //
  // ROUTE: a SECOND publication over an authority that has been STAMPED APPLIED. Root stamps
  // `recovery` because the record already there says a fence was applied behind it — a fact root
  // writes after the revoke and ${APP_USER} cannot forge, that directory being root-owned and
  // unwritable by anything else. Until o3d-secops r25 the fact asked for was merely that a file
  // existed, which is why publishAuthority() twice used to be enough here and is not any more.
  //
  // MUTATION ROUTE (made against the shipped file and reverted): make `accepted` a plain equality
  // in both modes and this test fails at EXIT_OK — a standing fence can then never be re-applied.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const record = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] }
  publishStandingAuthority(stateFile, record)
  publishAuthority(stateFile, record)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_mode, FENCE_MODE_RECOVERY,
    'a publication over a standing authority must be stamped as a recovery')

  // THE ACL OF A FENCED DATABASE: the owner keeps its own entry, and nobody else has CONNECT.
  const client = new FakeAdminClient({ stateFile, datacl: ACL_FENCED, stillConnectsBefore: false })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

  assert.equal(code, EXIT_OK, `a standing fence must still be re-applicable:\n${client.log.join(' | ')}`)
  assert.deepEqual(client.revokes, [
    'REVOKE CONNECT ON DATABASE "imsdb" FROM PUBLIC;',
    'REVOKE CONNECT ON DATABASE "imsdb" FROM "owner";',
    'REVOKE CONNECT ON DATABASE "imsdb" FROM "imsapp";',
  ], 'over the whole recorded list, so the release still restores all of it')

  // AND THE SAME RECORD UNDER THE INITIAL RULE IS REFUSED — which is what makes the mode, and not
  // the tolerance, the thing doing the work here.
  const strict = join(dir, 'strict.json')
  publishAuthority(strict, record)
  assert.equal(JSON.parse(readFileSync(strict, 'utf8')).fence_mode, FENCE_MODE_INITIAL)
  const strictClient = new FakeAdminClient({ stateFile: strict, datacl: ACL_FENCED, stillConnectsBefore: false })
  const strictCode = await withAdminUrl(() => doFence(strictClient as never, { stateFile: strict, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.equal(strictCode, EXIT_NOT_FENCEABLE, 'the identical grantee list under an INITIAL authority is drift')
  assert.deepEqual(strictClient.revokes, [], 'and revokes nothing')
})

test('the plan cannot choose which rule its record is executed under (o3d-secops r24)', (t) => {
  // `fence_mode` is the difference between the two rules, so it is the field worth forging: a plan
  // that could declare itself a recovery would buy the tolerance. It is computed by ROOT, in the
  // process that does the rename, from the presence of a file in a directory ${APP_USER} cannot
  // write — so that account can neither create a record to obtain the tolerance nor unlink one to
  // escape it — and one carried in the plan is dropped by the template like every other field root
  // does not compute for itself.
  //
  // MUTATION ROUTE (made against the shipped validator and reverted): take the field from the
  // request — `fence_mode: plan.fence_mode` — and the first case below publishes "recovery" over
  // an empty directory, which is the unprivileged account choosing its own rule.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')

  const asking = authorisePlan({ ...SAMPLE_STATE, fence_mode: FENCE_MODE_RECOVERY, fence_applied: 1 }, stateFile, 'imsdb', 'imsapp')
  assert.equal(asking.status, 0, `a plan carrying an extra field must still publish:\n${asking.output}`)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_mode, FENCE_MODE_INITIAL,
    'nothing was at the destination, so this is an initial fence whatever the request said')
  // AND THE FIELD THE MODE IS NOW COMPUTED FROM IS EQUALLY OUT OF THE PLAN'S REACH (o3d-secops
  // r25). `fence_applied` decides what the NEXT publication stamps, so a plan that could carry it
  // in as 1 would buy the recovery rule one run later — the same forgery, one step removed.
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_applied, 0,
    'the applied stamp is root\'s own and is written 0 whatever the request said')

  // AND THE CONVERSE: with a fence standing, a plan asking for the strict rule does not get it
  // either. The stamp answers to what root itself recorded and to nothing else. o3d-secops r25:
  // "standing" is the APPLIED stamp root writes after the revoke, so the fixture has to raise it.
  const stamped = markApplied(stateFile)
  assert.equal(stamped.status, 0, `the standing-fence fixture must be stamped applied:\n${stamped.output}`)
  const asserting = authorisePlan({ ...SAMPLE_STATE, fence_mode: FENCE_MODE_INITIAL, fence_applied: 1 }, stateFile, 'imsdb', 'imsapp')
  assert.equal(asserting.status, 0, asserting.output)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_mode, FENCE_MODE_RECOVERY,
    'an authority was already there, so this is a recovery whatever the request said')

  // AND IT IS ANNOUNCED, because an operator reading the publication line has to be able to tell
  // which of the two rules the fence about to run is being held to.
  assert.match(asserting.output, /\(recovery\)/, `the publication must name the mode:\n${asserting.output}`)
})

test('a refused INITIAL fence leaves no authority behind, and a standing one is left alone (o3d-secops r24)', (t) => {
  /**
   * WITHOUT THIS, ONE RE-RUN BUYS THE TOLERANCE THE REFUSAL WITHHELD.
   *
   * `fence_mode` is stamped from whether an authority is already at the destination. An initial
   * fence that is REFUSED leaves the record root published a moment earlier describing a fence that
   * does not exist — and the next cutover's `--plan` then reads it as a standing fence, unions its
   * grantee list, and root stamps the retry RECOVERY. The both-directions rule that just refused
   * the run would be unavailable to the very next attempt.
   *
   * Exit 3 is EXIT_NOT_FENCEABLE, and every path in the helper that returns it is strictly before
   * `BEGIN`: nothing was revoked, so the record is this run's own and removing it loses nothing.
   * Exit 5 is EXIT_FENCE_STANDING, where the revokes may be on the medium — that record is the only
   * thing that undoes them and must survive.
   *
   * ROUTE: the shipped db_fence_raise(), with the shipped validator and the shipped publisher, and
   * one stub: the privilege drop, which is the single part each entrypoint supplies for itself.
   */
  const dir = stateDir(t)
  const PLAN = '{"database":"imsdb","owner_role":"owner","app_role":"imsapp","admin_role":"admin","revoked":["PUBLIC","imsapp"],"datacl_before":null,"fenced_at":"2026-01-01T00:00:00.000Z"}'

  // A STATE FILE OF ITS OWN PER SCENARIO. `fence_mode` is stamped from whether one is already
  // there, so a second scenario over the first one's leftovers would be measuring the leftovers.
  const raise = (name: string, fenceRc: number, extra: string[] = [], mutate: (body: string) => string = (b) => b) => {
    const stateFile = join(dir, `${name}.json`)
    const program = [
      'set -uo pipefail',
      shellFunction(CUTOVER_NS_LIB_SOURCE, 'dir_is_private_to_this_run'),
      // The program emitter, rebuilt around the SHIPPED program text rather than lifted whole:
      // shellFunction() delimits a body by its braces and the validator's heredoc is full of them,
      // so lifting it cuts the here-document in half. AUTHORISE_PLAN_PROGRAM is read out of the
      // library between its own markers — the same bytes root hands `node -e` — so what runs here
      // is still the shipped validator and not a re-typed one.
      `db_fence_authorise_plan_program() {\n  cat <<'AUTHORISE_PLAN_EOF'\n${AUTHORISE_PLAN_PROGRAM}AUTHORISE_PLAN_EOF\n}`,
      `db_fence_mark_applied_program() {\n  cat <<'MARK_APPLIED_EOF'\n${MARK_APPLIED_PROGRAM}MARK_APPLIED_EOF\n}`,
      FENCE_DISPLAY_DECLARATIONS,
      shellFunction(FENCE_LIBRARY, 'db_fence_authorise_plan'),
      shellFunction(FENCE_LIBRARY, 'db_fence_mark_authority_applied'),
      shellFunction(FENCE_LIBRARY, 'db_fence_publish_authority'),
      shellFunction(FENCE_LIBRARY, 'db_fence_clear_authority'),
      mutate(shellFunction(FENCE_LIBRARY, 'db_fence_raise')),
      `state=${JSON.stringify(stateFile)}`,
      `fence_rc=${fenceRc}`,
      // THE PRIVILEGE DROP, STUBBED, and it answers `--plan` the way the shipped mode does: one
      // line of JSON on STDOUT and nothing else there, because the caller captures it.
      `db_fence_helper() { shift; case "$*" in *--plan*) printf '%s\\n' ${JSON.stringify(PLAN)}; return 0 ;; *--fence*) return "\${fence_rc}" ;; esac; return 0; }`,
      ...extra,
      'db_fence_raise "/nonexistent/fence.mjs" "${state}" --app-database=imsdb --app-user=imsapp; echo "RC=$?"',
      '[[ -e "${state}" ]] && echo "AUTHORITY=PRESENT" || echo "AUTHORITY=GONE"',
      '[[ -e "${state}" ]] && echo "MODE=$(node -e \'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fence_mode))\' "${state}")"',
      '[[ -e "${state}" ]] && echo "APPLIED=$(node -e \'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fence_applied))\' "${state}")"',
    ].join('\n')
    const run = spawnSync('bash', ['-c', program], { encoding: 'utf8' })
    return `${run.stdout ?? ''}${run.stderr ?? ''}`
  }

  // THE PRECONDITION, PROVED RATHER THAN ASSUMED: a fence that SUCCEEDS keeps its authority, or
  // every "GONE" below could be a publication that never happened.
  const raised = raise('raised', 0)
  assert.match(raised, /^RC=0$/m, `the ordinary raise must succeed:\n${raised}`)
  assert.match(raised, /^AUTHORITY=PRESENT$/m, `and leave the record a release is driven from:\n${raised}`)
  assert.match(raised, /^MODE=initial$/m, `stamped initial, because nothing was at the destination:\n${raised}`)
  // AND o3d-secops r25: a raise that got as far as a REVOKE stamps its record APPLIED, which is
  // what a later publication reads "a fence is standing" from. Asserted here rather than only in
  // its own test because every "GONE"/"PRESENT" below is about a record whose applied state is the
  // thing that now matters.
  assert.match(raised, /^APPLIED=1$/m, `and the record must say the fence went up:\n${raised}`)

  // REFUSED BEFORE ANY REVOKE, WITH NOTHING STANDING: the record is this run's own, and it goes.
  const refused = raise('refused', 3)
  assert.match(refused, /^RC=3$/m, `the refusal must be reported unchanged:\n${refused}`)
  assert.match(refused, /^AUTHORITY=GONE$/m,
    `and the authority this run published must not survive to make the RETRY a "recovery":\n${refused}`)
  // AND THE RETRY IS STILL AN INITIAL FENCE, which is the whole reason the removal is there: the
  // rule that refused this run has to be the rule the next attempt is held to as well.
  // Read off the publication banner rather than the file, because the shipped retry removes its
  // own record too: what is being asked is what root STAMPED, not what survived.
  const retried = raise('refused', 3)
  assert.match(retried, /published at .*\(initial\)/, `the re-run must be planned and stamped afresh:\n${retried}`)
  assert.match(retried, /^AUTHORITY=GONE$/m, `and clear up after itself in turn:\n${retried}`)

  // AND THE ONE IT MUST NEVER TOUCH: a fence was already standing when this run arrived, so that
  // record is the only account of what an earlier run revoked.
  //
  // AND THE FIXTURE IS A FENCE THAT ACTUALLY STOOD (o3d-secops r25): published AND stamped
  // applied. A bare publication is no longer a standing fence, which is the point of the round —
  // so a fixture that only published would be measuring a leftover, not the thing being protected.
  const standing = raise('standing', 3, [
    `printf '%s\\n' ${JSON.stringify(PLAN)} | db_fence_authorise_plan imsdb imsapp "\${state}" >/dev/null 2>&1`,
    'db_fence_mark_authority_applied "${state}" >/dev/null 2>&1',
  ])
  assert.match(standing, /^RC=3$/m, standing)
  assert.match(standing, /^AUTHORITY=PRESENT$/m,
    `a standing fence's record may never be removed by a refusal — every grantee it names depends on it:\n${standing}`)
  assert.match(standing, /^MODE=recovery$/m, `and it is a recovery, because a fence was applied behind it:\n${standing}`)

  // AND A FENCE THAT MAY BE STANDING KEEPS ITS RECORD TOO. Exit 5 is "the COMMIT was issued and
  // this run never learned whether it took", which is the one outcome where the undo record is
  // load-bearing and the run cannot prove it is not.
  const uncertain = raise('uncertain', 5)
  assert.match(uncertain, /^RC=5$/m, uncertain)
  assert.match(uncertain, /^AUTHORITY=PRESENT$/m,
    `a revoke that may be on the medium must keep the only thing that undoes it:\n${uncertain}`)

  // MEASURED BY MUTATION, ROUTE STATED, UNDER A REAL SHELL. Two of them, because the cleanup has
  // two halves and each can be wrong on its own.
  const RAISE = shellFunction(FENCE_LIBRARY, 'db_fence_raise')
  const CLEANUP = '  if [[ "${rc}" -eq 3 && "${had_authority}" -eq 0 ]]; then'
  assert.ok(RAISE.includes(CLEANUP), `the shipped orchestration must clear its own refused publication:\n${RAISE}`)

  // A: no cleanup at all, which is r23. The refused run leaves a record, and the next `--plan`
  // reads it as a standing fence.
  const withoutCleanup = (body: string) => body.replace(CLEANUP, '  if false; then')
  const noCleanup = raise('nocleanup', 3, [], withoutCleanup)
  assert.match(noCleanup, /^AUTHORITY=PRESENT$/m,
    `without the cleanup the refusal leaves an authority behind:\n${noCleanup}`)
  assert.match(noCleanup, /^MODE=initial$/m, `this run's own, stamped initial:\n${noCleanup}`)
  assert.match(noCleanup, /^APPLIED=0$/m, `and never applied to anything, because the fence was refused:\n${noCleanup}`)
  // AND THE CONSEQUENCE, RUN RATHER THAN DESCRIBED. Under r24 the very next attempt over that
  // leftover was stamped a RECOVERY — one re-run bought the drift tolerance the refusal existed to
  // withhold, because "a fence is standing" was read off the pathname. Under r25 it is read off
  // the APPLIED STAMP, which this leftover does not carry, so the retry is INITIAL and held to the
  // strict rule EVEN WITH THE CLEANUP REMOVED. That is the architectural half of the fix stated as
  // a measurement: the leftover is inert by construction rather than by having been tidied away.
  const secondAttempt = raise('nocleanup', 3, [], withoutCleanup)
  assert.match(secondAttempt, /^MODE=initial$/m,
    `a record nothing ever applied may not buy the recovery rule, cleanup or no cleanup:\n${secondAttempt}`)

  // B: the cleanup with its ownership half removed — `rc` alone. It then removes a STANDING
  // fence's record, which is strictly worse than the finding it was added for.
  const anyAuthority = raise('anyauthority', 3, [
    `printf '%s\\n' ${JSON.stringify(PLAN)} | db_fence_authorise_plan imsdb imsapp "\${state}" >/dev/null 2>&1`,
    'db_fence_mark_authority_applied "${state}" >/dev/null 2>&1',
  ], (body) => body.replace(CLEANUP, '  if [[ "${rc}" -eq 3 ]]; then'))
  assert.match(anyAuthority, /^AUTHORITY=GONE$/m,
    `without the "this run published it" half, a refusal destroys the only record of a standing fence:\n${anyAuthority}`)
})

/**
 * WHERE r24 STOPPED, AND WHY A SECOND CLEANUP WOULD NOT HAVE BEEN ENOUGH (o3d-secops r25, Codex
 * HIGH).
 *
 * r24 closed ONE route to a leftover authority — `--fence` returning EXIT_NOT_FENCEABLE — and left
 * its sibling open. The validator's LAST barrier is the directory fsync, which runs AFTER the
 * atomic rename; when it fails it says the name is not durable and deliberately leaves the record
 * visible, because the file genuinely is there. r24's cleanup hangs off the EXECUTION's exit code
 * and this route never reaches an execution at all, so the record survived and the instructed
 * retry read the pathname as a standing fence.
 *
 * THE RULE, NOT THE ROUTE: DO NOT INFER A STANDING FENCE SOLELY FROM RECORD PRESENCE. Presence
 * conflates "root published an authority" with "the fence was applied", and only the second is a
 * standing fence. So the record carries `fence_applied`, written 0 by the validator and raised to
 * 1 by root after `--fence` reports the revokes are on the medium; `fence_mode` is computed from
 * THAT. A record left by any publication failure — this one, or one nobody has thought of — is
 * then inert by construction rather than by having been cleaned up.
 *
 * ROUTE, AND IT IS THE REAL ONE: the shipped validator, run exactly as db_fence_authorise_plan()
 * runs it, into a directory whose mode is 0300 — searchable and writable, so the temporary, the
 * fsync, the chmod and the rename all succeed, and NOT readable, so `open(directory, 'r')` for the
 * final fsync returns EACCES. Nothing is faked and no branch is simulated.
 */
test('a record left by a post-rename publication failure does not buy recovery (o3d-secops r25)', (t) => {
  // ROOT BYPASSES THE MODE, so as root this would publish cleanly and every assertion below would
  // pass while measuring nothing. The suite is run as an unprivileged account; this says so out
  // loud rather than letting the day it is not be silent.
  if ((process.getuid?.() ?? 0) === 0) {
    assert.fail('this test measures a permission denial and root has none: run the unit suite as an unprivileged account')
  }
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')

  chmodSync(dir, 0o300)
  const torn = authorisePlan(SAMPLE_STATE, stateFile, 'imsdb', 'imsapp')
  chmodSync(dir, 0o700)

  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED — all three halves of it, because a test that
  // reached none of them would still go green on the assertions that follow.
  assert.notEqual(torn.status, 0, `the publication must FAIL when its name cannot be made durable:\n${torn.output}`)
  assert.match(torn.output, /NAME is not durable/, `by the post-rename barrier and not an earlier one:\n${torn.output}`)
  assert.equal(existsSync(stateFile), true,
    `and the record must be VISIBLE anyway — that is the whole finding:\n${torn.output}`)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_applied, 0,
    'left by a publication, so nothing has been applied behind it')

  // AND THE INSTRUCTED RETRY IS STILL AN INITIAL FENCE. This is the claim: a leftover record does
  // not hand the next attempt the tolerance a strict rule would have withheld.
  const retry = authorisePlan(SAMPLE_STATE, stateFile, 'imsdb', 'imsapp')
  assert.equal(retry.status, 0, `the retry must publish:\n${retry.output}`)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_mode, FENCE_MODE_INITIAL,
    'a record nothing ever applied is not a standing fence, however visible it is')
  assert.match(retry.output, /published and never stamped applied/,
    `and the retry says why it is not treating it as one:\n${retry.output}`)

  // MEASURED BY MUTATION, AGAINST THE SHIPPED PROGRAM TEXT, UNDER A REAL NODE. Restore r24's rule —
  // "anything at the destination is a standing fence" — and the same leftover is stamped RECOVERY.
  const APPLIED_RULE = 'prior.fence_applied === 1'
  assert.ok(AUTHORISE_PLAN_PROGRAM.includes(APPLIED_RULE),
    `the shipped validator must decide the mode from the applied stamp:\n${AUTHORISE_PLAN_PROGRAM}`)
  const presenceIsEnough = AUTHORISE_PLAN_PROGRAM.replace(APPLIED_RULE, 'true')
  assert.notEqual(presenceIsEnough, AUTHORISE_PLAN_PROGRAM, 'the mutation must have changed something')
  const mutated = join(dir, 'mutated.json')
  writeFileSync(mutated, readFileSync(stateFile, 'utf8'))
  writeFileSync(mutated, `${JSON.stringify({ ...JSON.parse(readFileSync(mutated, 'utf8')), fence_applied: 0 }, null, 2)}\n`)
  const regressed = spawnSync('node', ['-e', presenceIsEnough, '--', 'imsdb', 'imsapp', mutated], {
    input: `${JSON.stringify(SAMPLE_STATE)}\n`,
    encoding: 'utf8',
  })
  assert.equal(regressed.status, 0, `${regressed.stdout}${regressed.stderr}`)
  assert.equal(JSON.parse(readFileSync(mutated, 'utf8')).fence_mode, FENCE_MODE_RECOVERY,
    'with the applied stamp ignored, a leftover record buys the recovery rule again — which is the finding')
})

/**
 * THE MINIMUM, AS DEFENCE IN DEPTH: this run's own visible authority is cleaned up on the
 * PUBLICATION path too, not only on the execution's exit 3 (o3d-secops r25, Codex HIGH).
 *
 * ROUTE: the shipped db_fence_raise(), with the shipped validator and the shipped publisher, over
 * a 0300 state directory — the same real post-rename failure as above, reached through the
 * orchestration rather than through the validator directly. One stub, the privilege drop, which is
 * the single part each entrypoint supplies for itself.
 */
test('db_fence_raise clears the authority a FAILED PUBLICATION left behind (o3d-secops r25)', (t) => {
  if ((process.getuid?.() ?? 0) === 0) {
    assert.fail('this test measures a permission denial and root has none: run the unit suite as an unprivileged account')
  }
  const dir = stateDir(t)
  const PLAN = '{"database":"imsdb","owner_role":"owner","app_role":"imsapp","admin_role":"admin","revoked":["PUBLIC","imsapp"],"datacl_before":null,"fenced_at":"2026-01-01T00:00:00.000Z"}'

  const raise = (name: string, mutate: (body: string) => string = (b) => b) => {
    const stateFile = join(dir, `${name}.json`)
    const program = [
      'set -uo pipefail',
      shellFunction(CUTOVER_NS_LIB_SOURCE, 'dir_is_private_to_this_run'),
      `db_fence_authorise_plan_program() {\n  cat <<'AUTHORISE_PLAN_EOF'\n${AUTHORISE_PLAN_PROGRAM}AUTHORISE_PLAN_EOF\n}`,
      `db_fence_mark_applied_program() {\n  cat <<'MARK_APPLIED_EOF'\n${MARK_APPLIED_PROGRAM}MARK_APPLIED_EOF\n}`,
      FENCE_DISPLAY_DECLARATIONS,
      shellFunction(FENCE_LIBRARY, 'db_fence_authorise_plan'),
      shellFunction(FENCE_LIBRARY, 'db_fence_mark_authority_applied'),
      shellFunction(FENCE_LIBRARY, 'db_fence_publish_authority'),
      shellFunction(FENCE_LIBRARY, 'db_fence_clear_authority'),
      mutate(shellFunction(FENCE_LIBRARY, 'db_fence_raise')),
      `state=${JSON.stringify(stateFile)}`,
      // THE DIRECTORY THE PUBLICATION CANNOT FSYNC. 0300 keeps `stat` (which is what
      // dir_is_private_to_this_run asks), the temporary, the rename and the later `rm -f` all
      // working — only the read the final fsync needs is denied.
      `chmod 0300 ${JSON.stringify(dir)}`,
      `db_fence_helper() { shift; case "$*" in *--plan*) printf '%s\\n' ${JSON.stringify(PLAN)}; return 0 ;; esac; echo "THE HELPER WAS INVOKED PAST THE PLAN" >&2; return 0; }`,
      'db_fence_raise "/nonexistent/fence.mjs" "${state}" --app-database=imsdb --app-user=imsapp; echo "RC=$?"',
      `chmod 0700 ${JSON.stringify(dir)}`,
      '[[ -e "${state}" ]] && echo "AUTHORITY=PRESENT" || echo "AUTHORITY=GONE"',
    ].join('\n')
    const run = spawnSync('bash', ['-c', program], { encoding: 'utf8' })
    return `${run.stdout ?? ''}${run.stderr ?? ''}`
  }

  const failed = raise('failed')
  // THE PRECONDITION: the run really did reach the post-rename barrier, and really did refuse.
  assert.match(failed, /NAME is not durable/, `the publication must fail after the rename:\n${failed}`)
  assert.match(failed, /^RC=3$/m, `and the raise must refuse rather than revoke:\n${failed}`)
  assert.doesNotMatch(failed, /THE HELPER WAS INVOKED PAST THE PLAN/,
    `and nothing may execute a fence whose authority was not published:\n${failed}`)
  assert.match(failed, /^AUTHORITY=GONE$/m,
    `and the half-published record must not be left at the authoritative path:\n${failed}`)

  // MEASURED BY MUTATION, ROUTE STATED, UNDER A REAL SHELL: remove the publication-path cleanup —
  // which is exactly the shape r24 shipped — and the record survives.
  const RAISE = shellFunction(FENCE_LIBRARY, 'db_fence_raise')
  // o3d-secops r30: the call carries the attestation argument now (Codex HIGH 1) -- this is this
  // run's OWN publication, seconds old, which is exactly the fact that licenses an unlink.
  const PUBLICATION_CLEANUP = '    if [[ "${had_authority}" -eq 0 ]]; then\n      # THIS RUN\'S OWN PUBLICATION'
  assert.ok(RAISE.includes(PUBLICATION_CLEANUP),
    `the shipped orchestration must clear a failed publication's own record:\n${RAISE}`)
  const withoutIt = (body: string) => body.replace(PUBLICATION_CLEANUP, '    if false; then\n      # THIS RUN\'S OWN PUBLICATION')
  const leftBehind = raise('nocleanup', withoutIt)
  assert.match(leftBehind, /^AUTHORITY=PRESENT$/m,
    `without it a failed publication leaves its record at the authoritative path:\n${leftBehind}`)
})

/**
 * AND THE RECORD OF A FENCE THAT PREDATES THE STAMP IS NOT STRANDED (o3d-secops r25).
 *
 * A fence raised before this upgrade is standing and its record has no `fence_applied` key at all.
 * Refusing it recovery would leave it with neither a re-apply nor a release — the strict rule can
 * never be satisfied by a standing fence's own record, because that fence is what took CONNECT
 * from the grantees it names. So ABSENCE of the key means "written by a validator that predates
 * the stamp", which can only be a fence raised earlier, and it is treated as standing.
 *
 * That is how it is told apart from a half-published record: a record from this round always HAS
 * the key, holding 0, because the validator writes it in the same template as every other field.
 * The discriminator is the key's presence, not its value, and it holds because the directory is
 * root-owned and unwritable by anything else — the same argument `fence_mode` already rests on.
 */
/**
 * THE RULE THAT SETTLES AN UNSTAMPED RECORD, READ AS A RULE (o3d-secops r26, Codex HIGH).
 *
 * Pure and separate from the mode that drives it, for the reason assessAuthorityDrift() is: what
 * the ACL is allowed to prove must be readable without a database beside it.
 *
 * MUTATION ROUTE (each made against the shipped file and reverted):
 *   1. drop the `named.length === 0` guard: a record naming nobody reports `absent` — both later
 *      branches are vacuously true over an empty list — and the wrapper CLEARS the record of a
 *      fence it never looked at.
 *   2. return LEGACY_FENCE_STANDS for the mixed case instead of AMBIGUOUS: a fence that was half
 *      applied, and a host where an administrator removed one recorded role by hand, are both
 *      stamped as standing fences.
 */
test('the ACL settles an unstamped record in three ways, and refuses in the third (o3d-secops r26)', () => {
  const recorded = ['PUBLIC', 'imsapp', 'analytics']

  // NO FENCE STANDS. The REVOKE names exactly these roles, so it cannot have run.
  const spent = assessLegacyFenceEvidence({ recorded, holding: ['analytics', 'PUBLIC', 'imsapp'] })
  assert.equal(spent.verdict, LEGACY_FENCE_ABSENT, 'every recorded grantee still connects')
  assert.deepEqual(spent.lost, [], 'and nothing was taken from any of them')

  // A FENCE STANDS. Not one of them holds CONNECT, which nothing else on an ordinary host does.
  const standing = assessLegacyFenceEvidence({ recorded, holding: [] })
  assert.equal(standing.verdict, LEGACY_FENCE_STANDS)
  assert.deepEqual(standing.lost, recorded, 'and it names whose CONNECT is gone')

  // AND THE MIXED READING, WHICH IS NEITHER. A half-applied fence and an administrator who removed
  // one of these roles by hand are the same bytes from here.
  const mixed = assessLegacyFenceEvidence({ recorded, holding: ['PUBLIC'] })
  assert.equal(mixed.verdict, LEGACY_FENCE_AMBIGUOUS)
  assert.deepEqual([mixed.holding, mixed.lost], [['PUBLIC'], ['imsapp', 'analytics']],
    'and both lists are handed back, because the operator is the one who decides')

  // A RECORD NAMING NOBODY IS NOT AN ANSWER EITHER. Both other branches are vacuously true over an
  // empty list — every grantee holds CONNECT and no grantee holds CONNECT — so it is refused.
  for (const empty of [[], undefined, ['', null] as unknown as string[]]) {
    const nothing = assessLegacyFenceEvidence({ recorded: empty as string[], holding: [] })
    assert.equal(nothing.verdict, LEGACY_FENCE_AMBIGUOUS, `${JSON.stringify(empty)} settles nothing`)
  }
})

/**
 * `--audit-authority` ASKS THE DATABASE AND WRITES NOTHING (o3d-secops r26, Codex HIGH).
 *
 * ROUTE: the shipped doAuditAuthority() over a record the shipped validator published, against a
 * REAL `datacl` string of the shape PostgreSQL prints — an unfenced database's, then a fenced
 * one's, then one an administrator has edited. The verdict is read off stdout the way the
 * operator wrapper reads it, and the exit status the way the wrapper acts on it.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): read `holding` with
 * has_database_privilege()'s question instead of granteeHasConnect()'s — that is, treat every
 * recorded grantee as holding CONNECT — and the FENCED case below reports `absent`, which is the
 * wrapper deleting the record of a fence that is standing.
 */
test('--audit-authority reads the live ACL, decides, and touches nothing (o3d-secops r26)', async (t) => {
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const record = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] }
  publishAuthority(stateFile, record)
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'))
  delete legacy.fence_applied
  delete legacy.fence_mode
  writeFileSync(stateFile, `${JSON.stringify(legacy, null, 2)}\n`)
  const untouched = readFileSync(stateFile, 'utf8')

  const audit = async (datacl: ReturnType<typeof aclRows> | null, connectedDatabase = 'imsdb') => {
    const client = new FakeAdminClient({ stateFile, datacl, connectedDatabase })
    const captured = await capturingFenceOutput(() => withAdminUrl(() => doAuditAuthority(client as never, {
      stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
    })))
    return { code: captured.value, verdict: captured.out.trim(), log: client.log }
  }

  // 1. THE DATABASE IS NOT FENCED: PUBLIC and the application both still hold CONNECT directly,
  //    so the REVOKE this record describes never ran.
  const spent = await audit(ACL_UNFENCED)
  // o3d-secops r28: stdout carries three lines now -- the cluster verdict and the identity that
  // answered, beside the ACL verdict. The wrapper reads all three, so the test reads all three.
  assert.match(spent.verdict, new RegExp(`^legacy_fence_verdict=${LEGACY_FENCE_ABSENT}$`, 'm'), spent.verdict)
  assert.equal(spent.code, EXIT_OK, 'exit 0 is the status the wrapper clears the record on')

  // 2. THE DATABASE IS FENCED: the owner keeps its own entry and nothing else holds CONNECT.
  const standing = await audit(ACL_FENCED)
  assert.match(standing.verdict, new RegExp(`^legacy_fence_verdict=${LEGACY_FENCE_STANDS}$`, 'm'), standing.verdict)
  assert.equal(standing.code, EXIT_FENCE_STANDING, 'exit 5 is the status the wrapper stamps on')

  // 3. AND THE MIXED ONE. PUBLIC lost CONNECT and the application kept it — which is what a fence
  //    interrupted between two REVOKEs leaves, and also what an administrator revoking PUBLIC by
  //    hand leaves. Neither action may follow from it.
  const mixed = await audit(ACL_MIXED)
  assert.match(mixed.verdict, new RegExp(`^legacy_fence_verdict=${LEGACY_FENCE_AMBIGUOUS}$`, 'm'), mixed.verdict)
  assert.equal(mixed.code, EXIT_FENCE_UNPROVEN, 'exit 4 is the status that means the wrapper must not act')

  // NOTHING IN ANY OF THE THREE WROTE, OPENED A TRANSACTION OR CHANGED A GRANT. This is what makes
  // it safe to hand to an operator staring at a fence they cannot explain.
  for (const run of [spent, standing, mixed]) {
    assert.deepEqual(run.log.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE)/.test(sql)), [],
      `the audit must issue no transaction and no grant:\n${run.log.join(' | ')}`)
  }
  assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'and the record must be exactly as it was found')

  // AND IT REFUSES RATHER THAN GUESSING WHEN IT IS POINTED SOMEWHERE ELSE — at another database,
  // where the ACL it would read is not the one this record was written against.
  const elsewhere = await audit(ACL_FENCED, 'otherdb')
  assert.equal(elsewhere.code, EXIT_ERROR, 'a connection attached elsewhere settles nothing')
  assert.equal(elsewhere.verdict, '', 'and prints no verdict at all, so nothing downstream can act on one')

  // NOR WITH NO RECORD TO AUDIT.
  const absent = new FakeAdminClient({ datacl: ACL_FENCED })
  const missing = await withAdminUrl(() => doAuditAuthority(absent as never, {
    stateFile: join(dir, 'does-not-exist.json'), appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  }))
  assert.equal(missing, EXIT_ERROR, 'there is nothing to ask the ACL about')

  // AND A RECORD THE PUBLISHING ACCOUNT DID NOT WRITE IS NEVER READ — the audit's verdict decides
  // whether root stamps a fence applied, so it goes through the same provenance gate as everything
  // else that acts on this file.
  const foreign = new FakeAdminClient({ stateFile, datacl: ACL_FENCED })
  const foreignCode = await withAdminUrl(() => doAuditAuthority(foreign as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
    stateOwnerUid: (process.getuid?.() ?? 0) + 4242,
  }))
  assert.equal(foreignCode, EXIT_ERROR, 'a record this run does not act for may not drive a stamp')
})

/**
 * THE AUDIT BINDS THE WHOLE IDENTITY, NOT JUST THE DATABASE NAME (o3d-secops r27, Codex HIGH).
 *
 * WHAT r26 GOT WRONG, in the code r26 itself added. `--audit-authority` validated exactly one
 * thing about the cluster it had reached: that `current_database()` matched the name the record
 * carries. TWO SERVERS CAN BOTH SATISFY THAT AT ONCE. A `DEPLOY_ADMIN_DATABASE_URL` that has been
 * changed — or that was always pointing at staging — reaches a different host whose database
 * happens to be called the same thing; that cluster is not fenced, so every recorded grantee holds
 * CONNECT there, the verdict is `absent`, and the wrapper DELETES the sole authority for a fence
 * still standing on the real cluster. `--fence` and `--release` were never exposed to this: both
 * call requireBoundDatabaseIdentity() first. One rule, several readers, and the reader that did
 * not call it is the one that shipped the hole.
 *
 * ROUTE: the shipped doAuditAuthority() over the shipped requireBoundDatabaseIdentity(), against a
 * record the shipped validator published. The admin URL and the `--app-*` identity are moved apart
 * one axis at a time, and what is asserted is what does NOT come out — no verdict line at all, so
 * neither of the wrapper's two channels can be acted on — and that the authority is byte-identical
 * afterwards.
 *
 * MUTATION ROUTES (each made against scripts/fence-db-connections.mjs and reverted):
 *   1. delete the requireBoundDatabaseIdentity() call from doAuditAuthority(): the same-name/
 *      different-host case prints `legacy_fence_verdict=absent` and exits 0 — the wrapper deleting
 *      a standing fence's only record.
 *   2. drop `session_user AS audited_login_role` from the audit's read: the gate then refuses EVERY
 *      case including the bound one, which the first assertion here catches — so a gate that
 *      refuses everything cannot pass this test either. THIS ROUTE ONLY WORKS BECAUSE THE FIXTURE
 *      ANSWERS THE QUERY: it was run first against a fake that returned both role columns whatever
 *      the SELECT asked for, and every test in this file still passed with the column deleted. The
 *      `asked()` helper in FakeAdminClient exists for that, and nothing else here would cover it.
 */
test('--audit-authority refuses a same-named database on another cluster (o3d-secops r27)', async (t) => {
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishAuthority(stateFile, { ...SAMPLE_STATE, database: 'imsdb', revoked: ['PUBLIC', 'imsapp'] })
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'))
  delete legacy.fence_applied
  delete legacy.fence_mode
  writeFileSync(stateFile, `${JSON.stringify(legacy, null, 2)}\n`)
  const untouched = readFileSync(stateFile, 'utf8')

  // THE APPLICATION'S OWN SERVER, as the caller states it on argv and never derives it.
  const APP = { appHost: 'db.internal', appPort: '6432', appUser: 'imsapp', appDatabase: 'imsdb' }
  const UNFENCED = ACL_UNFENCED

  const audit = async (adminUrl: string, options: Record<string, unknown> = {}, client: Record<string, unknown> = {}) => {
    const fake = new FakeAdminClient({ stateFile, datacl: UNFENCED, connectedDatabase: 'imsdb', ...client })
    const previous = process.env.DEPLOY_ADMIN_DATABASE_URL
    process.env.DEPLOY_ADMIN_DATABASE_URL = adminUrl
    try {
      const captured = await capturingFenceOutput(() => doAuditAuthority(fake as never, {
        stateFile, appRole: 'imsapp', ...suppliedIdentity(APP), ...options,
      }))
      return { code: captured.value, verdict: captured.out.trim(), said: captured.err, log: fake.log }
    } finally {
      if (previous === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
      else process.env.DEPLOY_ADMIN_DATABASE_URL = previous
    }
  }

  // 0. THE BOUND CASE STILL DECIDES. Without this the rest is satisfied by a gate that refuses
  //    everything, which would be a regression wearing the shape of a fix.
  const bound = await audit('postgres://deployadmin@db.internal:6432/imsdb')
  assert.match(bound.verdict, new RegExp(`^legacy_fence_verdict=${LEGACY_FENCE_ABSENT}$`, 'm'), bound.said)
  assert.equal(bound.code, EXIT_OK, bound.said)

  // 1. THE FINDING ITSELF: THE SAME DATABASE NAME, ON ANOTHER HOST. The ACL supplied is the
  //    UNFENCED one, which is what an unfenced bystander cluster shows and is exactly the reading
  //    that made r26 delete the record.
  const elsewhere = await audit('postgres://deployadmin@replica.internal:6432/imsdb')
  assert.equal(elsewhere.code, EXIT_ERROR, `another cluster settles nothing:\n${elsewhere.said}`)
  assert.equal(elsewhere.verdict, '', `and must print NO verdict line:\n${elsewhere.verdict}`)
  assert.match(elsewhere.said, /NOT AUDITED/, elsewhere.said)
  assert.match(elsewhere.said, /replica\.internal/, `naming the host it actually reached:\n${elsewhere.said}`)

  // 2. AND THE REST OF THE SAME AXIS, because a host check that ignores the port, the role it
  //    logged in as, or a SET ROLE is a host check with three ways round it.
  const apart: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
    ['a different port on the right host', 'postgres://deployadmin@db.internal:5432/imsdb', {}, {}],
    ['a different database in the URL', 'postgres://deployadmin@db.internal:6432/otherdb', {}, {}],
    ['a login role the URL does not name', 'postgres://deployadmin@db.internal:6432/imsdb', {}, { loginRole: 'someoneelse', effectiveRole: 'someoneelse' }],
    ['a connection running under SET ROLE', 'postgres://deployadmin@db.internal:6432/imsdb', {}, { loginRole: 'deployadmin', effectiveRole: 'postgres' }],
    ['a connection landed on another database', 'postgres://deployadmin@db.internal:6432/imsdb', {}, { connectedDatabase: 'otherdb' }],
    ['no --app-host supplied at all', 'postgres://deployadmin@db.internal:6432/imsdb', { appHost: '' }, {}],
  ]
  for (const [label, adminUrl, options, client] of apart) {
    const run = await audit(adminUrl, options, client)
    assert.equal(run.code, EXIT_ERROR, `${label}: must refuse:\n${run.said}`)
    assert.equal(run.verdict, '', `${label}: and print no verdict:\n${run.verdict}`)
    assert.deepEqual(run.log.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE)/.test(sql)), [],
      `${label}: and issue nothing:\n${run.log.join(' | ')}`)
  }

  // 3. AND THE AUTHORITY IS BYTE FOR BYTE WHAT IT WAS, through all of it. This is the property the
  //    finding is about: the record is the only account of what the real cluster's fence revoked,
  //    and an audit that reached the wrong cluster must not be able to cost anything at all.
  assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'the record must be untouched')
})

/**
 * AN UNSTAMPED RECORD BUYS NOTHING, AND THE RELEASE STILL WORKS OVER IT
 * (o3d-secops r26, Codex HIGH — this test REPLACES r25's `a fence raised before the applied stamp
 * still re-applies and releases`, which asserted the behaviour this round removed).
 *
 * WHAT r25 GOT WRONG, since the test that asserted it is the one being rewritten. It read an
 * absent `fence_applied` key as a fence RAISED before the stamp existed, and therefore standing,
 * and published a RECOVERY authority over it. The premise is sound — the key is absent only in
 * records an older validator wrote — and the conclusion does not follow from it: that older
 * validator published its record BEFORE invoking `--fence`, so its own documented SIGKILL window
 * between the rename and `BEGIN` leaves exactly this record with no fence behind it. An absent
 * stamp dates the WRITER. Reading it as standing hands the lax rule — recorded grantees missing
 * from the ACL are accepted, and `--release` afterwards GRANTs CONNECT back to every one of them —
 * to a fence nobody can show exists, which is the direction refused everywhere else on this branch.
 *
 * SO: the automatic path REFUSES, and the two things that must still work do.
 */
test('an unstamped record is refused by the validator and still releasable from (o3d-secops r26)', async (t) => {
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const record = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] }

  // THE LEGACY RECORD, BUILT BY STRIPPING WHAT THE OLD VALIDATOR NEVER WROTE rather than by
  // hand-rolling one: the fields that remain are the shipped template's own.
  publishAuthority(stateFile, record)
  const published = JSON.parse(readFileSync(stateFile, 'utf8'))
  delete published.fence_applied
  delete published.fence_mode
  writeFileSync(stateFile, `${JSON.stringify(published, null, 2)}\n`)
  const before = readFileSync(stateFile, 'utf8')

  // 1. THE AUTOMATIC PATH REFUSES, AND PUBLISHES NOTHING.
  const republished = authorisePlan(record, stateFile, 'imsdb', 'imsapp')
  assert.equal(republished.status, 1, `a re-fence over an unstamped record must refuse:\n${republished.output}`)
  assert.equal(readFileSync(stateFile, 'utf8'), before,
    'and the record it refused must be exactly as it was found — a refusal is not a publication')
  assert.match(republished.output, /carries no applied stamp at all/,
    `it must name the record's own defect:\n${republished.output}`)
  assert.match(republished.output, /says nothing about whether that writer's REVOKE ever committed/,
    `and say why the two cases are indistinguishable rather than picking one:\n${republished.output}`)
  // AND POINT AT THE EVIDENCE, SAYING HOW FAR IT GOES (o3d-secops r27, Codex HIGH). r26 asserted
  // the wording "Only the live ACL can", which claimed more than the ACL delivers: it settles a
  // record every recorded grantee STILL HOLDS CONNECT against, and it cannot say WHOSE revoke took
  // CONNECT from roles that have all lost it. The refusal states both halves now, so both are
  // asserted here — a refusal that promised a settling the audit will not perform is a refusal
  // that sends the operator to a wrapper expecting it to decide.
  assert.match(republished.output, /the live ACL settles only half of it/,
    `and point at the evidence that settles the half it settles:\n${republished.output}`)
  assert.match(republished.output, /never what made them so/,
    `and not promise the half it cannot:\n${republished.output}`)

  // AND IT IS NOT SILENT ABOUT WHICH RECORD, which is what makes the refusal actionable.
  assert.ok(republished.output.includes(stateFile), `the refusal must name the record:\n${republished.output}`)

  // 2. NOR DOES THE EXECUTOR HAND IT THE LAX RULE IF ONE REACHES IT ANOTHER WAY. The ACL of a
  //    fenced database: the owner keeps its own entry and nobody else holds CONNECT, so every
  //    recorded grantee is `withdrawn` — which the strict rule refuses and the lax one accepts.
  //    r25 accepted this. It is the drift tolerance being withheld.
  const client = new FakeAdminClient({ stateFile, datacl: ACL_FENCED, stillConnectsBefore: false })
  const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.equal(code, EXIT_NOT_FENCEABLE, `an unstamped record must not license a re-fence:\n${client.log.join(' | ')}`)
  assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked over it')

  // 3. AND THE RELEASE STILL WORKS, WHICH IS THE ESCAPE HATCH IN BOTH DIRECTIONS. It reads the
  //    record and grants back every role it names, consulting neither `fence_applied` nor
  //    `fence_mode` — so an operator holding a record no automatic path will touch can still take
  //    a standing fence down. Asserted on the GRANTs rather than the exit code, as the r24 release
  //    drive is, because the code's last arm probes a live DATABASE_URL.
  // o3d-secops r30: stated for the same reason as above -- this record names `owner`, and the
  // default standing ACL leaves the owner holding CONNECT, which is now a refused MIXED reading.
  const releaser = new FakeAdminClient({ stateFile, releasedDatacl: ACL_UNFENCED, standingDatacl: aclRows([['other', 'c']]) })
  await withAdminUrl(() => doRelease(releaser as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.deepEqual(releaser.grants, [
    'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
    'GRANT CONNECT ON DATABASE "imsdb" TO "owner";',
    'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
  ], `an unstamped record must still be releasable from:\n${releaser.log.join(' | ')}`)

  // MEASURED BY MUTATION, AGAINST THE SHIPPED PROGRAM TEXT. The refusal is one branch, and putting
  // r25's rule back in its place — `standing = true` — is exactly the finding: the legacy record
  // publishes, is stamped RECOVERY, and the same doFence() that refused above proceeds to revoke
  // the whole recorded list. Both halves are asserted, because a mutation that only stopped the
  // refusal would not show what the refusal is FOR.
  const REFUSAL = 'fail("an authority that cannot be shown to be either standing or spent'
  assert.ok(AUTHORISE_PLAN_PROGRAM.includes(REFUSAL),
    `the shipped validator must refuse an unstamped record:\n${AUTHORISE_PLAN_PROGRAM}`)
  const r25Rule = AUTHORISE_PLAN_PROGRAM.replace(REFUSAL, 'standing = true; void ("')
  assert.notEqual(r25Rule, AUTHORISE_PLAN_PROGRAM, 'the mutation must have changed something')
  const lax = join(dir, 'lax.json')
  writeFileSync(lax, `${JSON.stringify(published, null, 2)}\n`)
  const run = spawnSync('node', ['-e', r25Rule, '--', 'imsdb', 'imsapp', lax], {
    input: `${JSON.stringify(record)}\n`,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `the r25 rule publishes where this one refuses:\n${run.stdout}${run.stderr}`)
  assert.equal(JSON.parse(readFileSync(lax, 'utf8')).fence_mode, FENCE_MODE_RECOVERY,
    'and it publishes the RECOVERY mode, which is the tolerance being handed out')
  const laxClient = new FakeAdminClient({ stateFile: lax, datacl: ACL_FENCED, stillConnectsBefore: false })
  const laxCode = await withAdminUrl(() => doFence(laxClient as never, { stateFile: lax, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.equal(laxCode, EXIT_OK, 'under r25 the re-fence proceeds over a fence nothing can show exists')
  assert.equal(laxClient.revokes.length, 3, 'revoking the whole recorded list, which the release then grants back')
})

/**
 * WHO RAISES THE STAMP, AND OFF WHICH STATUSES (o3d-secops r25).
 *
 * The stamp is the only write that ever happens AFTER a REVOKE, so which exit codes earn it is the
 * whole of what "the fence was applied" means. 0 is a fence this run watched go up; 5 is
 * EXIT_FENCE_STANDING, where the COMMIT was issued and the acknowledgement may have been lost, and
 * the only safe reading of unknown is that CONNECT may be revoked. 1 is the helper's catch-all —
 * it covers a connection that never opened AND a `client.end()` that threw after a successful
 * fence — so it may not declare anything applied, and the run says so out loud instead.
 *
 * ROUTE: the shipped db_fence_raise() with the shipped validator, publisher and stamp; the
 * privilege drop stubbed to return the status under test.
 */
test('only a status that means the revokes may be on the medium stamps the record applied (o3d-secops r25)', (t) => {
  const dir = stateDir(t)
  const PLAN = '{"database":"imsdb","owner_role":"owner","app_role":"imsapp","admin_role":"admin","revoked":["PUBLIC","imsapp"],"datacl_before":null,"fenced_at":"2026-01-01T00:00:00.000Z"}'

  const raise = (name: string, fenceRc: number, mutate: (body: string) => string = (b) => b) => {
    const stateFile = join(dir, `${name}.json`)
    const program = [
      'set -uo pipefail',
      shellFunction(CUTOVER_NS_LIB_SOURCE, 'dir_is_private_to_this_run'),
      `db_fence_authorise_plan_program() {\n  cat <<'AUTHORISE_PLAN_EOF'\n${AUTHORISE_PLAN_PROGRAM}AUTHORISE_PLAN_EOF\n}`,
      `db_fence_mark_applied_program() {\n  cat <<'MARK_APPLIED_EOF'\n${MARK_APPLIED_PROGRAM}MARK_APPLIED_EOF\n}`,
      FENCE_DISPLAY_DECLARATIONS,
      shellFunction(FENCE_LIBRARY, 'db_fence_authorise_plan'),
      shellFunction(FENCE_LIBRARY, 'db_fence_mark_authority_applied'),
      shellFunction(FENCE_LIBRARY, 'db_fence_publish_authority'),
      shellFunction(FENCE_LIBRARY, 'db_fence_clear_authority'),
      mutate(shellFunction(FENCE_LIBRARY, 'db_fence_raise')),
      `state=${JSON.stringify(stateFile)}`,
      `fence_rc=${fenceRc}`,
      `db_fence_helper() { shift; case "$*" in *--plan*) printf '%s\\n' ${JSON.stringify(PLAN)}; return 0 ;; *--fence*) return "\${fence_rc}" ;; esac; return 0; }`,
      'db_fence_raise "/nonexistent/fence.mjs" "${state}" --app-database=imsdb --app-user=imsapp; echo "RC=$?"',
      '[[ -e "${state}" ]] && echo "AUTHORITY=PRESENT" || echo "AUTHORITY=GONE"',
      '[[ -e "${state}" ]] && echo "APPLIED=$(node -e \'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fence_applied))\' "${state}")"',
    ].join('\n')
    const run = spawnSync('bash', ['-c', program], { encoding: 'utf8' })
    return `${run.stdout ?? ''}${run.stderr ?? ''}`
  }

  const up = raise('up', 0)
  assert.match(up, /^APPLIED=1$/m, `a fence that went up is recorded as having gone up:\n${up}`)
  assert.match(up, /stamped APPLIED/, `and the stamp announces itself:\n${up}`)

  const maybe = raise('maybe', 5)
  assert.match(maybe, /^AUTHORITY=PRESENT$/m, maybe)
  assert.match(maybe, /^APPLIED=1$/m,
    `a COMMIT whose acknowledgement was lost may be standing, and must be readable as standing:\n${maybe}`)

  // THE ONE THAT DELIBERATELY DOES NOT. Exit 1 cannot tell a connection that never opened from a
  // teardown that threw after a successful fence, so it declares nothing — and the run says what
  // that costs rather than leaving it to be discovered.
  const ambiguous = raise('ambiguous', 1)
  assert.match(ambiguous, /^AUTHORITY=PRESENT$/m,
    `an ambiguous status keeps the record, because the revokes MIGHT be on the medium:\n${ambiguous}`)
  assert.match(ambiguous, /^APPLIED=0$/m,
    `and does not claim a fence was applied, because it cannot show one was:\n${ambiguous}`)
  // AND THE CONSEQUENCE, RUN RATHER THAN DESCRIBED: the next publication over that record is
  // INITIAL, so the next cutover is held to the strict rule and REFUSES rather than tolerating
  // drift on a fence nobody can show exists. That is the direction this fails in.
  const next = raise('ambiguous', 3)
  assert.match(next, /published at .*\(initial\)/,
    `a record no status proved applied may not buy the recovery rule:\n${next}`)

  // MEASURED BY MUTATION, ROUTE STATED, UNDER A REAL SHELL: widen the stamp to "anything that is
  // not the refusal" and exit 1 declares a fence applied that may never have been raised.
  const RAISE = shellFunction(FENCE_LIBRARY, 'db_fence_raise')
  const GUARD = '  if [[ "${rc}" -eq 0 || "${rc}" -eq 5 ]]; then'
  assert.ok(RAISE.includes(GUARD), `the shipped orchestration must enumerate the statuses it stamps for:\n${RAISE}`)
  const widened = raise('widened', 1, (body) => body.replace(GUARD, '  if [[ "${rc}" -ne 3 ]]; then'))
  assert.match(widened, /^APPLIED=1$/m,
    `widened, a catch-all failure declares a fence standing and buys the next run the lax rule:\n${widened}`)
})

test('a record this account could have written is never a record (o3d-secops r23)', async (t) => {
  // THE LOAD-BEARING ONE. A planted fence-state file cannot cause a GRANT.
  //
  // Three plants, three refusals, and the refusal is the same in every case: the record is not
  // read at all. The directory question is asked FIRST and is the more important of the two —
  // `unlink(2)` and `rename(2)` ask for write permission on the PARENT and nothing about the
  // file, so a record's own owner says nothing while its directory is writable by somebody else.
  //
  // MUTATION ROUTE: replace readAuthorityRecord() with readState() in doRelease() — which is
  // exactly what r22 shipped — and every case below GRANTS: the planted grantee list is executed
  // over the admin connection and the run reports "Connection fence released".
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const planted = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'attacker'], state_complete: 1 }

  // 1. THE DIRECTORY IS WRITABLE BY SOMEBODY ELSE. The record itself is impeccable.
  publishAuthority(stateFile, SAMPLE_STATE)
  chmodSync(dir, 0o707)
  const shared = new FakeAdminClient({ stateFile })
  const sharedCode = await withAdminUrl(() => doRelease(shared as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  chmodSync(dir, 0o700)
  assert.notEqual(sharedCode, EXIT_OK, 'a record in a directory anybody may write must never license a release')
  assert.deepEqual(shared.grants, [], 'and NOTHING may be granted')

  // 2. THE RECORD IS NOT THE PUBLISHING ACCOUNT'S. Same bytes, an owner the caller does not claim.
  writeFileSync(stateFile, `${JSON.stringify(planted, null, 2)}\n`)
  const foreign = new FakeAdminClient({ stateFile })
  const foreignCode = await withAdminUrl(() => doRelease(foreign as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }), stateOwnerUid: (process.getuid?.() ?? 0) + 4242,
  }))
  assert.notEqual(foreignCode, EXIT_OK, 'a record the publishing account did not write must never license a release')
  assert.deepEqual(foreign.grants, [], 'and NOTHING may be granted')

  // 3. AND THE SAME AT THE OTHER END — a planted record may not drive a REVOKE either.
  const fencing = new FakeAdminClient({ stateFile })
  const fenceCode = await withAdminUrl(() => doFence(fencing as never, {
    stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }), stateOwnerUid: (process.getuid?.() ?? 0) + 4242,
  }))
  assert.equal(fenceCode, EXIT_NOT_FENCEABLE, 'nor a fence')
  assert.deepEqual(fencing.revokes, [], 'and NOTHING may be revoked')

  // THE PRECONDITION, PROVED RATHER THAN ASSUMED: the same record, with its provenance intact,
  // IS acted on. Without this the three refusals above could be refusals for any other reason.
  //
  // THE PLANT IS CLEARED FIRST, and the reason is r26 rather than tidiness: the validator refuses
  // to publish over a record carrying no `fence_applied` key, and the hand-rolled plant above
  // carries none. On a real host that destination is in a root-only directory and a plant cannot
  // be there at all, so an empty destination is what this precondition is about.
  rmSync(stateFile, { force: true })
  publishAuthority(stateFile, SAMPLE_STATE)
  const genuine = new FakeAdminClient({ stateFile, releasedDatacl: ACL_UNFENCED })
  const genuineCode = await withAdminUrl(() => doRelease(genuine as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
  assert.equal(genuineCode, EXIT_OK, `a record root published must still release:\n${genuine.log.join(' | ')}`)
  assert.deepEqual(genuine.grants, [
    'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
    'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
  ], 'restoring exactly what it names')
})

test('the privileged validator is run with nothing the environment could make it load', () => {
  // ROOT RUNS THIS. `node -e` resolves no module and reads no path out of the program — but
  // NODE_OPTIONS carries `--require`, and NODE_PATH decides where a `require` would look, so an
  // environment variable is a way to make a root-side `node` execute a file nobody named. The
  // variables belong to whatever shell launched the cutover rather than to ${APP_USER}, which is
  // why this is a hardening rather than the finding — and why it is asserted rather than argued.
  //
  // EVERY CALLER IN THE LIBRARY, and the scan is over the FILE rather than over a lifted function:
  // one of the two lives inside the quoted heredoc the operator wrappers are generated from, and a
  // function-shaped lift stops at the first `}` in that heredoc. A rule with one caller exempted
  // is a rule with an exception.
  const code = FENCE_LIBRARY.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  const invocations = [...code.matchAll(/node -e/g)]
  assert.ok(invocations.length >= 2,
    `both the library's own validator call and the copy baked into the wrappers must be here:\n${invocations.length}`)
  for (const at of invocations) {
    assert.match(code.slice(Math.max(0, (at.index ?? 0) - 120), at.index),
      /env -u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE/,
      'every root-side `node -e` in the fence library must strip what the environment could make node load')
  }

  // AND IT IS NOT THEATRE: with the scrub removed, NODE_OPTIONS runs a file of somebody's
  // choosing before the validator's first line. ROUTE: the shipped program, invoked both ways.
  const dir = mkdtempSync(join(tmpdir(), 'ims-node-options-'))
  try {
    const planted = join(dir, 'planted.js')
    writeFileSync(planted, "require('node:fs').writeFileSync(process.env.IMS_TEST_WITNESS, 'ran')\n")
    const witness = join(dir, 'witness')
    const plan = JSON.stringify({ ...SAMPLE_STATE, revoked: ['PUBLIC'] })
    const environment = { ...process.env, NODE_OPTIONS: `--require ${planted}`, IMS_TEST_WITNESS: witness }

    const unscrubbed = spawnSync('node', ['-e', AUTHORISE_PLAN_PROGRAM, '--', 'imsdb', 'imsapp', join(dir, 'rec.json')], {
      input: `${plan}\n`, encoding: 'utf8', env: environment,
    })
    assert.equal(existsSync(witness), true,
      `precondition: NODE_OPTIONS must be able to run a file at all, or this measures nothing:\n${unscrubbed.stderr}`)
    rmSync(witness, { force: true })

    const scrubbed = spawnSync('env', ['-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', '-u', 'NODE_REPL_EXTERNAL_MODULE',
      'node', '-e', AUTHORISE_PLAN_PROGRAM, '--', 'imsdb', 'imsapp', join(dir, 'rec.json')], {
      input: `${plan}\n`, encoding: 'utf8', env: environment,
    })
    assert.equal(existsSync(witness), false,
      `and the shipped invocation must load nothing of the sort:\n${scrubbed.stderr}`)
    assert.equal(scrubbed.status, 0, `while still publishing the authority:\n${scrubbed.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the privileged validator publishes atomically, and leaves the last record alone when it cannot', (t) => {
  // THE DURABILITY ORDERING, WHICH MOVED WITH THE PUBLISHER (o3d-secops r23).
  //
  // Until r23 these three properties belonged to publishState() inside the helper and had three
  // tests of their own; the helper has no publisher any more, so they are asserted where the
  // publication now happens. The ordering is unchanged and is the whole reason the fence is safe:
  // a REVOKE is a committed transaction that outlives a power cut, so the record that undoes it is
  // written to a temporary, fsynced, renamed, and the directory entry fsynced — and a publication
  // that cannot be completed leaves the PREVIOUS record byte for byte rather than a truncation.
  //
  // MEASURED BY MUTATION, ROUTE STATED AND VERIFIED UNDER A REAL SHELL: point the validator's
  // `temporary` at the destination itself and drop the rename — an `openSync(destination, "w")`
  // rather than `openSync(temporary, "wx")` + `renameSync`. The third case below then reports
  // SUCCESS (exit 0) having CLOBBERED the standing record with the refused plan's content, where
  // the shipped program exits 1 and leaves it byte for byte. That is the state a release cannot
  // recover from: the grants it would restore are gone and the REVOKEs are not.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const plan = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] }

  const first = authorisePlan(plan, stateFile, 'imsdb', 'imsapp')
  assert.equal(first.status, 0, `the first publication must succeed:\n${first.output}`)
  const body = readFileSync(stateFile, 'utf8')
  const keys = Object.keys(JSON.parse(body))
  assert.equal(keys[keys.length - 1], 'state_complete',
    `the sentinel must be written LAST, or it proves nothing about the fields above it:\n${body}`)
  assert.deepEqual(readdirSync(dir), ['db-connect-fence.json'], 'and no temporary may be left behind')

  // A SECOND PUBLICATION THAT CANNOT BE COMPLETED. The plan is refused after the destination has
  // been examined and before anything is renamed, so what must survive is the FIRST record.
  const refused = authorisePlan({ ...plan, fenced_at: 'not a timestamp' }, stateFile, 'imsdb', 'imsapp')
  assert.notEqual(refused.status, 0, 'the refused publication must fail')
  assert.equal(readFileSync(stateFile, 'utf8'), body, 'and the last durable record must be untouched')
  assert.deepEqual(readdirSync(dir), ['db-connect-fence.json'], 'with no temporary left behind')

  // AND ONE THAT FAILS AT THE WRITE ITSELF, after validation has passed: the destination
  // directory refuses new entries. Same requirement, on the other side of the checks.
  //
  // ROOT BYPASSES DIRECTORY PERMISSIONS, so as root there is nothing here to refuse and the case
  // would pass while measuring nothing. It is skipped out loud rather than asserted vacuously —
  // the same guard readState()'s unreadable case makes, for the same reason.
  if ((process.getuid?.() ?? 0) === 0) return
  chmodSync(dir, 0o500)
  const unwritable = authorisePlan({ ...plan, revoked: ['something else entirely'] }, stateFile, 'imsdb', 'imsapp')
  chmodSync(dir, 0o700)
  assert.notEqual(unwritable.status, 0, 'a publication that cannot create its temporary must fail, not return quietly')
  assert.match(unwritable.output, /could not be published/, 'and say so')
  assert.equal(readFileSync(stateFile, 'utf8'), body, 'and the last durable record must still be untouched')
  assert.deepEqual(readdirSync(dir), ['db-connect-fence.json'], 'with no temporary left behind')
})

test('the privileged validator rebuilds the record and refuses what it cannot check', (t) => {
  // ROUTE: the shipped db_fence_authorise_plan_program(), run exactly as db_fence_authorise_plan()
  // runs it. It is the only thing that writes the authority, so what it will not accept is the
  // whole of what can ever be in one.
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const plan = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] }

  // THE FIELDS ARE A WHITELIST, NOT A FILTER. Anything the plan carries that the template does
  // not name is dropped — including `undo_sql`, which used to be a second source of truth for the
  // statements a release runs and could disagree with `revoked`.
  const extra = authorisePlan({ ...plan, undo_sql: ['DROP DATABASE "imsdb";'], evil: 'x' }, stateFile, 'imsdb', 'imsapp')
  assert.equal(extra.status, 0, `a valid plan must publish:\n${extra.output}`)
  const published = JSON.parse(readFileSync(stateFile, 'utf8'))
  // `fence_mode` joined the template in o3d-secops r24: root stamps which rule the executor runs
  // the record under, rather than taking it from the request. `fence_applied` joined it in r25 and
  // is what `fence_mode` is now computed FROM — a publication is not a standing fence, and only a
  // record root stamped after the revoke may buy the recovery rule. The sentinel stays last.
  // `cluster_system_identifier` and `cluster_database_oid` joined the template in o3d-secops r28:
  // the fingerprint that says WHICH SERVER this record was written against, so an audit on another
  // cluster with a database of the same name cannot be read as an audit of this one.
  assert.deepEqual(Object.keys(published), ['database', 'owner_role', 'app_role', 'admin_role', 'revoked', 'datacl_before', 'cluster_system_identifier', 'cluster_database_oid', 'fenced_at', 'fence_mode', 'fence_applied', 'state_complete'],
    'the published record is root\'s template, not the request')
  assert.equal(published.fence_applied, 0, 'and a freshly published authority has not been applied to anything yet')
  assert.equal(published.state_complete, STATE_COMPLETE_SENTINEL, 'and it ends with the sentinel the reader requires')

  // AND IT IS CHECKED AGAINST WHAT ROOT SUPPLIED, not against itself.
  const wrongDatabase = authorisePlan(plan, stateFile, 'somewhere-else', 'imsapp')
  assert.notEqual(wrongDatabase.status, 0, 'a plan naming another database must be refused')
  assert.match(wrongDatabase.output, /this run is fencing/, 'and say which two disagreed')

  const wrongRole = authorisePlan(plan, stateFile, 'imsdb', 'someone-else')
  assert.notEqual(wrongRole.status, 0, 'a plan naming another application role must be refused')

  for (const [what, broken] of [
    ['a plan that is not an object', ['PUBLIC']],
    ['a plan with no grantees', { ...plan, revoked: [] }],
    ['a grantee that is not a string', { ...plan, revoked: ['PUBLIC', 7] }],
    ['a grantee carrying a control character', { ...plan, revoked: ['PUBLIC', 'ims\napp'] }],
    ['a duplicate grantee', { ...plan, revoked: ['PUBLIC', 'PUBLIC'] }],
    ['a timestamp that is not one', { ...plan, fenced_at: 'yesterday' }],
  ] as const) {
    const run = authorisePlan(broken, stateFile, 'imsdb', 'imsapp')
    assert.notEqual(run.status, 0, `${what} must be refused:\n${run.output}`)
    assert.match(run.output, /NOT AUTHORISED/, `and say so: ${what}`)
  }

  // AND IT WILL NOT PUBLISH INTO A DIRECTORY SOMEBODY ELSE MAY WRITE, which is the property the
  // whole round rests on: the check is made in the same process that does the rename.
  chmodSync(dir, 0o707)
  const exposed = authorisePlan(plan, stateFile, 'imsdb', 'imsapp')
  chmodSync(dir, 0o700)
  assert.notEqual(exposed.status, 0, 'a group- or other-writable destination must be refused')
  assert.match(exposed.output, /writable by group or other/, 'and name the reason')
})

test('the fence refuses to re-apply a record written for another database', async (t) => {
  // o3d-2sm1.5 r30, Codex CRITICAL (the second half of it). `--release` has asked this since it
  // was written; `--fence` never did, and the re-apply path is where it matters most: an existing
  // record is reused for its GRANTEE LIST, and that list is the set of roles a fence on THAT
  // database took CONNECT from. Aimed at another database it revokes from roles chosen for a
  // different ACL, appends to a record that now claims the wrong database, and leaves the fence
  // the record was written for standing with nothing tracking it. It is the last line of defence
  // under a substituted DATABASE_URL, and it holds even when everything above it was fooled.
  //
  // MUTATION ROUTE (verified by making the change locally and re-running): delete the
  // `existing.database !== facts.database` guard from doFence() and this test fails at the exit
  // code and at `revokes` — the fence re-applies "otherdb"'s grantee list against imsdb.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, { ...SAMPLE_STATE, database: 'otherdb', revoked: ['PUBLIC', 'otherapp'] })
    const before = readFileSync(stateFile, 'utf8')

    // The connection is attached to imsdb — FakeAdminClient reports it as current_database() —
    // and the supplied identity names imsdb too, so every check above this one passes.
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() =>
      doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    )

    assert.equal(code, EXIT_NOT_FENCEABLE, 'a record for another database must abort the fence')
    assert.deepEqual(client.revokes, [], 'and nothing may be revoked on the database it is not the record for')
    assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
    assert.equal(readFileSync(stateFile, 'utf8'), before, "and the other database's record must be left exactly as found")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fence refuses to start a fresh record over one it cannot read', async (t) => {
  // The same absence-read-as-negative defect on the WRITE side: the old readState() collapsed
  // "unusable" into null, and doFence would then publish a fresh record over the only account
  // of what an earlier fence revoked.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    writeFileSync(stateFile, '{ "database": "imsdb", "revoked": ["monitoring"')
    const before = readFileSync(stateFile, 'utf8')

    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_NOT_FENCEABLE, 'an unusable record must abort the fence, not be overwritten')
    assert.deepEqual(client.revokes, [], 'and nothing may be revoked over it')
    assert.equal(readFileSync(stateFile, 'utf8'), before, 'and the unusable record must be left exactly as found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the release side ------------------------------------------------------

test('a lost record is never "nothing to release" while the application is locked out', () => {
  const verdict = assessUnrecordedRelease({
    status: STATE_ABSENT,
    detail: 'no file at that path',
    appRole: 'imsapp',
    stateFile: '/var/lib/one-two-inventory/deploy/db-connect-fence.json',
    appStillConnects: false,
  })
  assert.equal(verdict.exitCode, EXIT_ERROR, 'a fence with no record is a failure, not a success')
  assert.equal(verdict.fenceProvenAbsent, false)
  const text = verdict.lines.join('\n')
  assert.match(text, /A CONNECTION FENCE IS STANDING/, 'and it must say what it found')
  assert.match(text, /GRANT CONNECT ON DATABASE .* TO imsapp;/, 'and give the operator the statement to run')
  assert.match(text, /OTHER grantee/, 'and warn that other recorded grantees are locked out with no record either')
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r12, HIGH) — ONE ROLE'S CONNECT IS NOT EVERY GRANTEE'S.
//
// r11 made the unrecorded release ASK the database instead of reading a missing file as an
// answer, and then over-read the answer it got: has_database_privilege(appRole, ...) speaks
// for exactly ONE role, while the fence revokes CONNECT from EVERY grantee that held it
// directly. The application can be back inside through PUBLIC, through role membership or
// through a manual grant while monitoring, backup, BI or a second application is still shut
// out by the same fence — and doFence() PRODUCES that shape on purpose, rejecting a fence the
// application survives through membership and leaving the revokes standing. So the branch
// contradicted a rule its own file enforces elsewhere.
// ---------------------------------------------------------------------------

test('an application role that connects is not proof that the fence is gone, only that it is back inside', () => {
  const verdict = assessUnrecordedRelease({
    status: STATE_ABSENT,
    appRole: 'imsapp',
    stateFile: '/var/lib/one-two-inventory/deploy/db-connect-fence.json',
    appStillConnects: true,
    // The application's own connection, observed rather than inferred (r13). Without it there is
    // no "the application connects" to be bounded, and the verdict is a different refusal.
    connectedDatabase: 'imsdb',
    appConnection: { attempted: true, connected: true, database: 'imsdb', error: '' },
  })
  // MUTATION ROUTE: put `exitCode: EXIT_OK, fenceProvenAbsent: true` back into the
  // appStillConnects branch of assessUnrecordedRelease() and both assertions below fail.
  assert.equal(
    verdict.exitCode,
    EXIT_FENCE_UNPROVEN,
    'the application connecting says nothing about PUBLIC, monitoring, backup, BI or a second application',
  )
  assert.notEqual(verdict.exitCode, EXIT_OK, 'and it is never a success')
  assert.equal(verdict.fenceProvenAbsent, false, 'nothing here proves a fence absent')
  assert.equal(verdict.appRoleConnects, true, 'the one thing it may claim, it claims')
  const text = verdict.lines.join('\n')
  assert.match(text, /ONLY THING THIS RUN CAN PROVE/, 'the claim must be bounded out loud')
  assert.match(text, /role membership/, 'and name the route by which the application gets back in')
  assert.match(text, /SELECT datacl FROM pg_database/, 'and hand over the ACL audit it is demanding')
})

test('an unusable record is left in place, and is still not a released fence', () => {
  const verdict = assessUnrecordedRelease({
    status: STATE_CORRUPT,
    detail: 'the record is not valid JSON',
    appRole: 'imsapp',
    stateFile: '/var/lib/one-two-inventory/deploy/db-connect-fence.json',
    appStillConnects: true,
    connectedDatabase: 'imsdb',
    appConnection: { attempted: true, connected: true, database: 'imsdb', error: '' },
  })
  // MUTATION ROUTE: as above — EXIT_OK in that branch fails the first assertion.
  assert.equal(verdict.exitCode, EXIT_FENCE_UNPROVEN)
  assert.match(verdict.lines.join('\n'), /left at .* for inspection/, 'a corrupt record is evidence, not litter')
})

test('a release with no role to ask about refuses rather than reporting success', () => {
  const verdict = assessUnrecordedRelease({
    status: STATE_ABSENT,
    appRole: '',
    stateFile: '/var/lib/one-two-inventory/deploy/db-connect-fence.json',
    appStillConnects: false,
  })
  assert.equal(verdict.exitCode, EXIT_ERROR, 'with nothing to ask about, nothing can be proven')
  assert.match(verdict.lines.join('\n'), /--app-role/, 'and it must say how to make the question answerable')
})

test('--release over a lost record grants nothing and fails, rather than reporting nothing to release', async (t) => {
  // The behavioural half: the record is gone, the database says the application cannot
  // connect. The old code printed "No connection fence is recorded; nothing to release." and
  // exited 0 here.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile, stillConnectsBefore: false })
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_ERROR, 'a release that cannot prove the database is open must fail')
    assert.deepEqual(client.grants, [], 'and it must not guess at grants it has no record of')
    assert.ok(
      client.log.some((sql) => sql.includes('AS still_connects')),
      'it must ASK the database, which is where the durable half of the fence lives',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--release over a lost record refuses even when the application connects, because another revoked grantee may still be out', async (t) => {
  // THE SHAPE doFence() ITSELF LEAVES BEHIND (o3d-2sm1.5, Codex r12 HIGH). The fence revoked
  // CONNECT from PUBLIC and from `monitoring`; the application kept it through role membership,
  // so doFence() rejected the fence as ineffective and DELIBERATELY left the revokes standing.
  // The datacl below is that state: imsapp connects, PUBLIC and monitoring do not. Then the
  // record is lost. Reading has_database_privilege('imsapp') as "no fence is standing" reports
  // success over two revocations nobody will ever undo.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({
      stateFile,
      stillConnectsBefore: true,
      datacl: aclRows([['owner', 'CTc'], ['', 'T'], ['imsapp', 'c']]),
      releasedDatacl: aclRows([['owner', 'CTc'], ['', 'T'], ['imsapp', 'c']]),
    })
    const code = await withAdminUrl(() =>
      doRelease(client as never, {
        stateFile,
        appRole: 'imsapp',
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        // The application's own connection succeeds — this is the state where BOTH halves agree
        // that imsapp is back inside, and it is STILL not a released fence (r13 kept r12 whole).
        probeApplication: async () => ({ attempted: true, connected: true, database: 'imsdb', error: '' }),
      } as never),
    )

    // MUTATION ROUTE: restore `exitCode: EXIT_OK` in the appStillConnects branch of
    // assessUnrecordedRelease() and the first two assertions fail together.
    assert.equal(code, EXIT_FENCE_UNPROVEN, 'the application being back inside is not the fence being gone')
    assert.notEqual(code, EXIT_OK, 'and nothing about this state may exit 0')
    assert.deepEqual(client.grants, [], 'and with no record there is nothing it may grant back')
    assert.ok(
      client.log.some((sql) => sql.includes('AS still_connects')),
      'it must still ASK the database rather than read the missing file as an answer',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--release restores exactly the recorded grantees when the record survived', async (t) => {
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, SAMPLE_STATE)
    const client = new FakeAdminClient({
      stateFile,
      releasedDatacl: ACL_UNFENCED,
    })
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_OK)
    assert.deepEqual(client.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ])
    // o3d-secops r23: THIS PROCESS DOES NOT REMOVE THE RECORD. An unlink is a write to the
    // directory, and that directory is root's. Root clears it — db_fence_clear_authority(), called
    // by every entrypoint AFTER a verified release — and until then the record describes a fence
    // that has been released, which is the safe way round: a `--fence` over it re-applies the same
    // grantee list, a second `--release` re-grants what is already granted, and removing it first
    // would lose the only account of what was revoked.
    assert.equal(existsSync(stateFile), true, 'the executor must not unlink a record it cannot write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r13, CRITICAL) — THE ANSWER WAS NEVER BOUND TO THE APPLICATION'S DATABASE.
//
// Every mode but --print-migration-url connects through DEPLOY_ADMIN_DATABASE_URL when it is
// set, and then asks its questions of current_database() ON THAT CONNECTION while taking the
// ROLE from DATABASE_URL. Nothing checked that the two were the same place. Point the admin URL
// at another database on which the application role happens to hold CONNECT — a copy, a
// `postgres` maintenance database, a staging URL left in the environment — and `--release`
// answers "the application can connect" about a database the application never uses, exits 4,
// and the caller permits startup while the real database still denies CONNECT. The health route
// does not touch the database, so the deploy reports success with the application locked out.
//
// Same class as asking the right question of the wrong object. The binding is proven from two
// directions, and each of these tests isolates ONE of them so that removing it fails one test.
// ---------------------------------------------------------------------------

test('an admin URL naming a different database from DATABASE_URL is refused even when this connection landed correctly', () => {
  // MUTATION ROUTE: delete the `admin.database !== app.database` arm from
  // assessDatabaseIdentity() and this returns bound. The live check below cannot cover it: the
  // migration runs through a SEPARATE connection composed from the admin URL, so two URLs that
  // disagree are a refusal on their own merits, whatever this particular connection reached.
  const verdict = assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@localhost:5432/onetwo3d_ims_copy',
    app: suppliedIdentity(),
    connectedDatabase: 'onetwo3d_ims',
  })

  assert.equal(verdict.bound, false, 'two URLs naming different databases are not one database')
  assert.match(verdict.reason, /onetwo3d_ims_copy/, 'and the refusal must name both')
  assert.match(verdict.reason, /onetwo3d_ims"/)
})

test('an admin URL on a different server is refused rather than assumed to be the same host renamed', () => {
  // MUTATION ROUTE: delete the `admin.server !== app.server` arm and this returns bound. A
  // privilege read on one server says nothing whatever about another.
  const verdict = assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@db-old.internal:5432/onetwo3d_ims',
    app: suppliedIdentity({ appHost: 'db-new.internal' }),
    connectedDatabase: 'onetwo3d_ims',
  })

  assert.equal(verdict.bound, false, 'the same database name on two servers is two databases')
  assert.match(verdict.reason, /db-old\.internal/)
  assert.match(verdict.reason, /db-new\.internal/)
})

test('a connection attached to a database neither URL asked for is refused', () => {
  // The admin URL with NO database in its path — it connects to the login role's own default
  // database, and both URLs look fine while the connection is somewhere else entirely. This is
  // the case a URL comparison cannot see at all.
  //
  // MUTATION ROUTE: delete the `connectedDatabase !== app.database` arm and this returns bound.
  const verdict = assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@localhost:5432/',
    app: suppliedIdentity(),
    connectedDatabase: 'deployadmin',
  })

  assert.equal(verdict.bound, false, 'the live attachment is the half a URL cannot prove')
  assert.match(verdict.reason, /deployadmin/)
})

test('a loopback address, localhost and a unix socket are the same machine, and are not refused', () => {
  // The control on the control: a check that refuses every legitimate configuration gets turned
  // off, and then it protects nothing.
  //
  // MUTATION ROUTE: compare the host strings as written — drop the LOCAL_HOSTS/socket family in
  // parseConnectionIdentity() — and both of these are refused.
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@127.0.0.1:5432/onetwo3d_ims',
      app: suppliedIdentity(),
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    true,
  )
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgresql:///onetwo3d_ims?host=/var/run/postgresql',
      app: suppliedIdentity(),
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    true,
    'a socket directory and localhost are the same server on the same default port',
  )
  // And the port still separates two clusters on that one machine.
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5433/onetwo3d_ims',
      app: suppliedIdentity(),
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    false,
  )
})

test('nothing to bind to is not a pass: a missing or partial supplied identity is refused', () => {
  // ROUTE: --app-host/--app-port/--app-user/--app-database -> requireSuppliedIdentity() ->
  // assessDatabaseIdentity(), which is what licenses every fence, release and printed URL.
  //
  // MUTATION ROUTE: return { bound: true } when nothing was supplied — the "there is nothing to
  // check, so it must be fine" reading, which is what an unset variable used to produce — and
  // every assertion here fails.
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost:5432/imsdb', app: {}, connectedDatabase: 'imsdb' }).bound,
    false,
    'no identity at all is not "any identity will do"',
  )
  // THREE OF FOUR IS NOT AN IDENTITY, and each one is named in the refusal so the caller knows
  // which of its own values was empty.
  for (const [option, key] of [['--app-host', 'appHost'], ['--app-port', 'appPort'], ['--app-user', 'appUser'], ['--app-database', 'appDatabase']] as const) {
    const verdict = assessDatabaseIdentity({
      ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
      app: suppliedIdentity({ appDatabase: 'imsdb', [key]: '' }),
      connectedDatabase: 'imsdb',
    })
    assert.equal(verdict.bound, false, `${option} is required`)
    assert.ok(verdict.reason.includes(option), `${option} is named in the refusal`)
  }
  // AND A BLANK IS A MISSING VALUE, not a default: `--app-host=` is the shape an unset shell
  // variable takes when a caller interpolates it, and reading it as `localhost` is exactly the
  // guess this round removed.
  assert.equal(requireSuppliedIdentity(suppliedIdentity({ appHost: '   ' })).ok, false)
  assert.equal(parseConnectionIdentity('not a url at all').ok, false)
})

/**
 * The admin URL and the SUPPLIED identity do NOT agree — the two-database configuration, at the
 * wire. The application half is now `MISMATCHED_IDENTITY` on the options, not a URL in the
 * environment (o3d-2sm1.5 r19); the environment is set here only because `--release`'s probe
 * still opens DATABASE_URL as a credential.
 */
const MISMATCHED_IDENTITY = { appHost: 'localhost', appPort: '5432', appUser: 'imsapp', appDatabase: 'onetwo3d_ims' }

async function withMismatchedUrls<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  // The fake answers current_database() = 'imsdb', i.e. the admin URL's target — the database on
  // which imsapp holds CONNECT. The application itself uses onetwo3d_ims, and nothing here can
  // say anything at all about that one.
  process.env.DEPLOY_ADMIN_DATABASE_URL = 'postgres://deployadmin@localhost/imsdb'
  process.env.DATABASE_URL = 'postgres://imsapp@localhost/onetwo3d_ims'
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previous
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
}

test('the fence revokes nothing when the admin connection is not the application\'s database', (t) => {
  // TWO DATABASES, and the role connects only to the admin URL's target. Fencing here would lock
  // other people's clients out of somewhere else while the application went on writing across
  // the migration, and every verification would be a truthful report about the wrong database.
  //
  // MUTATION ROUTE: remove the requireBoundDatabaseIdentity() call from doFence() and this
  // fences 'imsdb' and returns EXIT_OK with three REVOKEs on the wire.
  const dir = stateDir(t)
  return (async () => {
    try {
      const stateFile = join(dir, 'db-connect-fence.json')
      const client = new FakeAdminClient({ stateFile })
      const code = await withMismatchedUrls(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...MISMATCHED_IDENTITY }))

      assert.equal(code, EXIT_NOT_FENCEABLE, 'a database that cannot be shown to be the right one is not fenceable')
      assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked on it')
      assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
      assert.equal(existsSync(stateFile), false, 'and no record may claim a fence over it')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
})

test('a release over an unbound connection restores nothing, however good its record looks', async (t) => {
  // The record is PRESENT and valid, so nothing downstream would ever question this release: it
  // would GRANT CONNECT on 'imsdb' — the admin URL's target, where imsapp already connects —
  // report "released", and let the caller start an application whose own database, onetwo3d_ims,
  // this run has never asked about and cannot ask about.
  //
  // MUTATION ROUTE: remove the requireBoundDatabaseIdentity() call from doRelease() and this
  // returns EXIT_OK with two GRANTs on the wire.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, SAMPLE_STATE)
    const client = new FakeAdminClient({ stateFile, releasedDatacl: ACL_UNFENCED })
    const code = await withMismatchedUrls(() => doRelease(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...MISMATCHED_IDENTITY }))

    assert.equal(code, EXIT_ERROR, 'an unidentified database is a refusal, not a release')
    assert.notEqual(code, EXIT_OK, 'and above all not a success')
    assert.deepEqual(client.grants, [], 'and nothing may be granted on it')
    assert.equal(existsSync(stateFile), true, 'the record survives: this fence has not been released by anyone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a release refuses when the record it holds was written for another database', async (t) => {
  // The other half of the same question: the URLs agree, and the RECORD is from somewhere else —
  // a state file left by a run against a different database. Releasing from here would restore
  // grants recorded elsewhere, named by a database this connection is not attached to.
  //
  // MUTATION ROUTE: delete the `state.database !== connectedDatabase` arm from doRelease() and
  // this returns EXIT_OK, having granted on "elsewhere".
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishAuthority(stateFile, { ...SAMPLE_STATE, database: 'elsewhere' })
    const client = new FakeAdminClient({ stateFile, connectedDatabase: 'imsdb' })
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_ERROR)
    assert.deepEqual(client.grants, [], 'nothing recorded somewhere else may be restored from here')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unrecorded release proves "the application can connect" by connecting as the application', () => {
  // The privilege read is taken over the admin connection and answers about the admin
  // connection's database. The application uses DATABASE_URL. When the two disagree — the read
  // says CONNECT, the application's own URL is refused — the disagreement IS the finding, and it
  // must be fatal: the caller is otherwise about to start an application on the weaker answer.
  //
  // MUTATION ROUTE: drop the `!appConnection.connected` arm from assessUnrecordedRelease() (or
  // stop passing the probe from releaseWithoutRecord) and this returns 4.
  return (async () => {
    const client = new FakeAdminClient({ stillConnectsBefore: true })
    let probed = ''
    const code = await withAdminUrl(() =>
      doRelease(client as never, {
        stateFile: '',
        appRole: '',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        probeApplication: async (connectionString: string) => {
          probed = connectionString
          return { attempted: true, connected: false, database: '', error: 'FATAL: permission denied for database "imsdb"' }
        },
      } as never),
    )

    assert.equal(probed, 'postgres://imsapp@localhost/imsdb', 'the probe must use DATABASE_URL, not the admin URL')
    assert.equal(code, EXIT_ERROR, 'a privilege read the application itself contradicts is fatal')
    assert.deepEqual(client.grants, [], 'and nothing is restored on the strength of it')
  })()
})

test('an unrecorded release refuses when the application lands on a different database from this run', () => {
  // MUTATION ROUTE: drop the `appConnection.database !== connectedDatabase` arm and this returns
  // 4 — "the application can connect", about a database it never uses.
  return (async () => {
    const client = new FakeAdminClient({ stillConnectsBefore: true, connectedDatabase: 'imsdb' })
    const code = await withAdminUrl(() =>
      doRelease(client as never, {
        stateFile: '',
        appRole: '',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        probeApplication: async () => ({ attempted: true, connected: true, database: 'onetwo3d_ims', error: '' }),
      } as never),
    )

    assert.equal(code, EXIT_ERROR, 'two connections on two databases cannot speak for each other')
  })()
})

test('an unrecorded release still refuses to call a fence released when the application does connect', () => {
  // THE CONTROL THAT MUST SURVIVE (r12): even with both halves agreeing, "the application can
  // connect" is never promoted to "no fence is standing" — PUBLIC, monitoring, backup, BI and a
  // second application may still be revoked by the same fence, and no record names them.
  //
  // MUTATION ROUTE: return EXIT_OK (or EXIT_ERROR) from that branch and this fails.
  return (async () => {
    const client = new FakeAdminClient({ stillConnectsBefore: true, connectedDatabase: 'imsdb' })
    const code = await withAdminUrl(() =>
      doRelease(client as never, {
        stateFile: '',
        appRole: '',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        probeApplication: async () => ({ attempted: true, connected: true, database: 'imsdb', error: '' }),
      } as never),
    )

    assert.equal(code, EXIT_FENCE_UNPROVEN, 'proven connectivity is still not proof that no fence stands')
    assert.deepEqual(client.grants, [], 'and it grants nothing')
  })()
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r13, HIGH) — AN EXIT CODE IS NOT EVIDENCE ABOUT WHAT WAS COMMITTED.
//
// doFence() COMMITS its REVOKEs and then asks whether the door is actually shut. When the
// application keeps CONNECT through role membership, or the room will not go quiet, it
// deliberately LEAVES THEM STANDING so nothing is half-applied — and reported that with the same
// EXIT_ERROR a failure that revoked nothing returns. The callers raise their sticky "this run
// raised a fence" flag only on exit 0, so a run holding PUBLIC, monitoring and BI out was
// recorded as one with no fence to its name.
//
// EXIT_FENCE_STANDING means one thing: the revokes are committed and in force.
// ---------------------------------------------------------------------------

test('a fence that committed its revokes and could not shut the application out says the fence is STANDING', async (t) => {
  // MUTATION ROUTE: return EXIT_ERROR from the ineffective-fence branch of completeFence() and
  // this fails — which is the state the entrypoints could not distinguish.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // o3d-secops r23: the authority is published by ROOT before `--fence` is invoked; this
    // process executes it and never writes it. The fixture publishes it through the same
    // validator root uses.
    publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
    const client = new FakeAdminClient({ stateFile, stillConnectsAfter: true })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_FENCE_STANDING, 'the revokes are committed, so this is not "the fence failed"')
    assert.notEqual(code, EXIT_ERROR, 'and not the code a fence that revoked nothing returns')
    // Precondition: this really is the post-commit side.
    assert.ok(client.log.includes('COMMIT'), 'the transaction must have committed for this to be about a standing fence')
    assert.equal(client.revokes.length, 3, 'and the revokes must be on the wire')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fence whose room will not go quiet says the fence is STANDING', async (t) => {
  // MUTATION ROUTE: return EXIT_ERROR from the drain refusal and this fails.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // o3d-secops r23: the authority is published by ROOT before `--fence` is invoked.
    publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
    const client = new FakeAdminClient({
      stateFile,
      attached: [{ pid: 4242, application_name: 'psql', usename: 'someone' }],
    })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_FENCE_STANDING, 'CONNECT is revoked and standing; the drain is what failed')
    assert.ok(client.log.includes('COMMIT'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an error thrown AFTER the commit is a standing fence, not an exception the caller must classify', async (t) => {
  // A throw from any post-commit read used to escape doFence() entirely and reach main()'s
  // catch, which exits 1 — indistinguishable from a fence that revoked nothing, over a database
  // whose CONNECT had just been taken away.
  //
  // MUTATION ROUTE: remove the try/catch around completeFence() and this rejects instead of
  // returning, failing the test.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // o3d-secops r23: the authority is published by ROOT before `--fence` is invoked; this
    // process executes it and never writes it. The fixture publishes it through the same
    // validator root uses.
    publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
    const client = new FakeAdminClient({ stateFile, throwAfterCommit: 'server closed the connection unexpectedly' })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_FENCE_STANDING, 'a throw after COMMIT is still a database with a fence on it')
    assert.ok(client.log.includes('COMMIT'), 'precondition: the revokes committed before the failure')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r14) — THE CONNECTION NODE-POSTGRES WILL REALLY OPEN.
//
//   CRITICAL  the identity proof compared the URL's AUTHORITY. pg-connection-string, which pg
//             uses, copies the QUERY STRING into the config first and fills host/port/user from
//             the authority only if the query left them unset — so `?host=`, `?port=` and
//             `?user=` redirect the connection. The proof passed while the application connected
//             to another cluster, as another role, and went on writing across the migration.
//
// The parse is one half. The other is that the role is now ASKED OF THE CONNECTION —
// session_user and current_user — because PGUSER, a .pgpass entry, an ident map and
// `options=-c role=` are all outside any URL.
// ---------------------------------------------------------------------------

test('a query parameter that redirects the ADMIN connection is what the driver uses, so it is what is compared', () => {
  // THE FINDING'S OWN URL, now on the half that is still a URL. The application's host, port,
  // role and database are SUPPLIED (o3d-2sm1.5 r19) and nothing derives them; the admin URL is
  // the connection THIS process opens, so `pg`'s own resolution of it is the right one — and its
  // authority and path can still say localhost:5432/onetwo3d_ims while the query string is where
  // node-postgres actually goes.
  //
  // ROUTE: DEPLOY_ADMIN_DATABASE_URL -> parseConnectionIdentity() -> resolveDriverIdentity() ->
  // the `admin.server !== appServer` arm of assessDatabaseIdentity().
  //
  // MUTATION ROUTE: restore the original parse — read the authority first
  // (`url.hostname || params.get('host')`) AND drop the conflict refusal. This then returns
  // bound: the admin URL looks like localhost:5432 while the privileged connection is on
  // remote.example:6432, and the fence proves itself against a cluster nobody uses.
  const redirected = assessDatabaseIdentity({
    ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@localhost:5432/onetwo3d_ims?host=remote.example&port=6432',
    app: suppliedIdentity(),
    connectedDatabase: 'onetwo3d_ims',
  })
  assert.equal(redirected.bound, false, 'the query string is where this connection actually goes')
  assert.match(redirected.reason, /remote\.example/)

  // And with nothing in the authority to disagree with — `postgres://role@/db?host=...`, the
  // libpq form WHATWG URL rejects and node-postgres accepts by retrying with a dummy host — the
  // query values are simply what this connection IS: resolved and compared as remote.example:6432
  // rather than refused as unreadable.
  const identity = parseConnectionIdentity('postgres://deployadmin@/onetwo3d_ims?host=remote.example&port=6432')
  assert.equal(identity.ok, true, 'a URL the driver connects with must not be refused as unparseable')
  assert.equal(identity.host, 'remote.example')
  assert.equal(identity.port, '6432')
  assert.equal(identity.server, 'remote.example:6432')
  const viaQueryOnly = assessDatabaseIdentity({
    ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@/onetwo3d_ims?host=remote.example&port=6432',
    app: suppliedIdentity(),
    connectedDatabase: 'onetwo3d_ims',
  })
  assert.equal(viaQueryOnly.bound, false)
  assert.match(viaQueryOnly.reason, /remote\.example:6432/, 'and the refusal names where it really goes')
})

test('a query parameter that redirects the ROLE is the role the fence would have to revoke', () => {
  // `?user=` is what node-postgres authenticates as; the authority username is a decoration it
  // never reaches. The fence revokes CONNECT from the application role and verifies with
  // has_database_privilege() against it, so reading the wrong one fences a role nobody uses.
  //
  // MUTATION ROUTE: return `url.username` from parseRoleFromConnectionString() and this returns
  // '' for the query-only form and the authority name for the conflicting one.
  assert.equal(parseRoleFromConnectionString('postgres://@localhost:5432/onetwo3d_ims?user=actual'), 'actual')
  assert.equal(parseRoleFromConnectionString('postgres://imsapp@localhost:5432/onetwo3d_ims'), 'imsapp')
  // And a URL that names two different roles is refused outright rather than resolved, so no
  // caller gets a role at all — which every caller treats as a refusal.
  assert.equal(parseRoleFromConnectionString('postgres://app@localhost:5432/onetwo3d_ims?user=actual'), '')
})

test('a URL that disagrees with itself about host, port or role is refused, not resolved', () => {
  // MUTATION ROUTE: drop the authority/query conflict loop and each of these becomes ok, silently
  // resolving to the query value — which is the driver's answer, but "probably what they meant"
  // is the reasoning this whole check exists to stop.
  for (const url of [
    'postgres://imsapp@localhost:5432/onetwo3d_ims?host=remote.example',
    'postgres://imsapp@localhost:5432/onetwo3d_ims?port=6432',
    'postgres://imsapp@localhost:5432/onetwo3d_ims?user=actual',
  ]) {
    const identity = parseConnectionIdentity(url)
    assert.equal(identity.ok, false, `${url} names two different things and must be refused`)
    assert.match(identity.reason, /query string/)
  }
  // An EMPTY parameter is not a disagreement: the driver falls back to the authority, and so does
  // this. The control on the control — a check that refuses valid URLs gets turned off.
  assert.equal(parseConnectionIdentity('postgres://imsapp@localhost:5432/onetwo3d_ims?host=').host, 'localhost')
})

test('a ?dbname= that names a database the driver ignores is refused rather than believed', () => {
  // node-postgres overwrites config.database from the pathname UNCONDITIONALLY, so this parameter
  // does nothing at all — and a false statement about WHICH DATABASE is the subject of this gate.
  //
  // MUTATION ROUTE: delete the dbname/database loop and this returns ok with database 'imsdb',
  // the operator believing the connection lands on onetwo3d_ims.
  const identity = parseConnectionIdentity('postgres://imsapp@localhost/imsdb?dbname=onetwo3d_ims')
  assert.equal(identity.ok, false)
  assert.match(identity.reason, /IGNORES/)
  // The same name in both places is not a disagreement and is allowed through.
  assert.equal(parseConnectionIdentity('postgres://imsapp@localhost/imsdb?dbname=imsdb').ok, true)
})

test('the role half is asked of the connection: what it logged in as, and what it is running as', () => {
  // MUTATION ROUTE: delete the connectedLoginRole arms from assessDatabaseIdentity() and all
  // three of these return bound.
  const base = {
    adminUrl: 'postgres://deployadmin@localhost/onetwo3d_ims',
    app: suppliedIdentity(),
    connectedDatabase: 'onetwo3d_ims',
  }

  // A connection that will not say what it logged in as cannot be shown to be the one whose
  // CONNECT is deliberately NOT revoked. Absence is not a pass — and it is not a pass even when
  // there is nothing else left to catch it: an admin URL relying on peer authentication names no
  // role either, so with the connection silent too NOTHING identifies the role being held.
  assert.equal(assessDatabaseIdentity({ ...base, connectedLoginRole: '', connectedEffectiveRole: 'deployadmin' }).bound, false)
  const silent = assessDatabaseIdentity({
    ...base,
    adminUrl: 'postgres://localhost/onetwo3d_ims',
    connectedLoginRole: '',
    connectedEffectiveRole: '',
  })
  assert.equal(silent.bound, false, 'no role from the URL and none from the connection is not "any role will do"')
  assert.match(silent.reason, /session_user/)

  // Running as somebody other than it logged in as: every ACL answer below would be given as the
  // assumed role while CONNECT belongs to the login one.
  const assumed = assessDatabaseIdentity({ ...base, connectedLoginRole: 'deployadmin', connectedEffectiveRole: 'imsapp' })
  assert.equal(assumed.bound, false)
  assert.match(assumed.reason, /SET ROLE/)

  // The URL says one role and the connection logged in as another — PGUSER, .pgpass, an ident map.
  const elsewhere = assessDatabaseIdentity({ ...base, connectedLoginRole: 'postgres', connectedEffectiveRole: 'postgres' })
  assert.equal(elsewhere.bound, false)
  assert.match(elsewhere.reason, /deployadmin/)
  assert.match(elsewhere.reason, /postgres/)

  // And the ordinary configuration still passes.
  assert.equal(assessDatabaseIdentity({ ...base, ...ATTACHED_AS_ADMIN }).bound, true)
})

test('the fence revokes nothing when the SUPPLIED identity is not the cluster this connection is on', async (t) => {
  // THE WHOLE FINDING, AT THE WIRE, ON THE NEW SHAPE. The admin URL reaches localhost:5432/imsdb;
  // the caller says the application is on remote.example:6432. Fencing here would lock other
  // people's clients out of THIS cluster while the application keeps writing to remote.example
  // across the migration. It is refused BEFORE anything is revoked, committed or recorded.
  //
  // ROUTE: --app-host/--app-port -> requireBoundDatabaseIdentity() in doFence() ->
  // assessDatabaseIdentity()'s `admin.server !== appServer` arm.
  //
  // MUTATION ROUTE: delete that arm (or the requireBoundDatabaseIdentity() call from doFence())
  // and this fence proceeds — client.revokes stops being empty, COMMIT appears in the log and the
  // record is published.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() =>
      doFence(client as never, {
        stateFile,
        appRole: 'imsapp',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appHost: 'remote.example', appPort: '6432', appDatabase: 'imsdb' }),
      }),
    )

    assert.equal(code, EXIT_NOT_FENCEABLE)
    assert.deepEqual(client.revokes, [], 'nothing may be revoked on a cluster the application does not use')
    assert.ok(!client.log.includes('COMMIT'), 'and no transaction may commit')
    assert.equal(existsSync(stateFile), false, 'and no record may be published for a fence that never happened')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fence revokes nothing when the connection logged in as a role the admin URL does not name', async (t) => {
  // MUTATION ROUTE: delete the admin.user vs connectedLoginRole arm and this fence proceeds,
  // excluding 'deployadmin' from the revoke while the connection it must keep is 'postgres' —
  // which is how a fence locks out the very connection that would release it.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile, loginRole: 'postgres', effectiveRole: 'postgres' })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_NOT_FENCEABLE)
    assert.deepEqual(client.revokes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r14) — A LOST ACKNOWLEDGEMENT IS NOT A NEGATIVE ANSWER.
//
//   HIGH  the post-commit protection began only after `await client.query('COMMIT')` RESOLVED.
//         PostgreSQL can commit the REVOKEs and then lose the connection before the
//         acknowledgement arrives; the promise rejects, the old code rolled back into thin air
//         and threw, main() exited 1 — and all three entrypoints, which raise the sticky
//         DB_FENCE_RAISED only on exits 0 and 5, recorded a run with no fence to its name over a
//         database whose CONNECT may be revoked from PUBLIC, monitoring, backup, BI and a second
//         application. The boundary is now the moment COMMIT is ISSUED.
// ---------------------------------------------------------------------------

test('a COMMIT whose acknowledgement never arrives is a fence that MAY BE STANDING, not one that did not happen', async (t) => {
  // MUTATION ROUTE: move `commitIssued = true` to after the COMMIT await — the old boundary — and
  // this test rejects instead of returning, because the catch rethrows.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // o3d-secops r23: the authority is published by ROOT before `--fence` is invoked; this
    // process executes it and never writes it. The fixture publishes it through the same
    // validator root uses.
    publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
    const client = new FakeAdminClient({ stateFile, failCommitAck: 'Connection terminated unexpectedly' })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_FENCE_STANDING, 'unknown must not be reported as the not-committed case')
    assert.notEqual(code, EXIT_ERROR, 'and exit 1 is the code the entrypoints read as "no fence was raised"')
    // Precondition: this really is the lost-acknowledgement path — the revokes and the COMMIT were
    // both put on the wire, and only the answer went missing.
    assert.equal(client.revokes.length, 3, 'the revokes must have been sent for this to be about a possible fence')
    assert.ok(client.log.includes('COMMIT'), 'and the COMMIT must have been issued')
    // No rollback: a transaction that has been told to commit is not one this run can take back,
    // and a ROLLBACK here would only make the log claim it undid something.
    assert.ok(!client.log.includes('ROLLBACK'), 'nothing may claim to have undone a commit whose fate is unknown')
    // The record is the only account of what may now be revoked, so it stays.
    assert.equal(existsSync(stateFile), true, 'the undo record must survive the failure that made it necessary')
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).revoked, ['PUBLIC', 'owner', 'imsapp'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failure BEFORE the COMMIT is issued still rolls back and still reports a fence that never happened', async (t) => {
  // The control on the control (o3d-2sm1.5): if every failure became EXIT_FENCE_STANDING, the
  // code would stop meaning anything and every aborted run would send an operator hunting for a
  // fence that is not there.
  //
  // MUTATION ROUTE: drop the `if (!commitIssued)` guard and this stops throwing.
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    class RefusingClient extends FakeAdminClient {
      override async query(text: string) {
        if (String(text).trim().startsWith('REVOKE')) throw new Error('permission denied for database imsdb')
        return super.query(text)
      }
    }
    // o3d-secops r23: the authority is published by ROOT before `--fence` is invoked.
    publishAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] })
    const client = new RefusingClient({ stateFile })
    await assert.rejects(
      () => withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) })),
      /permission denied/,
      'a revoke that was refused is a fence that demonstrably did not happen',
    )
    assert.ok(client.log.includes('ROLLBACK'), 'and the transaction it opened is rolled back')
    assert.ok(!client.log.includes('COMMIT'), 'precondition: nothing was ever told to commit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r15) — A REPEATED PARAMETER REDIRECTS THE DRIVER.
//
//   CRITICAL  the identity proof read the query with URLSearchParams.get(), which returns the
//             FIRST value. pg-connection-string iterates every entry into ONE config object, so
//             the LAST duplicate wins. `?host=local&host=remote` was proven here as `local` and
//             connected to `remote`.
//
// These tests ask the INSTALLED PARSER what it does rather than restating what it is believed to
// do — both r14 and r15 exist because a hand-rolled copy of libpq's rules disagreed with libpq.
// ---------------------------------------------------------------------------

test('a repeated identity parameter is refused, because the driver keeps the LAST and every reader sees the first', () => {
  // THE FINDING'S OWN URL. Its authority, its path AND its first query values all say
  // localhost:5432/onetwo3d_ims as `imsapp` — the admin URL's address exactly.
  const twoOfEverything =
    'postgres://imsapp@localhost:5432/onetwo3d_ims?host=localhost&host=remote.example&port=5432&port=6432&user=imsapp&user=other'

  // PRECONDITION, ASSERTED AGAINST THE INSTALLED PARSER RATHER THAN DESCRIBED: the driver really
  // does take the last of each, and a reader taking them one at a time really does see the first.
  // If pg ever changes this, this assertion fails and the refusal below is re-argued from fact.
  const effective = driverParse(twoOfEverything)
  assert.equal(effective.host, 'remote.example', 'precondition: pg-connection-string keeps the LAST host')
  assert.equal(effective.port, '6432', 'precondition: and the last port')
  assert.equal(effective.user, 'other', 'precondition: and the last user')
  const read = new URL(twoOfEverything).searchParams
  assert.equal(read.get('host'), 'localhost', 'precondition: and .get() — what this file used to use — returns the FIRST')

  // MUTATION ROUTE: delete the IDENTITY_PARAMS getAll() loop from parseConnectionIdentity(). The
  // authority/query conflict loop cannot catch this — its .get('host') is 'localhost', which is
  // what the authority says — so the URL resolves ok, to the driver's remote.example:6432/other.
  const identity = parseConnectionIdentity(twoOfEverything)
  assert.equal(identity.ok, false, 'a URL naming two hosts is not a URL whose host is known')
  assert.match(identity.reason, /\?host= 2 times/)
  assert.match(identity.reason, /"localhost", "remote\.example"/, 'and it names both, so the operator can delete one')

  // Each identity parameter on its own, including the two that name the database. `?dbname=` is
  // ignored by the driver, but a URL carrying two of them is still a URL that disagrees with
  // itself about which database it means, and this file refuses those.
  for (const [name, url] of [
    ['host', 'postgres://imsapp@localhost:5432/onetwo3d_ims?host=localhost&host=remote.example'],
    ['port', 'postgres://imsapp@localhost:5432/onetwo3d_ims?port=5432&port=6432'],
    ['user', 'postgres://imsapp@localhost:5432/onetwo3d_ims?user=imsapp&user=other'],
    ['dbname', 'postgres://imsapp@localhost:5432/onetwo3d_ims?dbname=onetwo3d_ims&dbname=imsdb'],
    ['database', 'postgres://imsapp@localhost:5432/onetwo3d_ims?database=onetwo3d_ims&database=imsdb'],
  ] as const) {
    const repeated = parseConnectionIdentity(url)
    assert.equal(repeated.ok, false, `two ?${name}= parameters must be refused`)
    assert.match(repeated.reason, new RegExp(`\\?${name}= 2 times`))
  }

  // And the refusal reaches the callers that ask only for a role: no role at all, which every
  // caller treats as a refusal, rather than the first of two.
  // MUTATION ROUTE (same loop): this returns 'imsapp' — the decoration — while pg logs in as
  // 'other', so the fence revokes CONNECT from a role that is not the one connecting.
  assert.equal(parseRoleFromConnectionString(twoOfEverything), '')

  // THE CONTROL ON THE CONTROL: a parameter that appears once is not a repetition, and the
  // ordinary URLs this script sees every deploy still resolve.
  assert.equal(parseConnectionIdentity('postgres://imsapp@localhost:5432/onetwo3d_ims').ok, true)
  assert.equal(parseConnectionIdentity('postgres://imsapp@localhost:5432/onetwo3d_ims?sslmode=disable&application_name=x').ok, true)
})

test('the effective host, port, user and database are the DRIVER\'S CONNECTION, not a parser\'s reading of the URL', () => {
  // r16's finding is that a string parser is not a connection: pg/lib/connection-parameters.js
  // fills everything the URL omits from PGHOST/PGPORT/PGUSER/PGDATABASE and its own defaults
  // BEFORE dialling. So this loop runs with all four set to values NO URL below mentions, and
  // compares the script against the final connection rather than against the parser.
  //
  // MUTATION ROUTE, verified on each of the four fields: make resolveDriverIdentity() return the
  // installed `pg-connection-string` parse of the URL — the r15 implementation, i.e. the exact
  // code this finding was raised against — and the loop fails on the host of the `@/` case, the
  // port of every case that omits one, the user of the case with no username and the database of
  // the case with an empty path. The preconditions immediately below assert that divergence
  // directly, so the loop cannot pass by comparing two identically-wrong answers.
  const restore = withPgEnv({ PGHOST: 'env.example', PGPORT: '6432', PGUSER: 'envrole', PGDATABASE: 'envdb' })
  try {
    // The parser and the connection genuinely disagree here — one field at a time.
    assert.equal(driverParse('postgres://imsapp@/onetwo3d_ims').host ?? '', '', 'precondition: the parser sees no host')
    assert.equal(driverConnection('postgres://imsapp@/onetwo3d_ims').host, 'env.example', 'and the connection dials PGHOST')
    assert.equal(driverParse('postgres://imsapp@localhost/onetwo3d_ims').port ?? '', '', 'precondition: the parser sees no port')
    assert.equal(driverConnection('postgres://imsapp@localhost/onetwo3d_ims').port, 6432, 'and the connection dials PGPORT')
    assert.equal(driverParse('postgres://localhost/onetwo3d_ims').user ?? '', '', 'precondition: the parser sees no user')
    assert.equal(driverConnection('postgres://localhost/onetwo3d_ims').user, 'envrole', 'and the connection authenticates as PGUSER')
    assert.equal(driverParse('postgres://imsapp@localhost/').database ?? '', '', 'precondition: the parser sees no database')
    assert.equal(driverConnection('postgres://imsapp@localhost/').database, 'envdb', 'and the connection attaches to PGDATABASE')

    for (const url of [
      'postgres://imsapp@localhost:5432/onetwo3d_ims',
      'postgres://imsapp@localhost/onetwo3d_ims',
      'postgres://localhost/onetwo3d_ims',
      'postgres://imsapp@localhost/',
      'postgres://imsapp@/onetwo3d_ims',
      'postgres://imsapp@localhost:5432/onetwo3d_ims?host=',
      'postgres://imsapp@/onetwo3d_ims?host=remote.example&port=6432',
      'postgres://ims%2Bapp@localhost:5432/onetwo3d_ims',
      'postgres://imsapp@localhost:5432/ims%2Fdb',
    ]) {
      const identity = parseConnectionIdentity(url)
      assert.equal(identity.ok, true, `${url} is a URL the driver connects with and must not be refused`)
      const effective = driverConnection(url)
      assert.equal(identity.host, effective.host, `host of ${url}`)
      assert.equal(identity.user, effective.user, `user of ${url}`)
      assert.equal(identity.database, effective.database, `database of ${url}`)
      assert.equal(identity.port, String(effective.port), `port of ${url}`)
    }
    // Named, so the parity loop above cannot pass by comparing two identically-wrong answers.
    // The driver decodes the path with decodeURI — NOT decodeURIComponent — so `%2F` survives,
    // while the username is decoded and `%2B` does not.
    assert.equal(parseConnectionIdentity('postgres://imsapp@localhost:5432/ims%2Fdb').database, 'ims%2Fdb')
    assert.equal(parseConnectionIdentity('postgres://ims%2Bapp@localhost:5432/onetwo3d_ims').user, 'ims+app')
    assert.equal(parseConnectionIdentity('postgres://imsapp@/onetwo3d_ims?host=remote.example&port=6432').server, 'remote.example:6432')
  } finally {
    restore()
  }
})

test('a port node-postgres cannot read as a number is refused, not silently defaulted to 5432', () => {
  // ConnectionParameters runs the port through parseInt, so `?port=6432x` is NaN on the wire and
  // where this URL lands is genuinely unknown. Defaulting it would name a cluster nobody asked
  // for and then fence that one.
  //
  // MUTATION ROUTE: drop the Number.isInteger(driver.port) arm from parseConnectionIdentity() and
  // this becomes ok with the port 'NaN', which no comparison in assessDatabaseIdentity() rejects.
  assert.ok(Number.isNaN(driverConnection('postgres://imsapp@localhost/imsdb?port=nonsense').port), 'precondition: NaN is what reaches the driver')
  const identity = parseConnectionIdentity('postgres://imsapp@localhost/imsdb?port=nonsense')
  assert.equal(identity.ok, false)
  assert.match(identity.reason, /port number/)
})

/** An ADMIN URL that is ambiguous about where it goes, at the wire. */
async function withAdminUrlOf<T>(adminUrl: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DEPLOY_ADMIN_DATABASE_URL
  process.env.DEPLOY_ADMIN_DATABASE_URL = adminUrl
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previous
  }
}

test('the fence revokes nothing, and commits nothing, when the ADMIN URL names two hosts, two ports and two roles', async (t) => {
  // THE WHOLE FINDING, AT THE WIRE, IN THE DIRECTION THAT ACTUALLY FENCES. The duplicates here
  // resolve — through the driver — to precisely the address and role the caller supplies, so with
  // the repetition accepted the identity binds and the fence goes ahead: it would revoke CONNECT
  // on this cluster while the operator reading the URL, and every log line quoting it, says the
  // privileged connection is on remote.example:6432 as `other`. Nobody would look here.
  //
  // MUTATION ROUTE: delete the IDENTITY_PARAMS getAll() loop from parseConnectionIdentity() and
  // this fence proceeds — client.revokes stops being empty, COMMIT appears in the log, and the
  // state file is written.
  const ambiguous = 'postgres://@/imsdb?host=remote.example&host=localhost&port=6432&port=5432&user=other&user=deployadmin'
  const effective = driverParse(ambiguous)
  assert.equal(effective.host, 'localhost', 'precondition: the driver lands on the supplied host')
  assert.equal(effective.port, '5432', 'precondition: and the supplied port')
  assert.equal(effective.user, 'deployadmin', 'precondition: and the role the connection logs in as, so nothing else would refuse this')

  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrlOf(ambiguous, () =>
      doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    )

    assert.equal(code, EXIT_NOT_FENCEABLE)
    assert.deepEqual(client.revokes, [], 'nothing may be revoked for a URL whose destination is not known')
    assert.ok(!client.log.includes('COMMIT'), 'and no transaction may commit')
    assert.equal(existsSync(stateFile), false, 'and no record may be published for a fence that never happened')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the deploy account\'s own OS user is not a role the admin URL names, and is not mistaken for one', () => {
  // PGHOST/PGPORT/PGUSER/PGDATABASE are deliberate settings for THIS process's own connection —
  // the admin one — which is why its identity still resolves through them. pg's LAST fallback for
  // the login role is not a setting at all: it is process.env.USER, the account running whichever
  // process asked. Taking that for a role the admin URL names would make the identity gate's
  // "the URL says X and the connection logged in as Y" arm compare a role nobody wrote down.
  //
  // MUTATION ROUTE: delete the OS_ACCOUNT_SENTINEL probe from resolveDriverIdentity() and return
  // client.user/client.database straight through. This test then reads back whatever account the
  // suite happens to be running as instead of '', and the unix-socket admin URL in 'a loopback
  // address, localhost and a unix socket are the same machine' starts being refused for naming a
  // role it never named — i.e. the suite's verdict starts depending on who runs it.
  assert.equal(driverConnection('postgresql://localhost/ims').user, String(pg.defaults.user), 'precondition: the driver does fall back to the OS account')
  assert.equal(parseRoleFromConnectionString('postgresql://localhost/ims'), '', 'and no OS account is accepted as a named role')
  assert.equal(parseConnectionIdentity('postgresql://localhost/').database, '', 'nor as the database libpq would derive from it')
  // An admin URL that names no role at all is bound by `session_user` alone, read from the open
  // connection — never by the account this script happens to run as.
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgresql://localhost:5432/imsdb', app: suppliedIdentity({ appDatabase: 'imsdb' }), connectedDatabase: 'imsdb' }).bound,
    true,
  )

  // PGUSER, by contrast, IS deliberate shared configuration for this process, and is honoured.
  const restore = withPgEnv({ PGUSER: 'configured' })
  try {
    assert.equal(parseRoleFromConnectionString('postgresql://localhost/ims'), 'configured')
    assert.equal(parseConnectionIdentity('postgresql://localhost/').database, 'configured')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 r19 — THE IDENTITY IS REQUIRED, NOT INFERRED.
//
// Seven rounds went into deciding WHERE THE APPLICATION CONNECTS by reconstructing what its
// runtime resolves — this repo's reading of the URL, then the driver's string parser, then the
// driver's real client in the deploy shell's environment, then the service's environment file,
// then `systemctl show`. Each answer was locally correct and uncovered another layer; the review
// of the last one named five more (PassEnvironment=, UnsetEnvironment=, wildcard EnvironmentFile=
// globs, Next's per-mode dotenv overlays, a unit with no WorkingDirectory=, and DATABASE_URL's own
// precedence chain). The blocker count went 1 -> 4 -> 5.
//
// THE QUESTION HAS NO BOUNDED ANSWER, because the composition rules belong to systemd, Next and
// libpq at once. So it is no longer asked: the four values arrive on argv and a run without them
// refuses. These two tests are what that has to mean, and nothing else in the file can cover them:
// a missing value refuses, and an ambient variable that DIFFERS from the supplied one is not
// consulted at all.
// ---------------------------------------------------------------------------

test('o3d-2sm1.5 r19: a missing required value is a REFUSAL, in every mode, before anything is opened', () => {
  // ROUTE: node scripts/fence-db-connections.mjs <mode> -> parseArgs() ->
  // requireSuppliedIdentity() -> process.exit, ahead of every dotenv read, every pg.Client and
  // every query.
  //
  // MUTATION ROUTE: make requireSuppliedIdentity() return `{ ok: true, identity }` when a value
  // is blank — the "nothing was supplied, so use what is here" reading that seven rounds of this
  // file kept re-deriving. Every assertion below fails: the modes stop refusing, and --preflight
  // goes on to open a connection to a database nobody named.
  const env = {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://imsapp@127.0.0.1:5432/ims',
    DIRECT_URL: '',
  }

  // NOTHING SUPPLIED AT ALL. --preflight and --fence exit 3 (the code every entrypoint reads as
  // "nothing was revoked", so a deploy aborts cleanly); --release and --print-migration-url exit 1.
  for (const [mode, expected] of [
    ['--preflight', EXIT_NOT_FENCEABLE],
    ['--fence', EXIT_NOT_FENCEABLE],
    ['--release', EXIT_ERROR],
    ['--print-migration-url', EXIT_ERROR],
  ] as [string, number][]) {
    const refused = runFenceScript([mode], env, [])
    assert.equal(refused.status, expected, `${mode}: ${refused.output}`)
    assert.match(refused.output, /connection identity was not supplied/, `${mode} says why`)
    assert.match(refused.output, /--app-host, --app-port, --app-user, --app-database/, `${mode} names all four`)
  }

  // AND THREE OF FOUR IS STILL NOTHING. Each option is dropped in turn, and the refusal names the
  // one that is missing rather than the whole list.
  for (const option of REQUIRED_IDENTITY_OPTIONS) {
    const partial = identityArgs({ appDatabase: 'ims' }).filter((argument) => !argument.startsWith(`${option}=`))
    assert.equal(partial.length, 3, `precondition: exactly ${option} was dropped`)
    const refused = runFenceScript(['--preflight'], env, partial)
    assert.equal(refused.status, EXIT_NOT_FENCEABLE, refused.output)
    assert.ok(refused.output.includes(`${option} was not supplied`), `${option}: ${refused.output}`)
  }

  // A BLANK IS A MISSING VALUE, not a default — `--app-host=` is the shape an unset shell variable
  // takes when a caller interpolates it into the command line.
  const blank = runFenceScript(['--preflight'], env, ['--app-host=', '--app-port=5432', '--app-user=imsapp', '--app-database=ims'])
  assert.equal(blank.status, EXIT_NOT_FENCEABLE, blank.output)
  assert.match(blank.output, /--app-host was not supplied/)

  // And a port that is not a port is refused too, because the server comparison is made on it.
  const badPort = runFenceScript(['--preflight'], env, identityArgs({ appPort: 'five-four-three-two', appDatabase: 'ims' }))
  assert.equal(badPort.status, EXIT_NOT_FENCEABLE, badPort.output)
  assert.match(badPort.output, /is not a port number/)
})

test('o3d-2sm1.5 r19: an ambient PG* that DIFFERS from the supplied value is not consulted at all', () => {
  // THE OTHER HALF, AND THE ONE THAT USED TO NEED SYSTEMD. `pg` fills PGHOST, PGPORT, PGUSER and
  // PGDATABASE in for everything a connection string omits — so for seven rounds this file tried
  // to establish WHOSE environment those came from. Now nothing reads them on the application's
  // behalf: the four supplied values are the answer, and an ambient variable naming something
  // else changes nothing.
  //
  // ROUTE: the environment -> (nowhere) ; --app-* -> requireSuppliedIdentity() -> the identity
  // assessDatabaseIdentity() compares the admin connection against.
  //
  // MUTATION ROUTE: make assessDatabaseIdentity() fall back to `parseConnectionIdentity(appUrl)`
  // when a supplied value is absent, or reintroduce any read of process.env for the application's
  // identity. Every assertion below flips: the supplied port stops winning, and the deliberately
  // hostile PGHOST/PGPORT/PGDATABASE start deciding what the fence is about.
  const restore = withPgEnv({ PGHOST: 'remote.example', PGPORT: '6432', PGUSER: 'ambient', PGDATABASE: 'ambient_db' })
  try {
    // PRECONDITION, MEASURED ON THE DRIVER: these really do move a connection, so the test is not
    // passing against variables that were never capable of doing anything.
    const moved = driverConnection('postgres://imsapp@localhost/imsdb')
    assert.equal(moved.port, 6432, 'precondition: this shell\'s PGPORT reaches the driver')
    assert.equal(driverConnection('postgres://@/').host, 'remote.example', 'precondition: and its PGHOST')
    assert.equal(driverConnection('postgres://@/').database, 'ambient_db', 'precondition: and its PGDATABASE')

    // THE SUPPLIED VALUE WINS, and the ambient one is nowhere in the answer.
    const supplied = requireSuppliedIdentity(suppliedIdentity({ appDatabase: 'imsdb' }))
    assert.equal(supplied.ok, true, supplied.reason)
    assert.deepEqual(supplied.identity, { host: 'localhost', port: '5432', user: 'imsapp', database: 'imsdb' })

    // AND THE GATE IS DECIDED ON IT. The admin URL is on localhost:5432/imsdb — which agrees with
    // what the caller supplied and disagrees with every ambient variable in scope.
    assert.equal(
      assessDatabaseIdentity({
        ...ATTACHED_AS_ADMIN,
        adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
        app: suppliedIdentity({ appDatabase: 'imsdb' }),
        connectedDatabase: 'imsdb',
      }).bound,
      true,
      'the environment says remote.example:6432/ambient_db, and it is not asked',
    )

    // THE CONVERSE, so this cannot pass by ignoring the supplied values too: supply what the
    // ENVIRONMENT says and the same admin URL is refused. Only the supplied values moved.
    const followed = assessDatabaseIdentity({
      ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
      app: suppliedIdentity({ appHost: 'remote.example', appPort: '6432', appDatabase: 'imsdb' }),
      connectedDatabase: 'imsdb',
    })
    assert.equal(followed.bound, false)
    assert.match(followed.reason, /remote\.example:6432/)

    // AND A MISSING VALUE IS NOT FILLED IN FROM DATABASE_URL EITHER — the fallback that would make
    // "required" mean "preferred". The URL below would bind PERFECTLY if anything still read it,
    // which is what makes this assertion capable of failing.
    //
    // MUTATION ROUTE: add `if (!supplied.ok) supplied = parseConnectionIdentity(process.env.DATABASE_URL)`
    // to assessDatabaseIdentity() — the shape seven rounds of this file kept re-deriving — and
    // these two assertions fail while everything else in the suite still passes.
    const previousUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://imsapp@localhost:5432/imsdb'
    try {
      assert.equal(
        parseConnectionIdentity(process.env.DATABASE_URL).database,
        'imsdb',
        'precondition: this URL resolves to exactly what the gate below would need',
      )
      const partial = assessDatabaseIdentity({
        ...ATTACHED_AS_ADMIN,
        adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
        app: suppliedIdentity({ appDatabase: '' }),
        connectedDatabase: 'imsdb',
      })
      assert.equal(partial.bound, false, 'a value nobody supplied is refused, never taken from DATABASE_URL')
      assert.ok(partial.reason.includes('--app-database was not supplied'))
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousUrl
    }
  } finally {
    restore()
  }

  // END TO END, IN THE SHIPPED SCRIPT: --print-migration-url derives the role the migration RUNS
  // AS. A hostile PGUSER in this shell, and a DATABASE_URL naming no role at all, used to decide
  // it; the supplied --app-user does now.
  //
  // MUTATION ROUTE: put `parseRoleFromConnectionString(process.env.DATABASE_URL)` back in front of
  // `options.appUser` in main(). The emitted URL becomes `-c role=deployrole` — this shell's
  // variable deciding what the migration runs as, on a box where the service has never heard of
  // that role — and the last three assertions fail.
  const result = runFenceScript(['--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
    PGUSER: 'deployrole',
    DIRECT_URL: '',
  })
  assert.equal(result.status, 0, result.output)
  const emitted = result.stdout.trim().split('\n').at(-1) ?? ''
  assert.match(emitted, /^postgresql:\/\//, 'the last line is the URL the deploy captures')
  assert.match(emitted, /options=-c\+role%3Dimsapp|options=-c%20role%3Dimsapp/, 'the migration runs as the SUPPLIED role')
  assert.doesNotMatch(emitted, /deployrole/, 'and this shell\'s PGUSER reaches nothing the migration runs through')
  assert.doesNotMatch(result.stdout, /supplied by the caller/, 'stdout carries the URL and nothing else: the deploy captures it with $(...)')
  assert.match(result.stderr, /as supplied by the caller/, 'and the diagnostic goes to stderr')
})

test('o3d-2sm1.5 r19: --release will not read "the application can connect" off another cluster', () => {
  // A DATABASE NAME IS NOT AN IDENTITY. `imsdb` exists on the staging server too, and
  // DATABASE_URL is the one string this helper still OPENS — as a credential, through whatever
  // environment this process happens to have. So the probe is asked where it went:
  // pg_postmaster_start_time() is the same microsecond stamp on every backend of one postmaster
  // and a different one on any other.
  //
  // ROUTE: doRelease() -> the attachment query's connected_postmaster -> releaseWithoutRecord()
  // -> assessUnrecordedRelease()'s postmaster arm.
  //
  // MUTATION ROUTE: delete that arm and this returns EXIT_FENCE_UNPROVEN (4) — which the callers
  // treat as "the application role holds CONNECT", about a cluster this run has never touched.
  return (async () => {
    const client = new FakeAdminClient({ stillConnectsBefore: true, connectedDatabase: 'imsdb', postmaster: '2026-08-01 10:00:00.123456+00' })
    const elsewhere = await withAdminUrl(() =>
      doRelease(client as never, {
        stateFile: '',
        appRole: '',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        probeApplication: async () => ({ attempted: true, connected: true, database: 'imsdb', postmaster: '2026-07-14 09:30:00.654321+00', error: '' }),
      } as never),
    )
    assert.equal(elsewhere, EXIT_ERROR, 'two postmasters are two clusters, whatever their databases are called')
    assert.deepEqual(client.grants, [], 'and nothing is restored on the strength of it')

    // THE CONTROL: the same shapes with ONE postmaster still reach the r12 verdict, so this is
    // not a check that refuses everything.
    const sameCluster = new FakeAdminClient({ stillConnectsBefore: true, connectedDatabase: 'imsdb', postmaster: '2026-08-01 10:00:00.123456+00' })
    const together = await withAdminUrl(() =>
      doRelease(sameCluster as never, {
        stateFile: '',
        appRole: '',
        timeoutSeconds: 1,
        ...suppliedIdentity({ appDatabase: 'imsdb' }),
        probeApplication: async () => ({ attempted: true, connected: true, database: 'imsdb', postmaster: '2026-08-01 10:00:00.123456+00', error: '' }),
      } as never),
    )
    assert.equal(together, EXIT_FENCE_UNPROVEN, 'one cluster, and still not a released fence')
  })()
})

test('o3d-2sm1.5 r19: every entrypoint supplies the four values, and refuses when it cannot read them', () => {
  // The helper refuses without them; this is the other half — that the shipped callers actually
  // pass them, and that each one says plainly where it got them and what it does when it cannot.
  //
  // MUTATION ROUTE: drop `${DB_FENCE_IDENTITY_ARGS[@]:-}` from any invocation, or delete a
  // `require_db_identity ||` refusal, and the matching assertion fails by name.
  const deploy = readFileSync(join(process.cwd(), 'scripts/deploy.sh'), 'utf8')
  const update = readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8')
  const install = readFileSync(join(process.cwd(), 'scripts/install.sh'), 'utf8')
  const library = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')

  for (const [name, source] of [['deploy.sh', deploy], ['update.sh', update], ['install.sh', install]] as const) {
    // EVERY invocation of the helper carries the identity — not just the one a test happened to
    // look at. A mode added later without it would otherwise reintroduce the whole finding.
    // r29/r30: update.sh no longer names ${DB_FENCE_SCRIPT} at the invocation. The script it runs
    // is resolved first, and since r30 it is always the ROOT-OWNED copy — the checkout's file is
    // published into it and never executed in place, because it is application-owned and could be
    // REPLACED as easily as removed. Every spelling of the resolved path is an invocation of the
    // helper and every one of them must carry the identity.
    // r31: ALL THREE entrypoints now resolve the helper before running it, through the shared
    // scripts/lib/db-fence-protected.sh, so every one of them has these spellings and none of
    // them still names ${DB_FENCE_SCRIPT} at an invocation.
    const RESOLVED = [
      '"${DB_FENCE_SCRIPT}"', '"$DB_FENCE_SCRIPT"',
      '"${fence_script}"', '"$fence_script"',
      '"${preflight_script}"', '"$preflight_script"',
      '"${release_script}"', '"$release_script"',
    ]
    // r3 (o3d-secops): the dry-run preflight has no spelling here any more. The path it runs is a
    // `local` of db_fence_preflight() in the shared library, which appends
    // "${DB_FENCE_IDENTITY_ARGS[@]:-}" itself — so the identity travels with the invocation by
    // construction rather than by every caller remembering to add it. The library's own line is
    // asserted below.
    const invocations = source.split('\n').filter((line) => RESOLVED.some((spelling) => line.includes(spelling)))
    const modes = invocations.filter((line) => /--(fence|release|preflight|print-migration-url)\b/.test(line))
    assert.ok(modes.length >= 4, `${name}: precondition — the helper is actually invoked here (${modes.length})`)
    for (const line of modes) {
      assert.ok(line.includes('DB_FENCE_IDENTITY_ARGS[@]'), `${name}: every invocation passes the identity — ${line.trim()}`)
    }
    // AND THE ONE INVOCATION THAT MOVED INTO THE LIBRARY STILL CARRIES IT.
    const libInvocations = library.split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /^\s*"\$@" node /.test(line))
    assert.equal(libInvocations.length, 1, `the library runs the helper in exactly one place:\n${libInvocations.join('\n')}`)
    assert.ok(libInvocations[0].includes('DB_FENCE_IDENTITY_ARGS[@]'),
      `and it passes the identity — ${libInvocations[0].trim()}`)
    // AND NOTHING NAMES A UNIT ANY MORE: the systemd interrogation is gone, not merely unused.
    assert.ok(!source.includes('--service-unit'), `${name}: no unit is interrogated`)
    assert.ok(!source.includes('--systemctl='), `${name}: and no systemctl path is passed`)
    // AND A CALLER THAT CANNOT DETERMINE A VALUE REFUSES rather than defaulting.
    assert.ok(source.includes('require_db_identity ||'), `${name}: refuses when the four are not known`)
  }

  // r29: THE ONE EXEMPTION, AND WHAT IT IS CONDITIONED ON. fence_db_connections() drops both .env
  // questions when the identity came from the root-owned recovery record rather than from
  // ${APP_DIR}/.env — both compare the identity in hand against what a FILE will give systemd at
  // exec, and on that path there is no file and nothing is being started (the run refuses at the
  // layout gate a few lines later). The exemption is named here so it cannot be widened: exactly
  // one condition may wrap them, and exactly one function may raise the flag it tests.
  const fenceBody = update.slice(update.indexOf('\nfence_db_connections() {'), update.indexOf('\n# Asked in the VALIDATE phase'))
  assert.ok(fenceBody.length > 500, 'precondition: fence_db_connections() was located in update.sh')
  assert.match(fenceBody, /require_env_file_is_sole_definition \|\| die/, 'the sole-source question is still asked there')
  assert.match(fenceBody, /require_start_identity_unchanged \|\| die/, 'and the drift re-read too')
  const conditions = fenceBody.split('\n').filter((line) => /^\s*if .*; then$/.test(line) && !/\$DRY_RUN/.test(line))
  assert.deepEqual(
    conditions.map((line) => line.trim()),
    ['if ! $DB_FENCE_IDENTITY_FROM_RECORD; then'],
    'nothing else may condition what fence_db_connections() asks',
  )
  const raises = update.split('\n').filter((line) => /^\s*DB_FENCE_IDENTITY_FROM_RECORD=true$/.test(line))
  assert.equal(raises.length, 1, 'exactly one place may declare the identity to have come from the record')
  const raiseAt = update.indexOf('  DB_FENCE_IDENTITY_FROM_RECORD=true')
  const owner = update.lastIndexOf('() {', raiseAt)
  assert.ok(
    update.slice(update.lastIndexOf('\n', owner) + 1, owner).trim() === 'adopt_identity_from_recovery_record',
    'and it is the function that reads the record',
  )

  // WHERE EACH ONE GETS THEM, stated in the source and asserted here so the answer cannot drift:
  // install.sh OWNS the values (it created the role and the database with them), and the other
  // two split DATABASE_URL with a reader that refuses any URL not stating all four.
  assert.match(install, /--app-host=\$\{DB_HOST\}/, 'install.sh passes the variables it created the database with')
  assert.match(install, /--app-database=\$\{DB_NAME\}/)
  assert.ok(!install.includes('resolve_db_identity'), 'and parses nothing at all')
  for (const [name, source] of [['deploy.sh', deploy], ['update.sh', update]] as const) {
    assert.ok(source.includes('resolve_db_identity '), `${name}: reads DATABASE_URL through the strict reader`)
    assert.match(source, /DB_IDENTITY_REASON="DATABASE_URL states no port/, `${name}: and refuses a URL that does not state the port`)
    assert.match(source, /host\|port\|user\|dbname\|database\)/, `${name}: and one that restates any of the four in its query string`)
  }
})

test('o3d-2sm1.5 r19: the strict reader in the entrypoints accepts only a URL stating all four', () => {
  // THE CALLERS' HALF, EXECUTED rather than read. resolve_db_identity() is lifted straight out of
  // the shipped update.sh and run by bash, so what is asserted is the code that ships.
  //
  // MUTATION ROUTE: delete any refusal arm from resolve_db_identity() (the port check, the query
  // scan, the percent check) and the matching case below starts being ACCEPTED — which is a fence
  // pointed at whatever PGHOST/PGPORT/PGDATABASE happen to say in whichever process resolves it.
  const source = readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8')
  const reader = source.slice(source.indexOf('resolve_db_identity() {'), source.indexOf('\n}\n', source.indexOf('resolve_db_identity() {')) + 3)
  assert.ok(reader.includes('DB_FENCE_IDENTITY_ARGS=('), 'precondition: the whole function was lifted')

  function read(url: string) {
    const script = [
      'set -uo pipefail',
      'DB_IDENTITY_HOST=""; DB_IDENTITY_PORT=""; DB_IDENTITY_USER=""; DB_IDENTITY_DATABASE=""; DB_IDENTITY_REASON=""; DB_FENCE_IDENTITY_ARGS=()',
      reader,
      'if resolve_db_identity "$1"; then printf "OK %s\\n" "${DB_FENCE_IDENTITY_ARGS[*]}"; else printf "REFUSE %s\\n" "$DB_IDENTITY_REASON"; fi',
    ].join('\n')
    const run = spawnSync('bash', ['-c', script, 'reader', url], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return (run.stdout ?? '').trim()
  }

  // THE SHAPE EVERY SHIPPED .env HAS, and the one install.sh composes.
  assert.equal(
    read('postgresql://imsuser:secret@localhost:5432/one_two_inventory'),
    'OK --app-host=localhost --app-port=5432 --app-user=imsuser --app-database=one_two_inventory',
  )
  // A password containing '@' still works: the userinfo ends at the LAST '@', which is the rule
  // both WHATWG URL and node-postgres follow. A reader that refused this would get switched off.
  assert.match(read('postgresql://imsuser:p@ss@localhost:5432/ims'), /^OK --app-host=localhost --app-port=5432 --app-user=imsuser --app-database=ims$/)
  // And a parameter that does not touch identity is left alone.
  assert.match(read('postgresql://imsuser:s@localhost:5432/ims?sslmode=require'), /^OK /)

  // AND EVERY URL WHOSE DESTINATION DEPENDS ON SOMETHING ELSE IS REFUSED, never defaulted.
  for (const [url, expected] of [
    ['postgresql://imsuser:s@localhost/ims', /states no port/],
    ['postgresql://imsuser:s@localhost:5432', /states no database/],
    ['postgresql://localhost:5432/ims', /states no role/],
    ['postgresql://imsuser:s@localhost:5432/ims?host=remote.example', /carries \?host=/],
    ['postgresql://imsuser:s@localhost:5432/ims?port=6432', /carries \?port=/],
    ['postgresql://imsuser:s@localhost:5432/ims?user=other', /carries \?user=/],
    ['postgresql://imsuser:s@localhost:5432/ims?dbname=other', /carries \?dbname=/],
    ['postgresql://ims%2Fuser:s@localhost:5432/ims', /percent-escapes/],
    ['postgresql://imsuser:s@localhost:abc/ims', /not a port number/],
    ['postgresql://imsuser:s@localhost:5432/a/b', /more than one path segment/],
    ['postgres://imsuser@/ims?host=/var/run/postgresql', /states no port/],
    ['mysql://imsuser:s@localhost:3306/ims', /does not begin with postgres/],
    ['', /is not set/],
  ] as [string, RegExp][]) {
    const answer = read(url)
    assert.match(answer, /^REFUSE /, `${url || '(empty)'} must be refused, not read`)
    assert.match(answer, expected, url || '(empty)')
  }
})

test('o3d-2sm1.5 r19/r32: the four options are parsed, and no file is read from the application directory', () => {
  // TWO THINGS THE PRINTED --release COMMAND DEPENDS ON, and it is the one command an operator is
  // offered for taking a committed fence back down.
  //
  // 1. THE OPTIONS EXIST AND ARE READ. A flag parseArgs() silently ignores is a flag the callers
  //    pass into a void, and every mode would then refuse on a value that WAS supplied.
  //    MUTATION ROUTE: drop any `--app-*` arm from parseArgs() and the matching assertion fails.
  assert.deepEqual(
    parseArgs(['--release', '--app-host=db.internal', '--app-port=6432', '--app-user=imsapp', '--app-database=imsdb', '--state-file=/x']),
    // o3d-secops r23: and stateOwnerUid, whose DEFAULT is the load-bearing half. Every real
    // invocation of this file is composed by a root-owned script or a root-owned wrapper, so the
    // safe value is the one a caller gets without asking; `--state-owner` exists so an
    // unprivileged harness can exhibit the mechanism.
    // o3d-secops r31: and the three witness nonces, which every mode defaults to '' and every
    // mode given '' behaves on exactly as it did before that round.
    { mode: 'release', stateFile: '/x', stateOwnerUid: 0, appRole: '', timeoutSeconds: 30, appHost: 'db.internal', appPort: '6432', appUser: 'imsapp', appDatabase: 'imsdb',
      witnessNonce: '', witnessLock: '', witnessChallenge: '' },
  )
  // AND THE THREE ARE READ WHEN THEY ARE GIVEN (o3d-secops r31). MUTATION ROUTE: drop any of the
  // three `--witness-*` arms from parseArgs() and the matching field stays '' here.
  assert.deepEqual(
    (({ witnessNonce, witnessLock, witnessChallenge }) => ({ witnessNonce, witnessLock, witnessChallenge }))(
      parseArgs(['--witness', '--witness-nonce=' + 'a'.repeat(32), '--witness-lock=' + 'b'.repeat(32), '--witness-challenge=' + 'c'.repeat(32)]),
    ),
    { witnessNonce: 'a'.repeat(32), witnessLock: 'b'.repeat(32), witnessChallenge: 'c'.repeat(32) },
  )
  assert.equal(parseArgs(['--witness']).mode, 'witness', 'and --witness is a mode of its own')
  // And nothing remains that would take a unit name or a systemctl path.
  const withUnit = parseArgs(['--fence', '--service-unit=one-two-inventory.service', '--systemctl=/x/systemctl']) as Record<string, unknown>
  assert.equal(withUnit.serviceUnits, undefined, 'no unit is interrogated any more')
  assert.equal(withUnit.systemctlPath, undefined, 'and no systemctl path is taken')

  // 2. IT READS NO FILE AT ALL, FROM ANY DIRECTORY (o3d-2sm1.5 r32, Codex CRITICAL).
  //
  //    r17 made the `.env` load absolute against this file's own location, because the printed
  //    `--release` command is a bare `node /opt/.../fence-db-connections.mjs --release ...` and an
  //    operator runs it from wherever they are standing. r32 removed the load outright: the file
  //    this actually executes from is the ROOT-OWNED MIRROR, whose directory holds no `.env`, so
  //    the load supplied nothing on the only path that runs while `dotenv` stayed in the import
  //    graph — executed with DEPLOY_ADMIN_DATABASE_URL, at module scope, out of an
  //    application-owned node_modules. The credential now arrives in the environment, put there
  //    by the entrypoints or by the generated recovery wrapper.
  //
  //    MUTATION ROUTE: add `import { config } from 'dotenv'` and a `config({ path: ... })` call
  //    back into the helper. The first two assertions fail by name, and the decoy run below picks
  //    up the `.env` in its working directory, so `DEPLOY_ADMIN_DATABASE_URL is not set` stops
  //    appearing and `decoy` starts appearing.
  const helper = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  const imports = helper
    .split('\n')
    .filter((line) => /^import .* from '[^']+'$/.test(line))
    .map((line) => /from '([^']+)'$/.exec(line)![1])
  assert.deepEqual(
    imports.filter((specifier) => !specifier.startsWith('node:')),
    ['pg'],
    'the fence helper may import exactly one package, because every import is executed with the admin credential and has to be vendored into the protected artefact',
  )
  assert.doesNotMatch(helper, /loadDotenv|from 'dotenv'/, 'and dotenv is not one of them')

  // AND THE ONE PACKAGE IT DOES IMPORT IS THE ONE THE LIBRARY VENDORS. A dependency added here
  // and not there resolves to nothing inside the mirror, which is a fence that dies at exec.
  const library = readFileSync(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'), 'utf8')
  const roots = /^readonly DB_FENCE_VENDOR_ROOTS=\(([^)]*)\)$/m.exec(library)
  assert.ok(roots, 'the library must name what it vendors')
  assert.deepEqual(
    roots[1].split(/\s+/).filter(Boolean),
    imports.filter((specifier) => !specifier.startsWith('node:')),
    'DB_FENCE_VENDOR_ROOTS must be exactly the helper\'s bare imports',
  )

  const cwd = mkdtempSync(join(tmpdir(), 'ims-decoy-'))
  try {
    writeFileSync(join(cwd, '.env'), 'DEPLOY_ADMIN_DATABASE_URL=postgresql://decoy@127.0.0.1:5432/decoy\n')
    const run = spawnSync(
      'node',
      [join(process.cwd(), 'scripts/fence-db-connections.mjs'), '--preflight', ...identityArgs({ appDatabase: 'ims' })],
      { encoding: 'utf8', cwd, env: { ...process.env, DEPLOY_ADMIN_DATABASE_URL: '', DIRECT_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    assert.equal(run.status, EXIT_NOT_FENCEABLE, output)
    assert.match(output, /DEPLOY_ADMIN_DATABASE_URL is not set/, 'a .env in the working directory is not this application\'s')
    assert.doesNotMatch(output, /decoy/, 'and nothing from it reaches the run')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

/** resolve_db_identity(), lifted out of the shipped script and run by bash. */
function liftReader(script: 'deploy.sh' | 'update.sh'): string {
  const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
  const start = source.indexOf('resolve_db_identity() {')
  assert.ok(start > 0, `${script}: precondition — the reader is in the shipped script`)
  return source.slice(start, source.indexOf('\n}\n', start) + 3)
}

test('o3d-2sm1.5 r20: a percent-escaped query KEY is refused, because the driver decodes keys', () => {
  // ROUTE: DATABASE_URL in the app's .env -> resolve_db_identity() -> DB_FENCE_IDENTITY_ARGS ->
  // `node fence-db-connections.mjs --fence --app-host=... --app-port=... --app-user=...` -> the
  // host, port, role and database CONNECT is revoked on and the migration then runs against.
  //
  // MUTATION: delete the `case "$query" in *%*)` arm from resolve_db_identity(). Every URL below
  // is then ACCEPTED, because the scan under it compares RAW key bytes and `ho%73t` is not
  // `host` — and the four values it hands on are the AUTHORITY's, while the driver connects to
  // the decoded key's. The assert.match(/^REFUSE/) fails on each, and the fence is aimed at a
  // database the application is not using.
  for (const script of ['deploy.sh', 'update.sh'] as const) {
    const reader = liftReader(script)
    assert.ok(reader.includes('DB_FENCE_IDENTITY_ARGS=('), `${script}: precondition — the whole function was lifted`)

    function read(url: string): string {
      const bash = [
        'set -uo pipefail',
        'DB_IDENTITY_HOST=""; DB_IDENTITY_PORT=""; DB_IDENTITY_USER=""; DB_IDENTITY_DATABASE=""; DB_IDENTITY_REASON=""; DB_FENCE_IDENTITY_ARGS=()',
        reader,
        'if resolve_db_identity "$1"; then printf "OK %s\\n" "${DB_FENCE_IDENTITY_ARGS[*]}"; else printf "REFUSE %s\\n" "$DB_IDENTITY_REASON"; fi',
      ].join('\n')
      const run = spawnSync('bash', ['-c', bash, 'reader', url], { encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      return (run.stdout ?? '').trim()
    }

    for (const [encoded, field, moved] of [
      ['postgresql://app:pw@127.0.0.1:5432/main?ho%73t=other-cluster', 'host', 'other-cluster'],
      ['postgresql://app:pw@127.0.0.1:5432/main?po%72t=6543', 'port', '6543'],
      ['postgresql://app:pw@127.0.0.1:5432/main?u%73er=other-role', 'user', 'other-role'],
    ] as [string, 'host' | 'port' | 'user', string][]) {
      // PRECONDITION — THE PREMISE, MEASURED AGAINST THE INSTALLED DRIVER rather than asserted
      // from its documentation. Without this the test could be refusing a URL that goes nowhere
      // in particular, which would make it a style rule instead of a fix. `driverConnection()` is
      // the configuration `Connection#connect()` is handed, so this is where the socket goes.
      assert.equal(
        String(driverConnection(encoded)[field]),
        moved,
        `${script}: the driver decodes the KEY and it MOVES the connection's ${field}`,
      )
      // AND THE AUTHORITY SAYS OTHERWISE, which is what makes it a false statement rather than a
      // redundant one — the reader would have handed on these values and been wrong about all of
      // them.
      assert.notEqual(String(driverConnection(encoded.replace(/\?.*$/, ''))[field]), moved)

      const answer = read(encoded)
      assert.match(answer, /^REFUSE /, `${script}: ${encoded} must be refused, not read`)
      assert.match(answer, /percent-escapes something in its query string/, `${script}: ${encoded}`)
    }

    // AND AN ESCAPE IN A HARMLESS PARAMETER IS REFUSED TOO, on purpose: telling the two apart
    // means decoding, and decoding is the reimplementation this reader exists to avoid.
    assert.match(read('postgresql://app:pw@127.0.0.1:5432/main?sslmode=req%75ire'), /^REFUSE .*percent-escapes/)
    // While the unescaped forms still read cleanly, so the refusal is about the escape and not
    // about having a query string at all.
    assert.match(read('postgresql://app:pw@127.0.0.1:5432/main?sslmode=require'), /^OK --app-host=127.0.0.1 /)
  }
})

/**
 * The bus reader and the question it answers, lifted out of the shipped script and run by bash.
 *
 * From the first helper to the end of the function, so a mutation anywhere in the mechanism —
 * the tokenizer, the arity check, the name match or any refusal — reaches this test.
 */
function liftSoleSource(script: 'deploy.sh' | 'update.sh' | 'install.sh'): string {
  const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
  const start = source.indexOf('bus_read_strings() {')
  const main = source.indexOf('env_file_is_sole_database_url_source() {')
  assert.ok(start > 0 && main > start, `${script}: precondition — the question is asked by the shipped script`)
  const terminator = '\n  return 0\n}\n'
  return source.slice(start, source.indexOf(terminator, main) + terminator.length)
}

/**
 * WHAT SYSTEMD SAYS, one fixture per way a second definition of DATABASE_URL can exist.
 *
 * The shape is this host's own: `busctl get-property org.freedesktop.systemd1 <unit path>
 * org.freedesktop.systemd1.Service <property>` answers with the property's SIGNATURE, the array's
 * own ELEMENT COUNT and then the elements — `a(sb) 1 "/opt/app/.env" true`, `as 0`, `s ""` — all
 * verified read-only against the real ims-stage-dev.service and ims-e2e-dev.service on this host
 * before this test was written, and those two units answer SOLE through the lifted function.
 *
 * Each fixture overrides one property; everything it does not name is the sole-source answer.
 */
type SystemdUnit = Partial<Record<'LoadState' | 'PAMName' | 'Environment' | 'PassEnvironment' | 'UnsetEnvironment' | 'EnvironmentFiles', string>>

const SOLE_UNIT: Required<SystemdUnit> = {
  LoadState: 's "loaded"',
  PAMName: 's ""',
  Environment: 'as 2 "NODE_ENV=production" "PORT=3000"',
  PassEnvironment: 'as 0',
  UnsetEnvironment: 'as 0',
  EnvironmentFiles: 'a(sb) 1 "/opt/app/.env" true',
}

const SYSTEMD_ANSWERS: [string, SystemdUnit, RegExp | null][] = [
  ['the unit loads that file and nothing else defines it', {}, null],
  [
    'Environment= carries its own DATABASE_URL',
    { Environment: 'as 2 "NODE_ENV=production" "DATABASE_URL=postgresql://app:pw@other-cluster:5432/other"' },
    /sets DATABASE_URL in its own Environment=/,
  ],
  [
    'Environment= carries it FIRST',
    { Environment: 'as 2 "DATABASE_URL=postgresql://app:pw@other-cluster:5432/other" "NODE_ENV=production"' },
    /sets DATABASE_URL in its own Environment=/,
  ],
  [
    'a variable whose NAME merely ends in DATABASE_URL is not a definition of it',
    { Environment: 'as 2 "NEXT_PUBLIC_DATABASE_URL=shown" "NODE_ENV=production"' },
    null,
  ],
  [
    'a variable whose VALUE contains the text of one is not a definition of it either',
    { Environment: 'as 1 "SUMMARY=env is NODE_ENV=production DATABASE_URL=postgresql://x/y"' },
    null,
  ],
  [
    'a value carrying an ESCAPED QUOTE does not end the element early',
    { Environment: 'as 2 "SUMMARY=he said \\"DATABASE_URL=postgresql://x/y\\"" "NODE_ENV=production"' },
    null,
  ],
  ['PassEnvironment= lets the manager supply it', { PassEnvironment: 'as 2 "LANG" "DATABASE_URL"' }, /lists DATABASE_URL in PassEnvironment=/],
  ['UnsetEnvironment= removes what the file supplied', { UnsetEnvironment: 'as 1 "DATABASE_URL"' }, /lists DATABASE_URL in UnsetEnvironment=/],
  [
    'UnsetEnvironment= removes it in the ASSIGNMENT form, which names no bare token',
    { UnsetEnvironment: 'as 1 "DATABASE_URL=postgresql://app:pw@db:5432/ims"' },
    /lists DATABASE_URL in UnsetEnvironment= \(as 'DATABASE_URL=postgresql:\/\/app:pw@db:5432\/ims'\)/,
  ],
  ['PAMName= brings a whole environment source with it', { PAMName: 's "login"' }, /sets PAMName=login/],
  [
    // ROUND 23 SPLIT THIS ONE IN TWO. A second environment file used to be refused by its COUNT;
    // now the count of 2 is the shape the binding needs, so a second file is refused by WHAT IT
    // IS — not this run's snapshot, or one this run did not publish. A THIRD is still refused by
    // count, and has its own fixture below.
    'a SECOND environment file this run did not publish',
    { EnvironmentFiles: 'a(sb) 2 "/opt/app/.env" false "/etc/ims/override.env" true' },
    /loads a second environment file, \/etc\/ims\/override\.env, that this run did not publish/,
  ],
  [
    'a THIRD environment file, which is more than any shape this composes',
    { EnvironmentFiles: 'a(sb) 3 "/opt/app/.env" false "/etc/ims/override.env" true "/etc/ims/more.env" true' },
    /loads 3 environment files/,
  ],
  ['no environment file at all, so the application\'s own loader decides', { EnvironmentFiles: 'a(sb) 0' }, /does not load \/opt\/app\/\.env with EnvironmentFile=/],
  [
    'a different environment file instead of that one',
    { EnvironmentFiles: 'a(sb) 1 "/etc/ims/other.env" false' },
    /loads \/etc\/ims\/other\.env as its first environment file and not \/opt\/app\/\.env/,
  ],
  [
    'a path systemd had to escape, which this will not decode to compare',
    { EnvironmentFiles: 'a(sb) 1 "/opt/app/\\"quoted\\"/.env" false' },
    /a path it had to escape to state/,
  ],
  ['systemd cannot load the unit at all', { LoadState: 's "masked"' }, /reports one-two-inventory\.service as 'masked' rather than loaded/],
  [
    'an array whose stated count and contents disagree is not an answer',
    { Environment: 'as 2 "NODE_ENV=production"' },
    /would not answer readably for one-two-inventory\.service's Environment=/,
  ],
  [
    'and neither is a rendering of some other signature',
    { EnvironmentFiles: 'as 1 "/opt/app/.env"' },
    /would not answer readably for one-two-inventory\.service's EnvironmentFiles=/,
  ],
]

test('o3d-2sm1.5 r21: a unit that can define DATABASE_URL anywhere but that file is refused', () => {
  // ROUTE: the entrypoint reads DATABASE_URL from the app's .env -> resolve_db_identity() ->
  // DB_FENCE_IDENTITY_ARGS -> the fence, the migration and the release. This is the question that
  // decides whether that file is the one the SERVICE uses, and r21 asks it of systemd's BUS: the
  // property's signature, the array's own element count, and the elements. It computes nothing
  // and resolves no precedence — it asks whether a second definition EXISTS.
  //
  // MUTATION: delete any one arm from env_file_is_sole_database_url_source() — the PAMName
  // refusal, the `count -gt 1` refusal, the name match in bus_element_names_database_url(), the
  // Environment/PassEnvironment/UnsetEnvironment loop, the `loads_our_file` comparison, the
  // LoadState check or the count-versus-elements check. That fixture's expectation flips from
  // REFUSE to SOLE, and the deploy proceeds to fence, migrate and release one database while the
  // restarted application connects to another. THREE OF THOSE WERE RUN, each failing on the one
  // fixture named for it and on nothing else:
  //
  //   * delete the `count -gt 2` refusal            -> 'a THIRD environment file' becomes SOLE;
  //   * delete the `-n "$pam_name"` refusal         -> 'PAMName= brings a whole environment
  //                                                    source with it' becomes SOLE;
  //   * match UnsetEnvironment on the bare token only, which is what the r20 reader did
  //     (`[[ "$element" == "DATABASE_URL" ]]` for that property alone, the other two left as
  //     they are) -> 'UnsetEnvironment= removes it in the ASSIGNMENT form' becomes SOLE while the
  //     bare-name fixture still refuses.
  const dir = mkdtempSync(join(tmpdir(), 'ims-systemd-'))
  try {
    writeFileSync(
      join(dir, 'busctl'),
      [
        '#!/usr/bin/env bash',
        // The two calls the reader makes, and nothing else: an unexpected one is an error, so a
        // reader that asked a different question would not silently get an answer.
        'if [[ "$1" == "call" ]]; then printf \'o "/org/freedesktop/systemd1/unit/fake_2eservice"\\n\'; exit 0; fi',
        '[[ "$1" == "get-property" ]] || exit 1',
        '[[ "$4" == org.freedesktop.systemd1.* ]] || exit 1',
        'name="FAKE_$5"',
        '[[ -n "${!name+set}" ]] || exit 1',
        'printf \'%s\\n\' "${!name}"',
        '',
      ].join('\n'),
    )
    chmodSync(join(dir, 'busctl'), 0o755)

    for (const script of ['deploy.sh', 'update.sh'] as const) {
      const lifted = liftSoleSource(script)
      // PRECONDITION: the whole mechanism was lifted, so a mutation to the shipped script really
      // does reach this test.
      assert.ok(lifted.includes('PAMName'), `${script}: the lifted reader asks about PAMName`)
      assert.ok(lifted.includes('bus_array_count'), `${script}: and reads the array's own count`)

      const bash = [
        'set -uo pipefail',
        'DB_IDENTITY_SOURCE_REASON=""',
        // r23's two globals. False and unset here, which is the shape at every call site that is
        // not the one about to start the service.
        'DB_ENV_SNAPSHOT_FILE="/etc/ims-cutover/db-identity-snapshot.env"',
        'DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"',
        'DB_ENV_SNAPSHOT_PUBLISHED=false',
        lifted,
        'if env_file_is_sole_database_url_source "$1" "$2"; then printf "SOLE\\n"; else printf "REFUSE %s\\n" "$DB_IDENTITY_SOURCE_REASON"; fi',
      ].join('\n')

      function ask(unit: SystemdUnit, argv: [string, string] = ['/opt/app/.env', 'one-two-inventory.service']): string {
        const properties = { ...SOLE_UNIT, ...unit }
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
        for (const [key, value] of Object.entries(properties)) env[`FAKE_${key}`] = value
        const run = spawnSync('bash', ['-c', bash, 'ask', ...argv], { encoding: 'utf8', env })
        assert.equal(run.status, 0, run.stderr)
        return (run.stdout ?? '').trim()
      }

      for (const [label, unit, refusal] of SYSTEMD_ANSWERS) {
        const answer = ask(unit)
        if (refusal === null) {
          assert.equal(answer, 'SOLE', `${script}: ${label} — the deploy may proceed`)
        } else {
          assert.match(answer, /^REFUSE /, `${script}: ${label} — must be refused`)
          assert.match(answer, refusal, `${script}: ${label} — and named`)
        }
      }

      // AND IF SYSTEMD CANNOT BE ASKED, THAT IS A REFUSAL TOO — never a pass by default. An empty
      // directory as the whole PATH is the smallest way to have no busctl; bash is invoked by
      // absolute path so that the child is the shell under test and not a PATH lookup failure.
      const empty = mkdtempSync(join(tmpdir(), 'ims-nopath-'))
      const absent = spawnSync('/bin/bash', ['-c', bash, 'ask', '/opt/app/.env', 'one-two-inventory.service'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: empty },
      })
      rmSync(empty, { recursive: true, force: true })
      assert.match((absent.stdout ?? '').trim(), /^REFUSE busctl/, `${script}: no busctl is a refusal`)

      // AND SO IS HAVING NO UNIT TO ASK ABOUT.
      assert.match(ask({}, ['/opt/app/.env', '']), /^REFUSE no systemd unit was identified/, `${script}: no unit is a refusal`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o3d-2sm1.5 r20: every fence path asks it, and the installer is still exempt', () => {
  // The question is only worth asking where it gates something. This is the other half of the
  // test above: that the shipped entrypoints actually put it in front of the fence, the
  // preflight and the exit-trap re-fence.
  //
  // MUTATION: delete a `require_env_file_is_sole_definition ||` line from either script and the
  // matching count assertion fails by name.
  const deploy = readFileSync(join(process.cwd(), 'scripts/deploy.sh'), 'utf8')
  const update = readFileSync(join(process.cwd(), 'scripts/update.sh'), 'utf8')
  const install = readFileSync(join(process.cwd(), 'scripts/install.sh'), 'utf8')

  for (const [name, source] of [['deploy.sh', deploy], ['update.sh', update]] as const) {
    // Wherever the identity is required, the source of that identity is required too: the two
    // refusals are the same refusal split in half, and one without the other is the finding.
    //
    // r29: publish_fence_recovery_record() also requires the identity, and it is NOT a gate — it
    // WRITES DOWN the identity the gates above it already established, so it has no sole-source
    // half and should not have one. It is excised by NAME rather than by proximity to anything,
    // and the excision is asserted to have removed something, so a gate added without its
    // sole-source half still fails this.
    const publisher = /publish_fence_recovery_record\(\) \{[\s\S]*?\n\}\n/
    const gates = source.replace(publisher, '')
    if (name === 'update.sh') {
      assert.notEqual(gates.length, source.length, 'precondition: the record publisher was found and excised')
    }
    const identity = gates.split('\n').filter((line) => line.includes('require_db_identity ||')).length
    const sole = gates.split('\n').filter((line) => line.includes('require_env_file_is_sole_definition ||')).length
    assert.ok(identity >= 3, `${name}: precondition — the identity is required at more than one place (${identity})`)
    assert.equal(sole, identity, `${name}: and its source is questioned at every one of them (${sole} of ${identity})`)

    // It asks systemd, and it asks about the one variable.
    // It asks SYSTEMD's own bus, and it asks about every property that can carry the variable —
    // PAMName included, which is the environment source the five-property text query omitted.
    assert.match(source, /busctl get-property org\.freedesktop\.systemd1/, `${name}: asks systemd over its bus`)
    assert.match(source, /for property in Environment PassEnvironment UnsetEnvironment/, `${name}: scans all three lists the same way`)
    assert.match(source, /bus_unit_property "\$object" Service PAMName/, `${name}: and asks about PAMName`)
    assert.ok(!source.includes('systemctl show -p Environment'), `${name}: and no longer parses systemctl's text rendering for it`)
  }

  // THE INSTALLER WAS EXEMPT UNTIL ROUND 23, AND IS NOT ANY MORE (Codex HIGH). The exemption's
  // reasoning was that it prompts for DB_HOST/DB_PORT/DB_NAME/DB_USER, composes DATABASE_URL out
  // of them and therefore "has no file to be wrong about". That stopped being true at the line
  // where it WRITES ${APP_DIR}/.env — long before the build, the migration and the start — and
  // the unit it then writes loads that file at exec. It still parses nothing and pins nothing
  // from the file (its identity is the shell value, which is why the check below is a string
  // comparison and not a four-value re-parse), but it must still ask systemd whether anything
  // ELSE can define DATABASE_URL for the service it is about to start.
  //
  // MUTATION: delete the `require_start_identity_bound ||` line from install.sh and both
  // assertions below fail; delete env_file_is_sole_database_url_source() from it and the first
  // fails on its own.
  assert.ok(install.includes('env_file_is_sole_database_url_source'), 'install.sh asks systemd about the unit it writes')
  assert.equal(
    install.split('\n').filter((line) => line.includes('require_start_identity_bound ||')).length,
    1,
    'install.sh gates its start on the composed unit, once, after its final daemon-reload',
  )
  assert.match(install, /busctl get-property org\.freedesktop\.systemd1/, 'install.sh: over the bus, like the other two')
})

/**
 * The re-read, lifted out of the shipped script and run by bash.
 *
 * `env_file_value()` comes with it because it is the reader the re-read uses, and in update.sh it
 * is new: lifting the pair together means a mutation to either one reaches this test.
 */
function liftIdentityRecheck(script: 'deploy.sh' | 'update.sh'): string {
  const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
  const reader = source.indexOf('env_file_value() {')
  const recheck = source.indexOf('env_file_identity_unchanged() {')
  assert.ok(reader > 0 && recheck > reader, `${script}: precondition — the shipped script re-reads the file`)
  const terminator = '\n  return 0\n}\n'
  return (
    source.slice(reader, source.indexOf('\n}\n', reader) + 3) +
    '\n' +
    source.slice(recheck, source.indexOf(terminator, recheck) + terminator.length)
  )
}

/**
 * HOW EACH SCRIPT PINS THE IDENTITY, reproduced rather than approximated.
 *
 * deploy.sh reads the file with env_file_value(); update.sh `source`s the whole .env in its
 * preflight and pins from the resulting variable. That difference is the reason update.sh needed
 * a file reader of its own, so the harness must keep it: pinning both the same way would test a
 * script neither of them is.
 */
const IDENTITY_PIN: Record<'deploy.sh' | 'update.sh', string> = {
  'deploy.sh': 'resolve_db_identity "$(env_file_value DATABASE_URL "${APP_DIR_REAL}/.env")" || true',
  'update.sh': 'set -a; source "${APP_DIR}/.env"; set +a\nresolve_db_identity "${DATABASE_URL:-}" || true',
}

const PINNED_URL = 'postgresql://app:pw@127.0.0.1:5432/main'
const PINNED_ARGS = '--app-host=127.0.0.1 --app-port=5432 --app-user=app --app-database=main'

test('o3d-2sm1.5 r22: a DATABASE_URL that changes between the pin and the fence is refused', () => {
  // ROUTE: ${APP_DIR}/.env -> the ONE parse at the top of the script -> DB_FENCE_IDENTITY_ARGS ->
  // `--fence --app-host=... --app-database=...` -> the database CONNECT is revoked on and the
  // migration runs against. systemd reads the SAME file again, at `EnvironmentFile=`, when it
  // execs the service at the end of the window — so the two ends of that route can be different
  // databases, and nothing compared them.
  //
  // MEASURED ON THIS HOST, read-only, before this test was written: ims-stage-dev.service and
  // ims-e2e-dev.service both answer `EnvironmentFiles` as `a(sb) 1 "<dir>/.env" true`. That
  // trailing `true` is ignore_errors — `EnvironmentFile=-` — which is why the DELETED case below
  // is not a loud failure at start time but a silent fallback to the application's own dotenv
  // overlays, on a database nothing here fenced.
  //
  // MUTATION: delete the `now_* != DB_IDENTITY_PINNED_*` comparison from
  // env_file_identity_unchanged() and every REPLACED case below answers UNCHANGED. Delete the
  // `-e` arm and DELETED answers UNCHANGED. Delete the `-f || -r` arm and NOT-A-FILE answers
  // UNCHANGED. Drop the `|| rc=$?` capture and the strict reader's own refusal is swallowed.
  for (const script of ['deploy.sh', 'update.sh'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'ims-identity-recheck-'))
    try {
      const bash = [
        'set -uo pipefail',
        'APP_DIR_REAL="$1"',
        'APP_DIR="$1"',
        'SERVICE_UNIT=""',
        'DB_IDENTITY_HOST=""; DB_IDENTITY_PORT=""; DB_IDENTITY_USER=""; DB_IDENTITY_DATABASE=""',
        'DB_IDENTITY_REASON=""; DB_IDENTITY_SOURCE_REASON=""; DB_IDENTITY_DRIFT_REASON=""',
        'DB_FENCE_IDENTITY_ARGS=()',
        liftReader(script),
        liftIdentityRecheck(script),
        // THE PIN, exactly as the shipped script takes it, and BEFORE the tamper.
        IDENTITY_PIN[script],
        'DB_IDENTITY_PINNED_HOST="$DB_IDENTITY_HOST"; DB_IDENTITY_PINNED_PORT="$DB_IDENTITY_PORT"',
        'DB_IDENTITY_PINNED_USER="$DB_IDENTITY_USER"; DB_IDENTITY_PINNED_DATABASE="$DB_IDENTITY_DATABASE"',
        'printf "PIN %s\\n" "${DB_FENCE_IDENTITY_ARGS[*]:-}"',
        // THE WINDOW: the build, the stop and the migration, compressed to whatever $2 does.
        'eval "$2"',
        'if env_file_identity_unchanged; then printf "UNCHANGED\\n"; else printf "REFUSE %s\\n" "$DB_IDENTITY_DRIFT_REASON"; fi',
        // AND WHAT THE RELEASE WOULD BE BUILT FROM AFTERWARDS.
        'printf "ARGS %s\\n" "${DB_FENCE_IDENTITY_ARGS[*]:-}"',
      ].join('\n')

      function ask(setup: string, tamper: string): string[] {
        rmSync(join(dir, '.env'), { force: true, recursive: true })
        rmSync(join(dir, 'other.env'), { force: true })
        rmSync(join(dir, 'real.env'), { force: true })
        // eslint-disable-next-line no-eval -- the setup runs in bash, not here
        const prepare = spawnSync('bash', ['-c', setup, 'setup', dir], { encoding: 'utf8' })
        assert.equal(prepare.status, 0, `${script}: fixture setup — ${prepare.stderr}`)
        const run = spawnSync('bash', ['-c', bash, 'recheck', dir, tamper], { encoding: 'utf8' })
        assert.equal(run.status, 0, `${script}: ${run.stderr}`)
        return (run.stdout ?? '').trim().split('\n')
      }

      const plain = `printf 'DATABASE_URL="${PINNED_URL}"\\n' > "$1/.env"`
      const viaSymlink = `printf 'DATABASE_URL="${PINNED_URL}"\\n' > "$1/real.env"; ln -sf "$1/real.env" "$1/.env"`

      // NON-VACUITY FIRST. An untouched file must answer UNCHANGED, or every refusal below is
      // just the check failing at everything and proving nothing about the tamper.
      const [pin, verdict, args] = ask(plain, ':')
      assert.equal(pin, `PIN ${PINNED_ARGS}`, `${script}: precondition — the identity was pinned from the file`)
      assert.equal(verdict, 'UNCHANGED', `${script}: an untouched file is not a refusal`)
      assert.equal(args, `ARGS ${PINNED_ARGS}`, `${script}: and the fence arguments are intact`)

      for (const [label, setup, tamper, reason] of [
        [
          // The case Codex named: replaced ATOMICALLY, so no reader ever sees a partial file and
          // nothing about the write is detectable except the contents.
          'replaced atomically with another database',
          plain,
          `printf 'DATABASE_URL="postgresql://app:pw@127.0.0.1:5432/other"\\n' > "$1/.env.new"; mv -f "$1/.env.new" "$1/.env"`,
          /now names app@127\.0\.0\.1:5432\/other, and this run is fencing and migrating app@127\.0\.0\.1:5432\/main/,
        ],
        [
          'replaced atomically with another host',
          plain,
          `printf 'DATABASE_URL="postgresql://app:pw@10.0.0.9:5432/main"\\n' > "$1/.env.new"; mv -f "$1/.env.new" "$1/.env"`,
          /now names app@10\.0\.0\.9:5432\/main/,
        ],
        [
          // EnvironmentFile=- means systemd SKIPS this, and the application's own dotenv overlays
          // answer instead. Measured on this host: both real units carry the `true`.
          'deleted, which the unit ignores rather than fails on',
          plain,
          `rm -f "$1/.env"`,
          /no longer exists[\s\S]*leading '-'[\s\S]*dotenv overlays/,
        ],
        [
          'a symlink retargeted at a different file',
          viaSymlink,
          `printf 'DATABASE_URL="postgresql://app:pw@127.0.0.1:5432/other"\\n' > "$1/other.env"; ln -sfn "$1/other.env" "$1/.env"`,
          /now names app@127\.0\.0\.1:5432\/other/,
        ],
        [
          'no longer a regular file',
          plain,
          `rm -f "$1/.env"; mkdir -p "$1/.env"`,
          /no longer a readable regular file/,
        ],
        [
          // THE STRICT READER IS RE-RUN, NOT RELAXED. A replacement that states no port is
          // refused in the reader's own words, not compared field by field against the pin — a
          // URL with no port is one PGPORT can move, which is the thing r19 closed.
          'replaced with a URL the strict reader refuses',
          plain,
          `printf 'DATABASE_URL="postgresql://app:pw@127.0.0.1/main"\\n' > "$1/.env"`,
          /no longer states a connection identity this will accept: DATABASE_URL states no port/,
        ],
      ] as [string, string, string, RegExp][]) {
        const [, answer, after] = ask(setup, tamper)
        assert.match(answer, /^REFUSE /, `${script}: ${label} — refused`)
        assert.match(answer, reason, `${script}: ${label} — and the reason says what changed`)
        // AND THE FENCE ARGUMENTS SURVIVE THE REFUSAL, which is the half that is easy to get
        // wrong. resolve_db_identity() CLEARS DB_FENCE_IDENTITY_ARGS as its first act, so a
        // re-read that returned without restoring them would empty the arguments that
        // release_db_connections() and the exit trap's re-fence are built from — turning the
        // detection into the outage it exists to prevent, on the one path where the fence is
        // standing over a migrated schema.
        //
        // MUTATION: delete the four restore lines after the `resolve_db_identity` call and this
        // assertion fails on every case with `ARGS ` and nothing after it.
        assert.equal(after, `ARGS ${PINNED_ARGS}`, `${script}: ${label} — the release is still armed with the pinned identity`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('o3d-2sm1.5 r22: the re-read stands at the fence, at the release, and after the last reload', () => {
  // The other half: that the shipped entrypoints put it at the three moments that matter. A
  // re-read defined and never called is the finding with extra code in it.
  //
  // ROUND 23 CHANGED THE THIRD ONE, AND ONLY THE THIRD. The post-reload check is now
  // require_start_identity_bound(), which runs the same two halves and additionally requires the
  // environment snapshot to be in the loaded configuration — the binding that makes the answer
  // survive the interval between the check and the exec. The first two are still the plain
  // re-read, because at those moments no snapshot has been published yet.
  //
  // MUTATION: delete any one of the three lines from either script and the count assertion fails
  // by name; move the post-reload one above `remove_reboot_fence` and the ordering assertion
  // fails, because a check that runs before this run's final daemon-reload is not asking the unit
  // configuration systemd is about to exec with; change the third back to
  // require_start_identity_unchanged and the "bound" assertion fails, because the loaded unit
  // would no longer have to name the file this run wrote.
  for (const [name, anchors] of [
    // `run systemctl start`, not `systemctl start`: the bare spelling appears in the comment
    // ABOVE the second re-read, which would make the ordering assertion pass on prose.
    ['deploy.sh', { release: 'THIS IS THE ONLY PLACE A RELEASE FOLLOWS A MIGRATION', start: 'run systemctl start' }],
    ['update.sh', { release: 'THE ONLY PLACE A RELEASE FOLLOWS A MIGRATION', start: 'run systemctl start' }],
  ] as const) {
    const source = readFileSync(join(process.cwd(), `scripts/${name}`), 'utf8')
    // `|| die`, not `||`: require_start_identity_bound() calls the plain re-read inside its own
    // body, so counting the bare name would count the definition as a third call site.
    assert.equal(
      source.split('\n').filter((line) => line.includes('require_start_identity_unchanged || die')).length,
      2,
      `${name}: the file is re-read before the fence and before the release`,
    )
    assert.equal(
      source.split('\n').filter((line) => line.includes('require_start_identity_bound ||')).length,
      1,
      `${name}: and the post-reload moment asks for the BINDING, not only for another read`,
    )

    // 1. INSIDE THE FENCE, BEFORE IT IS RAISED. Nothing is fenced yet, so this is the cheap
    //    refusal — and it must come before the --fence invocation, not after it.
    const fence = source.indexOf('fence_db_connections() {')
    const preFence = source.indexOf('require_start_identity_unchanged ||', fence)
    // o3d-secops r23: the invocation is db_fence_raise(), which plans, publishes the authority as
    // root and only then issues `--fence`. The anchor moves with it.
    const raised = source.indexOf('db_fence_raise', fence)
    assert.ok(fence > 0 && preFence > fence && preFence < raised, `${name}: re-read before the fence is raised`)

    // 2. AND 3. THE START PATH, in order: re-read (fence HELD) -> release -> remove the reboot
    //    fence, whose daemon-reload is this run's last -> re-read again -> start.
    const anchor = source.indexOf(anchors.release)
    assert.ok(anchor > 0, `${name}: precondition — the start path is where it says it is`)
    const preRelease = source.indexOf('require_start_identity_unchanged ||', anchor)
    const release = source.indexOf('release_db_connections \\', anchor)
    // THE CALL, NOT THE WORD. `remove_reboot_fence` is named in the comment above the second
    // re-read, so indexOf() on the bare name found that comment and the ordering assertion below
    // passed with the re-read moved to the WRONG SIDE of the reload — proved by running exactly
    // that mutation. A line that is only the call cannot be satisfied by prose.
    const rebootOffset = source.slice(release).search(/^remove_reboot_fence$/m)
    assert.ok(rebootOffset > 0, `${name}: precondition — the reboot fence comes down by a call, on its own line`)
    const reboot = release + rebootOffset
    const postReload = source.indexOf('require_start_identity_bound ||', reboot)
    const start = source.indexOf(anchors.start, reboot)
    assert.ok(preRelease > anchor && preRelease < release, `${name}: re-read while the fence is still held`)

    // AND THE BINDING IS PUBLISHED WHILE THE FENCE IS STILL HELD TOO (o3d-2sm1.5 r23). Publishing
    // after the release would leave a window in which the database is open and the service is
    // startable by hand on whatever the file says — the exact window the release exists to close
    // in one direction and this closes in the other.
    const publish = source.indexOf('publish_db_identity_snapshot ||', anchor)
    assert.ok(publish > preRelease && publish < release, `${name}: the snapshot is published after the check and before the release`)
    assert.ok(release < reboot, `${name}: precondition — the reboot fence comes down after the release`)
    assert.ok(postReload > reboot, `${name}: re-read again AFTER the final daemon-reload`)
    assert.ok(postReload < start, `${name}: and before anything is started`)

    // IT RE-RUNS THE STRICT READER AND THE BUS QUESTION — it does not carry its own looser copy
    // of either. This is what keeps "re-run them, don't relax them" true in the source rather
    // than only in the commit message.
    assert.match(source, /^\s*resolve_db_identity "\$\(env_file_value DATABASE_URL "\$env_file"\)" \|\| rc=\$\?$/m, `${name}: the same strict reader`)
    assert.match(source, /^\s*if ! require_env_file_is_sole_definition; then$/m, `${name}: and the same bus question`)
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 r23 — THE BINDING, not another read.
// ---------------------------------------------------------------------------

/** The shape the bus reports for a unit that loads .env and then this run's snapshot. */
const SNAPSHOT_PATH = '/etc/ims-cutover/db-identity-snapshot.env'

test('o3d-2sm1.5 r23: the loaded unit must name THIS run\'s snapshot, last and mandatory', () => {
  // ROUTE: `systemctl show`'s bus equivalent -> env_file_is_sole_database_url_source() -> the
  // refusal that stands between the final daemon-reload and `systemctl start`. Rounds 20-22 asked
  // this question to find out whether anything ELSE could define DATABASE_URL; r23 also asks it to
  // prove that the one thing that CAN is a file this run wrote where the application user cannot
  // reach it. Both halves are asserted here, on the same lifted function, because relaxing either
  // one turns the binding back into the re-read it replaced.
  //
  // WHY EACH REFUSAL EXISTS, stated as the thing that would otherwise happen:
  //   * not published by this run   -> a drop-in left by an older cutover pins a DATABASE_URL
  //                                    nobody in this run validated.
  //   * not the snapshot's path     -> some other tool's environment file wins the last-definition
  //                                    race and the service connects where IT says.
  //   * loaded with a leading '-'   -> deleting the file between the check and the exec silently
  //                                    hands the service back to .env, which is the whole defect.
  //   * snapshot FIRST, .env second -> .env is then the last definition and the binding is inert.
  //   * required but absent         -> the start would go ahead on a value that can still move.
  //
  // MUTATION: delete any one of the four arms inside the `for index in 0 1` loop, or the
  // `DB_IDENTITY_REQUIRE_SNAPSHOT && count -ne 2` refusal after it. Each has exactly one fixture
  // below that flips from REFUSE to SOLE, and no other fixture changes.
  const dir = mkdtempSync(join(tmpdir(), 'ims-systemd-bind-'))
  try {
    writeFileSync(
      join(dir, 'busctl'),
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "call" ]]; then printf \'o "/org/freedesktop/systemd1/unit/fake_2eservice"\\n\'; exit 0; fi',
        '[[ "$1" == "get-property" ]] || exit 1',
        '[[ "$4" == org.freedesktop.systemd1.* ]] || exit 1',
        'name="FAKE_$5"',
        '[[ -n "${!name+set}" ]] || exit 1',
        'printf \'%s\\n\' "${!name}"',
        '',
      ].join('\n'),
    )
    chmodSync(join(dir, 'busctl'), 0o755)

    for (const script of ['deploy.sh', 'update.sh', 'install.sh'] as const) {
      const lifted = liftSoleSource(script)
      // PRECONDITION: the r23 half really was lifted, so a mutation to the shipped script reaches
      // this test rather than a stale copy of an older function.
      assert.ok(lifted.includes('bus_read_env_ignore_flags'), `${script}: the lifted reader reads the ignore_errors flags`)
      assert.ok(lifted.includes('DB_ENV_SNAPSHOT_PUBLISHED'), `${script}: and knows whether this run published a snapshot`)

      function ask(envFiles: string, published: boolean, required: boolean): string {
        const bash = [
          'set -uo pipefail',
          'DB_IDENTITY_SOURCE_REASON=""',
          `DB_ENV_SNAPSHOT_FILE="${SNAPSHOT_PATH}"`,
          'DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"',
          `DB_ENV_SNAPSHOT_PUBLISHED=${published}`,
          lifted,
          `DB_IDENTITY_REQUIRE_SNAPSHOT=${required}`,
          'if env_file_is_sole_database_url_source "$1" "$2"; then printf "SOLE\\n"; else printf "REFUSE %s\\n" "$DB_IDENTITY_SOURCE_REASON"; fi',
        ].join('\n')
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
        for (const [key, value] of Object.entries({ ...SOLE_UNIT, EnvironmentFiles: envFiles })) env[`FAKE_${key}`] = value
        const run = spawnSync('bash', ['-c', bash, 'ask', '/opt/app/.env', 'one-two-inventory.service'], { encoding: 'utf8', env })
        assert.equal(run.status, 0, run.stderr)
        return (run.stdout ?? '').trim()
      }

      const bound = `a(sb) 2 "/opt/app/.env" true "${SNAPSHOT_PATH}" false`

      // THE SHAPE THE BINDING MAKES, and it must pass BOTH ways round — as the ordinary "nothing
      // else defines it" question and as the start's "and the binding is there" question. If it
      // failed either, the start could never proceed and every refusal below would be vacuous.
      assert.equal(ask(bound, true, false), 'SOLE', `${script}: .env then this run's snapshot is the shape`)
      assert.equal(ask(bound, true, true), 'SOLE', `${script}: and it satisfies the start's requirement`)

      // AND THE PLAIN SHAPE IS STILL FINE EVERYWHERE ELSE, which is what keeps the two questions
      // different rather than one question asked twice.
      assert.equal(ask('a(sb) 1 "/opt/app/.env" true', false, false), 'SOLE', `${script}: .env alone, before any snapshot`)

      for (const [label, envFiles, published, required, refusal] of [
        [
          'a snapshot this run did not publish, which is an unexplained pin',
          bound, false, false,
          /loads a second environment file, \/etc\/ims-cutover\/db-identity-snapshot\.env, that this run did not publish/,
        ],
        [
          'a second file that is not the snapshot, which would win the last-definition race',
          'a(sb) 2 "/opt/app/.env" true "/etc/ims/other.env" false', true, false,
          /and this run's environment snapshot is \/etc\/ims-cutover\/db-identity-snapshot\.env/,
        ],
        [
          "the snapshot loaded with a leading '-', so losing it is silent instead of fatal",
          `a(sb) 2 "/opt/app/.env" true "${SNAPSHOT_PATH}" true`, true, false,
          /loads .* with a leading '-', so systemd SKIPS it if it is missing/,
        ],
        [
          'the snapshot FIRST and .env second, so .env is the last definition and the pin is inert',
          `a(sb) 2 "${SNAPSHOT_PATH}" false "/opt/app/.env" true`, true, false,
          /as its first environment file and not \/opt\/app\/\.env/,
        ],
        [
          'no snapshot at all, at the one call site that requires one',
          'a(sb) 1 "/opt/app/.env" true', true, true,
          /does not load this run's environment snapshot/,
        ],
      ] as [string, string, boolean, boolean, RegExp][]) {
        const answer = ask(envFiles, published, required)
        assert.match(answer, /^REFUSE /, `${script}: ${label} — must be refused`)
        assert.match(answer, refusal, `${script}: ${label} — and named`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o3d-2sm1.5 r23: the snapshot is written verbatim, root-only, and loaded without a fallback', () => {
  // ROUTE: publish_db_identity_snapshot() -> ${DB_ENV_SNAPSHOT_FILE} and the drop-in that loads it
  // -> systemd at exec. This is the WRITING end of the test above: it runs the shipped function
  // with `chown`, `chmod` and `systemctl` recorded rather than performed, and asserts the bytes.
  //
  // WHY SINGLE QUOTES. systemd.exec documents a single-quoted value as verbatim — "can span
  // multiple lines and contain any character verbatim other than single quote" — so the deploy's
  // reader and systemd's reader cannot disagree about a password containing a backslash or a `#`,
  // which they can for an unquoted one. A value carrying a single quote has no verbatim spelling
  // and is refused rather than escaped into a form the two would read differently.
  //
  // MUTATION: drop the quotes from the printf and the `$#` password below is written bare, so the
  // content assertion fails (and systemd would read it as a comment). Add a leading `-` to the
  // EnvironmentFile= line and the drop-in assertion fails. Delete the chmod 700 and the recorded
  // mode assertion fails, leaving the file in a directory whose mode nothing established.
  for (const [script, appVar] of [['deploy.sh', 'APP_DIR_REAL'], ['update.sh', 'APP_DIR'], ['install.sh', 'APP_DIR']] as const) {
    const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
    const start = source.indexOf('publish_db_identity_snapshot() {')
    assert.ok(start > 0, `${script}: precondition — the shipped script publishes a snapshot`)
    const lifted = source.slice(start, source.indexOf('\n  return 0\n}\n', start) + 14)
    assert.ok(lifted.includes('publish_durable_file'), `${script}: and publishes it durably`)

    const dir = mkdtempSync(join(tmpdir(), 'ims-snapshot-'))
    try {
      const url = "postgresql://app:p#ss\\word@127.0.0.1:5432/main"
      writeFileSync(join(dir, '.env'), `DATABASE_URL="${url}"\n`)
      const bash = [
        'set -uo pipefail',
        'DRY_RUN=false',
        'RED=""; RESET=""; YELLOW=""',
        `${appVar}="$1"`,
        'APP_DIR="$1"',
        'APP_NAME="one-two-inventory"',
        'SERVICE_UNIT="one-two-inventory.service"',
        'SERVICE_UNITS=("one-two-inventory.service")',
        'DATABASE_URL="$3"',
        `DB_ENV_SNAPSHOT_DIR="$1/etc"`,
        `DB_ENV_SNAPSHOT_FILE="$1/etc/db-identity-snapshot.env"`,
        'DB_ENV_SNAPSHOT_DROPIN_NAME="zz-deploy-db-identity.conf"',
        'DB_ENV_SNAPSHOT_DROPIN_FILE="$1/dropins/one-two-inventory.service.d/zz-deploy-db-identity.conf"',
        'DB_ENV_SNAPSHOT_PUBLISHED=false',
        'DB_ENV_SNAPSHOT_DROPINS_CREATED=()',
        // RECORDED, NOT PERFORMED: the test does not run as root, and what matters is that the
        // shipped function ASKS for root ownership and a 0700 directory.
        'CALLS="$2"',
        'chown() { printf "CHOWN %s\\n" "$*" >> "$CALLS"; return 0; }',
        'chmod() { printf "CHMOD %s\\n" "$*" >> "$CALLS"; return 0; }',
        'systemctl() { printf "SYSTEMCTL %s\\n" "$*" >> "$CALLS"; return 0; }',
        'error() { printf "ERROR %s\\n" "$*"; }',
        'warn() { printf "WARN %s\\n" "$*"; }',
        'fsync_path() { sync "$1" 2>/dev/null || true; return 0; }',
        // o3d-czpy: publish_durable_file() stages through a root-owned directory named here.
        // o3d-secops: the declaration begins `readonly` now, so it is read by scope and not by
        // the start of a line.
        shellConstant(source, 'PUBLISH_STAGE_DIRNAME'),
        readShellFunction(source, 'publish_trust_root_candidates'),
        // o3d-rn10 r4: publish_root_anchored() is a subshell around this walk.
        readShellFunction(source, 'pin_publish_root_parent'),
        readShellFunction(source, 'publish_root_anchored'),
        readShellFunction(source, 'publish_trust_root'),
        // o3d-secops r7: the shared symlinked-root refusal pin_dir_beneath_root() calls.
        readShellFunction(source, 'refuse_symlinked_root'),
        readShellFunction(source, 'pin_dir_beneath_root'),
        readShellFunction(source, 'publish_durable_file'),
        readShellFunction(source, 'publish_durable_dropin'),
        readShellFunction(source, 'env_file_value'),
        // deploy.sh names its own unit drop-ins through a helper; the other two use a variable.
        source.includes('snapshot_dropin_file() {') ? 'snapshot_dropin_file() { echo "$DB_ENV_SNAPSHOT_DROPIN_FILE"; }' : '',
        lifted,
        'if publish_db_identity_snapshot; then printf "PUBLISHED\\n"; else printf "REFUSED\\n"; fi',
      ].join('\n')

      const run = spawnSync('bash', ['-c', bash, 'publish', dir, join(dir, 'calls.log'), url], { encoding: 'utf8' })
      assert.equal(run.status, 0, `${script}: ${run.stderr}`)
      assert.match(run.stdout ?? '', /PUBLISHED/, `${script}: the shipped function published`)

      // THE VALUE, VERBATIM AND QUOTED. The `#` and the backslash are exactly the characters an
      // unquoted systemd value would mangle.
      const written = readFileSync(join(dir, 'etc/db-identity-snapshot.env'), 'utf8')
      assert.equal(written, `DATABASE_URL='${url}'\n`, `${script}: the value is written single-quoted and whole`)

      // THE DROP-IN, AND THE ABSENT '-'. `EnvironmentFile=-` would make a deleted snapshot a
      // silent fall-through to .env instead of a refused start.
      const dropin = readFileSync(join(dir, 'dropins/one-two-inventory.service.d/zz-deploy-db-identity.conf'), 'utf8')
      assert.match(dropin, /^EnvironmentFile=[^-]/m, `${script}: the snapshot is loaded MANDATORILY`)
      assert.ok(dropin.includes(`EnvironmentFile=${join(dir, 'etc/db-identity-snapshot.env')}`), `${script}: and it is the snapshot`)
      assert.match(dropin, /^\[Service\]$/m, `${script}: in the section that can carry it`)

      // AND THE OWNERSHIP IT ASKED FOR. A snapshot in a directory the application user can write
      // is not a binding — the service could delete what it is bound to.
      const calls = readFileSync(join(dir, 'calls.log'), 'utf8')
      assert.match(calls, new RegExp(`CHOWN root:root ${join(dir, 'etc')}$`, 'm'), `${script}: the directory is root-owned`)
      assert.match(calls, new RegExp(`CHMOD 700 ${join(dir, 'etc')}$`, 'm'), `${script}: and unreadable to anyone else`)
      assert.match(calls, /SYSTEMCTL daemon-reload/, `${script}: and the drop-in is loaded before anything asks about it`)

      // A VALUE WITH NO VERBATIM SPELLING IS REFUSED, not escaped into something the two readers
      // would disagree about.
      writeFileSync(join(dir, '.env'), "DATABASE_URL=\"postgresql://a:it's@h:5432/d\"\n")
      const quoted = spawnSync('bash', ['-c', bash, 'publish', dir, join(dir, 'calls.log'), "postgresql://a:it's@h:5432/d"], { encoding: 'utf8' })
      assert.match(quoted.stdout ?? '', /REFUSED/, `${script}: a single quote in the value is refused`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

/** One shell function out of a script, by name, closed by a `}` in column 0. */
function readShellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `the script must define ${name}()`)
  const rest = source.slice(start + 1)
  const end = rest.indexOf('\n}\n')
  assert.notEqual(end, -1, `${name}() must be closed by a } in column 0`)
  return rest.slice(0, end + 2)
}

test('o3d-2sm1.5 r23: the trap re-fences the database it migrated even when the UNIT now disagrees', () => {
  // ROUTE: the post-release refusal (`require_start_identity_bound || die`) -> the exit trap ->
  // SCHEMA_TOUCHED true, DB_FENCE_UP false -> refence_db_connections() -> `--fence`.
  //
  // THE DEFECT (Codex MEDIUM). refence_db_connections() re-ran
  // require_env_file_is_sole_definition() before issuing --fence. That is a START gate: it asks
  // whether anything but the app's .env can define DATABASE_URL for the SERVICE. The single
  // commonest reason control reaches this trap with the fence down is that the very same refusal
  // just fired upstream — so the guard necessarily failed again on the still-present unit
  // disagreement, the function returned before `--fence`, and the banner announced a re-fence
  // that was never attempted. The migrated database's CONNECT grants stayed RELEASED, with remote
  // writers and any second application free to reconnect during recovery.
  //
  // THE RULE. Once this run has fenced and migrated, WHICH database to shut is not in question —
  // it is the pinned identity, and what some unit now claims about its environment cannot make
  // that the wrong database to close. It can make it wrong to START the application, which is
  // exactly what the upstream refusal already decided.
  //
  // MUTATION: make the `require_env_file_is_sole_definition || return 1` unconditional again and
  // the first assertion below fails — no --fence is issued on the recovery path. Delete the guard
  // entirely (never ask it) and the last assertion fails, because the forward path would then
  // re-fence a database whose service may be reading its identity from somewhere else.
  for (const [script, runner] of [['deploy.sh', 'as_app_user'], ['update.sh', 'run_as_user']] as const) {
    const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
    const start = source.indexOf('refence_db_connections() {')
    assert.ok(start > 0, `${script}: precondition — the trap re-fences through a function of its own`)
    const lifted = source.slice(start, source.indexOf('\n  return 0\n}\n', start) + 14)
    assert.ok(lifted.includes('db_fence_raise'), `${script}: and the lifted body is the one that issues it`)

    // A REAL FILE, because the shipped function refuses when the fence script is missing — and a
    // test whose every call refused there would prove nothing about the guard under test.
    const fenceDir = mkdtempSync(join(tmpdir(), 'ims-refence-'))
    // A CHECKOUT, not a bare file (o3d-2sm1.5 r32): resolving the fence script now VENDORS the
    // helper's dependency closure into the protected mirror, so the harness has to give it the
    // shipped layout to vendor from — `<app>/scripts/fence-db-connections.mjs` beside
    // `<app>/node_modules`. A run with no `pg` to resolve refuses to publish, and every assertion
    // below would then pass or fail for that reason instead of the one under test.
    const fenceScript = writeFenceCheckout(fenceDir, '')

    function refence(schemaTouched: boolean, raised: boolean, soleOk: boolean): string {
      const bash = [
        'set -uo pipefail',
        'DB_FENCE_UP=false',
        'DRY_RUN=false',
        'DB_FENCE_SCRIPT="$1"',
        // r29/r30: the shipped function resolves the script it runs before anything else, and
        // since r30 that is ALWAYS the root-owned copy — the checkout's file is published into it
        // and never executed in place. Both paths are under the harness directory here; the copy
        // is absent to begin with, so the resolver publishes the real file above into it and runs
        // that, which is what every assertion below is written against.
        // r31: the resolution is the SHARED library both scripts source, so the harness runs its
        // shipped text and points its trust root at the harness directory. Lifting the functions one
        // by one would keep passing if an entrypoint stopped calling them, which is the finding.
        // o3d-secops r2: the redirection is a substitution INSIDE that text, because the paths are
        // `readonly` and an assignment after the source is now refused — as it should be.
        ...protectedLibraryLines(fenceDir),
        // resolve_fence_script() is what both entrypoints now call: it resolves the artefact AND
        // refreshes the root-owned recovery wrappers, so that the file executed and the file an
        // operator is pointed at can never be about different artefacts. Lifted rather than
        // stubbed, because "which script does the trap run" is the claim.
        liftedResolver(source),
        `DB_FENCE_RELEASE_WRAPPER=${JSON.stringify(join(fenceDir, 'recovery', 'release-db-fence'))}`,
        `DB_FENCE_REFENCE_WRAPPER=${JSON.stringify(join(fenceDir, 'recovery', 'refence-db'))}`,
        `APP_DIR=${JSON.stringify(join(fenceDir, 'app'))}`,
        `APP_DIR_REAL=${JSON.stringify(join(fenceDir, 'app'))}`,
        'DEPLOY_ADMIN_DATABASE_URL="postgresql://admin@127.0.0.1:5432/main"',
        'DATABASE_URL="postgresql://app:pw@127.0.0.1:5432/main"',
        'APP_USER="app"',
        // o3d-secops r23: the authority is published by root into a directory only root may
        // write, and db_fence_publish_authority() REFUSES anywhere else — so the harness points it
        // at its own private temporary rather than at /tmp, which is 1777.
        `DB_FENCE_STATE=${JSON.stringify(join(fenceDir, 'state.json'))}`,
        // o3d-secops r28: the recovery wrappers take the entrypoint's own cutover lock for their
        // whole read/audit/act sequence, so the entrypoint hands them its path. The resolver
        // lifted above is what publishes them, so the rig has to supply it exactly as deploy.sh
        // and update.sh do -- and a rig that did not would be measuring an unpublishable wrapper.
        `LOCK_FILE=${JSON.stringify(join(fenceDir, 'cutover.lock'))}`,
        'DB_FENCE_RELEASE_CMD="release"',
        'MIGRATION_DATABASE_URL=""',
        'DB_FENCE_IDENTITY_ARGS=(--app-host=127.0.0.1 --app-port=5432 --app-user=app --app-database=main)',
        `SCHEMA_TOUCHED=${schemaTouched}`,
        `DB_FENCE_RAISED=${raised}`,
        'require_db_identity() { return 0; }',
        // o3d-secops r23: raising a fence is plan -> authorise -> execute, so the rig carries the
        // orchestration (from the sourced library), the namespace library's directory predicate,
        // and the one adapter each entrypoint supplies for itself.
        shellFunction(CUTOVER_NS_LIB_SOURCE, 'dir_is_private_to_this_run'),
        shellFunction(source, 'db_fence_helper'),
        // THE STILL-PRESENT DISAGREEMENT: the unit acquired another environment source and the
        // gate keeps saying so, exactly as it does upstream.
        `require_env_file_is_sole_definition() { ${soleOk ? 'return 0' : 'return 1'}; }`,
        'warn() { :; }',
        // THE PRIVILEGE DROP, STUBBED — and it answers `--plan` the way the shipped mode does,
        // because root validates the plan against the identity IT supplied. CALL goes to STDERR so
        // that the plan is the only thing on stdout: a diagnostic line there would be a corrupt
        // record, which is exactly the property the shipped `--plan` mode is written around.
        `${runner}() { printf "CALL %s\\n" "$*" >&2; case "$*" in *--plan*) printf '{"database":"main","owner_role":"app","app_role":"app","admin_role":"admin","revoked":["PUBLIC","app"],"datacl_before":null,"fenced_at":"2026-01-01T00:00:00.000Z"}\\n' ;; esac; return 0; }`,
        lifted,
        'refence_db_connections || printf "RETURNED-NONZERO\\n"',
      ].join('\n')
      const run = spawnSync('bash', ['-c', bash, 'refence', fenceScript], { encoding: 'utf8' })
      assert.equal(run.status, 0, `${script}: ${run.stderr}`)
      // Both streams: the CALL log is on stderr since r23 so that stdout can carry the plan.
      return `${run.stdout ?? ''}${run.stderr ?? ''}`
    }

    // THE RECOVERY PATH: schema touched, unit disagreeing. The re-fence must happen anyway.
    assert.match(
      refence(true, false, false),
      /CALL .*--fence --state-file/,
      `${script}: a migrated database is re-closed even though the unit now names another environment source`,
    )
    // The same when the disagreement is absent, so the assertion above is not passing on a
    // function that ignores the gate in every case.
    assert.match(refence(true, false, true), /CALL .*--fence --state-file/, `${script}: and when it agrees`)
    // AND THE FORWARD PATH IS UNCHANGED: nothing migrated, nothing committed, and a service whose
    // DATABASE_URL something else can define is still a database this must not aim at.
    assert.doesNotMatch(
      refence(false, false, false),
      /--fence --state-file/,
      `${script}: with nothing fenced or migrated yet, the unit-source gate still refuses`,
    )
    // A run that COMMITTED revokes has a database to re-close too, even before SCHEMA_TOUCHED.
    assert.match(refence(false, true, false), /CALL .*--fence --state-file/, `${script}: and a committed fence counts`)
    rmSync(fenceDir, { recursive: true, force: true })
  }
})

test('o3d-2sm1.5 r23: the binding is taken away on every exit, and a stale one is cleared first', () => {
  // A drop-in that outlives its run is worse than no drop-in: it overrides ${APP_DIR}/.env for
  // every restart, reboot and Restart= that follows, silently, from a file in /etc/systemd/system
  // that no document mentions. So the removal is on the success path AND in the failure trap, and
  // a snapshot some SIGKILLed run left behind is cleared before anything asks the bus about it.
  //
  // MUTATION: delete either removal call from any entrypoint and its count assertion fails by
  // name; delete the clear and the ordering assertion fails, and a re-run after a hard kill would
  // refuse at the validate phase on a drop-in it wrote itself last time.
  for (const script of ['deploy.sh', 'update.sh', 'install.sh'] as const) {
    const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
    const calls = source.split('\n').filter((line) => /^\s*(\$DRY_RUN \|\| )?remove_db_identity_snapshot$/.test(line))
    assert.ok(calls.length >= 2, `${script}: the binding comes off on more than one path (${calls.length})`)

    // THE FAILURE PATH: after the re-stop, so nothing is running with a pin that is about to be
    // withdrawn, and before the reboot fence goes back. Anchored on the trap's OWN re-install —
    // `systemctl stop` appears in several other places, and indexOf from the first of them would
    // measure a distance in a different part of the script.
    const reinstall = source.search(/install_reboot_fence "(deploy|update|install) failed at /)
    assert.ok(reinstall > 0, `${script}: precondition — the failure trap re-installs the reboot fence`)
    const stop = source.lastIndexOf('systemctl stop', reinstall)
    assert.ok(stop > 0, `${script}: precondition — the trap re-stops before it re-fences`)
    const trapRemoval = source.indexOf('remove_db_identity_snapshot', stop)
    assert.ok(trapRemoval > stop && trapRemoval < reinstall, `${script}: the trap withdraws the binding it published`)
  }

  // AND THE TWO SCRIPTS THAT CAN BE RE-RUN AFTER A HARD KILL CLEAR A LEFTOVER BEFORE THE VALIDATE
  // PHASE ASKS THE BUS. install.sh needs none: it publishes (and so overwrites) before it asks.
  for (const script of ['deploy.sh', 'update.sh'] as const) {
    const source = readFileSync(join(process.cwd(), `scripts/${script}`), 'utf8')
    const clear = source.indexOf('$DRY_RUN || remove_db_identity_snapshot')
    const fenceable = source.indexOf('require_fenceable_database\n')
    assert.ok(clear > 0, `${script}: a leftover snapshot is cleared`)
    assert.ok(fenceable > clear, `${script}: and cleared BEFORE the first question about the unit`)
  }
})

// ---------------------------------------------------------------------------
// AGAINST A REAL POSTGRESQL CLUSTER (o3d-secops r28, Codex HIGH 1 + HIGH 2)
//
// Both findings this section answers are about what a SERVER does, and neither can be measured
// against a fixture without the fixture's author first modelling the thing the finding says was
// modelled wrongly:
//
//   HIGH 2  `datacl::text` is an ARRAY LITERAL whose quoted elements backslash-escape their own
//           quotes and backslashes. A test that writes the escaped form by hand is a test of
//           whether its author can write it. So the roles are CREATEd, the grants are issued, and
//           PostgreSQL prints what PostgreSQL prints.
//   HIGH 1  "two clusters that both host a database of this name" is not something a mock can
//           exhibit either. Two real clusters are started, both holding a database called `imsdb`
//           with the same roles, and the audit is pointed at the wrong one THROUGH a URL that
//           names the right one -- which is what DNS, a proxy or a failover actually produces.
//
// FRESH CLUSTERS, EVERY RUN. `initdb` into a throwaway directory: the database is new, its OID and
// system identifier are new, and nothing here can pass because of state a previous run left. (PR
// #663 on the sibling branch was approved and then failed CI on a fresh-database concurrency run;
// a reused database is a different environment.)
//
// THE SAME PORT ON BOTH, which is what makes the cluster gate load-bearing rather than decorative:
// the host, the port, the database name and the login role all match on the bystander cluster, so
// every check that existed before this round passes there. Only one of the two binds TCP -- the
// other is reached over its unix socket -- which is how two clusters can claim one port.
// ---------------------------------------------------------------------------

test('the shipped ACL query reads role names PostgreSQL has to quote, and a NULL datacl as the defaults (o3d-secops r28)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ims-fence-pg-'))
  const port = await freePort()
  let cluster: ReturnType<typeof startCluster> | undefined
  try {
    cluster = startCluster(root, 'acl', port, '127.0.0.1')
    const me = currentUser()
    // THE NAMES THE OLD PARSER COULD NOT READ. Each is a role PostgreSQL must quote in `datacl`,
    // and `we"ird` and `back\slash` are the two it must additionally BACKSLASH-ESCAPE inside that
    // quoting -- which is the escaping the old parser ignored entirely.
    const odd = ['we"ird', 'back\\slash', 'comma,role', 'UpperCase']
    cluster.psql(['-c', `CREATE ROLE ${JSON.stringify('owner_role')} LOGIN`])
    for (const role of odd) cluster.psql(['-c', `CREATE ROLE ${quoteIdent(role)} LOGIN`])
    cluster.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
    cluster.psql(['-c', `CREATE DATABASE imsdb OWNER ${JSON.stringify('owner_role')}`])

    // 1. THE UNTOUCHED DATABASE: `datacl` IS NULL, and that is not "no privileges".
    assert.equal(cluster.psql(['-c', "SELECT datacl IS NULL FROM pg_database WHERE datname = 'imsdb'"]), 't',
      'precondition: a database nobody has granted on carries a NULL datacl')
    const readPrivileges = () => JSON.parse(cluster!.psql([
      '-c', `SELECT ${DATACL_PRIVILEGES_SQL} FROM pg_database d WHERE d.datname = 'imsdb'`,
    ]))
    const defaults = readPrivileges()
    assert.equal(granteeHasConnect(defaults, PUBLIC_GRANTEE), true,
      `a NULL datacl grants CONNECT to PUBLIC, which is what acldefault() says and what a restore depends on:\n${JSON.stringify(defaults)}`)
    assert.deepEqual(listDirectConnectGrantees(defaults), ['owner_role'],
      'and everything to the owner, which is the only NAMED grantee there')
    assert.equal(granteeHasConnect(defaults, 'imsapp'), false, 'and nothing to anybody else')

    // 2. NOW THE GRANTS THAT NEED QUOTING. What PostgreSQL prints is recorded here as evidence of
    //    the shape, not parsed: it is the input the old reader could not handle.
    for (const role of [...odd, 'imsapp']) {
      cluster.psql(['-c', `GRANT CONNECT ON DATABASE imsdb TO ${quoteIdent(role)}`])
    }
    const printed = cluster.psql(['-c', "SELECT datacl::text FROM pg_database WHERE datname = 'imsdb'"])
    assert.match(printed, /\\"we\\"\\"ird\\"/,
      `precondition: PostgreSQL backslash-escapes the quotes inside a quoted ACL element, which is the encoding the old parser ignored:\n${printed}`)
    assert.match(printed, /comma,role/, `precondition: and quotes an element containing a comma:\n${printed}`)

    const granted = readPrivileges()
    for (const role of [...odd, 'imsapp']) {
      assert.equal(granteeHasConnect(granted, role), true,
        `${JSON.stringify(role)} holds CONNECT on the real server and must be read as holding it:\n${JSON.stringify(granted)}`)
    }
    assert.deepEqual(
      listDirectConnectGrantees(granted).slice().sort(),
      ['back\\slash', 'comma,role', 'imsapp', 'owner_role', 'UpperCase', 'we"ird'].sort(),
      'every named grantee, by the name the catalogue gives it and not by one reconstructed from text',
    )
    assert.ok(!listDirectConnectGrantees(granted).includes(''), 'and PUBLIC is not among them')

    // 3. AND THE REVOKE BUILT FROM THOSE NAMES ACTUALLY EXECUTES. Reading the name correctly is
    //    half of it; the other half is that the statement the fence issues names the same role.
    //    The old parser produced `\weird\`, which is a role no server has -- so the fence aborted.
    for (const statement of buildRevokeStatements('imsdb', listDirectConnectGrantees(granted).filter((r) => r !== 'owner_role'))) {
      cluster.psql(['-c', statement])
    }
    const afterRevoke = readPrivileges()
    for (const role of odd) {
      assert.equal(granteeHasConnect(afterRevoke, role), false,
        `${JSON.stringify(role)} must actually lose CONNECT, which is what proves the name round-tripped:\n${JSON.stringify(afterRevoke)}`)
    }
    assert.deepEqual(listDirectConnectGrantees(afterRevoke), ['owner_role'], 'leaving the owner, as a fence does')
  } finally {
    cluster?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// THE TWO KINDS OF NOTHING (o3d-secops r29, Codex HIGH 1)
//
// r28 gave compareClusterIdentity() three answers and one of them was two facts. `unproven` meant
// BOTH "this record states no fingerprint" AND "this record states one and the cluster would not
// answer", and doRelease() and assessFenceRequest() both refused `mismatch` and nothing else --
// so the second case inherited the tolerance that exists only for the first.
// ---------------------------------------------------------------------------

test('compareClusterIdentity tells a record with no fingerprint from one whose cluster would not answer (o3d-secops r29, Codex HIGH 1)', () => {
  const FINGERPRINT = { cluster_system_identifier: '7401111111111111111', cluster_database_oid: '16400' }
  const LIVE = { systemIdentifier: '7401111111111111111', databaseOid: '16400' }

  // THE TWO ANSWERS THAT ARE EVIDENCE, so that the four below are not four spellings of "no".
  assert.equal(compareClusterIdentity(FINGERPRINT, LIVE).status, CLUSTER_IDENTITY_PROVEN)
  assert.equal(
    compareClusterIdentity(FINGERPRINT, { ...LIVE, systemIdentifier: '7409999999999999999' }).status,
    CLUSTER_IDENTITY_MISMATCH,
    'a different cluster is positive evidence and not an absence',
  )
  assert.equal(
    compareClusterIdentity(FINGERPRINT, { ...LIVE, databaseOid: '16401' }).status,
    CLUSTER_IDENTITY_MISMATCH,
    'and so is a same-named database dropped and recreated',
  )

  // THE FINDING. Both of these were `unproven` in r28 and they are not the same fact.
  const legacy = compareClusterIdentity(
    { cluster_system_identifier: null, cluster_database_oid: null },
    LIVE,
  )
  assert.equal(legacy.status, CLUSTER_IDENTITY_NO_FINGERPRINT,
    'a record published before the field existed states nothing, and that is the case the legacy path is for')
  const denied = compareClusterIdentity(FINGERPRINT, {
    systemIdentifier: '',
    databaseOid: '16400',
    unavailable: 'permission denied for function pg_control_system',
  })
  assert.equal(denied.status, CLUSTER_IDENTITY_UNVERIFIABLE,
    'a record that NAMES a cluster, against a server that would not say which it is, is a different fact entirely')
  assert.notEqual(legacy.status, denied.status,
    'and the whole finding is that these two must not be one value')
  assert.match(denied.reason, /would not report its own/, denied.reason)
  assert.match(legacy.reason, /no cluster fingerprint at all/, legacy.reason)

  // HALF A FINGERPRINT IS NOT A LEGACY RECORD EITHER. An OID is unique inside a cluster and says
  // nothing between two of them, which is the case this comparison exists for -- so a record
  // carrying one half is `unverifiable` and not `no-fingerprint-recorded`.
  assert.equal(
    compareClusterIdentity({ cluster_system_identifier: null, cluster_database_oid: '16400' }, LIVE).status,
    CLUSTER_IDENTITY_UNVERIFIABLE,
    'the OID alone names a database and not a cluster',
  )
  assert.equal(
    compareClusterIdentity({ cluster_system_identifier: '7401111111111111111', cluster_database_oid: null }, LIVE).status,
    CLUSTER_IDENTITY_UNVERIFIABLE,
    'and the system identifier alone cannot see a database dropped and recreated inside the cluster it names',
  )

  // AND NO TWO OF THE FOUR ARE SPELT THE SAME, which is what stops a caller comparing against one
  // of them and silently catching another.
  assert.equal(
    new Set([CLUSTER_IDENTITY_PROVEN, CLUSTER_IDENTITY_MISMATCH, CLUSTER_IDENTITY_NO_FINGERPRINT, CLUSTER_IDENTITY_UNVERIFIABLE]).size,
    4,
    'four answers, four spellings',
  )
})

test('--release refuses a fingerprinted record whose cluster will not identify itself, and grants nothing (o3d-secops r29, Codex HIGH 1)', async (t) => {
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // THE RECORD NAMES ITS CLUSTER. This is not a legacy record: it went through the validator
    // with a fingerprint, which is what every record published since r28 carries.
    publishStandingAuthority(stateFile, {
      ...SAMPLE_STATE,
      cluster_system_identifier: '7401111111111111111',
      cluster_database_oid: '16400',
    })
    const before = readFileSync(stateFile, 'utf8')
    // AND THE SERVER WILL NOT SAY WHICH CLUSTER IT IS. EXECUTE on pg_control_system() is
    // revocable, so this is a real configuration and not a contrived one -- and it is precisely
    // the reading r28 spelt `unproven` and then released on.
    const client = new FakeAdminClient({
      stateFile,
      systemIdentifierError: 'permission denied for function pg_control_system',
      databaseOid: '16400',
      releasedDatacl: ACL_UNFENCED,
    })
    const code = await withAdminUrl(() =>
      doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    )

    // MUTATION ROUTE: delete the `releaseIdentity.status === CLUSTER_IDENTITY_UNVERIFIABLE` arm
    // from doRelease() -- which is r28's code exactly -- and this exits 0 with two GRANTs sent.
    assert.equal(code, EXIT_ERROR, 'an identity that cannot be read is not an identity that matches')
    assert.deepEqual(client.grants, [],
      'and NOT ONE GRANT may reach a server that would not say whether it is the fenced one')
    assert.equal(readFileSync(stateFile, 'utf8'), before,
      'and the record -- the only thing a release can be built from -- must be untouched')
    assert.ok(client.log.some((sql) => sql.includes('FROM pg_catalog.pg_control_system()')),
      'it must have ASKED, rather than assuming the answer was unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--release still releases a genuinely legacy record on that same silent server (o3d-secops r29, Codex HIGH 1)', async (t) => {
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    // NO FINGERPRINT AT ALL: what every record published before r28 looks like. The server is the
    // SAME one as the test above -- it still will not report its identity -- so the only thing
    // that differs between the two is which kind of nothing the record carries. Without this the
    // gate above could be a gate that refuses everything.
    publishStandingAuthority(stateFile, SAMPLE_STATE)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).cluster_system_identifier, null,
      'precondition: a legacy record states no cluster')
    const client = new FakeAdminClient({
      stateFile,
      systemIdentifierError: 'permission denied for function pg_control_system',
      releasedDatacl: ACL_UNFENCED,
    })
    const code = await withAdminUrl(() =>
      doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    )

    // MUTATION ROUTE: make compareClusterIdentity() return CLUSTER_IDENTITY_UNVERIFIABLE where it
    // returns CLUSTER_IDENTITY_NO_FINGERPRINT -- i.e. collapse the two absences the other way --
    // and this refuses, stranding every installation that predates the fingerprint.
    assert.equal(code, EXIT_OK, 'the legacy path is the whole reason the tolerance exists')
    assert.deepEqual(client.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ], 'and it must restore exactly the recorded grantees')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--release on a proven cluster with the fence standing still works (o3d-secops r29 control)', async (t) => {
  const dir = stateDir(t)
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishStandingAuthority(stateFile, {
      ...SAMPLE_STATE,
      cluster_system_identifier: '7401111111111111111',
      cluster_database_oid: '16400',
    })
    // EVERYTHING AGREES: the record names this cluster, this cluster says so, and the fence it
    // describes is standing on it. This is the ordinary release, and neither gate added this
    // round may touch it.
    const client = new FakeAdminClient({
      stateFile,
      systemIdentifier: '7401111111111111111',
      databaseOid: '16400',
      standingDatacl: ACL_FENCED,
      releasedDatacl: ACL_UNFENCED,
    })
    const code = await withAdminUrl(() =>
      doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    )

    assert.equal(code, EXIT_OK, 'an ordinary release must still be an ordinary release')
    assert.deepEqual(client.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a re-fence over a fingerprinted record refuses when the cluster will not identify itself, and still re-fences a legacy one (o3d-secops r29, Codex HIGH 1)', async (t) => {
  const dir = stateDir(t)
  // BOTH HALVES ARE DRIVEN AS A RECOVERY RE-FENCE -- stamped applied, then published over, so
  // root marks the record `recovery` and the drift rule accepts an ACL whose grantees have
  // already lost CONNECT. That shape matters: a re-fence refused by the DRIFT rule would satisfy
  // "nothing was revoked" just as well as one refused by the cluster gate, and the test would be
  // measuring a refusal it did not cause. The refusal is therefore read as well as counted.
  const recovery = (stateFile: string, record: Record<string, unknown>) => {
    publishStandingAuthority(stateFile, record)
    publishAuthority(stateFile, record)
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).fence_mode, FENCE_MODE_RECOVERY,
      'precondition: this must be the recovery rule, or the drift rule is what refuses below')
  }
  // NOTHING PROCESS-GLOBAL (o3d-secops r30, Codex LOW). r29 wrote this to capture stderr only, on
  // the reasoning that the runner's TAP goes to stdout -- true, and still the wrong shape: it
  // replaced a process global across an `await`, which is the mechanism, and the runner's
  // diagnostics go to stderr. capturingFenceOutput() reaches console.error and the module's own
  // machine channel instead, so no capture in this file can touch the reporter's streams at all.
  const said = async (run: () => Promise<number>) => {
    const captured = await capturingFenceOutput(run)
    return { code: captured.value, output: captured.err }
  }
  try {
    // 1. THE RECORD NAMES A CLUSTER AND THE SERVER WILL NOT. r28 refused only `mismatch` here too,
    //    so this re-applied the record's grantee list to an ACL nothing could show it belonged to
    //    -- and then republished over the only account of a fence possibly standing elsewhere.
    const fingerprinted = join(dir, 'fingerprinted.json')
    // THE OWNER IS IN THE RECORDED LIST because ACL_FENCED leaves the owner holding CONNECT, and
    // a grantee holding CONNECT that the record does not name is DRIFT -- a refusal from a
    // different rule, which would make this test measure that one instead.
    const RECOVERABLE = { ...SAMPLE_STATE, revoked: ['PUBLIC', 'owner', 'imsapp'] }
    recovery(fingerprinted, {
      ...RECOVERABLE,
      cluster_system_identifier: '7401111111111111111',
      cluster_database_oid: '16400',
    })
    const before = readFileSync(fingerprinted, 'utf8')
    const silent = new FakeAdminClient({
      stateFile: fingerprinted,
      systemIdentifierError: 'permission denied for function pg_control_system',
      databaseOid: '16400',
      datacl: ACL_FENCED,
      stillConnectsBefore: false,
    })
    const refused = await said(() => withAdminUrl(() =>
      doFence(silent as never, { stateFile: fingerprinted, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    ))

    // MUTATION ROUTE: delete the CLUSTER_IDENTITY_UNVERIFIABLE arm from assessFenceRequest() --
    // which leaves r28's code exactly -- and this exits 0 with three REVOKEs sent.
    assert.equal(refused.code, EXIT_NOT_FENCEABLE, `a record that names a cluster may not be re-applied to an unnamed one:\n${refused.output}`)
    assert.deepEqual(silent.revokes, [], 'and nothing may be revoked on the strength of it')
    // AND IT MUST BE THIS GATE THAT REFUSED, not the drift rule and not the mode rule.
    assert.match(refused.output, /NAMES the cluster it was written against/, refused.output)
    assert.match(refused.output, /NOT the legacy case/, `it must say which of the two absences this is:\n${refused.output}`)
    assert.equal(readFileSync(fingerprinted, 'utf8'), before,
      'and the fingerprint it carries must NOT be overwritten with the null this server would have supplied')

    // 2. AND THE LEGACY RECORD STILL RE-FENCES ON THE SAME SILENT SERVER. Same connection, same
    //    denial, same recovery shape; only the record differs. Without this the assertion above is
    //    satisfied by a gate that refuses every re-fence.
    const legacy = join(dir, 'legacy.json')
    recovery(legacy, RECOVERABLE)
    assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).cluster_system_identifier, null,
      'precondition: a legacy record states no cluster')
    const legacyClient = new FakeAdminClient({
      stateFile: legacy,
      systemIdentifierError: 'permission denied for function pg_control_system',
      datacl: ACL_FENCED,
      stillConnectsBefore: false,
    })
    const applied = await said(() => withAdminUrl(() =>
      doFence(legacyClient as never, { stateFile: legacy, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }),
    ))
    assert.equal(applied.code, EXIT_OK, `the legacy re-fence path must survive this round intact:\n${applied.output}`)
    assert.deepEqual(legacyClient.revokes, [
      'REVOKE CONNECT ON DATABASE "imsdb" FROM PUBLIC;',
      'REVOKE CONNECT ON DATABASE "imsdb" FROM "owner";',
      'REVOKE CONNECT ON DATABASE "imsdb" FROM "imsapp";',
    ], 'and it must actually revoke the recorded list')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a same-named database on a DIFFERENT CLUSTER does not clear the record (o3d-secops r28, Codex HIGH 1)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ims-fence-two-'))
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const port = await freePort()
  const me = currentUser()
  let real: ReturnType<typeof startCluster> | undefined
  let bystander: ReturnType<typeof startCluster> | undefined
  const previousAdmin = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  try {
    // ONE PORT, TWO CLUSTERS. The real one binds 127.0.0.1; the bystander binds no TCP address at
    // all and is reached over its own socket directory while CLAIMING the same port. That is what
    // lets the URL name the right server and the connection land on the wrong one -- the exact
    // shape of "DNS, a proxy, or failover routing".
    real = startCluster(root, 'real', port, '127.0.0.1')
    bystander = startCluster(root, 'bystander', port, '')

    for (const cluster of [real, bystander]) {
      cluster.psql(['-c', 'CREATE ROLE owner_role LOGIN'])
      cluster.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
      cluster.psql(['-c', 'CREATE DATABASE imsdb OWNER owner_role'])
      // A DIRECT GRANT ON BOTH, which is what an installed application has and what makes the two
      // clusters INDISTINGUISHABLE to every check that existed before this round. Left to the
      // default ACL the bystander would show imsapp holding CONNECT only through PUBLIC, the
      // reading would be MIXED rather than `absent`, and this test would be passing because the
      // bystander looked odd instead of because the cluster gate fired.
      cluster.psql(['-c', 'GRANT CONNECT ON DATABASE imsdb TO imsapp'])
    }
    // THE REAL CLUSTER IS FENCED: PUBLIC and imsapp have lost CONNECT, which is what the record
    // describes. THE BYSTANDER IS NOT, because nothing ever fenced it -- and that is precisely the
    // reading (`absent`) that made r26 and r27 delete the record.
    real.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM PUBLIC'])
    real.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM imsapp'])

    const identityOf = (cluster: ReturnType<typeof startCluster>) => ({
      systemIdentifier: cluster.psql(['-c', 'SELECT system_identifier::text FROM pg_control_system()']),
      databaseOid: cluster.psql(['-c', "SELECT oid::text FROM pg_database WHERE datname = 'imsdb'"]),
    })
    const realIdentity = identityOf(real)
    const bystanderIdentity = identityOf(bystander)
    assert.notEqual(realIdentity.systemIdentifier, bystanderIdentity.systemIdentifier,
      'precondition: two clusters initdb\'d separately have different system identifiers')
    assert.match(realIdentity.systemIdentifier, /^[0-9]+$/, 'precondition: and it is readable as a number')

    // THE RECORD, PUBLISHED BY THE SHIPPED VALIDATOR, carrying the REAL cluster's fingerprint and
    // no applied stamp -- the shape the resolution wrapper exists for.
    publishAuthority(stateFile, {
      ...SAMPLE_STATE,
      database: 'imsdb',
      owner_role: 'owner_role',
      app_role: 'imsapp',
      revoked: [PUBLIC_GRANTEE, 'imsapp'],
      cluster_system_identifier: realIdentity.systemIdentifier,
      cluster_database_oid: realIdentity.databaseOid,
    })
    const published = JSON.parse(readFileSync(stateFile, 'utf8'))
    delete published.fence_applied
    delete published.fence_mode
    writeFileSync(stateFile, `${JSON.stringify(published, null, 2)}\n`)
    const untouched = readFileSync(stateFile, 'utf8')

    // THE URL NAMES THE RIGHT SERVER IN BOTH RUNS. Only the connection differs, which is what the
    // finding is: every value the identity gate compares is identical on the two.
    process.env.DEPLOY_ADMIN_DATABASE_URL = `postgres://${me}@127.0.0.1:${port}/imsdb`
    process.env.DATABASE_URL = `postgres://imsapp@127.0.0.1:${port}/imsdb`

    const audit = async (cluster: ReturnType<typeof startCluster>) => {
      const client = new Client({ host: cluster.socket, port, database: 'imsdb', user: me })
      await client.connect()
      try {
        const captured = await capturingFenceOutput(() => doAuditAuthority(client as never, {
          stateFile, appRole: 'imsapp',
          ...suppliedIdentity({ appHost: '127.0.0.1', appPort: String(port), appUser: 'imsapp', appDatabase: 'imsdb' }),
        }))
        return { code: captured.value, verdict: captured.out, said: captured.err }
      } finally {
        await client.end()
      }
    }

    // 0. THE RIGHT CLUSTER STILL DECIDES, and says so on both channels. Without this the assertion
    //    below is satisfied by a gate that refuses everything.
    const onTheRealOne = await audit(real)
    assert.equal(onTheRealOne.code, EXIT_FENCE_STANDING, `the fenced cluster must be readable:\n${onTheRealOne.said}`)
    assert.match(onTheRealOne.verdict, new RegExp(`^legacy_fence_verdict=${LEGACY_FENCE_STANDS}$`, 'm'), onTheRealOne.verdict)
    assert.match(onTheRealOne.verdict, new RegExp(`^legacy_fence_cluster=${CLUSTER_IDENTITY_PROVEN}$`, 'm'),
      `and the reading must be attributable to the cluster the record names:\n${onTheRealOne.verdict}`)

    // 1. THE FINDING. Same host, same port, same database name, same roles, different SERVER. The
    //    bystander is unfenced, so every recorded grantee holds CONNECT there and the ACL verdict
    //    would be `absent` -- the reading root DELETES on. It must not get that far.
    const onTheBystander = await audit(bystander)
    assert.equal(onTheBystander.code, EXIT_ERROR,
      `an unfenced bystander cluster must settle nothing:\n${onTheBystander.said}`)
    assert.equal(onTheBystander.verdict, '',
      `and print NO verdict line at all, because the wrapper acts on a status and a verdict together:\n${onTheBystander.verdict}`)
    assert.match(onTheBystander.said, /NOT AUDITED/, onTheBystander.said)
    assert.match(onTheBystander.said, new RegExp(bystanderIdentity.systemIdentifier),
      `naming the cluster that actually answered:\n${onTheBystander.said}`)
    assert.equal(readFileSync(stateFile, 'utf8'), untouched,
      'and the authority a fence on the OTHER cluster depends on must be byte for byte what it was')

    // 2. AND THE READING IT WOULD HAVE GIVEN, PROVED RATHER THAN ASSERTED. Without this the test
    //    would pass on a bystander that happened to look fenced, and would be measuring nothing.
    const bystanderPrivileges = JSON.parse(bystander.psql([
      '-c', `SELECT ${DATACL_PRIVILEGES_SQL} FROM pg_database d WHERE d.datname = 'imsdb'`,
    ], { database: 'imsdb' }))
    assert.equal(granteeHasConnect(bystanderPrivileges, PUBLIC_GRANTEE), true,
      'the bystander is unfenced: PUBLIC holds CONNECT there')
    assert.equal(granteeHasConnect(bystanderPrivileges, 'imsapp'), true, 'and so does the application role')
    assert.deepEqual(
      assessLegacyFenceEvidence({ recorded: [PUBLIC_GRANTEE, 'imsapp'], holding: [PUBLIC_GRANTEE, 'imsapp'] }).verdict,
      LEGACY_FENCE_ABSENT,
      'so the ACL verdict there is `absent` — the one the automatic clear used to act on',
    )
  } finally {
    real?.stop()
    bystander?.stop()
    rmSync(root, { recursive: true, force: true })
    if (previousAdmin === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previousAdmin
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
})

test('a PHYSICAL CLONE carries the whole fingerprint, and a release on it is refused (o3d-secops r29, Codex HIGH 2)', async (t) => {
  // WHAT THIS MEASURES, AND WHY IT NEEDS REAL SERVERS. The r28 fingerprint -- system identifier
  // plus database OID -- was introduced to tell a DIFFERENT cluster apart from the fenced one. It
  // cannot tell a COPY of the fenced cluster apart from it: pg_basebackup, a restored snapshot and
  // a copied data directory all inherit both halves by construction. So the identity gate says
  // `proven` on a staging clone whose ACL never saw the REVOKE, --release grants what is already
  // granted, verifies happily, exits 0, and the wrapper deletes the only account of the fence
  // still standing on the real server.
  //
  // AND THE CANDIDATE THAT LOOKS LIKE THE ANSWER IS THE WRONG WAY ROUND. The timeline id is
  // asserted below precisely because it does NOT separate them: a clone started as its own
  // primary keeps the source's timeline, while promoting a standby -- the case that IS the same
  // cluster's data continuing, and whose ACL the record does describe -- moves it. Comparing it
  // would refuse the legitimate failover and pass the clone.
  const root = mkdtempSync(join(tmpdir(), 'ims-fence-clone-'))
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const port = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  let staleClone: ReturnType<typeof startCluster> | undefined
  let postFenceClone: ReturnType<typeof startCluster> | undefined
  const previousAdmin = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  try {
    // ONE PORT, THREE CLUSTERS -- the origin binds TCP and the copies bind none, which is how the
    // URL can name the right server while the connection lands on a copy. `local replication` is
    // needed because a `local all` rule does not match a replication connection.
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust'])
    origin.psql(['-c', 'CREATE ROLE owner_role LOGIN'])
    origin.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
    origin.psql(['-c', 'CREATE DATABASE imsdb OWNER owner_role'])
    origin.psql(['-c', 'GRANT CONNECT ON DATABASE imsdb TO imsapp'])

    // THE COPY IS TAKEN BEFORE THE FENCE, which is the whole of the finding: it is a copy that
    // never replayed the transaction the record describes.
    staleClone = cloneCluster(root, origin, 'stale', port)

    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM PUBLIC'])
    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM imsapp'])
    // AND A SECOND COPY AFTER IT, for the residual this gate does NOT close (below).
    postFenceClone = cloneCluster(root, origin, 'after', port)

    const identityOf = (cluster: ReturnType<typeof startCluster>) => ({
      systemIdentifier: cluster.psql(['-c', 'SELECT system_identifier::text FROM pg_control_system()']),
      databaseOid: cluster.psql(['-c', "SELECT oid::text FROM pg_database WHERE datname = 'imsdb'"]),
      timeline: cluster.psql(['-c', 'SELECT timeline_id::text FROM pg_control_checkpoint()']),
      appConnects: cluster.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]),
    })
    const originIdentity = identityOf(origin)
    const cloneIdentity = identityOf(staleClone)

    // THE MEASUREMENT. Every value the r28 gate compares is identical on the copy.
    assert.equal(cloneIdentity.systemIdentifier, originIdentity.systemIdentifier,
      'a physical clone inherits the system identifier initdb stamped into pg_control')
    assert.equal(cloneIdentity.databaseOid, originIdentity.databaseOid,
      'and the database OID, so BOTH halves of the fingerprint say the same thing')
    assert.equal(cloneIdentity.timeline, originIdentity.timeline,
      'and the timeline too, when it is started as its own primary rather than promoted -- which is why the timeline cannot be the discriminator')
    assert.equal(cloneIdentity.appConnects, 'true',
      'and its ACL never saw the REVOKE: this is the "proven" cluster that is not fenced')
    assert.equal(originIdentity.appConnects, 'false', 'precondition: the origin IS fenced')

    // THE RECORD, CARRYING THE ORIGIN'S FINGERPRINT AND STAMPED APPLIED: what a fence raised
    // since r28 leaves behind.
    publishStandingAuthority(stateFile, {
      ...SAMPLE_STATE,
      database: 'imsdb',
      owner_role: 'owner_role',
      app_role: 'imsapp',
      revoked: [PUBLIC_GRANTEE, 'imsapp'],
      cluster_system_identifier: originIdentity.systemIdentifier,
      cluster_database_oid: originIdentity.databaseOid,
    })
    const untouched = readFileSync(stateFile, 'utf8')

    // AND THE IDENTITY GATE ALONE WOULD LET IT THROUGH. Without this the test below could be
    // passing because of the fingerprint rather than in spite of it.
    assert.equal(
      compareClusterIdentity(JSON.parse(untouched), cloneIdentity).status,
      CLUSTER_IDENTITY_PROVEN,
      'the clone satisfies the r28 fingerprint completely, which is the finding',
    )

    process.env.DEPLOY_ADMIN_DATABASE_URL = `postgres://${me}@127.0.0.1:${port}/imsdb`
    process.env.DATABASE_URL = `postgres://imsapp@127.0.0.1:${port}/imsdb`
    // EVERY STATEMENT THE RELEASE SENDS IS RECORDED. "The ACL did not change" would prove nothing
    // here: the clone already grants what the release would grant, so its GRANTs are no-ops that
    // leave the ACL text identical. What has to be shown is that they were never SENT.
    const release = async (cluster: ReturnType<typeof startCluster>) => {
      const client = new Client({ host: cluster.socket, port, database: 'imsdb', user: me })
      await client.connect()
      const sent: string[] = []
      const query = client.query.bind(client)
      ;(client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        sent.push(String(args[0]))
        return (query as (...a: unknown[]) => unknown)(...args)
      }
      try {
        const captured = await capturingFenceOutput(() => doRelease(client as never, {
          stateFile, appRole: 'imsapp',
          ...suppliedIdentity({ appHost: '127.0.0.1', appPort: String(port), appUser: 'imsapp', appDatabase: 'imsdb' }),
        }))
        return { code: captured.value, said: captured.err, grants: sent.filter((sql) => sql.trim().startsWith('GRANT')) }
      } finally {
        await client.end()
      }
    }

    // MUTATION ROUTE: delete the LEGACY_FENCE_ABSENT arm from doRelease() -- leaving r28's code --
    // and this exits 0, grants on the clone, and reports the fence released.
    //
    // AND THE STATUS CHANGED IN r30, WHILE THE PROTECTION DID NOT (Codex MEDIUM). This record is
    // STAMPED APPLIED, which is what a fence raised since r28 leaves, and on a stamped record the
    // "every recorded grantee holds CONNECT" reading is ALSO what a release that granted and then
    // died before its record could be removed leaves behind. The two are indistinguishable here
    // and always will be, so r29's flat refusal made a legitimate retry unrunnable -- the finding
    // r30 answers. The exit is now EXIT_ALREADY_RELEASED, which says ONE thing: there is nothing
    // left to grant on this server. What matters for THIS test is unchanged and is asserted
    // below: not one GRANT is sent to the copy, the record is byte for byte what it was, and the
    // origin's fence is untouched. Nothing automatic can end the record from either reading --
    // see db_fence_clear_authority(), which refuses without an attestation no cluster can carry.
    const onTheClone = await release(staleClone)
    assert.equal(onTheClone.code, EXIT_ALREADY_RELEASED, `a copy that never saw the fence must not be released on:\n${onTheClone.said}`)
    assert.notEqual(onTheClone.code, EXIT_OK, 'and it must never be reported as a release this run performed')
    assert.match(onTheClone.said, /holds CONNECT/, onTheClone.said)
    assert.match(onTheClone.said, /COPY of the\s+fenced cluster/, `and it must name what it may be looking at:\n${onTheClone.said}`)
    assert.equal(readFileSync(stateFile, 'utf8'), untouched,
      'and the record the real fence is released from must be byte for byte what it was')
    assert.deepEqual(onTheClone.grants, [],
      'and NOT ONE GRANT may be sent to it -- on this server they would be silent no-ops, which is why the statements and not the ACL are what is counted')
    assert.equal(origin.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]), 'false',
      'and the fence on the ORIGIN is untouched by a run that was pointed at the copy')

    // AND THE ORIGIN STILL RELEASES, which is what makes the refusal above a discrimination rather
    // than a gate that refuses everything.
    const onTheOrigin = await release(origin)
    assert.equal(onTheOrigin.code, EXIT_OK, `the cluster the fence IS standing on must still release:\n${onTheOrigin.said}`)
    assert.deepEqual(onTheOrigin.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ], 'sending exactly the recorded list')
    assert.equal(origin.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]), 'true',
      'and the application must actually get CONNECT back')

    // THE RESIDUAL, ASSERTED RATHER THAN CLAIMED (o3d-secops r29). A copy taken AFTER the fence
    // carries the fence too, so it agrees with the origin on the fingerprint AND on the ACL, and
    // nothing readable separates the two. This gate does not close that case and nothing measured
    // here could: the assertions below are the evidence for saying so.
    const afterIdentity = identityOf(postFenceClone)
    assert.equal(afterIdentity.systemIdentifier, originIdentity.systemIdentifier, 'same cluster identity')
    assert.equal(afterIdentity.databaseOid, originIdentity.databaseOid, 'same database OID')
    assert.equal(afterIdentity.appConnects, 'false',
      'and the fence itself was copied with it, so the one fact that separates a STALE clone from the fenced cluster says nothing about this one')
  } finally {
    staleClone?.stop()
    postFenceClone?.stop()
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    if (previousAdmin === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previousAdmin
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
})

/**
 * THE RETRY THAT WAS UNRUNNABLE (o3d-secops r30, Codex MEDIUM).
 *
 * THE FINDING. The helper cannot remove the record -- the directory is root's -- so the GRANTs and
 * the unlink are two processes with an interval between them, and a crash, an OOM kill or a failed
 * unlink in that interval leaves the grants restored and the record still at the authoritative
 * path. Re-running the release then read EVERY recorded grantee holding CONNECT and REFUSED, while
 * the operator resolution wrapper refuses a STAMPED record and points back at the release wrapper.
 * A loop, with no way out but somebody deleting the file by hand.
 *
 * WHAT THE STAMP BUYS AND WHAT IT DOES NOT. `fence_applied: 1` is written by ROOT, after `--fence`
 * reported the REVOKEs were on the medium, into a directory ${APP_USER} cannot write. So on a
 * stamped record this reading means the fence DID commit and its grants are already back. It does
 * NOT mean this connection reached the server that fence was raised on -- an unfenced copy reads
 * identically -- which is why this exit authorises no destruction: it says only that there is
 * nothing left to grant here, and the record is ended by a person at a terminal.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): change the arm's condition from
 * `state.fence_applied === 1` to `false` and the first half of this test fails at EXIT_ERROR --
 * which is r29's code exactly, and is the state that cannot be retried.
 */
test('a release re-run after its grants have landed completes instead of refusing (o3d-secops r30, Codex MEDIUM)', async (t) => {
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishStandingAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] })
  const untouched = readFileSync(stateFile, 'utf8')
  assert.equal(JSON.parse(untouched).fence_applied, 1,
    'precondition: this measures the STAMPED record, which is what a fence raised since r28 leaves')

  // THE STATE A CRASH BETWEEN THE COMMIT AND THE UNLINK LEAVES: every role the record names holds
  // CONNECT again, because this run's predecessor granted them back and then died.
  const retry = new FakeAdminClient({ stateFile, standingDatacl: ACL_UNFENCED, releasedDatacl: ACL_UNFENCED })
  const retried = await capturingFenceOutput(() => withAdminUrl(() => doRelease(retry as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  })))

  assert.equal(retried.value, EXIT_ALREADY_RELEASED,
    `a re-run after the grants landed must be completable, not refused:\n${retried.err}`)
  assert.notEqual(retried.value, EXIT_ERROR, 'and in particular it must not be r29\'s flat refusal')
  assert.match(retried.out, /^release_state=already-released$/m,
    `and it must say so on the machine channel, which is what the wrapper acts on:\n${retried.out}`)
  assert.deepEqual(retry.grants, [],
    'NOTHING may be granted: there is nothing here to grant, and this exit is not a release this run performed')
  assert.equal(readFileSync(stateFile, 'utf8'), untouched,
    'and the record is untouched -- ending it is the operator\'s act, in the release wrapper')
  assert.match(retried.err, /COPY of the/,
    `and the other history that ends at this reading must be named, not hidden:\n${retried.err}`)

  // AND THE DISCRIMINATION, WITHOUT WHICH THE ABOVE IS A GATE THAT ACCEPTS EVERYTHING. An
  // UNSTAMPED record says nothing about whether the REVOKEs ever ran, so the same ACL reading on
  // one of those is still the flat refusal r29 shipped: there is no evidence a fence ever stood.
  const unstamped = join(dir, 'unstamped.json')
  publishAuthority(unstamped, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] })
  const legacy = JSON.parse(readFileSync(unstamped, 'utf8'))
  delete legacy.fence_applied
  writeFileSync(unstamped, `${JSON.stringify(legacy, null, 2)}\n`)
  const bare = new FakeAdminClient({ stateFile: unstamped, standingDatacl: ACL_UNFENCED, releasedDatacl: ACL_UNFENCED })
  const refused = await capturingFenceOutput(() => withAdminUrl(() => doRelease(bare as never, {
    stateFile: unstamped, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  })))
  assert.equal(refused.value, EXIT_ERROR,
    `a record that never said a fence was applied must still be refused outright:\n${refused.err}`)
  assert.deepEqual(bare.grants, [], 'and nothing may be granted on that one either')
})

/**
 * A MIXED READING IS NOT OURS, AND THE RELEASE IS NOW A TRANSACTION SO IT CANNOT BECOME OURS
 * (o3d-secops r30, Codex HIGH 2 and MEDIUM).
 *
 * r29 consumed a three-valued answer and proceeded on TWO of its values, refusing only `absent`.
 * The reason it gave for letting `ambiguous` through was that a half-applied fence has something
 * to restore -- and that is wrong on the facts of this file: doFence() issues every REVOKE inside
 * ONE transaction and commits it as one, so there is no half-applied fence to restore. The GRANTs
 * are one transaction here for the same reason, which is what this test measures second: without
 * it, refusing `ambiguous` while being able to CAUSE it would make a legitimate retry unrunnable.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): delete the LEGACY_FENCE_AMBIGUOUS
 * arm from doRelease() -- leaving r29's code -- and the first half exits 0, granting CONNECT back
 * to a role somebody revoked deliberately. Replace the BEGIN/COMMIT around the grant loop with the
 * bare loop r29 shipped and the second half fails: no ROLLBACK is issued and the partial grant
 * stands.
 */
test('a release refuses a MIXED reading, and cannot produce one by dying halfway (o3d-secops r30, Codex HIGH 2)', async (t) => {
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  publishStandingAuthority(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC', 'imsapp'] })
  const untouched = readFileSync(stateFile, 'utf8')

  // PUBLIC has lost CONNECT and the application has not. No fence this program raises can leave
  // that: the REVOKEs commit together or not at all.
  const mixed = new FakeAdminClient({ stateFile, standingDatacl: ACL_MIXED, releasedDatacl: ACL_UNFENCED })
  const refused = await capturingFenceOutput(() => withAdminUrl(() => doRelease(mixed as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  })))
  assert.equal(refused.value, EXIT_ERROR, `a mixed ACL must not be released from:\n${refused.err}`)
  assert.deepEqual(mixed.grants, [],
    'and NOT ONE GRANT may be sent -- the roles that lost CONNECT lost it to somebody other than this record')
  assert.ok(!mixed.log.includes('BEGIN'), 'the grant transaction must never be opened')
  assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'and the record is untouched')
  assert.match(refused.err, /DISAGREE about CONNECT/, refused.err)
  assert.match(refused.err, /ONE\s+transaction/, `and the refusal must say why a mixed reading cannot be ours:\n${refused.err}`)

  // AND THE DISCRIMINATION: the fenced ACL over this record's own list is `stands`, and releases.
  const standing = new FakeAdminClient({ stateFile, standingDatacl: ACL_FENCED, releasedDatacl: ACL_UNFENCED })
  const released = await capturingFenceOutput(() => withAdminUrl(() => doRelease(standing as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  })))
  assert.equal(released.value, EXIT_OK, `the reading a standing fence leaves must still release:\n${released.err}`)
  assert.deepEqual(standing.grants, [
    'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
    'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
  ], 'sending exactly the recorded list')
  assert.ok(standing.log.includes('BEGIN') && standing.log.includes('COMMIT'),
    `and inside ONE transaction, which is what stops an interrupted release producing the reading refused above:\n${standing.log.join(' | ')}`)
  assert.ok(standing.log.indexOf('BEGIN') < standing.log.indexOf(standing.grants[0]),
    'opened before the first GRANT')

  // THE INTERRUPTION ITSELF. A release killed between two GRANTs must leave the fenced ACL, not a
  // mixed one -- so the statement that fails is followed by a ROLLBACK and never by a COMMIT.
  const dying = new FakeAdminClient({
    stateFile, standingDatacl: ACL_FENCED, releasedDatacl: ACL_UNFENCED,
    failStatement: 'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
  })
  const died = await capturingFenceOutput(() => withAdminUrl(() => doRelease(dying as never, {
    stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }),
  })))
  assert.equal(died.value, EXIT_ERROR, `a release that could not finish must not report one:\n${died.err}`)
  assert.ok(dying.log.includes('ROLLBACK'),
    `the partial grant must be rolled back, or the next run reads the mixed ACL this refuses:\n${dying.log.join(' | ')}`)
  assert.ok(!dying.log.includes('COMMIT'), 'and nothing may be committed')
  assert.equal(readFileSync(stateFile, 'utf8'), untouched,
    'and the record survives, because it is what the retry releases from')
})

/**
 * NO HELPER IN THIS FILE MAY REPLACE THE RUNNER'S OWN STREAMS (o3d-secops r30, Codex LOW).
 *
 * This is a guard rather than a measurement, and it is here because the defect it guards against
 * is INVISIBLE in a test report: a capture that replaces `process.stdout.write` across an `await`
 * swallows whatever the runner writes inside the window, so the file reports fewer tests than it
 * declared AND ZERO FAILURES. Nothing goes red. It happened -- 112 declared, 76 reported -- and
 * the only reason it was noticed is that somebody counted.
 *
 * So the count is asserted too, from the file's own text: a walk that silently stopped visiting
 * anything would satisfy the absence check vacuously.
 *
 * MUTATION ROUTE: put `process.stderr.write = (c: string) => true` back into any helper in this
 * file and the first assertion fails, naming the line.
 */
test('no helper in this file replaces the test runner\'s own streams (o3d-secops r30, Codex LOW)', () => {
  const source = readFileSync(join(process.cwd(), 'tests/scripts/db-connection-fence.test.ts'), 'utf8')
  const lines = source.split(/\r?\n/)

  // THE PRECONDITION: the scan reached this file and the pattern is able to match at all. Without
  // both, "no line matched" is the answer an empty read and a broken regex give too.
  assert.ok(lines.length > 4000, `the guard must be reading this file; it saw ${lines.length} lines`)
  const PATCH = /process\.(?:stdout|stderr)\.write\s*=[^=]/
  // Assembled rather than written out, so the calibration does not become the file's own first
  // offender -- which is what it did on the first run of this guard, and is the tell that the scan
  // really does read this text.
  assert.ok(PATCH.test(`  ${'process.stdout'}${'.write'} = ((chunk: string) => true)`),
    'the pattern must match the shape it exists to forbid, or this test passes on nothing')

  const offenders = lines
    .map((line, index) => ({ line, at: index + 1 }))
    .filter(({ line }) => PATCH.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
  assert.deepEqual(offenders, [],
    `a capture that replaces a process stream can swallow the runner's own report of a test that finished inside its window, so the file silently under-reports its test count with zero failures. Use capturingFenceOutput().`)

  // AND THE REPLACEMENT IS ACTUALLY IN USE, so this cannot be satisfied by deleting every capture.
  assert.ok(source.includes('async function capturingFenceOutput'),
    'the non-global capture helper must still be defined')
  const uses = lines.filter((line) => line.includes('capturingFenceOutput(')).length
  assert.ok(uses >= 6, `and it must be what the helpers use; it is called on ${uses} lines`)

  // EVERY DECLARED TEST IS REPORTED, asked of the text rather than of the report -- which is the
  // number the swallowed-output defect moved, and the one nobody was checking.
  const declared = lines.filter((line) => /^test\(/.test(line)).length
  assert.ok(declared >= 113, `the file must still declare its tests at top level; it declares ${declared}`)
})

/**
 * THE RESIDUAL r29 MEASURED, AND WHAT NOW STANDS BETWEEN IT AND THE RECORD (o3d-secops r30,
 * Codex HIGH 1).
 *
 * r29 proved on real clusters that a copy taken AFTER the fence is indistinguishable from the
 * cluster it was copied from: same system identifier, same database OID, same timeline, the same
 * revoked ACL. It disclosed that honestly and left root's unlink hanging off the release's exit
 * status, which is the finding: the release SUCCEEDS on such a copy -- correctly, on the evidence
 * it has -- and root then destroyed the only account of the fence still standing on the original.
 *
 * THIS TEST DOES NOT PRETEND THE HELPER CAN TELL THEM APART. It asserts the opposite, on real
 * clusters, because that is the fact the design rests on: the release on the copy exits 0 and
 * sends the recorded GRANTs. What it then asserts is that NOTHING FOLLOWS FROM THAT for the
 * record -- the removal is refused, by a shell function asking a question no cluster can answer,
 * namely whether THIS RUN raised the fence it is releasing.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): delete the attestation comparison
 * from db_fence_clear_authority() in scripts/lib/db-fence-protected.sh -- which is r29's shape --
 * and the record is removed on the copy's release, leaving the origin fenced with nothing to
 * release it from.
 */
test('a release against a copy taken AFTER the fence still cannot end the record (o3d-secops r30, Codex HIGH 1)', async (t) => {
  const root = stateDir(t)
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const port = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  let copy: ReturnType<typeof startCluster> | undefined
  const previousAdmin = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  try {
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust'])
    origin.psql(['-c', 'CREATE ROLE owner_role LOGIN'])
    origin.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
    origin.psql(['-c', 'CREATE DATABASE imsdb OWNER owner_role'])
    origin.psql(['-c', 'GRANT CONNECT ON DATABASE imsdb TO imsapp'])
    // THE FENCE, and only then the copy: this one carries the revoked ACL with it.
    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM PUBLIC'])
    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM imsapp'])
    copy = cloneCluster(root, origin, 'after', port)

    const fingerprint = (cluster: ReturnType<typeof startCluster>) => ({
      systemIdentifier: cluster.psql(['-c', 'SELECT system_identifier::text FROM pg_control_system()']),
      databaseOid: cluster.psql(['-c', "SELECT oid::text FROM pg_database WHERE datname = 'imsdb'"]),
      appConnects: cluster.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]),
    })
    const originIdentity = fingerprint(origin)
    const copyIdentity = fingerprint(copy)

    // THE MEASUREMENT, RE-TAKEN HERE RATHER THAN CITED. Every fact the helper can reach agrees.
    assert.equal(copyIdentity.systemIdentifier, originIdentity.systemIdentifier, 'the copy inherits the system identifier')
    assert.equal(copyIdentity.databaseOid, originIdentity.databaseOid, 'and the database OID')
    assert.equal(copyIdentity.appConnects, 'false', 'and the FENCE itself, which is what makes this copy the hard one')
    assert.equal(originIdentity.appConnects, 'false', 'precondition: the origin is fenced')

    publishStandingAuthority(stateFile, {
      ...SAMPLE_STATE,
      database: 'imsdb',
      owner_role: 'owner_role',
      app_role: 'imsapp',
      revoked: [PUBLIC_GRANTEE, 'imsapp'],
      cluster_system_identifier: originIdentity.systemIdentifier,
      cluster_database_oid: originIdentity.databaseOid,
    })
    const untouched = readFileSync(stateFile, 'utf8')

    process.env.DEPLOY_ADMIN_DATABASE_URL = `postgres://${me}@127.0.0.1:${port}/imsdb`
    process.env.DATABASE_URL = `postgres://imsapp@127.0.0.1:${port}/imsdb`
    const client = new Client({ host: copy.socket, port, database: 'imsdb', user: me })
    await client.connect()
    let released
    try {
      released = await capturingFenceOutput(() => doRelease(client as never, {
        stateFile, appRole: 'imsapp',
        ...suppliedIdentity({ appHost: '127.0.0.1', appPort: String(port), appUser: 'imsapp', appDatabase: 'imsdb' }),
      }))
    } finally {
      await client.end()
    }

    // AND IT SUCCEEDS, WHICH IS THE POINT. Asserted rather than regretted: a design that assumed
    // the helper could refuse here would be resting on something no measurement supports.
    assert.equal(released.value, EXIT_OK,
      `the copy is indistinguishable, so the release on it succeeds -- that is the residual this round works around rather than closes:\n${released.err}`)
    assert.equal(copy.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]), 'true',
      'and it really did grant, on the copy')
    assert.equal(origin.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]), 'false',
      'while the ORIGIN is still fenced: that is the fence whose record is about to be at risk')

    // THE GATE. Root asks a question the database cannot answer -- did THIS RUN raise the fence it
    // just released -- and without that answer it removes nothing.
    const CLEAR = shellFunction(FENCE_LIBRARY, 'db_fence_clear_authority')
    // o3d-secops r31: the removal takes TWO answers now -- WHO raised it, and WHICH SERVER was
    // released -- so this helper passes both and the assertions below say which one is under test.
    const clear = (attestation: string, server = 'same-server-as-the-fence') => spawnSync('bash', ['-c', [
      'set -uo pipefail',
      'exec 2>&1',
      'DB_FENCE_SUDO_PREFIX=""',
      'DB_FENCE_RELEASE_WRAPPER="/opt/cutover/release-db-fence"',
      CLEAR,
      `db_fence_clear_authority ${JSON.stringify(stateFile)} ${JSON.stringify(attestation)} ${JSON.stringify(server)}`,
      'echo "RC=$?"',
    ].join('\n')], { encoding: 'utf8' })

    const unattested = clear('')
    assert.match(unattested.stdout, /^RC=2$/m,
      `a release this run did not raise must not end the record:\n${unattested.stdout}`)
    assert.equal(existsSync(stateFile), true, 'and the record must still be there')
    assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'byte for byte, so the origin can still be released from it')
    assert.match(unattested.stdout, /base backup|restored snapshot|staging clone/,
      `and the refusal must say what it may be looking at:\n${unattested.stdout}`)

    // AND THE SECOND HALF OF THE SAME REFUSAL (o3d-secops r31, Codex HIGH 1). r30 stopped here, with
    // "this run raised a fence" as the whole attestation -- and that is a fact about a PROCESS,
    // which both connections of a run whose release was re-pointed to this very copy would still
    // satisfy. So a run that DID raise the fence and cannot show WHICH SERVER it just released is
    // refused too, and the record survives that as well.
    const unwitnessed = clear('raised-by-this-run', '')
    assert.match(unwitnessed.stdout, /^RC=2$/m,
      `a release that cannot show which server it landed on must not end the record either:\n${unwitnessed.stdout}`)
    assert.equal(existsSync(stateFile), true, 'and that record must still be there too')
    assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'byte for byte')

    // AND THE GUARD IS NOT A BAN. With both answers the removal happens, so a passing test above
    // cannot be a function that refuses everything.
    const attested = clear('raised-by-this-run', 'same-server-as-the-fence')
    assert.match(attested.stdout, /^RC=0$/m, `an attested removal must still happen:\n${attested.stdout}`)
    assert.equal(existsSync(stateFile), false, 'and the record is gone')
  } finally {
    copy?.stop()
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    if (previousAdmin === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previousAdmin
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
})

/**
 * THE MIXED READING, ON A REAL PRE-FENCE COPY (o3d-secops r30, Codex HIGH 2 -- its named test).
 *
 * r29's gate refused only `absent`, so a pre-fence copy bypassed it the moment ONE recorded
 * grantee was independently revoked there: the fingerprint matches, the reading becomes mixed, and
 * r29 proceeded on mixed deliberately. This is that copy, built for real, with one recorded
 * grantee revoked on it by "an administrator" and the other left alone.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): delete the LEGACY_FENCE_AMBIGUOUS
 * arm from doRelease() -- which is r29's code exactly -- and this exits 0, granting CONNECT back
 * to the role that was deliberately revoked, on a server that was never fenced.
 */
test('a pre-fence copy with one grantee independently revoked is refused (o3d-secops r30, Codex HIGH 2)', async (t) => {
  const root = stateDir(t)
  const dir = stateDir(t)
  const stateFile = join(dir, 'db-connect-fence.json')
  const port = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  let copy: ReturnType<typeof startCluster> | undefined
  const previousAdmin = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  try {
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust'])
    origin.psql(['-c', 'CREATE ROLE owner_role LOGIN'])
    origin.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
    origin.psql(['-c', 'CREATE DATABASE imsdb OWNER owner_role'])
    origin.psql(['-c', 'GRANT CONNECT ON DATABASE imsdb TO imsapp'])
    // THE COPY IS TAKEN BEFORE THE FENCE: it never replayed the transaction the record describes.
    copy = cloneCluster(root, origin, 'stale', port)
    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM PUBLIC'])
    origin.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM imsapp'])
    // AND ON THE COPY, SOMEBODY ELSE TAKES CONNECT FROM ONE OF THE SAME ROLES. Not this record's
    // fence -- an administrator's own revoke, which is the history the ACL cannot rule out.
    copy.psql(['-c', 'REVOKE CONNECT ON DATABASE imsdb FROM imsapp'])

    const originIdentity = {
      systemIdentifier: origin.psql(['-c', 'SELECT system_identifier::text FROM pg_control_system()']),
      databaseOid: origin.psql(['-c', "SELECT oid::text FROM pg_database WHERE datname = 'imsdb'"]),
    }
    assert.equal(copy.psql(['-c', 'SELECT system_identifier::text FROM pg_control_system()']), originIdentity.systemIdentifier,
      'precondition: the copy satisfies the fingerprint gate completely, which is why this reading is the one that matters')
    // THE ACL ITSELF, AND NOT has_database_privilege(). The gate reads DIRECT grantees out of
    // datacl -- the exact inverse of the statement the fence issues -- and effective privilege
    // answers a different question: with PUBLIC still holding CONNECT on this copy, imsapp
    // "has" it through PUBLIC while its own entry is gone. A precondition asked the wrong way
    // round would have measured nothing here.
    const copyAcl = copy.psql(['-c', "SELECT datacl::text FROM pg_database WHERE datname = 'imsdb'"])
    assert.doesNotMatch(copyAcl, /[{,]imsapp=/,
      `precondition: one recorded grantee must have lost its DIRECT CONNECT on the copy:\n${copyAcl}`)
    assert.match(copyAcl, /[{,]=[A-Za-z]*c\//,
      `and the other must still hold it -- that is the MIXED reading r29 proceeded on:\n${copyAcl}`)

    publishStandingAuthority(stateFile, {
      ...SAMPLE_STATE,
      database: 'imsdb',
      owner_role: 'owner_role',
      app_role: 'imsapp',
      revoked: [PUBLIC_GRANTEE, 'imsapp'],
      cluster_system_identifier: originIdentity.systemIdentifier,
      cluster_database_oid: originIdentity.databaseOid,
    })
    const untouched = readFileSync(stateFile, 'utf8')

    process.env.DEPLOY_ADMIN_DATABASE_URL = `postgres://${me}@127.0.0.1:${port}/imsdb`
    process.env.DATABASE_URL = `postgres://imsapp@127.0.0.1:${port}/imsdb`
    const release = async (cluster: ReturnType<typeof startCluster>) => {
      const client = new Client({ host: cluster.socket, port, database: 'imsdb', user: me })
      await client.connect()
      const sent: string[] = []
      const query = client.query.bind(client)
      ;(client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        sent.push(String(args[0]))
        return (query as (...a: unknown[]) => unknown)(...args)
      }
      try {
        const captured = await capturingFenceOutput(() => doRelease(client as never, {
          stateFile, appRole: 'imsapp',
          ...suppliedIdentity({ appHost: '127.0.0.1', appPort: String(port), appUser: 'imsapp', appDatabase: 'imsdb' }),
        }))
        return { code: captured.value, said: captured.err, grants: sent.filter((sql) => sql.trim().startsWith('GRANT')) }
      } finally {
        await client.end()
      }
    }

    const onTheCopy = await release(copy)
    assert.equal(onTheCopy.code, EXIT_ERROR, `a mixed reading on a copy must not be released from:\n${onTheCopy.said}`)
    assert.deepEqual(onTheCopy.grants, [],
      'and NOT ONE GRANT may be sent -- one of these roles was revoked deliberately and would get CONNECT back')
    assert.doesNotMatch(copy.psql(['-c', "SELECT datacl::text FROM pg_database WHERE datname = 'imsdb'"]), /[{,]imsapp=/,
      'so the administrator\'s own revoke on the copy stands')
    assert.equal(readFileSync(stateFile, 'utf8'), untouched, 'and the record is untouched')
    assert.match(onTheCopy.said, /DISAGREE about CONNECT/, onTheCopy.said)

    // AND THE ORIGIN STILL RELEASES, so the refusal is a discrimination and not a gate that
    // refuses everything.
    const onTheOrigin = await release(origin)
    assert.equal(onTheOrigin.code, EXIT_OK, `the cluster the fence IS standing on must still release:\n${onTheOrigin.said}`)
    assert.deepEqual(onTheOrigin.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ], 'sending exactly the recorded list')
    assert.equal(origin.psql(['-c', "SELECT has_database_privilege('imsapp','imsdb','CONNECT')::text"]), 'true',
      'and the application must actually get CONNECT back')
  } finally {
    copy?.stop()
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    if (previousAdmin === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previousAdmin
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
})

/**
 * THE ATTESTATION IS BOUND TO A CONNECTION, MEASURED ON REAL CLUSTERS (o3d-secops r31, Codex HIGH 1).
 *
 * r30 rested root's automatic removal of the fence record on ${DB_FENCE_RAISED} -- this run's
 * memory of having raised the fence. That is a fact about a PROCESS, and the fence and the release
 * are two processes on two connections; a proxy, a DNS change or a failover between them re-points
 * the connection while the memory stays true, so the attestation could be spent against a backend
 * that never saw the fence. r30's own clone test above is half of the demonstration: a release on a
 * post-fence copy succeeds, and the literal then removes the record.
 *
 * WHAT THIS MEASURES, on a real origin and a real `pg_basebackup` copy of it:
 *
 *   1. the witness's session-scoped advisory lock is visible from the fenced database, so `--fence`
 *      can establish on ITS OWN CONNECTION that the witness is on the backend it is about to revoke
 *      on -- and the same lock is NOT visible on the copy, which is the whole property;
 *   2. a nonce the witness has not been given reads as absent, so the check is not one that says
 *      "held" about everything;
 *   3. the copy cannot answer a challenge issued after it was taken, however it was taken.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): in witnessLockIsHeld(), drop the
 * `AND granted` and the two classid/objid comparisons so the count is over every advisory lock --
 * assertion 2 fails, because an unrelated nonce then reads as held. Drop the whole predicate and
 * return `true` -- assertion 1's negative half and assertion 3 fail on the copy.
 */
test('the witness lock is visible on the fenced instance and on no copy of it (o3d-secops r31, Codex HIGH 1)', async (t) => {
  const root = stateDir(t)
  const port = await freePort()
  const clonePort = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  let copy: ReturnType<typeof startCluster> | undefined
  let witness: Client | undefined
  let fencing: Client | undefined
  let onCopy: Client | undefined
  try {
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust'])
    origin.psql(['-c', 'CREATE DATABASE imsdb'])

    // THE WITNESS IS NOT ON THE FENCED DATABASE, which is the shipped arrangement: completeFence()
    // terminates every other client backend on the database it fences, so a witness there would be
    // killed by the drain. `postgres` is the door the helper's own witnessConnectionStrings() picks.
    witness = new Client({ host: origin.socket, port, database: 'postgres', user: me })
    await witness.connect()
    const nonce = 'a1'.repeat(16)
    await witness.query('SELECT pg_advisory_lock($1::bigint)', [advisoryKeyForWitnessNonce(nonce)])

    // 1. THE FENCING CONNECTION, on the database that is about to be fenced, can see it.
    fencing = new Client({ host: origin.socket, port, database: 'imsdb', user: me })
    await fencing.connect()
    assert.equal(await witnessLockIsHeld(fencing as never, nonce), true,
      'the connection about to revoke must be able to see the witness it will be measured against')

    // 2. AND IT IS NOT A FUNCTION THAT SAYS YES. A nonce nobody holds must read as absent, or
    //    assertion 1 establishes nothing at all.
    assert.equal(await witnessLockIsHeld(fencing as never, 'b2'.repeat(16)), false,
      'a nonce no session holds must read as absent')

    // 3. THE COPY, taken WITH the lock held, cannot produce it. Advisory locks live in shared
    //    memory; nothing in a data directory carries one, which is exactly why this and not the
    //    system identifier, the database OID or the ACL -- all of which the copy does carry.
    copy = cloneCluster(root, origin, 'after', clonePort)
    onCopy = new Client({ host: copy.socket, port: clonePort, database: 'imsdb', user: me })
    await onCopy.connect()
    assert.equal(await witnessLockIsHeld(onCopy as never, nonce), false,
      'a physical copy of the fenced cluster must not be able to answer for the witness')

    // AND A CHALLENGE ISSUED AFTER THE COPY WAS TAKEN, which is the shape --release uses: the
    // nonce did not exist when the copy was made, so no copy however made can contain it.
    const challenge = 'c3'.repeat(16)
    await witness.query('SELECT pg_advisory_lock($1::bigint)', [advisoryKeyForWitnessNonce(challenge)])
    assert.equal(await witnessLockIsHeld(fencing as never, challenge), true, 'the origin answers a fresh challenge')
    assert.equal(await witnessLockIsHeld(onCopy as never, challenge), false, 'and the copy cannot')
  } finally {
    await onCopy?.end().catch(() => {})
    await fencing?.end().catch(() => {})
    await witness?.end().catch(() => {})
    copy?.stop()
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * THE WITNESS SURVIVES THE DRAIN, AND THE DRAIN STILL FINDS THE ROOM EMPTY (o3d-secops r31).
 *
 * This is the constraint that decided where the witness attaches, and it is the one a later round
 * would break by "simplifying" it onto the fenced database. completeFence() TERMINATES every other
 * client backend on `current_database()` and then requires none to be left -- and it must keep
 * requiring that, because a session attached across the migration window is the exact thing the
 * fence exists to prevent. So the witness must be invisible to that statement and its lock still
 * visible afterwards, and both halves are measured here with the shipped SQL rather than argued.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): change witnessConnectionStrings()
 * to leave the database as it was, so the witness attaches to the fenced database -- the drain
 * terminates it, the second assertion sees a non-empty room or the third sees the lock gone.
 */
test('the connection witness is not what the fence drains (o3d-secops r31)', async (t) => {
  const root = stateDir(t)
  const port = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  let witness: Client | undefined
  let fencing: Client | undefined
  try {
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust'])
    origin.psql(['-c', 'CREATE DATABASE imsdb'])
    const nonce = 'd4'.repeat(16)

    // THE WITNESS GOES WHERE THE SHIPPED CODE SENDS IT, read out of the shipped function rather
    // than written down again here: a rig that hard-coded `postgres` would keep passing after the
    // helper had been changed to attach somewhere the drain does reach.
    const [first] = witnessConnectionStrings(`postgres://${me}@127.0.0.1:${port}/imsdb`)
    assert.match(first, /\/postgres(\?|$)/, 'the witness is pointed at another database in the same cluster')
    witness = new Client({ host: origin.socket, port, database: new URL(first).pathname.slice(1), user: me })
    await witness.connect()
    await witness.query('SELECT pg_advisory_lock($1::bigint)', [advisoryKeyForWitnessNonce(nonce)])

    fencing = new Client({ host: origin.socket, port, database: 'imsdb', user: me })
    await fencing.connect()
    assert.equal(await witnessLockIsHeld(fencing as never, nonce), true, 'precondition: the fence can see the witness')

    // THE DRAIN, WORD FOR WORD AS completeFence() ISSUES IT. Lifted from the shipped file so a
    // change to that statement cannot leave this rig measuring the old one.
    const HELPER = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
    assert.ok(HELPER.includes('SELECT pg_terminate_backend(pid)'), 'the drain must still be the statement this rig models')
    await fencing.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'`,
    )
    const { rows } = await fencing.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    )
    assert.equal(rows[0].n, 0, 'the fenced database must still drain to nothing: the witness may not weaken that')
    assert.equal(await witnessLockIsHeld(fencing as never, nonce), true,
      'and the witness must still be holding, or the release would have nothing to be measured against')
  } finally {
    await fencing?.end().catch(() => {})
    await witness?.end().catch(() => {})
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * THE WITNESS LIFECYCLE, DRIVEN BY THE SHIPPED SHELL AGAINST A REAL CLUSTER (o3d-secops r31).
 *
 * The three library functions are lifted out of scripts/lib/db-fence-protected.sh and run in a real
 * bash, against a real `--witness` process talking to a real PostgreSQL. What it establishes:
 *
 *   * the co-process starts, holds, and says so, so the ordinary cutover keeps its automation;
 *   * every challenge nonce is FRESH -- a reused one would be a fact a snapshot could contain;
 *   * a stopped witness cannot be challenged, which is the fallback the whole design leans on;
 *   * and a SECOND witness starts cleanly in the same shell, which is the exit trap's re-fence.
 *
 * MUTATION ROUTE (made against the shipped file and reverted): make db_fence_witness_challenge()
 * reuse ${DB_FENCE_WITNESS_NONCE} instead of minting one -- the freshness assertion fails. Delete
 * the `db_fence_witness_stop` call at the top of db_fence_witness_start() -- the second start
 * warns and the "SECOND READY" line does not appear. Make db_fence_witness_challenge() return 0
 * without asking anything -- the stopped-witness assertion fails.
 */
test('the witness co-process starts, answers fresh challenges, stops, and restarts (o3d-secops r31)', async (t) => {
  const root = stateDir(t)
  const port = await freePort()
  const me = currentUser()
  let origin: ReturnType<typeof startCluster> | undefined
  try {
    origin = startCluster(root, 'origin', port, '127.0.0.1', ['local replication all trust', 'host all all 127.0.0.1/32 trust'])
    origin.psql(['-c', 'CREATE ROLE imsapp LOGIN'])
    origin.psql(['-c', 'CREATE DATABASE imsdb'])

    const program = [
      'set -uo pipefail',
      'DB_FENCE_SUDO_PREFIX=""',
      'DB_FENCE_RELEASE_WRAPPER="/opt/cutover/release-db-fence"',
      // The one part each entrypoint supplies for itself; here it is simply `node`, because this
      // rig is about the lifecycle and not about how the three of them drop privilege.
      'db_fence_helper() { local s="$1"; shift; node "$s" "$@"; }',
      shellFunction(FENCE_LIBRARY, 'db_fence_witness_nonce'),
      shellFunction(FENCE_LIBRARY, 'db_fence_witness_stop'),
      shellFunction(FENCE_LIBRARY, 'db_fence_witness_start'),
      shellFunction(FENCE_LIBRARY, 'db_fence_witness_challenge'),
      'DB_FENCE_WITNESS_BOUND=0',
      `IDENT=(--app-host=127.0.0.1 --app-port=${port} --app-user=imsapp --app-database=imsdb)`,
      // EVERY NONCE IS MINTED BY THE CALLER, which is the shipped shape: none of them is a
      // script-scope name, so each lives only in the frame that spends it.
      'FENCE_NONCE="$(db_fence_witness_nonce)"',
      `db_fence_witness_start ${JSON.stringify(join(process.cwd(), 'scripts/fence-db-connections.mjs'))} "\${FENCE_NONCE}" "\${IDENT[@]}" || { echo "START FAILED"; exit 1; }`,
      'echo "READY ${FENCE_NONCE}"',
      'DB_FENCE_WITNESS_BOUND=1',
      'C1="$(db_fence_witness_nonce)"',
      'db_fence_witness_challenge "${C1}" || { echo "CHALLENGE 1 FAILED"; exit 1; }',
      'echo "CHALLENGE1 ${C1}"',
      'C2="$(db_fence_witness_nonce)"',
      'db_fence_witness_challenge "${C2}" || { echo "CHALLENGE 2 FAILED"; exit 1; }',
      'echo "CHALLENGE2 ${C2}"',
      'db_fence_witness_stop',
      'C3="$(db_fence_witness_nonce)"',
      'if db_fence_witness_challenge "${C3}"; then echo "STOPPED WITNESS STILL ANSWERED"; else echo "STOPPED WITNESS CANNOT ANSWER"; fi',
      'SECOND_NONCE="$(db_fence_witness_nonce)"',
      `db_fence_witness_start ${JSON.stringify(join(process.cwd(), 'scripts/fence-db-connections.mjs'))} "\${SECOND_NONCE}" "\${IDENT[@]}" || { echo "SECOND START FAILED"; exit 1; }`,
      'echo "SECOND READY ${SECOND_NONCE}"',
      'db_fence_witness_stop',
      'echo "DONE"',
    ].join('\n')
    const run = spawnSync('bash', ['-c', program], {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_ADMIN_DATABASE_URL: `postgres://${me}@127.0.0.1:${port}/imsdb` },
    })
    const said = `${run.stdout}\n--- stderr ---\n${run.stderr}`

    assert.match(run.stdout, /^READY [0-9a-f]{32}$/m, `the witness must start and report its nonce:\n${said}`)
    const first = /^CHALLENGE1 ([0-9a-f]{32})$/m.exec(run.stdout)
    const second = /^CHALLENGE2 ([0-9a-f]{32})$/m.exec(run.stdout)
    const ready = /^READY ([0-9a-f]{32})$/m.exec(run.stdout)
    assert.ok(first && second && ready, `both challenges must be answered:\n${said}`)
    // FRESHNESS IS THE MECHANISM, not a detail. A challenge that reused an earlier nonce would be
    // a lock some earlier snapshot of the cluster could already contain.
    assert.notEqual(first![1], second![1], `each challenge must mint a new nonce:\n${said}`)
    assert.notEqual(first![1], ready![1], `and none of them may be the fence's own nonce:\n${said}`)
    assert.match(run.stdout, /^STOPPED WITNESS CANNOT ANSWER$/m,
      `a witness that has been stopped must not be able to attest anything:\n${said}`)
    assert.match(run.stdout, /^SECOND READY [0-9a-f]{32}$/m,
      `and a second witness must start cleanly in the same shell -- the exit trap's re-fence does exactly that:\n${said}`)
    assert.doesNotMatch(run.stderr, /still exists/,
      `starting the second witness must not leave bash complaining about the first:\n${said}`)
    assert.match(run.stdout, /^DONE$/m, `and the whole sequence must complete:\n${said}`)
  } finally {
    origin?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
