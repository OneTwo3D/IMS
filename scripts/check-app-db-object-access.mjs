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
// EVERY PRIVILEGE IS ASKED FOR SEPARATELY, AND THAT IS NOT A STYLE CHOICE.
// `has_table_privilege(role, oid, 'SELECT, INSERT, UPDATE, DELETE')` is documented as, and
// behaves as, ANY — not ALL. Verified on PostgreSQL 17: a role holding SELECT and nothing
// else answers TRUE to that list, and `has_sequence_privilege(role, oid, 'USAGE, SELECT,
// UPDATE')` answers TRUE for a role holding SELECT and no USAGE — which is EXACTLY the
// "serial column fails INSERT" case this file exists to catch. A comma-list therefore turns a
// read-only grant into a green check over a database the application cannot write, and this
// check is the one that closes the CRITICAL, so it would have been load-bearing and wrong.
// One call per privilege, ANDed here, and the ones that are missing are named in the failure.
//
// WHAT IT ASSERTS
//   * every non-system schema is USABLE by the application role — asked of the schema
//     itself, so a schema that is empty (or whose contents it cannot see) still fails
//     rather than contributing no rows and therefore no failure;
//   * every ordinary table in them is SELECT *and* INSERT *and* UPDATE *and* DELETE-able;
//   * every view and materialized view is SELECT-able;
//   * every sequence is USAGE *and* SELECT *and* UPDATE-able (an owned-by-a-superuser
//     sequence behind a serial column fails INSERT even when the table itself is granted);
//   * every function and procedure is EXECUTE-able — this repo's migrations create trigger
//     functions that GATE WRITES, so one the application cannot execute fails every INSERT
//     into the table that carries the trigger;
//   * every enum, domain, range and standalone composite type is USAGE-able — a column
//     typed by an enum the role cannot use is unreadable and unwritable.
//
// Objects belonging to an EXTENSION are skipped: they are not what a migration created, and
// their grants are the extension author's business.
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
// window DATABASE_URL is the ADMIN url, which is exactly why the state file comes first —
// and why a state file that EXISTS but cannot be read, or that names no role, is FATAL
// rather than a silent fall-through to the admin. Asking whether the admin can use the
// objects the admin just created is the defect, restated as a passing check.
// =============================================================================

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

export const EXIT_OK = 0
export const EXIT_ERROR = 1

/**
 * Ask about the APPLICATION role, not about the caller, and ask about ONE privilege at a
 * time — see the header: a comma-separated list is ANY, so it passes on a read-only grant.
 *
 * The shape is a union so that one pass answers for schemas, relations, routines and types,
 * and so a schema with nothing in it is still a row that can fail. `missing_privileges` is
 * the empty array when the role can use the object; anything in it is a failure that names
 * what is missing.
 */
export const OBJECT_ACCESS_QUERY = `
  WITH app_schemas AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
       AND n.nspname NOT LIKE 'pg\\_temp%'
       AND n.nspname NOT LIKE 'pg\\_toast\\_temp%'
  ),
  extension_members AS (
    SELECT d.objid, d.classid
      FROM pg_catalog.pg_depend d
     WHERE d.deptype = 'e'
  )
  SELECT s.nspname                                   AS schema_name,
         ''                                          AS object_name,
         'n'                                         AS relkind,
         pg_catalog.pg_get_userbyid(s.nspowner)     AS owner_role,
         has_schema_privilege($1, s.nspname, 'USAGE') AS schema_usable,
         CASE WHEN has_schema_privilege($1, s.nspname, 'USAGE')
              THEN ARRAY[]::text[] ELSE ARRAY['USAGE'] END AS missing_privileges
    FROM app_schemas s

  UNION ALL

  SELECT s.nspname                                   AS schema_name,
         c.relname                                   AS object_name,
         c.relkind::text                             AS relkind,
         pg_catalog.pg_get_userbyid(c.relowner)      AS owner_role,
         has_schema_privilege($1, s.nspname, 'USAGE') AS schema_usable,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.relkind IN ('r', 'p', 'v', 'm')
                 AND NOT has_table_privilege($1, c.oid, 'SELECT') THEN 'SELECT' END,
           CASE WHEN c.relkind IN ('r', 'p')
                 AND NOT has_table_privilege($1, c.oid, 'INSERT') THEN 'INSERT' END,
           CASE WHEN c.relkind IN ('r', 'p')
                 AND NOT has_table_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END,
           CASE WHEN c.relkind IN ('r', 'p')
                 AND NOT has_table_privilege($1, c.oid, 'DELETE') THEN 'DELETE' END,
           CASE WHEN c.relkind = 'S'
                 AND NOT has_sequence_privilege($1, c.oid, 'USAGE')  THEN 'USAGE'  END,
           CASE WHEN c.relkind = 'S'
                 AND NOT has_sequence_privilege($1, c.oid, 'SELECT') THEN 'SELECT' END,
           CASE WHEN c.relkind = 'S'
                 AND NOT has_sequence_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END
         ], NULL)                                    AS missing_privileges
    FROM pg_catalog.pg_class c
    JOIN app_schemas s ON s.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S')
     AND NOT EXISTS (
       SELECT 1 FROM extension_members e
        WHERE e.objid = c.oid AND e.classid = 'pg_catalog.pg_class'::regclass
     )

  UNION ALL

  SELECT s.nspname                                   AS schema_name,
         p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
         'f'                                         AS relkind,
         pg_catalog.pg_get_userbyid(p.proowner)      AS owner_role,
         has_schema_privilege($1, s.nspname, 'USAGE') AS schema_usable,
         CASE WHEN has_function_privilege($1, p.oid, 'EXECUTE')
              THEN ARRAY[]::text[] ELSE ARRAY['EXECUTE'] END AS missing_privileges
    FROM pg_catalog.pg_proc p
    JOIN app_schemas s ON s.oid = p.pronamespace
   WHERE NOT EXISTS (
       SELECT 1 FROM extension_members e
        WHERE e.objid = p.oid AND e.classid = 'pg_catalog.pg_proc'::regclass
     )

  UNION ALL

  SELECT s.nspname                                   AS schema_name,
         pg_catalog.format_type(t.oid, NULL)         AS object_name,
         't'                                         AS relkind,
         pg_catalog.pg_get_userbyid(t.typowner)      AS owner_role,
         has_schema_privilege($1, s.nspname, 'USAGE') AS schema_usable,
         CASE WHEN has_type_privilege($1, t.oid, 'USAGE')
              THEN ARRAY[]::text[] ELSE ARRAY['USAGE'] END AS missing_privileges
    FROM pg_catalog.pg_type t
    JOIN app_schemas s ON s.oid = t.typnamespace
   WHERE (
       t.typtype IN ('e', 'd', 'r', 'm')
       OR (t.typtype = 'c' AND EXISTS (
             SELECT 1 FROM pg_catalog.pg_class rc
              WHERE rc.oid = t.typrelid AND rc.relkind = 'c'))
     )
     AND NOT EXISTS (
       SELECT 1 FROM extension_members e
        WHERE e.objid = t.oid AND e.classid = 'pg_catalog.pg_type'::regclass
     )

   ORDER BY 1, 3, 2
`

const KIND_LABEL = {
  n: 'schema',
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  S: 'sequence',
  f: 'function',
  t: 'type',
}

function missingOf(row) {
  const missing = row?.missing_privileges
  if (Array.isArray(missing)) return missing.filter((entry) => typeof entry === 'string' && entry.length > 0)
  return []
}

/**
 * Pure: turn the rows into a verdict and operator-readable lines.
 *
 * A schema the role cannot USE makes every object in it unusable regardless of the object
 * grant, so it is reported as its own failure rather than repeated once per table.
 *
 * NO ROWS IS NOT A PASS. `public` always exists, so an empty result means the query answered
 * about nothing at all — a different database, a namespace filter that swallowed everything,
 * a role that cannot see pg_catalog. Reporting "the application can use all 0 objects" is the
 * same class of mistake as asking about the wrong role.
 */
export function summariseObjectAccess(rows, appRole) {
  const objects = Array.isArray(rows) ? rows : []
  const unusableSchemas = []
  const unusableObjects = []

  for (const row of objects) {
    if (row.relkind === 'n') {
      if (missingOf(row).length > 0 && !unusableSchemas.includes(row.schema_name)) {
        unusableSchemas.push(row.schema_name)
      }
      continue
    }
    if (row.schema_usable === false) {
      if (!unusableSchemas.includes(row.schema_name)) unusableSchemas.push(row.schema_name)
      continue
    }
    if (missingOf(row).length > 0) unusableObjects.push(row)
  }

  const lines = []
  if (objects.length === 0) {
    lines.push(
      'nothing was inspected: the query returned no rows at all, so no privilege of ' +
        `${appRole} was actually established. A pass here would mean nothing.`,
    )
  }
  for (const schema of unusableSchemas) {
    lines.push(`schema ${schema}: ${appRole} has no USAGE, so nothing in it is reachable`)
  }
  for (const row of unusableObjects) {
    lines.push(
      `${KIND_LABEL[row.relkind] ?? row.relkind} ${row.schema_name}.${row.object_name}: ` +
        `owned by ${row.owner_role}, and ${appRole} is missing ${missingOf(row).join(', ')}`,
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

/**
 * Pure: the application role a connection string describes.
 *
 * `options=-c role=imsapp` is preferred over the username because that is EXACTLY what the
 * deploy sets during a fenced window: the URL authenticates as the admin and then becomes the
 * application role. Reading the username there would name the admin — the role that owns
 * everything the migration just created, and therefore the role for which every answer is yes.
 */
export function roleFromConnectionString(connectionString) {
  if (!connectionString) return ''
  let url
  try {
    url = new URL(connectionString)
  } catch {
    return ''
  }
  const options = url.searchParams.get('options') ?? ''
  const roleOption = /(?:^|\s)-c\s*role=((?:\\.|[^\s\\])+)/.exec(options)
  if (roleOption) return roleOption[1].replace(/\\(.)/g, '$1')
  return url.username ? decodeURIComponent(url.username) : ''
}

/**
 * Pure-ish: read the role out of the fence state file, distinguishing THREE outcomes.
 *
 * absent  — the fence never engaged (or this is an unfenced deploy). Falling back is correct:
 *           DATABASE_URL is then the application's own URL.
 * present but unusable — something wrote that file and we cannot tell which role it named.
 *           This is FATAL. Swallowing it to '' fell back to DATABASE_URL, which during a
 *           fenced window is the ADMIN, and the check then reported green unconditionally.
 * usable  — the recorded role.
 *
 * @returns {{ role: string, absent: boolean, error: string }}
 */
export function readStateFileRole(stateFile, readFile = (path) => readFileSync(path, 'utf8')) {
  if (!stateFile) return { role: '', absent: true, error: '' }
  let raw
  try {
    raw = readFile(stateFile)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { role: '', absent: true, error: '' }
    return { role: '', absent: false, error: `${stateFile} could not be read: ${error?.message ?? String(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { role: '', absent: false, error: `${stateFile} is not valid JSON: ${error?.message ?? String(error)}` }
  }
  const role = typeof parsed?.app_role === 'string' ? parsed.app_role.trim() : ''
  if (!role) return { role: '', absent: false, error: `${stateFile} records no app_role` }
  return { role, absent: false, error: '' }
}

/**
 * Pure: refuse to ask the question whose answer is meaningless.
 *
 * During a fenced window DATABASE_URL is the privileged URL, so a fall-back to its role asks
 * the admin whether the admin can use what the admin created. The answer is always yes, which
 * is not a check — it is the CRITICAL wearing a green tick.
 *
 * @returns {string} the reason to refuse, or '' to proceed
 */
export function objectionToResolvedRole({ role, source, adminRole }) {
  if (!role) return ''
  if (source !== 'DATABASE_URL') return ''
  if (!adminRole) return ''
  if (adminRole !== role) return ''
  return (
    `the only role available was ${role}, read from DATABASE_URL — and that is the same role as ` +
    'DEPLOY_ADMIN_DATABASE_URL, i.e. the deploy admin. Asking whether the admin can use the objects ' +
    'the admin just created answers yes for every one of them, which is the defect this check exists ' +
    'to find. Pass --app-role=<application role>, or point --state-file at the fence state file.'
  )
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

  const stateFile = readStateFileRole(options.stateFile)
  if (!options.appRole && stateFile.error) {
    console.error(`The connection fence state file cannot be trusted to name the application role: ${stateFile.error}`)
    console.error('Falling back to DATABASE_URL here would ask about the DEPLOY ADMIN during a fenced window,')
    console.error('which answers yes for every object the migration just created. Refusing instead.')
    process.exit(EXIT_ERROR)
  }

  const { role: appRole, source } = resolveAppRole({
    flagRole: options.appRole,
    stateFileRole: stateFile.role,
    connectionRole: roleFromConnectionString(process.env.DATABASE_URL),
  })
  if (!appRole) {
    console.error('No application role could be determined (--app-role, the fence state file and DATABASE_URL were all silent).')
    console.error('Refusing to report that the application can use the schema when nothing was asked about it.')
    process.exit(EXIT_ERROR)
  }

  const objection = objectionToResolvedRole({
    role: appRole,
    source,
    adminRole: roleFromConnectionString(process.env.DEPLOY_ADMIN_DATABASE_URL),
  })
  if (objection) {
    console.error(`Refusing to check the wrong role: ${objection}`)
    process.exit(EXIT_ERROR)
  }

  const client = new pg.Client({ connectionString, application_name: 'ims-deploy-object-access' })
  await client.connect()
  try {
    const { rows } = await client.query(OBJECT_ACCESS_QUERY, [appRole])
    const summary = summariseObjectAccess(rows, appRole)

    if (summary.ok) {
      console.log(
        `Application role ${appRole} (from ${source}) can use all ${summary.inspected} schema(s), table(s), view(s), sequence(s), function(s) and type(s) in this database.`,
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
