import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  decideInvoicePaymentRegistration,
  selectReceiptsAwaitingRegistration,
  unresolvedInvoicePaymentAttempts,
  type ExistingInvoicePaymentSync,
} from '@/lib/domain/accounting/invoice-payment-registration'
import type { LedgerSettlementRecord } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { describeInvoicePaymentRefusal } from '@/lib/domain/accounting/invoice-payment-enqueue'

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
  // Most cases have no unresolved attempt, so the ledger is never consulted and this is unread.
  // The cases that DO have one pass their own records — see the o3d-0m56 block at the end.
  ledgerSettlements: null as LedgerSettlementRecord[] | null,
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

test('a rejected or cancelled payment frees the DATABASE slot, but only the ledger frees the decision', () => {
  // This test used to assert `register: true` outright, on the reading that a FAILED or CANCELLED row
  // "holds nothing". The partial unique index does ignore those statuses — but the index is a statement
  // about rows, not about money. A call that COMMITTED and then lost its response is FAILED, and
  // deleting a receipt CANCELS a row that may already have settled (o3d-0m56, Codex review). So the
  // slot is free and the decision is not, until the ledger says the earlier attempt is not in it.
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const existing = [{ status, amount: 100, paymentDate: '2026-08-01', paymentId: 'pay-old' }]
    assert.equal(
      decideInvoicePaymentRegistration({ ...base, existing, ledgerSettlements: [] }).register,
      true,
      `${status}: a ledger with no matching settlement is what makes this safe`,
    )
    const blocked = decideInvoicePaymentRegistration({ ...base, existing, ledgerSettlements: null })
    assert.equal(blocked.register === false && blocked.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT',
      `${status}: an unanswered ledger is not permission`)
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

test('an unreadable amount on a rejected row no longer waves the receipt through', () => {
  // This asserted `register: true` on the reading that "a rejected row holds nothing". It can hold a
  // payment — the response may simply have been lost — and with no amount recorded, no settlement in
  // the ledger can ever be matched to it, so it can never be ruled out (o3d-0m56). It does NOT take the
  // database's live slot, though, so the refusal names the unresolved attempt rather than a live one.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'FAILED', amount: null, paymentId: 'pay-old' }],
    ledgerSettlements: [],
  })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
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

// --- o3d-0m56: the OTHER way a second payment reaches the ledger (Codex finding 2) ---

/**
 * The manual-retry guard protects the RETRY of a failed payment row. Nothing was protecting the
 * likelier operator action: record the receipt again. That queues a BRAND-NEW row under a NEW
 * idempotency token, so it posts a second payment against the same invoice without the retry
 * guard ever running — and a failed payment looks, from the order screen, like nothing happened.
 */

const unresolved = (over: Partial<ExistingInvoicePaymentSync> = {}): ExistingInvoicePaymentSync => ({
  status: 'FAILED', amount: 100, paymentDate: '2026-08-01', paymentId: 'pay-old', ...over,
})

test('a receipt beside an unresolved attempt the ledger HOLDS is refused (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-08-01', id: 'PAY-1' }],
  })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(String(d.register === false ? d.detail : ''), /already holds 100\.00 dated 2026-08-01/)
})

test('a ledger that cannot be asked refuses too (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({ ...base, existing: [unresolved()], ledgerSettlements: null })
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(String(d.register === false ? d.detail : ''), /could not be asked/)
})

test('an unresolved attempt IMS cannot describe refuses (o3d-0m56)', () => {
  // No amount or no date means no settlement in the ledger can be matched to it, so it can never
  // be ruled out. Refusing is the only honest answer.
  for (const attempt of [unresolved({ amount: null }), unresolved({ paymentDate: null })]) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [attempt], ledgerSettlements: [] })
    assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT', JSON.stringify(attempt))
  }
})

test('an attempt that PROVABLY never posted does not block the receipt (o3d-0m56)', () => {
  // The stranding direction has a cost, so it is kept as narrow as the retry guard's: a stored body
  // missing a field the connector requires was rejected before any HTTP call, so it carries nothing.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved({ couldHaveReachedLedger: false })],
    ledgerSettlements: null,
  })
  assert.equal(d.register, true)
})

// ---------------------------------------------------------------------------
// o3d-hbgo, read side: WHICH ledger document a registration settled
// ---------------------------------------------------------------------------

test('o3d-hbgo: ANOTHER receipt s payment against a RETIRED invoice leaves the replacement fully open', () => {
  // The order's invoice was deleted in the ledger and re-posted as INV-2. The SYNCED row settled INV-1,
  // which no longer exists — it consumed none of INV-2. Counting it would refuse every payment on the
  // replacement for ever, and the operator would be told the invoice was already settled when it is not.
  //
  // o3d-ekn8 r4: this is an ARITHMETIC statement about capacity, and it holds for a payment made for a
  // DIFFERENT RECEIPT (`pay-old`, not the `pay-new` being decided). A row that could be speaking for
  // THIS receipt is evidence rather than arithmetic — see the block below.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-old', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register, true)
})

// ---------------------------------------------------------------------------
// o3d-ekn8 r4 (Codex HIGH) — THE ANCHORING TRADED SILENT UNDER-SETTLEMENT FOR SILENT
// OVER-SETTLEMENT.
//
// Receipt P is SYNCED against invoice A. The order's invoice id moves to B — reachable, because the
// delete guard swallows the back-reference write failure. Every gate then discards that row: the
// selector drops it, this `live` filter drops it, the anchored idempotency key misses it, and the
// post-site capacity guard is narrowed identically. The row is SYNCED, so the unresolved-attempt
// probe never consults the ledger. Nothing between the selector and the remote payment POST could
// catch it.
//
// The safety argument — "the old document has been deleted" — is an assumption about a ledger this
// code never reads, and it inverts the module's own rule that for money unknown must read as
// "possibly this one". On QuickBooks a deleted invoice leaves its payment as an UNAPPLIED CREDIT:
// the customer is credited twice.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r4] THIS receipt s own SYNCED row on a retired document refuses, instead of being discarded', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{
      status: 'SYNCED',
      amount: 100,
      paymentId: 'pay-new',
      accountingInvoiceId: 'INV-1',
      externalTransactionId: 'PAY-XYZ',
    }],
  })
  assert.equal(d.register, false, 'registering again pays the same receipt twice')
  assert.equal(d.register === false && d.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
  assert.match(
    (d.register === false && d.detail) || '',
    /INV-1.*PAY-XYZ/,
    'and it names the document and the payment an operator has to go and read',
  )
})

test('[o3d-ekn8 r4] an UN-ATTRIBUTED live row on a retired document refuses too', () => {
  // It cannot be shown to belong to a DIFFERENT receipt, and this module's own rule is that unknown
  // reads as "possibly this one".
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register === false && d.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
})

test('[o3d-ekn8 r4] a PENDING row for this receipt on a retired document refuses as well', () => {
  // Not only SYNCED: a row still in flight against the old document will post to it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-new', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register === false && d.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
})

test('[o3d-ekn8 r4] a CANCELLED retired-document row clears it — that is a human saying they read the ledger', () => {
  // The one thing that IS evidence, and the reason this refusal is not a permanent dead end: an
  // operator cancelling the row asserts the ledger no longer holds that payment, which is the fact
  // the code cannot establish for itself. o3d-ekn8's "never silently unsettled for ever" survives —
  // the refusal above is WARNED about and names this remedy.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    existing: [{ status: 'CANCELLED', amount: 100, paymentId: 'pay-new', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register, true)
})

test('[o3d-ekn8 r4] it is asked BEFORE the capacity arithmetic, which cannot see the row at all', () => {
  // The `live` filter drops the retired row, so the sum reports the whole invoice as free. Ordering
  // the gate after the arithmetic would let a receipt that happens to fit straight through.
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    paymentAmount: 1,
    ledgerTotal: 100,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-new', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(d.register === false && d.refusal, 'SETTLED_ON_RETIRED_DOCUMENT',
    'a receipt that fits the replacement invoice is still the same receipt already paid')
})

test('[o3d-ekn8 r4] a row on the CURRENT document is untouched by it — that is the capacity rule s business', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    accountingInvoiceId: 'INV-2',
    paymentAmount: 40,
    ledgerTotal: 100,
    existing: [{ status: 'SYNCED', amount: 60, paymentId: 'pay-old', accountingInvoiceId: 'INV-2' }],
  })
  assert.equal(d.register, true, 'a deposit and a balance on the SAME document are what o3d-cjt8 admits')
})

test('our OWN failed row does not block this receipt (o3d-0m56)', () => {
  // Re-running the registration for the same Payment must not refuse for its own earlier failure —
  // it re-posts under the same token, which is the case the whole idempotency scheme is built on.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved({ paymentId: 'pay-new' })],
    ledgerSettlements: null,
  })
  assert.equal(d.register, true)
})

test('a settlement for a different amount or date leaves the receipt free (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-07-01' }, { amount: 40, date: '2026-08-01' }],
  })
  assert.equal(d.register, true, 'only a settlement matching the ATTEMPT is evidence about it')
})

test('the caller can tell whether the ledger needs asking at all (o3d-0m56)', () => {
  // The probe is a network read; putting one behind every receipt would be a new problem. This is
  // the rule the caller uses to decide, so it is pinned here rather than left implicit in sales.ts.
  assert.deepEqual(unresolvedInvoicePaymentAttempts([], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([{ status: 'SYNCED', amount: 100 }], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([unresolved({ paymentId: 'pay-new' })], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([unresolved({ couldHaveReachedLedger: false })], 'pay-new'), [])
  assert.equal(unresolvedInvoicePaymentAttempts([unresolved(), unresolved({ status: 'CANCELLED' })], 'pay-new').length, 2)
})

test('sales.ts asks the ledger exactly when the decision needs it (o3d-0m56)', async () => {
  // registerInvoicePaymentWithLedger is module-private, so this pins the WIRING the pure tests
  // above cannot reach: the probe is gated on there being an unresolved attempt, its failure
  // becomes null rather than an empty list, and the result is what the decision is given.
  // SUPERSEDED LOCATION (o3d-ekn8 lifted this path out of the 'use server' file); same property.
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/invoice-payment-enqueue.ts'), 'utf8',
  )
  const at = source.indexOf('const ledgerSettlements =')
  assert.notEqual(at, -1, 'the registration path must resolve what the ledger holds')
  const body = source.slice(at, source.indexOf('const decision = decideInvoicePaymentRegistration', at))

  assert.match(body, /unresolvedInvoicePaymentAttempts\(existing, params\.paymentId\)\.length > 0/,
    'the probe must be gated on an unresolved attempt, not run on every receipt')
  assert.match(body, /probe\.ok \? probe\.records : null/,
    'a probe that could not answer must become null — the value the decision refuses on')
  assert.match(source.slice(at), /ledgerSettlements,/, 'and it must reach the decision')

  // The two fields the unresolved rule is decided from must actually be read off the stored row.
  // Without paymentDate no attempt can ever be matched, so every receipt beside a failed row is
  // refused; without the postability flag, a row that provably never posted strands one.
  const loader = source.slice(source.indexOf('export async function loadInvoicePaymentSyncRows'))
  const loaderBody = loader.slice(0, loader.indexOf('\n}\n'))
  // Round 6, finding 1: carried from the SHARED date rule, not from a local copy of
  // `payload.paymentDate?.slice(0, 10)`. A copy here is a copy that can drift from what the
  // processor will actually send, which is how the probe came to look for settlements on days no
  // post would ever create.
  assert.match(loaderBody, /paymentDate: pinnedAttemptDate\('INVOICE_PAYMENT', r\.payload\)/,
    'the attempt date must be carried from the shared money-post date rule')
  assert.match(loaderBody, /couldHaveReachedLedger: attemptCouldHaveReachedTheLedger\('INVOICE_PAYMENT', r\.payload\)/,
    'and postability judged by the SAME rule the retry guard uses')

  // The refusal has to be surfaced, not swallowed: an operator who is not told will record the
  // receipt again.
  //
  // o3d-0bfh r13: taken from the PRODUCER rather than by slicing 900 characters after the `case`
  // label. The message moved into `describeInvoicePaymentRefusal` when the remedies became
  // recovery-aware, and the source slice was measuring where the `warn` call happened to sit — it
  // would have gone on passing over prose written anywhere in that window, and it broke the moment
  // the reporting moved one function away without the property changing at all.
  assert.match(source, /case 'UNRESOLVED_PAYMENT_ATTEMPT':/)
  const notice = describeInvoicePaymentRefusal({
    refused: { register: false, refusal: 'UNRESOLVED_PAYMENT_ATTEMPT', detail: 'the ledger could not be read' },
    orderReference: 'SO-1',
    amount: 100,
    currency: 'GBP',
    orderCurrency: 'GBP',
    method: 'card',
    redrive: { redrive: 'none' },
  })
  assert.ok(notice, 'an unresolved attempt must produce an operator notice, not a silent return')
  assert.match(notice.description, /could pay the invoice twice/)
  assert.equal(notice.metadata.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.equal(notice.metadata.detail, 'the ledger could not be read', 'and it carries WHY it could not be ruled out')
  // ...and that notice is what `reportRefusal` logs, under the action an operator can search for.
  const reporter = source.slice(source.indexOf('const reportRefusal ='))
  assert.match(reporter.slice(0, 900), /describeInvoicePaymentRefusal\(\{/)
  assert.match(reporter.slice(0, 900), /invoice_payment_not_registered/)
})

test('the BILL side is closed by a different mechanism, and it must stay closed (o3d-0m56)', async () => {
  // Codex's finding 2 is about re-recording a receipt beside an unresolved attempt. The supplier side
  // has the same shape and no unresolved-attempt check — because marking a bill paid is single-shot:
  // it only writes paidAt while paidAt IS NULL, and the only thing that clears paidAt again is a
  // payment poller finding the bill genuinely unpaid in the ledger. A committed-but-unacknowledged
  // bill payment therefore leaves the ledger showing PAID, and the second attempt never reaches the
  // queue. That argument rests entirely on the compare-and-set, so it is pinned rather than trusted.
  //
  // SUPERSEDED LOCATION, REWRITTEN. o3d-a3wx moved the transition out of app/actions/purchase-orders.ts
  // into `markBillPaidSupersedingStaleRegistrations`, which additionally REFUSES when a claimed or
  // posted BILL_PAYMENT row contradicts "IMS held this bill as unsettled" — i.e. it now carries an
  // unresolved-attempt check of its own, which is what the o3d-0m56 comment said would be needed if
  // the compare-and-set ever went. The compare-and-set did not go; it moved. Both are pinned here.
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/payment-reversal.ts'), 'utf8',
  )
  const at = source.indexOf('export async function markBillPaidSupersedingStaleRegistrations')
  assert.notEqual(at, -1, 'the bill-paid transition must still be one guarded function')
  const body = source.slice(at, source.indexOf('\nexport ', at + 1))
  assert.match(body, /where: \{ id: params\.invoiceId, paidAt: null \}/,
    'a bill may only be marked paid while it is unpaid')
  assert.match(body, /if \(paid\.count === 0\) return \{ outcome: 'already-paid' \}/,
    'and losing that compare-and-set must report already-paid, not fall through')
  assert.match(body, /if \(!plan\.proceed\)/,
    'and a live BILL_PAYMENT row that contradicts an unsettled bill must refuse before anything is written')

  const action = await readFile(path.join(process.cwd(), 'app/actions/purchase-orders.ts'), 'utf8')
  assert.match(action, /if \(invoice\.paidAt\) return \{ success: false/,
    'and the early refusal in the action must stay too')
})

test('the WHOLE decision is re-runnable for the check inside the write (o3d-0m56, rebased onto o3d-cjt8)', () => {
  // SUPERSEDED AND REWRITTEN. This test used to pin `invoicePaymentRowSetBlocker`, a split-out half of
  // the decision covering only the rules that read the order's other sync rows, and it asserted in so
  // many words that the re-check "must NOT judge size". Both halves of that are now wrong:
  //
  //   • o3d-cjt8 made the live-follow-up index RECEIPT-scoped, so the thing that stops two racing
  //     receipts over-settling one invoice is the capacity SUM, not the index. A re-check that
  //     deliberately skipped the arithmetic would re-open the very race it was added to close.
  //   • its stated reason — "the caller inside the transaction has the row set and nothing else" —
  //     stopped being true: registerInvoicePaymentWithLedger hoists a whole `decisionInput` and
  //     re-runs `decideInvoicePaymentRegistration` under the lock with only `existing` refreshed.
  //
  // So the property being pinned is unchanged (the row-set rules must be re-evaluable against a fresh
  // snapshot) and the mechanism is now the one decision function called twice, which is also what
  // stops the two from drifting apart.
  const clean = decideInvoicePaymentRegistration({ ...base, existing: [] })
  assert.equal(clean.register, true)

  // A sibling that appeared since the first decision consumes the invoice's remaining room.
  const raced = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-other', accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(raced.register === false && raced.refusal, 'WOULD_OVERPAY')
  assert.equal(raced.register === false && raced.alreadyRegistered, 100)

  // And an attempt that turned unresolved in the same window is still refused on its own grounds,
  // which capacity arithmetic cannot see: a FAILED row consumes no capacity.
  const unresolvedNow = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-08-01' }],
  })
  assert.equal(unresolvedNow.register === false && unresolvedNow.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
})

test('the registration re-decides INSIDE the write transaction, under both locks (o3d-0m56 + o3d-cjt8)', async () => {
  // SUPERSEDED LOCATION, SAME PROPERTY. This used to read app/actions/sales.ts; o3d-ekn8 lifted
  // registerInvoicePaymentWithLedger into lib/domain/accounting/invoice-payment-enqueue.ts so a second
  // caller (the connector's re-drive after a SALES_INVOICE posts) could reach it without every export
  // of a 'use server' file becoming a server action. Pinned by source because the function is not
  // exported for testing; the point is not that the rule exists but that it is evaluated AGAIN in the
  // transaction that writes, against rows read through that transaction.
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/invoice-payment-enqueue.ts'), 'utf8',
  )
  const fnAt = source.indexOf('export async function registerInvoicePaymentWithLedger')
  assert.notEqual(fnAt, -1, 'the registration path must still exist')
  // o3d-ekn8 r2 named the transaction body so it can be run inside a try/catch — the pinned-connector
  // fence throws out of it to UNWRITE a row queued for a ledger this registration was not measured
  // against. The property pinned here is unchanged: everything below still happens inside it.
  const at = source.indexOf('const runEnqueue = () => db.$transaction(async (tx) => {', fnAt)
  assert.notEqual(at, -1)
  const body = source.slice(at, source.indexOf('}, STOCK_TX_OPTIONS)', at))

  const orderLockAt = body.indexOf('await lockSalesOrder(tx, params.orderId)')
  const scopeLockAt = body.indexOf('await lockFollowUpScope(tx, {')
  const readAt = body.indexOf('loadInvoicePaymentSyncRows(params.orderId, connectorId, tx)')
  const decideAt = body.indexOf('decideInvoicePaymentRegistration({')
  const queueAt = body.indexOf('queueAccountingSyncTxWithOutcome(tx, {')
  // o3d-ekn8 r2: and the PINNED document is re-read through the same transaction, after the locks and
  // before the decision — the pre-lock comparison runs in a window the order lock has since reopened.
  const pinRecheckAt = body.indexOf('select: { accountingInvoiceId: true },')

  assert.ok(orderLockAt !== -1, 'the order lock serialises this against deletePayment')
  assert.ok(scopeLockAt > orderLockAt,
    'and the follow-up scope lock serialises it against the connector queues and the manual retry, '
    + 'which do not touch the sales order at all — order first, scope second, the repo-wide lock order')
  assert.ok(readAt > scopeLockAt, 'the rows must be re-read UNDER both locks, not before them')
  // The re-read is an ARGUMENT of the re-decision, so it appears after `decideInvoicePaymentRegistration({`
  // in source order while running before it. Both are therefore anchored to the locks and to the write,
  // not to each other — an ordering assertion between the two would be about formatting, not sequence.
  assert.ok(decideAt > scopeLockAt, 'the decision must be re-taken under the locks')
  assert.ok(queueAt > readAt && queueAt > decideAt, 'and the write must come after both')
  assert.ok(pinRecheckAt > scopeLockAt && pinRecheckAt < queueAt,
    'the pinned document is re-read under the locks too, or the pin is only ever tested in a window '
    + 'the order lock has since reopened')
  // o3d-ekn8 r4: the throw carries whether this call actually WROTE the row. The enqueue reports
  // `queued: true` without writing when its idempotency short-circuit finds a live row, and rolling
  // back an empty transaction while telling the operator "nothing was sent" is the one message that
  // stops anyone looking for the row that is still going to post.
  assert.match(body, /throw new PinnedConnectorMoved\(enqueued\.connector, enqueued\.reason === 'already-queued'\)/,
    'and a row written under a connector this call did not pin is rolled back, not reported as queued')
  assert.match(body.slice(decideAt, decideAt + 400), /if \(!underLock\.register\) return \{ refused: underLock \}/,
    'a refused re-decision must abandon the enqueue')

  // The ledger is deliberately NOT re-read here — a network call inside the locks would let a slow
  // remote block every payment enqueue in the system.
  assert.ok(!/probeLedgerSettlement/.test(body), 'no network call inside the locked transaction')
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
    accountingInvoiceId: 'INV-1',
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
    accountingInvoiceId: 'INV-1',
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
    accountingInvoiceId: 'INV-1',
  })
  assert.deepEqual(awaiting, [])
})

test('o3d-ekn8: an unattributed row that is CANCELLED holds nothing back', () => {
  // A cancelled or rejected row is not a registration the ledger holds, so it cannot be the one that
  // covers an unidentified receipt. Treating it as one would strand every receipt on the order.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'CANCELLED', amount: 100, paymentId: null, accountingInvoiceId: 'INV-1' }],
    accountingInvoiceId: 'INV-1',
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-1', 'pay-2'])
})

test('[o3d-ekn8 r3] a row naming a RETIRED document does not speak for its receipt', () => {
  // o3d-hbgo's rule, on the WRITE side. The invoice was deleted in the ledger and re-posted as INV-2;
  // pay-1's row settled INV-1, an invoice this order no longer has. Keyed on the receipt alone this
  // returned an empty list, and the replacement was never settled by anything — silently, because a
  // gate that selects nothing has nothing to report.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-1', accountingInvoiceId: 'INV-1' }],
    accountingInvoiceId: 'INV-2',
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-1', 'pay-2'])
})

test('[o3d-ekn8 r3] an UNATTRIBUTED live row on a RETIRED document suppresses nothing', () => {
  // The same narrowing applied to the other rule, and for the same reason: a registration nobody can
  // match to a receipt still says nothing about a document it was not made against.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null, accountingInvoiceId: 'INV-1' }],
    accountingInvoiceId: 'INV-2',
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-1', 'pay-2'])
})

test('[o3d-ekn8 r3] a row that names NO document keeps suppressing, whichever invoice is asked about', () => {
  // Unknown must read as "possibly this one" — the only direction that cannot let a second payment
  // out. Mirrors the read side, which counts an unanchored row against the current invoice.
  const awaiting = selectReceiptsAwaitingRegistration({
    receipts,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: 'pay-1', accountingInvoiceId: null }],
    accountingInvoiceId: 'INV-2',
  })
  assert.deepEqual(awaiting.map((r) => r.id), ['pay-2'])
})

// ---------------------------------------------------------------------------
// o3d-anu8 — AN ASSERTED AMOUNT IS NOT A MEASUREMENT.
//
// A row an operator settled as POSTED is SYNCED with a document id, so it is LIVE and the capacity
// sum counts it. But its `amount` came out of the payload IMS BUILT — nothing sent it, nothing read
// the ledger back — and Xero will accept a payment smaller than an invoice as a PART payment while
// handing back a perfectly valid payment id. `ledgerTotal - alreadyRegistered` therefore overstates
// the room left by however much the assertion was wrong, in the direction that lets a second
// payment out.
// ---------------------------------------------------------------------------

test('[o3d-anu8] a live OPERATOR-ASSERTED registration refuses the arithmetic instead of trusting its amount', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 40,
    ledgerTotal: 100,
    existing: [{
      status: 'SYNCED',
      // 60 + 40 = 100 exactly, so WOULD_OVERPAY does not fire and the receipt sails through on a
      // number nothing verified. That is the whole point: the sum is self-consistent and meaningless.
      amount: 60,
      paymentId: 'pay-old',
      accountingInvoiceId: 'INV-1',
      externalTransactionId: 'PAY-TYPED',
      settlementBasis: 'OPERATOR_ASSERTION',
    }],
  })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'LEDGER_AMOUNT_ASSERTED')
  // The refusal NAMES the payment, because unlike LEDGER_AMOUNT_UNKNOWN there is a document to go
  // and read, and reading it is what resolves this.
  assert.equal(d.register === false && d.detail, 'PAY-TYPED')
})

test('[o3d-anu8] the identical row written back by the CONNECTOR still registers', () => {
  // The fence in the other direction: refusing every live SYNCED row would pass the test above while
  // refusing every ordinary deposit-plus-balance. Same numbers, settlementBasis NULL.
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 40,
    ledgerTotal: 100,
    existing: [{
      status: 'SYNCED',
      amount: 60,
      paymentId: 'pay-old',
      accountingInvoiceId: 'INV-1',
      externalTransactionId: 'PAY-REAL',
      settlementBasis: null,
    }],
  })
  assert.equal(d.register, true)
})
