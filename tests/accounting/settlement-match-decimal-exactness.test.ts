import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { probeQuickBooksSettlement, probeXeroSettlement } from '@/lib/connectors/accounting-settlement-probe'
import { ledgerAmountMagnitudeBound, parseLedgerAmount, readLedgerStatedAmount } from '@/lib/connectors/xero/invoice-delta'
import {
  classifyLedgerSettlement,
  describeAttempt,
  type AttemptDescription,
  type LedgerSettlementProbe,
  type LedgerSettlementRecord,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { payloadExactAmount, REGISTERED_AMOUNT_DECIMAL_FIELD } from '@/lib/domain/accounting/registered-amount'
import { ledgerAmountEpsilon, ledgerMatchEpsilon, toDecimal } from '@/lib/domain/math/decimal'

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
  // MUTATION (either kills it): return `null` from that fallback instead of `toDecimal(p.amount)`,
  //        and this row becomes undescribable; or compare the operands as numbers again, and it
  //        returns `clear`.
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
  // MUTATION: drop the minor-unit scale rule from `readLedgerStatedAmount` — which is the whole of
  //        what the old bare `num(p.Amount)` did — and the probe hands the figure back as though it
  //        were stateable, so this record is no longer a refusal and the verdict is not `unknown`.
  //        (With the OLD number comparison behind it the verdict was `clear` outright: the two
  //        doubles are 0.0078125 apart against a 0.005 band, and a second payment posts.)
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
  assert.match(reason, /cannot read as an exact amount in GBP/, 'and says the READING is what failed')
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
  // MUTATION (either kills it): size the scale rule with a fixed `'GBP'` instead of the currency it
  //        is asked about, and the KWD case below refuses a payment the ledger states perfectly well;
  //        or drop the scale rule entirely, and the GBP three-decimal figure is admitted.
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

test('[o3d-78rq] each Xero document is read in ITS OWN currency, on both branches of the probe', async () => {
  // The currency is not decoration: it is what decides whether a figure is stateable, and a fil is a
  // real payment. Reading every document as GBP would refuse both settlements below and withhold two
  // documents nothing has ever been sent to.
  //
  // ROUTE: probeXeroSettlement -> statedAmount(_, ledgerCurrencyCode(invoice.CurrencyCode)) on the
  //        payments branch, and ledgerCurrencyCode(note.CurrencyCode) on the allocations branch.
  // MUTATION: hard-code `'GBP'` in either `statedAmount(...)` call in the probe and that branch's
  //        assertion below fails — the fil reads as a figure IMS will not measure.
  assert.equal(readLedgerStatedAmount(10.001, 'GBP'), null,
    'the precondition: this figure is refused in GBP, so the assertions below can only pass on KWD')

  const payments = ledgerDouble({
    'Invoices/inv-kwd': {
      Invoices: [{
        InvoiceID: 'inv-kwd',
        CurrencyCode: 'KWD',
        Total: 10.001,
        AmountDue: 0,
        AmountPaid: 10.001,
        AmountCredited: 0,
        Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 10.001 }],
      }],
    },
  })
  const paid = await probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-kwd' } }, payments.get)
  assert.deepEqual(paid.ok ? paid.records.map((r) => r.amount?.toFixed() ?? null) : null, ['10.001'],
    'one fil is a payment the ledger can state, and this probe reads it')

  const allocations = ledgerDouble({
    'CreditNotes/cn-1': {
      CreditNotes: [{
        CreditNoteID: 'cn-1',
        CurrencyCode: 'KWD',
        Total: 10.001,
        RemainingCredit: 0,
        Allocations: [{ Amount: 10.001, Date: '2026-08-01T00:00:00', Invoice: { InvoiceID: 'inv-kwd' } }],
      }],
    },
  })
  const allocated = await probeXeroSettlement(
    { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', payload: { accountingInvoiceId: 'inv-kwd', creditNoteId: 'cn-1' } },
    allocations.get,
  )
  assert.deepEqual(allocated.ok ? allocated.records.map((r) => r.amount?.toFixed() ?? null) : null, ['10.001'],
    'and the credit-note branch reads the NOTE\'s currency, which is the one its allocations are in')
})

test('[o3d-78rq] the QuickBooks probe reads its applied amounts through the SAME rule', async () => {
  // Both connectors' probes needed it: the QuickBooks applied amount is a SUM of a payment's lines,
  // which is the one place a figure can stop being the one the ledger stated without any single
  // field being odd.
  //
  // ROUTE: probeQuickBooksSettlement -> qboAmountAppliedTo -> statedAmount -> readLedgerStatedAmount,
  //        with the currency read from the DOCUMENT's own `CurrencyRef`.
  // MUTATION (either kills it): read the applied amount against a fixed `'KWD'` rather than the
  //        document's currency, and the three-decimal figure is admitted; or drop the scale rule from
  //        `readLedgerStatedAmount`, and it is admitted for every currency.
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
  // MUTATION: reinstate a number arm inside `parseLedgerAmount` that applies the magnitude bound and
  //        not the scale rule — the exact shape r18 found — and the `0.005` row disagrees. Dropping
  //        either rule from `readLedgerStatedAmount` fails it from the other side.
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

/* --- o3d-r948 helpers, for the completeness and unrelated-record sections below. --- */

const xeroInvoice = (body: Record<string, unknown>) =>
  ledgerDouble({ 'Invoices/inv-1': { Invoices: [{ InvoiceID: 'inv-1', ...body }] } }).get

const probeInvoice = (get: ReturnType<typeof xeroInvoice>) =>
  probeXeroSettlement({ type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: 'inv-1' } }, get)

const reasonOf = (probe: LedgerSettlementProbe) => (probe.ok === false ? probe.reason : '')

const attemptFor = (amount: string, marker: string | null = null): AttemptDescription =>
  ({ amount: toDecimal(amount), currency: 'GBP', date: DATE, marker })

const holding = (records: LedgerSettlementRecord[]): LedgerSettlementProbe => ({ ok: true, records })

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
 * 3. A RECORD LEAVES THE MATCH ONLY ON AN IMMUTABLE IDENTITY (r3, Codex HIGH).
 *
 * r2 skipped a record whose readable half already differed from the attempt. Amounts and dates are
 * EDITABLE in both ledgers -- the premise this whole module is built on -- so a differing readable
 * half is not proof the record is somebody else's, and turning it into one turned an ambiguous
 * settlement into permission to post again. The exclusion is now the ledger's own id, matched
 * against what IMS recorded when a DIFFERENT row posted it.
 * ------------------------------------------------------------------------------------------- */

test('[o3d-r948 r3] a differing but UNREADABLE half does not clear the record it cannot measure', () => {
  // THE FINDING, directly. r2 read a readable date that is not this attempt's as proof the record
  // belongs to someone else, and skipped it even though its amount was unreadable. It is not proof:
  // a payment of OURS whose date was corrected in Xero after we made it looks exactly like this, and
  // skipping the only record on the document produced `clear` -- which authorises a second payment.
  //
  // ROUTE: classifyLedgerSettlement's record loop, reached from every money fence
  //        (authoriseMoneyPost, ledgerClearsFollowUpRevival, decideInvoicePaymentRegistration).
  // MUTATION: restore r2's `if (amountRulesItOut || dateRulesItOut) continue` ahead of the
  //        unmeasurable check and every assertion below reads `clear`.

  // Unreadable amount, and a date that is not this attempt's. The date is the only readable
  // discriminator and it is one the ledger can rewrite, so it settles nothing.
  const otherDay = holding([{ amount: null, unreadableAmount: '10.005', date: '2026-01-01', id: 'PAY-9', reference: null }])
  const heldByDate = classifyLedgerSettlement(attemptFor('10.00'), otherDay)
  assert.equal(heldByDate.outcome, 'unknown')
  assert.equal(heldByDate.outcome === 'unknown' && heldByDate.cause, 'record-unmeasurable')

  // THE PRECONDITION this test turns on: the readable half really does differ, so r2's skip really
  // would have fired here. Without this the assertion above could be passing for want of a mismatch.
  assert.notEqual('2026-01-01', DATE, 'the record\'s readable date is NOT the attempt\'s')

  // The mirror image: unreadable DATE beside an amount nothing near this attempt's. An amount is
  // just as editable as a date, so it clears just as little.
  const otherAmount = holding([{ amount: toDecimal('999.00'), date: null, id: 'PAY-8', reference: null }])
  const heldByAmount = classifyLedgerSettlement(attemptFor('10.00'), otherAmount)
  assert.equal(heldByAmount.outcome, 'unknown')
  assert.equal(heldByAmount.outcome === 'unknown' && heldByAmount.cause, 'record-unmeasurable')
  assert.ok(toDecimal('999.00').sub(toDecimal('10.00')).abs().gt(ledgerMatchEpsilon('GBP')),
    'and the record\'s readable amount really is outside the band, so r2\'s skip would have fired')
})

/* -------------------------------------------------------------------------------------------- *
 * o3d-r948 r6 — RETIRED: `[o3d-r948 r3] a record the ledger IDENTIFIES as another attempt's does
 * not withhold`.
 *
 * It asserted that `settlementsOfOtherAttempts` skipped a record whose immutable ledger id IMS had
 * already recorded against a different row, case-folded, and excluded nothing else. The option is
 * gone: `classifyLedgerSettlement` takes two arguments and measures every record the probe returned.
 * See the note above that function for the four rounds of narrowing and the two facts nothing in
 * this system records, and bd o3d-hold1 for the permanent hold that leaves standing.
 *
 * The test below replaces it, on the opposite property.
 * -------------------------------------------------------------------------------------------- */

test('[o3d-r948 r6] a record the ledger identifies as ANOTHER attempt\'s still withholds', () => {
  // The exact input r3's exclusion cleared, now asserted to withhold. `PAY-OTHER` is the id IMS
  // recorded when a different row posted; the ledger reports a settlement carrying it and an amount
  // this code will not read. There is no longer any argument by which that record can be skipped —
  // "our row obtained that id" is a claim this system makes about itself, and five rounds could not
  // make it evidence (see the retirement note above).
  //
  // ROUTE: classifyLedgerSettlement's record loop -> the `record-unmeasurable` arm.
  // MUTATION (run): re-add the `options` parameter, `foldedIdentitySet` and the
  //        `excluded.has(record.id...)` continue, then call this with
  //        `{ settlementsOfOtherAttempts: ['PAY-OTHER'] }`. Every assertion below then reads
  //        `clear` and fails. Reverted after running.
  const unmeasurable: LedgerSettlementRecord[] = [
    { amount: null, unreadableAmount: '10.005', date: null, id: 'PAY-OTHER', reference: null },
  ]
  const verdict = classifyLedgerSettlement(attemptFor('10.00'), holding(unmeasurable))
  assert.equal(verdict.outcome, 'unknown')
  assert.equal(verdict.outcome === 'unknown' && verdict.cause, 'record-unmeasurable')

  // And the case-folding that used to matter cannot: nothing compares the id to anything.
  assert.equal(
    classifyLedgerSettlement(attemptFor('10.00'), holding([{ ...unmeasurable[0], id: 'Pay-Other' }])).outcome,
    'unknown',
  )
  // A record with NO id at all -- every Xero credit-note allocation -- reads the same. It always did;
  // now so does every other record, which is the whole of the change.
  assert.equal(
    classifyLedgerSettlement(attemptFor('10.00'),
      holding([{ amount: null, unreadableAmount: '10.005', date: null, reference: null }])).outcome,
    'unknown',
  )
})

// o3d-r948 r6: and the third argument is not merely unused — it does not exist. Asserted on the
// SOURCE because a caller in another file passing an object literal to a two-parameter function is a
// compile error there, not here, and a future overload could quietly re-open it.
test('[o3d-r948 r6] classifyLedgerSettlement accepts no exclusion argument at all', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'lib/domain/accounting/ledger-settlement-evidence.ts'), 'utf8',
  )
  const at = source.indexOf('export function classifyLedgerSettlement(')
  assert.notEqual(at, -1, 'the classifier must still be exported from this module')
  const signature = source.slice(at, source.indexOf('{', source.indexOf('): SettlementVerdict', at)))
  assert.doesNotMatch(signature, /options/, 'no options parameter')
  assert.doesNotMatch(source, /settlementsOfOtherAttempts\?:/, 'and no option type declaring one')
  assert.doesNotMatch(source, /foldedIdentitySet/, 'and no folded-id set left to compare against')
})

test('[o3d-r948 r3] an ordinary first payment still posts, and the ordinary match still matches', () => {
  // The cost of the restored rule has to be paid by ambiguity and by nothing else. A document the
  // ledger holds NOTHING against still clears, and a document holding a readable settlement that is
  // this attempt's is still `present`.
  //
  // ROUTE: classifyLedgerSettlement's record loop, both exits.
  // MUTATION: replace the loop's `return { outcome: 'clear' }` with a withhold and the first
  //        assertion fails; drop the `record.date === attempt.date` conjunct and the third reads
  //        `present` for a record dated a different day.
  assert.equal(classifyLedgerSettlement(attemptFor('10.00'), holding([])).outcome, 'clear')

  const mine = holding([{ amount: toDecimal('10.00'), date: DATE, id: 'PAY-1', reference: null }])
  const matched = classifyLedgerSettlement(attemptFor('10.00'), mine)
  assert.equal(matched.outcome, 'present')
  assert.equal(matched.outcome === 'present' && matched.matchedId, 'PAY-1')

  // A fully READABLE record that is not this attempt's still lets the attempt through -- that is the
  // long-standing rule this round did not touch, and it is what keeps a second instalment sendable.
  const someoneElse = holding([{ amount: toDecimal('10.00'), date: '2026-01-01', id: 'PAY-2', reference: null }])
  assert.equal(classifyLedgerSettlement(attemptFor('10.00'), someoneElse).outcome, 'clear')
})

test('[o3d-r948] the MARK still identifies our own settlement whatever its date says', () => {
  // A settlement of OURS whose date was edited in the ledger is the case the mark exists to retire,
  // and r3 keeps the mark pass whole and AHEAD of the record loop: it runs across every record, is
  // filtered by no identity and skipped by no discriminator, so nothing the loop below does can step
  // past a record carrying this attempt's own reference.
  //
  // ROUTE: classifyLedgerSettlement's marker pass, ahead of the record loop.
  // MUTATION: add a `record.date !== attempt.date` skip to the MARKER loop and this reads `clear` —
  //        the record is skipped by its date before its reference is ever looked at. Adding the
  //        `settlementsOfOtherAttempts` skip there instead does the same for an excluded id.
  const marked = holding([{
    amount: null, unreadableAmount: '10.005', date: '2026-01-01', id: 'PAY-9', reference: 'IMS-abc123abc123',
  }])
  const verdict = classifyLedgerSettlement(attemptFor('10.00', 'IMS-abc123abc123'), marked)
  assert.equal(verdict.outcome, 'present')
  assert.equal(verdict.outcome === 'present' && verdict.matchedId, 'PAY-9')
})
