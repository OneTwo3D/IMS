import assert from 'node:assert/strict'
import test from 'node:test'

import { selectReorderPoCandidates } from '@/lib/domain/purchasing/reorder-po-planning'
import type { ReorderReportRow } from '@/lib/domain/inventory/replenishment-reports'

// audit-pcc0: the Create-PO button must draw quantities + supplier grouping straight
// from the Reorder Planning rows the operator selected — purchasable rows only, with
// a supplier, needing ≥1 whole unit, grouped by the report's chosen supplier.

function row(over: Partial<ReorderReportRow> & { productId: string }): ReorderReportRow {
  return {
    productId: over.productId,
    sku: over.sku ?? over.productId,
    productName: over.productName ?? over.productId,
    productType: over.productType ?? 'SIMPLE',
    categoryName: null,
    supplierId: over.supplierId === undefined ? 'sup-1' : over.supplierId,
    supplierName: over.supplierName ?? 'Supplier 1',
    supplierSku: null,
    stockUnit: 'pcs',
    availableQty: over.availableQty ?? '0',
    warehouseAvailabilityBreakdown: '',
    inboundOpenPoQty: '0',
    averageDailyDemand: '0',
    leadTimeDays: 7,
    safetyStockQty: '0',
    reorderPoint: '10',
    configuredReorderQty: '0',
    suggestedReorderQty: over.suggestedReorderQty ?? '5',
    abcClass: over.abcClass ?? 'C',
    urgency: over.urgency ?? 'reorder',
    neededFor: ['Direct sales'],
  }
}

test('groups selected purchasable rows by supplier with whole-unit quantities', () => {
  const rows = [
    row({ productId: 'p1', supplierId: 'sup-a', suggestedReorderQty: '5' }),
    row({ productId: 'p2', supplierId: 'sup-a', suggestedReorderQty: '8' }),
    row({ productId: 'p3', supplierId: 'sup-b', suggestedReorderQty: '3' }),
  ]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['p1', 'p2', 'p3'])
  assert.deepEqual([...bySupplier.keys()].sort(), ['sup-a', 'sup-b'])
  assert.deepEqual(bySupplier.get('sup-a')?.map((c) => [c.row.productId, c.qty]), [['p1', 5], ['p2', 8]])
  assert.deepEqual(bySupplier.get('sup-b')?.map((c) => [c.row.productId, c.qty]), [['p3', 3]])
  assert.deepEqual(skipped, [])
})

test('reports (never drops) selections that cannot become a PO line', () => {
  const rows = [
    row({ productId: 'bom', productType: 'BOM', supplierId: null, suggestedReorderQty: '9' }),
    row({ productId: 'no-sup', supplierId: null, suggestedReorderQty: '5' }),
    row({ productId: 'zero', suggestedReorderQty: '0' }),
    row({ productId: 'ok', suggestedReorderQty: '4' }),
  ]
  // 'gone' is selected but absent from the recomputed report.
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['bom', 'no-sup', 'zero', 'ok', 'gone'])
  assert.deepEqual(bySupplier.get('sup-1')?.map((c) => c.row.productId), ['ok'])
  assert.deepEqual(
    skipped.map((s) => [s.productId, s.reason]).sort(),
    [['bom', 'not_purchasable'], ['gone', 'not_in_report'], ['no-sup', 'no_supplier'], ['zero', 'no_positive_qty']],
  )
})

test('rejects non-finite suggested quantities (NaN / Infinity)', () => {
  const rows = [
    row({ productId: 'nan', suggestedReorderQty: 'NaN' }),
    row({ productId: 'inf', suggestedReorderQty: 'Infinity' }),
  ]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['nan', 'inf'])
  assert.equal([...bySupplier.values()].flat().length, 0)
  assert.deepEqual(skipped.map((s) => s.reason), ['no_positive_qty', 'no_positive_qty'])
})

test('excludes rows the operator did not select', () => {
  const rows = [row({ productId: 'p1' }), row({ productId: 'p2' })]
  const { bySupplier } = selectReorderPoCandidates(rows, ['p1'])
  assert.deepEqual(bySupplier.get('sup-1')?.map((c) => c.row.productId), ['p1'])
})
