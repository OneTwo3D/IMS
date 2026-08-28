import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
  appDirectory,
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
  STATE_PRESENT,
  STATE_UNREADABLE,
  assessDatabaseIdentity,
  assessUnrecordedRelease,
  classifyStateShape,
  doFence,
  doRelease,
  publishState,
  readState,
  assessEffectiveFence,
  assessMigrationRole,
  parseConnectionIdentity,
  buildMigrationConnectionString,
  listDirectConnectGrantees,
  buildGrantStatements,
  buildRevokeStatements,
  granteeHasConnect,
  parseAclEntries,
  parseRoleFromConnectionString,
  planConnectionFence,
  quoteIdent,
  verifyRelease,
} from '@/scripts/fence-db-connections.mjs'

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
  return { appHost: 'localhost', appPort: '5432', appUser: 'imsapp', appDatabase: 'onetwo3d_ims', ...overrides }
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
  const cwd = mkdtempSync(join(tmpdir(), 'ims-fence-'))
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
}

// o3d-2sm1.2 — check-db-writers.mjs SNAPSHOTS pg_stat_activity and closes; the dump
// and the migration open their own connections afterwards, and nothing stops another
// client connecting in between. This is the continuous part, and the decisions it
// makes — whether a fence is even possible, and exactly what a release must restore —
// are asserted here rather than discovered against a production database.

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

test('a default database ACL grants CONNECT to PUBLIC, so a NULL datacl is not "no privileges"', () => {
  // Reading NULL as an empty ACL is how a restore ends up granting nothing back.
  assert.equal(granteeHasConnect(null, 'owner', PUBLIC_GRANTEE), true)
  assert.equal(granteeHasConnect(null, 'owner', 'owner'), true)
  assert.equal(granteeHasConnect(null, 'owner', 'imsapp'), false)
})

test('an explicit ACL is read entry by entry, and the PUBLIC entry has no grantee', () => {
  const acl = '{owner=CTc/owner,=T/owner,imsapp=c/owner}'
  assert.deepEqual(parseAclEntries(acl).map((entry) => entry.grantee), ['owner', '', 'imsapp'])
  assert.equal(granteeHasConnect(acl, 'owner', PUBLIC_GRANTEE), false, 'PUBLIC has T but not c')
  assert.equal(granteeHasConnect(acl, 'owner', 'imsapp'), true)
  assert.equal(granteeHasConnect(acl, 'owner', 'nobody'), false)
})

test('a comma inside a quoted role name is not an ACL separator', () => {
  const entries = parseAclEntries('{"role,with,commas"=c/owner,imsapp=c/owner}')
  assert.deepEqual(entries.map((entry) => entry.grantee), ['role,with,commas', 'imsapp'])
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
  const restored = verifyRelease('{owner=CTc/owner,=Tc/owner,imsapp=c/owner}', 'owner', [PUBLIC_GRANTEE, 'imsapp'])
  assert.equal(restored.released, true)

  const partial = verifyRelease('{owner=CTc/owner,=T/owner,imsapp=c/owner}', 'owner', [PUBLIC_GRANTEE, 'imsapp'])
  assert.equal(partial.released, false)
  assert.deepEqual(partial.missing, [PUBLIC_GRANTEE])
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
  const acl = '{owner=CTc/owner,=Tc/owner,imsapp=c/owner,metabase=c/owner,readonly=T/owner}'
  assert.deepEqual(listDirectConnectGrantees(acl, 'owner'), ['owner', 'imsapp', 'metabase'])
  assert.ok(!listDirectConnectGrantees(acl, 'owner').includes(''), 'PUBLIC is handled separately')
  // A NULL datacl is the defaults: CONNECT to PUBLIC and everything to the owner.
  assert.deepEqual(listDirectConnectGrantees(null, 'owner'), ['owner'])
  assert.deepEqual(listDirectConnectGrantees('', 'owner'), ['owner'])
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

function stateDir() {
  return mkdtempSync(join(tmpdir(), 'ims-fence-state-'))
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
      datacl?: string | null
      releasedDatacl?: string | null
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
    } = {},
  ) {}

  private connectAsks = 0

  async query(text: string) {
    const sql = String(text).trim()
    this.log.push(sql)
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
            datacl: this.options.datacl ?? '{owner=CTc/owner,=Tc/owner,imsapp=c/owner}',
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
    if (sql.includes('FROM pg_roles r')) return { rows: [] }
    if (sql.includes('pg_terminate_backend')) return { rows: [] }
    if (sql.includes('FROM pg_stat_activity')) return { rows: this.options.attached ?? [] }
    if (sql.includes('FROM pg_database d WHERE d.datname = $1')) {
      return { rows: [{ datacl: this.options.releasedDatacl ?? null, owner_role: 'owner' }] }
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

test('the fence record is published atomically and ends with the completeness sentinel', () => {
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, SAMPLE_STATE)

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

test('readState tells a missing record apart from one that exists and cannot be used', () => {
  const dir = stateDir()
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

test('a publish that fails BEFORE the rename leaves the previous record byte for byte', () => {
  // FAILURE INJECTED ON THE PRE-RENAME SIDE: the directory refuses new entries, so the
  // temporary is never created and nothing is renamed. The last durable record must survive
  // exactly — the old writeFileSync would have truncated it in place at this instant.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, SAMPLE_STATE)
    const before = readFileSync(stateFile, 'utf8')

    chmodSync(dir, NO_WRITE)
    assert.throws(
      () => publishState(stateFile, { ...SAMPLE_STATE, revoked: ['something else entirely'] }),
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

test('a publish whose POST-RENAME barrier fails throws, though the record is already visible', () => {
  // FAILURE INJECTED ON THE POST-RENAME SIDE: create, write, fsync and rename all succeed;
  // only the flush of the directory entry the rename created is refused. Any caller that read
  // the file back here would be satisfied. Only the throw tells the truth.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    chmodSync(dir, NO_READ)
    assert.throws(() => publishState(stateFile, SAMPLE_STATE), /EACCES|EPERM/, 'an unprovable name must throw')
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

test('the fence refuses to revoke when its record cannot be created at all', async () => {
  // PRE-RENAME side. Nothing is on disk and nothing may be revoked: a REVOKE is committed and
  // survives, so it must never outrun the record that undoes it.
  const dir = stateDir()
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

test('the fence refuses to revoke when its record is visible but its name is not durable', async () => {
  // POST-RENAME side — the instant the finding names. The record is complete and readable at
  // the authoritative path; a read-back would pass; a power loss can still restore the
  // previous directory entry. Only publishState()'s throw can refuse here.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    chmodSync(dir, NO_READ)
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
    chmodSync(dir, 0o700)

    // Precondition: the rename HAPPENED, so this is the post-rename side and not the other one.
    assert.equal(existsSync(stateFile), true, 'the record must be visible at the authoritative path')
    assert.match(readFileSync(stateFile, 'utf8'), /"state_complete": 1/, 'complete, and readable, at the moment of refusal')

    assert.equal(code, EXIT_NOT_FENCEABLE, 'a record whose NAME is unproven must abort the fence')
    assert.deepEqual(client.revokes, [], 'and NOTHING may be revoked')
    assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the complete record is on the medium before the revoking transaction is opened', async () => {
  // The positive half, observed at the wire: the fake snapshots the state file the instant it
  // is asked for BEGIN. A publication ordered AFTER the transaction would leave it empty.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_OK, 'the happy path must still fence')
    assert.ok(client.fileAtBegin !== null, 'the record must exist before BEGIN, not after COMMIT')
    const atBegin = JSON.parse(client.fileAtBegin as string)
    assert.equal(atBegin.state_complete, 1, 'and be complete before BEGIN')
    assert.deepEqual(
      atBegin.revoked,
      ['PUBLIC', 'owner', 'imsapp'],
      'naming every grantee the transaction is about to revoke from',
    )
    assert.deepEqual(
      client.revokes,
      [
        'REVOKE CONNECT ON DATABASE "imsdb" FROM PUBLIC;',
        'REVOKE CONNECT ON DATABASE "imsdb" FROM "owner";',
        'REVOKE CONNECT ON DATABASE "imsdb" FROM "imsapp";',
      ],
      'and the transaction must revoke exactly what the record names',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a grantee that appeared since the fence was recorded is recorded durably before it is revoked', async () => {
  // The append path, on the POST-RENAME side. The fence recorded earlier stays standing; the
  // NEW grantee is not revoked, because the record that would restore it could not be proven.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, { ...SAMPLE_STATE, revoked: ['PUBLIC'] })
    const before = readFileSync(stateFile, 'utf8')

    chmodSync(dir, NO_READ)
    const client = new FakeAdminClient({ stateFile })
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...suppliedIdentity({ appDatabase: 'imsdb' }) }))
    chmodSync(dir, 0o700)

    assert.equal(code, EXIT_NOT_FENCEABLE, 'an unrecordable append must abort')
    assert.deepEqual(client.revokes, [], 'and the newly appeared grantees must NOT be revoked')
    assert.ok(!client.log.includes('BEGIN'), 'the transaction must never be opened')
    // The rename landed, so the visible record now names the appended grantees; what matters
    // is that the DATABASE was not changed to match a record that may not survive.
    assert.notEqual(readFileSync(stateFile, 'utf8'), before, 'precondition: the append reached the rename')
  } finally {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fence refuses to re-apply a record written for another database', async () => {
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
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, { ...SAMPLE_STATE, database: 'otherdb', revoked: ['PUBLIC', 'otherapp'] })
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

test('the fence refuses to start a fresh record over one it cannot read', async () => {
  // The same absence-read-as-negative defect on the WRITE side: the old readState() collapsed
  // "unusable" into null, and doFence would then publish a fresh record over the only account
  // of what an earlier fence revoked.
  const dir = stateDir()
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

test('--release over a lost record grants nothing and fails, rather than reporting nothing to release', async () => {
  // The behavioural half: the record is gone, the database says the application cannot
  // connect. The old code printed "No connection fence is recorded; nothing to release." and
  // exited 0 here.
  const dir = stateDir()
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

test('--release over a lost record refuses even when the application connects, because another revoked grantee may still be out', async () => {
  // THE SHAPE doFence() ITSELF LEAVES BEHIND (o3d-2sm1.5, Codex r12 HIGH). The fence revoked
  // CONNECT from PUBLIC and from `monitoring`; the application kept it through role membership,
  // so doFence() rejected the fence as ineffective and DELIBERATELY left the revokes standing.
  // The datacl below is that state: imsapp connects, PUBLIC and monitoring do not. Then the
  // record is lost. Reading has_database_privilege('imsapp') as "no fence is standing" reports
  // success over two revocations nobody will ever undo.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({
      stateFile,
      stillConnectsBefore: true,
      datacl: '{owner=CTc/owner,=T/owner,imsapp=c/owner}',
      releasedDatacl: '{owner=CTc/owner,=T/owner,imsapp=c/owner}',
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

test('--release restores exactly the recorded grantees when the record survived', async () => {
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, SAMPLE_STATE)
    const client = new FakeAdminClient({
      stateFile,
      releasedDatacl: '{owner=CTc/owner,=Tc/owner,imsapp=c/owner}',
    })
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp', ...suppliedIdentity({ appDatabase: 'imsdb' }) }))

    assert.equal(code, EXIT_OK)
    assert.deepEqual(client.grants, [
      'GRANT CONNECT ON DATABASE "imsdb" TO PUBLIC;',
      'GRANT CONNECT ON DATABASE "imsdb" TO "imsapp";',
    ])
    assert.equal(existsSync(stateFile), false, 'and the record goes only once the grants are verified back')
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

test('the fence revokes nothing when the admin connection is not the application\'s database', () => {
  // TWO DATABASES, and the role connects only to the admin URL's target. Fencing here would lock
  // other people's clients out of somewhere else while the application went on writing across
  // the migration, and every verification would be a truthful report about the wrong database.
  //
  // MUTATION ROUTE: remove the requireBoundDatabaseIdentity() call from doFence() and this
  // fences 'imsdb' and returns EXIT_OK with three REVOKEs on the wire.
  const dir = stateDir()
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

test('a release over an unbound connection restores nothing, however good its record looks', async () => {
  // The record is PRESENT and valid, so nothing downstream would ever question this release: it
  // would GRANT CONNECT on 'imsdb' — the admin URL's target, where imsapp already connects —
  // report "released", and let the caller start an application whose own database, onetwo3d_ims,
  // this run has never asked about and cannot ask about.
  //
  // MUTATION ROUTE: remove the requireBoundDatabaseIdentity() call from doRelease() and this
  // returns EXIT_OK with two GRANTs on the wire.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, SAMPLE_STATE)
    const client = new FakeAdminClient({ stateFile, releasedDatacl: '{owner=CTc/owner,=Tc/owner,imsapp=c/owner}' })
    const code = await withMismatchedUrls(() => doRelease(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1, ...MISMATCHED_IDENTITY }))

    assert.equal(code, EXIT_ERROR, 'an unidentified database is a refusal, not a release')
    assert.notEqual(code, EXIT_OK, 'and above all not a success')
    assert.deepEqual(client.grants, [], 'and nothing may be granted on it')
    assert.equal(existsSync(stateFile), true, 'the record survives: this fence has not been released by anyone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a release refuses when the record it holds was written for another database', async () => {
  // The other half of the same question: the URLs agree, and the RECORD is from somewhere else —
  // a state file left by a run against a different database. Releasing from here would restore
  // grants recorded elsewhere, named by a database this connection is not attached to.
  //
  // MUTATION ROUTE: delete the `state.database !== connectedDatabase` arm from doRelease() and
  // this returns EXIT_OK, having granted on "elsewhere".
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    publishState(stateFile, { ...SAMPLE_STATE, database: 'elsewhere' })
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

test('a fence that committed its revokes and could not shut the application out says the fence is STANDING', async () => {
  // MUTATION ROUTE: return EXIT_ERROR from the ineffective-fence branch of completeFence() and
  // this fails — which is the state the entrypoints could not distinguish.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
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

test('a fence whose room will not go quiet says the fence is STANDING', async () => {
  // MUTATION ROUTE: return EXIT_ERROR from the drain refusal and this fails.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
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

test('an error thrown AFTER the commit is a standing fence, not an exception the caller must classify', async () => {
  // A throw from any post-commit read used to escape doFence() entirely and reach main()'s
  // catch, which exits 1 — indistinguishable from a fence that revoked nothing, over a database
  // whose CONNECT had just been taken away.
  //
  // MUTATION ROUTE: remove the try/catch around completeFence() and this rejects instead of
  // returning, failing the test.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
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

test('the fence revokes nothing when the SUPPLIED identity is not the cluster this connection is on', async () => {
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
  const dir = stateDir()
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

test('the fence revokes nothing when the connection logged in as a role the admin URL does not name', async () => {
  // MUTATION ROUTE: delete the admin.user vs connectedLoginRole arm and this fence proceeds,
  // excluding 'deployadmin' from the revoke while the connection it must keep is 'postgres' —
  // which is how a fence locks out the very connection that would release it.
  const dir = stateDir()
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

test('a COMMIT whose acknowledgement never arrives is a fence that MAY BE STANDING, not one that did not happen', async () => {
  // MUTATION ROUTE: move `commitIssued = true` to after the COMMIT await — the old boundary — and
  // this test rejects instead of returning, because the catch rethrows.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
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

test('a failure BEFORE the COMMIT is issued still rolls back and still reports a fence that never happened', async () => {
  // The control on the control (o3d-2sm1.5): if every failure became EXIT_FENCE_STANDING, the
  // code would stop meaning anything and every aborted run would send an operator hunting for a
  // fence that is not there.
  //
  // MUTATION ROUTE: drop the `if (!commitIssued)` guard and this stops throwing.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    class RefusingClient extends FakeAdminClient {
      override async query(text: string) {
        if (String(text).trim().startsWith('REVOKE')) throw new Error('permission denied for database imsdb')
        return super.query(text)
      }
    }
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

test('the fence revokes nothing, and commits nothing, when the ADMIN URL names two hosts, two ports and two roles', async () => {
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

  const dir = stateDir()
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
      '"${DB_FENCE_PROBE_SCRIPT}"', '"$DB_FENCE_PROBE_SCRIPT"',
    ]
    const invocations = source.split('\n').filter((line) => RESOLVED.some((spelling) => line.includes(spelling)))
    const modes = invocations.filter((line) => /--(fence|release|preflight|print-migration-url)\b/.test(line))
    assert.ok(modes.length >= 4, `${name}: precondition — the helper is actually invoked here (${modes.length})`)
    for (const line of modes) {
      assert.ok(line.includes('DB_FENCE_IDENTITY_ARGS[@]'), `${name}: every invocation passes the identity — ${line.trim()}`)
    }
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

test('o3d-2sm1.5 r19: the four options are parsed, and the one file still read is resolved from the SCRIPT', () => {
  // TWO THINGS THE PRINTED --release COMMAND DEPENDS ON, and it is the one command an operator is
  // offered for taking a committed fence back down.
  //
  // 1. THE OPTIONS EXIST AND ARE READ. A flag parseArgs() silently ignores is a flag the callers
  //    pass into a void, and every mode would then refuse on a value that WAS supplied.
  //    MUTATION ROUTE: drop any `--app-*` arm from parseArgs() and the matching assertion fails.
  assert.deepEqual(
    parseArgs(['--release', '--app-host=db.internal', '--app-port=6432', '--app-user=imsapp', '--app-database=imsdb', '--state-file=/x']),
    { mode: 'release', stateFile: '/x', appRole: '', timeoutSeconds: 30, appHost: 'db.internal', appPort: '6432', appUser: 'imsapp', appDatabase: 'imsdb' },
  )
  // And nothing remains that would take a unit name or a systemctl path.
  const withUnit = parseArgs(['--fence', '--service-unit=one-two-inventory.service', '--systemctl=/x/systemctl']) as Record<string, unknown>
  assert.equal(withUnit.serviceUnits, undefined, 'no unit is interrogated any more')
  assert.equal(withUnit.systemctlPath, undefined, 'and no systemctl path is taken')

  // 2. THE .env IT READS IS THE APP DIRECTORY'S, resolved from this file's own location — because
  //    the printed command is a bare absolute `node /opt/.../fence-db-connections.mjs --release
  //    ...` and an operator runs it from wherever they are standing (Codex r17 HIGH). A relative
  //    path loaded nothing there, so the one command offered for taking a fence down could not
  //    obtain the admin connection that takes it down.
  //    MUTATION ROUTE: put the relative path back in main(). The run below then picks up the
  //    DECOY .env sitting in its working directory and reports a privileged connection it does
  //    not have, so `DEPLOY_ADMIN_DATABASE_URL is not set` stops appearing.
  assert.equal(appDirectory(), process.cwd(), 'precondition: the helper derives the app dir from its own path')
  const helper = readFileSync(join(process.cwd(), 'scripts/fence-db-connections.mjs'), 'utf8')
  const loads = helper.split('\n').filter((line) => /^\s*loadDotenv\(/.test(line))
  assert.deepEqual(
    loads.map((line) => line.trim()),
    ["loadDotenv({ path: resolvePath(appDir, '.env'), override: false, quiet: true })"],
    'exactly one file is loaded, and it is the one systemd gives the service — .env.local is not loaded at all',
  )
  assert.equal(
    readFileSync(join(process.cwd(), '.env'), 'utf8').includes('DEPLOY_ADMIN_DATABASE_URL'),
    false,
    'precondition: the app directory\'s own .env sets no admin URL, so the decoy is the only source of one',
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
    const raised = source.indexOf('--fence --state-file', fence)
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
    assert.ok(lifted.includes('--fence --state-file'), `${script}: and the lifted body is the one that issues it`)

    // A REAL FILE, because the shipped function refuses when the fence script is missing — and a
    // test whose every call refused there would prove nothing about the guard under test.
    const fenceDir = mkdtempSync(join(tmpdir(), 'ims-refence-'))
    const fenceScript = join(fenceDir, 'fence-db-connections.mjs')
    writeFileSync(fenceScript, '')

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
        // r31: the resolution is the SHARED library both scripts source, so the harness sources it
        // too and then points its literals at the harness directory. Lifting the functions one by
        // one would keep passing if an entrypoint stopped calling them, which is the finding.
        `source ${JSON.stringify(join(process.cwd(), 'scripts/lib/db-fence-protected.sh'))}`,
        `DB_FENCE_RECOVERY_DIR=${JSON.stringify(fenceDir)}`,
        `DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(join(fenceDir, 'protected'))}`,
        `DB_FENCE_SCRIPT_COPY=${JSON.stringify(join(fenceDir, 'protected', 'scripts', 'fence-db-connections.mjs'))}`,
        `DB_FENCE_SCRIPT_STAGED=${JSON.stringify(join(fenceDir, 'protected', 'scripts', '.staged'))}`,
        `DB_FENCE_MODULES_LINK=${JSON.stringify(join(fenceDir, 'protected', 'node_modules'))}`,
        `DB_FENCE_IDENTITY_FILE=${JSON.stringify(join(fenceDir, 'db-fence-identity.env'))}`,
        'DEPLOY_ADMIN_DATABASE_URL="postgresql://admin@127.0.0.1:5432/main"',
        'DATABASE_URL="postgresql://app:pw@127.0.0.1:5432/main"',
        'APP_USER="app"',
        'DB_FENCE_STATE="/tmp/state.json"',
        'DB_FENCE_RELEASE_CMD="release"',
        'MIGRATION_DATABASE_URL=""',
        'DB_FENCE_IDENTITY_ARGS=(--app-host=127.0.0.1 --app-port=5432 --app-user=app --app-database=main)',
        `SCHEMA_TOUCHED=${schemaTouched}`,
        `DB_FENCE_RAISED=${raised}`,
        'require_db_identity() { return 0; }',
        // THE STILL-PRESENT DISAGREEMENT: the unit acquired another environment source and the
        // gate keeps saying so, exactly as it does upstream.
        `require_env_file_is_sole_definition() { ${soleOk ? 'return 0' : 'return 1'}; }`,
        'warn() { :; }',
        `${runner}() { printf "CALL %s\\n" "$*"; return 0; }`,
        lifted,
        'refence_db_connections || printf "RETURNED-NONZERO\\n"',
      ].join('\n')
      const run = spawnSync('bash', ['-c', bash, 'refence', fenceScript], { encoding: 'utf8' })
      assert.equal(run.status, 0, `${script}: ${run.stderr}`)
      return run.stdout ?? ''
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
