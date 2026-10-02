import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregatePaymentSyncRows,
  settlementStatus,
  syncRowSettledAmount,
  type PaymentSyncRow,
} from '@/lib/domain/accounting/settlement-status'
import { loadInvoicePaymentSyncRows } from '@/lib/domain/accounting/invoice-payment-enqueue'
import { decideInvoicePaymentRegistration } from '@/lib/domain/accounting/invoice-payment-registration'
import {
  readPayloadRegisteredAmount,
  REGISTERED_AMOUNT_DECIMAL_FIELD,
  statedAmountOnly,
} from '@/lib/domain/accounting/registered-amount'
import { ledgerAmountEpsilon, toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-4ozd — THE SETTLEMENT VERDICT MEASURES MONEY, SO IT MEASURES IT EXACTLY.
 *
 * Codex, o3d-acctmoney r21 HIGH. o3d-6yho gave `settlementStatus` a band derived from the document's
 * own minor unit and left BOTH operands as doubles: the sync row's wire `amount`, and the caller's
 * `.toNumber()` of the stored `Decimal(18, 4)` total. An exact tolerance over collapsed operands is
 * still a lossy comparison — if the two figures already agree as doubles, the precision of the band
 * decides nothing.
 *
 * Every test below asserts the PRECONDITION it depends on — that the two figures really do collapse
 * onto one double — so none of them can pass by the collapse quietly ceasing to happen.
 */

/** Codex's figures. Strings, because a JS number literal has already lost the thing under test. */
const OVER_TOTAL = '35184372088832.0040'
const OVER_PAID = '35184372088832.01'

/** The same shape one binade down, in a currency whose minor unit is a fil. */
const SHORT_TOTAL = '35184372088832.003'
const SHORT_PAID = '35184372088831.999'

const base = { paidLocally: true, syncEnabled: true, documentPosted: true }

function syncedRow(over: Partial<PaymentSyncRow> = {}): PaymentSyncRow {
  return { status: 'SYNCED', externalTransactionId: 'PAY-1', ...over }
}

/** A row exactly as `loadInvoicePaymentSyncRows` builds one: the wire number AND the exact decimal. */
function registeredRow(amount: string, over: Partial<PaymentSyncRow> = {}): PaymentSyncRow {
  return syncedRow({ amount: Number(amount), registeredAmount: { kind: 'stated', amount: toDecimal(amount) }, ...over })
}

/** A row from before o3d-1xq8: the wire number and nothing beside it. */
function historicalRow(amount: string, over: Partial<PaymentSyncRow> = {}): PaymentSyncRow {
  return syncedRow({ amount: Number(amount), ...over })
}

function syncLogClient(rows: Array<{ id: string; status: string; payload: unknown }>) {
  return {
    accountingSyncLog: {
      findMany: async () => rows.map((r) => ({
        status: r.status,
        externalTransactionId: 'PAY-1',
        errorMessage: null,
        retryCount: 0,
        payload: r.payload,
        id: r.id,
        settlementBasis: null,
      })),
    },
  } as unknown as Parameters<typeof loadInvoicePaymentSyncRows>[3]
}

function invoicePaymentPayload(amount: string, currency: string, opts: { exact?: boolean } = {}) {
  return {
    accountingInvoiceId: 'INV-1',
    bankAccountId: 'bank-1',
    paymentId: 'pay-1',
    amount: Number(amount),
    currency,
    ...(opts.exact === false ? {} : { [REGISTERED_AMOUNT_DECIMAL_FIELD]: amount }),
  }
}

// ---------------------------------------------------------------------------
// The two directions, on the figures the finding named.
// ---------------------------------------------------------------------------

test('[o3d-4ozd] a document the ledger holds SIX THOUSANDTHS more than IMS claims is OVER_SETTLED', () => {
  // ROUTE: settlementStatus's SYNCED branch, the `paid > total + band` comparison.
  // MUTATION: read `p.amount` and `Number(input.totalForeign)` again — the two operands collapse onto
  // one double, the comparison reads `x > x + band`, and this returns a green SETTLED with
  // `discrepancy: false` over a ledger that is over-paid.
  assert.equal(
    Number(OVER_TOTAL),
    Number(OVER_PAID),
    'the precondition: both stored figures are the SAME double, so no band applied to doubles can see them apart',
  )
  assert.equal(
    toDecimal(OVER_PAID).sub(toDecimal(OVER_TOTAL)).toFixed(),
    '0.006',
    'and exactly, they are six thousandths apart',
  )
  assert.equal(ledgerAmountEpsilon('GBP').toFixed(), '0.005', 'which is outside the GBP band')

  const v = settlementStatus({
    ...base,
    currency: 'GBP',
    totalForeign: toDecimal(OVER_TOTAL),
    payment: registeredRow(OVER_PAID),
  })
  assert.equal(v.status, 'OVER_SETTLED')
  assert.equal(v.discrepancy, true)
  assert.match(v.detail, /OVER-paid/)
  // AND THE SENTENCE NAMES THE TWO FIGURES APART. A `toNumber()` here prints both as
  // 35184372088832.01 — "recorded X against a settlement of X, so it is OVER-paid" — which is a
  // refusal no operator can act on.
  //
  // ROUTE: the OVER_SETTLED detail's `toFixed()`.
  // MUTATION: print `toNumber()` and the two figures become one string.
  assert.match(v.detail, /35184372088832\.01 against a settlement of 35184372088832\.004/)
})

test('[o3d-4ozd] a document FOUR THOUSANDTHS short of its total is PARTIALLY_SETTLED', () => {
  // Four whole fils of a Gulf dinar still outstanding, against a band of half one fil.
  //
  // ROUTE: settlementStatus's SYNCED branch, the `paid + band < total` comparison.
  // MUTATION: restore either operand to its double and this reads SETTLED — a green badge over a
  // balance the ledger is still accounting for, which is the direction that stops anyone looking.
  assert.equal(
    Number(SHORT_TOTAL),
    Number(SHORT_PAID),
    'the precondition: the shortfall does not survive the conversion at all',
  )
  assert.equal(toDecimal(SHORT_TOTAL).sub(toDecimal(SHORT_PAID)).toFixed(), '0.004')
  assert.equal(ledgerAmountEpsilon('KWD').toFixed(), '0.0005', 'eight times the band')

  const v = settlementStatus({
    ...base,
    currency: 'KWD',
    totalForeign: toDecimal(SHORT_TOTAL),
    payment: registeredRow(SHORT_PAID),
  })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
  assert.equal(v.discrepancy, true)
  // ROUTE: the PARTIALLY_SETTLED detail's `toFixed()`.
  // MUTATION: print `toNumber()` and both figures read 35184372088832.
  assert.match(v.detail, /PART payment of 35184372088831\.999 against a total of 35184372088832\.003/)
})

// ---------------------------------------------------------------------------
// And the two things exactness must NOT have cost.
// ---------------------------------------------------------------------------

test('[o3d-4ozd] an ordinary settled document still reads SETTLED, and its rounding is still absorbed', () => {
  // Without this, "measure exactly" could be satisfied by breaking full settlement for everybody: a
  // comparison with no band at all would pass both tests above and report every real order as
  // partially settled.
  //
  // ROUTE: the same two comparisons.
  // MUTATION: drop `settlementBand` from either side and the second and third assertions fail.
  const exact = settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('100.00'), payment: registeredRow('100.00') })
  assert.equal(exact.status, 'SETTLED')
  assert.equal(exact.discrepancy, false)
  assert.equal(exact.basis, 'LEDGER_CONFIRMED')

  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('100.00'), payment: registeredRow('99.998') }).status,
    'SETTLED',
    'a fifth of a penny short is still arithmetic dust in GBP',
  )
  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('100.00'), payment: registeredRow('100.002') }).status,
    'SETTLED',
    'and so is a fifth of a penny over',
  )
})

test('[o3d-4ozd] a historical row with no decimal string is read exactly as it is today', () => {
  // The additive promise: no row is rewritten and no row gets worse. A row from before o3d-1xq8
  // carries only the JSON number, `syncRowSettledAmount` reads that number's OWN exact decimal value
  // — which is precisely what the comparison made of it before — and every verdict is unchanged.
  //
  // ROUTE: syncRowSettledAmount's fallback arm.
  // MUTATION: make the fallback answer `null` and the part payment below reads SETTLED; make it
  // answer zero and the full payment below reads PARTIALLY_SETTLED.
  assert.equal(syncRowSettledAmount(historicalRow('99.999'))!.toFixed(), toDecimal(99.999).toFixed())
  assert.equal(syncRowSettledAmount(syncedRow({ amount: null })), null, 'and an absent amount stays uncomparable')

  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('1000'), payment: historicalRow('1') }).status,
    'PARTIALLY_SETTLED',
  )
  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('1000'), payment: historicalRow('1000') }).status,
    'SETTLED',
  )
  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('1000'), payment: syncedRow({ amount: null }) }).status,
    'SETTLED',
    'an uncomparable amount is not a shortfall',
  )
  // AND IT IS READ NO BETTER THAN IT WAS. `549755813888.0003` does not survive a JSON number: the
  // double's own decimal reading is `549755813888.0002`, a whole minor unit short of the receipt the
  // row was raised for. The reader says exactly that, rather than pretending a row that never stated
  // an exact figure was hiding one — which is what makes this fix additive.
  assert.equal(syncRowSettledAmount(historicalRow('549755813888.0003'))!.toFixed(), '549755813888.0002')
  assert.equal(
    syncRowSettledAmount(registeredRow('549755813888.0003'))!.toFixed(),
    '549755813888.0003',
    'while a row that DOES state the figure is read as the figure',
  )
})

// ---------------------------------------------------------------------------
// The aggregate is the other operand, and it was summed as doubles.
// ---------------------------------------------------------------------------

test('[o3d-4ozd] several registrations settle for their EXACT sum, not for the sum of their doubles', () => {
  // Two registrations of 17592186044416.002 KWD each. Their exact sum falls four whole fils short of
  // the bill; summed as doubles each term rounds UP by ~0.0019 and the total lands inside the band.
  //
  // ROUTE: aggregatePaymentSyncRows's `syncedRegistered` reduce, read by settlementStatus.
  // MUTATION: restore `synced.reduce((sum, r) => sum + r.amount, 0)` and this reads SETTLED —
  // manufactured coverage, which is the direction that stops anyone chasing the balance.
  const LEG = '17592186044416.002'
  const TOTAL = '35184372088832.008'
  assert.equal(
    (Number(LEG) + Number(LEG)).toString(),
    Number(TOTAL).toString(),
    'the precondition: added as doubles the two legs are indistinguishable from the whole bill',
  )
  assert.equal(toDecimal(LEG).add(toDecimal(LEG)).toFixed(), '35184372088832.004', 'exactly, they are four fils short')

  const agg = aggregatePaymentSyncRows([
    registeredRow(LEG, { externalTransactionId: 'PAY-1' }),
    registeredRow(LEG, { externalTransactionId: 'PAY-2' }),
  ])!
  assert.equal(statedAmountOnly(agg.registeredAmount!)!.toFixed(), '35184372088832.004')

  const v = settlementStatus({ ...base, currency: 'KWD', totalForeign: toDecimal(TOTAL), payment: agg })
  assert.equal(v.status, 'PARTIALLY_SETTLED')
  assert.equal(v.discrepancy, true)
})

test('[o3d-4ozd] one leg that states no amount still makes the SUM unknown rather than smaller', () => {
  // The exactness must not have turned "cannot be measured" into a shortfall.
  //
  // ROUTE: aggregatePaymentSyncRows's `amountUnknown`.
  // MUTATION: treat a null term as zero and this reads PARTIALLY_SETTLED over an invoice nothing
  // knows to be short.
  const agg = aggregatePaymentSyncRows([
    registeredRow('40'),
    syncedRow({ externalTransactionId: 'PAY-2', amount: null }),
  ])!
  assert.equal(agg.amount, null)
  assert.equal(agg.registeredAmount!.kind, 'not-stated', 'a term that states nothing makes the SUM state nothing')
  assert.equal(settlementStatus({ ...base, currency: 'GBP', totalForeign: toDecimal('100'), payment: agg }).status, 'SETTLED')
})

// ---------------------------------------------------------------------------
// The whole route, from the stored payload to the verdict.
// ---------------------------------------------------------------------------

test('[o3d-4ozd] the payload s exact decimal reaches the verdict through the reader and the aggregate', async () => {
  // Not a hand-built row: the figure is read out of a stored payload by `loadInvoicePaymentSyncRows`,
  // reduced by `aggregatePaymentSyncRows`, and compared by `settlementStatus`. Every hop between the
  // column and the comparison is exercised, because a hop is exactly where the conversion used to be.
  //
  // ROUTE: loadInvoicePaymentSyncRows -> aggregatePaymentSyncRows -> settlementStatus.
  // MUTATION: drop `registeredAmount` from the row `loadInvoicePaymentSyncRows` builds and the
  // aggregate falls back to the wire number, which collapses onto the total.
  //
  // The figure is `549755813888.0003` in CLF, because that one does not survive the payload's JSON
  // number — it comes back `549755813888.0002` — so the two payloads give the verdict two different
  // answers and the string is demonstrably the one that decided.
  const EXACT_RECEIPT = '549755813888.0003'
  assert.equal(String(Number(EXACT_RECEIPT)), '549755813888.0002', 'the precondition: the wire number is a minor unit short')
  assert.equal(ledgerAmountEpsilon('CLF').toFixed(), '0.00005', 'and one CLF minor unit is outside the band')

  const rows = await loadInvoicePaymentSyncRows(
    'order-1',
    'xero',
    'CLF',
    syncLogClient([{ id: 'log-1', status: 'SYNCED', payload: invoicePaymentPayload(EXACT_RECEIPT, 'CLF') }]),
  )
  assert.equal(rows.length, 1)
  assert.equal(statedAmountOnly(rows[0].registeredAmount)!.toFixed(), EXACT_RECEIPT)
  assert.equal(rows[0].amount, Number(EXACT_RECEIPT), 'the wire number is still on the row, untouched')

  assert.equal(
    settlementStatus({
      ...base,
      currency: 'CLF',
      totalForeign: toDecimal(EXACT_RECEIPT),
      payment: aggregatePaymentSyncRows(rows),
    }).status,
    'SETTLED',
    'the registration settles the document exactly, and the exact string is what says so',
  )

  // The SAME payload without the decimal string is the historical row: read at the number's own
  // value, which is a minor unit short, and the verdict says a balance remains — unchanged from what
  // this row has always produced.
  const historical = await loadInvoicePaymentSyncRows(
    'order-1',
    'xero',
    'CLF',
    syncLogClient([{ id: 'log-1', status: 'SYNCED', payload: invoicePaymentPayload(EXACT_RECEIPT, 'CLF', { exact: false }) }]),
  )
  assert.equal(statedAmountOnly(historical[0].registeredAmount)!.toFixed(), '549755813888.0002')
  assert.equal(
    settlementStatus({
      ...base,
      currency: 'CLF',
      totalForeign: toDecimal(EXACT_RECEIPT),
      payment: aggregatePaymentSyncRows(historical),
    }).status,
    'PARTIALLY_SETTLED',
  )
})

/* ------------------------------------------------------------------------------------------- *
 * o3d-r948 (Codex HIGH 2) — AND A REFUSAL IS NOT A SILENCE.
 *
 * `payloadRegisteredAmount` answers null for three different facts — no exact figure was ever
 * written, one was and will not parse, one was in another currency — and `syncRowSettledAmount`
 * treated all three as "no exact amount" and reached for the lossy number beside them. Two of them
 * are refusals, and this repository's own rule (see `exactPayloadDecimal`) is that a
 * present-but-unreadable exact figure is a refusal and never a fallback.
 * ------------------------------------------------------------------------------------------- */

const R948_DATE = '2026-08-01'
/* ------------------------------------------------------------------------------------------- *
 * 2. THE TRI-STATE: A REFUSAL IS NOT A SILENCE (Codex HIGH 2).
 * ------------------------------------------------------------------------------------------- */

/** A row exactly as `latestBillPaymentSyncRows` / `loadInvoicePaymentSyncRows` build one. */
function rowFrom(payload: Record<string, unknown>, currency = 'GBP'): PaymentSyncRow {
  return syncedRow({
    amount: typeof payload.amount === 'number' ? payload.amount : null,
    registeredAmount: readPayloadRegisteredAmount(payload, currency),
  })
}

const verdictFor = (payment: PaymentSyncRow) => settlementStatus({
  paidLocally: true, syncEnabled: true, documentPosted: true,
  currency: 'GBP', totalForeign: toDecimal('100'), payment,
})

test('[o3d-r948] an explicitly REFUSED exact amount never falls back to the wire number', () => {
  // The rule this violated is written in `exactPayloadDecimal`: a present-but-unreadable exact string
  // is a refusal, never a fallback to the lossy number beside it. All three refusals below carry a
  // perfectly good wire number for the old code to have spent.
  //
  // ROUTE: readPayloadRegisteredAmount -> PaymentSyncRow.registeredAmount -> syncRowAmountReading
  //        -> settlementStatus's SYNCED branch.
  // MUTATION: let `exactAmountReadingOrLegacy` fall back on `refused` too, and every arm below reads
  //        PARTIALLY_SETTLED — a verdict taken on a figure this code declined to read.
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a present exact string that will not parse', { amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: 'forty', currency: 'GBP' }, /not a figure IMS can read/],
    ['a present exact value that is not a string', { amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: 40, currency: 'GBP' }, /not a figure IMS can read/],
    ['a figure stated in another currency', { amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '40.00', currency: 'EUR' }, /different currency/],
    ['a figure whose currency is not stated at all', { amount: 40 }, /does not record which currency/],
  ]
  for (const [what, payload, sentence] of refusals) {
    // THE PRECONDITION: this payload really is refused, and it really does carry the number that used
    // to be spent in its place.
    assert.equal(readPayloadRegisteredAmount(payload, 'GBP').kind, 'refused', what)
    const row = rowFrom(payload)
    assert.equal(row.amount, 40, `${what}: the wire number is there to be fallen back to`)

    assert.equal(syncRowSettledAmount(row), null, `${what}: and it is NOT spent`)
    const verdict = verdictFor(row)
    assert.equal(verdict.status, 'SETTLEMENT_AMOUNT_UNREADABLE', what)
    assert.equal(verdict.discrepancy, true, `${what}: a refusal must make someone look`)
    assert.match(verdict.detail, sentence, what)
    // And it must not read as a green settlement OR as a measured shortfall: nothing was measured.
    assert.doesNotMatch(verdict.detail, /PART payment of 40/, what)
  }
})

test('[o3d-r948] an OMITTED exact amount still uses the legacy numeric fallback', () => {
  // The other half, and the one that keeps every historical row settling exactly as it does today.
  // BILL_PAYMENT writes no exact decimal at all, so this is not a corner: it is every bill.
  //
  // ROUTE: readPayloadRegisteredAmount's fallback arm -> exactAmountReadingOrLegacy's not-stated arm.
  // MUTATION: refuse on `not-stated` as well and every bill in the system loses part-payment
  //        detection — the assertion below reads SETTLEMENT_AMOUNT_UNREADABLE.
  const historical = { amount: 40, currency: 'GBP' }
  assert.equal(readPayloadRegisteredAmount(historical, 'GBP').kind, 'stated', 'the precondition')

  const verdict = verdictFor(rowFrom(historical))
  assert.equal(verdict.status, 'PARTIALLY_SETTLED')
  assert.match(verdict.detail, /PART payment of 40 against a total of 100/)

  // A row with NO reading supplied at all is the same fact by a different route — a caller that does
  // not read payloads, and every fixture written before this type existed.
  assert.equal(verdictFor(syncedRow({ amount: 40 })).status, 'PARTIALLY_SETTLED')

  // ...and a payload that states NOTHING stays a silence rather than becoming a refusal: no figure,
  // no comparison, and the verdict this module has always given such a row.
  assert.equal(readPayloadRegisteredAmount({}, 'GBP').kind, 'not-stated', 'a retention-compacted body says nothing')
  assert.equal(verdictFor(rowFrom({})).status, 'SETTLED')
})

test('[o3d-r948] the aggregate carries the refusal rather than laundering it into a silence', () => {
  // `aggregatePaymentSyncRows` reduces every SYNCED row to one, and a null sum was its ONLY way of
  // saying "unmeasurable". Collapsing a refused term into that null would have reinstated the finding
  // one function further along — the aggregate would reach settlementStatus looking like a row that
  // simply states no figure, which falls through to a green SETTLED.
  //
  // ROUTE: aggregatePaymentSyncRows -> PaymentSyncRow.registeredAmount -> settlementStatus.
  // MUTATION: build the aggregate's reading as `{ kind: 'not-stated' }` when a term was refused and
  //        this reads SETTLED.
  const refused = rowFrom({ amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: 'forty', currency: 'GBP' })
  assert.equal(refused.registeredAmount?.kind, 'refused', 'the precondition')

  const agg = aggregatePaymentSyncRows([rowFrom({ amount: 40, currency: 'GBP' }), refused])!
  assert.equal(agg.registeredAmount?.kind, 'refused')
  assert.equal(verdictFor(agg).status, 'SETTLEMENT_AMOUNT_UNREADABLE')

  // The discriminating half: a term that states NOTHING still makes the sum state nothing, which is
  // the answer this reduce has always given.
  const silent = aggregatePaymentSyncRows([
    rowFrom({ amount: 40, currency: 'GBP' }),
    syncedRow({ externalTransactionId: 'PAY-2', amount: null }),
  ])!
  assert.equal(silent.registeredAmount?.kind, 'not-stated')
  assert.equal(verdictFor(silent).status, 'SETTLED')
})

test('[o3d-r948] an unresolved attempt with a refused figure is undescribable, not described from the wire number', () => {
  // The second collapse site. `decideInvoicePaymentRegistration` described an unresolved attempt as
  // `registeredAmount ?? toDecimal(amount)`, so a refused figure was replaced by the very number the
  // refusal is about — and the resulting description was then MATCHED against the ledger. When it
  // failed to match, the verdict was `clear` and the registration proceeded.
  //
  // ROUTE: decideInvoicePaymentRegistration's unresolved-attempt loop -> classifyLedgerSettlement.
  // MUTATION: restore `attempt.registeredAmount ?? (…toDecimal(attempt.amount))` and the refused
  //        attempt is described as 40, does not match the ledger's 99, and the receipt registers.
  const attempt = (exact: unknown) => ({
    status: 'FAILED' as const,
    amount: 40,
    registeredAmount: readPayloadRegisteredAmount(
      { amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: exact, currency: 'GBP' }, 'GBP'),
    paymentDate: R948_DATE,
    paymentId: 'pay-old',
    couldHaveReachedLedger: true,
    // o3d-kof8: REQUIRED now. A FAILED row that names no document and carries no cancellation
    // claim is exactly what the connector writes when a call is attempted and does not answer.
    externalTransactionId: null,
    abandonedBeforeRemoteCall: null,
    settlementBasis: null,
  })
  const decide = (exact: unknown) => decideInvoicePaymentRegistration({
    syncEnabled: true,
    accountingInvoiceId: 'INV-1',
    orderCurrency: 'GBP',
    paymentCurrency: 'GBP',
    paymentAmount: toDecimal('10.00'),
    paymentId: 'pay-new',
    bankAccountId: 'bank-1',
    existing: [attempt(exact)],
    // Nothing on the document resembles the attempt, so a DESCRIBABLE attempt is positively clear.
    ledgerSettlements: {
      ok: true,
      // o3d-obyd r31: the document's own settled figure was stated, so "nothing here resembles the
      // attempt" is the ledger's answer and not this list's silence. Without it a non-match is
      // `unknown`, which is a different fixture entirely.
      provedComplete: true,
      records: [{ amount: toDecimal('99.00'), date: R948_DATE, reference: null }],
    },
    ledgerTotal: toDecimal('100.00'),
  })

  // THE PRECONDITION: with a readable exact string this fixture registers. Whatever refuses below is
  // the refusal, not the shape of the test.
  assert.equal(readPayloadRegisteredAmount({ amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '40.00', currency: 'GBP' }, 'GBP').kind, 'stated')
  assert.equal(decide('40.00').register, true, 'a describable attempt that matches nothing is clear')

  const refused = decide('forty')
  assert.equal(refused.register, false)
  assert.equal(refused.register === false && refused.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
})
