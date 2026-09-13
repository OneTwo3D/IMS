/**
 * REFUSE TO TOUCH ANY DATABASE THAT IS NOT POSITIVELY A SCRATCH DATABASE — AND DO IT
 * BEFORE ANYTHING WRITES (o3d-zzgp round 4, Codex HIGH-2).
 *
 * Round 3's race test checked `current_database() <> 'onetwo3d_ims_dev'` AFTER it had
 * already seeded products, warehouses, a transfer, stock and an active WMS binding —
 * so the one database it named was mutated before the refusal, and every OTHER database
 * (a shared one, a production one) passed the check and went on to receive DDL. That is
 * the shape that once put 335 fixture rows into the live-served development database.
 *
 * This is an ALLOWLIST, and it has two independent halves that must BOTH hold:
 *
 *   1. the connected database's name matches `SCRATCH_DATABASE_PATTERN` — a name no
 *      shared, development or production database in this estate uses; and
 *   2. the operator has opted in to mutating THAT database by name:
 *      `IMS_CONCURRENCY_SCRATCH_DB=<exact database name>`. A flag that merely says "yes"
 *      would let a mistyped DATABASE_URL through; naming the database cannot.
 *
 * The check runs on its own connection with `default_transaction_read_only=on`, so the
 * guard itself cannot write even if it is wrong, and it asks the SERVER which database
 * the URL reached rather than trusting the URL's path. Call it first in every test, before
 * importing anything that opens the application pool.
 */

export const SCRATCH_DATABASE_PATTERN = /^ims_scratch_[a-z0-9_]{1,48}$/
export const SCRATCH_DATABASE_OPT_IN_ENV = 'IMS_CONCURRENCY_SCRATCH_DB'

export class NotAScratchDatabaseError extends Error {
  override readonly name = 'NotAScratchDatabaseError'
}

/** The pure decision, exported so the refusal paths can be tested without a server. */
export function scratchDatabaseVerdict(input: {
  connectedDatabase: string
  optIn: string | undefined
}): { ok: true } | { ok: false; reason: string } {
  if (!SCRATCH_DATABASE_PATTERN.test(input.connectedDatabase)) {
    return {
      ok: false,
      reason: `connected database "${input.connectedDatabase}" does not match ${SCRATCH_DATABASE_PATTERN}; `
        + 'these tests seed rows and install DDL, so they only run against a database created for them',
    }
  }
  if (input.optIn !== input.connectedDatabase) {
    return {
      ok: false,
      reason: `${SCRATCH_DATABASE_OPT_IN_ENV} must name the connected database exactly `
        + `("${input.connectedDatabase}"); it is ${input.optIn === undefined ? 'unset' : `"${input.optIn}"`}`,
    }
  }
  return { ok: true }
}

let verified: Promise<string> | null = null

/**
 * Resolve to the verified scratch database name, or throw before anything has been
 * written. Memoised per process: the URL cannot change underneath a test run, and the
 * application pool is created from the same environment afterwards.
 */
export function assertScratchDatabaseBeforeAnyWrite(): Promise<string> {
  verified ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new NotAScratchDatabaseError('DATABASE_URL is not set')

    const { default: pg } = await import('pg')
    const client = new pg.Client({
      connectionString: databaseUrl,
      options: '-c default_transaction_read_only=on',
      application_name: 'o3d-scratch-database-guard',
    })
    await client.connect()
    let connectedDatabase: string
    try {
      const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name')
      connectedDatabase = String(rows[0]!.name)
    } finally {
      await client.end().catch(() => {})
    }

    const verdict = scratchDatabaseVerdict({
      connectedDatabase,
      optIn: process.env[SCRATCH_DATABASE_OPT_IN_ENV],
    })
    if (!verdict.ok) throw new NotAScratchDatabaseError(`REFUSING before any write: ${verdict.reason}`)
    return connectedDatabase
  })()
  return verified
}
