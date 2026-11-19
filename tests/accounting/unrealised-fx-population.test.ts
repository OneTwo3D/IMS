import assert from 'node:assert/strict'
import test from 'node:test'

import { OPEN_RECEIVABLE_ORDER_WHERE, payableOutstanding, receivableOutstanding } from '@/lib/accounting-fx-revaluation'

test('drafts, quotes and cancelled orders are not receivables', () => {
  const where = OPEN_RECEIVABLE_ORDER_WHERE('GBP')
  assert.deepEqual(where.status.notIn, ['CANCELLED', 'DRAFT'])
  assert.equal(where.isQuote, false)
})

test('a credit note reduces the receivable; a credit beyond the invoice is not a receivable', () => {
  const base = { totalForeign: '100', totalBase: '80', currency: 'EUR', payments: [{ amount: '20', currency: 'EUR' }] }
  const r = receivableOutstanding({ ...base, refunds: [{ totalForeign: '30' }] })
  assert.equal(r.outstandingForeign, 50)
  assert.equal(r.bookedBase, 40)
  assert.equal(receivableOutstanding({ ...base, refunds: [{ totalForeign: '90' }] }).outstandingForeign, 0)
})

test('a part-credited bill is measured on what is still owed, with the base prorated', () => {
  const p = payableOutstanding({ totalForeign: '200', totalBase: '160', supplierCreditNotes: [{ amountForeign: '50' }] })
  assert.equal(p.outstandingForeign, 150)
  assert.equal(p.bookedBase, 120)
  assert.equal(payableOutstanding({ totalForeign: '200', totalBase: '160', supplierCreditNotes: [{ amountForeign: '200' }] }).outstandingForeign, 0)
  assert.equal(payableOutstanding({ totalForeign: '200', totalBase: '160', supplierCreditNotes: [] }).bookedBase, 160)
})

test('o3d-cr517: a NET credit comes off a GROSS order total as its VAT-inclusive equivalent, not as the ex-VAT figure', () => {
  // Order 120 EUR gross (100 net + 20 VAT), booked 96 GBP gross (80 net + 16 tax). A NET refund of 50 EUR ex-VAT (40 GBP) credits 60 EUR gross.
  const order = {
    totalForeign: '120', totalBase: '96', currency: 'EUR', payments: [],
    refunds: [{
      totalForeign: '50', totalBase: '40', totalsBasis: 'NET',
      lines: [{ totalBase: '40', salesOrderLine: { totalBase: '80', taxBase: '16' } }],
    }],
  }
  const r = receivableOutstanding(order)
  assert.equal(r.outstandingForeign, 60, 'subtracting the net 50 would leave 70 and overstate AR by the refunded VAT')
  assert.equal(r.bookedBase, 48)
  // A NET credit that cannot be placed exactly, and a legacy (NULL basis) credit, are read as they stand.
  assert.equal(receivableOutstanding({ ...order, refunds: [{ totalForeign: '50', totalBase: '40', totalsBasis: 'NET', lines: [] }] }).outstandingForeign, 70)
  assert.equal(receivableOutstanding({ ...order, refunds: [{ totalForeign: '50', totalBase: '40', totalsBasis: null }] }).outstandingForeign, 70)
})

test('o3d-cr517: a fully refunded NET order in a high-ratio currency leaves nothing outstanding (gross-up in foreign terms)', () => {
  // 12,000 JPY gross (10,000 net + 2,000 VAT) booked at 61.37 GBP gross; the base figures are rounded independently of the foreign ones.
  const order = {
    totalForeign: '12000', totalBase: '61.37', currency: 'JPY', payments: [],
    refunds: [{
      totalForeign: '10000', totalBase: '51.14', totalsBasis: 'NET',
      lines: [{ totalBase: '51.14', salesOrderLine: { totalBase: '51.14', taxBase: '10.23' } }],
    }],
  }
  assert.equal(receivableOutstanding(order).outstandingForeign, 0)
})
