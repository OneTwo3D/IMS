import assert from 'node:assert/strict'
import test from 'node:test'

import { computePurchaseOrderOverBilling } from '@/lib/domain/purchasing/purchasing-reversal-alerts'

test('flags a line billed beyond what is kept after a return', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [
      // billed 100, kept 70 (100 received − 30 returned) => 30 over-billed
      { id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 30 },
    ],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 1000, lines: [{ poLineId: 'pol-1', qtyBilled: 100, totalBase: 1000 }] },
    ],
  })
  assert.equal(summary.hasInvoices, true)
  assert.equal(summary.hasOverBilling, true)
  assert.equal(summary.totalOverBilledQty, '30')
  // avg unit cost £10 × 30 = £300
  assert.equal(summary.totalOverBilledValueBase, '300')
  assert.equal(summary.lines.length, 1)
  assert.equal(summary.lines[0].overBilledValueBase, '300')
  assert.deepEqual(summary.bills, [{ invoiceId: 'inv-1', invoiceNumber: 'BILL-1', totalBase: '1000' }])
})

test('no over-billing when billed quantity does not exceed kept quantity', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [{ id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 30 }],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 700, lines: [{ poLineId: 'pol-1', qtyBilled: 70, totalBase: 700 }] },
    ],
  })
  assert.equal(summary.hasInvoices, true)
  assert.equal(summary.hasOverBilling, false)
  assert.equal(summary.totalOverBilledQty, '0')
  assert.equal(summary.lines.length, 0)
})

test('reports no invoices when the PO is unbilled', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [{ id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 100, qtyReturned: 100 }],
    invoices: [],
  })
  assert.equal(summary.hasInvoices, false)
  assert.equal(summary.hasOverBilling, false)
})

test('aggregates billed quantity across multiple bills for one line', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [{ id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 50, qtyReturned: 50 }],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 300, lines: [{ poLineId: 'pol-1', qtyBilled: 30, totalBase: 300 }] },
      { id: 'inv-2', invoiceNumber: 'BILL-2', totalBase: 200, lines: [{ poLineId: 'pol-1', qtyBilled: 20, totalBase: 200 }] },
    ],
  })
  // billed 50 across two bills, kept 0 => 50 over-billed @ avg £10 = £500
  assert.equal(summary.hasOverBilling, true)
  assert.equal(summary.totalOverBilledQty, '50')
  assert.equal(summary.totalOverBilledValueBase, '500')
  assert.equal(summary.bills.length, 2)
})

test('names only the bills that billed an over-billed line', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [
      // line A: over-billed (billed 10 via inv-1, kept 0)
      { id: 'pol-A', productId: 'pA', sku: 'A', qtyReceived: 10, qtyReturned: 10 },
      // line B: correctly billed (billed 5 via inv-2, kept 5)
      { id: 'pol-B', productId: 'pB', sku: 'B', qtyReceived: 5, qtyReturned: 0 },
    ],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 100, lines: [{ poLineId: 'pol-A', qtyBilled: 10, totalBase: 100 }] },
      { id: 'inv-2', invoiceNumber: 'BILL-2', totalBase: 50, lines: [{ poLineId: 'pol-B', qtyBilled: 5, totalBase: 50 }] },
    ],
  })
  assert.equal(summary.hasOverBilling, true)
  // Only inv-1 contributed to an over-billed line; inv-2 must not be named.
  assert.deepEqual(summary.bills.map((b) => b.invoiceNumber), ['BILL-1'])
})

test('clamps a corrupt qtyReturned > qtyReceived so it does not inflate over-billing', () => {
  const summary = computePurchaseOrderOverBilling({
    // billed 10, received 5 but qtyReturned 8 (corrupt) → netReceived clamps to 0, not -3
    lines: [{ id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 5, qtyReturned: 8 }],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 100, lines: [{ poLineId: 'pol-1', qtyBilled: 10, totalBase: 100 }] },
    ],
  })
  // over-billed = billed 10 − netReceived 0 = 10 (NOT 13)
  assert.equal(summary.totalOverBilledQty, '10')
})

test('ignores freight/cost invoice lines with no poLineId', () => {
  const summary = computePurchaseOrderOverBilling({
    lines: [{ id: 'pol-1', productId: 'p1', sku: 'SKU-1', qtyReceived: 10, qtyReturned: 10 }],
    invoices: [
      { id: 'inv-1', invoiceNumber: 'BILL-1', totalBase: 250, lines: [
        { poLineId: 'pol-1', qtyBilled: 10, totalBase: 100 },
        { poLineId: null, qtyBilled: 1, totalBase: 150 },
      ] },
    ],
  })
  // Only the goods line counts: billed 10, kept 0 => 10 over-billed @ £10 = £100
  assert.equal(summary.totalOverBilledQty, '10')
  assert.equal(summary.totalOverBilledValueBase, '100')
})
