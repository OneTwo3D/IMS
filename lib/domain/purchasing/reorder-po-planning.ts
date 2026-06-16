import type { ReorderReportRow } from '@/lib/domain/inventory/replenishment-reports'

// audit-pcc0: pure selection used by createReorderPOs so draft-PO quantities come
// straight from the Reorder Planning rows the operator is looking at — keeping the
// DB-bound action thin and this decision unit-testable. Mirrors the MO path's
// "no silent drops" contract: every selected product either becomes a candidate or
// is reported with a structured skip reason.

export type ReorderPoCandidate = {
  row: ReorderReportRow
  supplierId: string
  qty: number
}

export type ReorderPoSkipReason = 'not_in_report' | 'not_purchasable' | 'no_supplier' | 'no_positive_qty'
export type ReorderPoSkip = { productId: string; sku?: string; reason: ReorderPoSkipReason }

export type ReorderPoSelection = {
  bySupplier: Map<string, ReorderPoCandidate[]>
  skipped: ReorderPoSkip[]
}

/**
 * From the report rows, keep the operator's selected products that are purchasable
 * (not BOM-manufactured), have a resolved supplier, and need at least one whole unit
 * reordered — grouped by the report's chosen (lowest-cost) supplier so each group
 * becomes one draft purchase order. Quantity is the whole-unit suggestedReorderQty.
 * Selections that can't become a PO line are returned in `skipped` (never dropped).
 */
export function selectReorderPoCandidates(
  rows: ReorderReportRow[],
  selectedProductIds: string[],
): ReorderPoSelection {
  const rowById = new Map(rows.map((row) => [row.productId, row]))
  const bySupplier = new Map<string, ReorderPoCandidate[]>()
  const skipped: ReorderPoSkip[] = []

  for (const productId of selectedProductIds) {
    const row = rowById.get(productId)
    if (!row) { skipped.push({ productId, reason: 'not_in_report' }); continue }
    if (row.productType === 'BOM') { skipped.push({ productId, sku: row.sku, reason: 'not_purchasable' }); continue }
    if (!row.supplierId) { skipped.push({ productId, sku: row.sku, reason: 'no_supplier' }); continue }
    const qty = Number(row.suggestedReorderQty)
    if (!Number.isFinite(qty) || qty < 1) { skipped.push({ productId, sku: row.sku, reason: 'no_positive_qty' }); continue }
    const list = bySupplier.get(row.supplierId) ?? []
    list.push({ row, supplierId: row.supplierId, qty })
    bySupplier.set(row.supplierId, list)
  }

  return { bySupplier, skipped }
}
