import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideInvoicePaymentRegistration,
  selectReceiptsAwaitingRegistration,
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
  // Since o3d-cjt8 the refusal is CAPACITY, not occupancy: the whole invoice is already registered, so
  // there is no room left for this receipt. The figure the operator is shown is what is already on it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null }],
  })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
  assert.equal(d.register === false && d.ledgerTotal, 100)
})

test('o3d-cjt8: a SECOND receipt that fits alongside the first IS registered', () => {
  // THE DEFECT THIS CLOSES. The old rule refused any receipt once ANY live INVOICE_PAYMENT row existed,
  // because accounting_sync_logs_followup_live_unique permitted one live row per ORDER — so a deposit
  // followed by a balance had to be keyed into Xero by hand. A Xero Payment is per RECEIPT against a
  // DOCUMENT; the index is now scoped that way, and what is left to check is arithmetic.
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 60,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }],
  })
  assert.equal(d.register, true)
  assert.equal(d.register && d.bankAccountId, 'BANK-1')
})

test('o3d-cjt8: the receipt that would take the total PAST the invoice is the one refused', () => {
  // The capacity rule is not "anything goes once part payments are allowed". 40 + 60 exhausts the
  // invoice, so a further 10 has nowhere to go — and the refusal names what is already registered
  // rather than only the invoice total, since that is the number that explains it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 10,
    existing: [
      { status: 'SYNCED', amount: 40, paymentId: 'pay-1' },
      { status: 'PENDING', amount: 60, paymentId: 'pay-2' },
    ],
  })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
  assert.equal(d.register === false && d.ledgerTotal, 100)
})

test('a payment still in the queue consumes capacity as firmly as a synced one', () => {
  // PENDING is not "not sent" — it is on its way, and the index's live predicate counts it, so the
  // arithmetic must too. Otherwise two receipts queued in quick succession would each measure
  // themselves against an empty invoice.
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY', status)
    assert.equal(d.register === false && d.alreadyRegistered, 100, status)
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

test('a live row with no recorded amount refuses on the UNREADABLE amount, and invents no figure', () => {
  // Capacity arithmetic needs every live amount. An unreadable one cannot be treated as zero — that is
  // the assumption that the ledger holds nothing, which is precisely what is not known — so this fails
  // closed with the reason named, and reports no total it does not have.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_AMOUNT_UNKNOWN')
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

// ---------------------------------------------------------------------------
// o3d-hbgo, read side: WHICH ledger document a registration settled
// ---------------------------------------------------------------------------

test('o3d-hbgo: a payment registered against a RETIRED invoice leaves the replacement fully open', () => {
  // The order's invoice was deleted in the ledger and re-posted as INV-2. The SYNCED row settled INV-1,
  // which no longer exists — it consumed none of INV-2. Counting it would refuse every payment on the
  // replacement for ever, and the operator would be told the invoice was already settled when it is not.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-old', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register, true)
})

test('o3d-hbgo: a registration that names NO document still consumes capacity', () => {
  // Rows queued before the payload recorded the document cannot be attributed. For money, unknown has
  // to read as "possibly this invoice" — assuming otherwise would silently double-pay exactly the
  // legacy rows least able to survive it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-old', accountingInvoiceId: null }],
  })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
})

// ---------------------------------------------------------------------------
// o3d-ekn8: receipts recorded before the invoice posted
// ---------------------------------------------------------------------------

const receipts = [{ id: 'pay-1' }, { id: 'pay-2' }]

test('o3d-ekn8: a receipt with no sync row at all is the one waiting to be registered', () => {
  // THE DEFECT THIS CLOSES. addPayment refused it with DOCUMENT_NOT_POSTED because the invoice had not
  // reached the ledger, and nothing came back for it once the invoice posted.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' }],
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-2'])
})

test('o3d-ekn8: a receipt whose own attempt FAILED is left to the retry path, not re-driven', () => {
  // This path does not go through planFollowUpEnqueue, so it cannot pin the remote token. A FAILED
  // attempt may have committed in the ledger before failing (o3d-ju8t), and re-driving it here would
  // post under a token Xero has never seen — the o3d-h2wx double payment.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'FAILED', amount: 40, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' }],
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-2'])
})

test('o3d-ekn8: an UNATTRIBUTED live registration suppresses every receipt on the order', () => {
  // The imported-order shape: the SALES_INVOICE follow-up registers the receipt with no local Payment
  // row, so nothing says which receipt it covers. "Which one is this?" unanswered has to read as
  // "possibly that one" — for all of them.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null, accountingInvoiceId: 'INV-1' }],
  })
  assert.deepEqual(awaiting, [])
})

test('o3d-ekn8: an unattributed row that is CANCELLED holds nothing back', () => {
  // A cancelled or rejected row is not a registration the ledger holds, so it cannot be the one that
  // covers an unidentified receipt. Treating it as one would strand every receipt on the order.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'CANCELLED', amount: 100, paymentId: null, accountingInvoiceId: 'INV-1' }],
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-1', 'pay-2'])
})
