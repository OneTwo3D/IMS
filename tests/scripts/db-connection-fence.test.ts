import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  PUBLIC_GRANTEE,
  assessEffectiveFence,
  assessMigrationRole,
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

/** Run the shipped script from a directory with no .env, and report what it said. */
function runFenceScript(args: string[], env: Record<string, string | undefined>) {
  try {
    const stdout = execFileSync('node', [join(process.cwd(), 'scripts/fence-db-connections.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd: mkdtempSync(join(tmpdir(), 'ims-fence-')),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
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
  assert.match(doFence, /return EXIT_ERROR/)
})
