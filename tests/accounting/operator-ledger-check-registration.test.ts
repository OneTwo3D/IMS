import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideInvoicePaymentRegistration,
  type ExistingInvoicePaymentSync,
} from '@/lib/domain/accounting/invoice-payment-registration'
import type { LedgerSettlementProbe, LedgerSettlementRecord } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { settlementMarkerFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { describeInvoicePaymentRefusal } from '@/lib/domain/accounting/invoice-payment-enqueue'
import { toDecimal } from '@/lib/domain/math/decimal'
import { unconditionalMoneySentences, unlicensedHistoryClaims } from '../helpers/unconditional-instruction'

/**
 * o3d-llyw (owner decision C4) — THE PERMANENT HOLD, AND THE OPERATOR LEDGER CHECK THAT LIFTS IT, AT THE
 * REGISTRATION DECISION.
 *
 * THE SHAPE THE CHECK CAN LIFT: a FAILED attempt F on the order, and a settlement on the invoice that IMS
 * cannot read (here a payment entered by hand in Xero, PAY-H). F can never be ruled out against PAY-H, so
 * every later receipt N is refused for ever with UNRESOLVED_PAYMENT_ATTEMPT.
 *
 * THE BEAD'S HEADLINE SHAPE — the unreadable payment belongs to a SYNCED sibling S on the same invoice —
 * is covered at the end, and it is NOT liftable: the post fence judges S as a contender immediately before
 * money moves and refuses a payment beside one IMS has already posted (its documented part-payment limit),
 * so the decision refuses the lift and says why rather than queueing a payment that will be refused.
 *
 * FAILING-FIRST. This file imports nothing that is new on this branch: the checks are passed as plain
 * objects through the decision's input. On origin/development the decision ignores them, so the
 * precondition test passes there and every "lifts" test FAILS there — which is what was run (see the
 * PR's gate table) before the rule was wired in.
 *
 * Every test prints its precondition (the refusal or registration it starts from), so an arm that
 * passes while examining nothing is visible in the log.
 */

type Row = Omit<ExistingInvoicePaymentSync, 'registeredAmount' | 'externalTransactionId' | 'abandonedBeforeRemoteCall' | 'settlementBasis'>
  & Partial<Pick<ExistingInvoicePaymentSync, 'externalTransactionId' | 'abandonedBeforeRemoteCall' | 'settlementBasis'>>

function row(r: Row): ExistingInvoicePaymentSync {
  return {
    ...r,
    externalTransactionId: r.externalTransactionId ?? null,
    abandonedBeforeRemoteCall: r.abandonedBeforeRemoteCall ?? null,
    settlementBasis: r.settlementBasis ?? null,
    registeredAmount: r.amount == null ? { kind: 'not-stated' } : { kind: 'stated', amount: toDecimal(r.amount) },
  }
}

const F_MARKER = settlementMarkerFor('log-f')
/** The FAILED attempt that can never be ruled out against the unreadable payment. */
const F = row({ id: 'log-f', status: 'FAILED', amount: 100, paymentId: 'pay-f', accountingInvoiceId: 'INV-1', paymentDate: '2026-08-01', settlementMarker: F_MARKER })
/** A payment entered by hand in Xero, reported with a figure IMS will not read. */
const UNREADABLE_H: LedgerSettlementRecord = { amount: null, unreadableAmount: '40.005', date: '2026-08-02', id: 'PAY-H', reference: null }
/** The headline shape's SYNCED sibling: 40 against INV-1, its payment PAY-S. */
const S = row({ id: 'log-s', status: 'SYNCED', amount: 40, paymentId: 'pay-s', accountingInvoiceId: 'INV-1', externalTransactionId: 'PAY-S', paymentDate: '2026-08-02' })
const UNREADABLE_S: LedgerSettlementRecord = { amount: null, unreadableAmount: '40.005', date: '2026-08-02', id: 'PAY-S', reference: null }

const BINDING = { tenantId: 'tenant-A', connectionGeneration: 'gen-1' }

function probe(records: LedgerSettlementRecord[], extra: Record<string, unknown> = { answeredBy: BINDING }): LedgerSettlementProbe {
  return { ok: true, records, provedComplete: true, ...extra } as LedgerSettlementProbe
}

const CHECK = {
  id: 'chk-1',
  syncLogId: 'log-f',
  paymentId: 'pay-new',
  connector: 'xero',
  ledgerDocumentId: 'INV-1',
  ledgerRecordIds: ['PAY-H'],
  tenantId: 'tenant-A',
  connectionGeneration: 'gen-1',
}

const base = {
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentAmount: toDecimal(60),
  paymentId: 'pay-new',
  bankAccountId: 'BANK-1',
  existing: [F],
  ledgerSettlements: probe([UNREADABLE_H]),
  ledgerTotal: toDecimal(100),
  connector: 'xero',
}

type Input = Parameters<typeof decideInvoicePaymentRegistration>[0]
const decide = (overrides: Partial<Input> & { operatorLedgerChecks?: unknown[] } = {}) =>
  decideInvoicePaymentRegistration({ ...base, ...overrides } as Input)

function precondition(label: string, decision: ReturnType<typeof decideInvoicePaymentRegistration>) {
  console.log(`[precondition] ${label}: ${decision.register ? 'REGISTER' : `REFUSE ${decision.refusal} (${decision.detail ?? ''})`}`)
}

test('[o3d-llyw] precondition: an unreadable settlement on the invoice holds every later receipt back (green on trunk)', () => {
  const d = decide()
  precondition('no check', d)
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(d.register === false ? d.detail ?? '' : '', /PAY-H/, 'and it is that record which holds it, by id')
})

test('[o3d-llyw] a matching operator ledger check lifts the hold and the receipt registers (RED on trunk)', () => {
  const held = decide()
  precondition('without the check', held)
  assert.equal(held.register, false, 'precondition: held without the check')
  const d = decide({ operatorLedgerChecks: [CHECK] })
  precondition('with the check', d)
  assert.equal(d.register, true)
  assert.deepEqual(d.register && d.liftedByCheckIds, ['chk-1'], 'and the lift names the check that permitted it')
})

test('[o3d-llyw] a check covering R1 does not cover a record R2 that appeared since', () => {
  const d = decide({
    operatorLedgerChecks: [CHECK],
    ledgerSettlements: probe([UNREADABLE_H, { amount: null, unreadableAmount: '7.0001', date: '2026-08-05', id: 'PAY-NEW-UNREADABLE', reference: null }]),
  })
  precondition('R1 checked, R2 new', d)
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(d.register === false ? d.ledgerCheckRemedy ?? '' : '', /PAY-NEW-UNREADABLE/, 'and the remedy names the record still to look at')
})

test('[o3d-llyw] a check recorded under another organisation does not apply', () => {
  const lifted = decide({ operatorLedgerChecks: [CHECK] })
  assert.equal(lifted.register, true, 'precondition: the same check lifts under its own organisation')
  const d = decide({ operatorLedgerChecks: [{ ...CHECK, tenantId: 'tenant-B' }] })
  precondition('tenant mismatch', d)
  assert.equal(d.register, false)
})

test('[o3d-llyw] a check recorded under an earlier connection generation does not apply (a reconnect voids it)', () => {
  const d = decide({ operatorLedgerChecks: [{ ...CHECK, connectionGeneration: 'gen-0' }] })
  precondition('generation mismatch', d)
  assert.equal(d.register, false)
  // ...and the same organisation reconnected (A -> B -> A mints a third generation) is no better.
  const reconnected = decide({ operatorLedgerChecks: [CHECK], ledgerSettlements: probe([UNREADABLE_H], { answeredBy: { tenantId: 'tenant-A', connectionGeneration: 'gen-3' } }) })
  precondition('same tenant, re-minted generation', reconnected)
  assert.equal(reconnected.register, false)
})

test('[o3d-llyw] a probe that cannot say which connection served it honours no check', () => {
  for (const extra of [{}, { answeredBy: null }]) {
    const d = decide({ operatorLedgerChecks: [CHECK], ledgerSettlements: probe([UNREADABLE_H], extra) })
    precondition(`answeredBy ${JSON.stringify(extra)}`, d)
    assert.equal(d.register, false)
    assert.match(d.register === false ? d.ledgerCheckRemedy ?? '' : '', /could not establish which Xero connection/)
  }
})

test('[o3d-llyw] a check never clears a PRESENT verdict — by amount and date, or by the attempt\'s own mark', () => {
  // F's own payment, measurable: 100 on 2026-08-01. The unreadable record is checked; the match is not.
  const byAmount = decide({
    operatorLedgerChecks: [CHECK],
    ledgerSettlements: probe([UNREADABLE_H, { amount: toDecimal(100), date: '2026-08-01', id: 'PAY-F', reference: null }]),
  })
  precondition('present by amount/date', byAmount)
  assert.equal(byAmount.register, false)
  assert.match(byAmount.register === false ? byAmount.detail ?? '' : '', /already holds .*PAY-F/)
  // The checked, unreadable record itself carries F's mark: it IS F's payment, whatever the check says.
  const byMark = decide({
    operatorLedgerChecks: [CHECK],
    ledgerSettlements: probe([{ ...UNREADABLE_H, reference: `deposit ${F_MARKER}` }]),
  })
  precondition('present by mark on the checked record', byMark)
  assert.equal(byMark.register, false)
  assert.match(byMark.register === false ? byMark.detail ?? '' : '', new RegExp(F_MARKER))
})

test('[o3d-llyw] a check is for ONE attempt, ONE receipt, ONE document and ONE connector', () => {
  for (const [label, check] of [
    ['another receipt', { ...CHECK, paymentId: 'pay-other' }],
    ['another attempt', { ...CHECK, syncLogId: 'log-other' }],
    ['another document', { ...CHECK, ledgerDocumentId: 'INV-OLD' }],
    ['another connector', { ...CHECK, connector: 'quickbooks' }],
  ] as const) {
    const d = decide({ operatorLedgerChecks: [check] })
    precondition(label, d)
    assert.equal(d.register, false, `${label} must not lift`)
  }
  // Ids compare case-insensitively (Xero GUIDs arrive in either case) — so a case difference is NOT a mismatch.
  const cased = decide({ operatorLedgerChecks: [{ ...CHECK, ledgerRecordIds: ['pay-h'], ledgerDocumentId: 'inv-1' }] })
  precondition('case-folded ids', cased)
  assert.equal(cased.register, true)
})

test('[o3d-llyw] an unmeasurable record with NO ledger id can never be checked', () => {
  const d = decide({ operatorLedgerChecks: [CHECK], ledgerSettlements: probe([{ ...UNREADABLE_H, id: null }]) })
  precondition('record without id', d)
  assert.equal(d.register, false)
  assert.match(d.register === false ? d.ledgerCheckRemedy ?? '' : '', /carries no ledger id/)
})

test('[o3d-llyw] a check does not stand in for completeness: an unproved collection still withholds', () => {
  const d = decide({ operatorLedgerChecks: [CHECK], ledgerSettlements: probe([UNREADABLE_H], { answeredBy: BINDING, provedComplete: false }) })
  precondition('collection unproved', d)
  assert.equal(d.register, false)
  assert.match(d.register === false ? d.detail ?? '' : '', /did not establish that what it returned/)
})

test('[o3d-llyw] a lift frees only the unresolved attempt — capacity still refuses an overpayment', () => {
  // A live registration of 40 for another receipt (queued, not posted) is still counted; 70 does not fit in the 60 left.
  const queued = row({ id: 'log-q', status: 'PENDING', amount: 40, paymentId: 'pay-q', accountingInvoiceId: 'INV-1', paymentDate: '2026-08-03' })
  const fits = decide({ operatorLedgerChecks: [CHECK], existing: [queued, F], paymentAmount: toDecimal(60) })
  assert.equal(fits.register, true, 'precondition: 60 fits beside the queued 40 once the hold is lifted')
  const d = decide({ operatorLedgerChecks: [CHECK], existing: [queued, F], paymentAmount: toDecimal(70) })
  precondition('lifted but over capacity', d)
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
})

test('[o3d-llyw] the refusal tells the operator EXACTLY what lifts it, conditionally, with no history claim', () => {
  const d = decide()
  assert.equal(d.register, false)
  if (d.register) return
  const remedy = d.ledgerCheckRemedy ?? ''
  console.log(`[precondition] remedy text: ${remedy}`)
  for (const named of ['PAY-H', 'INV-1', 'log-f', 'pay-new', 'Checked the ledger', 'Accounting Sync page', F_MARKER, 'GBP 100.00', '2026-08-01']) {
    assert.ok(remedy.includes(named), `the remedy names ${named}`)
  }
  assert.match(remedy, /Only if it is not that attempt's payment, and not a payment for this receipt already entered by hand/)
  assert.match(remedy, /lapses after any Xero reconnect/)
  const notice = describeInvoicePaymentRefusal({
    refused: d, orderReference: 'SO-1', amount: 60, currency: 'GBP', orderCurrency: 'GBP', method: 'Bank', redrive: { redrive: 'none' },
  })
  assert.ok(notice)
  assert.ok(notice!.description.includes(remedy), 'the operator warning carries the remedy sentence verbatim')
  assert.doesNotMatch(notice!.description, /Resolve the earlier attempt on the Accounting Sync page first/,
    'the old remedy, which lifts nothing since C1, is gone')
  assert.deepEqual(unconditionalMoneySentences(remedy), [], 'no unconditional money instruction')
  assert.deepEqual(unlicensedHistoryClaims(remedy, null), [], 'no claim about what was or was not posted')
})

test('[o3d-llyw] a hold that is NOT an unmeasurable record does not offer a ledger check', () => {
  // The probe could not be read at all: no check could ever answer that.
  const d = decide({ operatorLedgerChecks: [CHECK], ledgerSettlements: { ok: false, reason: 'HTTP 503' } })
  precondition('probe unreadable', d)
  assert.equal(d.register, false)
  if (d.register) return
  assert.equal(d.ledgerCheckRemedy, undefined)
  const notice = describeInvoicePaymentRefusal({
    refused: d, orderReference: 'SO-1', amount: 60, currency: 'GBP', orderCurrency: 'GBP', method: 'Bank', redrive: { redrive: 'none' },
  })
  assert.match(notice!.description, /An operator ledger check cannot lift this kind of hold/)
})

test('[o3d-llyw] the HEADLINE shape — the unreadable payment is a SYNCED sibling\'s own — is refused with the reason, not lifted', () => {
  const sCheck = { ...CHECK, ledgerRecordIds: ['PAY-S'] }
  const withoutSibling = decide({ operatorLedgerChecks: [sCheck], existing: [F], ledgerSettlements: probe([UNREADABLE_S]) })
  assert.equal(withoutSibling.register, true, 'precondition: the same check lifts F when no registration has posted on the invoice')
  const d = decide({ operatorLedgerChecks: [sCheck], existing: [S, F], ledgerSettlements: probe([UNREADABLE_S]) })
  precondition('SYNCED sibling S posted on the invoice', d)
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  const remedy = d.register === false ? d.ledgerCheckRemedy ?? '' : ''
  assert.match(remedy, /cannot get this receipt sent: entry log-s already posted a payment against this invoice/)
  assert.deepEqual(unconditionalMoneySentences(remedy), [])
  assert.deepEqual(unlicensedHistoryClaims(remedy, null), [])
})

test('[o3d-llyw] a check never sets aside the ledger id the attempt row records as its OWN payment', () => {
  // A swept or retired attempt that still records `PAY-H` as its ledger id: by its own account PAY-H is
  // its payment, so "PAY-H is not this attempt's payment" is not a check anyone can make.
  const ownsIt = row({ id: 'log-f', status: 'CANCELLED', amount: 100, paymentId: 'pay-f', accountingInvoiceId: 'INV-1', paymentDate: '2026-08-01', settlementMarker: F_MARKER, externalTransactionId: 'PAY-H' })
  const d = decide({ operatorLedgerChecks: [CHECK], existing: [ownsIt] })
  precondition('attempt records PAY-H as its own', d)
  assert.equal(d.register, false)
  assert.match(d.register === false ? d.ledgerCheckRemedy ?? '' : '', /carries the very ledger id the earlier entry records as its own/,
    'refused BY THIS RULE — the posted-registration refusal would also refuse, with a different sentence')
})
