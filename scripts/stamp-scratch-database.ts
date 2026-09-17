/**
 * STAMP A DATABASE AS DISPOSABLE, so the concurrency tier's guard will use it.
 *
 *   npx tsx scripts/stamp-scratch-database.ts        # stamps $DATABASE_URL's database
 *
 * The guard (tests/concurrency/scratch-database-guard.ts) asks the SERVER for proof that a
 * database was created to be destroyed before it seeds anything into it, because two
 * rounds of name rules both admitted databases the product actually ships — tenant
 * databases are `ims_<slug>` and the canonical one is `onetwoinventory`. The proof is this
 * stamp: `COMMENT ON DATABASE <db> IS '<marker>'`, which lives outside every schema (so it
 * is invisible to the schema-drift gate), survives `prisma migrate deploy`, and requires
 * ownership of the database to set.
 *
 * It refuses to stamp anything the guard would refuse for a reason a stamp must not
 * override: an obviously real or server-owned name, a replica, a template, or the target
 * of a logical-replication subscription. It does NOT check the opt-in variable — that is
 * the run's declaration, not a property of the database.
 *
 * Exit codes: 0 stamped (or already stamped), 1 refused, 2 usage/connection failure.
 */

import { pathToFileURL } from 'node:url'

import {
  ALWAYS_REFUSED_DATABASE,
  SCRATCH_DATABASE_MARKER,
} from '../tests/concurrency/scratch-database-guard'

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set; point it at the database you created for this test run')
    return 2
  }

  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'o3d-stamp-scratch-database' })
  await client.connect()
  try {
    const { rows } = await client.query<{
      name: string
      comment: string | null
      in_recovery: boolean
      is_template: boolean
    }>(`SELECT current_database() AS name,
               shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS comment,
               pg_is_in_recovery() AS in_recovery,
               (SELECT datistemplate FROM pg_database WHERE datname = current_database()) AS is_template`)
    const database = String(rows[0]!.name)
    const refusal = refuseToStamp({
      database,
      inRecovery: rows[0]!.in_recovery === true,
      isTemplate: rows[0]!.is_template === true,
      subscriptionCount: await countSubscriptions(client),
    })
    if (refusal) {
      console.error(`REFUSING to stamp "${database}": ${refusal}`)
      return 1
    }

    if (rows[0]!.comment === SCRATCH_DATABASE_MARKER) {
      console.log(`"${database}" is already stamped disposable.`)
      return 0
    }
    if (rows[0]!.comment !== null) {
      console.error(
        `REFUSING to stamp "${database}": it already carries a different database comment `
        + `("${rows[0]!.comment}"), which a database created for a test run does not have`,
      )
      return 1
    }

    // Neither the identifier nor the comment can be a bind parameter in DDL. The name comes
    // from the server's own current_database() and the marker is a constant; both are quoted.
    const quotedName = `"${database.replace(/"/g, '""')}"`
    await client.query(`COMMENT ON DATABASE ${quotedName} IS ${quoteLiteral(SCRATCH_DATABASE_MARKER)}`)
    console.log(`Stamped "${database}" disposable. Export IMS_CONCURRENCY_SCRATCH_DB=${database} to run the tier against it.`)
    return 0
  } finally {
    await client.end().catch(() => {})
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function countSubscriptions(client: { query: (sql: string) => Promise<{ rows: Array<{ count: string }> }> }): Promise<number | null> {
  try {
    const { rows } = await client.query(
      `SELECT count(*)::text AS count FROM pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )
    return Number(rows[0]!.count)
  } catch {
    return null
  }
}

/** The reasons a stamp must never be applied, whoever asks. */
export function refuseToStamp(input: {
  database: string
  inRecovery: boolean
  isTemplate: boolean
  subscriptionCount: number | null
}): string | null {
  if (!input.database) return 'the server reported no database name'
  if (ALWAYS_REFUSED_DATABASE.test(input.database)) {
    return `the name matches ${ALWAYS_REFUSED_DATABASE}, which is a real or server-owned database`
  }
  if (input.inRecovery) return 'the server is in recovery, so this is a replica'
  if (input.isTemplate) return 'it is a template database'
  if (input.subscriptionCount !== null && input.subscriptionCount > 0) {
    return `it is the target of ${input.subscriptionCount} logical-replication subscription(s), so it is a copy of another database`
  }
  return null
}

// Only when RUN, never when imported: the unit table imports `refuseToStamp` from here, and
// a module that connects to a database on import would make importing it a side effect.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    })
}
