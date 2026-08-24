#!/usr/bin/env node
// =============================================================================
// Can the APPLICATION role actually use what the migration just created?
// =============================================================================
// This is the check that would have caught o3d-2sm1.5 (Codex r4, CRITICAL), and it is
// worth stating the failure it exists for rather than only what it does.
//
// The connection fence revokes CONNECT from the application role, so the migration has to
// run through DEPLOY_ADMIN_DATABASE_URL. scripts/install.sh makes the APPLICATION role the
// database owner, and the fence REFUSES when the admin role is the application role — so the
// only fenceable configuration is a separate SUPERUSER admin. Every CREATE TABLE, INDEX and
// SEQUENCE a migration made through it was then owned by that superuser, with no grant to the
// application role at all.
//
// And nothing in the pipeline could see it. `prisma migrate deploy`, the drift check, the
// verification hook and `pg_dump` all use THE SAME ADMIN CONNECTION, which owns the new
// objects and can read them perfectly. The health check hits a route that touches no
// database. The deploy reported success; every request touching the new table failed with
// `permission denied`.
//
// scripts/fence-db-connections.mjs now runs the migration as the application role
// (`options=-c role=...`), which makes the fenced path leave the database in the same state
// an unfenced one would. THIS script is the part that does not take that on trust: it asks
// the database, ABOUT THE APPLICATION ROLE, from whatever connection it has — because
// has_table_privilege(role, ...) answers for a role other than the caller's, which is
// precisely why the defect was invisible to every other step.
//
// It runs after `prisma migrate deploy` and the drift check, before the new build starts.
//
// WHAT IT ASSERTS
//   * every non-system schema is USABLE by the application role;
//   * every ordinary table in them is SELECT/INSERT/UPDATE/DELETE-able by it;
//   * every view and materialized view is SELECT-able;
//   * every sequence is USAGE/SELECT/UPDATE-able (an owned-by-a-superuser sequence behind a
//     serial column fails INSERT even when the table itself is granted).
//
// It does NOT assert ownership. Ownership is one way to have the privilege and not the only
// one, and a database an operator has deliberately granted through a group role is not
// broken. The question that matters to a running application is "can it use this", so that
// is the question asked. The owner is REPORTED alongside each failure, because it is the
// fastest way to see what went wrong.
//
// Usage:
//   node scripts/check-app-db-object-access.mjs [--app-role=ROLE] [--state-file=PATH]
//
// The application role is resolved from --app-role, then from the fence state file (which
// records the role whose CONNECT was revoked), then from DATABASE_URL. During a fenced
// window DATABASE_URL is the ADMIN url, which is exactly why the state file comes first.
// =============================================================================

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

export const EXIT_OK = 0
export const EXIT_ERROR = 1

/**
 * Ask about the APPLICATION role, not about the caller. `relkind` decides which privileges
 * are meaningful: 'r'/'p' ordinary and partitioned tables need write access, 'v'/'m' views
 * need only SELECT, 'S' sequences need the three a serial column consumes.
 */
export const OBJECT_ACCESS_QUERY = `
  SELECT n.nspname                                        AS schema_name,
         c.relname                                        AS object_name,
         c.relkind                                        AS relkind,
         pg_catalog.pg_get_userbyid(c.relowner)           AS owner_role,
         has_schema_privilege($1, n.nspname, 'USAGE')     AS schema_usable,
         CASE
           WHEN c.relkind IN ('r', 'p') THEN has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
           WHEN c.relkind IN ('v', 'm') THEN has_table_privilege($1, c.oid, 'SELECT')
           WHEN c.relkind = 'S'         THEN has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE')
           ELSE true
         END                                              AS object_usable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg_toast%'
     AND n.nspname NOT LIKE 'pg_temp%'
   ORDER BY n.nspname, c.relname
`

const KIND_LABEL = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', S: 'sequence' }

/**
 * Pure: turn the rows into a verdict and operator-readable lines.
 *
 * A schema the role cannot USE makes every object in it unusable regardless of the object
 * grant, so it is reported as its own failure rather than repeated once per table.
 */
export function summariseObjectAccess(rows, appRole) {
  const objects = Array.isArray(rows) ? rows : []
  const unusableSchemas = []
  const unusableObjects = []

  for (const row of objects) {
    if (row.schema_usable === false) {
      if (!unusableSchemas.includes(row.schema_name)) unusableSchemas.push(row.schema_name)
      continue
    }
    if (row.object_usable === false) unusableObjects.push(row)
  }

  const lines = []
  for (const schema of unusableSchemas) {
    lines.push(`schema ${schema}: ${appRole} has no USAGE, so nothing in it is reachable`)
  }
  for (const row of unusableObjects) {
    lines.push(
      `${KIND_LABEL[row.relkind] ?? row.relkind} ${row.schema_name}.${row.object_name}: ` +
        `owned by ${row.owner_role}, and ${appRole} cannot use it`,
    )
  }

  return {
    ok: lines.length === 0,
    inspected: objects.length,
    failures: lines.length,
    lines,
  }
}

/** Pure: the role to ask about, and where the answer came from. */
export function resolveAppRole({ flagRole, stateFileRole, connectionRole }) {
  if (flagRole) return { role: flagRole, source: '--app-role' }
  if (stateFileRole) return { role: stateFileRole, source: 'the connection fence state file' }
  if (connectionRole) return { role: connectionRole, source: 'DATABASE_URL' }
  return { role: '', source: '' }
}

function parseArgs(argv) {
  const options = { appRole: '', stateFile: '' }
  for (const arg of argv) {
    if (arg.startsWith('--app-role=')) options.appRole = arg.slice('--app-role='.length)
    else if (arg.startsWith('--state-file=')) options.stateFile = arg.slice('--state-file='.length)
  }
  return options
}

function roleFromConnectionString(connectionString) {
  if (!connectionString) return ''
  try {
    const url = new URL(connectionString)
    return url.username ? decodeURIComponent(url.username) : ''
  } catch {
    return ''
  }
}

function roleFromStateFile(stateFile) {
  if (!stateFile) return ''
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')).app_role ?? ''
  } catch {
    return ''
  }
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const options = parseArgs(process.argv.slice(2))

  // The application role has no CONNECT while the fence is up, so this must go through the
  // privileged connection when there is one — the same rule scripts/check-db-writers.mjs and
  // scripts/run-migration-verifications.mjs follow (o3d-2sm1.5, Codex r4 HIGH).
  const connectionString =
    process.env.DEPLOY_ADMIN_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set — cannot check what the application role can use.')
    process.exit(EXIT_ERROR)
  }

  const { role: appRole, source } = resolveAppRole({
    flagRole: options.appRole,
    stateFileRole: roleFromStateFile(options.stateFile),
    connectionRole: roleFromConnectionString(process.env.DATABASE_URL),
  })
  if (!appRole) {
    console.error('No application role could be determined (--app-role, the fence state file and DATABASE_URL were all silent).')
    console.error('Refusing to report that the application can use the schema when nothing was asked about it.')
    process.exit(EXIT_ERROR)
  }

  const client = new pg.Client({ connectionString, application_name: 'ims-deploy-object-access' })
  await client.connect()
  try {
    const { rows } = await client.query(OBJECT_ACCESS_QUERY, [appRole])
    const summary = summariseObjectAccess(rows, appRole)

    if (summary.ok) {
      console.log(
        `Application role ${appRole} (from ${source}) can use all ${summary.inspected} table(s), view(s) and sequence(s) in this database.`,
      )
      return
    }

    console.error(`THE MIGRATION LEFT OBJECTS THE APPLICATION CANNOT USE. ${summary.failures} of ${summary.inspected} inspected:`)
    for (const line of summary.lines) console.error(`  - ${line}`)
    console.error('')
    console.error(`The usual cause is a migration that ran as the deploy admin instead of as ${appRole}:`)
    console.error('the fenced window runs `prisma migrate deploy` through DEPLOY_ADMIN_DATABASE_URL, and that')
    console.error(`connection carries \`options=-c role=${appRole}\` so the objects are owned by the application.`)
    console.error('If that option did not reach Postgres, everything created in this run is owned by the admin.')
    console.error('The new build must NOT be started: it would fail with "permission denied" on every one of these.')
    process.exitCode = EXIT_ERROR
  } finally {
    await client.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Failed to check what the application role can use: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Treating that as "not proven usable" — the new build must not be started.')
    process.exit(EXIT_ERROR)
  })
}
