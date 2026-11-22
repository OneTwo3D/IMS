/**
 * o3d-hvzdx: THE ORGANISATION'S XERO DAY ALLOWANCE AS EVERY WORKER LAST SAW IT.
 *
 * Xero answers every API response with X-DayLimit-Remaining: the organisation's calls left in its rolling 24 hours, counting every caller
 * (every IMS worker, Xeroom, anything else on the tenant). The Xero client keeps that per process (api.ts noteLimitHeaders), so a worker that
 * has not called Xero yet knows nothing and reads null. This persists the observation, one row per tenant, so that worker can read what the
 * others saw. Throttled per process; best effort (a failed write changes nothing for the call that observed it).
 *
 * A reader takes the LOWEST of what it knows: its own process's figures and every fresh shared row. A row older than
 * DAY_LIMIT_OBSERVATION_FRESH_MS says too little about now and is ignored; with nothing fresh the answer is null, which the callers treat as
 * low (they wait), never as plenty.
 */

/** A shared observation older than this is not used (the allowance may have been spent since). */
export const DAY_LIMIT_OBSERVATION_FRESH_MS = 60 * 60_000
/** At most one write per tenant per process in this interval, unless the figure has fallen to the warning level. */
export const DAY_LIMIT_PERSIST_INTERVAL_MS = 15_000
const LOW_WATERMARK = 100

const lastPersistAt = new Map<string, number>()

type RawClient = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>
}

async function defaultClient(): Promise<RawClient> {
  const { db } = await import('@/lib/db')
  return db as unknown as RawClient
}

/** Record what Xero said is left for `tenantId`. Returns whether a write was made (throttled ones are not). Never throws. */
export async function persistDayLimitObservation(
  tenantId: string,
  dayRemaining: number,
  at: number = Date.now(),
  client?: RawClient,
): Promise<boolean> {
  if (!tenantId || !Number.isFinite(dayRemaining)) return false
  const last = lastPersistAt.get(tenantId)
  if (last !== undefined && at - last < DAY_LIMIT_PERSIST_INTERVAL_MS && dayRemaining > LOW_WATERMARK) return false
  lastPersistAt.set(tenantId, at)
  try {
    const c = client ?? await defaultClient()
    const observedAt = new Date(at)
    // An older observation never overwrites a newer one (two workers writing out of order).
    await c.$executeRaw`
      INSERT INTO "xero_day_limit_observations" ("tenant_id", "day_remaining", "observed_at") VALUES (${tenantId}, ${Math.trunc(dayRemaining)}, ${observedAt})
      ON CONFLICT ("tenant_id") DO UPDATE SET "day_remaining" = EXCLUDED."day_remaining", "observed_at" = EXCLUDED."observed_at"
        WHERE "xero_day_limit_observations"."observed_at" <= EXCLUDED."observed_at"`
    return true
  } catch {
    return false
  }
}

/** The fewest calls left across every tenant's FRESH shared observation, or null when there is none. Throws if the table cannot be read. */
export async function sharedDayCallsRemaining(now: number = Date.now(), client?: RawClient): Promise<number | null> {
  const c = client ?? await defaultClient()
  const since = new Date(now - DAY_LIMIT_OBSERVATION_FRESH_MS)
  const rows = await c.$queryRaw<Array<{ remaining: number | null }>>`
    SELECT MIN("day_remaining")::int AS remaining FROM "xero_day_limit_observations" WHERE "observed_at" >= ${since}`
  const value = rows[0]?.remaining
  return value === null || value === undefined ? null : Number(value)
}

/**
 * What the invoice-document sweep reads: the lower of this process's own figure and the shared one. Null (unknown, so the caller waits) when there
 * is no fresh shared observation or it cannot be read: every worker that called Xero within the freshness window has written one, so a process's
 * own figure alone (possibly hours old, and blind to the others) is not taken as the answer.
 */
export async function organisationDayCallsRemaining(local: number | null, now: number = Date.now(), client?: RawClient): Promise<number | null> {
  let shared: number | null
  try {
    shared = await sharedDayCallsRemaining(now, client)
  } catch {
    return null
  }
  if (shared === null) return null
  return local === null ? shared : Math.min(local, shared)
}

/** Test seam: forget the per-process throttle. */
export function resetDayLimitPersistThrottleForTests(): void {
  lastPersistAt.clear()
}
