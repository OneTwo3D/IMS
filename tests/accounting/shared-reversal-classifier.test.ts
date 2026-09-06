import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPayment,
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  ledgerAmountMagnitudeBound,
  listedLedgerPaymentIds,
  parseLedgerAmount,
  partitionPaymentReversals,
  readDecimalAsNumber,
  readLedgerDifferenceAsNumber,
  zeroPaidIsProvenReversal,
  type RegisteredPaymentRow,
  type XeroInvoice,
} from '@/lib/connectors/xero/invoice-delta'
import {
  classifyQboLedgerEvidence,
  qboLedgerAmount,
  qboWithheldReversalReason,
  resolveLedgerRowCurrency,
} from '@/lib/connectors/quickbooks/payment-poller'
import { currencyMinorUnits, ledgerAmountEpsilon, toDecimal } from '@/lib/domain/math/decimal'

/**
 * One row of a QuickBooks reversal read, put through the PRODUCTION reader.
 *
 * Deliberately not a hand-built object: `qboLedgerAmount` is where `TotalAmt - Balance` is done in
 * decimal and where `CurrencyRef` is parsed, and a fixture that reimplemented either would be testing
 * the classifier against arithmetic production does not perform. `100 - 99.999` in binary floating
 * point is 0.0009999999999976353, which is a different answer from the one production gives, and it
 * is exactly the size of figure the currency-aware threshold is about.
 */
// o3d-psrx r16: the figures may be given as STRINGS as well as numbers, because after r16 the two
// arms of `parseLedgerAmount` answer differently and several cases below are about exactly that. A
// string is what QuickBooks sends when it serialises money as text, and it carries its own decimal
// evidence; a number has already been through `Response.json()` and carries none.
const ledgerAmount = (
  total: number | string | null,
  balance: number | string | null,
  currency: string | null = null,
) =>
  qboLedgerAmount({
    Id: 'row',
    TotalAmt: total ?? undefined,
    Balance: balance ?? undefined,
    CurrencyRef: currency == null ? undefined : { value: currency },
  })

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
    // DIFFERENT things — go and look at figures that do not describe a removal, versus go and look at
    // a document whose figures IMS could not read at all.
    { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID' as const, paidAmount: 100, documentTotal: 100 },
    { verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID' as const, paidAmount: null, documentTotal: null },
    // o3d-psrx r9: and the one that is not a failure to establish anything. It belongs in this census
    // because it is withheld like the rest — and it is the one whose sentence has the most work to do,
    // since it is the only withheld state IMS will never resolve by itself.
    {
      verdict: 'LEDGER_PARTIALLY_PAID' as const,
      paidAmount: 50, documentTotal: 100, outstandingAmount: 50, currency: 'GBP',
    },
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
// o3d-psrx r8 (Codex HIGH 2) — THE UNSTATED FACT THE TABLE ABOVE PRESUMES.
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
  assert.deepEqual(
    qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 50 }),
    { paid: 50, total: 100, outstanding: 50, currency: null, currencySource: 'NONE' },
    'half the document settled: the ledger is still accounting for the rest of it')
  assert.deepEqual(
    qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 100 }),
    { paid: 0, total: 100, outstanding: 100, currency: null, currencySource: 'NONE' },
    'nothing settled: the zero the admitting arms are written about')
  // QuickBooks serialises money as a number, but `parseLedgerAmount` is the reader Xero's own amount
  // partition uses and it accepts the string form — one dialect of "is this a number" across both.
  assert.deepEqual(
    qboLedgerAmount({ Id: '1', TotalAmt: '100.00', Balance: '0.00' }),
    { paid: 100, total: 100, outstanding: 0, currency: null, currencySource: 'NONE' })
  // o3d-psrx r10 (Codex HIGH 3): and the CURRENCY, off the same row — `qboQuery` issues `SELECT *`,
  // so `CurrencyRef` is already in the response. Both spellings QuickBooks uses are read.
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 50, CurrencyRef: { value: 'kwd' } }).currency, 'KWD')
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 50, CurrencyRef: 'JOD' }).currency, 'JOD')
  for (const bad of [undefined, null, '', 'GBPX', { value: 42 }, {}]) {
    assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 50, CurrencyRef: bad }).currency, null,
      `a currency that is not an ISO-4217-shaped code must be NULL rather than a guess: ${JSON.stringify(bad)}`)
  }
  // o3d-psrx r10: THE SUBTRACTION IS DECIMAL, and it has to be. In IEEE-754 `100 - 99.999` is
  // 0.0010000000000047748 and `100.1 - 50.1` is 49.99999999999999 — dust of a size a four-decimal
  // currency's threshold can see, produced by arithmetic on figures that are exact in the ledger.
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 99.999 }).paid, 0.001,
    'one minor unit of a 3-decimal currency, not 0.0010000000000047748')
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 99.9999 }).paid, 0.0001,
    'and one minor unit of a 4-decimal currency')
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100.1, Balance: 50.1 }).paid, 50)
  // ...and the OUTSTANDING figure is never a subtraction at all: it is the Balance the ledger stated.
  assert.equal(qboLedgerAmount({ Id: '1', TotalAmt: 100, Balance: 99.999 }).outstanding, 99.999)

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
  // r9 CHANGED THE FIXTURE, and the change is the finding. `paidAmount: 50, documentTotal: 100` is no
  // longer this verdict at all — a document the ledger STATES as part paid is `LEDGER_PARTIALLY_PAID`
  // now — so testing this branch with it would be testing a state the gate cannot produce. What is
  // left here is a figure that does not describe a removal: the ledger reporting it still fully paid.
  const measured = qboWithheldReversalReason({
    verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: 100, documentTotal: 100,
  })
  assert.match(measured, /\b100\b/, 'a stated amount must be named, or the operator has nothing to check against')
  assert.doesNotMatch(measured, /part of the money missing|has been removed/i,
    'and it must NOT describe a removal: nothing here has been shown to be missing, and this branch '
    + 'saying otherwise is exactly the assertion-about-unestablished-money r9 split out')

  const unreadable = qboWithheldReversalReason({
    verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID', paidAmount: null, documentTotal: null,
  })
  assert.doesNotMatch(unreadable, /\d|null/i,
    'an amount that could not be read must not be REPORTED as an amount — the operator is being sent '
    + 'to look at the document precisely because IMS has no figure for it')
  assert.match(unreadable, /could not read|not.*read|without stating/i,
    'and it must say that is why, or the warning is indistinguishable from the measured one')
})

// ---------------------------------------------------------------------------
// o3d-psrx r9 (Codex HIGH) — A DOCUMENT THE LEDGER STATES AS PART PAID IS NOT AN UNCERTAINTY.
//
// r8 closed a false full-reversal by refusing to reverse anything the ledger had not been shown to
// hold NOTHING on. Codex's finding is what that cost: every non-zero answer went into ONE verdict
// meaning "IMS could not establish this", including the case where IMS established it perfectly.
// A 100 document with 50 settled against it is `TotalAmt = 100, Balance = 50` — stable, unambiguous,
// and the same on every future poll. Filed under "unproven", with `paidAt` left set, it was in
// practice absorbed as "still paid" and there was nothing in IMS to find it by.
//
// The split changes NO reversal decision. What it changes is what the record can say, which is the
// whole of the fix — reconciling the difference is o3d-cdhl and is deliberately not built.
//
// o3d-psrx r10 (Codex HIGH 1) changed what the record is ALLOWED to say. See the tests below it.
// ---------------------------------------------------------------------------

test('[o3d-psrx r9] a stated part-paid position and an evidence absence are different answers', () => {
  const cases: Array<{ name: string; amount: Parameters<typeof classifyQboLedgerEvidence>[0]; expect: ReturnType<typeof classifyQboLedgerEvidence> }> = [
    {
      name: 'CODEX\'S CASE: a 100 document with 50 settled against it',
      amount: ledgerAmount(100, 50, 'GBP'),
      expect: { kind: 'PARTIALLY_PAID', paidAmount: 50, documentTotal: 100, outstandingAmount: 50, currency: 'GBP' },
    },
    {
      name: 'nothing settled — the zero the admitting arms are written about',
      amount: ledgerAmount(100, 100, 'GBP'),
      expect: { kind: 'HOLDS_NOTHING' },
    },
    {
      name: 'THE CONTROL THAT STOPS THIS CRYING WOLF: the ledger accounts for the WHOLE document',
      amount: ledgerAmount(100, 0, 'GBP'),
      // The ledger and IMS agree about it, so there is nothing to report. Classified UNPROVEN rather
      // than PARTIALLY_PAID because "paid equals the total" is not a partial anything — and a rule
      // that called it one would warn about every fully-settled document that ever reached the gate,
      // which is how an operator learns to ignore the warnings that are real.
      expect: { kind: 'UNPROVEN', paidAmount: 100, documentTotal: 100, currencyUnbound: false },
    },
    {
      // o3d-psrx r16 read this as a STRING so it would survive the scale rule the number arm had just
      // been given, and r18 (Codex HIGH 1) closed that door: the scale rule belongs to the CURRENCY,
      // so both arms refuse a three-decimal GBP figure and this case changed meaning rather than
      // merely changing arm.
      //
      // AND THE READING IT USED TO ASSERT IS NOW UNREACHABLE, WHICH IS THE POINT. `paidAmount: 99.999`
      // was "a residual strictly inside the epsilon". The epsilon is half a minor unit (r17) and every
      // admitted figure is a whole multiple of one (r16/r18), so no stated balance can land inside it
      // any more — the band survives only for DERIVED arithmetic dust. The case is kept, aimed at what
      // actually happens now, and the impossibility is asserted directly below.
      name: 'a balance finer than the currency can state is not read at all',
      amount: ledgerAmount(100, '0.001', 'GBP'),
      expect: { kind: 'UNPROVEN', paidAmount: null, documentTotal: 100, currencyUnbound: false },
    },
    {
      name: 'a figure QuickBooks would not state',
      amount: ledgerAmount(null, null),
      // o3d-psrx r15: this fixture states no currency either, so the binding flag is TRUE — and that
      // is the honest reading of it, because nothing here could size a minor unit.
      expect: { kind: 'UNPROVEN', paidAmount: null, documentTotal: null, currencyUnbound: true },
    },
    {
      name: 'an amount settled, against a total the payload did not state — nothing can be quantified',
      amount: { paid: 50, total: null, outstanding: 50, currency: 'GBP', currencySource: 'LEDGER' as const },
      expect: { kind: 'UNPROVEN', paidAmount: 50, documentTotal: null, currencyUnbound: false },
    },
    {
      name: 'a NEGATIVE settled amount — over-credited, and this code has no honest reading of it',
      amount: ledgerAmount(100, 125, 'GBP'),
      expect: { kind: 'UNPROVEN', paidAmount: -25, documentTotal: 100, currencyUnbound: false },
    },
    {
      // o3d-psrx r16 — A READ THAT SUCCEEDED AND STILL COULD NOT SIZE ITS OWN MINOR UNIT. The figures
      // here are ordinary and read fine at the strictest precision, so this reaches the LAST UNPROVEN
      // return rather than the early one — the other place the binding marker is set, and previously
      // the only one no case exercised.
      name: 'fully settled, but nothing said what currency it is in — the binding defect stands',
      amount: ledgerAmount(100, 0),
      expect: { kind: 'UNPROVEN', paidAmount: 100, documentTotal: 100, currencyUnbound: true },
    },
    {
      name: 'a document this read said NOTHING about is not a document with nothing on it',
      amount: undefined,
      // A document the read said NOTHING about has no binding to report on — see the classifier.
      expect: { kind: 'UNPROVEN', paidAmount: null, documentTotal: null, currencyUnbound: false },
    },
  ]
  for (const c of cases) {
    assert.deepEqual(classifyQboLedgerEvidence(c.amount), c.expect, c.name)
  }
  // AND THE FIGURES RECONCILE: whatever else changes, what the ledger says is settled plus what it
  // says is outstanding is the document. Three figures that do not add up are worse than none.
  const stated = classifyQboLedgerEvidence(ledgerAmount(100, 70, 'GBP'))
  assert.equal(stated.kind, 'PARTIALLY_PAID')
  if (stated.kind !== 'PARTIALLY_PAID') return
  assert.equal(stated.paidAmount + stated.outstandingAmount, stated.documentTotal)
})

test('[o3d-psrx r9] a part-paid document withholds exactly as the verdict it was split out of', () => {
  // THE SPLIT MUST MOVE NO MONEY. If separating the stated case had made it ADMIT, r9 would have
  // re-opened the very defect r8 closed — a full chargeback credit note raised over the part the
  // ledger is still accounting for.
  assert.equal(
    zeroPaidIsProvenReversal({
      verdict: 'LEDGER_PARTIALLY_PAID', paidAmount: 50, documentTotal: 100, outstandingAmount: 50,
      currency: 'GBP',
    }),
    false,
    'the ledger still accounts for half of this document, so the whole of it plainly has not been '
    + 'given back',
  )
})

// ---------------------------------------------------------------------------
// o3d-psrx r10 (Codex HIGH 1) — THE VERDICT NAMED A REMOVAL IT CANNOT SEE.
//
// r9 called this `LEDGER_PART_PAYMENT_REMOVED` and its third figure `removedAmount`, on the strength
// of `TotalAmt - Balance`. Those two fields describe the document AS IT STANDS: there is no prior
// amount in them and no payment history. So a document that was only ever part paid — invoiced at
// 100, settled with a single 50 — produces figures identical to one that carried 100 and lost 50.
// r9 measured "partly paid now" and reported "a payment was removed".
//
// The quantity was real; the story about it was not, and the story is the part an operator acts on.
// This is the same defect the sibling reports branch is fixing in its operator notice: state what the
// comparison establishes, and nothing beyond it.
// ---------------------------------------------------------------------------

test('[o3d-psrx r10] a document only ever part paid is the SAME reading as one that lost a payment', () => {
  // TWO DIFFERENT HISTORIES, and QuickBooks answers about them with the same row. That equality IS
  // the finding, asserted rather than described: nothing downstream of this point can tell them
  // apart, so nothing downstream of this point may claim to.
  const onlyEverPartPaid = qboLedgerAmount({ Id: 'A', TotalAmt: 100, Balance: 50, CurrencyRef: { value: 'GBP' } })
  const lostOneOfTwoPayments = qboLedgerAmount({ Id: 'B', TotalAmt: 100, Balance: 50, CurrencyRef: { value: 'GBP' } })
  assert.deepEqual(onlyEverPartPaid, lostOneOfTwoPayments,
    'a 100 invoice settled by a single 50 and a 100 invoice settled by two 50s one of which was '
    + 'deleted are the SAME TotalAmt and the SAME Balance — the read carries no history to tell them '
    + 'apart, which is why r9 was wrong to name one of them')

  const verdicts = [onlyEverPartPaid, lostOneOfTwoPayments].map((amount) => {
    const evidence = classifyQboLedgerEvidence(amount)
    assert.equal(evidence.kind, 'PARTIALLY_PAID', 'both must reach the same neutral classification')
    return evidence
  })
  assert.deepEqual(verdicts[0], verdicts[1], 'and it must carry the same figures for both')
  assert.deepEqual(verdicts[0], {
    kind: 'PARTIALLY_PAID', paidAmount: 50, documentTotal: 100, outstandingAmount: 50, currency: 'GBP',
  }, 'THE NAME AND THE FIELDS: what is settled, what the document is for, and what is OUTSTANDING — '
    + 'the ledger\'s own balance. Not a removed amount, which is a claim about a payment that may '
    + 'never have existed')

  // AND THE FIGURE IS THE LEDGER'S, NOT A SUBTRACTION OF OURS. `outstandingAmount` must be the
  // `Balance` QuickBooks stated: an inference dressed as a stated figure is the same fault again.
  assert.equal(verdicts[0].kind === 'PARTIALLY_PAID' && verdicts[0].outstandingAmount, onlyEverPartPaid.outstanding)
})

test('[o3d-psrx r10] the part-paid warning states the comparison and disclaims the removal', () => {
  const reason = qboWithheldReversalReason({
    verdict: 'LEDGER_PARTIALLY_PAID', paidAmount: 40, documentTotal: 100, outstandingAmount: 60,
    currency: 'KWD',
  })
  // ALL THREE FIGURES, AND THE CURRENCY. "Part of it is unpaid" is not actionable; "40 of 100 is
  // settled and 60 is outstanding, in KWD" is what an operator reconciles against — and an amount
  // reported without its currency cannot be added to anything.
  assert.match(reason, /\b40\b/, 'what the ledger says is settled')
  assert.match(reason, /\b100\b/, 'what it is a part OF')
  assert.match(reason, /\b60\b/, 'and what is still outstanding')
  assert.match(reason, /KWD/, 'in a stated currency')

  // THE DISCLAIMER, which is the whole of r10. Without it the sentence reads as a report that money
  // was taken back, which these two figures cannot establish.
  assert.match(reason, /only ever part paid/i,
    'the operator must be told that a document which was never fully paid produces this same reading')
  assert.match(reason, /NOT a report that a payment was removed/i,
    'and told plainly that this is not a removal, or they go hunting a chargeback that may not exist')

  // AND THE r9 CLAIM SENTENCES MUST BE GONE, in the words r9 actually used. A re-introduction of any
  // of them is a re-introduction of the finding.
  for (const claim of [/has given back/i, /so \d+ has been removed/i, /is a PARTIAL chargeback/i]) {
    assert.doesNotMatch(reason, claim,
      `r9's wording asserted a history the figures do not contain: ${claim}`)
  }

  // AND THE SENTENCE THAT MAKES IT AN OUTSTANDING ITEM RATHER THAN A CURIOSITY. Every other withheld
  // verdict describes something IMS expects to settle by itself. This one must say the opposite, or an
  // operator reasonably files it with them and waits for a poll that is never coming.
  assert.match(reason, /WILL NOT correct that by itself/,
    'the operator has to be told IMS does not reconcile this — there is no partial credit-note path '
    + '(o3d-cdhl), so waiting for one is waiting for ever')
  assert.match(reason, /paidAt was LEFT SET/, 'and that IMS still shows the document as paid meanwhile')

  // A DOCUMENT WHOSE CURRENCY QUICKBOOKS DID NOT STATE still gets a sentence, without a stray code.
  const noCurrency = qboWithheldReversalReason({
    verdict: 'LEDGER_PARTIALLY_PAID', paidAmount: 40, documentTotal: 100, outstandingAmount: 60,
    currency: null,
  })
  assert.match(noCurrency, /\b60\b/)
  assert.doesNotMatch(noCurrency, /\(\s*\)/, 'and no empty parenthetical where the currency would go')
})

// ---------------------------------------------------------------------------
// o3d-psrx r10 (Codex HIGH 3) — THE EPSILON WAS CURRENCY-BLIND.
//
// The threshold was Xero's `PAYMENT_PRESENT_EPSILON`: 0.005, documented for Xero's two-decimal
// amounts. This classifier receives QuickBooks documents and no currency ever reached it, while the repository
// supports three- and four-decimal currencies (`currencyMinorUnits`). Against those, 0.005 is FIVE
// whole minor units in a Gulf dinar and FIFTY in CLF: an amount the ledger really is holding read as
// nothing, the registration gate admitted, and a full chargeback was raised over a document the
// ledger was still accounting for.
// ---------------------------------------------------------------------------

test('[o3d-psrx r10] one minor unit is never zero, in any currency the repository supports', () => {
  // ONE MINOR UNIT of each, still settled on a document whose total the ledger states. Not one of
  // these may read as "the ledger holds nothing".
  const oneMinorUnit: Array<{ currency: string | null; total: number; balance: number; paid: number }> = [
    { currency: 'GBP', total: 100, balance: 99.99, paid: 0.01 },       // 2dp
    { currency: 'JPY', total: 100, balance: 99, paid: 1 },             // 0dp
    { currency: 'KWD', total: 100, balance: 99.999, paid: 0.001 },     // 3dp — 0.005 swallowed this
    { currency: 'CLF', total: 100, balance: 99.9999, paid: 0.0001 },   // 4dp — and five of these
    // An unstated currency takes the STRICTEST threshold rather than the most convenient one: too
    // large a threshold discards a real minor unit and lets a reversal through, while too small a one
    // can only move a document into a verdict that withholds.
    { currency: null, total: 100, balance: 99.9999, paid: 0.0001 },
  ]
  for (const c of oneMinorUnit) {
    const evidence = classifyQboLedgerEvidence(ledgerAmount(c.total, c.balance, c.currency))
    assert.notEqual(evidence.kind, 'HOLDS_NOTHING',
      `${c.currency ?? 'an unstated currency'}: the ledger states ${c.paid} is still settled on this `
      + 'document, which is one whole minor unit — reading it as nothing admits a full reversal over '
      + 'money the ledger is still accounting for')
    assert.equal(evidence.kind, 'PARTIALLY_PAID', `${c.currency ?? 'unstated'}: and it is reported as part paid`)
  }

  // THE CONTROL: narrowing the pass is not the same as switching it off. A ledger that states NOTHING
  // is settled must still admit, or every genuine chargeback stops being recognised.
  //
  // o3d-psrx r18 (Codex HIGH 1) — AND "BELOW ONE MINOR UNIT" IS NO LONGER A FIGURE A LEDGER CAN STATE,
  // WHICH IS WHY THIS CONTROL CHANGED SHAPE. r16 wrote these balances as STRINGS (`'99.999'` in GBP,
  // `'99.6'` in JPY) precisely because the scale rule it had just added to the number arm would refuse
  // them; the string arm still admitted them, and that asymmetry is the r18 finding. Now that the
  // scale rule belongs to the currency rather than to an arm, EVERY admitted figure is a whole
  // multiple of its minor unit — so a paid amount is either 0 or at least one whole unit, and the
  // epsilon (half a unit, r17) has nothing between those two to decide. It survives for derived
  // arithmetic dust and for nothing that a ledger states.
  //
  // So the control is the reading that IS reachable: exactly zero settled.
  const nothingSettled: Array<{ currency: string; total: number; balance: string }> = [
    { currency: 'GBP', total: 100, balance: '100' },
    { currency: 'JPY', total: 100, balance: '100' },
    { currency: 'KWD', total: 100, balance: '100.000' },
  ]
  for (const c of nothingSettled) {
    assert.deepEqual(
      classifyQboLedgerEvidence(ledgerAmount(c.total, c.balance, c.currency)),
      { kind: 'HOLDS_NOTHING' },
      `${c.currency}: a ledger that states the whole document is outstanding holds nothing, and a `
      + 'genuine reversal must still be able to proceed',
    )
    // AND THE TWO ARMS AGREE ABOUT IT, which after r18 is a property of every figure rather than of
    // the well-behaved ones: the same value as a decoded JSON NUMBER reaches the same verdict.
    assert.deepEqual(classifyQboLedgerEvidence(ledgerAmount(c.total, Number(c.balance), c.currency)),
      { kind: 'HOLDS_NOTHING' },
      `${c.currency}: a string and a number of the same value must classify identically`)
  }

  // AND THE BAND REALLY IS EMPTY FOR STATED FIGURES, asserted rather than left as prose above. For
  // every currency the repository supports, a balance one minor unit short of the total is READ and
  // is NOT nothing, while anything finer than that is not read at all — in either arm. There is no
  // third case, so no stated residual can fall inside the epsilon.
  for (const currency of ['GBP', 'JPY', 'KWD', 'CLF']) {
    const unit = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
    const oneUnitShort = toDecimal(100).minus(unit).toString()
    const halfUnitShort = toDecimal(100).minus(unit.div(2)).toString()
    assert.equal(classifyQboLedgerEvidence(ledgerAmount(100, oneUnitShort, currency)).kind, 'PARTIALLY_PAID',
      `${currency}: one whole minor unit settled is a payment, not nothing`)
    for (const form of [halfUnitShort, Number(halfUnitShort)]) {
      assert.equal(classifyQboLedgerEvidence(ledgerAmount(100, form, currency)).kind, 'UNPROVEN',
        `${currency}: HALF a minor unit is not a figure this currency can state, in either arm — so `
        + 'there is nothing left for the epsilon to admit as zero')
    }
  }
})

test('[o3d-psrx r10] the threshold is strictly below one minor unit of the currency', () => {
  // The rule stated directly, so a future change to how it is computed is measured against the RULE
  // rather than against the numbers it happens to produce today.
  for (const currency of ['GBP', 'USD', 'JPY', 'KRW', 'KWD', 'BHD', 'CLF', 'UYW']) {
    const epsilon = ledgerAmountEpsilon(currency)
    const oneMinorUnit = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
    assert.ok(epsilon.lt(oneMinorUnit),
      `${currency}: a threshold at or above one minor unit discards a real payment as zero `
      + `(epsilon ${epsilon.toString()}, minor unit ${oneMinorUnit.toString()})`)
    assert.ok(epsilon.gt(0), `${currency}: and a zero threshold would make float dust a payment`)
  }
  // The two-decimal case is unchanged from the fixed 0.005 this replaced, so nothing about the
  // ordinary currency moves. Written out as the literal it has to equal: the constant it used to be
  // compared against was deleted in r17, and a test that compared the rule against itself would pass
  // however the rule moved.
  assert.equal(ledgerAmountEpsilon('GBP').toString(), '0.005')
  // An unstated currency takes the finest precision the repository supports.
  assert.ok(ledgerAmountEpsilon(null).lte(ledgerAmountEpsilon('CLF')),
    'an unstated currency must be no more permissive than the finest currency it could be')
})

// ---------------------------------------------------------------------------
// o3d-psrx r16 (Codex HIGH 2) — AN UNVERIFIED CURRENCY MAY TIGHTEN A READ AND MAY NEVER LOOSEN ONE.
// ---------------------------------------------------------------------------

test('[o3d-psrx r16] an IMS currency can never raise the bound above the strictest', () => {
  // THE RULE, OVER EVERY CURRENCY THE REPOSITORY SUPPORTS, rather than over the two the poller happens
  // to meet. `resolveLedgerRowCurrency` is handed an unstated `CurrencyRef` and each IMS code in turn,
  // and the question asked of every answer is the same one: could believing this make the reader
  // admit a figure the strictest fallback would have refused?
  const supported = ['GBP', 'USD', 'EUR', 'JPY', 'KRW', 'ISK', 'BHD', 'IQD', 'JOD', 'KWD', 'LYD',
    'OMR', 'TND', 'CLF', 'UYW', 'VND', 'XOF']
  const strictestBound = ledgerAmountMagnitudeBound(null)
  const strictestEpsilon = ledgerAmountEpsilon(null)
  for (const ims of supported) {
    const resolved = resolveLedgerRowCurrency(undefined, ims)
    assert.equal(resolved.stated, null, `${ims}: nothing was stated, and an inference is never stated`)
    assert.ok(ledgerAmountMagnitudeBound(resolved.read) <= strictestBound,
      `${ims}: an unverified IMS currency must not select a LARGER magnitude bound than the unstated `
      + 'fallback — a coarser bound admits a decode collapse the bound exists to refuse')
    assert.ok(ledgerAmountEpsilon(resolved.read).lte(strictestEpsilon),
      `${ims}: nor a larger epsilon, which would discard a real minor unit as nothing`)
  }

  // AND THE TWO ANSWERS IT ACTUALLY GIVES, so this cannot pass by refusing to resolve anything.
  // A currency at least as fine as the fallback is accepted and labelled; a coarser one is not used
  // at all, and the row is recorded as having no binding rather than a borrowed one.
  assert.deepEqual(resolveLedgerRowCurrency(undefined, 'CLF'),
    { stated: null, read: 'CLF', source: 'IMS_DOCUMENT' },
    'four decimals is the finest precision supported, so believing it loosens nothing')
  assert.deepEqual(resolveLedgerRowCurrency(undefined, 'GBP'),
    { stated: null, read: null, source: 'NONE' },
    'THE FINDING: two decimals is COARSER than the fallback, so it is not used — this is the exact '
    + 'substitution that let 600000000000.0003 and 600000000000.0002 collapse into one reading')
  assert.deepEqual(resolveLedgerRowCurrency(undefined, 'not-a-currency'),
    { stated: null, read: null, source: 'NONE' })

  // THE LEDGER'S OWN STATEMENT IS UNAFFECTED AND STILL WINS, including over a finer IMS code — it is
  // the only source anything has actually vouched for.
  assert.deepEqual(resolveLedgerRowCurrency({ value: 'GBP' }, 'CLF'),
    { stated: 'GBP', read: 'GBP', source: 'LEDGER' },
    'a currency QuickBooks stated is authoritative, and it is not second-guessed by an IMS column')
})

// ---------------------------------------------------------------------------
// o3d-psrx r13 (Codex HIGH 2) — THE INPUTS WERE GUARDED AND THE ARITHMETIC BETWEEN THEM WAS NOT.
// ---------------------------------------------------------------------------
//
// r12 put a losslessness round trip on every figure COMING IN. `TotalAmt - Balance` is a Decimal
// subtraction whose result was then handed to a bare `.toNumber()` — so the derived figure, the only
// one any verdict is taken on, was the single unguarded conversion left in the chain.
//
// Both operands can survive the round trip perfectly and their exact difference still not, and the
// pair below is the one from the finding. Its exact difference is ABOVE the GBP epsilon, so the
// ledger holds a payment; the double it converts to is exactly the epsilon, which the comparison
// reads as nothing. HOLDS_NOTHING is the verdict `zeroPaidIsProvenReversal` is written about, so the
// provenance gate then admits a reversal that clears `paidAt` and raises a chargeback.

/**
 * The admitted pair from the finding, and the arithmetic that makes it one.
 *
 * o3d-psrx r16 kept these as STRING TOKENS because the scale rule it had just added to the number arm
 * refused them, while the string arm still admitted them. r18 (Codex HIGH 1) removed that asymmetry:
 * eighteen decimals is not a figure ANY supported currency can state, so neither arm reads these now
 * and the pair can no longer be assembled out of a payload at all.
 *
 * THE GUARD IS NOT DELETED WITH THE ROUTE. `readDecimalAsNumber` is spent on every DERIVED amount —
 * `readLedgerDifferenceAsNumber`, and through it `qboLedgerAmountFrom` — and a subtraction is not an
 * input, so no input rule speaks for it. What changed is where the pair is put to it: at the guard's
 * own door rather than through a reader that now refuses the tokens one step earlier. Both facts are
 * asserted below, and the second is what stops the first being a claim about a dead code path.
 */
const ADMITTED_TOTAL_TOKEN = '0.005055810576648219'
const ADMITTED_BALANCE_TOKEN = '0.00005581057664821855'
const ADMITTED_TOTAL = Number(ADMITTED_TOTAL_TOKEN)
const ADMITTED_BALANCE = Number(ADMITTED_BALANCE_TOKEN)

test('[o3d-psrx r13] the derived-value guard still refuses the admitted pair, asked at its own door', () => {
  // The premise of the finding, asserted rather than assumed: the exact difference is a payment the
  // ledger holds — strictly ABOVE the GBP epsilon.
  const exact = toDecimal(String(ADMITTED_TOTAL)).minus(toDecimal(String(ADMITTED_BALANCE)))
  assert.equal(exact.toString(), '0.00500000000000000045')
  assert.ok(exact.gt(ledgerAmountEpsilon('GBP')),
    'the premise of the finding: this document holds a payment above the threshold')
  // While the double it converts to does not clear the threshold — this is the loss itself.
  assert.equal(exact.toNumber(), 0.005)
  assert.ok(toDecimal(exact.toNumber()).lte(ledgerAmountEpsilon('GBP')),
    'and the converted number does not, which is the whole defect')

  // THE GUARD. Nothing else in this test can produce these answers: both operands are below the GBP
  // magnitude bound, so the bound is not what refuses them, and the difference is finite, so
  // `Number.isFinite` is not either. Only the losslessness comparison is left.
  assert.ok(Math.abs(ADMITTED_TOTAL) < ledgerAmountMagnitudeBound('GBP')
    && Math.abs(ADMITTED_BALANCE) < ledgerAmountMagnitudeBound('GBP'),
    'PRECONDITION: both operands are inside the magnitude bound, so the bound cannot be what refuses')
  assert.equal(readLedgerDifferenceAsNumber(ADMITTED_TOTAL, ADMITTED_BALANCE, 'GBP'), null,
    'a lossy Decimal->number conversion of the derived amount must refuse, not round onto the threshold')
  assert.equal(readDecimalAsNumber(exact), null, 'and the conversion itself is where it refuses')
  // NULL IS NOT ZERO — zero is the reading that clears paidAt.
  assert.notEqual(readLedgerDifferenceAsNumber(ADMITTED_TOTAL, ADMITTED_BALANCE, 'GBP'), 0)
  // CONTROL: the guard refuses LOSS and not derivation. An ordinary pair still converts.
  assert.equal(readLedgerDifferenceAsNumber(100, 40, 'GBP'), 60)
})

test('[o3d-psrx r18] and the admitted pair can no longer be assembled from a payload, in either arm', () => {
  // o3d-psrx r18 (Codex HIGH 1). r16 refused these as JSON numbers and read them as strings; that
  // asymmetry is the finding. Eighteen decimals is not an amount ANY supported currency can hold, so
  // the answer is now the same whichever way the figure arrived — including in CLF, the finest
  // precision the repository supports, which is the strictest possible reading of "no currency".
  for (const [label, token] of [['total', ADMITTED_TOTAL_TOKEN], ['balance', ADMITTED_BALANCE_TOKEN]] as const) {
    for (const currency of ['GBP', 'CLF', null]) {
      assert.equal(parseLedgerAmount(token, currency), parseLedgerAmount(Number(token), currency),
        `${label} in ${currency ?? 'an unstated currency'}: a string and a number of the same value `
        + 'must classify identically')
      assert.equal(parseLedgerAmount(token, currency), null,
        `${label} in ${currency ?? 'an unstated currency'}: and that answer is REFUSED — eighteen `
        + 'decimals is finer than any minor unit this repository supports')
    }
  }
})

test('[o3d-psrx r13] THE ROUTE: the admitted pair WITHHOLDS instead of proving a full reversal', () => {
  const verdict = classifyQboLedgerEvidence(ledgerAmount(ADMITTED_TOTAL_TOKEN, ADMITTED_BALANCE_TOKEN, 'GBP'))
  // The load-bearing claim, and it is unchanged: this pair must not reach HOLDS_NOTHING, the one
  // verdict every admitting arm of the provenance gate is written about.
  assert.notEqual(verdict.kind, 'HOLDS_NOTHING',
    'a positive payment must never be classified as a ledger holding nothing')
  // r18: and `documentTotal` is now NULL rather than the figure, because the total is refused for its
  // scale one step before the derivation is attempted. The withholding got stricter, not looser.
  assert.deepEqual(verdict, { kind: 'UNPROVEN', paidAmount: null, documentTotal: null, currencyUnbound: false })
})

test('[o3d-psrx r13] CONTROL: ordinary amounts classify exactly as they always did', () => {
  // The guard must refuse a LOSSY conversion and nothing else. These are the readings the poller
  // makes every day, and none of them may move.
  const unchanged = [
    // A document the ledger has FULLY settled is deliberately UNPROVEN, not PARTIALLY_PAID: the
    // ledger and IMS agree about it, so there is nothing to report. See classifyQboLedgerEvidence.
    { total: 100, balance: 0, currency: 'GBP', expect: { kind: 'UNPROVEN' as const } },
    { total: 100, balance: 100, currency: 'GBP', expect: { kind: 'HOLDS_NOTHING' as const } },
    { total: 100, balance: 40, currency: 'GBP', expect: { kind: 'PARTIALLY_PAID' as const } },
    { total: 0, balance: 0, currency: 'GBP', expect: { kind: 'HOLDS_NOTHING' as const } },
    { total: 1234.56, balance: 1234.56, currency: 'USD', expect: { kind: 'HOLDS_NOTHING' as const } },
    { total: 1234.56, balance: 34.56, currency: 'USD', expect: { kind: 'PARTIALLY_PAID' as const } },
    { total: 100.1, balance: 0.1, currency: 'GBP', expect: { kind: 'PARTIALLY_PAID' as const } },
    { total: 9999999.99, balance: 0.01, currency: 'EUR', expect: { kind: 'PARTIALLY_PAID' as const } },
    { total: 12.345, balance: 12.344, currency: 'KWD', expect: { kind: 'PARTIALLY_PAID' as const } },
  ]
  for (const c of unchanged) {
    const amount = ledgerAmount(c.total, c.balance, c.currency)
    assert.notEqual(amount.paid, null,
      `${c.currency} ${c.total}/${c.balance}: an ordinary figure must still convert — a guard that `
      + 'refuses the everyday reading has switched the poller off rather than fixed it')
    // And the paid figure is the exact decimal difference, not a rounded one.
    assert.equal(
      toDecimal(amount.paid!).toString(),
      toDecimal(String(c.total)).minus(toDecimal(String(c.balance))).toString(),
      `${c.currency} ${c.total}/${c.balance}: the settled figure must be the exact difference`)
    // AND THE STRONGER FORM OF "IDENTICAL": the figure equals what the PRE-CHANGE conversion
    // produced. Hand-written expectations only say the verdict is what somebody wrote down; this
    // says the new reader returns the same number the bare `.toNumber()` did on every ordinary
    // reading, so the guard is a refusal of lossy conversions and not a change of arithmetic.
    assert.equal(amount.paid, toDecimal(String(c.total)).minus(toDecimal(String(c.balance))).toNumber(),
      `${c.currency} ${c.total}/${c.balance}: the guard must not change what a lossless conversion returns`)
    assert.equal(classifyQboLedgerEvidence(amount).kind, c.expect.kind,
      `${c.currency} ${c.total}/${c.balance}: the verdict must not move`)
  }
})

test('[o3d-psrx r13] a VOIDED document is still a stated zero, not a derivation', () => {
  // The one place a zero `paid` is legitimate is a document QuickBooks zeroed, and it is stated
  // rather than subtracted — so the new refusal must not be able to reach it.
  assert.deepEqual(classifyQboLedgerEvidence(ledgerAmount(0, 0, 'GBP')), { kind: 'HOLDS_NOTHING' })
})


// ---------------------------------------------------------------------------
// o3d-psrx r14 (Codex HIGH) — THE FULL QUICKBOOKS ROUTE, THROUGH AN ACTUAL `Response.json()`.
//
// r13's guard is applied to `TotalAmt - Balance` AFTER both figures have been decoded. Codex's point
// is that the decode itself is the lossy step: two QuickBooks figures one minor unit apart come back
// as ONE double, their exact difference is then a true zero, and every guard downstream — including
// r13's, which is asking a question about a Decimal that is already wrong — accepts it. The verdict is
// HOLDS_NOTHING, which is the one `zeroPaidIsProvenReversal` is written about.
//
// So these tests do not construct the numbers. They put QuickBooks' own wire text through `Response`,
// exactly as `qboQuery` does, and read the row that comes out. A fixture built from numeric literals
// would be rounded by the same rule and would prove nothing about the decode.
// ---------------------------------------------------------------------------

/** One row of a QBO query response, decoded from wire text the way the connector client decodes it. */
async function decodeQboRow(body: string): Promise<Parameters<typeof qboLedgerAmount>[0]> {
  const response = new Response(body, { headers: { 'content-type': 'application/json' } })
  const payload = await response.json() as { QueryResponse: { Invoice: Parameters<typeof qboLedgerAmount>[0][] } }
  return payload.QueryResponse.Invoice[0]
}

test('[o3d-psrx r14] a CLF document holding ONE minor unit is not read as holding NOTHING', async () => {
  // The finding's pair. TotalAmt 1649267441664 with Balance 1649267441663.9999 is a document with
  // 0.0001 CLF — one whole minor unit — settled on it.
  const row = await decodeQboRow(
    '{"QueryResponse":{"Invoice":[{"Id":"clf-1","TotalAmt":1649267441664,'
    + '"Balance":1649267441663.9999,"CurrencyRef":{"value":"CLF"}}]}}')

  // PRECONDITION 1: the ledger really does hold a payment. Read from the wire TEXT in exact decimal,
  // which is the only place the truth still exists after the decode.
  const trueSettled = toDecimal('1649267441664').minus(toDecimal('1649267441663.9999'))
  assert.equal(trueSettled.toString(), '0.0001')
  assert.ok(trueSettled.gt(ledgerAmountEpsilon('CLF')),
    'precondition: one CLF minor unit is above the CLF threshold, so this document HOLDS a payment')

  // PRECONDITION 2: and `Response.json()` destroyed exactly that. Without this the test could pass
  // against a decode that never lost anything, and would be proving nothing at all.
  assert.equal(row.TotalAmt, row.Balance,
    'precondition: the decode collapsed the two figures, so their difference is now an exact zero')

  const evidence = classifyQboLedgerEvidence(qboLedgerAmount(row))
  assert.notEqual(evidence.kind, 'HOLDS_NOTHING',
    'THE DEFECT: a document with a minor unit settled on it must never reach the verdict that clears '
    + 'paidAt, re-arms Mark Paid over a supplier payment, and raises a sales chargeback')
  assert.equal(evidence.kind, 'UNPROVEN',
    'and the answer is that IMS could not read these figures — which withholds')
})

test('[o3d-psrx r14] a 3-decimal document holding ONE minor unit is not read as holding NOTHING', async () => {
  const row = await decodeQboRow(
    '{"QueryResponse":{"Invoice":[{"Id":"kwd-1","TotalAmt":8796093022208.002,'
    + '"Balance":8796093022208.001,"CurrencyRef":{"value":"KWD"}}]}}')

  const trueSettled = toDecimal('8796093022208.002').minus(toDecimal('8796093022208.001'))
  assert.equal(trueSettled.toString(), '0.001')
  assert.ok(trueSettled.gt(ledgerAmountEpsilon('KWD')),
    'precondition: one fils is above the KWD threshold, so this document HOLDS a payment')
  assert.equal(row.TotalAmt, row.Balance,
    'precondition: the decode collapsed one fils out of existence')

  const evidence = classifyQboLedgerEvidence(qboLedgerAmount(row))
  assert.notEqual(evidence.kind, 'HOLDS_NOTHING',
    'the Gulf-dinar equivalent of the finding, and it must withhold for the same reason')
  assert.equal(evidence.kind, 'UNPROVEN')
})

test('[o3d-psrx r14] an ordinary decoded QBO document still classifies exactly as before', async () => {
  // THE CONTROL. Everything above would also pass if the reader had simply stopped reading anything,
  // which would withhold every reversal in the system and be a far worse defect than the one fixed.
  const row = await decodeQboRow(
    '{"QueryResponse":{"Invoice":[{"Id":"ord-1","TotalAmt":1200.50,'
    + '"Balance":200.50,"CurrencyRef":{"value":"GBP"}}]}}')
  assert.deepEqual(classifyQboLedgerEvidence(qboLedgerAmount(row)), {
    kind: 'PARTIALLY_PAID',
    paidAmount: 1000,
    documentTotal: 1200.5,
    outstandingAmount: 200.5,
    currency: 'GBP',
  })

  // And a genuinely settled-to-nothing document still says so — the verdict this whole module exists
  // to reach when it is true.
  const zeroed = await decodeQboRow(
    '{"QueryResponse":{"Invoice":[{"Id":"ord-2","TotalAmt":1200.50,'
    + '"Balance":1200.50,"CurrencyRef":{"value":"GBP"}}]}}')
  assert.deepEqual(classifyQboLedgerEvidence(qboLedgerAmount(zeroed)), { kind: 'HOLDS_NOTHING' })
})

// ---------------------------------------------------------------------------
// o3d-psrx r18 (Codex HIGH 1) — ONE RULE, TWO READERS, AND NOW ONE ANSWER.
//
// THE DEFECT. r16 put the currency-scale refusal on `parseLedgerAmount`'s NUMBER arm only. The string
// arm kept its grammar test and its round trip, and r15's argument for the asymmetry — a string
// carries its own evidence, so it needs no rule about values of its SIZE — is an argument about
// MAGNITUDE that does not transfer to SCALE. The round trip establishes that the number IS the text
// it came from; it says nothing about whether that text is a figure the currency can hold. So GBP
// `0.005` was UNVERIFIABLE as a JSON number and money as a JSON string, and both connectors spent the
// difference: Xero on `AmountPaid` in `partitionPaymentReversals`, QuickBooks on `Balance` and
// `TotalAmt` in `qboLedgerAmount`.
//
// ROUTE: the two connectors' own production readers, not `parseLedgerAmount` on its own — the whole
// point of the finding is what the difference is spent on.
//
// MUTATION: take the scale check off the string arm of `parseLedgerAmount` (r18's edit) and the GBP
// rows below stop agreeing — Xero reads `'0.005'` into `partPaid` while `0.005` stays `unverifiable`,
// and QuickBooks reads a paid amount from the string where the number gives none.
// ---------------------------------------------------------------------------

const authorised = (amountPaid: unknown, currency: string): XeroInvoice => ({
  InvoiceID: 'inv_paired',
  Status: 'AUTHORISED',
  Type: 'ACCREC',
  CurrencyCode: currency,
  AmountPaid: amountPaid,
} as XeroInvoice)

/** Which of Xero's four buckets this reading landed in. */
function xeroBucket(amountPaid: unknown, currency: string): string {
  const reading = partitionPaymentReversals([authorised(amountPaid, currency)], 'ACCREC')
  if (reading.zeroPaid.length > 0) return 'zeroPaid'
  if (reading.partPaid.length > 0) return 'partPaid'
  if (reading.unverifiable.length > 0) return 'unverifiable'
  return 'none'
}

test('[o3d-psrx r18] a string and a number of the same value classify identically, through BOTH connectors', () => {
  // Each row is ONE value in ONE currency, read twice — once as the JSON text a ledger may serialise
  // and once as the double `Response.json()` produces. The two readings must agree, and what they
  // agree ON is decided by the currency's minor unit rather than by which form arrived.
  const rows: Array<{
    label: string
    currency: string
    /** The figure under test, as text. Xero spends it as AmountPaid, QuickBooks as the settled part. */
    text: string
    xero: string
    qbo: string
  }> = [
    // THE FINDING'S OWN VALUE: three decimals in a two-decimal currency. Refused in both arms since
    // r18; before it, refused as a number and READ as a string.
    { label: 'a three-decimal figure in a two-decimal currency', currency: 'GBP', text: '0.005', xero: 'unverifiable', qbo: 'UNPROVEN' },
    // THE CONTROL THAT MAKES THE REFUSAL ABOUT THE CURRENCY AND NOT ABOUT THE DIGITS: the identical
    // text in a three-decimal currency is money, in both arms.
    { label: 'the same text in a three-decimal currency', currency: 'KWD', text: '0.005', xero: 'partPaid', qbo: 'PARTIALLY_PAID' },
    // A four-decimal figure: refused in KWD, read in CLF. Same digits, opposite answers, decided by
    // the minor-unit table alone.
    { label: 'four decimals in a three-decimal currency', currency: 'KWD', text: '0.0005', xero: 'unverifiable', qbo: 'UNPROVEN' },
    { label: 'four decimals in a four-decimal currency', currency: 'CLF', text: '0.0005', xero: 'partPaid', qbo: 'PARTIALLY_PAID' },
    // AND THE ORDINARY READINGS, which are the ones the pollers make every day and none of which may
    // move: a stated zero, and an ordinary part payment.
    { label: 'a stated zero', currency: 'GBP', text: '0', xero: 'zeroPaid', qbo: 'HOLDS_NOTHING' },
    { label: 'an ordinary part payment', currency: 'GBP', text: '12.34', xero: 'partPaid', qbo: 'PARTIALLY_PAID' },
  ]

  for (const row of rows) {
    const value = Number(row.text)
    // XERO. `partitionPaymentReversals` reads `AmountPaid` and buckets the invoice; `zeroPaid` is the
    // only bucket the provenance gate can turn into a cleared `paidAt`.
    assert.equal(xeroBucket(row.text, row.currency), xeroBucket(value, row.currency),
      `${row.label} (${row.currency} ${row.text}): Xero must bucket the string and the number alike`)
    assert.equal(xeroBucket(row.text, row.currency), row.xero,
      `${row.label} (${row.currency} ${row.text}): and the bucket is ${row.xero}`)

    // QUICKBOOKS. `qboLedgerAmount` reads `TotalAmt` and `Balance` and derives the settled figure; the
    // amount under test is the settled part of a document totalling 100.
    const balanceText = toDecimal(100).minus(toDecimal(row.text)).toString()
    const asText = classifyQboLedgerEvidence(ledgerAmount('100', balanceText, row.currency))
    const asNumber = classifyQboLedgerEvidence(ledgerAmount(100, Number(balanceText), row.currency))
    assert.deepEqual(asText, asNumber,
      `${row.label} (${row.currency} ${row.text}): QuickBooks must classify the string and the number alike`)
    assert.equal(asText.kind, row.qbo,
      `${row.label} (${row.currency} ${row.text}): and the verdict is ${row.qbo}`)
  }
})
