import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import { settlementMarkerFor, type LedgerSettlementProbe } from '@/lib/domain/accounting/ledger-settlement-evidence'
import {
  NO_LIVE_RECEIPTS,
  isProvenDifferentPayment,
  liveReceiptsFrom,
  partitionByPaymentIdentity,
  setAsideRecordsOfOtherPayments,
} from '@/lib/domain/accounting/payment-identity'
import {
  decideInvoicePaymentRegistration,
  postedRegistrationsOnDocument,
  type ExistingInvoicePaymentSync,
} from '@/lib/domain/accounting/invoice-payment-registration'
import { decideInvoicePaymentPost, type PostedInvoicePaymentRegistration } from '@/lib/domain/accounting/invoice-payment-capacity'
import { planManualRetry } from '@/lib/domain/accounting/followup-retry-guard'

/**
 * THE PARTITION, AND EVERY GATE THAT ASKS IT (registration, capacity guard, retry planner).
 * The fence has its own file (payment-identity-fence.test.ts); the agreement table at the end drives the
 * registration decision and the fence through the same scenarios.
 */

const ORDER = 'so-1'
const LIVE = liveReceiptsFrom([
  { id: 'pay-dep', orderId: ORDER, refundId: null },
  { id: 'pay-bal', orderId: ORDER, refundId: null },
  { id: 'pay-other-order', orderId: 'so-2', refundId: null },
  { id: 'pay-refund', orderId: ORDER, refundId: 'refund-1' },
])
const target = { paymentId: 'pay-bal', orderId: ORDER }

test('partition: only a live receipt of the SAME order with a different id is proven different', () => {
  const rivals = [
    { n: 'different live', paymentId: 'pay-dep' },
    { n: 'equal id', paymentId: 'pay-bal' },
    { n: 'null id', paymentId: null },
    { n: 'undefined id', paymentId: undefined },
    { n: 'deleted receipt', paymentId: 'pay-gone' },
    { n: 'other order', paymentId: 'pay-other-order' },
    { n: 'refund payment', paymentId: 'pay-refund' },
  ]
  const { same, different } = partitionByPaymentIdentity(target, rivals, LIVE)
  assert.deepEqual(different.map((r) => r.n), ['different live'])
  assert.deepEqual(same.map((r) => r.n), ['equal id', 'null id', 'undefined id', 'deleted receipt', 'other order', 'refund payment'])
})

test('partition: a target with no receipt, or no order, proves nothing different', () => {
  const rival = { paymentId: 'pay-dep' }
  assert.equal(isProvenDifferentPayment({ paymentId: null, orderId: ORDER }, rival, LIVE), false)
  assert.equal(isProvenDifferentPayment({ paymentId: 'pay-bal', orderId: null }, rival, LIVE), false)
  assert.equal(isProvenDifferentPayment(target, rival, NO_LIVE_RECEIPTS), false)
  assert.equal(isProvenDifferentPayment(target, rival, LIVE), true)
})

test('attribution: by mark only; one record per mark; a record carrying the target\'s own mark is never set aside', () => {
  const rec = (id: string, reference: string | null) => ({ id, amount: toDecimal(10), date: '2026-08-01', reference })
  const probe: LedgerSettlementProbe = { ok: true, provedComplete: true, records: [rec('A', 'x IMS-aaa y'), rec('B', 'IMS-bbb'), rec('C', null), rec('D', 'IMS-aaa IMS-own')] }
  // IMS-aaa is on A and D => two records => ambiguous, nothing set aside for it.
  const dup = setAsideRecordsOfOtherPayments(probe, ['IMS-aaa'], 'IMS-own')
  assert.deepEqual(dup.ambiguous, [{ mark: 'IMS-aaa', count: 2 }])
  assert.equal(dup.setAside.length, 0)
  const one = setAsideRecordsOfOtherPayments(probe, ['IMS-bbb', 'IMS-nobody'], 'IMS-own')
  assert.deepEqual(one.setAside.map((r) => r.id), ['B'])
  assert.deepEqual(one.probe.ok && one.probe.records.map((r) => r.id), ['A', 'C', 'D'])
  assert.equal(one.probe.ok && one.probe.provedComplete, true, 'completeness is carried: the set-aside record was READ')
  const own = setAsideRecordsOfOtherPayments({ ok: true, provedComplete: true, records: [rec('D', 'IMS-bbb IMS-own')] }, ['IMS-bbb'], 'IMS-own')
  assert.equal(own.setAside.length, 0, 'it may be this payment\'s own')
  const failed = setAsideRecordsOfOtherPayments({ ok: false, reason: 'down' }, ['IMS-bbb'], null)
  assert.deepEqual(failed.probe, { ok: false, reason: 'down' })
})

// ------------------------------------------------------------------------------------------- registration

function row(over: Partial<ExistingInvoicePaymentSync> & { status: ExistingInvoicePaymentSync['status'] }): ExistingInvoicePaymentSync {
  return {
    externalTransactionId: null,
    abandonedBeforeRemoteCall: null,
    settlementBasis: null,
    amount: 40,
    registeredAmount: { kind: 'stated', amount: toDecimal(over.amount ?? 40) },
    paymentDate: '2026-08-02',
    accountingInvoiceId: 'INV-1',
    ...over,
  }
}

const regBase = {
  orderId: ORDER,
  liveReceipts: LIVE,
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentAmount: toDecimal(60),
  paymentId: 'pay-bal',
  bankAccountId: 'BANK-1',
  existing: [] as ExistingInvoicePaymentSync[],
  ledgerSettlements: null as LedgerSettlementProbe | null,
  ledgerTotal: toDecimal(100),
}
const emptyLedger: LedgerSettlementProbe = { ok: true, provedComplete: true, records: [] }

test('P4 registration: a FAILED deposit of a live different receipt does not refuse the balance, but its money counts', () => {
  const failedDeposit = row({ id: 'log-dep', status: 'FAILED', paymentId: 'pay-dep', amount: 40 })
  const ok = decideInvoicePaymentRegistration({ ...regBase, existing: [failedDeposit], ledgerSettlements: null })
  assert.equal(ok.register, true, 'no probe needed to register a different receipt')
  // Capacity: 40 counted, so a 61 balance does not fit...
  const over = decideInvoicePaymentRegistration({ ...regBase, paymentAmount: toDecimal(61), existing: [failedDeposit], ledgerSettlements: null })
  assert.equal(over.register === false && over.refusal, 'WOULD_OVERPAY')
  // ...unless the ledger reads clear for it, which frees the capacity (the deposit never posted).
  const freed = decideInvoicePaymentRegistration({ ...regBase, paymentAmount: toDecimal(100), existing: [failedDeposit], ledgerSettlements: emptyLedger })
  assert.equal(freed.register, true)
})

test('registration: the SAME receipt\'s FAILED row, a null-identity row and a deleted receipt\'s row still refuse', () => {
  for (const [label, paymentId] of [['same receipt', 'pay-bal'], ['null identity', null], ['deleted receipt', 'pay-gone']] as const) {
    const existing = [row({ id: 'log-x', status: 'FAILED', paymentId })]
    // The own receipt's rows are exempt from the unresolved test by design (retry path), so the null/deleted
    // ones are the ones that must refuse without a probe.
    const d = decideInvoicePaymentRegistration({ ...regBase, existing, ledgerSettlements: null })
    if (label === 'same receipt') assert.equal(d.register, true, 'a receipt\'s own row never blocks its own registration')
    else assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT', label)
  }
})

test('registration: a posted registration of a DIFFERENT receipt no longer blocks a lift; a null-identity one does', () => {
  const posted = (paymentId: string | null) => [row({ id: 'log-p', status: 'SYNCED', paymentId, externalTransactionId: 'PAY-P' })]
  assert.equal(postedRegistrationsOnDocument(posted('pay-dep'), 'pay-bal', 'INV-1', { orderId: ORDER, liveReceipts: LIVE }).length, 0)
  assert.equal(postedRegistrationsOnDocument(posted(null), 'pay-bal', 'INV-1', { orderId: ORDER, liveReceipts: LIVE }).length, 1)
  assert.equal(postedRegistrationsOnDocument(posted('pay-dep'), 'pay-bal', 'INV-1', { orderId: ORDER, liveReceipts: NO_LIVE_RECEIPTS }).length, 1)
})

// ------------------------------------------------------------------------------------------- capacity guard

function reg(over: Partial<PostedInvoicePaymentRegistration> & { id: string; status: string }): PostedInvoicePaymentRegistration {
  return {
    externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null,
    registeredAmount: toDecimal(40), accountingInvoiceId: 'INV-1', paymentId: null,
    bodyCouldHavePosted: true, provenNeverAttempted: false, ...over,
  }
}
const cap = (registrations: PostedInvoicePaymentRegistration[], amount = 60, liveReceipts = LIVE) =>
  decideInvoicePaymentPost({ orderId: ORDER, liveReceipts, entryId: 'log-bal', accountingInvoiceId: 'INV-1', amount: toDecimal(amount), ledgerTotal: toDecimal(100), currency: 'GBP', registrations })

test('capacity guard: a FAILED row of a different live receipt is COUNTED, not ambiguous; the same receipt\'s FAILED row still is', () => {
  const self = reg({ id: 'log-bal', status: 'PROCESSING', paymentId: 'pay-bal', registeredAmount: toDecimal(60) })
  const dep = reg({ id: 'log-dep', status: 'FAILED', paymentId: 'pay-dep' })
  assert.equal(cap([self, dep]).post, true)
  const tooMuch = cap([self, dep], 61)
  assert.equal(tooMuch.post === false && tooMuch.refusal, 'WOULD_OVERPAY')
  assert.equal(tooMuch.post === false && tooMuch.alreadyPosted?.toFixed(), '40')
  const unreadable = cap([self, reg({ id: 'log-dep', status: 'FAILED', paymentId: 'pay-dep', registeredAmount: null })])
  assert.equal(unreadable.post === false && unreadable.refusal, 'LEDGER_AMOUNT_UNKNOWN')
  for (const paymentId of ['pay-bal', null, 'pay-gone']) {
    const v = cap([self, reg({ id: 'log-old', status: 'FAILED', paymentId })])
    assert.equal(v.post === false && v.refusal, 'AMBIGUOUS_FAILED_REGISTRATION', String(paymentId))
  }
  const noReceipts = cap([self, dep], 60, NO_LIVE_RECEIPTS)
  assert.equal(noReceipts.post === false && noReceipts.refusal, 'AMBIGUOUS_FAILED_REGISTRATION', 'unreadable receipts keep today\'s refusal')
})

// ------------------------------------------------------------------------------------------- retry planner

const postable = { accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1', currency: 'GBP' }
const DEP = { ...postable, amount: 50, paymentDate: '2026-08-02', paymentId: 'pay-dep' }
const BAL = { ...postable, amount: 50, paymentDate: '2026-08-02', paymentId: 'pay-bal' }

test('P5 retry: a FAILED balance beside a SYNCED deposit is allowed once the ledger (deposit set aside by mark) is clear', () => {
  const depToken = 'log-dep'
  const ledger: LedgerSettlementProbe = {
    ok: true, provedComplete: true,
    records: [{ id: 'PAY-DEP', amount: toDecimal(50), date: '2026-08-02', reference: settlementMarkerFor(depToken) }],
  }
  const siblings = [
    { id: 'log-dep', effectiveToken: depToken, payload: DEP, status: 'SYNCED' },
    { id: 'log-bal', effectiveToken: 'log-bal', payload: BAL, status: 'FAILED' },
  ]
  const args = { type: 'INVOICE_PAYMENT', reference: 'SalesOrder so-1', target: siblings[1]!, siblings, ledger }
  assert.deepEqual(planManualRetry({ ...args, identity: { orderId: ORDER, liveReceipts: LIVE } }), { action: 'allow' })
  // The control: with receipts unreadable the deposit is "possibly the same" and the retry refuses.
  assert.equal(planManualRetry({ ...args, identity: { orderId: ORDER, liveReceipts: NO_LIVE_RECEIPTS } }).action, 'refuse')
  // The same receipt's own earlier SYNCED row still refuses.
  const dup = [{ id: 'log-bal-1', effectiveToken: 'log-bal-1', payload: BAL, status: 'SYNCED' }, siblings[1]!]
  const dupLedger: LedgerSettlementProbe = { ok: true, provedComplete: true, records: [{ id: 'PAY-B1', amount: toDecimal(50), date: '2026-08-02', reference: settlementMarkerFor('log-bal-1') }] }
  assert.equal(planManualRetry({ ...args, siblings: dup, ledger: dupLedger, identity: { orderId: ORDER, liveReceipts: LIVE } }).action, 'refuse')
})

test('retry: a live (PENDING) row of a different receipt does not occupy this receipt\'s slot; the same receipt\'s does', () => {
  const target = { id: 'log-bal', effectiveToken: 'log-bal', payload: BAL, status: 'FAILED' }
  const pendingDep = { id: 'log-dep', effectiveToken: 'log-dep', payload: DEP, status: 'PENDING' }
  const identity = { orderId: ORDER, liveReceipts: LIVE }
  const common = { type: 'INVOICE_PAYMENT', reference: 'SalesOrder so-1', target, ledger: emptyLedger, identity }
  assert.deepEqual(planManualRetry({ ...common, siblings: [pendingDep, target] }), { action: 'allow' })
  const pendingSame = { ...pendingDep, id: 'log-bal-2', effectiveToken: 'log-bal', payload: BAL }
  assert.equal(planManualRetry({ ...common, siblings: [pendingSame, target] }).action, 'refuse')
})

test('retry: a different payment\'s mark on two ledger records refuses', () => {
  const target = { id: 'log-bal', effectiveToken: 'log-bal', payload: BAL, status: 'FAILED' }
  const dep = { id: 'log-dep', effectiveToken: 'log-dep', payload: DEP, status: 'SYNCED' }
  const m = settlementMarkerFor('log-dep')
  const ledger: LedgerSettlementProbe = { ok: true, provedComplete: true, records: [
    { id: 'A', amount: toDecimal(50), date: '2026-08-02', reference: m }, { id: 'B', amount: toDecimal(50), date: '2026-08-03', reference: m }] }
  const plan = planManualRetry({ type: 'INVOICE_PAYMENT', reference: 'SalesOrder so-1', target, siblings: [dep, target], ledger, identity: { orderId: ORDER, liveReceipts: LIVE } })
  assert.equal(plan.action, 'refuse')
})

// ------------------------------------------------------------------------------------------- agreement

let xeroData: unknown
mock.module('@/lib/connectors/xero/api', {
  namedExports: { xeroGet: async () => ({ ok: true, status: 200, data: xeroData }) },
})

/**
 * REGISTRATION AND FENCE MUST AGREE. For every scenario: if the registration decision says `register`, the
 * post fence must say `proceed`. (The converse need not hold - the fence reads the ledger as it is now.)
 * Each scenario describes one rival registration beside a balance receipt, and the ledger as it stands.
 */
test('agreement: whatever the registration decision lets through, the post fence lets through', async () => {
  const { authoriseMoneyPost } = await import('@/lib/connectors/accounting-settlement-probe')
  const depToken = 'log-dep'
  const depMark = settlementMarkerFor(depToken)
  const scenarios: Array<{ name: string; rival: Record<string, unknown>; status: ExistingInvoicePaymentSync['status']; receipts: string[]; ledger: unknown[] }> = [
    { name: 'P1 SYNCED deposit, marked', rival: { paymentId: 'pay-dep' }, status: 'SYNCED', receipts: ['pay-dep', 'pay-bal'], ledger: [{ PaymentID: 'P', Date: '2026-08-02', Amount: 40, Reference: depMark }] },
    { name: 'P3 FAILED deposit, marked', rival: { paymentId: 'pay-dep' }, status: 'FAILED', receipts: ['pay-dep', 'pay-bal'], ledger: [{ PaymentID: 'P', Date: '2026-08-02', Amount: 40, Reference: depMark }] },
    { name: 'FAILED deposit, never posted', rival: { paymentId: 'pay-dep' }, status: 'FAILED', receipts: ['pay-dep', 'pay-bal'], ledger: [] },
    { name: 'D5 null identity SYNCED', rival: {}, status: 'SYNCED', receipts: ['pay-bal'], ledger: [{ PaymentID: 'P', Date: '2026-08-02', Amount: 40, Reference: depMark }] },
    { name: 'D6 deleted receipt SYNCED', rival: { paymentId: 'pay-dep' }, status: 'SYNCED', receipts: ['pay-bal'], ledger: [{ PaymentID: 'P', Date: '2026-08-02', Amount: 40, Reference: depMark }] },
    { name: 'D6 deleted receipt FAILED', rival: { paymentId: 'pay-dep' }, status: 'FAILED', receipts: ['pay-bal'], ledger: [{ PaymentID: 'P', Date: '2026-08-02', Amount: 40, Reference: depMark }] },
  ]
  const verdicts: string[] = []
  for (const sc of scenarios) {
    const live = liveReceiptsFrom(sc.receipts.map((id) => ({ id, orderId: ORDER, refundId: null })))
    const rivalPayload = { ...postable, amount: 40, paymentDate: '2026-08-02', ...sc.rival }
    const paid = 40
    const probe: LedgerSettlementProbe = { ok: true, provedComplete: true, records: sc.ledger.map((p) => {
      const r = p as { PaymentID: string; Date: string; Amount: number; Reference: string }
      return { id: r.PaymentID, amount: toDecimal(r.Amount), date: r.Date, reference: r.Reference }
    }) }
    const decision = decideInvoicePaymentRegistration({
      ...regBase,
      liveReceipts: live,
      existing: [row({ id: 'log-dep', status: sc.status, paymentId: (sc.rival.paymentId as string | undefined) ?? null, amount: paid })],
      ledgerSettlements: probe,
    })
    xeroData = { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 100 - (sc.ledger.length ? paid : 0), AmountPaid: sc.ledger.length ? paid : 0, Payments: sc.ledger }] }
    const rows = [
      { id: 'log-bal', remoteAttemptedAt: null as Date | null, payload: { ...postable, amount: 60, paymentDate: '2026-08-09', paymentId: 'pay-bal' } },
      { id: 'log-dep', remoteAttemptedAt: new Date('2026-08-02T10:00:00Z'), payload: rivalPayload },
    ]
    const fence = await authoriseMoneyPost({
      connector: 'xero', entryId: 'log-bal', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: ORDER,
      payload: rows[0]!.payload, postingDate: '2026-08-09',
      db: {
        accountingSyncLog: {
          updateMany: async () => ({ count: 1 }),
          findMany: async () => rows.filter((r) => r.remoteAttemptedAt !== null).map((r) => ({ id: r.id, payload: r.payload })),
        },
        payment: { findMany: async () => sc.receipts.map((id) => ({ id, orderId: ORDER, refundId: null })) },
      } as never,
    })
    verdicts.push(`${sc.name}: register=${decision.register} proceed=${fence.proceed}`)
    if (decision.register) assert.equal(fence.proceed, true, `${sc.name}: registered but the fence refuses`)
  }
  console.log(verdicts.join('\n'))
  assert.ok(verdicts.some((v) => v.includes('register=true proceed=true')), 'the table must contain a scenario that passes both gates, or the implication is vacuous')
  assert.ok(verdicts.some((v) => v.includes('register=false')), 'and one that refuses, so the table is not all-pass')
})
