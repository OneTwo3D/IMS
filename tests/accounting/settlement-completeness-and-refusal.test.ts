import assert from 'node:assert/strict'
import test from 'node:test'

import { probeQuickBooksSettlement, probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import {
  classifyLedgerSettlement,
  describeAttempt,
  type AttemptDescription,
  type LedgerSettlementProbe,
  type LedgerSettlementRecord,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { decideInvoicePaymentRegistration } from '@/lib/domain/accounting/invoice-payment-registration'
import {
  readPayloadRegisteredAmount,
  REGISTERED_AMOUNT_DECIMAL_FIELD,
} from '@/lib/domain/accounting/registered-amount'
import {
  aggregatePaymentSyncRows,
  settlementStatus,
  syncRowSettledAmount,
  type PaymentSyncRow,
} from '@/lib/domain/accounting/settlement-status'
import { ledgerAmountEpsilon, toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-r948 — THE NINTH SITE, AND THE REFUSAL THAT HAD BECOME A FALLBACK.
 *
 * Three findings from the Codex pass on o3d-78rq, all of the same family: a rule this branch wrote
 * down and then broke one layer away from where it is stated.
 *
 *   HIGH 1  the four COMPLETENESS cross-checks in the settlement probes carried a flat `0.005` over
 *           wire doubles. o3d-78rq named this as the ninth site and filed it rather than folding it
 *           in. It is reachable at ONE MINOR UNIT: a KWD invoice reporting `AmountPaid` 0.001 with an
 *           omitted `Payments` collection had the whole fil swallowed, answered "everything is
 *           accounted for", and the classifier built `clear` out of an EMPTY record list — which is
 *           what authorises a second payment.
 *   HIGH 2  `payloadRegisteredAmount` answers null for three different facts and the two callers
 *           holding a lossy number beside it took that number for two of them.
 *   MEDIUM  `classifyLedgerSettlement` refused on an unreadable half of a record without asking
 *           whether the OTHER half had already proved the record unrelated.
 *
 * Every test states the PRECONDITION it turns on, so none of them can pass by the property under
 * test quietly ceasing to hold.
 */

const DATE = '2026-08-01'

type Call = { path: string }
function ledgerDouble(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const get = async <T>(path: string) => {
    calls.push({ path })
    const body = responses[path]
    if (body === undefined) return { ok: false, status: 404, error: 'not stubbed' }
    return { ok: true, status: 200, data: body as T }
  }
  return { get, calls }
}

const xeroInvoice = (body: Record<string, unknown>) =>
  ledgerDouble({ 'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', ...body }] } }).get

const probeInvoice = (get: ReturnType<typeof xeroInvoice>) =>
  probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)

const reasonOf = (probe: LedgerSettlementProbe) => (probe.ok === false ? probe.reason : '')

/* ------------------------------------------------------------------------------------------- *
 * 1. THE COMPLETENESS BAND IS THE DOCUMENT'S OWN MINOR UNIT (Codex HIGH 1).
 * ------------------------------------------------------------------------------------------- */

test('[o3d-r948] a KWD invoice ONE FIL short of its stated settlement does not read as complete', async () => {
  // THE LOAD-BEARING CASE, END TO END: the ledger states 0.001 paid and returns no payment for it.
  //
  // ROUTE: probeXeroSettlement's `AmountPaid` cross-check, banded by completenessBand('KWD'),
  //        then classifyLedgerSettlement over the probe it returns.
  // MUTATION: return a flat `toDecimal('0.005')` from `completenessBand` and the fil is swallowed —
  //        the probe answers ok:true with an EMPTY record list and the classifier answers `clear`.

  // THE PRECONDITION, both halves. One fil is a whole minor unit in KWD, and it is INSIDE the flat
  // half-penny these checks used to carry — so nothing below can pass on the old band.
  assert.equal(ledgerAmountEpsilon('KWD').toFixed(), '0.0005', 'half one fil is the KWD band')
  assert.ok(toDecimal('0.001').lt(toDecimal('0.005')), 'and a whole fil sits inside the band that was there')

  const short = await probeInvoice(xeroInvoice({ CurrencyCode: 'KWD', AmountPaid: 0.001 }))
  assert.equal(short.ok, false, 'the shortfall is a whole minor unit and the picture is incomplete')
  assert.match(reasonOf(short), /0\.001 paid against this document but returned no payments/)

  // ...and no `clear` can be built from it. This is the end the finding is about: `clear` is what
  // authorises a money post, and it was being manufactured out of a collection Xero never sent.
  const verdict = classifyLedgerSettlement(
    describeAttempt('INVOICE_PAYMENT', { amount: 0.001, currency: 'KWD', paymentDate: DATE }),
    short,
  )
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'probe-unreadable')

  // THE DISCRIMINATING HALF. The identical figures in GBP are a tenth of a penny — genuinely noise —
  // and still read as complete. The band is derived from the document, not tightened for everyone.
  const gbp = await probeInvoice(xeroInvoice({ CurrencyCode: 'GBP', AmountPaid: 0.001 }))
  assert.deepEqual(gbp, { ok: true, records: [] })
  assert.equal(
    classifyLedgerSettlement(
      describeAttempt('INVOICE_PAYMENT', { amount: 40, currency: 'GBP', paymentDate: DATE }),
      gbp,
    ).outcome,
    'clear',
    'and a first post against an ordinary GBP document is NOT withheld',
  )
})

test('[o3d-r948] all four completeness checks, on both connectors, are banded by the document currency', async () => {
  // The finding is about the RULE, not about one branch of it: a flat band left in any of the four
  // leaves the same false `clear` reachable through a different document shape.
  //
  // Each pair below states the same figures twice — once in KWD, where the gap is a whole minor unit,
  // and once in GBP, where it is noise. The GBP arm is the precondition: it proves the gap is inside
  // the old flat band, so the KWD arm can only be refusing on the currency-derived one.
  // MUTATION (any one of them): restore `0.005` at that branch and its KWD arm answers ok:true.

  // (1) ROUTE: the credit-note branch — `Total - RemainingCredit` against the Allocations collection.
  const creditNote = (currency: string) => ledgerDouble({
    'CreditNotes/cn-1': {
      CreditNotes: [{
        CreditNoteID: 'cn-1',
        CurrencyCode: currency,
        Total: 10,
        RemainingCredit: 9.998,
        Allocations: [{ Amount: 0.001, Date: DATE, Invoice: { InvoiceID: 'inv-1' } }],
      }],
    },
  }).get
  const probeNote = (currency: string) => probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { accountingInvoiceId: 'inv-1', creditNoteId: 'cn-1' } },
    creditNote(currency),
  )
  assert.equal((await probeNote('GBP')).ok, true, 'the precondition: two fils of GBP is noise')
  const noteShort = await probeNote('KWD')
  assert.equal(noteShort.ok, false)
  assert.match(reasonOf(noteShort), /0\.002 of this credit note already applied but returned allocations totalling 0\.001/)

  // (2) ROUTE: the invoice `AmountPaid` cross-check — covered end to end above, and re-stated here
  //     with a NON-EMPTY collection so it is the arithmetic, not the empty list, that refuses.
  const paidVsList = (currency: string) => probeInvoice(xeroInvoice({
    CurrencyCode: currency,
    AmountPaid: 0.002,
    Payments: [{ PaymentID: 'PAY-1', Date: DATE, Amount: 0.001 }],
  }))
  assert.equal((await paidVsList('GBP')).ok, true, 'the precondition')
  const paidShort = await paidVsList('KWD')
  assert.equal(paidShort.ok, false)
  assert.match(reasonOf(paidShort), /0\.002 paid against this document but returned payments totalling 0\.001/)

  // (3) ROUTE: the shape-independent settlement accounting — `Total - AmountDue` against everything
  //     the probe actually read. `AmountPaid` agrees with the collection here, so ONLY this check can
  //     be the one that fires.
  const settledVsExplained = (currency: string) => probeInvoice(xeroInvoice({
    CurrencyCode: currency,
    Total: 10.002,
    AmountDue: 10,
    AmountPaid: 0.001,
    AmountCredited: 0,
    Payments: [{ PaymentID: 'PAY-1', Date: DATE, Amount: 0.001 }],
  }))
  assert.equal((await settledVsExplained('GBP')).ok, true, 'the precondition')
  const settledShort = await settledVsExplained('KWD')
  assert.equal(settledShort.ok, false)
  assert.match(reasonOf(settledShort), /0\.002 already settled against this document but only 0\.001 of it is accounted for/)

  // (4) ROUTE: the QuickBooks settlement accounting — `TotalAmt - Balance` against the payment lines
  //     this probe read, with the currency out of the document's own `CurrencyRef`.
  const qbo = (currency: string) => ledgerDouble({
    'bill/bill-1': {
      Bill: {
        LinkedTxn: [{ TxnId: '9', TxnType: 'BillPaymentCheck' }],
        CurrencyRef: { value: currency },
        TotalAmt: 10.002,
        Balance: 10,
      },
    },
    'billpayment/9': {
      BillPayment: { TxnDate: DATE, Line: [{ Amount: 0.001, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] }] },
    },
  }).get
  const probeBill = (currency: string) => probeQuickBooksSettlement(
    { type: 'BILL_PAYMENT', payload: { accountingInvoiceId: 'bill-1' } },
    qbo(currency),
  )
  assert.equal((await probeBill('GBP')).ok, true, 'the precondition')
  const billShort = await probeBill('KWD')
  assert.equal(billShort.ok, false)
  assert.match(reasonOf(billShort), /0\.002 already applied to this bill but only 0\.001 of it is accounted for/)
})

test('[o3d-r948] the ordinary two-decimal document is unmoved, and an UNSTATED currency is stricter', async () => {
  // The band is HALF one minor unit, which is 0.005 exactly in every two-decimal currency — so the
  // ordinary Xero and QuickBooks document reads exactly as it always has. It is not "strictly below
  // one minor unit" taken as loosely as possible: a shortfall of four thousandths of a pound is still
  // inside the band, and six thousandths is still outside it.
  //
  // ROUTE: the `AmountPaid` cross-check, banded by completenessBand.
  // MUTATION: band at `ledgerAmountEpsilon(null)` regardless of currency and the 0.004 GBP arm
  //        refuses, which would refuse ordinary documents nothing is wrong with.
  assert.equal(ledgerAmountEpsilon('GBP').toFixed(), '0.005', 'the precondition: GBP is unchanged')
  const gbp = (paid: number) => probeInvoice(xeroInvoice({
    CurrencyCode: 'GBP',
    AmountPaid: paid,
    Payments: [{ PaymentID: 'PAY-1', Date: DATE, Amount: 100 }],
  }))
  assert.equal((await gbp(100.004)).ok, true, 'four thousandths of a pound is inside the band, as it always was')
  assert.equal((await gbp(100.006)).ok, false, 'and six thousandths is outside it, as it always was')

  // AN UNSTATED CURRENCY TAKES THE STRICTEST BAND, which is `ledgerAmountEpsilon`'s documented
  // direction. Too WIDE a band here hides an omission behind a `clear`, so the null arm must not
  // widen the way `ledgerMatchEpsilon`'s deliberately does.
  //
  // ROUTE: ledgerCurrencyCode(undefined) -> completenessBand(null).
  // MUTATION: resolve a null currency through `ledgerMatchEpsilon` (0.005) and this reads complete.
  assert.equal(ledgerAmountEpsilon(null).toFixed(), '0.00005', 'the precondition: the null band is the finest')
  const unstated = await probeInvoice(xeroInvoice({
    AmountPaid: 100.004,
    Payments: [{ PaymentID: 'PAY-1', Date: DATE, Amount: 100 }],
  }))
  assert.equal(unstated.ok, false, 'a document that does not say what it is stated in is read strictly')
})

test('[o3d-r948] the completeness arithmetic is exact: a sum of wire doubles no longer decides it', async () => {
  // The band is only half the finding. The four checks added their terms with `+`, and at magnitude a
  // double addition can round UPWARD past the shortfall it is meant to expose — the sum then
  // "explains" money the collection does not contain.
  //
  // ROUTE: probeXeroSettlement's `AmountPaid` cross-check, over `sumExact` rather than a `+` reduce.
  // MUTATION: sum `wireAmounts` with `.reduce((t, a) => t + a.toNumber(), 0)` and this reads complete.
  //
  // The magnitude is 2^46, where neighbouring doubles are 0.015625 apart — so adding a penny to it
  // rounds UP by more than half of that, four times over.
  const PAYMENTS = [70368744177664, 0.01, 0.01, 0.01, 0.01]
  const AMOUNT_PAID = 70368744177664.0625

  // THE PRECONDITION, and it is the whole test: added as DOUBLES these five payments reach exactly
  // the figure Xero states as paid, so the old arithmetic saw no shortfall whatsoever. Added exactly
  // they are two pence short of it, which is four times the GBP band.
  const asDoubles = PAYMENTS.reduce((total, a) => total + a, 0)
  assert.equal(asDoubles, AMOUNT_PAID, 'as doubles, the collection accounts for the stated total EXACTLY')
  const asDecimals = PAYMENTS.reduce((total, a) => total.add(toDecimal(a)), toDecimal(0))
  assert.equal(asDecimals.toFixed(), '70368744177664.04', 'exactly, they are two pence short of it')
  assert.ok(toDecimal(AMOUNT_PAID).sub(asDecimals).gt(ledgerAmountEpsilon('GBP')), 'and that is outside the band')

  const probe = await probeInvoice(xeroInvoice({
    CurrencyCode: 'GBP',
    AmountPaid: AMOUNT_PAID,
    Payments: PAYMENTS.map((Amount, i) => ({ PaymentID: `PAY-${i + 1}`, Date: DATE, Amount })),
  }))
  assert.equal(probe.ok, false, 'the shortfall the double addition rounded away is now visible')
  assert.match(reasonOf(probe), /70368744177664\.06 paid against this document but returned payments totalling 70368744177664\.04/)
})

test('[o3d-r948] a refusal names the figure at its OWN scale — a fil is not 0.00', () => {
  // A completeness refusal that rounds to two places prints the shortfall it is about as `0.00`,
  // which reads to an operator as an arithmetic fault rather than as the missing payment it is.
  //
  // ROUTE: the probe refusals, through `formatLedgerMoney`.
  // MUTATION: restore `.toFixed(2)` at any of them and the sentence says `0.00`.
  //
  // Asserted on the reason built above rather than re-fetched: this is the same string, and stating
  // it here is what pins the RULE rather than one branch's wording.
  return probeInvoice(xeroInvoice({ CurrencyCode: 'KWD', AmountPaid: 0.001 })).then((probe) => {
    assert.match(reasonOf(probe), /reports 0\.001 paid/)
    assert.doesNotMatch(reasonOf(probe), /reports 0\.00 paid/)
  })
})

/* ------------------------------------------------------------------------------------------- *
 * 2. THE TRI-STATE: A REFUSAL IS NOT A SILENCE (Codex HIGH 2).
 * ------------------------------------------------------------------------------------------- */

const syncedRow = (over: Partial<PaymentSyncRow> = {}): PaymentSyncRow =>
  ({ status: 'SYNCED', externalTransactionId: 'PAY-1', ...over })

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
    paymentDate: DATE,
    paymentId: 'pay-old',
    couldHaveReachedLedger: true,
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
    ledgerSettlements: [{ amount: toDecimal('99.00'), date: DATE, reference: null }],
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

/* ------------------------------------------------------------------------------------------- *
 * 3. WITHHOLD ONLY WHILE THE RECORD IS STILL A CANDIDATE (Codex MEDIUM).
 * ------------------------------------------------------------------------------------------- */

const attemptFor = (amount: string, marker: string | null = null): AttemptDescription =>
  ({ amount: toDecimal(amount), currency: 'GBP', date: DATE, marker })

const holding = (records: LedgerSettlementRecord[]): LedgerSettlementProbe => ({ ok: true, records })

test('[o3d-r948] a record proved unrelated by the half that IS readable does not withhold a first payment', () => {
  // Withholding is the safe direction only while the record could actually be ours. The match rule is
  // a CONJUNCTION — amount within the band AND the same date — so either readable half failing means
  // this record is somebody else's, and its unreadable half decides nothing.
  //
  // ROUTE: classifyLedgerSettlement's record loop, the `amountRulesItOut || dateRulesItOut` skip.
  // MUTATION: delete that `continue` and both `clear` assertions below read `unknown`.

  // Unreadable amount, and a date that is not this attempt's.
  const otherDay = holding([{ amount: null, unreadableAmount: '10.005', date: '2026-01-01', id: 'PAY-9', reference: null }])
  assert.equal(classifyLedgerSettlement(attemptFor('10.00'), otherDay).outcome, 'clear')

  // Unreadable date, and an amount nothing near this attempt's.
  const otherAmount = holding([{ amount: toDecimal('999.00'), date: null, id: 'PAY-8', reference: null }])
  assert.equal(classifyLedgerSettlement(attemptFor('10.00'), otherAmount).outcome, 'clear')

  // THE DISCRIMINATING HALF, and it is what stops this being a loosening: the SAME unreadable record
  // on the attempt's OWN date is still a candidate, and still withholds.
  const sameDay = holding([{ amount: null, unreadableAmount: '10.005', date: DATE, id: 'PAY-9', reference: null }])
  const held = classifyLedgerSettlement(attemptFor('10.00'), sameDay)
  assert.equal(held.outcome, 'unknown')
  assert.equal(held.outcome === 'unknown' && held.cause, 'record-unmeasurable')

  // ...and an unreadable date beside an amount that IS within the band withholds too.
  const nearAmount = holding([{ amount: toDecimal('10.00'), date: null, id: 'PAY-7', reference: null }])
  assert.equal(classifyLedgerSettlement(attemptFor('10.00'), nearAmount).outcome, 'unknown')
})

test('[o3d-r948] the MARK still identifies our own settlement whatever its date says', () => {
  // The residual risk of the refinement is a settlement of OURS whose date was edited in the ledger.
  // That risk is not new — a record with both halves readable and a different date is skipped today —
  // and it is the risk the mark exists to retire. The mark is checked before the loop, so the
  // refinement cannot skip past a record that carries it.
  //
  // ROUTE: classifyLedgerSettlement's marker pass, ahead of the record loop.
  // MUTATION: move the marker pass below the loop and this reads `clear` — the record is skipped by
  //        its date before its reference is ever looked at.
  const marked = holding([{
    amount: null, unreadableAmount: '10.005', date: '2026-01-01', id: 'PAY-9', reference: 'IMS-abc123abc123',
  }])
  const verdict = classifyLedgerSettlement(attemptFor('10.00', 'IMS-abc123abc123'), marked)
  assert.equal(verdict.outcome, 'present')
  assert.equal(verdict.outcome === 'present' && verdict.matchedId, 'PAY-9')
})
