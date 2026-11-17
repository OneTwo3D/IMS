import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

// Grouped view of Reorder Planning: the rows are laid out supplier by supplier, because purchase orders are placed
// supplier by supplier. Pure and display-only: nothing here changes which rows the report returns or how draft POs are
// generated (that stays in reorder-po-planning.ts). Groups are computed from the rows the report returned for the
// current filters, so changing the location filter changes the rows and therefore every group and total.
//
// A group never merges rows across lead times: each row keeps its own leadTimeDays and latestPoDate, and the group only
// adds up the recommended quantity.

export type ReorderGroupableRow = {
  productId: string
  productType: string
  supplierId: string | null
  supplierName: string | null
  suggestedReorderQty: string
}

export type ReorderGroupKind = 'supplier' | 'manufactured' | 'no_supplier'

export type ReorderSupplierGroup<Row extends ReorderGroupableRow> = {
  /** Stable key: `supplier:<id>`, `manufactured:<label>` or `no-supplier`. */
  key: string
  kind: ReorderGroupKind
  /** Supplier name, the manufactured label ('Manufactured by X' / 'Manufactured in-house'), or 'No supplier'. */
  label: string
  rows: Row[]
  /** Sum of the rows' suggestedReorderQty, as a plain decimal string (same format as the report's own totals). */
  totalSuggestedQty: string
}

/** A row with no usable supplier: a purchased product with neither a supplier id nor a supplier name. */
function hasNoSupplier(row: ReorderGroupableRow): boolean {
  if (row.productType === 'BOM') return false
  if (row.supplierId) return false
  const name = row.supplierName?.trim()
  return !name || name === 'Unassigned'
}

function groupOf(row: ReorderGroupableRow): { key: string; kind: ReorderGroupKind; label: string } {
  if (row.productType === 'BOM') {
    const label = row.supplierName?.trim() || 'Manufactured in-house'
    return { key: `manufactured:${label}`, kind: 'manufactured', label }
  }
  if (hasNoSupplier(row)) return { key: 'no-supplier', kind: 'no_supplier', label: 'No supplier' }
  return row.supplierId
    ? { key: `supplier:${row.supplierId}`, kind: 'supplier', label: row.supplierName?.trim() || row.supplierId }
    : { key: `supplier-name:${row.supplierName!.trim()}`, kind: 'supplier', label: row.supplierName!.trim() }
}

const KIND_ORDER: Record<ReorderGroupKind, number> = { supplier: 0, manufactured: 1, no_supplier: 2 }

/**
 * Groups rows by supplier. Supplier groups come first (by name), then manufactured-product groups, and the
 * no-supplier warning group is always last so it is not buried. Rows keep the report's order inside a group.
 */
export function groupReorderRowsBySupplier<Row extends ReorderGroupableRow>(rows: Row[]): ReorderSupplierGroup<Row>[] {
  const byKey = new Map<string, ReorderSupplierGroup<Row>>()
  for (const row of rows) {
    const g = groupOf(row)
    let group = byKey.get(g.key)
    if (!group) {
      group = { key: g.key, kind: g.kind, label: g.label, rows: [], totalSuggestedQty: '0' }
      byKey.set(g.key, group)
    }
    group.rows.push(row)
  }
  const groups = [...byKey.values()]
  for (const group of groups) {
    group.totalSuggestedQty = roundQuantity(
      group.rows.reduce((sum, row) => sum.plus(toDecimal(row.suggestedReorderQty || '0')), toDecimal(0)),
      6,
    ).toString()
  }
  return groups.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label))
}
