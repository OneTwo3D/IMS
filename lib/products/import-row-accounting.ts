/**
 * Row accounting for the product CSV import's component pass (pass 2).
 *
 * Pass 1 counts every row once: created, updated or skipped, and COMMITS the product write. Pass 2
 * (components / BOM recipe) runs afterwards and may still refuse a row's component list (invalid
 * cell, cycle, in-flight sales, type changed, recipe refusal, fault). The product write is not rolled
 * back, so the row stays in created/updated — it is not "skipped" — and the refusal is counted
 * separately in `componentsFailed`, exactly once per row (the BOM-cycle refusal used to be counted a
 * second time as skipped; the other refusals were not counted anywhere). Any component failure makes
 * the result unsuccessful.
 */
export type ImportCounters = { created: number; updated: number; skipped: number; componentsFailed?: number }

export type ComponentPassRow = {
  lineNum: number
  sku: string
  productId: string
  components: string
  /** The pass-1 counter this row was counted in (informational; it is never changed by pass 2). */
  rowOutcome: 'created' | 'updated'
  /** True once the row's component failure has been counted; makes the count idempotent. */
  componentFailureCounted: boolean
}

export function recordComponentRowFailure(counters: ImportCounters, row: ComponentPassRow): void {
  if (row.componentFailureCounted) return
  row.componentFailureCounted = true
  counters.componentsFailed = (counters.componentsFailed ?? 0) + 1
}
