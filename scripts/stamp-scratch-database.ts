/**
 * STAMP A DATABASE AS DISPOSABLE, so the concurrency tier's guard will use it.
 *
 *   npm run db:stamp-scratch   -- <database-name>     # stamp it
 *   npm run db:unstamp-scratch -- <database-name>     # take the stamp off again
 *
 * The guard (tests/concurrency/scratch-database-guard.ts) asks the SERVER for proof that a
 * database was created to be destroyed before it seeds anything into it, because two rounds
 * of name rules both admitted databases the product actually ships — tenant databases are
 * `ims_<slug>` (scripts/provision-ims-tenant.sh) and the canonical one is `onetwoinventory`
 * (.env.example). The proof is this stamp: `COMMENT ON DATABASE <db> IS '<marker naming that
 * database>'`, which lives outside every schema (so the schema-drift gate cannot see it) and
 * survives `prisma migrate deploy`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * WHY IT TAKES THE NAME AS AN ARGUMENT, AND REFUSES A DATABASE HOLDING DATA (o3d-zzgp r7)
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 6 argued that stamping plus declaring were "two deliberate acts naming the
 * database". The independent review disproved it end to end: round 6's stamper read
 * `DATABASE_URL`, took no argument, asked nothing, never looked at what the database held,
 * and PRINTED the export line to paste — so it stamped a live tenant-shaped database full of
 * rows, and the guard then accepted it. Both "acts" came from one wrong URL.
 *
 * So the second act now genuinely names the database: the argument must equal
 * `current_database()`, which a copy-pasted URL does not supply. And a database that holds
 * application data is refused outright — a live database is exactly the thing this must never
 * mark disposable, and "it has rows in it" is the cheapest honest evidence of one.
 *
 * NOT OWNERSHIP. Round 6 claimed ownership of the database was a meaningful barrier. It is
 * not: provision-ims-tenant.sh hands every tenant database to the role in its own
 * DATABASE_URL, and on the development server one role owns every `ims_*`. The barriers are
 * the argument, the data check, and the belt below.
 */

import { pathToFileURL } from 'node:url'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_MARKER_PREFIX,
  expectedScratchDatabaseMarker,
} from '../tests/concurrency/scratch-database-guard'

/**
 * Tables a FRESHLY MIGRATED database has rows in, so their rows are not evidence that a
 * database is in use. MEASURED on 2026-09-17, not assumed: `createdb` + `prisma migrate
 * deploy` (262 migrations) then a row count over all 109 user tables gave exactly
 * `_prisma_migrations` (262), `settings` (2) and `shopping_status_mappings` (7) — everything
 * else empty. Re-measure with:
 *
 *   for t in $(psql -At -c "SELECT n.nspname||'.'||c.relname FROM pg_class c
 *       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')
 *       AND n.nspname NOT IN ('pg_catalog','information_schema') AND NOT c.relispartition");
 *     do echo "$t $(psql -At -c "select count(*) from $t")"; done
 *
 * A future migration that seeds a fourth table makes this script REFUSE a freshly migrated
 * database and CI goes red naming the table — loud, and in the safe direction. The residual
 * is stated in docs/development.md: a live database whose ONLY rows are in these three is not
 * distinguished by this check.
 */
const MIGRATION_SEEDED_TABLES = ['_prisma_migrations', 'settings', 'shopping_status_mappings']

type Facts = {
  database: string
  comment: string | null
  inRecovery: boolean
  isTemplate: boolean
  /** null when the catalogue could not be read — a REFUSAL here, see `refuseToStamp`. */
  subscriptionCount: number | null
  /** Tables outside `MIGRATION_SEEDED_TABLES` that hold at least one row. */
  populatedTables: string[]
}

type PgClient = {
  query: <T>(sql: string) => Promise<{ rows: T[] }>
  end: () => Promise<void>
}

async function readFacts(client: PgClient): Promise<Facts> {
  const { rows } = await client.query<{
    name: string
    comment: string | null
    in_recovery: boolean
    is_template: boolean
  }>(`SELECT pg_catalog.current_database() AS name,
             pg_catalog.shobj_description(
               (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
               'pg_database') AS comment,
             pg_catalog.pg_is_in_recovery() AS in_recovery,
             (SELECT datistemplate FROM pg_catalog.pg_database
               WHERE datname = pg_catalog.current_database()) AS is_template`)

  let subscriptionCount: number | null = null
  try {
    const subscriptions = await client.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count FROM pg_catalog.pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database
                          WHERE datname = pg_catalog.current_database())`,
    )
    subscriptionCount = Number(subscriptions.rows[0]!.count)
  } catch {
    subscriptionCount = null
  }

  return {
    database: String(rows[0]!.name ?? ''),
    comment: rows[0]!.comment ?? null,
    inRecovery: rows[0]!.in_recovery === true,
    isTemplate: rows[0]!.is_template === true,
    subscriptionCount,
    populatedTables: await findPopulatedTables(client),
  }
}

/**
 * Every ordinary table outside the migration-seeded set that holds at least one row, as ONE
 * statement: the catalogue names the tables, and an `EXISTS` per table is UNION ALLed so the
 * server answers in a single round trip and stops at the first row of each.
 */
async function findPopulatedTables(client: PgClient): Promise<string[]> {
  const { rows: tables } = await client.query<{ schema: string; table: string }>(
    `SELECT n.nspname AS schema, c.relname AS table
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY 1, 2`,
  )
  const candidates = tables.filter((row) => !MIGRATION_SEEDED_TABLES.includes(row.table))
  if (candidates.length === 0) return []

  const probes = candidates.map((row) => {
    const qualified = `"${row.schema.replace(/"/g, '""')}"."${row.table.replace(/"/g, '""')}"`
    const label = quoteLiteral(`${row.schema}.${row.table}`)
    return `SELECT ${label} AS t WHERE EXISTS (SELECT 1 FROM ${qualified})`
  })
  const { rows } = await client.query<{ t: string }>(probes.join(' UNION ALL '))
  return rows.map((row) => row.t)
}

/**
 * The reasons a stamp must never be applied, whoever asks. Pure, so the unit table can cover
 * every one without a server.
 */
export function refuseToStamp(input: {
  database: string
  requestedName: string | undefined
  inRecovery: boolean
  isTemplate: boolean
  subscriptionCount: number | null
  populatedTables: string[]
}): string | null {
  if (!input.database) return 'the server reported no database name'
  if (input.requestedName === undefined) {
    return 'no database name was given. Name the database you mean as an argument — '
      + 'npm run db:stamp-scratch -- <database-name> — so that stamping is a decision about a '
      + 'database rather than a consequence of whatever DATABASE_URL happens to be set to'
  }
  if (input.requestedName !== input.database) {
    return `the name given ("${input.requestedName}") is not the database this DATABASE_URL reaches `
      + `("${input.database}")`
  }
  if (ALWAYS_REFUSED_DATABASE.test(input.database)) {
    return `the name matches ${ALWAYS_REFUSED_DATABASE}, which is a real or server-owned database`
  }
  if (input.inRecovery) return 'the server is in recovery, so this is a replica'
  if (input.isTemplate) return 'it is a template database'
  // FAILS CLOSED, unlike the guard (review LOW-4). The guard may treat an unreadable
  // pg_subscription as "no evidence" because the stamp is what excludes a copy for it; here the
  // stamp is what is being HANDED OUT, so an unanswerable question is a refusal.
  if (input.subscriptionCount === null) {
    return 'whether this database is a logical-replication subscriber could not be read '
      + '(pg_subscription is not readable to this role), and a database that might be a copy of '
      + 'another one must not be marked disposable'
  }
  if (input.subscriptionCount > 0) {
    return `it is the target of ${input.subscriptionCount} logical-replication subscription(s), so it is a copy of another database`
  }
  if (input.populatedTables.length > 0) {
    const shown = input.populatedTables.slice(0, 5).join(', ')
    const more = input.populatedTables.length > 5 ? ` (and ${input.populatedTables.length - 5} more)` : ''
    return `it holds application data — rows in ${shown}${more}. A database created for a test run has `
      + 'none, so this is a database in use'
  }
  return null
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function main(argv: string[]): Promise<number> {
  const unstamp = argv.includes('--unstamp')
  const requestedName = argv.find((arg) => !arg.startsWith('--'))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set; point it at the database you created for this test run')
    return 2
  }
  const { sanitisedProbeConnectionString } = await import('../lib/db/database-url-schema.mjs')
  const connectionString = sanitisedProbeConnectionString(databaseUrl)
  if (connectionString === null) {
    console.error('DATABASE_URL is not a URL, so its connection parameters cannot be sanitised')
    return 2
  }

  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString, application_name: 'o3d-stamp-scratch-database' })
  await client.connect()
  try {
    const facts = await readFacts(client as unknown as PgClient)

    if (unstamp) {
      if (requestedName !== facts.database) {
        console.error(`REFUSING to unstamp: name the database this DATABASE_URL reaches ("${facts.database}")`)
        return 1
      }
      if (facts.comment === null) {
        console.log(`"${facts.database}" carries no database comment; nothing to remove.`)
        return 0
      }
      if (!facts.comment.startsWith(`${SCRATCH_DATABASE_MARKER_PREFIX}(`)) {
        console.error(`REFUSING to unstamp "${facts.database}": its comment is not a scratch marker, and this script `
          + 'will not remove a comment it did not write')
        return 1
      }
      await client.query(`COMMENT ON DATABASE ${quoteIdentifier(facts.database)} IS NULL`)
      console.log(`Removed the scratch marker from "${facts.database}".`)
      return 0
    }

    const refusal = refuseToStamp({
      database: facts.database,
      requestedName,
      inRecovery: facts.inRecovery,
      isTemplate: facts.isTemplate,
      subscriptionCount: facts.subscriptionCount,
      populatedTables: facts.populatedTables,
    })
    if (refusal) {
      console.error(`REFUSING to stamp "${facts.database || '<unknown>'}": ${refusal}`)
      return 1
    }

    const marker = expectedScratchDatabaseMarker(facts.database)
    if (facts.comment === marker) {
      console.log(`"${facts.database}" is already stamped disposable.`)
      return 0
    }
    if (facts.comment !== null) {
      console.error(
        `REFUSING to stamp "${facts.database}": it already carries a different database comment `
        + `("${facts.comment}"), which a database created for a test run does not have`,
      )
      return 1
    }

    // Neither the identifier nor the comment can be a bind parameter in DDL. The name comes
    // from the server's own current_database() and the marker is derived from it; both quoted.
    await client.query(`COMMENT ON DATABASE ${quoteIdentifier(facts.database)} IS ${quoteLiteral(marker)}`)
    // DELIBERATELY NOT A PASTE-READY EXPORT LINE (review LOW-3): round 6 printed the exact
    // declaration to set, which composed with the guard's refusal into a walkthrough for
    // pointing the suite at whatever database the URL reached.
    console.log(`Stamped "${facts.database}" disposable. docs/development.md, "Database-backed tiers", `
      + 'has the rest of the setup.')
    return 0
  } finally {
    await client.end().catch(() => {})
  }
}

// Only when RUN, never when imported: the unit table imports `refuseToStamp` from here, and a
// module that connects to a database on import would make importing it a side effect.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    })
}
