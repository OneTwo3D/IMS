import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideInvoicePaymentPost,
  guardInvoicePaymentCapacity,
} from '@/lib/domain/accounting/invoice-payment-capacity'
import { decideInvoicePaymentRegistration } from '@/lib/domain/accounting/invoice-payment-registration'
import {
  REGISTERED_AMOUNT_DECIMAL_FIELD,
  payloadRegisteredAmount,
  readPayloadRegisteredAmount,
} from '@/lib/domain/accounting/registered-amount'
import { classifyLedgerSettlement } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { settlementStatus } from '@/lib/domain/accounting/settlement-status'
import {
  ledgerAmountEpsilon,
  ledgerMatchEpsilon,
  toDecimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

/**
 * o3d-6abj — THE CAPACITY GUARDS MEASURE MONEY, SO THEY MEASURE IT EXACTLY.
 *
 * Codex, o3d-acctmoney r20 HIGH. `guardInvoicePaymentCapacity` converted the stored order total to a
 * double and read every prior registration from the payload's JSON `amount`, ignoring the exact
 * decimal string o3d-1xq8 had just added beside it. Above about 4.5e13 the spacing between
 * neighbouring doubles exceeds the band the guard allows, so two figures that differ by more than
 * the band convert to the SAME double and the test reads `x > x + band` — false, and an
 * over-settlement posts.
 *
 * The reproduction is Codex's, and its figures are the ones asserted: both are legal `numeric(18,4)`,
 * the receipt survives the writer's round-trip backstop, and the excess is 0.006 against a 0.005
 * band. Every test below states the PRECONDITION it depends on — that the two operands really do
 * collapse — so it cannot pass by the collapse quietly ceasing to happen.
 */

/** Codex's figures. Strings, because a JS number literal has already lost the thing under test. */
const REPRO_TOTAL = '35184372088832.0040'
const REPRO_PAYMENT = '35184372088832.01'

const ENTRY = 'entry-under-test'

function payload(amount: string, over: Record<string, unknown> = {}) {
  return {
    accountingInvoiceId: 'INV-1',
    bankAccountId: 'bank-1',
    amount: Number(amount),
    [REGISTERED_AMOUNT_DECIMAL_FIELD]: amount,
    currency: 'GBP',
    ...over,
  }
}

function client(order: {
  totalForeign: DecimalInput
  currency?: string
}, logs: Array<{ id: string; status: string; payload: unknown; settlementBasis?: string | null }> = []) {
  return {
    salesOrder: {
      findUnique: async () => ({
        currency: order.currency ?? 'GBP',
        totalForeign: toDecimal(order.totalForeign),
        taxForeign: toDecimal(0),
        pricesIncludeVat: false,
        shoppingLinks: [] as { connector: string }[],
      }),
    },
    accountingSyncLog: {
      findMany: async () => logs.map((row) => ({
        settlementBasis: null,
        remoteAttemptedAt: null,
        attemptStampingCustodyAt: null,
        ...row,
      })),
    },
  } as never
}

function guardParams(amount: string, over: Record<string, unknown> = {}) {
  return {
    connector: 'xero',
    entryId: ENTRY,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    accountingInvoiceId: 'INV-1',
    amount: Number(amount),
    payload: payload(amount),
    ...over,
  }
}

const registrationBase = {
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentId: 'pay-new',
  bankAccountId: 'BANK-1',
  existing: [],
  ledgerSettlements: null,
}

// ---------------------------------------------------------------------------
// THE PRECONDITION. Asserted on its own, first, so every refusal below is known
// to be running on the collapse rather than beside it.
// ---------------------------------------------------------------------------

test('[o3d-6abj] PRECONDITION: Codex s total and receipt are 0.006 apart and become the SAME double', () => {
  // Both legal numeric(18,4). This is the fact the whole finding rests on, and if it ever stops
  // being true every test below would pass for a reason that is not the fix.
  assert.equal(toDecimal(REPRO_PAYMENT).minus(toDecimal(REPRO_TOTAL)).toFixed(), '0.006')
  assert.ok(toDecimal(REPRO_PAYMENT).minus(toDecimal(REPRO_TOTAL)).gt(ledgerAmountEpsilon('GBP')),
    'the excess is ABOVE the band, so this pair MUST be refused')
  assert.equal(Number(REPRO_TOTAL), Number(REPRO_PAYMENT),
    'and yet as doubles they are one value — the collapse the old arithmetic could not see')
  // The old test, spelt out: `amount > total - already + 0.005` on doubles.
  assert.equal(Number(REPRO_PAYMENT) > Number(REPRO_TOTAL) - 0 + 0.005, false,
    'so the arithmetic this replaced APPROVED it')
})

// ---------------------------------------------------------------------------
// THE POST-SITE GUARD — the one no enqueue path can route around.
// ---------------------------------------------------------------------------

test('[o3d-6abj] the post-site decision REFUSES Codex s reproduction', () => {
  // ROUTE: decideInvoicePaymentPost's WOULD_OVERPAY test.
  // MUTATION: `compareDecimal(input.amount, ...)` -> the old `Number(...) > Number(...) + 0.005`,
  // or `ledgerTotal: toDecimal(Number(order.totalForeign))` at the guard — either returns post:true.
  const verdict = decideInvoicePaymentPost({
    entryId: ENTRY,
    accountingInvoiceId: 'INV-1',
    currency: 'GBP',
    amount: toDecimal(REPRO_PAYMENT),
    ledgerTotal: toDecimal(REPRO_TOTAL),
    registrations: [],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
  assert.equal(verdict.ledgerTotal.toFixed(), '35184372088832.004',
    'and the refusal reports the STORED total, not a rounding of it')
})

test('[o3d-6abj] and so does the whole guard, reading the order total out of the database', async () => {
  // The pure decision above cannot catch the `Number(order.totalForeign)` hop, which was HALF the
  // finding: it lived at the read, not in the arithmetic.
  // ROUTE: guardInvoicePaymentCapacity -> ledgerSalesInvoiceTotalForeign(order.totalForeign).
  // MUTATION: put `Number(...)` back around `order.totalForeign` -> post:true.
  const result = await guardInvoicePaymentCapacity(
    client({ totalForeign: REPRO_TOTAL }),
    guardParams(REPRO_PAYMENT),
  )
  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'refused')
  assert.equal(result.post === false && result.kind === 'refused' && result.refusal, 'WOULD_OVERPAY')
  assert.match(
    result.post === false && result.kind === 'refused' ? result.message : '',
    /35184372088832\.004/,
    'and the operator is given the digits that differ, which a toFixed(2) rendering would hide',
  )
})

test('[o3d-6abj] an ordinary receipt inside the invoice still posts — the guard is a gate, not a wall', async () => {
  // THE COUNTER-TEST. Every assertion above is satisfied by a guard that refuses everything.
  // ROUTE: the same WOULD_OVERPAY test, on the ordinary case.
  // MUTATION: invert the comparison, or drop the epsilon -> this fails while the others still pass.
  const result = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }, [
      { id: 'deposit', status: 'SYNCED', payload: payload('40.00') },
    ]),
    guardParams('60.00'),
  )
  assert.equal(result.post, true)

  // And the exact settlement, which is the boundary the epsilon exists for.
  const exact = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }),
    guardParams('100.00'),
  )
  assert.equal(exact.post, true)
})

// ---------------------------------------------------------------------------
// THE ENQUEUE GUARD. Both guards have to agree, so the same pair is driven
// through the other one.
// ---------------------------------------------------------------------------

test('[o3d-6abj] the ENQUEUE guard refuses the same pair, so the two guards still agree', () => {
  // ROUTE: decideInvoicePaymentRegistration's WOULD_OVERPAY test.
  // MUTATION: `paymentAmount: amountNumber` / `ledgerTotal: Number(so.totalForeign)` at the caller,
  // or the Decimal comparison here -> register:true.
  const decision = decideInvoicePaymentRegistration({
    ...registrationBase,
    paymentAmount: toDecimal(REPRO_PAYMENT),
    ledgerTotal: toDecimal(REPRO_TOTAL),
  })
  assert.equal(decision.register, false)
  assert.equal(decision.register === false && decision.refusal, 'WOULD_OVERPAY')
})

test('[o3d-6abj] the enqueue guard still registers an ordinary second receipt that fits', () => {
  const decision = decideInvoicePaymentRegistration({
    ...registrationBase,
    paymentAmount: toDecimal('60.00'),
    ledgerTotal: toDecimal('100.00'),
    existing: [{ status: 'SYNCED', amount: 40, registeredAmount: { kind: 'stated', amount: toDecimal('40.00') }, paymentId: 'pay-old' }],
  })
  assert.equal(decision.register, true)
})

// ---------------------------------------------------------------------------
// THE SUM OVER PRIOR ROWS — the second lossy operand.
// ---------------------------------------------------------------------------

test('[o3d-6abj] prior registrations are summed from the EXACT string, not the JSON number', () => {
  // The two forms are made to DISAGREE here on purpose. Production cannot produce such a row — the
  // writer refuses an amount whose two forms would differ — but a test that fed both forms the same
  // figure could not tell which one the sum read, and that is the whole question.
  //
  // ROUTE: decideInvoicePaymentPost's `alreadyPosted` reduce, via payloadRegisteredAmount.
  // MUTATION: read `payloadNumber(row.payload, 'amount')` again -> the sum becomes 1 and it posts.
  const verdict = decideInvoicePaymentPost({
    entryId: ENTRY,
    accountingInvoiceId: 'INV-1',
    currency: 'GBP',
    amount: toDecimal('50.00'),
    ledgerTotal: toDecimal('100.00'),
    registrations: [{
      id: 'prior',
      status: 'SYNCED',
      settlementBasis: null,
      // 99, not the 1 the number claims: the sum must leave no room for a 50.
      registeredAmount: payloadRegisteredAmount(
        { amount: 1, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '99.00', currency: 'GBP' }, 'GBP'),
      accountingInvoiceId: 'INV-1',
      paymentId: null,
      bodyCouldHavePosted: true,
      provenNeverAttempted: false,
    }],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
  assert.equal(verdict.post === false && verdict.alreadyPosted?.toFixed(), '99')
})

test('[o3d-6abj] the ENQUEUE sum reads the exact string too, not the number beside it', () => {
  // The post-site twin of the test above, and it needs its own: the two guards read the SAME payload
  // through two different loaders, so one of them staying on `amount` would leave the enqueue gate
  // measuring a figure the post gate does not.
  //
  // The forms are made to disagree on purpose; production cannot produce such a row.
  // ROUTE: decideInvoicePaymentRegistration's `alreadyRegistered` reduce.
  // MUTATION: sum `r.amount` again -> the sum becomes 1 and a 50 registers against a full invoice.
  const decision = decideInvoicePaymentRegistration({
    ...registrationBase,
    paymentAmount: toDecimal('50.00'),
    ledgerTotal: toDecimal('100.00'),
    existing: [{
      status: 'SYNCED',
      amount: 1,
      registeredAmount: readPayloadRegisteredAmount(
        { amount: 1, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '99.00', currency: 'GBP' }, 'GBP'),
      paymentId: 'pay-old',
    }],
  })
  assert.equal(decision.register, false)
  assert.equal(decision.register === false && decision.refusal, 'WOULD_OVERPAY')
  assert.equal(decision.register === false && decision.alreadyRegistered?.toFixed(), '99')
})

test('[o3d-6abj] a HISTORICAL row carrying no decimal string is read exactly as it is today', async () => {
  // THE ADDITIVE PROMISE. Rows written before o3d-1xq8 carry only the JSON number, and
  // payloadRegisteredAmount falls through to the double's own exact decimal reading — which IS what
  // the old `+` reduce added. Nothing about such a row gets worse, and nothing refuses it.
  //
  // ROUTE: payloadRegisteredAmount's fallback arm, through the guard's registration mapping.
  // MUTATION: make the missing field a refusal (`return null` when the string is absent) and this
  // becomes LEDGER_AMOUNT_UNKNOWN — every pre-o3d-1xq8 invoice permanently unmeasurable.
  const historical = { accountingInvoiceId: 'INV-1', amount: 40, currency: 'GBP' }
  assert.equal(REGISTERED_AMOUNT_DECIMAL_FIELD in historical, false, 'the fixture really is a pre-fix row')

  const fits = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }, [{ id: 'old', status: 'SYNCED', payload: historical }]),
    guardParams('60.00'),
  )
  assert.equal(fits.post, true, 'a historical row consumes exactly its 40 and no more')

  const overflows = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }, [{ id: 'old', status: 'SYNCED', payload: historical }]),
    guardParams('60.01'),
  )
  assert.equal(overflows.post, false, 'and exactly its 40 and no less')
  assert.equal(overflows.post === false && overflows.kind === 'refused' && overflows.refusal, 'WOULD_OVERPAY')
})

test('[o3d-6abj] a PRESENT-but-unreadable decimal string refuses here too, rather than falling back', async () => {
  // The string exists so a reader never has to consult the double again. A payload that carries the
  // field is a payload written by a build that promised it is exact; if it will not parse, the
  // promise is broken and the double beside it is not a second opinion.
  //
  // ROUTE: payloadRegisteredAmount's "present decides" arm -> LEDGER_AMOUNT_UNKNOWN.
  // MUTATION: fall back to `p.amount` when the string is unreadable -> post:true.
  const result = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }, [{
      id: 'prior',
      status: 'SYNCED',
      // `1e3` is a number Prisma.Decimal would happily accept and is NOT a plain decimal numeral.
      payload: { accountingInvoiceId: 'INV-1', amount: 40, [REGISTERED_AMOUNT_DECIMAL_FIELD]: '1e3', currency: 'GBP' },
    }]),
    guardParams('60.00'),
  )
  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind === 'refused' && result.refusal, 'LEDGER_AMOUNT_UNKNOWN')
})

test('[o3d-6abj] the guard refuses unless the figure it measured IS the one about to go on the wire', async () => {
  // A guard that measures one figure while the connector sends another has measured nothing. The two
  // payload forms agree by the writer's round-trip refusal, which says nothing about a payload
  // written by something else or edited by hand.
  //
  // ROUTE: guardInvoicePaymentCapacity's `amount.eq(toDecimal(params.amount))` gate.
  // MUTATION: drop the equality test -> the 1.00 is measured and the 99.00 is sent.
  const mismatched = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }),
    guardParams('1.00', { amount: 99 }),
  )
  assert.equal(mismatched.post, false)
  assert.equal(mismatched.post === false && mismatched.kind, 'unmeasurable',
    'retryable and NOT sent — the size of this receipt is not established')

  // A payload that names a DIFFERENT currency from the order cannot be measured against its total
  // either: adding the two numbers is arithmetic across two units.
  const foreign = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }),
    guardParams('60.00', { payload: payload('60.00', { currency: 'EUR' }) }),
  )
  assert.equal(foreign.post === false && foreign.kind, 'unmeasurable')
})

// ---------------------------------------------------------------------------
// o3d-6yho (1 of 3) — THE BAND IS THE DOCUMENT'S, NOT A HALF-PENNY.
// ---------------------------------------------------------------------------

test('[o3d-6yho] the over-payment band is half one minor unit of the ORDER s currency, at both guards', async () => {
  // A flat 0.005 is five whole minor units of admitted over-payment in a Gulf dinar and fifty in
  // CLF. The test reads `amount > remaining + band`, so a larger band ADMITS more — the one
  // direction that ends in a second payment on the ledger.
  //
  // ROUTE: ledgerAmountEpsilon(currency) at both guards.
  // MUTATION: restore the flat 0.005 and the KWD case posts.
  assert.equal(ledgerAmountEpsilon('KWD').toFixed(), '0.0005', 'the precondition: KWD is finer than GBP')

  const kwd = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.000', currency: 'KWD' }),
    guardParams('100.002', { payload: payload('100.002', { currency: 'KWD' }) }),
  )
  assert.equal(kwd.post, false, '2 whole fils of over-payment is an over-payment')
  assert.equal(kwd.post === false && kwd.kind === 'refused' && kwd.refusal, 'WOULD_OVERPAY')

  // The same 0.002 in GBP is a fifth of a penny and still inside the band, so the ordinary
  // two-decimal case has not moved.
  const gbp = await guardInvoicePaymentCapacity(
    client({ totalForeign: '100.00' }),
    guardParams('100.002'),
  )
  assert.equal(gbp.post, true)

  // And the enqueue guard derives the same band from the same function.
  const enqueueKwd = decideInvoicePaymentRegistration({
    ...registrationBase,
    orderCurrency: 'KWD',
    paymentCurrency: 'KWD',
    paymentAmount: toDecimal('100.002'),
    ledgerTotal: toDecimal('100.000'),
  })
  assert.equal(enqueueKwd.register, false)
  assert.equal(enqueueKwd.register === false && enqueueKwd.refusal, 'WOULD_OVERPAY')
  const enqueueGbp = decideInvoicePaymentRegistration({
    ...registrationBase,
    paymentAmount: toDecimal('100.002'),
    ledgerTotal: toDecimal('100.00'),
  })
  assert.equal(enqueueGbp.register, true, 'and the two guards agree in both currencies')
})

// ---------------------------------------------------------------------------
// o3d-6yho (3 of 3) — the settlement VERDICT's two literals.
// ---------------------------------------------------------------------------

test('[o3d-6yho] the part/over settlement band is the document s, not a half-penny', () => {
  // ROUTE: settlementStatus's `settlementBand`.
  // MUTATION: restore the two bare 0.005 literals and the KWD shortfall reads SETTLED.
  const base = { paidLocally: true, syncEnabled: true, documentPosted: true }
  const row = (amount: number) => ({ status: 'SYNCED' as const, externalTransactionId: 'PAY-1', amount })

  assert.equal(
    settlementStatus({ ...base, currency: 'KWD', totalForeign: 100, payment: row(99.998) }).status,
    'PARTIALLY_SETTLED',
    'two whole fils still outstanding is a balance, not a rounding',
  )
  assert.equal(
    settlementStatus({ ...base, currency: 'KWD', totalForeign: 100, payment: row(100.002) }).status,
    'OVER_SETTLED',
  )
  // GBP is unchanged: a fifth of a penny either way is still arithmetic dust.
  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: 100, payment: row(99.998) }).status,
    'SETTLED',
  )
  assert.equal(
    settlementStatus({ ...base, currency: 'GBP', totalForeign: 100, payment: row(100.002) }).status,
    'SETTLED',
  )
})

// ---------------------------------------------------------------------------
// o3d-6yho (2 of 3) — the one band whose fail-safe direction is the other way.
// ---------------------------------------------------------------------------

test('[o3d-6yho] an unstated currency narrows every band EXCEPT the settlement match, which widens', () => {
  // The asymmetry is deliberate and it is the whole reason `ledgerMatchEpsilon` is a second
  // function. Everywhere else a narrower band can only move a verdict into one that WITHHOLDS, so an
  // unstated currency takes the finest unit. In `classifyLedgerSettlement` a narrower band means our
  // OWN payment's ledger record is not recognised, the verdict is `clear`, and a SECOND payment
  // posts — so an unstated currency there takes the WIDEST band the supported currencies produce.
  //
  // ROUTE: ledgerAmountEpsilon(null) vs ledgerMatchEpsilon(null).
  // MUTATION: point the match rule at ledgerAmountEpsilon and this fails — which is exactly the
  // edit a reader who saw "one epsilon function" would make.
  assert.equal(ledgerAmountEpsilon(null).toFixed(), '0.00005', 'the strictest — CLF/UYW at four places')
  assert.equal(ledgerMatchEpsilon(null).toFixed(), '0.005', 'the widest — and the value this rule always had')
  assert.ok(ledgerMatchEpsilon(null).gt(ledgerAmountEpsilon(null)),
    'the two resolve an unstated currency in OPPOSITE directions, on purpose')

  // A stated currency is the same answer from both, because there the rule is not a default at all.
  for (const currency of ['GBP', 'KWD', 'CLF', 'JPY']) {
    assert.equal(ledgerMatchEpsilon(currency).toFixed(), ledgerAmountEpsilon(currency).toFixed(), currency)
  }
})

test('[o3d-6yho] an attempt with NO currency is still MATCHED at the wide band, not cleared for a re-post', () => {
  // The behaviour behind the constant asserted above, because the constant alone does not say what
  // it costs to get it wrong. A ledger record a thousandth away from what IMS sent IS that payment;
  // reading it as a different one returns `clear`, and `clear` is the verdict that lets a SECOND
  // payment be posted for a receipt the ledger already holds.
  //
  // ROUTE: classifyLedgerSettlement's amount+date match, banded by ledgerMatchEpsilon.
  // MUTATION: resolve a null currency with FINEST_SUPPORTED_MINOR_UNITS — the reading every OTHER
  // rule in the repository takes — and this returns `clear`.
  // o3d-78rq: both operands are `Decimal`s now. The figures, and everything this test asserts about
  // them, are unchanged — only the type they are stated in.
  const records = (amount: number) => ({ ok: true as const, records: [{ amount: toDecimal(amount), date: '2026-08-01', id: 'PAY-1' }] })
  const unstated = { amount: toDecimal(10), currency: null, date: '2026-08-01', marker: null }
  assert.equal(classifyLedgerSettlement(unstated, records(10.001)).outcome, 'present',
    'a thousandth apart is the same payment, and this attempt must not be re-sent')

  // The band is still strictly below one minor unit, so it cannot merge two figures a two-decimal
  // ledger can tell apart. Without this the test above would be satisfied by an infinite band.
  assert.equal(classifyLedgerSettlement(unstated, records(10.01)).outcome, 'clear',
    'a whole penny apart is a different payment, and this attempt is genuinely unsettled')

  // And a STATED fine currency narrows it, which is the half of the fix that was actually broken:
  // a flat 0.005 conflated five whole fils.
  const kwd = { amount: toDecimal(10), currency: 'KWD', date: '2026-08-01', marker: null }
  assert.equal(classifyLedgerSettlement(kwd, records(10.001)).outcome, 'clear',
    'one whole fil apart is a different payment in KWD, whatever it would be in GBP')
})
