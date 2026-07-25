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
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
  assert.equal(d.register === false && d.ledgerTotal, 100)
})

test('a second part payment that fits inside the invoice total is registered', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 60,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }],
  })
  assert.equal(d.register, true)
})

test('a part payment that would tip the ledger past the invoice total is refused', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 61,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
})

test('a payment still in the queue already holds its share of the invoice', () => {
  // PENDING is not "not sent" — it is on its way, and counting it as free capacity would register the
  // same money twice the moment both rows drain.
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY', status)
  }
})

test('a rejected or cancelled payment frees its capacity again', () => {
  // The ledger rejected it or never saw it, so the invoice is still outstanding by that amount and a
  // fresh receipt has room. Treating a FAILED row as money held would block the retry that fixes it.
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register, true, status)
  }
})

test('an existing sync with no recorded amount fails CLOSED', () => {
  // "How much has the ledger already been told" is the whole guard. A row we cannot read makes the answer
  // unknown, not zero — and guessing zero is exactly how the invoice gets paid twice.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'UNKNOWN_REGISTERED_AMOUNT')
})

test('an unreadable amount on a rejected row does not block a fresh receipt', () => {
  // Fail-closed applies to money the ledger HOLDS. A rejected row holds nothing, readable or not.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'FAILED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register, true)
})

test('this receipt does not count against itself when the decision is re-run', () => {
  // The idempotency key already makes a second queue a no-op, so counting our own row as capacity used
  // would refuse the retry with a false over-pay warning.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-new' }],
  })
  assert.equal(d.register, true)
})

test('a tax-inclusive invoice is measured against what the ledger holds, not the gross order total', () => {
  // The caller passes ledgerTotal from ledgerSalesInvoiceTotalForeign: a tax-inclusive invoice posts at
  // NET (o3d-cyn), so a gross receipt against it would EXCEED the invoice and Xero would reject the
  // payment. Refusing here turns a rejected sync into a warning that names the number.
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 120, ledgerTotal: 100 })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
})

test('sub-penny rounding does not refuse an exact settlement', () => {
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 60.005, ledgerTotal: 100, existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }] })
  assert.equal(d.register, true)
})
