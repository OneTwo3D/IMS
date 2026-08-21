import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-ekn8 — DB WIRING for the deferred-receipt re-drive.
 *
 * Round 1 covered `selectReceiptsAwaitingRegistration` and `decideInvoicePaymentRegistration` as pure
 * functions and stopped there, so nothing checked the part that actually moves money: that
 * `registerDeferredOrderReceipts` re-reads the LIVE sync rows between receipts, so the second receipt is
 * measured against an invoice the first has already consumed part of. Get that wrong — hoist the read,
 * or re-use the selection snapshot — and a two-receipt order double-settles its invoice, with every
 * pure test still green.
 *
 * This drives the real function against a stateful fake database.
 */

type QueuedRow = { type: string; payload: Record<string, unknown>; idempotencyKey?: string }

const state = {
  syncRows: [] as Array<{ status: string; externalTransactionId: null; errorMessage: null; retryCount: number; payload: Record<string, unknown> }>,
  queued: [] as QueuedRow[],
  activity: [] as Array<{ action: string; level: string; metadata: Record<string, unknown> }>,
  payments: [] as Array<{ id: string; amount: number; currency: string; method: string | null; reference: string | null; paidAt: Date }>,
  order: {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null as string | null,
    accountingInvoiceId: 'INV-1' as string | null,
    currency: 'GBP',
    totalForeign: 100,
    taxForeign: 0,
    pricesIncludeVat: false,
    shoppingLinks: [] as Array<{ connector: string }>,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
      accountingSyncLog: { findMany: async () => state.syncRows },
      salesOrder: {
        findUnique: async () => ({
          ...state.order,
          payments: state.payments,
        }),
      },
      payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
    },
  },
})

function txClient() {
  return {
    accountingSyncLog: { findMany: async () => state.syncRows },
    payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
  }
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level: string; metadata: Record<string, unknown> }) => {
      state.activity.push({ action: entry.action, level: entry.level, metadata: entry.metadata })
    },
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})

mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getPaymentAccountMap: async () => ({ default: 'BANK-1' }),
    lookupPaymentAccount: () => 'BANK-1',
    queueAccountingSyncTx: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      state.queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      // A queued row is immediately live and visible to the next receipt's capacity read — which is the
      // whole behaviour under test.
      state.syncRows.unshift({
        status: 'PENDING',
        externalTransactionId: null,
        errorMessage: null,
        retryCount: 0,
        payload: params.payload,
      })
      return true
    },
  },
})

async function redrive() {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerDeferredOrderReceipts('order-1')
}

test.beforeEach(() => {
  state.syncRows = []
  state.queued = []
  state.activity = []
  state.payments = []
  state.order.accountingInvoiceId = 'INV-1'
  state.order.totalForeign = 100
  state.order.taxForeign = 0
  state.order.pricesIncludeVat = false
  state.order.shoppingLinks = []
})

test('each receipt is measured against what the PREVIOUS one already consumed', async () => {
  // Two GBP 100 receipts against a GBP 100 invoice. Only the first fits; the second must be refused
  // with a named reason, not queued behind it.
  state.payments = [
    { id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') },
    { id: 'pay-2', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02') },
  ]

  await redrive()

  assert.equal(state.queued.length, 1, 'exactly one receipt may be registered against a fully consumed invoice')
  assert.equal(state.queued[0].idempotencyKey, 'invoice-payment:payment:pay-1')
  assert.equal(state.queued[0].payload.paymentId, 'pay-1')

  const refusals = state.activity.filter((a) => a.action === 'invoice_payment_not_registered')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].metadata.refusal, 'WOULD_OVERPAY')
  assert.equal(refusals[0].metadata.paymentId, 'pay-2')
  assert.equal(refusals[0].metadata.alreadyRegistered, 100)
})

test('a deposit and a balance that together fit are BOTH registered', async () => {
  // The guard must not collapse back into one-payment-per-order, which is the key mistake o3d-cjt8
  // corrected in the first place.
  state.payments = [
    { id: 'pay-1', amount: 40, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') },
    { id: 'pay-2', amount: 60, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-02') },
  ]

  await redrive()

  assert.deepEqual(state.queued.map((q) => q.idempotencyKey), [
    'invoice-payment:payment:pay-1',
    'invoice-payment:payment:pay-2',
  ])
  assert.equal(state.activity.filter((a) => a.action === 'invoice_payment_not_registered').length, 0)
})

test('an UNATTRIBUTED live registration suppresses the whole re-drive', async () => {
  // The imported-order shape: the SALES_INVOICE follow-up registered a receipt with no local Payment
  // row, so it cannot be matched to one, and "which receipt is this?" unanswered has to read as
  // "possibly that one".
  state.syncRows = [{ status: 'PENDING', externalTransactionId: null, errorMessage: null, retryCount: 0, payload: { amount: 100, accountingInvoiceId: 'INV-1' } }]
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
  // And not merely refused downstream: the receipt is never CONSIDERED, so no refusal is reported
  // either. Asserting only "nothing was queued" would pass on the capacity arithmetic alone and stop
  // pinning the suppression rule at all.
  assert.deepEqual(state.activity, [])
})

test('a receipt that already has its OWN sync row is never re-driven', async () => {
  // A FAILED row may have committed remotely before failing; re-driving it here would post under a
  // token the ledger has never seen. That belongs to the retry path, which pins the token.
  state.syncRows = [{ status: 'FAILED', externalTransactionId: null, errorMessage: null, retryCount: 3, payload: { amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1' } }]
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
})

test('nothing is re-driven while the invoice has not posted', async () => {
  state.order.accountingInvoiceId = null
  state.payments = [{ id: 'pay-1', amount: 100, currency: 'GBP', method: 'card', reference: null, paidAt: new Date('2026-08-01') }]

  await redrive()

  assert.equal(state.queued.length, 0)
  // The re-drive exists precisely BECAUSE DOCUMENT_NOT_POSTED already warned once at the moment the
  // receipt was recorded; returning early is what stops it warning again on every invoice sync. A bare
  // "nothing queued" assertion would also be satisfied by falling through to a NO_BANK_ACCOUNT refusal.
  assert.deepEqual(state.activity, [])
})
