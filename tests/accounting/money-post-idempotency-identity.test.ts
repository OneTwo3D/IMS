import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { countReversedEpisodes, moneyPostIdempotencySource } from '@/lib/domain/accounting/money-post-document'
import { buildXeroIdempotencyKey, resolveXeroMoneyPostIdempotencyKey, xeroMoneyPostIdempotencyKey } from '@/lib/connectors/xero/sync-processor'

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

test('the reversal episode is part of the identity: retries of one episode share a key, the next episode after a proven reversal does not', () => {
  const bill = { accountingInvoiceId: 'BILL-1', bankAccountId: 'BANK', amount: 250 }
  const first = xeroMoneyPostIdempotencyKey('r1', 'BILL_PAYMENT', bill, 'bill-payment', 0)
  assert.equal(first, xeroMoneyPostIdempotencyKey('r2', 'BILL_PAYMENT', bill, 'bill-payment', 0), 'two rows of one episode')
  assert.equal(first, xeroMoneyPostIdempotencyKey('r1', 'BILL_PAYMENT', bill, 'bill-payment'), 'episode defaults to the first')
  const repaid = xeroMoneyPostIdempotencyKey('r3', 'BILL_PAYMENT', bill, 'bill-payment', 1)
  assert.notEqual(first, repaid, 'the same bill, the same amount, after a proven reversal')
  assert.notEqual(repaid, xeroMoneyPostIdempotencyKey('r3', 'BILL_PAYMENT', bill, 'bill-payment', 2))
  for (const [type, payload] of [['INVOICE_PAYMENT', invoice()], ['PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'B', creditNoteId: 'C', amount: 3 }]] as const) {
    assert.notEqual(moneyPostIdempotencySource(type, payload, 0), moneyPostIdempotencySource(type, payload, 1), type)
  }
})

test('countReversedEpisodes counts only reversed registrations of the SAME settlement', () => {
  const bill = { accountingInvoiceId: 'BILL-1', amount: 250 }
  assert.equal(countReversedEpisodes('BILL_PAYMENT', bill, []), 0)
  assert.equal(countReversedEpisodes('BILL_PAYMENT', bill, [{ payload: { accountingInvoiceId: 'bill-1', amount: 250 } }, { payload: { accountingInvoiceId: 'BILL-2' } }]), 1)
  const pay = invoice()
  const rows = [{ payload: invoice({ paymentId: 'PAY-1' }) }, { payload: invoice({ paymentId: 'PAY-2' }) }, { payload: invoice({ accountingInvoiceId: 'INV-9' }) }]
  assert.equal(countReversedEpisodes('INVOICE_PAYMENT', pay, rows), 1, 'another receipt\'s reversal is not this settlement\'s episode')
})

test('a key already stored on the row is returned as it is: no derivation query, no write', async () => {
  const calls: string[] = []
  const client = {
    accountingSyncLog: {
      findUnique: async () => { calls.push('findUnique'); return { payload: { _moneyPostIdempotencyKey: 'ims-bill-payment-STORED' }, remoteAttemptedAt: null, attemptStampingCustodyAt: new Date() } },
      findMany: async () => { calls.push('findMany'); return [] },
    },
    $executeRaw: async () => { calls.push('executeRaw'); return 0 },
  }
  const key = await resolveXeroMoneyPostIdempotencyKey(client as never, { entryId: 'r1', type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'B', amount: 5 }, operation: 'bill-payment' })
  assert.equal(key, 'ims-bill-payment-STORED')
  assert.deepEqual(calls, ['findUnique'])
})

test('WIRING: every Xero money post sends the stored/resolved key, and none builds it from the row at the call site', async () => {
  const source = await readFile(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  for (const [type, operation] of [['INVOICE_PAYMENT', 'invoice-payment'], ['BILL_PAYMENT', 'bill-payment'], ['PURCHASE_CREDIT_NOTE_ALLOCATION', 'purchase-credit-note-allocation']]) {
    const resolve = `resolveXeroMoneyPostIdempotencyKey(db, { entryId, type: '${type}', payload, operation: '${operation}' })`
    const at = source.indexOf(resolve)
    assert.ok(at > 0, `the ${type} branch resolves its key`)
    // resolved BEFORE the fence call, which is what stamps the attempt
    assert.ok(source.indexOf('return postMoneyUnderLedgerFence({', at) > at && source.indexOf('return postMoneyUnderLedgerFence({', at) - at < 200, `${type}: resolved immediately before the fence`)
    assert.ok(!source.includes(`buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), '${operation}')`), `the ${type} post does not key on the row`)
  }
  assert.equal(source.split('idempotencyKey: moneyPostKey').length - 1, 3)
})
