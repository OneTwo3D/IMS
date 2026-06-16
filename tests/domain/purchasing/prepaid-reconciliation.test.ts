import assert from 'node:assert/strict'
import test from 'node:test'

import { computePrepaidReconciliation } from '@/lib/domain/purchasing/prepaid-reconciliation'

test('prepaid PO billed 100 / received 90 surfaces a shortfall of 10', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90, qtyReturned: 0 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.hasShortfall, true)
  assert.equal(summary.totalShortfallQty, '10')
  assert.equal(summary.totalShortfallValueBase, '100')
})

test('returns are NOT counted as non-delivery: billed 100, received 100, returned 10 → no shortfall', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 10 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  // All 100 were delivered (then 10 returned → handled by the auto credit note),
  // so the prepaid "not arrived" banner stays silent — it only flags genuine
  // non-delivery (billed − received).
  assert.equal(summary.hasShortfall, false)
  assert.equal(summary.totalShortfallQty, '0')
})

test('only genuine non-delivery counts; returns are ignored: billed 100, received 90, returned 5 → shortfall 10', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90, qtyReturned: 5 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  // 10 never arrived (billed 100 − received 90); the 5 returned are not added.
  assert.equal(summary.hasShortfall, true)
  assert.equal(summary.totalShortfallQty, '10')
  assert.equal(summary.lines[0].receivedQty, '90')
})

test('pay-on-receipt (non-prepaid) supplier never surfaces the banner', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: false,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90, qtyReturned: 0 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.isPrepaidSupplier, false)
  assert.equal(summary.hasShortfall, false)
  assert.deepEqual(summary.lines, [])
})

test('fully reconciled prepaid PO (billed == net received) shows nothing', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 0 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.hasShortfall, false)
  assert.equal(summary.totalShortfallQty, '0')
})

test('under-billed prepaid PO (net received > billed) flags a balancing bill, no shortfall', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 0 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 80, totalBase: 800 }] }],
  })
  assert.equal(summary.hasShortfall, false)
  assert.equal(summary.hasUnderBilled, true)
})

test('freight/cost invoice lines with no poLineId are excluded from billed', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90, qtyReturned: 0 }],
    invoices: [{ lines: [
      { poLineId: 'l1', qtyBilled: 100, totalBase: 1000 },
      { poLineId: null, qtyBilled: 1, totalBase: 150 },
    ] }],
  })
  assert.equal(summary.totalShortfallQty, '10')
  assert.equal(summary.totalShortfallValueBase, '100')
})

test('multi-line: only the shortfall line appears', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [
      { id: 'l1', productId: 'p1', sku: 'A', qtyReceived: 90, qtyReturned: 0 },
      { id: 'l2', productId: 'p2', sku: 'B', qtyReceived: 50, qtyReturned: 0 },
    ],
    invoices: [{ lines: [
      { poLineId: 'l1', qtyBilled: 100, totalBase: 1000 },
      { poLineId: 'l2', qtyBilled: 50, totalBase: 500 },
    ] }],
  })
  assert.equal(summary.lines.length, 1)
  assert.equal(summary.lines[0].poLineId, 'l1')
})

test('aggregates billed across multiple bills per line', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 50, qtyReturned: 0 }],
    invoices: [
      { lines: [{ poLineId: 'l1', qtyBilled: 40, totalBase: 400 }] },
      { lines: [{ poLineId: 'l1', qtyBilled: 30, totalBase: 300 }] },
    ],
  })
  assert.equal(summary.totalShortfallQty, '20')
  assert.equal(summary.totalShortfallValueBase, '200')
})
