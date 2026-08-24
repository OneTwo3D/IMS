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
// This script is the continuous part. It REVOKEs CONNECT on the database from EVERY
// grantee that holds it directly — the application role, PUBLIC (the default database ACL
// grants CONNECT to PUBLIC, so revoking from the role alone would change nothing), and any
// other role with a direct grant — then terminates what is already attached, and leaves the
// revocation standing until `--release`.
//
// EVERY GRANTEE, NOT TWO OF THEM (o3d-2sm1.5, Codex r4 HIGH). It used to revoke from PUBLIC
// and the application role and call the database held closed. A third role with a direct
// CONNECT grant — monitoring, BI, a backup job, a second application — was terminated by the
// drain and RECONNECTED IMMEDIATELY, for the whole length of the migration, while every
// header and every doc said the database was fenced. The revoke is now derived from the ACL
// itself: whatever holds CONNECT loses it, except the admin role this deploy is connected as
// (revoking from that would lock the deploy out of its own recovery). Each one is recorded,
// and `--release` restores exactly those.
//
//   --preflight            can this database be fenced AT ALL, asked while the predecessor
//                          is still up and a refusal costs nothing. Revokes nothing,
//                          terminates nothing, writes no state file. It exists because the
//                          callers' preflight used to check only that this FILE EXISTS —
//                          so a missing module (dotenv was a devDependency, and the
//                          documented manual upgrade runs `npm ci --omit=dev`) was
//                          discovered at drain-verify, AFTER the stop: an outage for a
//                          missing import. This mode runs the same imports, opens the same
//                          connection and asks the same questions.
//   --fence                revoke CONNECT, drain the existing backends, prove it is quiet
//   --release              restore EXACTLY the grants that were revoked, and verify they are back
//   --print-migration-url  the admin URL with `options=-c role=<app role>` merged in — the
//                          connection the migration must run through. See "WHO THE
//                          MIGRATION RUNS AS" below. No database connection is opened.
//
// WHAT THIS CANNOT DO, said here rather than implied away:
//
//   * It cannot fence a role that is a SUPERUSER. Superusers bypass ACL checks, so a
//     revoke is decoration. It also cannot fence when the deploy has no connection of
//     its own that survives the revoke — revoking CONNECT from the role the migration
//     itself uses would lock the migration out, and no ACL can tell "the migration"
//     apart from "the application" when both log in as one role. Both cases exit 3
//     (NOT FENCED), and the caller is expected to say so OUT LOUD and abort.
//
//     A real fence therefore needs DEPLOY_ADMIN_DATABASE_URL: a connection as a
//     SEPARATE role that is a superuser or the database owner.
//
//   * WHO THE MIGRATION RUNS AS, WHICH IS NOT WHO IT CONNECTS AS (o3d-2sm1.5, Codex r4
//     CRITICAL). The connection that survives the fence is the ADMIN one, so for a while
//     this script told the operator to "point it at the role that owns the schema today"
//     — advice that is impossible to follow. scripts/install.sh makes the APPLICATION
//     role the database owner, and planConnectionFence() REFUSES outright when the admin
//     role IS the application role. The only fenceable configuration is therefore a
//     separate SUPERUSER admin, and every CREATE TABLE / INDEX / SEQUENCE a migration made
//     through it was owned by that superuser with no grant to the application role. The
//     drift check, the verification hook and pg_dump all ran on the same admin connection,
//     so nothing in the pipeline could see it: the deploy reported success and every
//     request touching the new table failed with `permission denied`.
//
//     So the migration CONNECTS as the admin and RUNS AS the application role:
//     buildMigrationConnectionString() adds `options=-c role=<app role>` to the admin URL,
//     which Postgres applies at connection start. Authentication — and therefore the
//     CONNECT check the fence revokes — happens as the admin, so the fence still holds;
//     everything the migration then creates is owned by the application role, exactly as
//     an unfenced migration would leave it. That is the whole point: the fenced path and
//     the unfenced path leave the database in the SAME state.
//
//     Why this and not the alternatives. ALTER DEFAULT PRIVILEGES fixes privileges but not
//     ownership, applies only to objects created afterwards by one specific role, and needs
//     a separate clause per object type — a repair that has to enumerate what it repairs is
//     one that silently misses the next object type Prisma emits. Transferring ownership
//     afterwards has the same enumeration problem plus a window in which the objects exist
//     and are unusable. Setting the role at connection start has no enumeration and no
//     window.
//
//     AND IT IS NOT TRUSTED. `--preflight` refuses before anything is stopped if the admin
//     cannot SET ROLE to the application role, and scripts/check-app-db-object-access.mjs
//     runs after every migration and FAILS THE DEPLOY if the application role cannot
//     actually use a table, sequence or view that now exists. A comment saying the
//     ownership is right is not evidence; asking the database is.
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
//   * It cannot restore the GRANTOR. `--release` re-GRANTs CONNECT as the admin role, so a
//     grant originally made by someone else comes back recorded as `role=c/deployadmin`
//     rather than `role=c/postgres`. The privilege is identical and every caller sees the
//     same answer from has_database_privilege(); what changes is who may revoke it later.
//     Said here because the state file calls itself a restore of "exactly the grants".
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
 * Pure: every named role holding CONNECT DIRECTLY on the database.
 *
 * PUBLIC is deliberately NOT in this list — it is not a role and the caller handles it
 * separately. A NULL datacl means "the defaults", which grant CONNECT to PUBLIC and
 * everything to the owner, so the owner is the only named grantee there.
 *
 * This is what turns "revoke from the two grantees we thought of" into "revoke from whatever
 * the database says holds it": a monitoring or BI role with its own grant is otherwise
 * terminated by the drain and back a moment later (o3d-2sm1.5).
 */
export function listDirectConnectGrantees(datacl, ownerRole) {
  if (datacl === null || datacl === undefined || String(datacl).trim() === '') {
    return ownerRole ? [ownerRole] : []
  }
  const seen = []
  for (const entry of parseAclEntries(datacl)) {
    if (entry.grantee === '' || !entry.privileges.includes('c')) continue
    if (!seen.includes(entry.grantee)) seen.push(entry.grantee)
  }
  return seen
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
    directConnectGrantees = [],
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

  // EVERY GRANTEE THAT HOLDS CONNECT DIRECTLY, not the two we happened to think of.
  // `directConnectGrantees` comes from the database's own ACL, so a monitoring role, a BI
  // login or a second application is revoked too — otherwise the drain terminates it and it
  // reconnects a moment later, for the whole migration, while this script reports "fenced".
  // The admin role is the one exception: it is the connection this deploy and its recovery
  // run through, and revoking CONNECT from it would lock the deploy out of the database it
  // just fenced. (A superuser admin ignores the ACL anyway; an owner admin keeps its owner
  // entry, which Postgres materialises the moment anything is revoked.)
  const revoke = []
  if (publicHasConnect) revoke.push(PUBLIC_GRANTEE)
  for (const grantee of directConnectGrantees) {
    if (grantee === PUBLIC_GRANTEE || grantee === '') continue
    if (grantee === adminRole) continue
    if (!revoke.includes(grantee)) revoke.push(grantee)
  }
  if (appRoleHasConnect && !revoke.includes(appRole)) revoke.push(appRole)

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
 * Pure: can the migration RUN AS the application role over the admin's connection?
 *
 * The fence forces the migration through the admin connection, and everything a migration
 * creates is owned by whoever ran it. Left as the admin, that is a superuser, and the
 * application role gets no grant on the new table at all — a deploy that reports success and
 * then fails every request that touches it (o3d-2sm1.5). `SET ROLE`, applied at connection
 * start, makes the fenced migration leave the database in exactly the state an unfenced one
 * would.
 *
 * A superuser may SET ROLE to anything. A non-superuser admin — the database-owner case —
 * may only do it if it is a member of the application role, and `pg_has_role(admin, app,
 * 'SET')` is the database's own answer to that. When it cannot, this is a REFUSAL rather
 * than a silent fall back to admin-owned objects: falling back is the defect.
 *
 * @param {{ adminRole: string, appRole: string, adminIsSuperuser: boolean, adminCanSetAppRole: boolean }} facts
 * @returns {{ usable: boolean, reason: string }}
 */
export function assessMigrationRole({ adminRole, appRole, adminIsSuperuser, adminCanSetAppRole }) {
  if (!appRole) {
    return { usable: false, reason: 'DATABASE_URL carries no role name, so the migration has no role to run as.' }
  }
  if (adminIsSuperuser || adminCanSetAppRole) return { usable: true, reason: '' }
  return {
    usable: false,
    reason: `the deploy connects as ${adminRole}, which is neither a superuser nor a member of ${appRole}, so the migration cannot SET ROLE to ${appRole}. Everything it created would be owned by ${adminRole} with no grant to the application, and the deploy would report success while every request touching a new table failed with "permission denied". Grant ${adminRole} membership of ${appRole} (GRANT ${appRole} TO ${adminRole}) and re-run.`,
  }
}

/**
 * Pure: the admin connection string with `options=-c role=<appRole>` merged in.
 *
 * Authentication still happens as the admin — which is what keeps the fence effective, since
 * CONNECT is checked against the role that logs in — and the session then runs as the
 * application role, so the objects a migration creates are owned by it.
 *
 * libpq splits `options` on spaces, so a space inside a role name is backslash-escaped; the
 * whole value is then percent-encoded, because `+` is NOT decoded as a space here and using
 * URLSearchParams would produce exactly that. An `options` already present is preserved and
 * appended to rather than overwritten.
 *
 * IT THROWS RATHER THAN RETURNING THE INPUT (o3d-2sm1.5, Codex r5 MEDIUM). Returning the admin
 * URL unchanged on unparseable input produced a connection with NO `role=` at all — the
 * migration then ran as the admin, creating objects the application cannot use, while the
 * deploy log announced that it was running as the application role. That is precisely the
 * CRITICAL this whole mechanism exists to close, reached through its own fallback. Same for a
 * role name carrying a tab or a newline: libpq's option parser splits on those exactly as it
 * splits on a space, and the resulting `role=` would be silently truncated, so it is refused
 * rather than escaped-and-hoped.
 */
export function buildMigrationConnectionString(adminConnectionString, appRole) {
  if (!adminConnectionString) {
    throw new Error('No admin connection string to compose a migration URL from.')
  }
  if (!appRole) {
    throw new Error('No application role, so there is no role for the migration to run as.')
  }
  if (/[\t\n\r\f\v]/.test(String(appRole))) {
    throw new Error(
      `The application role name ${JSON.stringify(String(appRole))} contains whitespace that libpq's ` +
        'option parser treats as a separator, so `role=` would be silently truncated and the migration ' +
        'would run as the admin. Refusing to compose that URL.',
    )
  }
  let url
  try {
    url = new URL(adminConnectionString)
  } catch {
    throw new Error(
      'The admin connection string cannot be parsed as a URL, so `options=-c role=' +
        `${appRole}\` cannot be added to it. Returning it unchanged would run the migration AS THE ADMIN ` +
        'while the deploy announced the application role — the exact failure this composes a URL to avoid.',
    )
  }
  const escaped = String(appRole).replace(/([\\ '])/g, '\\$1')
  const existing = url.searchParams.get('options')
  const merged = existing ? `${existing} -c role=${escaped}` : `-c role=${escaped}`
  url.searchParams.delete('options')
  const query = url.searchParams.toString()
  url.search = ''
  const rendered = url.toString().replace(/\?$/, '')
  const parts = []
  if (query) parts.push(query)
  parts.push(`options=${encodeURIComponent(merged)}`)
  return `${rendered}?${parts.join('&')}`
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
    if (arg === '--fence' || arg === '--release' || arg === '--preflight' || arg === '--print-migration-url') options.mode = arg.slice(2)
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
            (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS app_role_exists,
            -- Can the admin SET ROLE to the application role? That is what decides whether the
            -- migration can create objects OWNED BY the application (o3d-2sm1.5). 'MEMBER' is the
            -- mode that answers "may SET ROLE", as opposed to 'USAGE' which only answers
            -- "inherits its privileges".
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
              OR COALESCE((SELECT pg_has_role(current_user, $1, 'MEMBER')
                             FROM pg_roles WHERE rolname = $1), false) AS admin_can_set_app_role
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

/**
 * Everything the two read-only questions need, asked once: is this database fenceable, and
 * can the migration run as the application role over the admin's connection?
 *
 * `--preflight` and `--fence` ask exactly the same things of exactly the same database. That
 * is deliberate: a preflight that asks a DIFFERENT question is a preflight that passes and
 * then fails after the stop.
 */
async function assessFence(client, appRole) {
  const facts = await readFacts(client, appRole)
  const effective = await readEffectiveConnect(client, appRole)
  const plan = planConnectionFence({
    appRole,
    appRoleIsSuperuser: facts.app_role_is_superuser === true,
    adminRole: facts.admin_role,
    adminIsSuperuser: facts.admin_is_superuser === true,
    adminIsOwner: facts.admin_role === facts.owner_role,
    publicHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, PUBLIC_GRANTEE),
    appRoleHasConnect: granteeHasConnect(facts.datacl, facts.owner_role, appRole),
    appRoleHasEffectiveConnect: effective.stillConnects,
    directConnectGrantees: listDirectConnectGrantees(facts.datacl, facts.owner_role),
  })
  const role = assessMigrationRole({
    adminRole: facts.admin_role,
    appRole,
    adminIsSuperuser: facts.admin_is_superuser === true,
    adminCanSetAppRole: facts.admin_can_set_app_role === true,
  })
  return { facts, plan, role }
}

/** Shared by --preflight and --fence: the admin URL is the ONLY connection either may use. */
function requireAdminUrl(what) {
  if (process.env.DEPLOY_ADMIN_DATABASE_URL) return true
  console.error(`NOT FENCED: DEPLOY_ADMIN_DATABASE_URL is not set, so this deploy has no privileged`)
  console.error(`connection that would survive revoking CONNECT from the application role, and ${what}`)
  console.error('cannot hold the database closed for the migration window.')
  return false
}

/**
 * --preflight: ask, before anything is stopped, every question that can be asked without
 * changing anything. It revokes nothing, terminates nothing and writes no state file.
 *
 * WHY IT EXISTS AT ALL (o3d-2sm1.5, Codex r4 HIGH). The callers' pre-stop check was
 * `[[ -f scripts/fence-db-connections.mjs ]]` — it checked that the file EXISTS and never
 * executed it. `dotenv` was a devDependency while the documented manual upgrade runs
 * `npm ci --omit=dev`, so the fence died with a missing module at drain-verify, AFTER the
 * predecessor had been stopped: an outage for an import. Running this mode executes the same
 * imports and opens the same connection as `--fence`, so anything that would kill the fence
 * kills the preflight instead, while the predecessor is still up.
 */
async function doPreflight(client, options) {
  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const { facts, plan, role } = await assessFence(client, appRole)

  if (appRole && !facts.app_role_exists) {
    console.error(`NOT FENCED: the role ${appRole} from DATABASE_URL does not exist on this server.`)
    return EXIT_NOT_FENCEABLE
  }
  if (!plan.fenceable) {
    console.error(`NOT FENCED: ${plan.reason}`)
    return EXIT_NOT_FENCEABLE
  }
  if (!role.usable) {
    console.error(`NOT FENCED: ${role.reason}`)
    return EXIT_NOT_FENCEABLE
  }

  console.log(`Preflight: ${facts.database} is fenceable.`)
  console.log(`  CONNECT would be revoked from: ${plan.revoke.join(', ')}`)
  console.log(`  the migration would connect as ${facts.admin_role} and RUN AS ${appRole}, so what it creates is owned by ${appRole}.`)
  console.log('  Nothing was revoked, terminated or written by this check.')
  return EXIT_OK
}

async function doFence(client, options) {
  // The fence is only ever established through an EXPLICIT admin URL. Falling back to
  // DIRECT_URL here would let a fence engage while the caller has no idea which
  // connection survived it — and the caller has to run the migration through exactly
  // that connection.
  if (!requireAdminUrl('this deploy')) {
    console.error('The deploy may continue, but the database is NOT held closed for the migration')
    console.error('window: a client that connects between now and the end of the migration is not stopped.')
    return EXIT_NOT_FENCEABLE
  }

  const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
  const { facts, plan: freshPlan, role } = await assessFence(client, appRole)

  if (appRole && !facts.app_role_exists) {
    console.error(`NOT FENCED: the role ${appRole} from DATABASE_URL does not exist on this server.`)
    return EXIT_NOT_FENCEABLE
  }

  // Asked here as well as in --preflight, because a re-run may reach this with a state file
  // and never go through a preflight at all. An admin that cannot SET ROLE would migrate as
  // itself and leave every new object unusable by the application (o3d-2sm1.5).
  if (!role.usable) {
    console.error(`NOT FENCED: ${role.reason}`)
    return EXIT_NOT_FENCEABLE
  }

  const existing = options.stateFile ? readState(options.stateFile) : null
  const plan = existing ? { fenceable: true, reason: '', revoke: existing.revoked } : freshPlan

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
    // A grantee that appeared SINCE the fence was recorded would otherwise be revoked by
    // nothing: the state file is the authority on what to restore, not on what holds CONNECT
    // now. Anything new is revoked too and appended, so the release still puts it back.
    const appeared = freshPlan.revoke.filter((grantee) => !plan.revoke.includes(grantee))
    if (appeared.length > 0) {
      console.log(`  and revoking from ${appeared.join(', ')}, which has acquired CONNECT since the fence was recorded.`)
      plan.revoke.push(...appeared)
      writeState(options.stateFile, { ...existing, revoked: plan.revoke, undo_sql: buildGrantStatements(facts.database, plan.revoke) })
      revokes.push(...buildRevokeStatements(facts.database, appeared))
      grants.push(...buildGrantStatements(facts.database, appeared))
    }
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
  //
  // THE TERMINATE AND THE CONFIRMING READ ARE BOTH UNCONDITIONAL (o3d-2sm1.5, Codex r4 HIGH).
  // This used to terminate only if the FIRST read found something and skip the settle loop
  // entirely when it did not — so a single empty sample, taken microseconds after the revoke
  // committed, was the whole proof. A backend mid-authentication when the revoke landed is
  // not in pg_stat_activity yet and is attached a moment later. Terminating costs nothing
  // when there is nothing to terminate, and the second read after a settle is what makes
  // "quiet" an observation rather than a coincidence.
  const deadline = Date.now() + Math.max(1, options.timeoutSeconds) * 1000
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
  let remaining = await otherClientBackends(client)
  if (remaining.length > 0) console.log(`Draining ${remaining.length} connection(s) already attached...`)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    remaining = await otherClientBackends(client)
  }
  if (remaining.length === 0) {
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
  const modes = ['fence', 'release', 'preflight', 'print-migration-url']
  if (!modes.includes(options.mode)) {
    console.error('Usage: node scripts/fence-db-connections.mjs (--preflight|--fence|--release|--print-migration-url) [--state-file=PATH] [--app-role=ROLE] [--timeout-seconds=N]')
    process.exit(EXIT_ERROR)
  }

  // Opens no connection: it is pure string work over two environment variables, and the
  // caller needs it BEFORE the migration runs, from a shell that cannot parse a URL safely.
  if (options.mode === 'print-migration-url') {
    if (!process.env.DEPLOY_ADMIN_DATABASE_URL) {
      console.error('DEPLOY_ADMIN_DATABASE_URL is not set — there is no privileged connection to compose a migration URL from.')
      process.exit(EXIT_ERROR)
    }
    const appRole = options.appRole || parseRoleFromConnectionString(process.env.DATABASE_URL)
    if (!appRole) {
      console.error('DATABASE_URL carries no role name, so the migration has no role to run as. Refusing to emit a URL that would create objects owned by the admin.')
      process.exit(EXIT_ERROR)
    }
    process.stdout.write(`${buildMigrationConnectionString(process.env.DEPLOY_ADMIN_DATABASE_URL, appRole)}\n`)
    return
  }

  // --preflight and --fence must BOTH be the admin connection or neither is meaningful: a
  // preflight that connected as the application role would prove nothing about the connection
  // the migration actually uses.
  const connectionString =
    options.mode === 'preflight'
      ? process.env.DEPLOY_ADMIN_DATABASE_URL
      : process.env.DEPLOY_ADMIN_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    if (options.mode === 'preflight') {
      requireAdminUrl('this deploy')
      process.exit(EXIT_NOT_FENCEABLE)
    }
    console.error('Neither DEPLOY_ADMIN_DATABASE_URL nor DATABASE_URL is set — cannot fence or release anything.')
    process.exit(EXIT_ERROR)
  }

  const client = new pg.Client({ connectionString, application_name: 'ims-deploy-fence' })
  await client.connect()
  try {
    if (options.mode === 'preflight') process.exitCode = await doPreflight(client, options)
    else if (options.mode === 'fence') process.exitCode = await doFence(client, options)
    else process.exitCode = await doRelease(client, options)
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
