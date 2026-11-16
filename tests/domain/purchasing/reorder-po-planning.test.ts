import assert from 'node:assert/strict'
import test from 'node:test'

import {
  earliestLineDelivery,
  reorderLineExpectedDelivery,
  sanitizeSupplierOverrides,
  selectReorderPoCandidates,
} from '@/lib/domain/purchasing/reorder-po-planning'
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
    supplierOptions: over.supplierOptions ?? [],
    stockUnit: 'pcs',
    availableQty: over.availableQty ?? '0',
    warehouseAvailabilityBreakdown: '',
    inboundOpenPoQty: '0',
    averageDailyDemand: '0',
    leadTimeDays: over.leadTimeDays ?? 7,
    safetyStockQty: '0',
    reorderPoint: '10',
    configuredReorderQty: '0',
    suggestedReorderQty: over.suggestedReorderQty ?? '5',
    abcClass: over.abcClass ?? 'C',
    urgency: over.urgency ?? 'reorder',
    requiredReceiptDate: over.requiredReceiptDate === undefined ? null : over.requiredReceiptDate,
    latestPoDate: null,
    latestPoOverdue: false,
    timingBasis: 'no_demand',
    lateInboundQty: '0',
    lateInboundDueDate: null,
    reorderNote: null,
    firstShortageDate: null,
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

const opt = (supplierId: string) => ({ supplierId, supplierName: supplierId, supplierSku: null })

test('a supplier override groups the line into the chosen supplier and is flagged', () => {
  const rows = [
    row({ productId: 'p1', supplierId: 'sup-a', supplierOptions: [opt('sup-a'), opt('sup-b')] }),
    row({ productId: 'p2', supplierId: 'sup-a', supplierOptions: [opt('sup-a'), opt('sup-b')] }),
    row({ productId: 'p3', supplierId: 'sup-b', supplierOptions: [opt('sup-b')] }),
  ]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['p1', 'p2', 'p3'], { supplierOverrides: { p1: 'sup-b' } })
  assert.deepEqual(skipped, [])
  assert.deepEqual(bySupplier.get('sup-a')?.map((c) => [c.row.productId, c.supplierOverridden]), [['p2', false]])
  assert.deepEqual(bySupplier.get('sup-b')?.map((c) => [c.row.productId, c.supplierId, c.supplierOverridden]), [['p1', 'sup-b', true], ['p3', 'sup-b', false]])
})

test('an override equal to the default supplier is not an override', () => {
  const rows = [row({ productId: 'p1', supplierId: 'sup-a', supplierOptions: [] })]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['p1'], { supplierOverrides: { p1: 'sup-a' } })
  assert.deepEqual(skipped, [])
  assert.equal(bySupplier.get('sup-a')?.[0].supplierOverridden, false)
})

test('an override outside the product catalog is skipped, never silently replaced by the default', () => {
  const rows = [row({ productId: 'p1', supplierId: 'sup-a', supplierOptions: [opt('sup-a')] })]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['p1'], { supplierOverrides: { p1: 'sup-zzz' } })
  assert.equal(bySupplier.size, 0)
  assert.deepEqual(skipped, [{ productId: 'p1', sku: 'p1', reason: 'supplier_override_not_in_catalog' }])
})

test('an override on a BOM row cannot make it purchasable', () => {
  const rows = [row({ productId: 'bom', productType: 'BOM', supplierId: null, supplierOptions: [opt('sup-b')] })]
  const { bySupplier, skipped } = selectReorderPoCandidates(rows, ['bom'], { supplierOverrides: { bom: 'sup-b' } })
  assert.equal(bySupplier.size, 0)
  assert.deepEqual(skipped, [{ productId: 'bom', sku: 'bom', reason: 'not_purchasable' }])
})

test('no overrides given: selection is unchanged', () => {
  const rows = [row({ productId: 'p1', supplierId: 'sup-a' })]
  assert.deepEqual(selectReorderPoCandidates(rows, ['p1']), selectReorderPoCandidates(rows, ['p1'], { supplierOverrides: {} }))
})

test('sanitizeSupplierOverrides keeps only own, selected-product, non-empty string entries', () => {
  const raw = JSON.parse('{"p1":"sup-b","p2":"","p3":5,"p4":"x","__proto__":"evil","  ":"s"}')
  const clean = sanitizeSupplierOverrides(raw, ['p1', 'p2', 'p3', '__proto__'])
  assert.deepEqual(Object.entries(clean).sort(), [['__proto__', 'evil'], ['p1', 'sup-b']])
  assert.equal(Object.getPrototypeOf(clean), Object.prototype)
  for (const bad of [null, undefined, 'x', 7, ['p1']]) assert.deepEqual(sanitizeSupplierOverrides(bad, ['p1']), {})
})

test('sanitizeSupplierOverrides caps the entry count', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `p${i}`)
  const raw = Object.fromEntries(ids.map((id) => [id, 'sup']))
  assert.equal(Object.keys(sanitizeSupplierOverrides(raw, ids)).length, 250)
})

const NOW = new Date('2026-11-16T15:30:00.000Z')

test('line delivery is the required receipt date when it is after today + lead time', () => {
  const r = reorderLineExpectedDelivery({ requiredReceiptDate: '2026-12-31', leadTimeDays: 10 }, NOW)
  assert.equal(r.expectedDelivery?.toISOString(), '2026-12-31T00:00:00.000Z')
  assert.equal(r.clamped, false)
  assert.equal(r.rawRequiredReceiptDate, '2026-12-31')
  assert.equal(r.earliestPossibleDate, '2026-11-26')
})

test('an overdue row (required date in the past) is clamped to today + lead time', () => {
  const r = reorderLineExpectedDelivery({ requiredReceiptDate: '2026-11-01', leadTimeDays: 14 }, NOW)
  assert.equal(r.expectedDelivery?.toISOString(), '2026-11-30T00:00:00.000Z')
  assert.equal(r.clamped, true)
  assert.equal(r.rawRequiredReceiptDate, '2026-11-01')
})

test('a required date exactly at today + lead time is not reported as clamped', () => {
  const r = reorderLineExpectedDelivery({ requiredReceiptDate: '2026-11-30', leadTimeDays: 14 }, NOW)
  assert.equal(r.expectedDelivery?.toISOString(), '2026-11-30T00:00:00.000Z')
  assert.equal(r.clamped, false)
})

test('no required receipt date leaves the line undated', () => {
  const r = reorderLineExpectedDelivery({ requiredReceiptDate: null, leadTimeDays: 14 }, NOW)
  assert.equal(r.expectedDelivery, null)
  assert.equal(r.clamped, false)
  assert.equal(r.rawRequiredReceiptDate, null)
})

test('header date is the earliest dated line, null when none is dated', () => {
  const a = new Date('2026-12-05T00:00:00.000Z')
  const b = new Date('2026-11-30T00:00:00.000Z')
  assert.equal(earliestLineDelivery([a, null, b])?.toISOString(), b.toISOString())
  assert.equal(earliestLineDelivery([null, null]), null)
  assert.equal(earliestLineDelivery([]), null)
})
