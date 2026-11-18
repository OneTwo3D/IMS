/**
 * Row accounting for the product CSV import's component pass (pass 2).
 *
 * Pass 1 counts every row once: created, updated or skipped. A KIT/BOM row that landed in pass 1 is
 * then counted created/updated, and pass 2 may still refuse its component list (invalid cell,
 * cycle, in-flight sales, type changed, recipe refusal, fault). Such a row did not fully land, so it
 * moves from created/updated to skipped — exactly once — instead of being counted a second time
 * (the BOM-cycle refusal used to add a skip on top of its created/updated) or not at all (every other
 * pass-2 refusal used to leave the skipped counter untouched).
 */
export type ImportCounters = { created: number; updated: number; skipped: number }

export type ComponentPassRow = {
  lineNum: number
  sku: string
  productId: string
  components: string
  /** The pass-1 counter this row was counted in. */
  rowOutcome: 'created' | 'updated'
  /** True once the row has been moved to skipped; makes the move idempotent. */
  demoted: boolean
}

export function demoteComponentRowToSkipped(counters: ImportCounters, row: ComponentPassRow): void {
  if (row.demoted) return
  row.demoted = true
  counters[row.rowOutcome] -= 1
  counters.skipped += 1
}
