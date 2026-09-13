import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-j625 r3 (Codex HIGH 3) — THE ORDINARY addPayment REGISTRATION: TWO CONNECTOR-NATIVE IDs THAT THE
 * ACTIVE CONNECTOR DOES NOT SPEAK FOR.
 *
 * `registerInvoicePaymentWithLedger` UNPINNED — the shape `addPayment` calls — resolves `connectorId`
 * from the active connector, then builds a payload carrying `so.accountingInvoiceId` (retained across a
 * connector switch by design) and a `bankAccountId` out of `getPaymentAccountMap()` (ONE global
 * settings row whose values are one connector's native account ids). r2 routed the row by
 * `connectorId` and called that provenance; these tests pin what replaced it:
 *
 *   - the invoice's RECORDED connector (`SalesOrder.accountingInvoiceConnector`) must equal the
 *     connector the payment posts to — absent or different REFUSES (DOCUMENT_PROVENANCE_UNPROVEN);
 *   - the mapped bank account must be one of THAT connector's stored bank accounts — otherwise
 *     PAYMENT_ACCOUNT_NOT_IN_LEDGER;
 *   - and the enqueue is handed `documentConnector`, so its own runtime guard is the backstop.
 *
 * It also covers r2's untested message: an enqueue that REFUSES under the lock surfaces as
 * POSTING_CONTEXT_CHANGED, reported rather than dropped.
 */

const state = {
  active: 'xero' as string,
  bankBelongs: true,
  enqueueAnswer: { queued: true, connector: 'xero' } as { queued: boolean; reason?: string; connector: string | null },
  belongsCalls: [] as Array<{ connector: string; id: string }>,
  queued: [] as Array<{ payload: Record<string, unknown>; chartConnector: unknown; documentConnector: unknown }>,
  activity: [] as Array<{ action: string; metadata: Record<string, unknown>; description: string }>,
  order: {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null as string | null,
    accountingInvoiceId: 'INV-1' as string | null,
    accountingInvoiceConnector: 'xero' as string | null,
    currency: 'GBP',
    totalForeign: new Prisma.Decimal('100.0000'),
    taxForeign: new Prisma.Decimal('0.0000'),
    pricesIncludeVat: false,
    shoppingLinks: [] as Array<{ connector: string }>,
  },
}

const payment = { id: 'pay-1', amount: new Prisma.Decimal('40.0000'), currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-20T10:00:00.000Z') }

function client() {
  return {
    accountingSyncLog: { findMany: async () => [], findFirst: async () => null, updateMany: async () => ({ count: 0 }), count: async () => 0 },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === payment.id ? payment : null),
      findMany: async () => [payment],
    },
    salesOrder: { findUnique: async () => ({ ...state.order, payments: [payment] }) },
    accountingFollowUpObligation: { findMany: async () => [], findFirst: async () => null },
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: { ...client(), $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client()) },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; description: string; metadata: Record<string, unknown> }) => {
      state.activity.push({ action: entry.action, description: entry.description, metadata: entry.metadata })
    },
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: state.active, name: state.active }),
    getPaymentAccountMap: async () => '{"card:*":"XERO-BANK-1"}',
    lookupPaymentAccount: () => 'XERO-BANK-1',
    accountingBankAccountBelongsTo: async (connector: string, id: string) => {
      state.belongsCalls.push({ connector, id })
      return state.bankBelongs
    },
    queueAccountingSyncTxWithOutcome: async (
      _tx: unknown,
      params: { payload: Record<string, unknown>; chartConnector: unknown; documentConnector?: unknown },
    ) => {
      state.queued.push({ payload: params.payload, chartConnector: params.chartConnector, documentConnector: params.documentConnector })
      return state.enqueueAnswer
    },
  },
})

async function register() {
  const { registerInvoicePaymentWithLedger } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  await registerInvoicePaymentWithLedger({
    orderId: 'order-1',
    orderReference: 'SO-1',
    paymentId: payment.id,
    amount: payment.amount,
    currency: 'GBP',
    method: 'card',
    reference: null,
    paidAt: payment.paidAt,
  })
}

function refusals(): unknown[] {
  return state.activity.map((a) => a.metadata?.refusal).filter((r) => r !== undefined)
}

test.beforeEach(() => {
  state.active = 'xero'
  state.bankBelongs = true
  state.enqueueAnswer = { queued: true, connector: 'xero' }
  state.belongsCalls = []
  state.queued = []
  state.activity = []
  state.order.accountingInvoiceId = 'INV-1'
  state.order.accountingInvoiceConnector = 'xero'
})

test('[o3d-j625 r3 HIGH 3] PRECONDITION: an invoice recorded as the active connector’s, paid to one of its own accounts, IS queued', async () => {
  await register()
  assert.equal(state.queued.length, 1, `the control registers. Activity: ${JSON.stringify(state.activity)}`)
  assert.equal(state.queued[0].chartConnector, 'xero')
  assert.equal(state.queued[0].documentConnector, 'xero', 'and the enqueue is told whose document it carries')
  assert.deepEqual(state.belongsCalls, [{ connector: 'xero', id: 'XERO-BANK-1' }], 'the bank account was CONFIRMED against the target connector')
})

test('[o3d-j625 r3 HIGH 3] an invoice link with NO recorded connector is REFUSED — fail closed, never assumed to be the active one', async () => {
  state.order.accountingInvoiceConnector = null
  await register()
  assert.equal(state.queued.length, 0, 'nothing may be queued against a document whose ledger is unknown')
  assert.deepEqual(refusals(), ['DOCUMENT_PROVENANCE_UNPROVEN'])
  const notice = state.activity.find((a) => a.metadata?.refusal === 'DOCUMENT_PROVENANCE_UNPROVEN')
  assert.match(String(notice?.description), /cannot establish which accounting connector holds the invoice/)
})

test('[o3d-j625 r3 HIGH 3] an invoice recorded as the OTHER connector’s is REFUSED after a switch', async () => {
  // The Xero invoice id survived the switch to QuickBooks. r2 routed by `connectorId` (quickbooks) and
  // approved the payment.
  state.active = 'quickbooks'
  state.enqueueAnswer = { queued: true, connector: 'quickbooks' }
  state.order.accountingInvoiceConnector = 'xero'
  await register()
  assert.equal(state.queued.length, 0)
  assert.deepEqual(refusals(), ['DOCUMENT_PROVENANCE_UNPROVEN'])
})

test('[o3d-j625 r3 HIGH 3] a mapped bank account that is NOT one of the target connector’s is REFUSED, and told apart from no mapping', async () => {
  state.bankBelongs = false
  await register()
  assert.equal(state.queued.length, 0, 'a payment naming an account the ledger does not hold is not sent')
  assert.deepEqual(refusals(), ['PAYMENT_ACCOUNT_NOT_IN_LEDGER'])
  const notice = state.activity.find((a) => a.metadata?.refusal === 'PAYMENT_ACCOUNT_NOT_IN_LEDGER')
  assert.match(String(notice?.description), /SINGLE setting shared by every accounting connector/)
})

test('[o3d-j625 r2 message] an enqueue that REFUSES under the lock is reported as POSTING_CONTEXT_CHANGED, not dropped', async () => {
  state.enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero' }
  await register()
  assert.equal(state.queued.length, 1, 'PRECONDITION: the enqueue was reached and answered')
  assert.deepEqual(refusals(), ['POSTING_CONTEXT_CHANGED'], 'the receipt is reported as not registered')
  assert.equal(state.activity[0]?.action, 'invoice_payment_not_registered')
})
