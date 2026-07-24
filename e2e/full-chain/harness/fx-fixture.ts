/**
 * FX-rate fixtures for the full-chain tier.
 *
 * The rig keeps `fx_rates` EMPTY as its baseline, which is load-bearing in both directions:
 *   - nothing foreign can be raised without a seed (createPurchaseOrder THROWS "Missing … FX rate", and
 *     the WC importer refuses a foreign order), so a foreign scenario MUST seed its own rate first;
 *   - a rate left behind would silently become the booked rate for a LATER test's foreign document, so
 *     every seed is removed in a finally, with global-setup's sweepSeededFxRates() as the crash net
 *     (that sweep keys on source = 'e2e-fc-seed', so never seed with a different source).
 *
 * Lives in the harness rather than in one spec because more than one scenario needs it: PP-08 seeds a
 * booked rate and then a later settlement rate to realise an FX gain on payment, and X-03 seeds a
 * divergent rate to create an unrealised movement for the period-end revaluation.
 */
import { Client, type QueryResultRow } from 'pg'

/** Run a read query against this instance and return its rows. */
export async function queryRows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    const r = await db.query<T>(sql, params)
    return r.rows
  } finally {
    await db.end()
  }
}

/**
 * Seed a base(GBP)->foreign FX rate with an explicit `fetchedAt` SQL expression (e.g. "now()" or
 * "now() - interval '2 hours'"), so a test can control rate ORDERING precisely — PP-08 seeds the
 * settlement rate with a LATER fetchedAt than the booked rate, because resolveSettlementFxRateToBase
 * takes the latest fetchedAt <= asOf. Explicit ordering is what makes those tests independent of
 * wall-clock timing.
 *
 * The fetchedAt expression is interpolated, so it must always be a fixed test literal, never external
 * input; the currency and rate are bound as parameters.
 */
export async function seedFxRateAt(toCurrency: string, rate: number, fetchedAtSql: string): Promise<string> {
  const { randomUUID } = await import('node:crypto')
  const id = `e2e-fc-fx-${randomUUID()}`
  await queryRows(
    `insert into fx_rates (id, "fromCurrency", "toCurrency", rate, "fetchedAt", source, "manualOverride")
     values ($1, 'GBP', $2, $3, ${fetchedAtSql}, 'e2e-fc-seed', false)`,
    [id, toCurrency.toUpperCase(), rate],
  )
  return id
}

/**
 * Remove a seeded FX rate to restore the rig's empty-fx_rates baseline. Never throws (it runs in a
 * finally and must not mask a test result) but is not silent: a residual seeded rate would let a later
 * foreign order/PO book at this artificial rate. global-setup's sweep is the recovery net.
 */
export async function deleteFxRate(id: string): Promise<void> {
  try {
    const rows = await queryRows<{ id: string }>(`delete from fx_rates where id = $1 returning id`, [id])
    if (rows.length !== 1) {
      console.warn(`[fx-fixture] deleteFxRate(${id}) removed ${rows.length} row(s), expected 1 — global-setup will sweep it next run`)
    }
  } catch (e) {
    console.warn(`[fx-fixture] deleteFxRate(${id}) failed: ${e instanceof Error ? e.message : String(e)} — global-setup will sweep it next run`)
  }
}
