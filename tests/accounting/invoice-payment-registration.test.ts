import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideInvoicePaymentRegistration,
  type ExistingInvoicePaymentSync,
} from '@/lib/domain/accounting/invoice-payment-registration'

/**
 * o3d-lgo.15, decision recorded 2026-07-25: a manually-recorded sales receipt DOES register against the
 * ledger invoice, on the same principle as markBillPaid — but guarded, because the ledger may already
 * know about the money and a payment registered twice has to be reversed there by hand.
 *
 * Every refusal below leaves the receipt recorded and the settlement verdict visibly unsettled. That is
 * the safe end of the trade: someone can act on a warning, but nobody goes looking for a duplicate
 * payment they were never told about.
 */

const base = {
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentAmount: 100,
  paymentId: 'pay-new',
  bankAccountId: 'BANK-1',
  existing: [] as ExistingInvoicePaymentSync[],
  ledgerTotal: 100,
}

test('a receipt against a posted invoice with a mapped bank account is registered', () => {
  const d = decideInvoicePaymentRegistration(base)
  assert.equal(d.register, true)
  assert.equal(d.register && d.bankAccountId, 'BANK-1')
})

test('nothing is registered while the connector is off', () => {
  const d = decideInvoicePaymentRegistration({ ...base, syncEnabled: false })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'SYNC_DISABLED')
})

test('a payment cannot attach to an invoice the ledger has never seen', () => {
  const d = decideInvoicePaymentRegistration({ ...base, accountingInvoiceId: null })
  assert.equal(d.register === false && d.refusal, 'DOCUMENT_NOT_POSTED')
})

test('a receipt in another currency is not registered against the invoice', () => {
  const d = decideInvoicePaymentRegistration({ ...base, paymentCurrency: 'EUR' })
  assert.equal(d.register === false && d.refusal, 'CURRENCY_MISMATCH')
})

test('an unmapped payment method is refused rather than guessed at', () => {
  const d = decideInvoicePaymentRegistration({ ...base, bankAccountId: null })
  assert.equal(d.register === false && d.refusal, 'NO_BANK_ACCOUNT')
})

test('an imported order whose payment the ledger already holds is NOT paid a second time', () => {
  // THE CASE THIS GUARD EXISTS FOR. An imported paid order registers its receipt through the
  // SALES_INVOICE follow-up and creates NO local Payment row — so IMS's own payment rows do not bound
  // what the ledger has been told. An operator then recording "the" payment would double-pay it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
  assert.equal(d.register === false && d.ledgerTotal, 100)
})

test('a SECOND receipt is refused even when it fits inside the invoice total', () => {
  // Not a policy invented here: accounting_sync_logs_followup_live_unique permits ONE live
  // INVOICE_PAYMENT per order, so queueing a second violates the constraint. Refusing it visibly beats
  // letting the insert throw and turning a receipt the operator believed recorded into an error log.
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 60,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, 40)
})

test('a payment still in the queue holds the slot as firmly as a synced one', () => {
  // PENDING is not "not sent" — it is on its way, and the unique index counts it.
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT', status)
  }
})

test('a rejected or cancelled payment frees the slot again', () => {
  // The ledger rejected it or never saw it, and the unique index ignores those rows too — so a fresh
  // receipt has room. Treating a FAILED row as holding the slot would block the retry that fixes it.
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register, true, status)
  }
})

test('a live row with no recorded amount still blocks, and says nothing about how much', () => {
  // The slot is taken whether or not the amount is readable — so this fails closed by construction. The
  // operator message must not invent a figure it does not have.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, undefined)
})

test('an unreadable amount on a rejected row does not block a fresh receipt', () => {
  // The slot-taken rule applies to rows the ledger HOLDS. A rejected row holds nothing, readable or not.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'FAILED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register, true)
})

test('this receipt does not count against itself when the decision is re-run', () => {
  // The idempotency key already makes a second queue a no-op, so treating our own row as the slot-taker
  // would refuse the retry for its own success.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-new' }],
  })
  assert.equal(d.register, true)
})

test('a receipt bigger than what the ledger holds is refused here, not left for Xero to reject', () => {
  // The caller passes ledgerTotal from ledgerSalesInvoiceTotalForeign. A receipt that EXCEEDS the
  // invoice would be rejected by Xero, and refusing here turns that rejected sync into a warning that
  // names the number instead.
  //
  // The case this used to model — an IMPORTED tax-inclusive invoice posted at its NET total — is gone
  // since o3d-cyn: both construction paths now post at the order's gross, so ledgerTotal is the order
  // total and an ordinary VAT receipt matches it. What is left for this guard is every OTHER way a
  // receipt can exceed the document (a credited or part-refunded invoice, a mistyped amount), plus the
  // invoices imported and posted before that fix.
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 120, ledgerTotal: 100 })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
})

test('sub-penny rounding does not refuse an exact settlement', () => {
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 100.004, ledgerTotal: 100 })
  assert.equal(d.register, true)
})
