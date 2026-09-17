/**
 * REFUSE TO TOUCH ANY DATABASE THAT WAS NOT MADE FOR THIS RUN — AND DO IT BEFORE
 * ANYTHING WRITES (o3d-zzgp round 4, Codex HIGH-2; widened in round 5).
 *
 * Round 3's race test checked `current_database() <> 'onetwo3d_ims_dev'` AFTER it had
 * already seeded products, warehouses, a transfer, stock and an active WMS binding —
 * so the one database it named was mutated before the refusal, and every OTHER database
 * (a shared one, a production one) passed the check and went on to receive DDL. That is
 * the shape that once put 335 fixture rows into the live-served development database.
 * Running FIRST, on a read-only connection, is the half that made that a P1 fix and is
 * unchanged.
 *
 * THE PROPERTY IS "THIS DATABASE WAS CREATED FOR THIS RUN AND IS DISPOSABLE". Round 4
 * accepted only one proxy for it — an `ims_scratch_*` NAME — and CI's own purpose-built,
 * thrown-away `ims_ci` database has that property while having a different name, so the
 * guard refused the one environment that most obviously satisfies it. A name is a proxy;
 * an explicit declaration naming the exact database is a statement. So either is accepted:
 *
 *   · DECLARED — `IMS_CONCURRENCY_SCRATCH_DB` names the connected database EXACTLY.
 *     Whoever configured the run said "this database is mine to destroy", about this
 *     database and no other. A flag that merely said "yes" would let a mistyped
 *     DATABASE_URL through; naming the database cannot.
 *   · CONVENTIONALLY NAMED — the connected database matches `SCRATCH_DATABASE_PATTERN`,
 *     for a local run that exports nothing.
 *
 * AND A DECLARATION CANNOT NAME A REAL DATABASE. `ALWAYS_REFUSED_DATABASE` is checked
 * FIRST and overrides both: this estate's own databases (`onetwo3d…`), the server's
 * built-ins, and any production-shaped name (`…prod…`, `…live…`) are refused however
 * they are declared. That is what stops the opt-in from becoming "an environment
 * variable can authorise anything", and it is why `onetwo3d_ims_dev` is refused even
 * when it is the value of `IMS_CONCURRENCY_SCRATCH_DB`.
 *
 * WHEN IT CANNOT TELL — no declaration and no scratch-shaped name — it refuses.
 *
 * The check runs on its own connection with `default_transaction_read_only=on`, so the
 * guard itself cannot write even if it is wrong, and it asks the SERVER which database
 * the URL reached rather than trusting the URL's path. Call it first in every test, before
 * importing anything that opens the application pool.
 */

export const SCRATCH_DATABASE_PATTERN = /^ims_scratch_[a-z0-9_]{1,48}$/
export const SCRATCH_DATABASE_OPT_IN_ENV = 'IMS_CONCURRENCY_SCRATCH_DB'

/**
 * Databases no declaration may nominate: every real database in this estate is named
 * `onetwo3d…`, `postgres`/`template…` are the server's own, and a name whose first or any
 * underscore-separated part begins `prod`/`live` is production-shaped. Matched on part
 * boundaries so an innocent scratch name (`ims_scratch_delivery`) is not caught by the
 * letters inside it.
 */
export const ALWAYS_REFUSED_DATABASE = /^(postgres|template\d+)$|^onetwo3d|(^|_)(prod|live)/i

export class NotAScratchDatabaseError extends Error {
  override readonly name = 'NotAScratchDatabaseError'
}

/** The pure decision, exported so the refusal paths can be tested without a server. */
export function scratchDatabaseVerdict(input: {
  connectedDatabase: string
  optIn: string | undefined
}): { ok: true } | { ok: false; reason: string } {
  // FIRST, and beyond appeal: a declaration may not nominate one of these.
  if (ALWAYS_REFUSED_DATABASE.test(input.connectedDatabase)) {
    return {
      ok: false,
      reason: `connected database "${input.connectedDatabase}" is a real or production-shaped database `
        + `(${ALWAYS_REFUSED_DATABASE}); these tests seed rows and install DDL, and no value of `
        + `${SCRATCH_DATABASE_OPT_IN_ENV} makes one of these acceptable`,
    }
  }
  // DECLARED: the run says this exact database was created for it and is disposable.
  if (input.optIn === input.connectedDatabase) return { ok: true }
  // Or CONVENTIONALLY NAMED, for a local run that exports nothing.
  if (SCRATCH_DATABASE_PATTERN.test(input.connectedDatabase)) return { ok: true }
  return {
    ok: false,
    reason: `connected database "${input.connectedDatabase}" is neither named ${SCRATCH_DATABASE_PATTERN} nor `
      + `declared disposable by ${SCRATCH_DATABASE_OPT_IN_ENV} (which is `
      + `${input.optIn === undefined ? 'unset' : `"${input.optIn}"`}); these tests seed rows and install DDL, `
      + `so set ${SCRATCH_DATABASE_OPT_IN_ENV}="${input.connectedDatabase}" only if that database was created `
      + 'for this run and can be thrown away',
  }
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
