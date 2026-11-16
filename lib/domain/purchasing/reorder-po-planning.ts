import type { ReorderReportRow } from '@/lib/domain/inventory/replenishment-reports'
import { MAX_SELECTED_IDS } from '@/lib/analytics/reorder-selection'
import { UTC_DAY_MS, dateOnly, startOfUtcDay } from '@/lib/domain/math/date-window'

// audit-pcc0: pure selection used by createReorderPOs so draft-PO quantities come
// straight from the Reorder Planning rows the operator is looking at — keeping the
// DB-bound action thin and this decision unit-testable. Mirrors the MO path's
// "no silent drops" contract: every selected product either becomes a candidate or
// is reported with a structured skip reason.

export type ReorderPoCandidate = {
  row: ReorderReportRow
  /** The supplier the draft goes to: the operator's override when one was given, else the row's default. */
  supplierId: string
  /** True when `supplierId` is an operator override that differs from the row's default supplier. */
  supplierOverridden: boolean
  qty: number
}

export type ReorderPoSkipReason =
  | 'not_in_report'
  | 'not_purchasable'
  | 'no_supplier'
  | 'no_positive_qty'
  | 'supplier_override_not_in_catalog'
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
  options: { supplierOverrides?: Record<string, string> } = {},
): ReorderPoSelection {
  const overrides = options.supplierOverrides ?? {}
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
    // A per-row override must be a catalog supplier of the product. A rejected override is reported, never
    // silently replaced by the default supplier (the order would go to a supplier the operator did not choose).
    const override = Object.hasOwn(overrides, productId) ? overrides[productId] : undefined
    const supplierOverridden = override !== undefined && override !== row.supplierId
    if (supplierOverridden && !row.supplierOptions.some((option) => option.supplierId === override)) {
      skipped.push({ productId, sku: row.sku, reason: 'supplier_override_not_in_catalog' })
      continue
    }
    const supplierId = supplierOverridden ? override : row.supplierId
    const list = bySupplier.get(supplierId) ?? []
    list.push({ row, supplierId, supplierOverridden, qty })
    bySupplier.set(supplierId, list)
  }

  return { bySupplier, skipped }
}

/**
 * Server actions cannot trust their argument: rebuild a clean productId -> supplierId map from untrusted input.
 * Keeps only own entries whose key is one of `allowedProductIds` and whose value is a non-empty string, capped at
 * MAX_SELECTED_IDS. Whether the supplier is a catalog supplier of the product is decided later, against the
 * report row, by selectReorderPoCandidates.
 */
export function sanitizeSupplierOverrides(raw: unknown, allowedProductIds: Iterable<string>): Record<string, string> {
  const clean: Record<string, string> = {}
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return clean
  const allowed = new Set(allowedProductIds)
  let count = 0
  for (const [productId, supplierId] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_SELECTED_IDS) break
    if (!allowed.has(productId)) continue
    if (typeof supplierId !== 'string' || supplierId.trim() === '') continue
    Object.defineProperty(clean, productId, { value: supplierId, enumerable: true, writable: true, configurable: true })
    count += 1
  }
  return clean
}

export type ReorderLineExpectedDelivery = {
  /** Date written to the draft line's expectedDelivery; null when the row has no required receipt date. */
  expectedDelivery: Date | null
  /** The row's requiredReceiptDate as read (YYYY-MM-DD), or null. */
  rawRequiredReceiptDate: string | null
  /** today + the row's lead time: the soonest a PO placed today can physically arrive. */
  earliestPossibleDate: string
  /** True when the required receipt date was earlier than earliestPossibleDate and was moved to it. */
  clamped: boolean
}

/**
 * Per-line estimated delivery for a draft PO line: the row's required receipt date, clamped to
 * today + lead time (an overdue row's required date is already in the past, and goods cannot arrive sooner than
 * the lead time). No required date (no-demand rows, beyond the horizon) leaves the line undated rather than
 * inventing one. `now` is injected for tests; dates are whole UTC days like the Reorder Planning columns.
 */
export function reorderLineExpectedDelivery(
  row: Pick<ReorderReportRow, 'requiredReceiptDate' | 'leadTimeDays'>,
  now: Date,
): ReorderLineExpectedDelivery {
  const earliest = new Date(startOfUtcDay(now).getTime() + Math.max(0, row.leadTimeDays) * UTC_DAY_MS)
  const raw = row.requiredReceiptDate
  const earliestPossibleDate = dateOnly(earliest)
  if (!raw) return { expectedDelivery: null, rawRequiredReceiptDate: null, earliestPossibleDate, clamped: false }
  const needed = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(needed.getTime())) return { expectedDelivery: null, rawRequiredReceiptDate: raw, earliestPossibleDate, clamped: false }
  const clamped = needed.getTime() < earliest.getTime()
  return { expectedDelivery: clamped ? earliest : needed, rawRequiredReceiptDate: raw, earliestPossibleDate, clamped }
}

/** PO header date: the earliest dated line (the soonest the order starts to matter), or null when no line is dated. */
export function earliestLineDelivery(dates: Array<Date | null>): Date | null {
  let min: Date | null = null
  for (const d of dates) {
    if (d && (min === null || d.getTime() < min.getTime())) min = d
  }
  return min
}
