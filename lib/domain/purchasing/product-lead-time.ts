import { db } from '@/lib/db'
import { getObservedLeadTimeP95ByProduct } from './purchasing-analytics'

type ObservedRow = { id: string; observedLeadTimeDays: number | null }

/**
 * Pure decision: given the freshly observed P95 map and the products that currently
 * hold an observed value, work out which products to UPDATE (changed value) and which
 * to CLEAR (had an observed value but no longer have receipts in the window). P95 is
 * rounded to whole days; non-positive results are ignored. Manual overrides
 * (Product.leadTimeDays) are out of scope here — only observedLeadTimeDays is touched.
 */
export function planObservedLeadTimeUpdates(
  observed: Map<string, number>,
  productsWithObserved: ObservedRow[],
): { updates: Array<{ id: string; days: number }>; clears: string[] } {
  const currentById = new Map(productsWithObserved.map((p) => [p.id, p.observedLeadTimeDays]))
  const updates: Array<{ id: string; days: number }> = []
  for (const [id, p95] of observed) {
    const days = Math.round(p95)
    if (!Number.isFinite(days) || days <= 0) continue
    if (currentById.get(id) === days) continue
    updates.push({ id, days })
  }
  const clears = productsWithObserved
    .filter((p) => p.observedLeadTimeDays != null && !observed.has(p.id))
    .map((p) => p.id)
  return { updates, clears }
}

/**
 * Recompute Product.observedLeadTimeDays from the trailing-365-day P95 of PO receipt
 * lead times. Persists only changed rows, and CLEARS the value for products whose
 * receipts have aged out of the window (so observed always reflects the window).
 * Per-row failures are counted, not fatal — the run is idempotent, so a re-run heals
 * partial writes. Drives the recompute-product-lead-times cron + initial backfill.
 */
export async function recomputeProductObservedLeadTimes(
  options: { now?: () => Date } = {},
): Promise<{ scanned: number; updated: number; cleared: number; failed: number }> {
  const observed = await getObservedLeadTimeP95ByProduct({ now: options.now })
  const productsWithObserved = await db.product.findMany({
    where: { observedLeadTimeDays: { not: null } },
    select: { id: true, observedLeadTimeDays: true },
  })
  const { updates, clears } = planObservedLeadTimeUpdates(observed, productsWithObserved)

  let updated = 0
  let cleared = 0
  let failed = 0
  for (const u of updates) {
    try { await db.product.update({ where: { id: u.id }, data: { observedLeadTimeDays: u.days } }); updated++ }
    catch { failed++ }
  }
  for (const id of clears) {
    try { await db.product.update({ where: { id }, data: { observedLeadTimeDays: null } }); cleared++ }
    catch { failed++ }
  }
  return { scanned: observed.size, updated, cleared, failed }
}
