import assert from 'node:assert/strict'
import test from 'node:test'

import { computePrepaidReconciliation } from '@/lib/domain/purchasing/prepaid-reconciliation'

test('prepaid PO billed 100 / received 90 surfaces a shortfall of 10', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.isPrepaidSupplier, true)
  assert.equal(summary.hasShortfall, true)
  assert.equal(summary.totalShortfallQty, '10')
  // avg unit £10 × 10 = £100
  assert.equal(summary.totalShortfallValueBase, '100')
  assert.equal(summary.lines[0].shortfallValueBase, '100')
})

test('pay-on-receipt (non-prepaid) supplier never surfaces the banner', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: false,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 90 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.isPrepaidSupplier, false)
  assert.equal(summary.hasShortfall, false)
  assert.deepEqual(summary.lines, [])
})

test('fully reconciled prepaid PO (billed == received) shows nothing', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 100, totalBase: 1000 }] }],
  })
  assert.equal(summary.hasShortfall, false)
  assert.equal(summary.totalShortfallQty, '0')
})

test('under-billed prepaid PO (received > billed) flags a balancing bill due, no shortfall', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100 }],
    invoices: [{ lines: [{ poLineId: 'l1', qtyBilled: 80, totalBase: 800 }] }],
  })
  assert.equal(summary.hasShortfall, false)
  assert.equal(summary.hasUnderBilled, true)
})

test('aggregates billed across multiple bills per line', () => {
  const summary = computePrepaidReconciliation({
    isPrepaidSupplier: true,
    lines: [{ id: 'l1', productId: 'p1', sku: 'SKU-1', qtyReceived: 50 }],
    invoices: [
      { lines: [{ poLineId: 'l1', qtyBilled: 40, totalBase: 400 }] },
      { lines: [{ poLineId: 'l1', qtyBilled: 30, totalBase: 300 }] },
    ],
  })
  // billed 70, received 50 → shortfall 20 @ avg £10 = £200
  assert.equal(summary.totalShortfallQty, '20')
  assert.equal(summary.totalShortfallValueBase, '200')
})
