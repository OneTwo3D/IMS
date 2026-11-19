import assert from 'node:assert/strict'
import test from 'node:test'

import { OPEN_RECEIVABLE_ORDER_WHERE, RECEIVABLE_NETTING_REFUND_WHERE, payableOutstanding, receivableOutstanding } from '@/lib/accounting-fx-revaluation'
import { matchesWhere, type SyncLogRow } from '@/tests/fixtures/accounting-sync-log-store'

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

// The where objects are evaluated against rows by the sync-log store's matcher (it throws on an operator it does not implement), so a clause that did not mean what the
// comment says would select the wrong rows rather than pass a structural assertion.
const asRow = (row: Record<string, unknown>) => row as unknown as SyncLogRow
const order = (over: Record<string, unknown> = {}) => ({ currency: 'EUR', status: 'PROCESSING', isQuote: false, accountingInvoiceId: 'INV-1', totalForeign: 100, refundStatus: 'NONE', ...over })

// [mutation: the invoice-posted clause dropped, so population is keyed on status again]
test('o3d-cr517: the receivable population is keyed on the invoice being POSTED, not on order status', () => {
  const where = OPEN_RECEIVABLE_ORDER_WHERE('GBP')
  const included = (over: Record<string, unknown>) => matchesWhere(asRow(order(over)), where)
  assert.equal(included({}), true)
  // PENDING_PAYMENT and ON_HOLD orders the ledger holds no invoice for are not receivables; once the invoice has posted they are.
  for (const status of ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'SHIPPED']) assert.equal(included({ status, accountingInvoiceId: null }), false, `${status}, invoice not posted`)
  for (const status of ['PENDING_PAYMENT', 'ON_HOLD']) assert.equal(included({ status }), true, `${status}, invoice posted`)
  // Unchanged exclusions.
  assert.equal(included({ status: 'CANCELLED' }), false)
  assert.equal(included({ status: 'DRAFT' }), false)
  assert.equal(included({ isQuote: true }), false)
  assert.equal(included({ currency: 'GBP' }), false)
  // A fully refunded order stays in the population: whether it is still owed is decided by the credit notes the ledger holds (below), not by IMS's refund state.
  assert.equal(included({ refundStatus: 'FULL' }), true)
})

// [mutation: the credit-note-posted clause dropped, so a refund still queued for the ledger is netted]
test('o3d-cr517: receivables net only refunds whose credit note has reached the ledger, the payable side\'s POSTED basis', () => {
  const refunds = [
    { id: 'posted', deletedAt: null, accountingCreditNoteId: 'CN-1', totalForeign: '30' },
    { id: 'queued', deletedAt: null, accountingCreditNoteId: null, totalForeign: '25' },
    { id: 'deleted', deletedAt: new Date(), accountingCreditNoteId: 'CN-2', totalForeign: '10' },
  ]
  const netted = refunds.filter((refund) => matchesWhere(asRow(refund), RECEIVABLE_NETTING_REFUND_WHERE))
  assert.deepEqual(netted.map((r) => r.id), ['posted'])
  const base = { totalForeign: '100', totalBase: '80', currency: 'EUR', payments: [] }
  assert.equal(receivableOutstanding({ ...base, refunds: netted }).outstandingForeign, 70, 'the queued credit note is not subtracted')
  // A fully credited order whose credit note HAS posted leaves nothing; with it still queued the ledger still holds the whole invoice.
  assert.equal(receivableOutstanding({ ...base, refunds: [refunds[0]!, { ...refunds[1]!, accountingCreditNoteId: 'CN-3', totalForeign: '70' }].filter((r) => matchesWhere(asRow(r), RECEIVABLE_NETTING_REFUND_WHERE)) }).outstandingForeign, 0)
  assert.equal(receivableOutstanding({ ...base, refunds: [{ ...refunds[1]!, totalForeign: '100' }].filter((r) => matchesWhere(asRow(r), RECEIVABLE_NETTING_REFUND_WHERE)) }).outstandingForeign, 100)
})
