import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  registrationBindsToPaidState,
  zeroPaidIsProvenReversal,
  type PaidStateBinding,
  type RegisteredPaymentRow,
} from '@/lib/connectors/xero/invoice-delta'
import { payloadRegisteredAmount } from '@/lib/domain/accounting/invoice-payment-enqueue'
import { coversDocumentTotal, PAID_COVERAGE_EPSILON } from '@/lib/domain/accounting/paid-coverage'
import { currencyMinorUnits, toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-psrx r6 (Codex HIGH 2) — WHAT THE SURVIVING MARKER BUYS, AND WHAT A PART-COVERED ORDER READS AS.
 *
 * `addPayment` now clears `SalesOrder.unregisteredPaidAt` only when the non-refund receipts on the
 * order COVER its total (r6), where r5 cleared it on any non-refund receipt at all. The write-site
 * halves of that rule are proved in tests/sales-add-payment-clears-paid-provenance.test.ts. This file
 * is the other end: what the column being kept — or destroyed by a penny — actually decides.
 *
 * ONE THING THE MARKER DECIDES is the OTHER half of `registrationBindsToPaidState`: with the marker
 * gone, `unregisteredPaidAt == null` is "this flag was never off-ledger", and EVERY registration the
 * order has ever carried — including one from a paid episode that was reversed — is handed back to
 * the CURRENT paid flag. That is r4's Codex HIGH exactly, re-created by r5's over-wide clearing, and a
 * penny of receipt was enough to do it. The first two tests below are that.
 *
 * AND THE OTHER THING IT DECIDES IS THE ONE r6 SAID IT DID NOT (r7, Codex HIGH 1).
 *
 * Round 6's header claimed, in this spot, that "the marker does NOT stand between a GBP 1
 * registration going missing and the ledger's zero being read", and filed that gap as somebody else's
 * residual. It was wrong, and the sentence it was defending is what made it wrong: the marker was
 * consulted only when `posted.length === 0`, so the part-covered order's own registration posting is
 * precisely what SILENCED it. Retire that GBP 1 registration and the classifier read GONE over a
 * GBP 100 order held as paid off-ledger — a full chargeback credit note raised on the strength of a
 * penny's worth of evidence. The reader is now coverage-aware: while the marker stands and the bound
 * registrations settle LESS than the order total, their removal is `PART_COVERED_OFF_LEDGER` and
 * withholds. The marker itself stays boolean; only this one comparison counts.
 *
 * THE STEADY STATE OF AN ORDER THAT IS PART-COVERED FOR EVER, enumerated so nobody has to infer it:
 *
 *   receipt recorded, not yet registered   RECEIPT_NOT_REGISTERED  — WITHHELD. IMS's own silence.
 *   its registration in flight             REGISTRATION_UNDECIDED  — WITHHELD.
 *   its registration posted and bound,     the LEDGER decides — but only about the part it covers.
 *   covering LESS than the total           Its absence is PART_COVERED_OFF_LEDGER — WITHHELD (r7);
 *                                          its presence is STILL_HELD, which withholds anyway.
 *   its registration posted and bound,     the LEDGER decides outright. GONE is a real reversal and
 *   covering the WHOLE total               is admitted, exactly as it is for an order with no marker.
 *   nothing posted is left to speak        PAID_WITHOUT_LEDGER_RECEIPT — WITHHELD, which is exactly
 *                                          what the remaining uncovered balance is: a paid flag with
 *                                          nothing in any ledger behind it.
 *
 * So the order is neither silently registered in full nor permanently withheld: the withholding is
 * discharged by the receipt that completes the cover, which is a write to the ORDER and not a
 * property of any poll — `addPayment` clears the marker at that moment and this guard stops running.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))

/** This paid episode began here — the order was marked paid by hand, off-ledger, for GBP 100. */
const EPISODE_BEGAN = new Date('2026-08-20T10:00:00.000Z')
/** …and this registration completed an hour BEFORE it: it belongs to a paid state that was reversed. */
const STALE_COMPLETION = new Date('2026-08-20T09:00:00.000Z')

const staleRegistration: RegisteredPaymentRow = {
  id: 'log_stale',
  status: 'SYNCED',
  externalTransactionId: 'PAY-OLD',
  syncedAt: STALE_COMPLETION,
  // Database-minted and equal, so `databaseStampedCompletion` vouches for it: this row is not
  // undecidable, it is decidably OLD. That is what makes the episode test the only thing left.
  syncedAtDatabaseClock: STALE_COMPLETION,
  // Against the document the order still points at. Only the EPISODE separates it from this flag.
  registeredAgainstInvoiceId: 'inv_1',
}

const withMarker: PaidStateBinding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: EPISODE_BEGAN }
const markerErased: PaidStateBinding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: null }

test('[o3d-psrx r6] the marker is the ONLY thing holding a previous episode\'s registration off this flag', () => {
  assert.equal(
    registrationBindsToPaidState(staleRegistration, STALE_COMPLETION, withMarker),
    false,
    'a registration that completed before this paid episode began cannot speak for it',
  )
  assert.equal(
    registrationBindsToPaidState(staleRegistration, STALE_COMPLETION, markerErased),
    true,
    'THE FINDING: with the marker gone the same row binds — nothing else in the row or the state '
    + 'distinguishes it, so a penny of receipt that clears the marker hands it back',
  )
})

test('[o3d-psrx r6] and that difference is a CHARGEBACK, not a change of wording', () => {
  // The ledger has been read in full and holds nothing on this document. Both arms below see the
  // identical evidence; they differ only in whether the off-ledger marker survived a partial receipt.
  const listedNothing = new Set<string>()

  const kept = classifyRegisteredPaymentAgainstListing(
    listedNothing, [staleRegistration], READ_AT, [], true, withMarker,
  )
  assert.equal(kept.verdict, 'PAID_WITHOUT_LEDGER_RECEIPT')
  assert.equal(zeroPaidIsProvenReversal(kept), false,
    'the flag was entered off-ledger and the stale row says nothing about it — paidAt is LEFT SET')

  const erased = classifyRegisteredPaymentAgainstListing(
    listedNothing, [staleRegistration], READ_AT, [], false, markerErased,
  )
  assert.equal(erased.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(erased), true,
    'THE COST: the reversed episode\'s payment is read as THIS flag\'s payment, found missing, and a '
    + 'chargeback credit note is raised against a sale nobody reversed')
})

test('[o3d-psrx r6] the part-covered order\'s OWN receipt is not withheld by the surviving marker', () => {
  // The marker is asked only when nothing posted is left to speak. A receipt whose registration
  // posted AFTER the episode began binds normally, so keeping the marker does not park the order:
  // the ledger's own answer is taken, exactly as it is for a fully covered one.
  const ownRegistration: RegisteredPaymentRow = {
    id: 'log_own',
    status: 'SYNCED',
    externalTransactionId: 'PAY-NEW',
    syncedAt: new Date('2026-08-20T11:00:00.000Z'),
    syncedAtDatabaseClock: new Date('2026-08-20T11:00:00.000Z'),
    registeredAgainstInvoiceId: 'inv_1',
  }
  const stillHeld = classifyRegisteredPaymentAgainstListing(
    new Set(['pay-new']), [ownRegistration], READ_AT, [], true, withMarker,
  )
  assert.equal(stillHeld.verdict, 'STILL_HELD',
    'the marker is standing and the ledger still decided — it is not a permanent withholding')

  // And before that registration exists, the receipt itself is what withholds — IMS\'s own silence,
  // named by payment id so an operator can see which receipt the poller is waiting on.
  const notYet = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [], READ_AT, ['pay-new'], true, withMarker,
  )
  assert.equal(notYet.verdict, 'RECEIPT_NOT_REGISTERED')
  assert.equal(zeroPaidIsProvenReversal(notYet), false)
})

// ---------------------------------------------------------------------------
// o3d-psrx r7 (Codex HIGH 1) — THE READER COUNTS.
//
// ROUTE. Every test below calls `classifyRegisteredPaymentAgainstListing` — the function
// `readPaidProvenanceVerdicts` calls for BOTH pollers — and reads the answer through
// `zeroPaidIsProvenReversal`, which is what decides whether `paidAt` is cleared and
// `raiseChargebackForReversedOrder` is called. Nothing here re-implements a decision. The wiring from
// the database columns into these arguments is proved separately, against a real PostgreSQL, in
// tests/concurrency/paid-provenance-reversal.concurrent.test.ts.
//
// THE ORDER UNDER TEST throughout: GBP 100, marked paid by hand with no ledger receipt behind it, and
// then given a GBP 1 receipt whose registration posted. `addPayment` keeps the marker (r6) because
// GBP 1 does not cover GBP 100 — and it is the state r6 left the reader unable to read.
// ---------------------------------------------------------------------------

/** The GBP 1 receipt's registration: bound to THIS episode, posted before the read, and tiny. */
const pennyRegistration: RegisteredPaymentRow = {
  id: 'log_penny',
  status: 'SYNCED',
  externalTransactionId: 'PAY-PENNY',
  syncedAt: new Date('2026-08-20T11:00:00.000Z'),
  syncedAtDatabaseClock: new Date('2026-08-20T11:00:00.000Z'),
  registeredAgainstInvoiceId: 'inv_1',
  // What the enqueue's payload states it sent, via `payloadRegisteredAmount`.
  registeredAmount: 1,
}

/** The same registration, for the whole order. Every other field is identical. */
const fullRegistration: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: 100 }

/** And the same registration from a payload that will not say — legacy, or retention-compacted. */
const silentRegistration: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: null }

const ORDER_TOTAL = 100

test('[o3d-psrx r7] removing a PART-covering registration does not reverse the whole off-ledger order', () => {
  // The ledger has been read in full and lists nothing: the GBP 1 payment IMS registered is gone.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [pennyRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER',
    'THE FINDING: r6 returned GONE here, because the marker was consulted only while nothing had '
    + 'posted — and the penny posting is exactly what silenced it')
  assert.equal(zeroPaidIsProvenReversal(verdict), false,
    'so paidAt is LEFT SET and no chargeback credit note is raised over the GBP 99 that was never in '
    + 'any ledger to be taken away')
  // The numbers travel with the verdict, because the operator's question is "part of what?".
  assert.deepEqual(
    verdict.verdict === 'PART_COVERED_OFF_LEDGER'
      ? { registeredTotal: verdict.registeredTotal?.toString() ?? null, documentTotal: verdict.documentTotal.toString() }
      : null,
    { registeredTotal: '1', documentTotal: '100' },
    'and they travel as the DECIMALS the guard compared (r18), so the pair the finding is about is '
    + 'reportable rather than printing the same double twice',
  )
})

test('[o3d-psrx r17] ONE MINOR UNIT SHORT IS NOT COVERAGE, in the finest currency the repository supports', () => {
  // o3d-psrx r17 — THE SAME SHAPE AS THE XERO EPSILON, ONE MODULE OVER. `PAID_COVERAGE_EPSILON` was
  // the literal 0.0001, described in its own file as "a hundredth of a penny — far below any
  // currency's minor unit, so it cannot absorb a real shortfall". `currencyMinorUnits` puts CLF and
  // UYW at FOUR decimals, whose minor unit is 0.0001 EXACTLY, so in those currencies the band was one
  // whole minor unit wide and did absorb a real shortfall.
  //
  // THE ROUTE is `classifyRegisteredPaymentAgainstListing`, the production reader, not
  // `coversDocumentTotal` on its own: the guard's whole purpose is the verdict it dominates, and the
  // verdict is what `zeroPaidIsProvenReversal` spends. Registered 99.9999 against a 100 total is a
  // shortfall of one CLF minor unit — a real part-coverage — and under the old literal the reader
  // called it covered and returned GONE, an ADMITTED reversal of the whole document.
  const oneUnitShort: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: 99.9999 }
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [oneUnitShort], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER',
    'a whole minor unit short of the total is a PART, and its removal is not a reversal of the whole')
  assert.equal(zeroPaidIsProvenReversal(verdict), false,
    'so paidAt is LEFT SET and no chargeback is raised over the remainder')

  // THE CONTROL, and the reason the band exists at all: float assembly noise from summing receipt
  // rows must still read as covered, or every fully-settled order would withhold for ever.
  const noisy: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: ORDER_TOTAL - 1e-9 }
  assert.equal(
    classifyRegisteredPaymentAgainstListing(
      new Set<string>(), [noisy], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
    ).verdict,
    'GONE',
    'a shortfall of a billionth is assembly noise, not a part payment',
  )

  // AND THE RULE THE BAND IS NOW DERIVED FROM, stated rather than sampled: strictly below one minor
  // unit of every supported currency, so no real shortfall fits inside it.
  for (const currency of ['GBP', 'JPY', 'KWD', 'CLF', 'UYW']) {
    const oneMinorUnit = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(currency)))
    assert.ok(toDecimal(PAID_COVERAGE_EPSILON).lt(oneMinorUnit),
      `${currency}: a coverage band at or above one minor unit absorbs a real shortfall `
      + `(band ${PAID_COVERAGE_EPSILON}, minor unit ${oneMinorUnit.toString()})`)
  }
  assert.ok(PAID_COVERAGE_EPSILON.gt(0), 'and a zero band would make assembly dust a shortfall')
})

test('[o3d-psrx r7] a registration that COVERS the order still reverses when the ledger says so', () => {
  // THE CONTROL, and the whole reason the guard counts instead of simply asking whether the marker
  // stands. "Withhold whenever a marker is present" would pass the test above and disable genuine
  // chargeback detection for every order that carries one.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [fullRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(verdict), true,
    'a registration that settled the whole order and is now absent from a list IMS could read in '
    + 'full IS a removal of the whole order')
})

test('[o3d-psrx r7] coverage a payload will not state is not coverage', () => {
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [silentRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER',
    'a compacted or legacy payload cannot establish that the registration covered the order, and '
    + '"cannot establish" is not "did"')
  assert.equal(
    verdict.verdict === 'PART_COVERED_OFF_LEDGER' ? verdict.registeredTotal : 'unread',
    null,
    'and it is reported as unknown rather than as zero — the two are different facts',
  )
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
})

test('[o3d-psrx r7] one unreadable amount makes the WHOLE sum unreadable, not merely smaller', () => {
  // Two registrations that between them plainly cover the order — if the silent one is assumed to be
  // worth what the visible one is. It is not: a sum with a hole in it is a number that means nothing,
  // and which direction the hole pushes the comparison depends entirely on which row it is in.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(),
    [{ ...fullRegistration, id: 'log_a', externalTransactionId: 'PAY-A' }, { ...silentRegistration, id: 'log_b', externalTransactionId: 'PAY-B' }],
    READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER')
  assert.equal(verdict.verdict === 'PART_COVERED_OFF_LEDGER' ? verdict.registeredTotal : 'unread', null)
})

test('[o3d-psrx r7] the guard is gated on the MARKER, not on the amounts alone', () => {
  // An order whose paid flag came from the ledger's own forward pass carries no marker. Its GBP 1
  // registration going missing is a removal of everything IMS ever registered, and the part-payment-
  // versus-removal question there is the amount reading's (`partitionPaymentReversals`), not this
  // one's. Passing `paidWithoutLedgerReceipt: false` must therefore change nothing about round 6.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [pennyRegistration], READ_AT, [], false, markerErased, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(verdict), true)
})

test('[o3d-psrx r7] a caller that supplies no total reaches round 6\'s answer exactly', () => {
  // `documentTotal` null is "not asking": a bill, which has no marker and cannot reach this arm, and
  // every test and caller written before this parameter existed. Behaviour must be unchanged, or the
  // parameter is a silent semantic change rather than an addition.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [pennyRegistration], READ_AT, [], true, withMarker,
  )
  assert.equal(verdict.verdict, 'GONE')
})

test('[o3d-psrx r7] a ledger that still LISTS the part payment says so, rather than falling to the guard', () => {
  // Both withhold, so this is about what an operator is told: STILL_HELD names the payment the ledger
  // is holding, which is the thing to go and look at. The guard's sentence would send them to the
  // order instead.
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set(['pay-penny']), [pennyRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(verdict.verdict, 'STILL_HELD')
  assert.equal(zeroPaidIsProvenReversal(verdict), false)
})

test('[o3d-psrx r7] the QuickBooks route — a withheld listing is not a licence to reverse the remainder', () => {
  // QuickBooks' reversal read enumerates no payments, so `ledgerListedPaymentIds` is ALWAYS null and
  // a document with a posted registration lands on LEDGER_DID_NOT_LIST_PAYMENTS — which
  // `zeroPaidIsProvenReversal` ADMITS. The GBP 1-on-GBP 100 defect therefore existed on that connector
  // too, by a different route, and the guard has to dominate that answer as well as GONE.
  const partCovered = classifyRegisteredPaymentAgainstListing(
    null, [pennyRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(partCovered.verdict, 'PART_COVERED_OFF_LEDGER')
  assert.equal(zeroPaidIsProvenReversal(partCovered), false)

  // And the control on the same route: a full-cover registration over a ledger stating a zero total
  // is still a reversal, exactly as it was.
  const fullyCovered = classifyRegisteredPaymentAgainstListing(
    null, [fullRegistration], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL),
  )
  assert.equal(fullyCovered.verdict, 'LEDGER_DID_NOT_LIST_PAYMENTS')
  assert.equal(zeroPaidIsProvenReversal(fullyCovered), true)
})

test('[o3d-psrx r7] the reader\'s comparison IS the writer\'s, epsilon included', () => {
  // The guard is only sound while it asks the question `addPayment` answered when it decided to keep
  // the marker. Both call `coversDocumentTotal`; this pins the band they share, in both directions,
  // at the boundary — the only place a drift between two spellings would ever show.
  const justUnder: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: ORDER_TOTAL - 0.01 }
  const withinEpsilon: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: ORDER_TOTAL - 0.00005 }
  // r18: the arguments are `Decimal`s, and the conversion is WRITTEN DOWN at the call site rather
  // than performed inside the rule — which is the property that stopped a stored four-decimal figure
  // reaching this comparison as a collapsed double.
  assert.equal(coversDocumentTotal(toDecimal(ORDER_TOTAL - 0.01), toDecimal(ORDER_TOTAL)), false,
    'PRECONDITION: a penny short is short')
  assert.equal(coversDocumentTotal(toDecimal(ORDER_TOTAL - 0.00005), toDecimal(ORDER_TOTAL)), true,
    'PRECONDITION: assembly dust is not')

  assert.equal(
    classifyRegisteredPaymentAgainstListing(new Set<string>(), [justUnder], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL)).verdict,
    'PART_COVERED_OFF_LEDGER',
  )
  assert.equal(
    classifyRegisteredPaymentAgainstListing(new Set<string>(), [withinEpsilon], READ_AT, [], true, withMarker, toDecimal(ORDER_TOTAL)).verdict,
    'GONE',
  )
})

// ---------------------------------------------------------------------------
// o3d-psrx r7 — AND WHERE THE AMOUNT COMES FROM.
//
// `payloadRegisteredAmount` is the single reading of the enqueue's own payload. It is the reason a
// registration raised in another currency, or by a build that did not record the amount, answers
// "will not say" rather than a number that would be added to a total stated in a different unit.
// ---------------------------------------------------------------------------

test('[o3d-psrx r7] a registration in another currency covers none of this order', () => {
  assert.equal(payloadRegisteredAmount({ amount: 100, currency: 'GBP' }, 'GBP'), 100)
  assert.equal(payloadRegisteredAmount({ amount: 100, currency: 'EUR' }, 'GBP'), null,
    'EUR 100 is not GBP 100, and adding them would put an unstated FX rate inside a reversal decision')
  assert.equal(payloadRegisteredAmount({ amount: 100 }, 'GBP'), null,
    'a payload that does not state its currency is not presumed to be in the order\'s')
  assert.equal(payloadRegisteredAmount({ currency: 'GBP' }, 'GBP'), null)
  assert.equal(payloadRegisteredAmount({}, 'GBP'), null, 'a retention-compacted payload says nothing')
  assert.equal(payloadRegisteredAmount(null, 'GBP'), null)
  assert.equal(payloadRegisteredAmount({ amount: '100', currency: 'GBP' }, 'GBP'), null,
    'a string is not a number here — the enqueue writes a number, and anything else is a row this '
    + 'reader cannot vouch for')
})

// ---------------------------------------------------------------------------
// o3d-psrx r18 (Codex HIGH 2) — THE RULE WAS EXACT AND ITS OPERANDS WERE NOT.
//
// `PAID_COVERAGE_EPSILON` was derived from the minor unit in r17 and is exact. What reached the
// comparison was not: every figure it weighs comes out of a `Decimal(18, 4)` column, and all three
// call sites wrote `Number(...)` on the way in. A double cannot hold four decimals across that
// column's range — at 549755813888 (2^39) neighbouring doubles are about 0.00012 apart — so the two
// stored, valid, ONE-MINOR-UNIT-APART values below are the same number, and a registration a whole
// unit short of the order read as exact coverage. The reader then returned GONE, which
// `zeroPaidIsProvenReversal` admits: a chargeback credit note over money nobody took back.
//
// ROUTE: `coversDocumentTotal` for the rule itself, and `classifyRegisteredPaymentAgainstListing`
// for the verdict it dominates. The writer half of the same rule is driven through the real
// `addPayment` in tests/sales-add-payment-clears-paid-provenance.test.ts.
// ---------------------------------------------------------------------------

/** The pair from the finding: two valid four-decimal amounts, one minor unit apart. */
const FOUR_DP_COVERED = '549755813888.0002'
const FOUR_DP_TOTAL = '549755813888.0003'

test('[o3d-psrx r18] a four-decimal registration ONE MINOR UNIT short is not coverage', () => {
  // THE PRECONDITION, and it is what makes this a finding rather than a preference: as `number`s
  // these two stored values are indistinguishable, so no comparison taken on them could ever have
  // separated the covered order from the one that is a whole minor unit short.
  assert.equal(Number(FOUR_DP_COVERED), Number(FOUR_DP_TOTAL),
    'PRECONDITION: the two stored values collapse onto one double — the r18 finding itself')
  assert.ok(toDecimal(FOUR_DP_COVERED).lt(toDecimal(FOUR_DP_TOTAL)),
    'PRECONDITION: while as decimals they are a whole minor unit apart')
  // And the shortfall is a REAL one — a whole minor unit of a four-decimal currency, an order of
  // magnitude above the band, so the epsilon is not what is being measured here.
  assert.ok(toDecimal(FOUR_DP_TOTAL).sub(toDecimal(FOUR_DP_COVERED)).gt(PAID_COVERAGE_EPSILON),
    'PRECONDITION: and the gap is wider than the band, so this is a shortfall and not dust')

  assert.equal(coversDocumentTotal(toDecimal(FOUR_DP_COVERED), toDecimal(FOUR_DP_TOTAL)), false,
    'THE FINDING: one whole minor unit short is not coverage, at any magnitude the column can hold')

  // AND THE VERDICT IT DOMINATES, through the production reader rather than the rule alone: the
  // registration's absence from a ledger listing IMS read in full must be PART coverage, not a
  // reversal of the whole document.
  const oneUnitShort: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: Number(FOUR_DP_COVERED) }
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [oneUnitShort], READ_AT, [], true, withMarker, toDecimal(FOUR_DP_TOTAL),
  )
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER',
    'and the reader withholds instead of returning GONE')
  assert.equal(zeroPaidIsProvenReversal(verdict), false,
    'so paidAt is LEFT SET and no chargeback credit note is raised over the remainder')
})

test('[o3d-psrx r18] CONTROL: ordinary coverage at the same magnitude still settles', () => {
  // THE CONTROL, and it is what stops the fix being "never cover anything". Exact coverage of the
  // same four-decimal total must still read as coverage and must still reverse — a rule that refused
  // here would disable genuine chargeback detection for every large order.
  assert.equal(coversDocumentTotal(toDecimal(FOUR_DP_TOTAL), toDecimal(FOUR_DP_TOTAL)), true,
    'the exact total covers the total')
  const covering: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: 100 }
  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [covering], READ_AT, [], true, withMarker, toDecimal('100.0000'),
  )
  assert.equal(verdict.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(verdict), true,
    'a registration that settled the whole order and is now absent IS a removal of the whole order')

  // AND THE ONE PLACE THE READER STILL CANNOT REACH EXACT COVERAGE AT THIS MAGNITUDE, SAID OUT LOUD
  // RATHER THAN LEFT AS A SURPRISE (o3d-1xq8). `registeredAmount` is not a stored decimal: the enqueue
  // writes `Number(receipt.amount)` into the registration's JSON payload, and at 2^39 no double
  // answers to `549755813888.0003` — the nearest one is named `...0002`. So a registration that really
  // did settle this order reads as one minor unit short and the reader WITHHOLDS. That is the
  // fail-closed direction and it is the residue of the last lossy hop in the chain; closing it is
  // o3d-1xq8, and this assertion is what will fail when it is closed.
  const coveringAtScale: RegisteredPaymentRow = { ...pennyRegistration, registeredAmount: Number(FOUR_DP_TOTAL) }
  assert.equal(toDecimal(Number(FOUR_DP_TOTAL)).toString(), FOUR_DP_COVERED,
    'PRECONDITION: the payload double cannot name the order total at this magnitude')
  assert.equal(
    classifyRegisteredPaymentAgainstListing(
      new Set<string>(), [coveringAtScale], READ_AT, [], true, withMarker, toDecimal(FOUR_DP_TOTAL),
    ).verdict,
    'PART_COVERED_OFF_LEDGER',
    'so the reader withholds rather than admitting a reversal it cannot establish — o3d-1xq8',
  )

  // And the everyday figures, which are the ones this rule answers on every poll.
  assert.equal(coversDocumentTotal(toDecimal('100.00'), toDecimal('100.0000')), true)
  assert.equal(coversDocumentTotal(toDecimal('100.01'), toDecimal('100.0000')), true)
  assert.equal(coversDocumentTotal(toDecimal('99.99'), toDecimal('100.0000')), false)
})

test('[o3d-psrx r18] and the SUM of the registrations is exact, not just the comparison', () => {
  // The other half of "computes in Number": `sumRegisteredAmounts` added the registrations with `+`.
  // Each term is still a payload double (o3d-1xq8), but adding two of them can land a whole minor unit
  // away from their true sum — and that sum is one side of the coverage comparison.
  //
  // TWO registrations that between them settle the order EXACTLY. Their float sum does not.
  const halfA: RegisteredPaymentRow = { ...pennyRegistration, id: 'log_a', externalTransactionId: 'PAY-A', registeredAmount: Number('274877906944.0001') }
  const halfB: RegisteredPaymentRow = { ...pennyRegistration, id: 'log_b', externalTransactionId: 'PAY-B', registeredAmount: Number('274877906944.0002') }
  // PRECONDITIONS. Each term is exactly the figure it names, and their float sum is a minor unit short
  // of their exact sum — so the two summations really do disagree here.
  assert.equal(toDecimal(halfA.registeredAmount!).toString(), '274877906944.0001')
  assert.equal(toDecimal(halfB.registeredAmount!).toString(), '274877906944.0002')
  assert.equal(toDecimal(halfA.registeredAmount!).add(halfB.registeredAmount!).toString(), FOUR_DP_TOTAL)
  assert.equal(toDecimal(halfA.registeredAmount! + halfB.registeredAmount!).toString(), FOUR_DP_COVERED,
    'PRECONDITION: added as doubles they fall one whole minor unit short')

  const verdict = classifyRegisteredPaymentAgainstListing(
    new Set<string>(), [halfA, halfB], READ_AT, [], true, withMarker, toDecimal(FOUR_DP_TOTAL),
  )
  assert.equal(verdict.verdict, 'GONE',
    'registrations that between them settle the order EXACTLY cover it — a float sum said they were '
    + 'a minor unit short and parked a genuine reversal for ever')
  assert.equal(zeroPaidIsProvenReversal(verdict), true)

  // CONTROL, in the other direction: two registrations that genuinely fall a minor unit short still
  // do, so this is not "summing in Decimal admits everything".
  const shortB: RegisteredPaymentRow = { ...halfB, registeredAmount: Number('274877906944.0001') }
  assert.equal(
    classifyRegisteredPaymentAgainstListing(
      new Set<string>(), [halfA, shortB], READ_AT, [], true, withMarker, toDecimal(FOUR_DP_TOTAL),
    ).verdict,
    'PART_COVERED_OFF_LEDGER',
  )
})
