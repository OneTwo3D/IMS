import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPayment,
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  listedLedgerPaymentIds,
  zeroPaidIsProvenReversal,
  type RegisteredPaymentRow,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'
import { qboLedgerAmount, qboWithheldReversalReason } from '@/lib/connectors/quickbooks/payment-poller'

/**
 * o3d-psrx r3 (Codex HIGH) — ONE CASE TABLE, BOTH ENTRY POINTS.
 *
 * Codex's first instruction was to reuse the Xero decision path rather than write a second one, and
 * to say — if the two cannot literally be one function — how they are kept in agreement. They CAN be:
 * `classifyRegisteredPayment` is now `classifyRegisteredPaymentAgainstListing` plus the one line that
 * reads a Xero invoice's `Payments[]`. So agreement is not maintained by discipline, it is maintained
 * by there being one implementation — and this file is the proof of that claim rather than a
 * restatement of it.
 *
 * THE TABLE BELOW IS DRIVEN THROUGH BOTH DOORS and asserted EQUAL, case by case. If somebody re-inlines
 * the decision into the Xero entry point, the two can diverge and this is what notices — the same
 * technique that kept the two bill-payment fences in step on o3d-batch-ret.
 *
 * THE QUICKBOOKS COLUMN is the second half. QuickBooks' reversal read enumerates no payments at all, so
 * its listing is always NULL — and null is "absence cannot be established", never "no payments". Every
 * case therefore states what the SAME evidence decides for a connector that cannot enumerate.
 *
 * r8 (Codex HIGH 2) — AND THAT IS NOW THE SECOND HALF OF WHAT THE GATE ACTS ON, NOT THE WHOLE OF IT.
 * r3 wrote the sentence above as "which is exactly what `gateQboReversalsOnProvenance` acts on", and
 * that was the defect in one line: this whole table presumes the ledger has already been shown to hold
 * NOTHING on the document, which is what makes `LEDGER_DID_NOT_LIST_PAYMENTS` an ADMITTED verdict at
 * all ("the payload withheld the list, but it STATED a zero total"). QuickBooks selected its
 * candidates on `Balance > 0`, under which a PART-removed payment is indistinguishable from a fully
 * removed one, and so reached this table without establishing its subject. The gate now proves the
 * zero first — see `LEDGER_NOT_PROVEN_ZERO_PAID` and the tests for it at the foot of this file — and
 * only then asks the question this table answers.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
const BEFORE_READ = new Date('2026-08-20T11:00:00.000Z')
const AFTER_READ = new Date('2026-08-20T12:00:01.000Z')

const registration = (overrides: Partial<RegisteredPaymentRow> = {}): RegisteredPaymentRow => {
  const row = { id: 'log_1', status: 'SYNCED', externalTransactionId: 'PAY-1', syncedAt: BEFORE_READ, ...overrides }
  return { syncedAtDatabaseClock: row.syncedAt, ...row }
}

/** A sales invoice the ledger says holds NOTHING, listing its (empty) payments. */
const zeroPaidListing = (payments: string[] = []): XeroInvoice => ({
  InvoiceID: 'inv_1',
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  AmountPaid: 0,
  AmountDue: 100,
  Payments: payments.map((PaymentID) => ({ PaymentID })),
})

type Case = {
  name: string
  invoice: XeroInvoice
  registrations: RegisteredPaymentRow[]
  unregisteredReceiptIds: string[]
  paidWithoutLedgerReceipt: boolean
  /** What Xero — which CAN enumerate the payments — concludes. */
  xero: string
  /** What QuickBooks — which cannot — concludes from the same IMS-side evidence. */
  quickbooks: string
  /** Does that QuickBooks verdict permit the reversal? */
  quickbooksReverses: boolean
}

const CASES: Case[] = [
  {
    name: 'THE DEFECT: paid by an operator or a channel, nothing registered, no receipt',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    xero: 'PAID_WITHOUT_LEDGER_RECEIPT',
    quickbooks: 'PAID_WITHOUT_LEDGER_RECEIPT',
    quickbooksReverses: false,
  },
  {
    name: 'THE CONTROL: the same absence of evidence, but the paid flag came from the ledger',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'NOTHING_REGISTERED',
    quickbooks: 'NOTHING_REGISTERED',
    quickbooksReverses: true,
  },
  {
    name: 'a local receipt IMS has not registered yet (the addPayment window)',
    invoice: zeroPaidListing(),
    registrations: [],
    unregisteredReceiptIds: ['pay_1'],
    paidWithoutLedgerReceipt: true,
    xero: 'RECEIPT_NOT_REGISTERED',
    quickbooks: 'RECEIPT_NOT_REGISTERED',
    quickbooksReverses: false,
  },
  {
    name: 'a registration this read cannot speak for (PENDING)',
    invoice: zeroPaidListing(),
    registrations: [registration({ status: 'PENDING' })],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    xero: 'REGISTRATION_UNDECIDED',
    quickbooks: 'REGISTRATION_UNDECIDED',
    quickbooksReverses: false,
  },
  {
    name: 'a registration that SYNCED after the ledger was read',
    invoice: zeroPaidListing(),
    registrations: [registration({ syncedAt: AFTER_READ })],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'REGISTRATION_UNDECIDED',
    quickbooks: 'REGISTRATION_UNDECIDED',
    quickbooksReverses: false,
  },
  {
    name: 'THE GENUINE CHARGEBACK: our payment posted before the read and the ledger no longer lists it',
    invoice: zeroPaidListing(),
    registrations: [registration()],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: true,
    // Xero can enumerate, so it proves the identity is gone.
    xero: 'GONE',
    // QuickBooks cannot enumerate — but it still reverses, which is the point: the marker is
    // SELF-DISCHARGING. Once a registration is proved to have reached the ledger, the ledger decides.
    quickbooks: 'LEDGER_DID_NOT_LIST_PAYMENTS',
    quickbooksReverses: true,
  },
  {
    name: 'our payment posted and the ledger STILL lists it',
    invoice: zeroPaidListing(['PAY-1']),
    registrations: [registration()],
    unregisteredReceiptIds: [],
    paidWithoutLedgerReceipt: false,
    xero: 'STILL_HELD',
    // Unreachable from QuickBooks: with no listing there is nothing to be still held in.
    quickbooks: 'LEDGER_DID_NOT_LIST_PAYMENTS',
    quickbooksReverses: true,
  },
]

for (const c of CASES) {
  test(`[o3d-psrx r3] both entry points agree — ${c.name}`, () => {
    const throughXeroDoor = classifyRegisteredPayment(
      c.invoice, c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    const throughSharedDoor = classifyRegisteredPaymentAgainstListing(
      listedLedgerPaymentIds(c.invoice), c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    // AGREEMENT IS THE ASSERTION, not "both are correct" — that is what makes it survive a future
    // change to what the verdict SHOULD be while still catching the two implementations parting.
    assert.deepEqual(throughXeroDoor, throughSharedDoor,
      'the Xero entry point must be the shared core plus a listing, not a second decision')
    assert.equal(throughXeroDoor.verdict, c.xero)
  })

  test(`[o3d-psrx r3] QuickBooks, which enumerates nothing — ${c.name}`, () => {
    // NULL listing, which is what gateQboReversalsOnProvenance passes for every document.
    const verdict = classifyRegisteredPaymentAgainstListing(
      null, c.registrations, READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt,
    )
    assert.equal(verdict.verdict, c.quickbooks)
    assert.equal(zeroPaidIsProvenReversal(verdict), c.quickbooksReverses,
      c.quickbooksReverses
        ? 'this reversal must still happen — withholding everything would disable the pass'
        : 'this reversal must be withheld — admitting it raises a chargeback against a paid sale')
  })
}

test('[o3d-psrx r3] a null listing is "cannot establish absence", never "no payments"', () => {
  // The distinction the whole QuickBooks arm rests on. An EMPTY listing is a real answer (the ledger
  // enumerated its payments and there are none) and proves our posted payment GONE; a NULL listing
  // enumerated nothing and proves only that this read cannot say.
  const posted = [registration()]
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(new Set<string>(), posted, READ_AT),
    { verdict: 'GONE', paymentIds: ['PAY-1'] },
  )
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(null, posted, READ_AT),
    { verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' },
  )
})

test('[o3d-psrx r3] a null fence decides nothing, on either door', () => {
  const invoice = zeroPaidListing()
  const rows = [registration()]
  assert.deepEqual(
    classifyRegisteredPayment(invoice, rows, null, [], true),
    classifyRegisteredPaymentAgainstListing(null, rows, null, [], true),
  )
  assert.equal(classifyRegisteredPaymentAgainstListing(null, rows, null).verdict, 'REGISTRATION_UNDECIDED')
})

test('[o3d-psrx r3] every withheld verdict can tell an operator what to do about it', () => {
  // A withheld reversal leaves `paidAt` set and raises no credit note. The audit entry is the ONLY
  // durable record that a human has to look at it — a generic sentence there is a lost reversal.
  const withheld = [
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' as const },
    { verdict: 'RECEIPT_NOT_REGISTERED' as const, paymentIds: ['pay_1'] },
    { verdict: 'REGISTRATION_UNDECIDED' as const, entryIds: ['log_1'] },
    { verdict: 'STILL_HELD' as const, paymentIds: ['PAY-1'] },
    // o3d-psrx r8: the two ways the ledger can fail to show a zero, and they ask the operator for
    // DIFFERENT things — reconcile a payment that is visibly still applied, versus go and look at a
    // document whose figures IMS could not read at all.
    { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID' as const, paidAmount: 50, documentTotal: 100 },
    { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID' as const, paidAmount: null, documentTotal: null },
  ]
  const reasons = withheld.map((v) => qboWithheldReversalReason(v))
  for (const reason of reasons) {
    assert.ok(reason.length > 80, `too terse to act on: ${reason}`)
    assert.ok(/paidAt was LEFT SET/i.test(reason), `must say the flag was kept: ${reason}`)
  }
  assert.equal(new Set(reasons).size, reasons.length, 'each withheld state needs its OWN explanation')
  // And it names the rows an operator would go and look at.
  assert.match(reasons[1], /pay_1/)
  assert.match(reasons[2], /log_1/)
})

// ---------------------------------------------------------------------------
// o3d-psrx r4 (Codex HIGH) — THE BINDING, THROUGH THE DOOR THE DEFECT CAME IN BY.
//
// Codex's route is QuickBooks: it enumerates no payments, so a stale registration that reaches
// `posted` lands on LEDGER_DID_NOT_LIST_PAYMENTS, which `zeroPaidIsProvenReversal` ADMITS. The
// pure-function cases below are that route with nothing else in the way; the wiring — that the
// evidence read actually supplies the binding off real rows — is proved against a real database in
// tests/concurrency/paid-provenance-reversal.concurrent.test.ts.
// ---------------------------------------------------------------------------

/** The paid state a document is in NOW: which ledger document, and (sales) when this episode began. */
const paidState = (accountingInvoiceId: string | null, unregisteredPaidAt: Date | null = null) =>
  ({ accountingInvoiceId, unregisteredPaidAt })

const EPISODE_2_BEGAN = new Date('2026-08-20T11:30:00.000Z')

test('[o3d-psrx r4] a registration from an EARLIER paid episode leaves the marker standing', () => {
  // Posted at 11:00, this paid state entered at 11:30, ledger read at 12:00. Everything about the row
  // is impeccable — SYNCED, database-stamped, a real ledger payment id, before the fence, and against
  // THIS document. It is simply about a payment that was taken away before this flag was set.
  const stale = registration({ registeredAgainstInvoiceId: 'inv_1', syncedAt: BEFORE_READ })
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(null, [stale], READ_AT, [], true, paidState('inv_1', EPISODE_2_BEGAN)),
    { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' },
    'the marker says this paid state was never going to have a ledger receipt; a row from the '
    + 'PREVIOUS one cannot contradict it',
  )
  // WITHOUT the binding this is the exact defect: admitted, and a chargeback credit note raised.
  const unbound = classifyRegisteredPaymentAgainstListing(null, [stale], READ_AT, [], true)
  assert.equal(unbound.verdict, 'LEDGER_DID_NOT_LIST_PAYMENTS')
  assert.equal(zeroPaidIsProvenReversal(unbound), true,
    'stated so the danger is visible: with no binding the stale row makes this an ADMITTED reversal')
})

test('[o3d-psrx r4] a registration raised DURING this paid state still discharges the marker', () => {
  // The control for the case above, and the reason the marker is self-discharging at all (6oyu.6): a
  // WooCommerce chargeback on an order IMS did register must still reverse.
  const current = registration({ registeredAgainstInvoiceId: 'inv_1', syncedAt: new Date('2026-08-20T11:45:00.000Z') })
  assert.deepEqual(
    classifyRegisteredPaymentAgainstListing(
      new Set<string>(), [current], READ_AT, [], true, paidState('inv_1', EPISODE_2_BEGAN),
    ),
    { verdict: 'GONE', paymentIds: ['PAY-1'] },
  )
})

test('[o3d-psrx r4] a registration against a document this one replaced is UNDECIDED, not absent', () => {
  const stranded = registration({ id: 'log_old', registeredAgainstInvoiceId: 'inv_deleted' })
  const verdict = classifyRegisteredPaymentAgainstListing(null, [stranded], READ_AT, [], false, paidState('inv_1'))
  assert.deepEqual(verdict, { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_old'] })
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
  // NOT `NOTHING_REGISTERED`. Dropping the row would be the opposite mistake and a worse one: the
  // ledger may still be holding that payment, and NOTHING_REGISTERED is an ADMITTED reversal.
  assert.notEqual(verdict.verdict, 'NOTHING_REGISTERED')
})

test('[o3d-psrx r4] a registration that names NO document binds to nothing (legacy and compacted rows)', () => {
  // A row from before the payload carried `accountingInvoiceId`, or one retention-compacted to `{}`
  // (o3d-m5qk). "We cannot tell which document this was about" is not "it was about this one".
  for (const registeredAgainstInvoiceId of [null, undefined, '', '   ']) {
    const legacy = registration({ id: 'log_legacy', registeredAgainstInvoiceId })
    assert.deepEqual(
      classifyRegisteredPaymentAgainstListing(null, [legacy], READ_AT, [], false, paidState('inv_1')),
      { verdict: 'REGISTRATION_UNDECIDED', entryIds: ['log_legacy'] },
      `registeredAgainstInvoiceId=${JSON.stringify(registeredAgainstInvoiceId)}`,
    )
  }
})

test('[o3d-psrx r4] a caller that supplies no binding decides exactly what it decided before', () => {
  // Every existing caller — `classifyRegisteredPayment` and its tests above — passes no binding, and
  // this is what makes that safe to say rather than to assume.
  const rows = [registration({ registeredAgainstInvoiceId: 'inv_whatever' })]
  for (const listing of [null, new Set<string>(), new Set(['pay-1'])]) {
    assert.deepEqual(
      classifyRegisteredPaymentAgainstListing(listing, rows, READ_AT, [], true),
      classifyRegisteredPaymentAgainstListing(listing, rows, READ_AT, [], true, null),
    )
  }
})

test('[o3d-psrx r4] the binding narrows the evidence; it never admits a reversal on its own', () => {
  // The whole safety argument, over the case table above: a binding that REJECTS every registration
  // can only move a verdict from ADMITTED to WITHHELD, never the reverse. That is what makes r4 safe
  // to ship without re-arguing each of the earlier rounds' verdicts.
  assert.ok(CASES.length >= 5, `the table must actually have cases in it, found ${CASES.length}`)
  let changed = 0
  for (const c of CASES) {
    const withBinding = classifyRegisteredPaymentAgainstListing(
      null, c.registrations.map((r) => ({ ...r, registeredAgainstInvoiceId: 'inv_someone_else' })),
      READ_AT, c.unregisteredReceiptIds, c.paidWithoutLedgerReceipt, paidState('inv_1'),
    )
    if (withBinding.verdict !== c.quickbooks) changed++
    assert.ok(!zeroPaidIsProvenReversal(withBinding) || c.quickbooksReverses,
      `${c.name}: rejecting every registration turned a WITHHELD verdict into an ADMITTED one`)
  }
  // Non-vacuity: if rejecting every registration changed nothing anywhere, the loop above proved
  // nothing about the binding and would keep passing with the binding deleted.
  assert.ok(changed > 0,
    'rejecting every registration must actually change some verdict, or this test is examining nothing')
})

// ---------------------------------------------------------------------------
// o3d-psrx r8 (Codex HIGH 2) — THE PRECONDITION THE TABLE ABOVE PRESUMES.
//
// `zeroPaidIsProvenReversal` answers "may a ZERO-PAID document clear `paidAt`". Its subject is not
// established by any of the evidence in this file: the classifier reads registrations, receipts and
// provenance, and never an amount the ledger states. Xero established it upstream
// (`partitionPaymentReversals`, `AmountPaid`); the QuickBooks poller did not, and its candidates were
// documents showing merely a BALANCE DUE — which a part-removed payment produces exactly as a fully
// removed one does. So a document with posted registrations landed on LEDGER_DID_NOT_LIST_PAYMENTS,
// which ADMITS, and a full chargeback was raised while QuickBooks still held some of the money.
//
// The wiring — that the QuickBooks gate now proves the zero before asking the question, and that a
// balance-due document with a surviving payment is withheld while a fully-removed one still reverses
// — is proved against a real database and the poller's own query in
// tests/concurrency/qbo-paid-provenance-reversal.concurrent.test.ts. What is pinned HERE is the
// decision and the arithmetic it rests on.
// ---------------------------------------------------------------------------

test('[o3d-psrx r8] a ledger not shown to hold nothing is never a proven reversal', () => {
  for (const paidAmount of [50, 0.01, -25, null]) {
    assert.equal(
      zeroPaidIsProvenReversal({ verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount, documentTotal: 100 }),
      false,
      `paidAmount=${paidAmount}: a balance due is not proof the payments IMS registered were removed`,
    )
  }
})

test('[o3d-psrx r8] the QuickBooks paid amount is TotalAmt - Balance, and NULL when either will not say', () => {
  // THE ARITHMETIC IS THE EVIDENCE, and it comes out of the response the reversal read ALREADY takes:
  // `qboQuery` issues `SELECT *`, so both figures are on the row. No QuickBooks call is added by this
  // round, which is what stops the gate being something a rate-limited poll can skip.
  assert.deepEqual(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 50 }), { paid: 50, total: 100 },
    'one of two payments removed: the ledger is still holding half of this document')
  assert.deepEqual(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 100 }), { paid: 0, total: 100 },
    'every payment removed: the zero the admitting arms are written about')
  // QuickBooks serialises money as a number, but `parseLedgerAmount` is the reader Xero's own amount
  // partition uses and it accepts the string form — one dialect of "is this a number" across both.
  assert.deepEqual(qboLedgerAmount({ Id: '1', TotalAmt: '100.00', Balance: '0.00' }), { paid: 100, total: 100 })

  // NULL IS NOT ZERO. Each of these is a payload that did not state a figure this code can use, and
  // the withheld direction is the only honest one: a document might be holding anything.
  for (const row of [
    { Id: '1', TotalAmt: 100 },                     // no Balance
    { Id: '1', Balance: 50 },                       // no TotalAmt — the by-id read marks it optional
    { Id: '1', TotalAmt: 100, Balance: 'n/a' },
    { Id: '1', TotalAmt: null, Balance: 0 },
    { Id: '1', TotalAmt: 100, Balance: Number.NaN },
  ]) {
    assert.equal(qboLedgerAmount(row).paid, null, `must not produce a figure from ${JSON.stringify(row)}`)
    assert.equal(
      zeroPaidIsProvenReversal({ verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: null, documentTotal: null }),
      false,
      'and an unreadable figure withholds, rather than falling into an admitting arm by default',
    )
  }
})

test('[o3d-psrx r8] the two ways the zero is unproven do not borrow each other\'s sentence', () => {
  // WHY THIS IS NOT COVERED BY THE CENSUS ABOVE. That test asserts every withheld verdict gets its
  // OWN explanation, and it compares whole strings — so two readings of this verdict that share a
  // sentence and differ only where a figure is interpolated still pass it, distinct and both wrong.
  // Collapse the branch and the unreadable case reports "QuickBooks still shows null of this document
  // as PAID", which is not a smaller answer: it is an assertion about money nobody established.
  const measured = qboWithheldReversalReason({
    verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: 50, documentTotal: 100,
  })
  assert.match(measured, /\b50\b/, 'a measured amount must name what QuickBooks is still holding')
  assert.match(measured, /\b100\b/, 'and what it is a part OF, which is the operator\'s next question')

  const unreadable = qboWithheldReversalReason({
    verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: null, documentTotal: null,
  })
  assert.doesNotMatch(unreadable, /\d|null/i,
    'an amount that could not be read must not be REPORTED as an amount — the operator is being sent '
    + 'to look at the document precisely because IMS has no figure for it')
  assert.match(unreadable, /could not read|not.*read|without stating/i,
    'and it must say that is why, or the warning is indistinguishable from the measured one')
})
