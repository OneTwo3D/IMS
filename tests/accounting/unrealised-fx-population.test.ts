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
