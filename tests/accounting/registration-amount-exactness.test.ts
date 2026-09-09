import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  zeroPaidIsProvenReversal,
  type PaidStateBinding,
  type RegisteredPaymentRow,
} from '@/lib/connectors/xero/invoice-delta'
import {
  invoicePaymentAmountRoundTrips,
  payloadRegisteredAmount,
  REGISTERED_AMOUNT_DECIMAL_FIELD,
} from '@/lib/domain/accounting/invoice-payment-enqueue'
import { coversDocumentTotal, PAID_COVERAGE_EPSILON } from '@/lib/domain/accounting/paid-coverage'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-1xq8 (Codex HIGH) — THE LAST LOSSY HOP UNDER THE COVERAGE RULE, AND THE DIRECTION THE
 * DISCLOSURE THAT FILED IT DID NOT PROVE.
 *
 * THE HISTORY, because this file exists to correct a claim as much as a defect. o3d-psrx r18 made the
 * coverage rule exact — `coversDocumentTotal` takes `Decimal`s, both writer call sites sum stored
 * decimals, and `sumRegisteredAmounts` adds without rounding — and disclosed the one hop it left
 * open: `registerInvoicePaymentWithLedger` wrote `Number(receipt.amount)` into the registration
 * payload, so the reader's term was a double however exact the arithmetic around it. The disclosure
 * said that residue was fail-closed, and offered a test as evidence:
 *
 *     at 2^39 no double answers to `549755813888.0003` — the nearest one is named `...0002`. So a
 *     registration that really did settle this order reads as one minor unit short and the reader
 *     WITHHOLDS. That is the fail-closed direction.
 *
 * EVERY WORD OF THAT IS TRUE AND THE CONCLUSION IS NOT. It establishes that the conversion can round
 * DOWN and that rounding down withholds. Rounding is not one-directional. `549755813888.0008` — a
 * perfectly ordinary value of a `Decimal(18, 4)` column — converts to a double whose own decimal
 * reading is `549755813888.0009`, a WHOLE MINOR UNIT ABOVE the receipt. Against an order totalling
 * `549755813888.0009` that is not "within the band", it is exact coverage of a document the receipts
 * fall a minor unit short of: `coversDocumentTotal` answers YES, the PART_COVERED_OFF_LEDGER guard
 * stands down, `classifyRegisteredPaymentAgainstListing` returns GONE, `zeroPaidIsProvenReversal`
 * admits, and `paidAt` is cleared with a chargeback credit note raised against a customer who paid.
 *
 * That is the same shape as the two findings r18 was itself reporting on: a check that is sound,
 * establishes a real property, and does not establish the one that was claimed. It reached a
 * DISCLOSURE, which is the document a later reader trusts precisely because they cannot re-derive it.
 *
 * WHAT CLOSES IT, and both halves are tested here:
 *
 *   the READER   the enqueue now records the receipt's exact decimal STRING beside the number, and
 *                `payloadRegisteredAmount` prefers it. Additive: a historical row carries no string,
 *                falls through to the number, and is read exactly as it is today.
 *   the WRITER   `invoicePaymentAmountRoundTrips` refuses to enqueue at all an amount whose two forms
 *                would disagree — because the number is what the connectors put on the WIRE, and the
 *                string does nothing for the figure that is actually sent.
 *
 * The wiring that produces such a payload, and the refusal in situ, are in
 * tests/accounting/registration-amount-enqueue-wiring.test.ts.
 */

const READ_AT = databaseLedgerFence(new Date('2026-08-20T12:00:00.000Z'))
const EPISODE_BEGAN = new Date('2026-08-20T10:00:00.000Z')
const withMarker: PaidStateBinding = { accountingInvoiceId: 'inv_1', unregisteredPaidAt: EPISODE_BEGAN }

/** THE EXACT FIGURE FROM THE FINDING. An order total, and a receipt one whole minor unit short of it. */
const UP_TOTAL = '549755813888.0009'
const UP_RECEIPT = '549755813888.0008'

/** The r18 disclosure's own figures, which round the OTHER way. Kept, and still withholding. */
const DOWN_TOTAL = '549755813888.0003'
const DOWN_RECEIPT = '549755813888.0002'

/**
 * A registration row as `readPaidProvenanceVerdicts` builds one: bound to this paid episode, posted
 * before the fence, and carrying whatever `payloadRegisteredAmount` made of its stored payload.
 */
function registrationFor(payload: Record<string, unknown>, currency = 'GBP'): RegisteredPaymentRow {
  return {
    id: 'log_1',
    status: 'SYNCED',
    // o3d-f709: neither marker set — the ordinary shape, and the one `mayHaveReachedLedger`
    // refuses to read as "nothing was sent". Irrelevant to a SYNCED row; named because the
    // type requires it rather than defaulting it, so a reader cannot ask without loading it.
    abandonedBeforeRemoteCall: null,
    settlementBasis: null,
    externalTransactionId: 'PAY-1',
    syncedAt: new Date('2026-08-20T11:00:00.000Z'),
    syncedAtDatabaseClock: new Date('2026-08-20T11:00:00.000Z'),
    registeredAgainstInvoiceId: 'inv_1',
    // THROUGH THE PRODUCTION READER, not a hand-written figure. A test that assigned
    // `registeredAmount` directly would prove something about the classifier and nothing about the
    // payload, and the payload is where this defect lives.
    registeredAmount: payloadRegisteredAmount(payload, currency),
  }
}

/** The payload the enqueue writes TODAY: the number, and the exact decimal string beside it. */
function currentPayload(amount: string, currency = 'GBP'): Record<string, unknown> {
  return { amount: Number(amount), [REGISTERED_AMOUNT_DECIMAL_FIELD]: amount, currency }
}

/** The payload every row written BEFORE this issue carries: the number alone. */
function historicalPayload(amount: string, currency = 'GBP'): Record<string, unknown> {
  return { amount: Number(amount), currency }
}

function verdictFor(row: RegisteredPaymentRow, total: string) {
  return classifyRegisteredPaymentAgainstListing(
    // The ledger was read IN FULL and lists nothing: whatever IMS registered is gone from it. That is
    // the input under which coverage decides between "a reversal of the whole document" and "an
    // account of a part of it".
    new Set<string>(), [row], READ_AT, [], true, withMarker, toDecimal(total),
  )
}

test('[o3d-1xq8] an amount that rounds UP cannot manufacture coverage', () => {
  // THE PRECONDITIONS, so this test cannot pass by examining nothing.
  //
  // 1. The receipt really is short. A whole minor unit of a four-decimal currency, an order of
  //    magnitude above the band, so the epsilon is not what is being measured.
  assert.ok(toDecimal(UP_RECEIPT).lt(toDecimal(UP_TOTAL)),
    'PRECONDITION: the receipt is below the order total')
  assert.ok(toDecimal(UP_TOTAL).sub(toDecimal(UP_RECEIPT)).gt(PAID_COVERAGE_EPSILON),
    'PRECONDITION: and short by more than the coverage band, so this is a shortfall and not dust')
  // 2. The conversion moves it UP — the direction the r18 disclosure did not cover — and moves it far
  //    enough to land exactly ON the total. Not "within the band of" the total: on it.
  assert.equal(toDecimal(Number(UP_RECEIPT)).toFixed(), UP_TOTAL,
    'PRECONDITION: THE FINDING — as a double the receipt reads as the whole order total')
  // 3. So the defect is reachable: read through the number alone, this order is fully covered.
  assert.equal(coversDocumentTotal(toDecimal(Number(UP_RECEIPT)), toDecimal(UP_TOTAL)), true,
    'PRECONDITION: and the coverage rule therefore says YES to a receipt that is a minor unit short')

  // THE RULE, on the exact decimal.
  assert.equal(coversDocumentTotal(toDecimal(UP_RECEIPT), toDecimal(UP_TOTAL)), false,
    'a receipt one minor unit short of the order does not cover it')

  // AND THE VERDICT IT DOMINATES, through the production reader: a payload that states its exact
  // decimal is read at that decimal, the coverage guard stands, and the reader WITHHOLDS.
  const verdict = verdictFor(registrationFor(currentPayload(UP_RECEIPT)), UP_TOTAL)
  assert.equal(verdict.verdict, 'PART_COVERED_OFF_LEDGER',
    'the ledger\'s silence about a PART-covering registration is not a reversal of the whole document')
  assert.equal(zeroPaidIsProvenReversal(verdict), false,
    'so paidAt is LEFT SET and no chargeback credit note is raised over the remainder')

  // THE CONTROL THAT PROVES THIS IS NOT "WITHHOLD EVERYTHING AT THIS MAGNITUDE": the receipt that
  // genuinely settles the order still covers it and is still admitted as a reversal.
  const exact = verdictFor(registrationFor(currentPayload(UP_TOTAL)), UP_TOTAL)
  assert.equal(exact.verdict, 'GONE',
    'a registration that settled the WHOLE order and is now absent IS a removal of the whole order')
  assert.equal(zeroPaidIsProvenReversal(exact), true)
})

test('[o3d-1xq8] an amount that rounds DOWN still withholds', () => {
  // The r18 direction, kept. Its conclusion was right about this half and only about this half.
  assert.equal(toDecimal(Number(DOWN_TOTAL)).toFixed(), DOWN_RECEIPT,
    'PRECONDITION: as a double the order total reads as one minor unit LESS than itself')

  // A receipt that genuinely IS a minor unit short still withholds — read exactly, not by luck of the
  // conversion. This is the assertion the fix must not weaken: making the reader exact must not turn
  // a real shortfall into coverage.
  const short = verdictFor(registrationFor(currentPayload(DOWN_RECEIPT)), DOWN_TOTAL)
  assert.equal(short.verdict, 'PART_COVERED_OFF_LEDGER',
    'a receipt a minor unit short withholds whichever way its double would have rounded')
  assert.equal(zeroPaidIsProvenReversal(short), false)

  // And the everyday shortfall, which is the one this rule answers on every poll.
  const everyday = verdictFor(registrationFor(currentPayload('99.9900')), '100.0000')
  assert.equal(everyday.verdict, 'PART_COVERED_OFF_LEDGER')
  assert.equal(zeroPaidIsProvenReversal(everyday), false)
})

test('[o3d-1xq8] a historical row with no decimal string settles exactly as it does today', () => {
  // THE WHOLE CASE FOR AN ADDITIVE FIELD. No row is rewritten, so a row written before this issue
  // carries the number alone — and it must be read the way it was read yesterday, neither better nor
  // worse. `payloadRegisteredAmount` therefore falls through to the double's own exact decimal
  // reading, which is precisely what `sumRegisteredAmounts` already made of it.
  assert.equal(payloadRegisteredAmount(historicalPayload('100.0000'), 'GBP')?.toFixed(), '100',
    'the number arm answers the double\'s own decimal reading, as it always did')

  // The ordinary historical row: full coverage, admitted, unchanged.
  const covered = verdictFor(registrationFor(historicalPayload('100.0000')), '100.0000')
  assert.equal(covered.verdict, 'GONE')
  assert.equal(zeroPaidIsProvenReversal(covered), true)

  // The ordinary historical shortfall: withheld, unchanged.
  assert.equal(verdictFor(registrationFor(historicalPayload('1.0000')), '100.0000').verdict,
    'PART_COVERED_OFF_LEDGER')

  // AND THE RESIDUAL, STATED RATHER THAN HIDDEN. At 2^39 a historical row still carries only the
  // double, so the manufactured coverage above is still what such a row produces. The information
  // needed to read it exactly was destroyed when it was written and no reader can recover it; the
  // guarantee this issue buys is for rows written from now on, and it is bought at the WRITER as well
  // as the reader — an amount like this one is now refused before any row is created. This assertion
  // is the honest record of what a legacy row does, and it is expected to keep passing for ever.
  const legacy = verdictFor(registrationFor(historicalPayload(UP_RECEIPT)), UP_TOTAL)
  assert.equal(legacy.verdict, 'GONE',
    'RESIDUAL: a pre-o3d-1xq8 row at 2^39 still reads as covering — no worse than it is today, and '
    + 'not recoverable, which is why the writer refuses to create another one')

  // A payload that will not say at all — retention-compacted to `{}`, or raised in another currency —
  // still answers NULL, and NULL is still "cannot be established", never zero and never full cover.
  assert.equal(payloadRegisteredAmount({}, 'GBP'), null)
  assert.equal(payloadRegisteredAmount(currentPayload('100.0000', 'EUR'), 'GBP'), null,
    'a registration raised in another currency covers none of this document')
})

test('[o3d-1xq8] a present but unreadable decimal string refuses, it does not fall back to the number', () => {
  // A payload that carries this field was written by a build that promised it is exact. If the string
  // is not a decimal numeral that promise is broken, and reverting to the double beside it would
  // silently reinstate the hop the field exists to remove — on a payload that has already been shown
  // to be untrustworthy. PRESENT DECIDES.
  for (const bad of ['', '  ', 'NaN', 'Infinity', '1e3', '0x10', '1.2.3', '--1', '100,00', 'abc']) {
    assert.equal(payloadRegisteredAmount({ amount: 100, [REGISTERED_AMOUNT_DECIMAL_FIELD]: bad, currency: 'GBP' }, 'GBP'),
      null, `an unreadable decimal string (${JSON.stringify(bad)}) answers null, never 100`)
  }
  // Not a string at all is the same refusal, for the same reason.
  assert.equal(payloadRegisteredAmount({ amount: 100, [REGISTERED_AMOUNT_DECIMAL_FIELD]: 100, currency: 'GBP' }, 'GBP'), null)
  assert.equal(payloadRegisteredAmount({ amount: 100, [REGISTERED_AMOUNT_DECIMAL_FIELD]: null, currency: 'GBP' }, 'GBP'), null)

  // And the readable forms it must accept, including a negative and a bare integer.
  assert.equal(payloadRegisteredAmount(currentPayload('100.0000'), 'GBP')?.toFixed(), '100')
  assert.equal(payloadRegisteredAmount({ amount: 7, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '7', currency: 'GBP' }, 'GBP')?.toFixed(), '7')
  assert.equal(payloadRegisteredAmount({ amount: -2.5, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '-2.5000', currency: 'GBP' }, 'GBP')?.toFixed(), '-2.5')
  // The string is PREFERRED, which is only observable where the two disagree — i.e. exactly where the
  // defect was. A disagreeing pair cannot be written any more; it can still be READ.
  assert.equal(payloadRegisteredAmount(currentPayload(UP_RECEIPT), 'GBP')?.toFixed(), UP_RECEIPT,
    'the string wins over a number that reads a whole minor unit higher')
})

test('[o3d-1xq8] the writer refuses an amount it cannot state as the JSON number the wire takes', () => {
  // The connectors' payment bodies state the amount as a JSON number (`Amount` on Xero, `TotalAmt` /
  // `Line[0].Amount` on QuickBooks). The decimal string makes the COVERAGE route exact; it does
  // nothing for the figure that is actually SENT. So the writer — the one place that holds the stored
  // `Decimal` — refuses what it cannot state in both forms.
  assert.equal(invoicePaymentAmountRoundTrips(toDecimal(UP_RECEIPT)), false,
    'THE FINDING\'S OWN FIGURE: no double names it, so it is not sendable')
  assert.equal(invoicePaymentAmountRoundTrips(toDecimal(DOWN_TOTAL)), false)

  // AND IT NEVER FIRES ON AN AMOUNT ANY REAL ORDER CARRIES. A `Decimal(18, 4)` round-trips through a
  // double up to 2^53 / 10^4, so the refusal is a backstop and not a new failure mode.
  for (const ordinary of ['0.0000', '0.0001', '1.0000', '99.9900', '100.0000', '1234567.8912', '999999999.9999', '-2.5000']) {
    assert.equal(invoicePaymentAmountRoundTrips(toDecimal(ordinary)), true,
      `${ordinary} is sendable, so the refusal cannot reach an ordinary receipt`)
  }
})
