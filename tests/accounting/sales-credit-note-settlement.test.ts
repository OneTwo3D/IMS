import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import {
  CREDIT_NOTE_ALLOCATION_SETTING_KEY,
  invoiceHasReceiptEvidence,
  OPERATOR_ATTENTION_REASONS,
  isCreditNoteAllocationEnabled,
  planCreditNoteSettlement,
  refundPaymentMethodOf,
  type CreditNoteSettlementFacts,
} from '@/lib/domain/accounting/credit-note-allocation'
import { probeXeroSettlement, type XeroFetcher } from '@/lib/connectors/accounting-settlement-probe'
import { findSwitch } from '@/lib/domain/settings/system-switches'
import { isMoneyMovingSyncType } from '@/lib/domain/accounting/followup-retry-guard'
import { moneyPostDateFieldFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { WRITER_OWNERSHIP_MAP } from '@/lib/security/writer-ownership-map'

/**
 * o3d-hqvrp.39 - settling a posted sales credit note: the PLAN (allocate or refund), the refund payment's request, the ledger probe's refund arm, and the
 * registrations that keep the new type inside the money fences. No network and no database: the Xero client is a double.
 */

function facts(over: Omit<Partial<CreditNoteSettlementFacts>, 'order' | 'refund'> & { order?: Partial<CreditNoteSettlementFacts['order']>; refund?: Partial<CreditNoteSettlementFacts['refund']> } = {}): CreditNoteSettlementFacts {
  const { order, refund, ...rest } = over
  return {
    refund: { id: 'refund-1', orderId: 'order-1', deleted: false, creditNoteId: 'cn-xero-1', creditNoteConnector: 'xero', shopRefund: false, createdAt: new Date('2026-11-01T10:00:00Z'), ...refund },
    order: { id: 'order-1', currency: 'GBP', invoiceId: 'inv-xero-1', invoiceConnector: 'xero', paidAt: null, fxRateToBase: toDecimal(1), paymentMethod: null, ...order },
    creditNotePosted: true,
    invoicePosted: true,
    receiptCount: 0,
    receiptTotal: toDecimal(0),
    invoicePaymentRows: 0,
    recordedRefundCash: toDecimal(0),
    refundPaymentMethod: null,
    refundPaymentPaidAt: null,
    originalReceiptMethod: null,
    refundedViaGateway: null,
    priorCashOut: toDecimal(0),
    siblingSettled: false,
    ...rest,
  }
}

test('an invoice with no receipt behind it is ALLOCATED to (the settle-invoice case)', () => {
  assert.deepEqual(planCreditNoteSettlement(facts()), { kind: 'ALLOCATE' })
})

test('every kind of receipt evidence makes the invoice PAID: a Payment, a registered payment, the paid flag', () => {
  assert.equal(invoiceHasReceiptEvidence(facts()), false)
  assert.equal(invoiceHasReceiptEvidence(facts({ receiptCount: 1, receiptTotal: toDecimal(10) })), true)
  assert.equal(invoiceHasReceiptEvidence(facts({ invoicePaymentRows: 1 })), true)
  assert.equal(invoiceHasReceiptEvidence(facts({ order: { paidAt: new Date() } })), true)
})

test('a PAID invoice is never allocated: a refund the GATEWAY paid back is refunded in cash, capped at the receipts', () => {
  const plan = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(100), refundedViaGateway: true, refund: { shopRefund: true } }))
  assert.equal(plan.kind, 'REFUND_PAYMENT')
  assert.equal(plan.kind === 'REFUND_PAYMENT' && plan.cashEvidence, 'GATEWAY')
  assert.equal(plan.kind === 'REFUND_PAYMENT' && plan.cap.toFixed(), '100')
})

test('a WooCommerce refund made MANUALLY (refunded_payment false) posts no bank refund: no cash left the bank, and an operator is told', () => {
  const plan = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(100), refundedViaGateway: false, refund: { shopRefund: true } }))
  assert.equal(plan.kind, 'NOT_NOW')
  assert.equal(plan.kind === 'NOT_NOW' && plan.reason, 'REFUND_NOT_PAID_BY_GATEWAY')
  assert.ok(OPERATOR_ATTENTION_REASONS.has('REFUND_NOT_PAID_BY_GATEWAY'))
})

test('a WooCommerce refund recorded before the flag was kept (unknown) fails closed: no bank refund, an operator is told', () => {
  const plan = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(100), refundedViaGateway: null, refund: { shopRefund: true } }))
  assert.equal(plan.kind === 'NOT_NOW' && plan.reason, 'REFUND_CASH_UNKNOWN')
  assert.ok(OPERATOR_ATTENTION_REASONS.has('REFUND_CASH_UNKNOWN'))
})

test('EVERY refund payment is capped by the receipts recorded less the cash already out: a 10 receipt pays out at most 10, nothing when nothing is left', () => {
  const small = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(10), refundedViaGateway: true, refund: { shopRefund: true } }))
  assert.equal(small.kind === 'REFUND_PAYMENT' && small.cap.toFixed(), '10')
  const recorded = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(10), recordedRefundCash: toDecimal(50) }))
  assert.equal(recorded.kind === 'REFUND_PAYMENT' && recorded.cap.toFixed(), '10', 'even a recorded refund payment is capped')
  const spent = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(10), priorCashOut: toDecimal(10), refundedViaGateway: true, refund: { shopRefund: true } }))
  assert.equal(spent.kind === 'NOT_NOW' && spent.reason, 'NO_RECEIPT_CAPACITY')
})

test('a PAID invoice with an operator-recorded refund payment is refunded for the recorded amount', () => {
  const plan = planCreditNoteSettlement(facts({ invoicePaymentRows: 1, receiptTotal: toDecimal(100), recordedRefundCash: toDecimal('42.5') }))
  assert.equal(plan.kind, 'REFUND_PAYMENT')
  assert.equal(plan.kind === 'REFUND_PAYMENT' && plan.cashEvidence, 'RECORDED')
  assert.equal(plan.kind === 'REFUND_PAYMENT' && plan.recordedAmount?.toFixed(), '42.5')
})

test('a PAID invoice, a manual refund, no refund payment recorded: nothing says cash left the bank, so it waits', () => {
  const plan = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(100) }))
  assert.equal(plan.kind, 'NOT_NOW')
  assert.equal(plan.kind === 'NOT_NOW' && plan.reason, 'CASH_REFUND_NOT_RECORDED')
})

test('a PART-PAID invoice counts as paid: refunded up to the cap, never split', () => {
  const plan = planCreditNoteSettlement(facts({ receiptCount: 1, receiptTotal: toDecimal(30), refundedViaGateway: true, refund: { shopRefund: true } }))
  assert.equal(plan.kind, 'REFUND_PAYMENT')
})

test('nothing is settled until BOTH documents are posted, and only for Xero documents', () => {
  assert.equal((planCreditNoteSettlement(facts({ creditNotePosted: false })) as { reason: string }).reason, 'CREDIT_NOTE_NOT_POSTED')
  assert.equal((planCreditNoteSettlement(facts({ invoicePosted: false })) as { reason: string }).reason, 'INVOICE_NOT_POSTED')
  assert.equal((planCreditNoteSettlement(facts({ refund: { creditNoteId: null } })) as { reason: string }).reason, 'CREDIT_NOTE_NOT_POSTED')
  assert.equal((planCreditNoteSettlement(facts({ order: { invoiceId: null } })) as { reason: string }).reason, 'INVOICE_NOT_POSTED')
  assert.equal((planCreditNoteSettlement(facts({ refund: { creditNoteConnector: null } })) as { reason: string }).reason, 'DOCUMENT_NOT_XEROS')
  assert.equal((planCreditNoteSettlement(facts({ order: { invoiceConnector: 'quickbooks' } })) as { reason: string }).reason, 'DOCUMENT_NOT_XEROS')
})

test('a deleted refund, or one another row already settled, is not settled again', () => {
  assert.equal((planCreditNoteSettlement(facts({ refund: { deleted: true } })) as { reason: string }).reason, 'REFUND_DELETED')
  assert.equal((planCreditNoteSettlement(facts({ siblingSettled: true })) as { reason: string }).reason, 'ALREADY_SETTLED')
})

test('the refund goes out by the ORIGINAL receipt\'s method, then the recorded refund payment\'s, then the order\'s', () => {
  const base = facts()
  assert.equal(refundPaymentMethodOf({ ...base, originalReceiptMethod: 'stripe', refundPaymentMethod: 'paypal', order: { ...base.order, paymentMethod: 'bacs' } }), 'stripe')
  assert.equal(refundPaymentMethodOf({ ...base, originalReceiptMethod: null, refundPaymentMethod: 'paypal', order: { ...base.order, paymentMethod: 'bacs' } }), 'paypal')
  assert.equal(refundPaymentMethodOf({ ...base, originalReceiptMethod: null, refundPaymentMethod: null, order: { ...base.order, paymentMethod: ' bacs ' } }), 'bacs')
  assert.equal(refundPaymentMethodOf(base), null)
})

test('the switch reads ON only for the exact string true, and is a registered system switch, off by default', async () => {
  const read = (value: string | null) => isCreditNoteAllocationEnabled({
    setting: { findUnique: async () => (value === null ? null : { value }) },
  } as never)
  assert.equal(await read(null), false)
  for (const v of ['TRUE', '1', 'yes', 'false', '']) assert.equal(await read(v), false, v)
  assert.equal(await read('true'), true)
  const def = findSwitch(CREDIT_NOTE_ALLOCATION_SETTING_KEY)
  assert.ok(def, 'registered as a system switch')
  assert.equal(def.defaultValue, 'false')
})

test('the new type is inside every money fence and owned by Xeroom (shadowed) in P1 and P2', () => {
  assert.equal(isMoneyMovingSyncType('CREDIT_NOTE_ALLOCATION'), true)
  assert.equal(moneyPostDateFieldFor('CREDIT_NOTE_ALLOCATION'), 'date')
  const owners = WRITER_OWNERSHIP_MAP.filter((entry) => (entry.accountingSyncTypes ?? []).includes('CREDIT_NOTE_ALLOCATION'))
  assert.equal(owners.length, 1)
  assert.deepEqual({ P1: owners[0]!.owners.P1, P2: owners[0]!.owners.P2 }, { P1: 'xeroom', P2: 'xeroom' })
  const creditNote = WRITER_OWNERSHIP_MAP.find((entry) => (entry.accountingSyncTypes ?? []).includes('CREDIT_NOTE'))!
  assert.deepEqual(owners[0]!.owners, creditNote.owners, 'the settlement follows the credit note it settles')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The refund payment's request, and what refuses it before anything is sent. The Xero client is a double.
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Call = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown; opts?: unknown }
const calls: Call[] = []
let creditNote: Record<string, unknown> = {}
let loadedCreditNotes: typeof import('@/lib/connectors/xero/credit-notes') | null = null
async function creditNotes() {
  if (loadedCreditNotes) return loadedCreditNotes
  const realApi = await import('@/lib/connectors/xero/api')
  mock.module('@/lib/connectors/xero/api', {
    namedExports: {
      ...realApi,
      xeroGet: async (path: string) => {
        calls.push({ method: 'GET', path })
        return { ok: true, status: 200, data: { CreditNotes: [creditNote] } }
      },
      xeroPost: async (path: string, body: unknown, opts?: unknown) => {
        calls.push({ method: 'POST', path, body, opts })
        return { ok: true, status: 200, data: { Payments: [{ PaymentID: 'pay-1' }] } }
      },
    },
  })
  loadedCreditNotes = await import('@/lib/connectors/xero/credit-notes')
  return loadedCreditNotes
}

const refundParams = { creditNoteId: 'cn-xero-1', accountId: 'acc-1', amount: 40, date: '2026-11-02', currencyRate: 0.833333, reference: 'ims-mark-1' }

test('the refund is a Payment against the CREDIT NOTE from the mapped account, carrying IMS\'s rate (the realised FX) and IMS\'s mark', async () => {
  calls.length = 0
  creditNote = { CreditNoteID: 'cn-xero-1', RemainingCredit: 60, Status: 'AUTHORISED' }
  const { refundSalesCreditNote } = await creditNotes()
  const result = await refundSalesCreditNote(refundParams, { idempotencyKey: 'row-key' })
  assert.deepEqual(result, { success: true, paymentId: 'pay-1' })
  const post = calls.find((call) => call.method === 'POST')!
  assert.equal(post.path, 'Payments')
  assert.deepEqual(post.body, {
    CreditNote: { CreditNoteID: 'cn-xero-1' },
    Account: { AccountID: 'acc-1' },
    Date: '2026-11-02',
    Amount: 40,
    CurrencyRate: 0.833333,
    Reference: 'ims-mark-1',
  })
  const { deriveCreditNoteRefundIdempotencyKey } = await creditNotes()
  assert.equal((post.opts as { idempotencyKey: string }).idempotencyKey, deriveCreditNoteRefundIdempotencyKey('row-key', 'cn-xero-1', 'acc-1', 4000))
})

test('a base-currency refund sends no CurrencyRate', async () => {
  calls.length = 0
  creditNote = { CreditNoteID: 'cn-xero-1', RemainingCredit: 60, Status: 'AUTHORISED' }
  const baseParams = { ...refundParams, currencyRate: undefined }
  const { refundSalesCreditNote } = await creditNotes()
  await refundSalesCreditNote(baseParams, { idempotencyKey: 'row-key' })
  assert.equal('CurrencyRate' in (calls.find((c) => c.method === 'POST')!.body as object), false)
})

test('more than the credit left is REFUSED and nothing is sent (an allocation or refund already landed)', async () => {
  calls.length = 0
  creditNote = { CreditNoteID: 'cn-xero-1', RemainingCredit: 10, Status: 'AUTHORISED' }
  const { refundSalesCreditNote } = await creditNotes()
  const result = await refundSalesCreditNote(refundParams, { idempotencyKey: 'row-key' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /10\.00 credit remaining/)
  assert.equal(calls.some((call) => call.method === 'POST'), false)
})

test('a credit note that is not AUTHORISED is refused and nothing is sent', async () => {
  calls.length = 0
  creditNote = { CreditNoteID: 'cn-xero-1', RemainingCredit: 100, Status: 'DRAFT' }
  const { refundSalesCreditNote } = await creditNotes()
  const result = await refundSalesCreditNote(refundParams, { idempotencyKey: 'row-key' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /DRAFT/)
  assert.equal(calls.some((call) => call.method === 'POST'), false)
})

test('a response about ANOTHER credit note is unknown, not a balance: nothing is sent', async () => {
  calls.length = 0
  creditNote = { CreditNoteID: 'some-other-credit-note', RemainingCredit: 100, Status: 'AUTHORISED' }
  const { refundSalesCreditNote } = await creditNotes()
  const result = await refundSalesCreditNote(refundParams, { idempotencyKey: 'row-key' })
  assert.equal(result.success, false)
  assert.equal(calls.some((call) => call.method === 'POST'), false)
})

test('a changed request never reuses a key: the amount and the account are in the derived Idempotency-Key', async () => {
  const { deriveCreditNoteRefundIdempotencyKey } = await creditNotes()
  const a = deriveCreditNoteRefundIdempotencyKey('row', 'cn', 'acc', 4000)
  assert.notEqual(a, deriveCreditNoteRefundIdempotencyKey('row', 'cn', 'acc', 4001))
  assert.notEqual(a, deriveCreditNoteRefundIdempotencyKey('row', 'cn', 'acc2', 4000))
  assert.equal(a, deriveCreditNoteRefundIdempotencyKey('row', 'CN', 'ACC', 4000), 'case does not change the identity of the documents')
  assert.ok(a.length <= 128)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The ledger probe: on a retry, a refund that landed is FOUND (so it is not paid twice), and an allocation is not mistaken for it.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const probeNote = (over: Record<string, unknown>): XeroFetcher => (async (path: string) => {
  if (path.startsWith('CreditNotes/')) {
    return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-xero-1', CurrencyCode: 'GBP', Total: 100, RemainingCredit: 60, Allocations: [], Payments: [{ PaymentID: 'pay-1', Amount: 40, Status: 'AUTHORISED', PaymentType: 'ARCREDITPAYMENT' }], ...over }] } }
  }
  if (path.startsWith('Payments/')) {
    return { ok: true, status: 200, data: { Payments: [{ PaymentID: 'pay-1', Status: 'AUTHORISED', PaymentType: 'ARCREDITPAYMENT', Amount: 40 }] } }
  }
  return { ok: false, status: 404, error: 'not found' }
}) as XeroFetcher

test('the probe reads a landed REFUND as a record (so the retry finds it), and the allocation arm does not see it as an allocation', async () => {
  const refund = await probeXeroSettlement({
    type: 'CREDIT_NOTE_ALLOCATION',
    payload: { operation: 'REFUND_PAYMENT', creditNoteId: 'cn-xero-1', accountingInvoiceId: 'inv-xero-1', amount: 40, date: '2026-11-02' },
  } as never, probeNote({}))
  assert.equal(refund.ok, true)
  if (refund.ok) {
    assert.equal(refund.records.length, 1)
    assert.equal(refund.records[0]!.amount?.toFixed(), '40')
    assert.equal(refund.provedComplete, true)
  }
  const allocation = await probeXeroSettlement({
    type: 'CREDIT_NOTE_ALLOCATION',
    payload: { operation: 'ALLOCATE', creditNoteId: 'cn-xero-1', accountingInvoiceId: 'inv-xero-1', amount: 40, date: '2026-11-02' },
  } as never, probeNote({}))
  assert.equal(allocation.ok, true)
  if (allocation.ok) assert.equal(allocation.records.length, 0, 'a refund payment is not an allocation to the invoice')
})

test('a DELETED refund payment is not a record: the credit is back and the refund may be posted', async () => {
  const fetcher = (async (path: string) => {
    if (path.startsWith('CreditNotes/')) {
      return { ok: true, status: 200, data: { CreditNotes: [{ CreditNoteID: 'cn-xero-1', CurrencyCode: 'GBP', Total: 100, RemainingCredit: 100, Allocations: [], Payments: [{ PaymentID: 'pay-1', Amount: 40, Status: 'DELETED', PaymentType: 'ARCREDITPAYMENT' }] }] } }
    }
    return { ok: true, status: 200, data: { Payments: [{ PaymentID: 'pay-1', Status: 'DELETED', PaymentType: 'ARCREDITPAYMENT', Amount: 40 }] } }
  }) as XeroFetcher
  const probe = await probeXeroSettlement({
    type: 'CREDIT_NOTE_ALLOCATION',
    payload: { operation: 'REFUND_PAYMENT', creditNoteId: 'cn-xero-1', accountingInvoiceId: 'inv-xero-1', amount: 40, date: '2026-11-02' },
  } as never, fetcher)
  assert.equal(probe.ok, true)
  if (probe.ok) assert.equal(probe.records.length, 0)
})
