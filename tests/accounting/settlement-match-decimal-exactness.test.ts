import assert from 'node:assert/strict'
import test from 'node:test'

import { probeQuickBooksSettlement, probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import { ledgerAmountMagnitudeBound, parseLedgerAmount, readLedgerStatedAmount } from '@/lib/connectors/xero/invoice-delta'
import {
  classifyLedgerSettlement,
  describeAttempt,
  type AttemptDescription,
  type LedgerSettlementProbe,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { payloadExactAmount, REGISTERED_AMOUNT_DECIMAL_FIELD } from '@/lib/domain/accounting/registered-amount'
import { ledgerMatchEpsilon, toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-78rq — THE RULE THAT DECIDES WHETHER MONEY MAY MOVE A SECOND TIME MEASURES BOTH ITS OPERANDS
 * EXACTLY.
 *
 * Codex, o3d-acctmoney r21 HIGH, and the fourth instance of this shape on this branch. o3d-6yho gave
 * `classifyLedgerSettlement` a band derived from the attempt's own currency — `ledgerMatchEpsilon`,
 * a `Decimal` — and left the two figures it measures as doubles, spending the band back with
 * `toNumber()` to meet them:
 *
 *   Math.abs(record.amount - attempt.amount) <= ledgerMatchEpsilon(attempt.currency).toNumber()
 *
 * THE DIRECTION IS WHAT MAKES IT A HIGH. `ledgerMatchEpsilon`'s own docblock states the asymmetry:
 * too WIDE mistakes someone else's payment for ours and strands a payment visibly, while too NARROW
 * fails to recognise OUR OWN payment's ledger record, returns `clear`, and posts a SECOND payment for
 * a receipt the ledger already holds. Irreversible, and nobody is told.
 *
 * Every test below asserts the PRECONDITION it depends on — that the doubles really do disagree by
 * more than the band, or that the ledger's figure really is one this connector cannot read — so none
 * of them can pass by the arithmetic quietly ceasing to have the property under test.
 */

/* ------------------------------------------------------------------------------------------- *
 * The figures.
 * ------------------------------------------------------------------------------------------- */

/**
 * An ordinary registration, at an ordinary magnitude: a `Decimal(18, 4)` receipt just over a
 * thousand million, and the two-decimal figure the ledger rounded it to. They are EXACTLY the band
 * apart, which is what the band is for — the ledger states money at its own minor unit and IMS may
 * send a finer figure — and their doubles are 0.005000114440917969 apart, which is over it.
 */
const RECEIPT = '1073741824.0050'
const LEDGER_ROUNDED = '1073741824.00'

/**
 * The bd issue's own pair, at 2^45, where one ulp is 0.0078125 and the GBP band is 0.005. Two figures
 * ONE THOUSANDTH apart decode to doubles a whole ulp apart.
 */
const THOUSANDTH_LOW = '35184372088832.0035'
const THOUSANDTH_HIGH = '35184372088832.0045'

/** Codex's figure, and the ledger value it is measured against. See the refusal test for the pair. */
const CODEX_ATTEMPT = '35184372088832.05'
const CODEX_LEDGER_TOKEN = '35184372088832.0546'

const DATE = '2026-08-01'

/** A payload exactly as `registerInvoicePaymentWithLedger` writes one: the wire number AND the exact decimal. */
function registrationPayload(amount: string, currency = 'GBP') {
  return {
    accountingInvoiceId: 'INV-1',
    bankAccountId: 'bank-1',
    paymentId: 'pay-1',
    amount: Number(amount),
    currency,
    [REGISTERED_AMOUNT_DECIMAL_FIELD]: amount,
    paymentDate: DATE,
  }
}

const ledgerHolding = (...amounts: string[]): LedgerSettlementProbe => ({
  ok: true,
  records: amounts.map((a, i) => ({ amount: toDecimal(a), date: DATE, id: `PAY-${i + 1}`, reference: null })),
})

const stated = (amount: string, currency: string | null = 'GBP'): AttemptDescription =>
  ({ amount: toDecimal(amount), currency, date: DATE, marker: null })

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

/**
 * The double a JSON numeric token ACTUALLY decodes to. Written as a parse rather than as a literal
 * because a literal in this file would already have been through the same decode, so the test would
 * be asserting the rounding against itself.
 */
function wire(token: string): number {
  return JSON.parse(`{"v":${token}}`).v as number
}

/* ------------------------------------------------------------------------------------------- *
 * 1. OUR OWN RECORD IS RECOGNISED where the doubles disagree by more than the band.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-78rq] our own payment is recognised where the two doubles differ by MORE than the band', () => {
  // ROUTE: describeAttempt -> payloadExactAmount -> AttemptDescription.amount, then
  //        classifyLedgerSettlement's amount+date arm, banded by ledgerMatchEpsilon('GBP').
  // MUTATION: compare the operands as numbers again —
  //        `Math.abs(record.amount.toNumber() - attempt.amount.toNumber()) <= band.toNumber()` —
  //        and this returns `clear`, which is the verdict that posts a second payment.
  //
  // THE PRECONDITION, ASSERTED: the figures are exactly the band apart, and their doubles are not.
  assert.equal(
    toDecimal(RECEIPT).sub(toDecimal(LEDGER_ROUNDED)).abs().toFixed(),
    '0.005',
    'the receipt and the figure the ledger rounded it to are EXACTLY half a penny apart',
  )
  assert.equal(ledgerMatchEpsilon('GBP').toFixed(), '0.005', 'which is the GBP band, inclusive')
  assert.ok(
    Math.abs(Number(RECEIPT) - Number(LEDGER_ROUNDED)) > 0.005,
    'and the two DOUBLES are 0.005000114440917969 apart, which is outside it — the defect itself',
  )

  const attempt = describeAttempt('INVOICE_PAYMENT', registrationPayload(RECEIPT))
  assert.equal(attempt.amount?.toFixed(), '1073741824.005', 'the attempt carries the payload\'s exact figure')
  assert.equal(attempt.currency, 'GBP', 'and its currency, which sizes the band')

  const verdict = classifyLedgerSettlement(attempt, ledgerHolding(LEDGER_ROUNDED))
  assert.equal(verdict.outcome, 'present', 'this IS the payment IMS already made, and it must not be sent again')
  assert.match(verdict.outcome === 'present' ? verdict.detail : '', /^1073741824\.00 dated 2026-08-01 \(PAY-1\)$/)
})

test('[o3d-78rq] a HISTORICAL row, with no exact decimal beside its number, is recognised too', () => {
  // ROUTE: the same, through `payloadExactAmount`'s fallback arm — the number's OWN decimal reading.
  // MUTATION: fall back to the raw number (`amount: p.amount`) and the comparison is a double
  //        subtraction again, so this returns `clear`.
  //
  // The fix is NOT confined to rows written since o3d-1xq8. `toDecimal(aDouble)` is that double's
  // shortest decimal reading, which is exact where the subtraction of two doubles is not, so a row
  // carrying only the JSON number gets the same guarantee — and gets it without being rewritten.
  const historical = { ...registrationPayload(RECEIPT), [REGISTERED_AMOUNT_DECIMAL_FIELD]: undefined }
  delete (historical as Record<string, unknown>)[REGISTERED_AMOUNT_DECIMAL_FIELD]
  assert.equal(REGISTERED_AMOUNT_DECIMAL_FIELD in historical, false, 'the fixture really is a pre-fix row')
  assert.equal(payloadExactAmount(historical)?.toFixed(), '1073741824.005',
    'and the number alone still reads as the figure, because that is what its shortest reading IS')

  assert.equal(
    classifyLedgerSettlement(describeAttempt('INVOICE_PAYMENT', historical), ledgerHolding(LEDGER_ROUNDED)).outcome,
    'present',
  )
})

test('[o3d-78rq] one THOUSANDTH apart is one whole ulp apart at 2^45, and the figures decide, not the ulp', () => {
  // ROUTE: classifyLedgerSettlement's amount+date arm. The operands are stated directly here — as the
  //        probe and the registration call site now produce them — because at this magnitude the
  //        enqueue's own round-trip gate (`invoicePaymentAmountRoundTrips`) refuses to WRITE a payload
  //        stating THOUSANDTH_HIGH, so there is no payload route to reach it through. The arithmetic
  //        is the subject, and the arithmetic is what this asserts.
  // MUTATION: `Math.abs(record.amount.toNumber() - attempt.amount.toNumber()) <= band.toNumber()` and
  //        the HIGH case returns `clear` while the LOW case still passes — which is exactly how the
  //        defect hid: half the pair looks right.
  //
  // THE PRECONDITION, ASSERTED: the two decode to doubles a whole ulp apart.
  assert.equal(wire(THOUSANDTH_LOW), 35184372088832, `${THOUSANDTH_LOW} decodes to 35184372088832`)
  assert.equal(wire(THOUSANDTH_HIGH), 35184372088832.0078125, `${THOUSANDTH_HIGH} decodes one ulp up`)
  assert.equal(
    toDecimal(THOUSANDTH_HIGH).sub(toDecimal(THOUSANDTH_LOW)).toFixed(),
    '0.001',
    'the two figures are ONE THOUSANDTH apart',
  )
  assert.ok(
    Math.abs(wire(THOUSANDTH_HIGH) - wire(THOUSANDTH_LOW)) > Number(ledgerMatchEpsilon('GBP').toFixed()),
    'and their doubles are 0.0078125 apart, over the 0.005 band — a whole ulp, not a rounding accident',
  )

  // Both are within half a penny of the whole-pound figure the ledger holds, so both ARE that payment.
  for (const ours of [THOUSANDTH_LOW, THOUSANDTH_HIGH]) {
    assert.equal(
      classifyLedgerSettlement(stated(ours), ledgerHolding('35184372088832')).outcome,
      'present',
      `${ours} is within the band of what the ledger holds and must not be sent again`,
    )
  }
  // And the band has not become infinite: a figure a whole penny away is still a different payment.
  assert.equal(
    classifyLedgerSettlement(stated('35184372088832.02'), ledgerHolding('35184372088832')).outcome,
    'clear',
    'two whole pennies apart is a DIFFERENT payment, and this attempt is genuinely unsettled',
  )
})

/* ------------------------------------------------------------------------------------------- *
 * 2. AN UNREADABLE LEDGER AMOUNT WITHHOLDS, and the sentence says which.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-78rq] a ledger figure this connector cannot read exactly WITHHOLDS rather than clearing', async () => {
  // Codex's reproduction, end to end through the Xero probe.
  //
  // ROUTE: probeXeroSettlement -> statedAmount -> readLedgerStatedAmount (the minor-unit scale rule)
  //        -> LedgerSettlementRecord.amount === null with `unreadableAmount` set
  //        -> classifyLedgerSettlement's `record-unmeasurable` arm -> `unknown`, which every caller
  //        treats as `present`.
  // MUTATION: read the amount with the old `num(p.Amount)` — the bare finite check — and the probe
  //        hands back the wire double; the comparison is then 0.0078125 against a 0.005 band and the
  //        verdict is `clear`, which posts a second payment.
  //
  // THE PRECONDITION, ASSERTED: the token decodes to a double whose own decimal reading has THREE
  // decimals, which is not a figure a two-decimal currency can state.
  const ledgerWire = wire(CODEX_LEDGER_TOKEN)
  assert.equal(toDecimal(ledgerWire).toFixed(), '35184372088832.055', 'the double reads back at three decimals')
  assert.equal(readLedgerStatedAmount(ledgerWire, 'GBP'), null, 'so GBP cannot state it, and it is refused')
  assert.ok(
    Math.abs(ledgerWire - Number(CODEX_ATTEMPT)) > 0.005,
    'the precondition for the OLD verdict: the two doubles are 0.0078125 apart, outside the band',
  )
  assert.equal(
    toDecimal(ledgerWire).sub(toDecimal(CODEX_ATTEMPT)).abs().toFixed(),
    '0.005',
    'while the FIGURES are exactly the band apart — so `clear` was wrong on the ledger\'s own reading too',
  )

  const { get } = ledgerDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        CurrencyCode: 'GBP',
        Total: ledgerWire,
        AmountDue: 0,
        AmountPaid: ledgerWire,
        AmountCredited: 0,
        Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: ledgerWire }],
      }],
    },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, true, 'the probe still ANSWERS — the completeness cross-check is untouched by this')
  assert.deepEqual(probe.ok ? probe.records : null, [{
    amount: null,
    unreadableAmount: '35184372088832.055',
    date: '2026-08-01',
    id: 'PAY-1',
    reference: null,
  }], 'and the record carries the refusal AND the figure that was refused')

  const verdict = classifyLedgerSettlement(describeAttempt('INVOICE_PAYMENT', registrationPayload(CODEX_ATTEMPT)), probe)
  assert.equal(verdict.outcome, 'unknown', 'never `clear`: a figure IMS cannot read cannot rule this attempt out')
  assert.equal(verdict.outcome === 'unknown' ? verdict.cause : null, 'record-unmeasurable')

  // AND THE OPERATOR IS TOLD WHICH FACT THIS IS. A hold whose reason reads like "the document looks
  // unpaid" invites exactly the action that posts the second payment.
  const reason = verdict.outcome === 'unknown' ? verdict.reason : ''
  assert.match(reason, /35184372088832\.055/, 'the sentence names the figure the ledger stated')
  assert.match(reason, /PAY-1/, 'and which settlement it was, so it can be found')
  assert.match(reason, /cannot read as an exact GBP amount/, 'and says the READING is what failed')
  assert.match(reason, /NOT that the document is unpaid/, 'and says plainly what it does not mean')
})

test('[o3d-78rq] and the two unmeasurable causes are told apart — no amount at all still reads as before', () => {
  // ROUTE: the same `record-unmeasurable` arm, the arm without `unreadableAmount`.
  // MUTATION: drop the conditional and always print the refusal sentence, and a settlement on which
  //        the ledger stated NO amount is described as one whose figure could not be read — a
  //        sentence that sends an operator looking for a number that is not there.
  const noAmount = classifyLedgerSettlement(stated('10'), {
    ok: true,
    records: [{ amount: null, date: DATE, id: 'PAY-1', reference: null }],
  })
  assert.equal(noAmount.outcome, 'unknown')
  assert.equal(noAmount.outcome === 'unknown' ? noAmount.cause : null, 'record-unmeasurable')
  assert.match(noAmount.outcome === 'unknown' ? noAmount.reason : '', /whose amount or date could not be read/)
  assert.doesNotMatch(noAmount.outcome === 'unknown' ? noAmount.reason : '', /cannot read as an exact/)
})

test('[o3d-78rq] a ledger amount too large for its own minor unit to survive the decode is refused too', async () => {
  // ROUTE: probeXeroSettlement -> statedAmount -> readLedgerStatedAmount's MAGNITUDE arm.
  // MUTATION: drop the `ledgerAmountMagnitudeBound` line from `readLedgerStatedAmount` and this
  //        record is admitted at a magnitude where two figures one penny apart share a double, so the
  //        comparison below decides on a figure that is not provably the one the ledger stated.
  //
  // THE PRECONDITION, ASSERTED: the value is at the bound, and one below it is not.
  assert.equal(ledgerAmountMagnitudeBound('GBP'), 70368744177664, '2^46 for a two-decimal currency')
  assert.equal(readLedgerStatedAmount(70368744177664, 'GBP'), null)
  assert.equal(readLedgerStatedAmount(35184372088832, 'GBP')?.toFixed(), '35184372088832',
    'and the binade below it is read, so the refusal is a bound and not a blanket')

  const { get } = ledgerDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        CurrencyCode: 'GBP',
        Total: 70368744177664,
        AmountDue: 0,
        AmountPaid: 70368744177664,
        AmountCredited: 0,
        Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 70368744177664 }],
      }],
    },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok && probe.records[0]?.amount, null)
  assert.equal(probe.ok && probe.records[0]?.unreadableAmount, '70368744177664')
})

/* ------------------------------------------------------------------------------------------- *
 * 3. THE ORDINARY CASE IS UNTOUCHED — the refusal is not over-eager.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-78rq] an ordinary settlement is read, matched, and an ordinary non-match still CLEARS', async () => {
  // The cost of the refusal arm is real — `unknown` is treated as `present`, so an over-eager refusal
  // withholds FIRST posts, from documents nothing has ever been sent to. This is the test that the
  // rule refuses only what it says it refuses.
  //
  // ROUTE: probeXeroSettlement -> statedAmount -> readLedgerStatedAmount, then the match arm.
  // MUTATION: size the scale rule with `COARSEST_SUPPORTED_MINOR_UNITS` instead of the document's own
  //        currency and the KWD case below refuses a payment the ledger states perfectly well.
  const { get } = ledgerDouble({
    'Invoices/inv-1': {
      Invoices: [{
        InvoiceID: 'inv-1',
        CurrencyCode: 'GBP',
        Total: 35,
        AmountDue: 0,
        AmountPaid: 35,
        AmountCredited: 0,
        Payments: [
          { PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 10 },
          { PaymentID: 'PAY-2', Date: '2026-08-01T00:00:00', Amount: 25 },
        ],
      }],
    },
  })
  const probe = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.ok ? probe.records.map((r) => r.amount?.toFixed() ?? null) : null, ['10', '25'],
    'both ordinary figures are READ — none of this refuses money a ledger can state')

  assert.equal(
    classifyLedgerSettlement(describeAttempt('INVOICE_PAYMENT', registrationPayload('10.00')), probe).outcome,
    'present',
    'the payment IMS made is found',
  )
  assert.equal(
    classifyLedgerSettlement(describeAttempt('INVOICE_PAYMENT', registrationPayload('40.00')), probe).outcome,
    'clear',
    'and a figure nothing on the document matches is positively clear — a first post is NOT withheld',
  )

  // A three-decimal currency states three decimals, and that is not "finer than its currency".
  assert.equal(readLedgerStatedAmount(10.001, 'KWD')?.toFixed(), '10.001', 'one fil, read')
  assert.equal(readLedgerStatedAmount(10.001, 'GBP'), null, 'and the identical figure refused in GBP')
  // An unstated currency resolves through `ledgerMinorUnits(null)` exactly as every other ledger
  // reading in this repository does — four places, the finest supported.
  assert.equal(readLedgerStatedAmount(10.0001, null)?.toFixed(), '10.0001')
  assert.equal(readLedgerStatedAmount(10.00001, null), null)
})

test('[o3d-78rq] the QuickBooks probe reads its applied amounts through the SAME rule', async () => {
  // Both connectors' probes needed it: the QuickBooks applied amount is a SUM of a payment's lines,
  // which is the one place a figure can stop being the one the ledger stated without any single
  // field being odd.
  //
  // ROUTE: probeQuickBooksSettlement -> qboAmountAppliedTo -> statedAmount -> readLedgerStatedAmount.
  // MUTATION: leave `amount: qboAmountAppliedTo(...)` as the bare number and the second case below is
  //        admitted as a figure whose decimal reading nothing establishes.
  const readable = ledgerDouble({
    'invoice/inv-1': { Invoice: { LinkedTxn: [{ TxnId: '55', TxnType: 'Payment' }], CurrencyRef: { value: 'GBP' }, TotalAmt: 10, Balance: 0 } },
    'payment/55': {
      Payment: { TxnDate: '2026-08-01', Line: [{ Amount: 10, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] }] },
    },
  })
  const ok = await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, readable.get)
  assert.deepEqual(ok.ok ? ok.records : null,
    [{ amount: toDecimal(10), date: '2026-08-01', id: '55', reference: null }],
    'the ordinary applied amount is read exactly, and carries no refusal')

  const unreadable = ledgerDouble({
    'invoice/inv-1': { Invoice: { LinkedTxn: [{ TxnId: '55', TxnType: 'Payment' }], CurrencyRef: { value: 'GBP' }, TotalAmt: 10.005, Balance: 0 } },
    'payment/55': {
      Payment: { TxnDate: '2026-08-01', Line: [{ Amount: 10.005, LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }] }] },
    },
  })
  const refused = await probeQuickBooksSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, unreadable.get)
  assert.deepEqual(refused.ok ? refused.records : null,
    [{ amount: null, unreadableAmount: '10.005', date: '2026-08-01', id: '55', reference: null }],
    'a three-decimal figure on a two-decimal document is refused here exactly as it is on the Xero side')
  assert.equal(
    classifyLedgerSettlement(describeAttempt('INVOICE_PAYMENT', registrationPayload('10.00')), refused).outcome,
    'unknown',
    'and the classifier withholds on it',
  )
})

/* ------------------------------------------------------------------------------------------- *
 * 4. THE TWO READERS CANNOT DRIFT.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-78rq] parseLedgerAmount and readLedgerStatedAmount admit exactly the same values', () => {
  // The rules moved into `readLedgerStatedAmount` and `parseLedgerAmount` became a conversion on top
  // of it. That is only safe while there is ONE admission — a second copy of a fail-safe direction is
  // a second chance for one of them to be edited into the lenient reading, which is the failure mode
  // this branch has now closed five times.
  //
  // ROUTE: both exported readers, over the table each round of o3d-psrx pinned.
  // MUTATION: reinstate the rules inside `parseLedgerAmount` and drop one of them (say the scale
  //        rule) and the `0.005` rows below disagree.
  const cases: Array<[unknown, string | null, boolean]> = [
    [10, 'GBP', true],
    ['10', 'GBP', true],
    [0.005, 'GBP', false],
    ['0.005', 'GBP', false],
    [0.001, 'KWD', true],
    ['0.0001', 'CLF', true],
    [123456789.99, 'JPY', false],
    [70368744177664, 'GBP', false],
    [35184372088832, 'GBP', true],
    ['1649267441664', 'CLF', true],
    ['0x64', 'GBP', false],
    ['35184372088832.003', 'GBP', false],
    [Number.POSITIVE_INFINITY, 'GBP', false],
    [null, 'GBP', false],
    [{ Amount: 10 }, 'GBP', false],
  ]
  let reached = 0
  for (const [value, currency, admitted] of cases) {
    reached += 1
    assert.equal(readLedgerStatedAmount(value, currency) !== null, admitted,
      `readLedgerStatedAmount(${JSON.stringify(value)}, ${currency})`)
    assert.equal(parseLedgerAmount(value, currency) !== null, admitted,
      `parseLedgerAmount(${JSON.stringify(value)}, ${currency})`)
  }
  assert.equal(reached, cases.length, 'every row was actually asked')

  // The one place they legitimately differ, stated rather than left to be discovered: the STRING arm's
  // round trip belongs to the NUMBER `parseLedgerAmount` hands out, not to the figure the ledger
  // stated, so a grammatical figure that cannot survive `toNumber()` is a Decimal and not a number.
  const beyondTheSignificand = '9007199254740993'
  assert.equal(toDecimal(beyondTheSignificand).decimalPlaces(), 0, 'a whole number, so the scale rule admits it')
  assert.equal(parseLedgerAmount(beyondTheSignificand, null), null,
    'it has no honest number — `toNumber()` reads it as ...992')
  assert.equal(readLedgerStatedAmount(beyondTheSignificand, null)?.toFixed(), beyondTheSignificand,
    'but it is a figure, and the figure is exactly what it says')
})
