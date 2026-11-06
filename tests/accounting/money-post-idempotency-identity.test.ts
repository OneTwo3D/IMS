import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { moneyPostIdempotencySource } from '@/lib/domain/accounting/money-post-document'
import { buildXeroIdempotencyKey, xeroMoneyPostIdempotencyKey } from '@/lib/connectors/xero/sync-processor'

/**
 * THE CONNECTOR IDEMPOTENCY KEY OF A MONEY POST IS THE SETTLEMENT'S, NOT THE SYNC ROW'S.
 *
 * Two rows posting the same payment must carry one key (so Xero answers the second with the first's
 * result even when the money-post lock was lost mid-call), and two genuinely different settlements of one
 * document (a deposit and a balance) must carry two (or the second would be silently swallowed).
 */

const invoice = (over: Record<string, unknown> = {}) => ({ accountingInvoiceId: 'INV-1', paymentId: 'PAY-1', amount: 100, bankAccountId: 'BANK', ...over })

test('two different rows for the same receipt on the same invoice carry ONE key, whatever their row ids and tokens', () => {
  const rowA = xeroMoneyPostIdempotencyKey('row-a', 'INVOICE_PAYMENT', { ...invoice(), _followUpIdempotencyKey: 'followup:token:A' }, 'invoice-payment')
  const rowB = xeroMoneyPostIdempotencyKey('row-b', 'INVOICE_PAYMENT', { ...invoice(), _followUpIdempotencyKey: 'followup:token:B' }, 'invoice-payment')
  assert.equal(rowA, rowB)
  assert.match(rowA, /^ims-invoice-payment-doc-[0-9a-f]{64}$/)
  assert.ok(rowA.length <= 128, 'inside Xero\'s Idempotency-Key limit')
})

test('the key does not follow the case of the document id, nor the shape of the amount', () => {
  const a = xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice({ accountingInvoiceId: '4D8A-FF' }), 'invoice-payment')
  const b = xeroMoneyPostIdempotencyKey('r2', 'INVOICE_PAYMENT', invoice({ accountingInvoiceId: '4d8a-ff', amount: '100.00', amountDecimal: '100.00' }), 'invoice-payment')
  assert.equal(a, b)
})

test('a deposit and a balance (different receipts) on one invoice carry DIFFERENT keys', () => {
  const deposit = xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice({ paymentId: 'PAY-1', amount: 40 }), 'invoice-payment')
  const balance = xeroMoneyPostIdempotencyKey('r2', 'INVOICE_PAYMENT', invoice({ paymentId: 'PAY-2', amount: 60 }), 'invoice-payment')
  assert.notEqual(deposit, balance)
})

test('two different receipts of the SAME amount on one invoice (a 50/50 split) carry different keys', () => {
  const first = xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice({ paymentId: 'PAY-1', amount: 50 }), 'invoice-payment')
  const second = xeroMoneyPostIdempotencyKey('r2', 'INVOICE_PAYMENT', invoice({ paymentId: 'PAY-2', amount: 50 }), 'invoice-payment')
  assert.notEqual(first, second)
})

test('the same receipt with a corrected amount, or against another invoice, is a different request', () => {
  const base = xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice(), 'invoice-payment')
  assert.notEqual(base, xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice({ amount: 90 }), 'invoice-payment'))
  assert.notEqual(base, xeroMoneyPostIdempotencyKey('r1', 'INVOICE_PAYMENT', invoice({ accountingInvoiceId: 'INV-2' }), 'invoice-payment'))
})

test('an INVOICE_PAYMENT that names no receipt keeps the row\'s own token: unknown is never "the same payment"', () => {
  const payload = { ...invoice({ paymentId: undefined }), _followUpIdempotencyKey: 'followup:token:A' }
  assert.equal(moneyPostIdempotencySource('INVOICE_PAYMENT', payload), null)
  assert.equal(
    xeroMoneyPostIdempotencyKey('row-a', 'INVOICE_PAYMENT', payload, 'invoice-payment'),
    buildXeroIdempotencyKey('followup:token:A', 'invoice-payment'),
  )
  assert.equal(
    xeroMoneyPostIdempotencyKey('row-a', 'INVOICE_PAYMENT', invoice({ paymentId: '' }), 'invoice-payment'),
    buildXeroIdempotencyKey('row-a', 'invoice-payment'),
  )
})

test('no document anchor, or no usable amount, falls back to the row', () => {
  assert.equal(moneyPostIdempotencySource('INVOICE_PAYMENT', invoice({ accountingInvoiceId: '' })), null)
  assert.equal(moneyPostIdempotencySource('INVOICE_PAYMENT', invoice({ amount: undefined })), null)
  assert.equal(moneyPostIdempotencySource('INVOICE_PAYMENT', invoice({ amount: 'not a number' })), null)
  assert.equal(moneyPostIdempotencySource('BILL_PAYMENT', null), null)
})

test('BILL_PAYMENT: two rows paying the same bill the same amount share a key; another amount or bill does not', () => {
  const bill = (over: Record<string, unknown> = {}) => ({ accountingInvoiceId: 'BILL-1', bankAccountId: 'BANK', amount: 250, ...over })
  const a = xeroMoneyPostIdempotencyKey('row-a', 'BILL_PAYMENT', bill(), 'bill-payment')
  assert.equal(a, xeroMoneyPostIdempotencyKey('row-b', 'BILL_PAYMENT', bill({ reference: 'other ref' }), 'bill-payment'))
  assert.notEqual(a, xeroMoneyPostIdempotencyKey('row-a', 'BILL_PAYMENT', bill({ amount: 100 }), 'bill-payment'))
  assert.notEqual(a, xeroMoneyPostIdempotencyKey('row-a', 'BILL_PAYMENT', bill({ accountingInvoiceId: 'BILL-2' }), 'bill-payment'))
})

test('PURCHASE_CREDIT_NOTE_ALLOCATION: the pair (bill, credit note) and the amount identify it', () => {
  const alloc = (over: Record<string, unknown> = {}) => ({ accountingInvoiceId: 'BILL-1', creditNoteId: 'CN-1', amount: 30, ...over })
  const a = xeroMoneyPostIdempotencyKey('row-a', 'PURCHASE_CREDIT_NOTE_ALLOCATION', alloc(), 'purchase-credit-note-allocation')
  assert.equal(a, xeroMoneyPostIdempotencyKey('row-b', 'PURCHASE_CREDIT_NOTE_ALLOCATION', alloc(), 'purchase-credit-note-allocation'))
  assert.notEqual(a, xeroMoneyPostIdempotencyKey('row-a', 'PURCHASE_CREDIT_NOTE_ALLOCATION', alloc({ creditNoteId: 'CN-2' }), 'purchase-credit-note-allocation'))
  assert.equal(moneyPostIdempotencySource('PURCHASE_CREDIT_NOTE_ALLOCATION', alloc({ creditNoteId: '' })), null)
})

test('a type, an operation and a document never share a key', () => {
  const same = { accountingInvoiceId: 'X-1', amount: 5, paymentId: 'P' }
  const invoicePayment = xeroMoneyPostIdempotencyKey('r', 'INVOICE_PAYMENT', same, 'invoice-payment')
  const billPayment = xeroMoneyPostIdempotencyKey('r', 'BILL_PAYMENT', same, 'bill-payment')
  assert.notEqual(invoicePayment, billPayment)
  assert.equal(moneyPostIdempotencySource('SALES_INVOICE', same), null, 'a non-money type is never keyed by the document')
})

test('WIRING: every Xero money post sends the document-derived key, and none builds it from the row any more', async () => {
  const source = await readFile(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  for (const [type, operation] of [['INVOICE_PAYMENT', 'invoice-payment'], ['BILL_PAYMENT', 'bill-payment'], ['PURCHASE_CREDIT_NOTE_ALLOCATION', 'purchase-credit-note-allocation']]) {
    assert.ok(
      source.includes(`xeroMoneyPostIdempotencyKey(entryId, '${type}', payload, '${operation}')`),
      `the ${type} post sends the settlement's key`,
    )
    assert.ok(
      !source.includes(`buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), '${operation}')`),
      `the ${type} post does not key on the row`,
    )
  }
})
