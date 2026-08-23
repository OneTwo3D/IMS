#!/usr/bin/env node
// =============================================================================
// Fence the database against the application for the length of a migration.
// =============================================================================
// scripts/check-db-writers.mjs answers "is anything connected RIGHT NOW". That is a
// snapshot, and a snapshot is not a fence: it closes its connection, and the dump and
// the migration open theirs afterwards. Nothing in between stops a cron tick that the
// crontab fence missed, an operator's `psql`, or a `next dev` in a sibling worktree
// from connecting in the gap and writing across the migration.
//
// This script is the continuous part. It REVOKEs CONNECT on the database from the
// application role (and from PUBLIC, because the default database ACL grants CONNECT
// to PUBLIC and revoking from the role alone would change nothing), then terminates
// what is already attached, and leaves the revocation standing until `--release`.
//
//   --fence    revoke CONNECT, drain the existing backends, prove it is quiet
//   --release  restore EXACTLY the grants that were revoked, and verify they are back
//
// WHAT THIS CANNOT DO, said here rather than implied away:
//
//   * It cannot fence a role that is a SUPERUSER. Superusers bypass ACL checks, so a
//     revoke is decoration. It also cannot fence when the deploy has no connection of
//     its own that survives the revoke — revoking CONNECT from the role the migration
//     itself uses would lock the migration out, and no ACL can tell "the migration"
//     apart from "the application" when both log in as one role. Both cases exit 3
//     (NOT FENCED), and the caller is expected to say so OUT LOUD and fall back to the
//     snapshot probe rather than proceed believing it is fenced.
//
//     A real fence therefore needs DEPLOY_ADMIN_DATABASE_URL: a connection as a
//     SEPARATE role that is a superuser or the database owner. While the fence is up
//     that connection is the one the migration itself runs through — which means the
//     objects a migration creates are owned by THAT role. Point it at the role that
//     owns the schema today, or the migration will create tables the application
//     cannot read. docs/installation.md says the same thing next to the variable.
//
//   * It cannot revoke a grant that arrives through ROLE MEMBERSHIP. A REVOKE names a grantee, and
//     `imsapp` may hold CONNECT because it is a member of some other role that holds it — revoking
//     from `imsapp` and from PUBLIC then changes nothing an application would notice. Examining the
//     ACL entries this script itself just removed cannot see that, so after the revokes it ASKS THE
//     DATABASE: `has_database_privilege(appRole, current_database(), 'CONNECT')` must be false. If
//     it is still true the fence did NOT take and this exits 1 with the granting roles named. It
//     does not go on to revoke from those roles — they are shared with other principals and a deploy
//     has no business rewriting them — so the operator's fix is to make the application role's
//     CONNECT a direct grant, or to run the cutover with the writers stopped and no fence at all.
//     This is the same lesson as revoking from PUBLIC: ask the database what is true rather than
//     reasoning about what you changed.
//
//   * It cannot survive a power cut mid-window in the sense of undoing itself. If the
//     box dies while fenced, CONNECT stays revoked and the application cannot start
//     until `--release` runs. That is the intended failure direction — down, not
//     writing across a half-migrated schema — but it is why the state file records the
//     exact SQL to undo it by hand, and why the deploy scripts print that SQL on every
//     failure path.
//
// THE STATE FILE is written BEFORE anything is revoked, and it records what each
// grantee held beforehand so that `--release` restores that and not "everything".
// `--fence` on an existing state file re-applies the revoke and re-drains but keeps
// the ORIGINAL recorded state, so a re-run after a failure restores the truth rather
// than the fenced snapshot.
// =============================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_NOT_FENCEABLE = 3

export const PUBLIC_GRANTEE = 'PUBLIC'

/** SQL identifier quoting. Role and database names reach these statements as text. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** The role a connection string logs in as, or '' when it does not carry one. */
export function parseRoleFromConnectionString(connectionString) {
  if (!connectionString) return ''
  try {
    const url = new URL(connectionString)
    return url.username ? decodeURIComponent(url.username) : ''
  } catch {
    return ''
  }
}

/**
 * Pure: split a `pg_database.datacl` text value into { grantee, privileges } entries.
 * An empty grantee is PUBLIC. Commas inside a quoted role name are not separators.
 */
export function parseAclEntries(datacl) {
  const text = String(datacl ?? '').trim().replace(/^\{/, '').replace(/\}$/, '')
  if (!text) return []

  const entries = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === ',' && !quoted) {
      entries.push(current)
      current = ''
      continue
    }
    current += character
  }
  entries.push(current)

  return entries
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const slash = entry.lastIndexOf('/')
      const body = slash === -1 ? entry : entry.slice(0, slash)
      const equals = body.indexOf('=')
      return {
        grantee: equals === -1 ? body : body.slice(0, equals),
        privileges: equals === -1 ? '' : body.slice(equals + 1),
      }
    })
}

/**
 * Pure: did `grantee` hold CONNECT before we touched anything?
 *
 * A NULL datacl is not "no privileges" — it is "the defaults", which grant CONNECT to
 * PUBLIC and everything to the owner. Reading NULL as empty is how a restore ends up
 * granting nothing back.
 */
export function granteeHasConnect(datacl, ownerRole, grantee) {
  const isPublic = grantee === PUBLIC_GRANTEE
  if (datacl === null || datacl === undefined || String(datacl).trim() === '') {
    return isPublic || grantee === ownerRole
  }
  return parseAclEntries(datacl).some((entry) => {
    const matches = isPublic ? entry.grantee === '' : entry.grantee === grantee
    return matches && entry.privileges.includes('c')
  })
}

/**
 * Pure: can this deploy actually fence the application out, and of whom?
 *
 * Returns the grantees to revoke CONNECT from, or a refusal with the reason to print.
 * The refusal cases are the ones where a revoke would either do nothing (a superuser
 * application role bypasses the ACL) or lock the deploy itself out (the migration
 * connects as the very role being fenced, with no privileged connection of its own).
 */
export function planConnectionFence(facts) {
  const {
    appRole,
    appRoleIsSuperuser,
    adminRole,
    adminIsSuperuser,
    adminIsOwner,
    publicHasConnect,
    appRoleHasConnect,
    appRoleHasEffectiveConnect,
  } = facts

  if (!appRole) {
    return { fenceable: false, reason: 'DATABASE_URL carries no role name, so there is nothing to revoke CONNECT from.', revoke: [] }
  }
  if (appRoleIsSuperuser) {
    return {
      fenceable: false,
      reason: `the application role ${appRole} is a SUPERUSER, and superusers bypass database ACLs — revoking CONNECT from it would fence nothing.`,
      revoke: [],
    }
  }
  if (!adminIsSuperuser && !adminIsOwner) {
    return {
      fenceable: false,
      reason: `the deploy connects as ${adminRole}, which is neither a superuser nor the database owner, so it cannot revoke CONNECT (and would not survive the revoke).`,
      revoke: [],
    }
  }
  if (adminRole === appRole) {
    return {
      fenceable: false,
      reason: `the deploy connects as the application role ${appRole} itself; revoking CONNECT from it would lock the migration out. Set DEPLOY_ADMIN_DATABASE_URL to a separate superuser or owner connection.`,
      revoke: [],
    }
  }

  const revoke = []
  if (publicHasConnect) revoke.push(PUBLIC_GRANTEE)
  if (appRoleHasConnect) revoke.push(appRole)

  if (revoke.length === 0) {
    // Asked of the database, not of the ACL: a role can hold CONNECT with no ACL entry of its own.
    // The two answers are different refusals and must not be collapsed — one is a database already
    // closed, the other is one this script cannot close.
    if (appRoleHasEffectiveConnect) {
      return {
        fenceable: false,
        reason: `neither PUBLIC nor ${appRole} holds CONNECT DIRECTLY, yet ${appRole} can still connect — the grant reaches it through role membership, which a deploy must not revoke because those roles are shared. Make the application role's CONNECT a direct grant to make this fenceable.`,
        revoke: [],
      }
    }
    return {
      fenceable: false,
      reason: `neither PUBLIC nor ${appRole} holds CONNECT on this database already — nothing to revoke, and nothing this script can add.`,
      revoke: [],
    }
  }

  return { fenceable: true, reason: '', revoke }
}

/**
 * Pure: did the revokes actually shut the application out?
 *
 * `stillConnects` is `has_database_privilege(appRole, current_database(), 'CONNECT')` read AFTER the
 * revokes committed. It accounts for membership, for PUBLIC and for superuser status, which is
 * exactly what an ACL diff cannot. A fence that reports armed while the application can still
 * connect is worse than none, because the whole deploy proceeds believing the door is shut.
 *
 * @param {{ appRole: string, stillConnects: boolean, grantingRoles?: string[] }} facts
 * @returns {{ fenced: boolean, reason: string }}
 */
export function assessEffectiveFence({ appRole, stillConnects, grantingRoles = [] }) {
  if (!stillConnects) return { fenced: true, reason: '' }
  const via = grantingRoles.length > 0
    ? ` The grant reaches it through: ${grantingRoles.join(', ')}.`
    : ' No role membership was identified, so the grant is held some other way (a superuser bit, or a grant made between the read and now).'
  return {
    fenced: false,
    reason: `THE FENCE DID NOT TAKE. CONNECT was revoked from every grantee that held it directly, and ${appRole} can STILL connect to this database.${via} A deploy must not revoke from a shared role, so this cannot be fixed from here.`,
  }
}

/** Pure: the exact statements a fence applies, and the ones that undo it. */
export function buildRevokeStatements(database, grantees) {
  return grantees.map((grantee) => `REVOKE CONNECT ON DATABASE ${quoteIdent(database)} FROM ${grantee === PUBLIC_GRANTEE ? 'PUBLIC' : quoteIdent(grantee)};`)
}

export function buildGrantStatements(database, grantees) {
  return grantees.map((grantee) => `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${grantee === PUBLIC_GRANTEE ? 'PUBLIC' : quoteIdent(grantee)};`)
}

/** Pure: the fence is released only when every grantee it revoked holds CONNECT again. */
export function verifyRelease(datacl, ownerRole, grantees) {
  const missing = grantees.filter((grantee) => !granteeHasConnect(datacl, ownerRole, grantee))
  return { released: missing.length === 0, missing }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { mode: '', stateFile: '', appRole: '', timeoutSeconds: 30 }
  for (const arg of argv) {
    if (arg === '--fence' || arg === '--release') options.mode = arg.slice(2)
    else if (arg.startsWith('--state-file=')) options.stateFile = arg.slice('--state-file='.length)
    else if (arg.startsWith('--app-role=')) options.appRole = arg.slice('--app-role='.length)
    else if (arg.startsWith('--timeout-seconds=')) options.timeoutSeconds = Number(arg.slice('--timeout-seconds='.length))
  }
  return options
}

function readState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

function writeState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function readFacts(client, appRole) {
  const { rows } = await client.query(
    `SELECT current_database()                                  AS database,
            current_user                                        AS admin_role,
            pg_catalog.pg_get_userbyid(d.datdba)                AS owner_role,
            d.datacl::text                                      AS datacl,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS admin_is_superuser,
            (SELECT rolsuper FROM pg_roles WHERE rolname = $1)   AS app_role_is_superuser,
            (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS app_role_exists
       FROM pg_database d
      WHERE d.datname = current_database()`,
    [appRole],
  )
  return rows[0]
}

/**
 * The only question that matters: can the application role connect RIGHT NOW? Postgres answers it
 * accounting for direct grants, PUBLIC, role membership and the superuser bit all at once, which is
 * why this is asked of the database instead of inferred from the ACL entries we removed.
 */
async function readEffectiveConnect(client, appRole) {
  if (!appRole) return { stillConnects: false, grantingRoles: [] }
  const { rows } = await client.query(
    `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS still_connects`,
    [appRole],
  )
  const stillConnects = rows[0]?.still_connects === true
  if (!stillConnects) return { stillConnects: false, grantingRoles: [] }

  // Name the culprits so the operator has somewhere to go. A role the application is a member of
  // that holds CONNECT in its own right is the usual answer.
  const { rows: sources } = await client.query(
    `SELECT r.rolname
       FROM pg_roles r
      WHERE r.rolname <> $1
        AND pg_has_role($1, r.oid, 'USAGE')
        AND has_database_privilege(r.rolname, current_database(), 'CONNECT')
      ORDER BY r.rolname`,
    [appRole],
  )
  return { stillConnects: true, grantingRoles: sources.map((row) => row.rolname) }
}

async function otherClientBackends(client) {
  const { rows } = await client.query(
    `SELECT pid, COALESCE(application_name, '') AS application_name, COALESCE(usename, '') AS usename
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`,
  )
  return rows
}

async function doFence(client, options) {
  // The fence is only ever established through an EXPLICIT admin URL. Falling back to
  // DIRECT_URL here would let a fence engage while the caller has no idea which
  // connection survived it — and the caller has to run the migration through exactly
  // that connection.
  if (!process.env.DEPLOY_ADMIN_DATABASE_URL) {
    console.error('NOT FENCED: DEPLOY_ADMIN_DATABASE_URL is not set, so this deploy has no privileged')
    console.error('connection that would survive revoking CONNECT from the application role.')
    console.error('The deploy may continue, but the database is NOT held closed for the migration')
    console.error('window: a client that connects between now and the end of the migration is not stopped.')
    return EXIT_NOT_FENCEABLE
  }

  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const facts = await readFacts(client, appRole)

  if (appRole && !facts.app_role_exists) {
    console.error(`NOT FENCED: the role ${appRole} from DATABASE_URL does not exist on this server.`)
    return EXIT_NOT_FENCEABLE
  }

  const existing = options.stateFile ? readState(options.stateFile) : null

  const plan = existing
    ? { fenceable: true, reason: '', revoke: existing.revoked }
    : planConnectionFence({
        appRole,
        appRoleIsSuperuser: facts.app_role_is_superuser === true,
        adminRole: facts.admin_role,
        adminIsSuperuser: facts.admin_is_superuser === true,
        adminIsOwner: facts.admin_role === facts.owner_role,
        publicHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, PUBLIC_GRANTEE),
        appRoleHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, appRole),
        appRoleHasEffectiveConnect: (await readEffectiveConnect(client, appRole)).stillConnects,
      })

  if (!plan.fenceable) {
    console.error(`NOT FENCED: ${plan.reason}`)
    console.error('The deploy may continue, but the database is NOT held closed for the migration window:')
    console.error('a client that connects between now and the end of the migration will not be stopped.')
    return EXIT_NOT_FENCEABLE
  }

  const revokes = buildRevokeStatements(facts.database, plan.revoke)
  const grants = buildGrantStatements(facts.database, plan.revoke)

  if (options.stateFile && !existing) {
    // Written BEFORE the revoke: a crash between the two must leave a record of what
    // to restore, not a fence nobody can undo.
    writeState(options.stateFile, {
      database: facts.database,
      owner_role: facts.owner_role,
      app_role: appRole,
      admin_role: facts.admin_role,
      revoked: plan.revoke,
      datacl_before: facts.datacl ?? null,
      fenced_at: new Date().toISOString(),
      undo_sql: grants,
    })
  } else if (existing) {
    console.log(`Re-applying the fence recorded at ${existing.fenced_at} (grantees: ${existing.revoked.join(', ')}).`)
  }

  await client.query('BEGIN')
  try {
    for (const statement of revokes) await client.query(statement)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
  for (const statement of revokes) console.log(`  ${statement}`)

  // ASK THE DATABASE WHETHER THE DOOR IS SHUT. Everything above reasons about ACL entries, and an
  // ACL entry is not the whole answer: CONNECT can reach the application role through membership of
  // another role, in which case both revokes ran, both succeeded, and the application can still
  // connect. Reporting "fenced" there is the worst outcome available — the migration then runs
  // believing nothing else can attach. Draining is deliberately NOT attempted before this check:
  // terminating backends we cannot keep out is disruption without a fence.
  const effective = await readEffectiveConnect(client, appRole)
  const assessment = assessEffectiveFence({
    appRole,
    stillConnects: effective.stillConnects,
    grantingRoles: effective.grantingRoles,
  })
  if (!assessment.fenced) {
    console.error(assessment.reason)
    console.error('The fence is left standing so nothing is half-applied; undo it with --release before starting the application:')
    for (const statement of grants) console.error(`  ${statement}`)
    return EXIT_ERROR
  }
  console.log(`Verified: has_database_privilege('${appRole}', current_database(), 'CONNECT') is false.`)

  // Revoking CONNECT stops NEW connections; the ones already open keep writing.
  const deadline = Date.now() + Math.max(1, options.timeoutSeconds) * 1000
  let remaining = await otherClientBackends(client)
  if (remaining.length > 0) {
    console.log(`Draining ${remaining.length} connection(s) already attached...`)
    try {
      await client.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'`,
      )
    } catch (error) {
      console.error(`Could not terminate the attached backends: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    remaining = await otherClientBackends(client)
  }

  if (remaining.length > 0) {
    console.error(`Fence applied, but ${remaining.length} client backend(s) are still attached:`)
    for (const row of remaining) {
      console.error(`  - pid ${row.pid} user=${row.usename} app=${row.application_name || '(unnamed)'}`)
    }
    console.error('Refusing to call the database drained. The fence is left in place; release it with --release.')
    return EXIT_ERROR
  }

  console.log(`Database ${facts.database} is fenced: CONNECT revoked from ${plan.revoke.join(', ')}, no other client backends attached.`)
  return EXIT_OK
}

async function doRelease(client, options) {
  const state = options.stateFile ? readState(options.stateFile) : null
  if (!state) {
    console.log('No connection fence is recorded; nothing to release.')
    return EXIT_OK
  }

  const grants = buildGrantStatements(state.database, state.revoked)
  for (const statement of grants) {
    await client.query(statement)
    console.log(`  ${statement}`)
  }

  const { rows } = await client.query(
    `SELECT d.datacl::text AS datacl, pg_catalog.pg_get_userbyid(d.datdba) AS owner_role
       FROM pg_database d WHERE d.datname = $1`,
    [state.database],
  )
  const check = verifyRelease(rows[0]?.datacl, rows[0]?.owner_role, state.revoked)
  if (!check.released) {
    console.error(`Release did NOT take: ${check.missing.join(', ')} still lack CONNECT on ${state.database}.`)
    console.error('Run this by hand as a superuser before starting the application:')
    for (const statement of grants) console.error(`  ${statement}`)
    return EXIT_ERROR
  }

  rmSync(options.stateFile, { force: true })
  console.log(`Connection fence released: CONNECT restored to ${state.revoked.join(', ')} on ${state.database}.`)
  return EXIT_OK
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const options = parseArgs(process.argv.slice(2))
  if (options.mode !== 'fence' && options.mode !== 'release') {
    console.error('Usage: node scripts/fence-db-connections.mjs (--fence|--release) [--state-file=PATH] [--app-role=ROLE] [--timeout-seconds=N]')
    process.exit(EXIT_ERROR)
  }

  const connectionString =
    process.env.DEPLOY_ADMIN_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('Neither DEPLOY_ADMIN_DATABASE_URL nor DATABASE_URL is set — cannot fence or release anything.')
    process.exit(EXIT_ERROR)
  }

  const client = new pg.Client({ connectionString, application_name: 'ims-deploy-fence' })
  await client.connect()
  try {
    process.exitCode = options.mode === 'fence' ? await doFence(client, options) : await doRelease(client, options)
  } finally {
    await client.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Connection fence failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(EXIT_ERROR)
  })
}
