import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
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
    'a URL with no database in its path identifies no database',
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
