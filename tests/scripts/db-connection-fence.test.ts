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
  IDENTITY_ENVIRONMENT_VARIABLES,
  SYSTEMCTL_PATHS,
  UNIT_PROPERTIES,
  appDirectory,
  applicationDotenvPaths,
  applyServiceEnvironment,
  findSystemctl,
  mentionedIdentityVariable,
  parseArgs,
  parseSystemctlShow,
  parseSystemdEnvironment,
  parseSystemdEnvironmentFiles,
  processOsAccount,
  readUnitEnvironment,
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
 * A STAND-IN FOR `systemctl show`, because a test cannot install a systemd unit.
 *
 * It answers with the properties the helper asks for, in `systemctl show`'s own `Key=Value`
 * shape, and it is reached through `--systemctl=<path>` — an ARGV value, which is the seam the
 * review asked for when it rejected the `IMS_SERVICE_ENV_FILE` environment variable (r17
 * CRITICAL): argv comes from the entrypoint that ran the script, and unlike an inherited variable
 * it cannot arrive from a `.bashrc`, a cron wrapper or a shell left open since last week.
 */
function stubSystemctl(
  directory: string,
  properties: { LoadState?: string; Environment?: string; EnvironmentFiles?: string; WorkingDirectory?: string; User?: string },
): string {
  const lines = [
    `Environment=${properties.Environment ?? ''}`,
    ...(properties.EnvironmentFiles === undefined ? [] : [`EnvironmentFiles=${properties.EnvironmentFiles}`]),
    `WorkingDirectory=${properties.WorkingDirectory ?? ''}`,
    `User=${properties.User ?? ''}`,
    `LoadState=${properties.LoadState ?? 'loaded'}`,
    'FragmentPath=/etc/systemd/system/one-two-inventory.service',
  ]
  const path = join(directory, 'systemctl')
  writeFileSync(path, `#!/bin/sh\ncat <<'PROPS'\n${lines.join('\n')}\nPROPS\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * Run the shipped script from a directory with no .env, and report what it said.
 *
 * THE SERVICE'S ENVIRONMENT COMES FROM SYSTEMD (o3d-2sm1.5 r18). The script asks
 * `systemctl show <unit>` for PGHOST/PGPORT/PGUSER/PGDATABASE and refuses when systemd cannot be
 * asked, when the unit is not loaded, or when the answer cannot be read — precisely so that a
 * variable in the calling shell cannot decide where the application connects. `unitEnvironment` is
 * what the stub reports as the unit's `Environment=`; passing `null` points `--systemctl=` at
 * nothing, which is the "systemd cannot be asked" refusal.
 */
function runFenceScript(
  args: string[],
  env: Record<string, string | undefined>,
  unitEnvironment: string | null = '',
  unitArgs: string[] = ['--service-unit=one-two-inventory.service'],
) {
  const cwd = mkdtempSync(join(tmpdir(), 'ims-fence-'))
  const systemctl =
    unitEnvironment === null
      ? join(cwd, 'no-such-systemctl')
      : stubSystemctl(cwd, { Environment: unitEnvironment })
  // spawnSync, not execFileSync: the script's diagnostics go to STDERR so that stdout stays the
  // machine-readable channel `--print-migration-url` is captured through, and a test that could
  // only see stdout on success could not tell the two apart.
  const run = spawnSync(
    'node',
    [join(process.cwd(), 'scripts/fence-db-connections.mjs'), ...args, ...unitArgs, `--systemctl=${systemctl}`],
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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))
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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))
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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))
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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp' }))

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
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp' }))

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
    appUrl: 'postgres://imsapp@localhost:5432/onetwo3d_ims',
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
    appUrl: 'postgres://imsapp@db-new.internal:5432/onetwo3d_ims',
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
    appUrl: 'postgres://imsapp@localhost:5432/onetwo3d_ims',
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
      appUrl: 'postgres://imsapp@localhost:5432/onetwo3d_ims',
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    true,
  )
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgresql:///onetwo3d_ims?host=/var/run/postgresql',
      appUrl: 'postgres://imsapp@localhost/onetwo3d_ims',
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    true,
    'a socket directory and localhost are the same server on the same default port',
  )
  // And the port still separates two clusters on that one machine.
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5433/onetwo3d_ims',
      appUrl: 'postgres://imsapp@localhost:5432/onetwo3d_ims',
      connectedDatabase: 'onetwo3d_ims',
    }).bound,
    false,
  )
})

test('nothing to bind to is not a pass: an unset or database-less DATABASE_URL is refused', () => {
  // MUTATION ROUTE: return { bound: true } when appUrl is missing — the "there is nothing to
  // check, so it must be fine" reading — and both of these fail.
  assert.equal(assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/imsdb', appUrl: '', connectedDatabase: 'imsdb' }).bound, false)
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/imsdb', appUrl: 'postgres://imsapp@localhost/', connectedDatabase: 'imsdb' }).bound,
    false,
    'a URL with no database in its path lands on the login role\'s own name, which is not the database this run is attached to',
  )
  assert.equal(parseConnectionIdentity('not a url at all').ok, false)
})

/** Admin and application URLs that do NOT agree — the two-database configuration, at the wire. */
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
      const code = await withMismatchedUrls(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withMismatchedUrls(() => doRelease(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doRelease(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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

test('a query parameter that redirects the server is what the driver uses, so it is what is compared', () => {
  // THE FINDING'S OWN URL. Its authority and path say localhost:5432/onetwo3d_ims — the admin
  // URL's own address, exactly — and the query string is where node-postgres actually goes.
  //
  // MUTATION ROUTE: restore the original parse, which is BOTH halves of the fix at once — read
  // the authority first (`url.hostname || params.get('host')`, `url.port || params.get('port')`)
  // AND drop the conflict refusal. This then returns bound: both URLs look like localhost:5432
  // while the application is on remote.example:6432, and the fence proves itself against a
  // cluster nobody uses. Either half alone catches it, which is why those routes are separate
  // below; this test is the whole defect as reported.
  const redirected = assessDatabaseIdentity({
    ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@localhost:5432/onetwo3d_ims',
    appUrl: 'postgres://imsapp@localhost:5432/onetwo3d_ims?host=remote.example&port=6432',
    connectedDatabase: 'onetwo3d_ims',
  })
  assert.equal(redirected.bound, false, 'the query string is where this connection actually goes')
  assert.match(redirected.reason, /remote\.example/)

  // And with nothing in the authority to disagree with — `postgres://role@/db?host=...`, the
  // libpq form WHATWG URL rejects and node-postgres accepts by retrying with a dummy host — the
  // query values are simply what this connection IS: resolved and compared as remote.example:6432
  // rather than refused as unreadable.
  const identity = parseConnectionIdentity('postgres://imsapp@/onetwo3d_ims?host=remote.example&port=6432')
  assert.equal(identity.ok, true, 'a URL the driver connects with must not be refused as unparseable')
  assert.equal(identity.host, 'remote.example')
  assert.equal(identity.port, '6432')
  assert.equal(identity.server, 'remote.example:6432')
  const viaQueryOnly = assessDatabaseIdentity({
    ...ATTACHED_AS_ADMIN,
    adminUrl: 'postgres://deployadmin@localhost:5432/onetwo3d_ims',
    appUrl: 'postgres://imsapp@/onetwo3d_ims?host=remote.example&port=6432',
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
    appUrl: 'postgres://imsapp@localhost/onetwo3d_ims',
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

/** An application URL that is redirected by its query string, at the wire. */
async function withRedirectedAppUrl<T>(appUrl: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DEPLOY_ADMIN_DATABASE_URL
  const previousApp = process.env.DATABASE_URL
  process.env.DEPLOY_ADMIN_DATABASE_URL = 'postgres://deployadmin@localhost:5432/imsdb'
  process.env.DATABASE_URL = appUrl
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_ADMIN_DATABASE_URL
    else process.env.DEPLOY_ADMIN_DATABASE_URL = previous
    if (previousApp === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousApp
  }
}

test('the fence revokes nothing when DATABASE_URL is redirected to another cluster by its query string', async () => {
  // THE WHOLE FINDING, AT THE WIRE. The admin URL and the application URL name the same database
  // on the same authority; only the query string says the application is somewhere else entirely.
  // Fencing here locks other people's clients out of THIS cluster while the application keeps
  // writing to remote.example across the migration.
  //
  // MUTATION ROUTE: read the authority first in parseConnectionIdentity() and this fence proceeds
  // — client.revokes stops being empty and the code stops being EXIT_NOT_FENCEABLE.
  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile })
    const code = await withRedirectedAppUrl('postgres://imsapp@localhost:5432/imsdb?host=remote.example&port=6432', () =>
      doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }),
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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
    const code = await withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }))

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
      () => withAdminUrl(() => doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 })),
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

test('the fence revokes nothing, and commits nothing, when DATABASE_URL names two hosts, two ports and two roles', async () => {
  // THE WHOLE FINDING, AT THE WIRE, IN THE DIRECTION THAT ACTUALLY FENCES. The duplicates here
  // resolve — through the driver — to precisely the admin URL's own address and role, so with the
  // repetition accepted the identity binds and the fence goes ahead: it would revoke CONNECT on
  // this cluster while the operator reading the URL, and every log line quoting it, says the
  // application is on remote.example:6432 as `other`. Nobody would look here for the writes.
  //
  // MUTATION ROUTE: delete the IDENTITY_PARAMS getAll() loop from parseConnectionIdentity() and
  // this fence proceeds — client.revokes stops being empty, COMMIT appears in the log, and the
  // state file is written.
  const ambiguous = 'postgres://@/imsdb?host=remote.example&host=localhost&port=6432&port=5432&user=other&user=imsapp'
  const effective = driverParse(ambiguous)
  assert.equal(effective.host, 'localhost', 'precondition: the driver lands on the admin URL\'s own host')
  assert.equal(effective.port, '5432', 'precondition: and its port')
  assert.equal(effective.user, 'imsapp', 'precondition: and the application role, so nothing else would refuse this')

  const dir = stateDir()
  try {
    const stateFile = join(dir, 'db-connect-fence.json')
    const client = new FakeAdminClient({ stateFile })
    const code = await withRedirectedAppUrl(ambiguous, () =>
      doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }),
    )

    assert.equal(code, EXIT_NOT_FENCEABLE)
    assert.deepEqual(client.revokes, [], 'nothing may be revoked for a URL whose destination is not known')
    assert.ok(!client.log.includes('COMMIT'), 'and no transaction may commit')
    assert.equal(existsSync(stateFile), false, 'and no record may be published for a fence that never happened')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a value the URL never mentions and the ENVIRONMENT supplies is where the application really connects, and the fence follows it there', async () => {
  // THE WHOLE r16 FINDING, IN THE DIRECTION THAT ACTUALLY FENCES.
  //
  // DATABASE_URL names no port. PGPORT does, and node-postgres dials it. Read the URL — even with
  // the driver's OWN STRING PARSER, which is what r15 shipped — and the application looks like it
  // is on 5432, which is exactly where the admin URL is: the identity binds, the fence revokes
  // CONNECT on 5432, and the application writes to 6432 undisturbed for the whole migration. The
  // one cluster nobody is protecting is the one being migrated.
  //
  // MUTATION ROUTE: make resolveDriverIdentity() return the installed pg-connection-string parse
  // of the connection string, and every assertion below flips — identity.port reads '5432', the
  // server reads '(this host):5432', assessDatabaseIdentity() returns bound, and doFence()
  // revokes, commits and writes the state file.
  const restore = withPgEnv({ PGPORT: '6432' })
  try {
    const appUrl = 'postgres://imsapp@localhost/imsdb'
    assert.equal(driverParse(appUrl).port ?? '', '', 'precondition: the URL itself names no port at all')
    assert.equal(driverConnection(appUrl).port, 6432, 'precondition: and the connection node-postgres opens is on 6432')

    const identity = parseConnectionIdentity(appUrl)
    assert.equal(identity.port, '6432', 'the port the environment supplies is the port this connects to')
    assert.equal(identity.server, '(this host):6432')

    const verdict = assessDatabaseIdentity({
      ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
      appUrl,
      connectedDatabase: 'imsdb',
    })
    assert.equal(verdict.bound, false, 'the admin connection is on 5432 and the application is not')
    assert.match(verdict.reason, /6432/, 'and the refusal names where the application really is')

    // At the wire: nothing revoked, nothing committed, no record published.
    const dir = stateDir()
    try {
      const stateFile = join(dir, 'db-connect-fence.json')
      const client = new FakeAdminClient({ stateFile })
      const code = await withRedirectedAppUrl(appUrl, () =>
        doFence(client as never, { stateFile, appRole: 'imsapp', timeoutSeconds: 1 }),
      )
      assert.equal(code, EXIT_NOT_FENCEABLE)
      assert.deepEqual(client.revokes, [], 'nothing may be revoked on a cluster the application does not use')
      assert.ok(!client.log.includes('COMMIT'), 'and no transaction may commit')
      assert.equal(existsSync(stateFile), false, 'and no record may be published for a fence that never happened')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    restore()
  }
})

test('an empty authority plus PGHOST moves the whole server, and that is refused rather than bound', () => {
  // The same defect on the other axis. `postgres://role@/db` is the libpq form with no host at
  // all; the parser reports '' and node-postgres then takes PGHOST. A fence bound on the parser's
  // answer locks out this machine while the application is on another one entirely.
  //
  // MUTATION ROUTE: return the pg-connection-string parse from resolveDriverIdentity() and the
  // host reads '' — which LOCAL_HOSTS treats as "(this host)" — so this binds to the local admin
  // URL and fences the wrong machine.
  const restore = withPgEnv({ PGHOST: 'remote.example' })
  try {
    const appUrl = 'postgres://imsapp@/imsdb'
    assert.equal(driverParse(appUrl).host ?? '', '', 'precondition: the URL names no host')
    const identity = parseConnectionIdentity(appUrl)
    assert.equal(identity.host, 'remote.example')
    assert.equal(identity.server, 'remote.example:5432')
    const verdict = assessDatabaseIdentity({
      ...ATTACHED_AS_ADMIN,
      adminUrl: 'postgres://deployadmin@localhost:5432/imsdb',
      appUrl,
      connectedDatabase: 'imsdb',
    })
    assert.equal(verdict.bound, false)
    assert.match(verdict.reason, /remote\.example/)
  } finally {
    restore()
  }
})

test('PGDATABASE is where a path-less DATABASE_URL lands, and the live attachment still has to agree with it', () => {
  // A URL with an empty path used to be refused as "names no database". That was a statement
  // about the URL, not about the connection: node-postgres attaches to PGDATABASE, and failing
  // that to the login role's own name. Both are now resolved, and both are then held against
  // current_database() read from the connection this run actually opened — which is the half a
  // URL cannot fake.
  //
  // MUTATION ROUTE: return the pg-connection-string parse from resolveDriverIdentity() and the
  // first case reads no database at all, so the run reports "DATABASE_URL resolves to no
  // database" about a URL that resolves perfectly well to onetwo3d_ims.
  const restore = withPgEnv({ PGDATABASE: 'onetwo3d_ims' })
  try {
    assert.equal(parseConnectionIdentity('postgres://imsapp@localhost/').database, 'onetwo3d_ims')
    assert.equal(
      assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/onetwo3d_ims', appUrl: 'postgres://imsapp@localhost/', connectedDatabase: 'onetwo3d_ims' }).bound,
      true,
      'the connection is attached to the database the environment sends it to',
    )
    assert.equal(
      assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/onetwo3d_ims', appUrl: 'postgres://imsapp@localhost/', connectedDatabase: 'imsdb' }).bound,
      false,
      'and a connection attached elsewhere is still refused',
    )
  } finally {
    restore()
  }
  // With no PGDATABASE, libpq falls back to the login role's own name — so this URL identifies
  // "imsapp", and a run attached to imsdb is not it.
  assert.equal(parseConnectionIdentity('postgres://imsapp@localhost/').database, 'imsapp')
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/imsdb', appUrl: 'postgres://imsapp@localhost/', connectedDatabase: 'imsdb' }).bound,
    false,
  )
})

test('the deploy account\'s own OS user is not the application\'s login role, and is not mistaken for it', () => {
  // PGHOST/PGPORT/PGUSER/PGDATABASE are deliberate settings this script and the application read
  // from the same environment, which is why identity now resolves through them. pg's LAST
  // fallback for the login role is not a setting at all — it is process.env.USER, the account
  // running whichever process asked. This script runs as the deploy account and the application
  // runs as its own, so taking one for the other would revoke CONNECT from a role nobody
  // connects as and then report the door shut.
  //
  // MUTATION ROUTE: delete the OS_ACCOUNT_SENTINEL probe from resolveDriverIdentity() and return
  // client.user/client.database straight through. This test then reads back whatever account the
  // suite happens to be running as instead of '', and the unix-socket admin URL in 'a loopback
  // address, localhost and a unix socket are the same machine' starts being refused for naming a
  // role it never named — i.e. the suite's verdict starts depending on who runs it.
  assert.equal(driverConnection('postgresql://localhost/ims').user, String(pg.defaults.user), 'precondition: the driver does fall back to the OS account')
  assert.equal(parseRoleFromConnectionString('postgresql://localhost/ims'), '', 'and no OS account is accepted as the application role')
  assert.equal(parseConnectionIdentity('postgresql://localhost/').database, '', 'nor as the database libpq would derive from it')
  assert.equal(
    assessDatabaseIdentity({ ...ATTACHED_AS_ADMIN, adminUrl: 'postgres://deployadmin@localhost/imsdb', appUrl: 'postgresql://localhost/', connectedDatabase: 'imsdb' }).bound,
    false,
    'so there is nothing to bind the run to',
  )

  // PGUSER, by contrast, IS deliberate shared configuration, and is honoured like the rest.
  const restore = withPgEnv({ PGUSER: 'configured' })
  try {
    assert.equal(parseRoleFromConnectionString('postgresql://localhost/ims'), 'configured')
    assert.equal(parseConnectionIdentity('postgresql://localhost/').database, 'configured')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// o3d-2sm1.5 (Codex r17, CRITICAL + MEDIUM) — WHOSE ENVIRONMENT, AND WHOSE ACCOUNT.
//
// r16 moved identity onto the driver, and the driver reads PGHOST/PGPORT/PGUSER/PGDATABASE from
// the environment OF WHICHEVER PROCESS ASKS. This one's is the deploy shell's; the application's
// is systemd's `Environment=` plus the unit's `EnvironmentFile=`. So the more faithfully this
// followed the driver, the more faithfully it followed the wrong environment — and a `PGPORT` in
// an operator's shell, absent from the service file, moved the whole fence onto another cluster.
//
// The tests below are about the two halves of that: the environment the script resolves in, and
// the OS account it is entitled to treat as the application's.
// ---------------------------------------------------------------------------

/** Set or DELETE environment variables for the length of one test, and put back what was there. */
function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A directory only this test can see, for stub binaries and stand-in environment files. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ims-fence-systemd-'))
}

/** `readUnitEnvironment` against a stand-in systemd, with no process spawned. */
function unitEnvironment(
  properties: Record<string, string | undefined>,
  overrides: Record<string, unknown> = {},
) {
  const stdout = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  return readUnitEnvironment(['one-two-inventory.service'], {
    show: () => ({ ok: true, reason: '', stdout }),
    readText: () => {
      const error = new Error('ENOENT') as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    },
    appDir: '/opt/one-two-inventory',
    realpath: (path: string) => path,
    osAccount: 'imsapp',
    ...overrides,
  })
}

test('o3d-2sm1.5 r18: an ambient PG* that DIFFERS from what systemd reports never reaches the fence', () => {
  // ROUTE: main() -> readUnitEnvironment(options.serviceUnits) -> `systemctl show <unit>` ->
  // Environment= -> applyServiceEnvironment() -> process.env -> the `pg.Client`
  // resolveDriverIdentity() builds -> parseConnectionIdentity() -> assessDatabaseIdentity(),
  // which is what licenses the fence.
  //
  // MUTATION ROUTE: delete the `delete env[name]` loop from applyServiceEnvironment() (or the
  // applyServiceEnvironment() call from main()). The ambient PGPORT below survives, the identity
  // reads 6432 — the port this shell happens to carry — and the first assertion fails. Delete
  // only the re-apply loop instead and the SECOND case fails: 6544 is neither the ambient value
  // nor pg's static default, so it can only be there by having come from systemd.
  const restore = withEnv({ PGPORT: '6432', PGHOST: 'deploy-shell.example', PGUSER: undefined, PGDATABASE: undefined })
  try {
    // PRECONDITION, MEASURED ON THE DRIVER: the ambient variables really do move the connection.
    // Without this the test could pass against a driver that ignored them.
    assert.equal(driverConnection('postgres://imsapp@localhost/imsdb').port, 6432, 'precondition: this shell\'s PGPORT reaches the driver')

    const service = unitEnvironment({ LoadState: 'loaded', Environment: 'PGPORT=5432', WorkingDirectory: '', User: 'imsapp' })
    assert.equal(service.ok, true, service.reason)
    const applied = applyServiceEnvironment(service)
    assert.deepEqual(applied.applied, ['PGPORT=5432'])
    assert.ok(applied.removed.includes('PGPORT=6432'), 'this shell\'s copy is taken away, not merged with')
    assert.ok(applied.removed.includes('PGHOST=deploy-shell.example'), 'and so is every other identity variable it carried')

    const identity = parseConnectionIdentity('postgres://imsapp@localhost/imsdb')
    assert.equal(identity.port, '5432', 'the fence resolves the port SYSTEMD reports, not the one this shell has')
    assert.equal(identity.host, 'localhost', 'and a host this shell invented does not survive at all')
  } finally {
    restore()
  }

  // THE OTHER DIRECTION, which a mere `delete` would pass by accident: a value that is neither the
  // ambient one nor pg's default has to be the answer.
  const restoreOther = withEnv({ PGPORT: '6432', PGHOST: undefined, PGUSER: undefined, PGDATABASE: undefined })
  try {
    applyServiceEnvironment(unitEnvironment({ LoadState: 'loaded', Environment: 'PGPORT=6544', WorkingDirectory: '', User: 'imsapp' }))
    assert.equal(parseConnectionIdentity('postgres://imsapp@localhost/imsdb').port, '6544')
  } finally {
    restoreOther()
  }
})

test('o3d-2sm1.5 r18: systemd being unavailable is a REFUSAL, never a fallback to this shell\'s environment', () => {
  // ROUTE: main() -> readUnitEnvironment() -> ok:false -> exit before any connection is opened.
  //
  // MUTATION ROUTE: make readUnitEnvironment() return `{ ok: true, values: {} }` on any of these
  // (i.e. "systemd said nothing, so assume the service sets none"). Every assertion here fails,
  // and the shipped script runs on the ambient environment — which is precisely the guess this
  // refuses to make, since the answer it could not get is the only thing that could contradict it.

  // 1. systemctl cannot be run at all.
  const missing = readUnitEnvironment(['one-two-inventory.service'], {
    show: () => ({ ok: false, reason: 'systemd cannot be asked: no systemctl at /usr/bin/systemctl', stdout: '' }),
    appDir: '/opt/one-two-inventory',
  })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /systemd cannot be asked/)

  // 2. the unit is not there.
  const notFound = unitEnvironment({ LoadState: 'not-found', Environment: '', WorkingDirectory: '', User: '' })
  assert.equal(notFound.ok, false)
  assert.match(notFound.reason, /LoadState=not-found, not loaded/)

  // 3. systemd answered, and the answer cannot be parsed. `LoadState` is printed for every unit
  //    that exists AND for every name that does not, so its ABSENCE is not an empty answer — it
  //    is not systemd's answer at all.
  const unparseable = unitEnvironment({ Environment: 'PGPORT=5432', WorkingDirectory: '', User: 'imsapp' })
  assert.equal(unparseable.ok, false)
  assert.match(unparseable.reason, /reported no LoadState/)

  // 4. no unit was named, so there is nothing to ask about. This is the closed ambient override:
  //    without --service-unit= there is no path back to the deleted variables.
  const unnamed = readUnitEnvironment([], { appDir: '/opt/one-two-inventory' })
  assert.equal(unnamed.ok, false)
  assert.match(unnamed.reason, /will NOT fall back to its own shell's/)

  // ...and the SHIPPED SCRIPT exits on it, with the code its callers read as "nothing was
  // revoked", so a deploy aborts cleanly rather than proceeding unfenced. `null` here points
  // --systemctl= at a path that does not exist.
  const refused = runFenceScript(['--preflight'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://imsapp@127.0.0.1:5432/ims',
  }, null)
  assert.equal(refused.status, EXIT_NOT_FENCEABLE, refused.output)
  assert.match(refused.output, /systemd could not be asked/)

  // And so does a run that names no unit at all, with a working systemctl.
  const unnamedRun = runFenceScript(['--preflight'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://imsapp@127.0.0.1:5432/ims',
  }, '', [])
  assert.equal(unnamedRun.status, EXIT_NOT_FENCEABLE, unnamedRun.output)
  assert.match(unnamedRun.output, /no --service-unit=<unit> was given/)
})

test('o3d-2sm1.5 r18: a file systemd will read is never PARSED here — a mention of the name is a refusal', () => {
  // THE TRAP THIS ROUND CLOSES. `systemctl show -p Environment` reports the Environment=
  // DIRECTIVES ONLY; systemd reads an EnvironmentFile when it FORKS the service and publishes
  // nothing about what it made of it. r17's answer was to parse the file with dotenv, whose
  // grammar is not systemd's: `PGUSER=ims#writer` is the role `ims` to dotenv and `ims#writer` to
  // systemd, and both are legal. So the file is not parsed at all — it is asked the one question
  // every grammar answers identically, and a mention is refused.
  //
  // MUTATION ROUTE: parse the file (with dotenv, or any grammar) and merge what it yields. The
  // first case below returns ok with PGUSER=ims, the fence revokes CONNECT from a role the
  // service does not use, and the assertion on `ok` fails.
  const directory = scratch()
  const withPg = join(directory, 'with-pg.env')
  writeFileSync(withPg, 'DATABASE_URL=postgresql://ims@localhost/ims\nPGUSER=ims#writer\n')
  const withoutPg = join(directory, 'plain.env')
  writeFileSync(withoutPg, 'DATABASE_URL=postgresql://ims@localhost/ims\nNODE_ENV=production\n')

  const readReal = (path: string) => readFileSync(path, 'utf8')
  const mentions = unitEnvironment(
    { LoadState: 'loaded', Environment: '', EnvironmentFiles: `${withPg} (ignore_errors=yes)`, WorkingDirectory: '', User: 'imsapp' },
    { readText: readReal },
  )
  assert.equal(mentions.ok, false)
  assert.match(mentions.reason, /that file mentions PGUSER/)
  assert.match(mentions.reason, /will not reimplement its parsing/)

  // A file that does not mention any of the four cannot set any of them under ANY grammar, so it
  // is not a disagreement and not a refusal.
  const clean = unitEnvironment(
    { LoadState: 'loaded', Environment: '', EnvironmentFiles: `${withoutPg} (ignore_errors=yes)`, WorkingDirectory: '', User: 'imsapp' },
    { readText: readReal },
  )
  assert.equal(clean.ok, true, clean.reason)
  assert.deepEqual(clean.values, {})
  assert.ok(clean.sources?.includes(`one-two-inventory.service:EnvironmentFile=${withoutPg}`))

  // AN UNREADABLE FILE IS NOT AN EMPTY ONE (Codex r17 CRITICAL). systemd will read it; this
  // cannot; "unreadable" is therefore not "sets none of them".
  const unreadable = unitEnvironment(
    { LoadState: 'loaded', Environment: '', EnvironmentFiles: `${join(directory, 'locked.env')} (ignore_errors=yes)`, WorkingDirectory: '', User: 'imsapp' },
    { readText: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } },
  )
  assert.equal(unreadable.ok, false)
  assert.match(unreadable.reason, /systemd will read and this run cannot/)

  // THE ONLY SKIP IS THE ONE SYSTEMD ITSELF MAKES: an `EnvironmentFile=-` whose file is absent.
  const absentOptional = unitEnvironment({
    LoadState: 'loaded',
    Environment: '',
    EnvironmentFiles: `${join(directory, 'gone.env')} (ignore_errors=yes)`,
    WorkingDirectory: '',
    User: 'imsapp',
  })
  assert.equal(absentOptional.ok, true, absentOptional.reason)

  // ...but a REQUIRED file that is absent is a unit that cannot start, and a refusal here.
  const absentRequired = unitEnvironment({
    LoadState: 'loaded',
    Environment: '',
    EnvironmentFiles: `${join(directory, 'gone.env')} (ignore_errors=no)`,
    WorkingDirectory: '',
    User: 'imsapp',
  })
  assert.equal(absentRequired.ok, false)
  assert.match(absentRequired.reason, /ENOENT/)

  // AND THE APPLICATION'S OWN OVERLAY, which systemd never sees: Next loads .env.local inside the
  // process, after exec, so no systemd property could ever report a PGHOST in it.
  const overlay = readUnitEnvironment(['one-two-inventory.service'], {
    show: () => ({ ok: true, reason: '', stdout: 'Environment=\nWorkingDirectory=\nUser=imsapp\nLoadState=loaded\n' }),
    appDir: directory,
    realpath: (path: string) => path,
    osAccount: 'imsapp',
    readText: (path: string) => (path === join(directory, '.env.local') ? 'PGHOST=elsewhere.example\n' : readReal(path)),
  })
  assert.equal(overlay.ok, false)
  assert.match(overlay.reason, /\.env\.local mentions PGHOST/)
  assert.match(overlay.reason, /the application loads that file itself/)
})

test('o3d-2sm1.5 r18: the unit must be THIS installation\'s, and two units may not disagree', () => {
  // ROUTE: readUnitEnvironment() -> systemd's WorkingDirectory= for the named unit, against the
  // directory this helper ships in. Being handed the wrong unit name is otherwise
  // indistinguishable from being handed the right one, and the answer would be another
  // installation's cluster — which is the wrong-environment failure in its purest form.
  //
  // MUTATION ROUTE: drop the WorkingDirectory comparison. The first case returns ok and hands the
  // fence the OTHER installation's PGPORT.
  const elsewhere = unitEnvironment({
    LoadState: 'loaded',
    Environment: 'PGPORT=6544',
    WorkingDirectory: '/opt/some-other-install',
    User: 'imsapp',
  })
  assert.equal(elsewhere.ok, false)
  assert.match(elsewhere.reason, /WorkingDirectory=\/opt\/some-other-install/)
  assert.match(elsewhere.reason, /serves a different installation/)

  // The control: the unit that DOES serve this app dir is accepted.
  const here = unitEnvironment({
    LoadState: 'loaded',
    Environment: 'PGPORT=6544',
    WorkingDirectory: '/opt/one-two-inventory',
    User: 'imsapp',
  })
  assert.equal(here.ok, true, here.reason)
  assert.deepEqual(here.values, { PGPORT: '6544' })

  // TWO UNITS SERVING ONE APP DIR — scripts/deploy.sh finds them by WorkingDirectory and both are
  // writers into this database. Which cluster the fence is meant to close has no answer when they
  // disagree, so it is refused rather than resolved to the first.
  //
  // MUTATION ROUTE: keep the first value and drop the disagreement check. This returns ok with
  // PGPORT=5432 while the second unit is writing to 6432 — a fence proved against a cluster
  // nobody chose.
  const answers: Record<string, string> = {
    'a.service': 'Environment=PGPORT=5432\nWorkingDirectory=\nUser=imsapp\nLoadState=loaded\n',
    'b.service': 'Environment=PGPORT=6432\nWorkingDirectory=\nUser=imsapp\nLoadState=loaded\n',
    'c.service': 'Environment=PGPORT=5432 PGHOST=db.example\nWorkingDirectory=\nUser=imsapp\nLoadState=loaded\n',
  }
  const twoUnits = (units: string[]) =>
    readUnitEnvironment(units, {
      show: (unit: string) => ({ ok: true, reason: '', stdout: answers[unit] }),
      readText: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      appDir: '/opt/one-two-inventory',
      realpath: (path: string) => path,
      osAccount: 'imsapp',
    })
  const clash = twoUnits(['a.service', 'b.service'])
  assert.equal(clash.ok, false)
  assert.match(clash.reason, /a\.service sets PGPORT="5432" and b\.service sets PGPORT="6432"/)

  // The control: units that AGREE are merged, and a variable only one of them sets is kept.
  const agreeing = twoUnits(['a.service', 'c.service'])
  assert.equal(agreeing.ok, true, agreeing.reason)
  assert.deepEqual(agreeing.values, { PGPORT: '5432', PGHOST: 'db.example' })
})

test('o3d-2sm1.5 r18: systemd\'s own output format is read, and anything ambiguous in it is refused', () => {
  // ROUTE: parseSystemdEnvironment() over `systemctl show -p Environment`'s serialized strv.
  // THIS IS A PARSER OF SYSTEMD'S OUTPUT, not of systemd's EnvironmentFile semantics — a bounded
  // grammar whose whole job is to be read back. What it cannot read unambiguously it throws on,
  // and main() turns that into the same refusal as "systemd could not be asked".
  //
  // MUTATION ROUTE: replace the body with `value.split(' ')`. The quoted case below loses
  // everything after the space in the value, so a PGDATABASE of `ims prod` silently becomes `ims`
  // and the fence closes a database nobody named; the assertion on it fails.
  assert.deepEqual(
    [...parseSystemdEnvironment('NODE_ENV=production PGPORT=5432')],
    [['NODE_ENV', 'production'], ['PGPORT', '5432']],
  )
  assert.deepEqual([...parseSystemdEnvironment('"PGDATABASE=ims prod"')], [['PGDATABASE', 'ims prod']])
  assert.deepEqual([...parseSystemdEnvironment('"PGUSER=ims\\"writer"')], [['PGUSER', 'ims"writer']])
  assert.deepEqual([...parseSystemdEnvironment('PGUSER=a\\tb')], [['PGUSER', 'a\tb']])
  assert.deepEqual([...parseSystemdEnvironment('PGUSER=a\\x41b')], [['PGUSER', 'aAb']])
  assert.deepEqual([...parseSystemdEnvironment('')], [])

  assert.throws(() => parseSystemdEnvironment('"PGUSER=unterminated'), /unterminated quote/)
  assert.throws(() => parseSystemdEnvironment('PGUSER=trailing\\'), /lone backslash/)
  assert.throws(() => parseSystemdEnvironment('PGUSER=bad\\q'), /escape this cannot read/)
  assert.throws(() => parseSystemdEnvironment('PGUSER=bad\\xZZ'), /malformed \\x escape/)
  assert.throws(() => parseSystemdEnvironment('NOT_AN_ASSIGNMENT'), /not NAME=VALUE/)

  // ...and an unreadable Environment= is a refusal, not an empty environment.
  const ambiguous = unitEnvironment({ LoadState: 'loaded', Environment: '"PGUSER=oops', WorkingDirectory: '', User: 'imsapp' })
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.reason, /unterminated quote/)
  assert.match(ambiguous.reason, /could not be parsed/)

  // EnvironmentFiles= is systemd's format too, and an entry this cannot even NAME is a file it
  // cannot rule out.
  assert.deepEqual(parseSystemdEnvironmentFiles('/a/.env (ignore_errors=yes)\n/b/.env (ignore_errors=no)'), [
    { path: '/a/.env', ignoreErrors: true },
    { path: '/b/.env', ignoreErrors: false },
  ])
  assert.deepEqual(parseSystemdEnvironmentFiles(undefined), [])
  assert.throws(() => parseSystemdEnvironmentFiles('/a/.env'), /EnvironmentFiles entry this cannot read/)

  // `systemctl show` prints an EMPTY property but OMITS one that does not apply — measured against
  // this host's real units. Both readings matter: the empty one is an answer, the absent one is not.
  const properties = parseSystemctlShow('Environment=\nWorkingDirectory=/opt/x\nLoadState=loaded\n')
  assert.equal(properties.get('Environment'), '')
  assert.equal(properties.has('EnvironmentFiles'), false)
  assert.equal(properties.get('WorkingDirectory'), '/opt/x')
})

test('o3d-2sm1.5 r18: the OS account is the application\'s when SYSTEMD says the unit runs as it', () => {
  // r16 subtracted EVERY OS-account fallback, on the grounds that this script runs as the deploy
  // account. In the supported installation it does not: deploy.sh, update.sh and install.sh all
  // run this helper through `runuser -u ${APP_USER}`, and the generated unit runs `User=${APP_USER}`.
  // r17 established that by OWNERSHIP of a file; r18 asks systemd, which states it outright.
  //
  // ROUTE: readUnitEnvironment() -> systemd's `User=` vs processOsAccount() -> runsAsServiceAccount
  // -> applyServiceEnvironment() writes PGUSER -> the driver resolves the login role as a SETTING
  // -> the OS_ACCOUNT_SENTINEL probe in resolveDriverIdentity() has nothing to catch.
  //
  // MUTATION ROUTE: drop the `runsAsServiceAccount && osAccount` arm from applyServiceEnvironment()
  // and the first assertion returns to '' — the r16 behaviour, i.e. the finding. Drop the
  // `runsAsServiceAccount` CONDITION instead and the second fails: the deploy account's identity
  // is then accepted as the application's, which is what the sentinel exists to stop.
  const restore = withEnv({ PGUSER: undefined, PGHOST: undefined, PGPORT: undefined, PGDATABASE: undefined })
  try {
    const account = processOsAccount()
    assert.notEqual(account, '', 'precondition: this process has an OS account both ways of asking agree on')
    assert.equal(driverConnection('postgresql://localhost/ims').user, account, 'precondition: the driver falls back to it')

    const runsAsIt = unitEnvironment({ LoadState: 'loaded', Environment: '', WorkingDirectory: '', User: account }, { osAccount: account })
    assert.equal(runsAsIt.runsAsServiceAccount, true, 'systemd says the unit runs as this process\'s account')
    applyServiceEnvironment(runsAsIt)
    assert.equal(
      parseConnectionIdentity('postgresql://localhost/ims').user,
      account,
      'the account systemd says the service runs as is the application\'s login role, not an anonymous fallback',
    )
    assert.equal(parseConnectionIdentity('postgresql://localhost/').database, account, 'and the database libpq derives from it is identified too')

    // A DIFFERENT ACCOUNT: a deploy running as root against a unit with `User=imsapp` gets the
    // r16 answer, because nothing here can show the two are the same identity.
    delete process.env.PGUSER
    const runsAsOther = unitEnvironment({ LoadState: 'loaded', Environment: '', WorkingDirectory: '', User: 'someone-else' }, { osAccount: account })
    assert.equal(runsAsOther.runsAsServiceAccount, false)
    applyServiceEnvironment(runsAsOther)
    assert.equal(process.env.PGUSER, undefined, 'nothing is asserted about an account this run cannot show is the application\'s')
    assert.equal(parseConnectionIdentity('postgresql://localhost/ims').user, '', 'so the fallback stays unidentified, and unidentified is refused')

    // A UNIT THAT NAMES THE ROLE OUTRIGHT WINS OVER BOTH: it is a deliberate setting.
    delete process.env.PGUSER
    applyServiceEnvironment(unitEnvironment({ LoadState: 'loaded', Environment: 'PGUSER=imsapp', WorkingDirectory: '', User: account }, { osAccount: account }))
    assert.equal(parseConnectionIdentity('postgresql://localhost/ims').user, 'imsapp')
  } finally {
    restore()
  }
})

test('processOsAccount refuses an account the passwd entry and the environment disagree about', () => {
  // pg's fallback is `process.env.USER`, which is inheritable and can be stale or set by hand;
  // `userInfo()` reads the passwd entry for the effective uid, which cannot. Only an agreement
  // is an identity.
  //
  // MUTATION ROUTE: return the passwd name (or the driver default) unconditionally. The second
  // assertion fails, and with it the account test above starts vouching for whatever name the
  // calling shell put in USER.
  assert.equal(processOsAccount({ userInfo: () => ({ username: 'imsapp' }), driverDefaultUser: 'imsapp' }), 'imsapp')
  assert.equal(processOsAccount({ userInfo: () => ({ username: 'imsapp' }), driverDefaultUser: 'root' }), '')
  assert.equal(processOsAccount({ userInfo: () => ({ username: 'imsapp' }), driverDefaultUser: '' }), '')
})

test('o3d-2sm1.5 r18: the shipped script runs on the environment SYSTEMD reports, end to end', () => {
  // THE WHOLE PROCESS, not a function: `--print-migration-url` derives the role the migration runs
  // as from DATABASE_URL, and a URL naming no role falls through to PGUSER. So the ambient
  // environment and systemd's answer are made to disagree about PGUSER, and the emitted URL says
  // which one won.
  //
  // ROUTE: node scripts/fence-db-connections.mjs --print-migration-url --service-unit=... ->
  // main()'s readUnitEnvironment/applyServiceEnvironment -> parseRoleFromConnectionString(DATABASE_URL)
  // -> buildMigrationConnectionString() -> `options=-c role=...` on stdout.
  //
  // MUTATION ROUTE: remove the applyServiceEnvironment() call from main(). The emitted URL becomes
  // `-c role=deployrole` — this shell's variable deciding what the migration runs as, on a box
  // where the service has never heard of that role.
  const result = runFenceScript(['--print-migration-url'], {
    DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
    DATABASE_URL: 'postgresql://127.0.0.1:5432/ims',
    PGUSER: 'deployrole',
    DIRECT_URL: '',
  }, 'PGUSER=imsapp')
  assert.equal(result.status, 0, result.output)
  const emitted = result.stdout.trim().split('\n').at(-1) ?? ''
  assert.match(emitted, /^postgresql:\/\//, 'the last line is the URL the deploy captures')
  assert.match(emitted, /options=-c\+role%3Dimsapp|options=-c%20role%3Dimsapp/, 'the migration runs as the role SYSTEMD names')
  assert.doesNotMatch(emitted, /deployrole/, 'and this shell\'s PGUSER reaches nothing the migration runs through')
  assert.match(result.stderr, /Ignoring this shell's PGUSER=deployrole/, 'and it says so out loud, on stderr')
  assert.doesNotMatch(result.stdout, /Ignoring/, 'stdout carries the URL and nothing else: the deploy captures it with $(...)')
})

test('o3d-2sm1.5 r18: everything the script reads is resolved from the SCRIPT, not the working directory', () => {
  // The `--release` command the callers print is a bare absolute `node /opt/.../fence-db-connections.mjs`
  // meant to be runnable by an operator from wherever they are standing, and the deploy scripts
  // `cd` to the app directory for reasons of their own. main() loaded `.env.local` and `.env`
  // RELATIVE, so from any other directory that command loaded no DATABASE_URL, no DIRECT_URL and
  // no DEPLOY_ADMIN_DATABASE_URL — the one command offered for taking a committed fence down could
  // not obtain the connection that takes it down (Codex r17 HIGH).
  //
  // MUTATION ROUTE: put the relative paths back in main(). The end-to-end case below runs from a
  // temporary directory with a DECOY .env in it and no DATABASE_URL in its own environment; with
  // relative loading it reads the decoy and emits the decoy's role, and the assertions fail.
  assert.equal(appDirectory('file:///opt/one-two-inventory/scripts/fence-db-connections.mjs'), '/opt/one-two-inventory')
  assert.deepEqual(applicationDotenvPaths('/opt/one-two-inventory'), [
    '/opt/one-two-inventory/.env.local',
    '/opt/one-two-inventory/.env.production.local',
    '/opt/one-two-inventory/.env.production',
    '/opt/one-two-inventory/.env',
  ])
  assert.deepEqual(IDENTITY_ENVIRONMENT_VARIABLES, ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE'])
  assert.deepEqual(UNIT_PROPERTIES, ['LoadState', 'Environment', 'EnvironmentFiles', 'WorkingDirectory', 'User', 'FragmentPath'])

  // systemctl is found at an absolute path rather than through the inherited PATH, so the shell
  // that ran this cannot decide what answers for systemd.
  assert.ok(SYSTEMCTL_PATHS.every((path) => path.startsWith('/')), 'every candidate is absolute')
  assert.equal(findSystemctl(['/nonexistent/systemctl'], { exists: () => false }), '')
  assert.equal(findSystemctl(['/a/systemctl', '/b/systemctl'], { exists: (path: string) => path === '/b/systemctl' }), '/b/systemctl')

  // AND END TO END, from a directory that is not the app dir and holds a DECOY .env.
  const elsewhere = mkdtempSync(join(tmpdir(), 'ims-fence-cwd-'))
  writeFileSync(join(elsewhere, '.env'), 'DATABASE_URL=postgresql://decoyrole@127.0.0.1:5432/decoy\n')
  const systemctl = stubSystemctl(elsewhere, { Environment: '' })
  const run = spawnSync(
    'node',
    [
      join(process.cwd(), 'scripts/fence-db-connections.mjs'),
      '--print-migration-url',
      '--service-unit=one-two-inventory.service',
      `--systemctl=${systemctl}`,
    ],
    {
      encoding: 'utf8',
      cwd: elsewhere,
      env: {
        ...process.env,
        DATABASE_URL: undefined,
        DIRECT_URL: undefined,
        DEPLOY_ADMIN_DATABASE_URL: 'postgresql://deployadmin@127.0.0.1:5432/ims',
        PGUSER: undefined,
        PGHOST: undefined,
        PGPORT: undefined,
        PGDATABASE: undefined,
      } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  assert.doesNotMatch(output, /decoyrole|decoy/, 'the .env sitting in the working directory is not read')

  // The DATABASE_URL it did find is the app dir's own — which is what makes the printed release
  // command work from an unrelated directory. Its role is whatever this checkout's .env names, so
  // the assertion is that a role was found at all rather than that it is a particular one.
  const repoRole = parseRoleFromConnectionString(
    (readFileSync(join(process.cwd(), '.env'), 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1] ?? '').replace(/^["']|["']$/g, ''),
  )
  if (repoRole) {
    assert.equal(run.status, 0, output)
    assert.match(output, new RegExp(`role%3D${repoRole}`), 'the role comes from the APP DIR\'s .env, from any working directory')
  } else {
    assert.notEqual(run.status, 0, 'no DATABASE_URL anywhere means a refusal, not a silent read of the local decoy')
  }
})

test('o3d-2sm1.5 r18: every entrypoint names the unit it already addresses the service by', () => {
  // ROUTE: scripts/{deploy,update,install}.sh -> `--service-unit=` on every fence invocation ->
  // parseArgs().serviceUnits -> readUnitEnvironment(). The unit name is NOT hardcoded in the
  // helper and NOT read from its environment; each script passes the name it already stops,
  // drains and restarts the service by.
  //
  // MUTATION ROUTE: drop `"${DB_FENCE_UNIT_ARG}"` from any one invocation in update.sh or
  // install.sh, or `"${DB_FENCE_UNIT_ARGS[@]:-}"` from any in deploy.sh. That invocation refuses
  // at run time with "no --service-unit=<unit> was given", and the count assertion here fails by
  // name before it ever gets that far.
  const scripts = Object.fromEntries(
    ['deploy.sh', 'update.sh', 'install.sh'].map((name) => [name, readFileSync(join(process.cwd(), 'scripts', name), 'utf8')]),
  )

  // deploy.sh finds its units by WorkingDirectory (or IMS_SERVICE_UNIT) and may find more than one.
  assert.match(scripts['deploy.sh'], /DB_FENCE_UNIT_ARGS\+=\("--service-unit=\$\{unit\}"\)/)
  // update.sh and install.sh each address exactly one unit, and each takes the name from the
  // variable it already uses for `systemctl stop`.
  assert.match(scripts['update.sh'], /DB_FENCE_UNIT_ARG="--service-unit=\$\{SERVICE_UNIT\}"/)
  assert.match(scripts['install.sh'], /DB_FENCE_UNIT_ARG="--service-unit=\$\{APP_NAME\}\.service"/)

  // EVERY invocation carries it — this is the sweep, so a mode added later cannot quietly omit it.
  for (const [name, source] of Object.entries(scripts)) {
    const invocations = source.match(/node "\$\{?DB_FENCE_SCRIPT\}?" --\S+/g) ?? []
    assert.ok(invocations.length >= 4, `${name}: expected every fence mode to be invoked, found ${invocations.length}`)
    const lines = source.split('\n').filter((line) => /node "\$\{?DB_FENCE_SCRIPT\}?" --/.test(line))
    for (const line of lines) {
      assert.match(line, /DB_FENCE_UNIT_ARGS?\[?/, `${name}: this invocation names no unit: ${line.trim()}`)
    }
  }

  // AND THE PRINTED RELEASE COMMAND CARRIES IT TOO, or the operator's copy of it refuses.
  assert.match(scripts['update.sh'], /DB_FENCE_RELEASE_CMD="node \$\{DB_FENCE_SCRIPT\} --release --state-file=\$\{DB_FENCE_STATE\} \$\{DB_FENCE_UNIT_ARG\}"/)
  assert.match(scripts['install.sh'], /DB_FENCE_RELEASE_CMD="node \$\{DB_FENCE_SCRIPT\} --release --state-file=\$\{DB_FENCE_STATE\} \$\{DB_FENCE_UNIT_ARG\}"/)
  assert.match(scripts['deploy.sh'], /db_fence_release_cmd\(\)/)

  // parseArgs takes the flag more than once, because deploy.sh may pass more than one unit.
  assert.deepEqual(parseArgs(['--fence', '--service-unit=a.service', '--service-unit=b.service']).serviceUnits, ['a.service', 'b.service'])
  assert.deepEqual(parseArgs(['--fence']).serviceUnits, [])
  assert.equal(parseArgs(['--release', '--systemctl=/x/systemctl']).systemctlPath, '/x/systemctl')
})

test('o3d-2sm1.5 r18: a mention is decided on the NAME alone, under every grammar', () => {
  // The one question dotenv, systemd, sh and a hand-written parser all answer the same way. It is
  // deliberately BROADER than "assigns it": over-reporting costs a refusal with an instruction,
  // under-reporting costs a fence on the wrong cluster.
  //
  // MUTATION ROUTE: narrow it to /^\s*PGUSER=/m (i.e. "assigns it"). The commented and prefixed
  // cases below stop being reported, and with them every spelling of an assignment whose grammar
  // this module has decided not to reproduce.
  assert.equal(mentionedIdentityVariable('DATABASE_URL=postgres://x\nNODE_ENV=production\n'), '')
  assert.equal(mentionedIdentityVariable('PGUSER=ims#writer\n'), 'PGUSER')
  assert.equal(mentionedIdentityVariable('# PGUSER is deliberately unset\n'), 'PGUSER')
  assert.equal(mentionedIdentityVariable('MY_PGHOST=x\n'), 'PGHOST')
  assert.equal(mentionedIdentityVariable('PGPORT=5432\nPGHOST=a\n'), 'PGHOST', 'the first in IDENTITY_ENVIRONMENT_VARIABLES order')
})
