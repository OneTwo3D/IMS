import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { fakeFxClient, type FakeFxRow } from '../helpers/fx-fake-client'

/**
 * o3d-q0x56.2 - THE SETTLEMENT RATE RIDES ON THE QUEUED INVOICE PAYMENT.
 *
 * Driven through the real `registerInvoicePaymentWithLedger` and `registerDeferredOrderReceipts` against a fake database (the harness shape of
 * registration-amount-enqueue-wiring.test.ts). What is read back is the payload handed to the enqueue, i.e. exactly what the Xero poster will later
 * send as the payment's CurrencyRate. Named mutations (each shown red, restored from a copy, md5-verified):
 *  a  rate-not-carried     the payload line `settlementRateToBase` is dropped: every "carries" arm goes red
 *  b  redrive-recalculates the stored rate is ignored and fx_rates is looked up again: the RE-DRIVE and LEGACY arms go red
 *  c  base-also-looked-up  a base-currency receipt is given a looked-up rate: the base arm goes red
 *  d  missing-fallback-1   a foreign receipt with no rate gets 1: the LEGACY arm goes red
 */

type QueuedRow = { type: string; payload: Record<string, unknown>; idempotencyKey?: string }

const state = {
  syncRows: [] as Array<{ id: string; status: string; externalTransactionId: null; errorMessage: null; retryCount: number; payload: Record<string, unknown> }>,
  queued: [] as QueuedRow[],
  activity: [] as Array<{ action: string; level: string; description: string; metadata: Record<string, unknown> }>,
  /**
   * `amount` is a `Prisma.Decimal` and not a number, because that is what Prisma hands back for a
   * `Decimal(18, 4)` column and the whole finding is about what the enqueue does to it. A harness
   * that stored a number here could not tell the fix from the defect.
   */
  payments: [] as Array<{ id: string; amount: Prisma.Decimal; currency: string; method: string | null; reference: string | null; paidAt: Date; settlementRateToBase?: Prisma.Decimal | null }>,
  rates: [] as FakeFxRow[],
  order: {
    id: 'order-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null as string | null,
    accountingInvoiceId: 'INV-1' as string | null,
    // o3d-j625 r3: a posted invoice records whose document it is (see SalesOrder.accountingInvoiceConnector).
    accountingInvoiceConnector: 'xero' as string | null,
    currency: 'GBP' as string,
    totalForeign: new Prisma.Decimal('100.0000') as Prisma.Decimal,
    taxForeign: new Prisma.Decimal('0.0000') as Prisma.Decimal,
    pricesIncludeVat: false,
    shoppingLinks: [] as Array<{ connector: string }>,
  },
}

// o3d-q0x56.2/.3: the payment and document posters read the base currency to tell a foreign posting from a base one.
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
      accountingSyncLog: { findMany: async () => state.syncRows },
      salesOrder: { findUnique: async () => ({ ...state.order, payments: state.payments }) },
      payment: { findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null },
      fxRate: { groupBy: async (args: never) => fakeFxClient(state.rates).fxRate.groupBy(args), findMany: async (args: never) => fakeFxClient(state.rates).fxRate.findMany(args) },
      organisation: { findFirst: async () => ({ baseCurrency: 'GBP' }) },
    },
  },
})

function txClient() {
  return {
    accountingSyncLog: {
      findMany: async () => state.syncRows,
      updateMany: async () => ({ count: 1 }),
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => state.payments.find((p) => p.id === where.id) ?? null,
      findMany: async () => state.payments,
    },
    salesOrder: { findUnique: async () => ({ ...state.order, payments: state.payments }) },
    // Both locks are no-ops here, but they must EXIST or the enqueue dies before it registers
    // anything and every count below reads zero.
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level: string; description: string; metadata: Record<string, unknown> }) => {
      state.activity.push({ action: entry.action, level: entry.level, description: entry.description, metadata: entry.metadata })
    },
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})

mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingSyncTypeEnabled: async () => true,
    isAccountingSyncTypeEnabledFor: async () => true,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getPaymentAccountMap: async () => JSON.stringify({ 'card:GBP': 'BANK-1' }), // o3d-j625 r5: production returns the setting's JSON STRING
    lookupPaymentAccount: () => 'BANK-1',
    // o3d-j625 r3: the mapped bank account IS one of the target connector's own accounts. The refusal
    // when it is not is covered by tests/accounting/invoice-payment-document-provenance.test.ts.
    accountingBankAccountBelongsTo: async () => true,
    queueAccountingSyncTxWithOutcome: async (
      _tx: unknown,
      params: { type: string; payload: Record<string, unknown>; idempotencyKey?: string },
    ) => {
      state.queued.push({ type: params.type, payload: params.payload, idempotencyKey: params.idempotencyKey })
      state.syncRows.unshift({
        id: `log-${state.queued.length}`,
        status: 'PENDING',
        externalTransactionId: null,
        errorMessage: null,
        retryCount: 0,
        payload: { ...params.payload, ...(params.idempotencyKey ? { _idempotencyKey: params.idempotencyKey } : {}) },
      })
      return { queued: true, connector: 'xero' }
    },
  },
})

async function redrive() {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: 'INV-1' }, {
    syncLogId: 'sync-1',
    connector: 'xero',
    generation: new Date('2026-08-01T00:00:00.000Z'),
    recovery: { consumer: 'sweep' },
  })
}

function receipt(amount: string, id = 'pay-1') {
  return {
    id,
    amount: new Prisma.Decimal(amount),
    currency: 'GBP',
    method: 'card',
    reference: null,
    paidAt: new Date('2026-08-20T10:00:00.000Z'),
    settlementRateToBase: null as Prisma.Decimal | null,
  }
}


const EUR = (rate: string, at: string): FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: 'EUR', rate, fetchedAt: new Date(at) })

test.beforeEach(() => {
  state.syncRows = []
  state.queued = []
  state.activity = []
  state.payments = []
  state.rates = []
  state.order.currency = 'GBP'
  state.order.accountingInvoiceId = 'INV-1'
  state.order.accountingInvoiceConnector = 'xero'
  state.order.totalForeign = new Prisma.Decimal('100.0000')
  state.order.taxForeign = new Prisma.Decimal('0.0000')
  state.order.pricesIncludeVat = false
  state.order.shoppingLinks = []
})

async function register(params: { currency: string; settlementRateToBase: number | null }) {
  const m = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  return m.registerInvoicePaymentWithLedger({
    orderId: 'order-1', orderReference: 'SO-1', paymentId: 'pay-1', amount: new Prisma.Decimal('100.0000'),
    currency: params.currency, method: 'card', reference: null, paidAt: new Date('2026-08-20T10:00:00.000Z'),
    settlementRateToBase: params.settlementRateToBase,
  })
}

test('a foreign receipt carries the settlement rate its caller resolved, and NOT a fresh lookup', async () => {
  state.order.currency = 'EUR'
  state.payments = [{ ...receipt('100.0000'), currency: 'EUR' }]
  state.rates = [EUR('9.99', '2026-08-20T09:00:00.000Z')] // a different rate sits in the table: it must not be used
  await register({ currency: 'EUR', settlementRateToBase: 1.17 })
  assert.equal(state.queued.length, 1)
  assert.equal(state.queued[0]!.payload.settlementRateToBase, 1.17)
  assert.equal(state.queued[0]!.payload.currency, 'EUR')
})

test('RE-DRIVE: the deferred re-drive carries the rate STORED with the receipt, even after a later same-day rate lands', async () => {
  state.order.currency = 'EUR'
  // recorded at the 09:00 rate of 1.20 (stored on the row); a 16:00 rate of 1.30 for the same business day landed afterwards
  state.payments = [{ ...receipt('100.0000'), currency: 'EUR', settlementRateToBase: new Prisma.Decimal('1.20000000') }]
  state.rates = [EUR('1.20', '2026-08-20T09:00:00.000Z'), EUR('1.30', '2026-08-20T16:00:00.000Z')]
  const result = await (await import('@/lib/domain/accounting/invoice-payment-enqueue')).registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: 'INV-1' }, {
    syncLogId: 'sync-1', connector: 'xero', generation: new Date('2026-08-01T00:00:00.000Z'), recovery: { consumer: 'sweep' },
  })
  assert.equal(result.settled, true)
  assert.equal(state.queued.length, 1)
  assert.equal(state.queued[0]!.payload.settlementRateToBase, 1.2, 'the stored rate, never a recalculation (1.30 is in the table)')
})

test('LEGACY: a foreign receipt with NO stored rate carries none on re-drive (the enqueue then refuses it) - no fresh lookup, never 1', async () => {
  state.order.currency = 'EUR'
  state.payments = [{ ...receipt('100.0000'), currency: 'EUR', settlementRateToBase: null }]
  state.rates = [EUR('1.30', '2026-08-20T09:00:00.000Z')] // a perfectly good rate exists: it must NOT be looked up
  await (await import('@/lib/domain/accounting/invoice-payment-enqueue')).registerDeferredOrderReceipts('order-1', { connector: 'xero', accountingInvoiceId: 'INV-1' }, {
    syncLogId: 'sync-1', connector: 'xero', generation: new Date('2026-08-01T00:00:00.000Z'), recovery: { consumer: 'sweep' },
  })
  assert.equal(state.queued.length, 1)
  assert.equal('settlementRateToBase' in state.queued[0]!.payload, false)
})

test('a base-currency receipt carries no settlement rate (stored null)', async () => {
  state.payments = [receipt('100.0000')]
  state.rates = [EUR('1.17', '2026-08-20T09:00:00.000Z')]
  await register({ currency: 'GBP', settlementRateToBase: null })
  assert.equal(state.queued.length, 1)
  assert.equal('settlementRateToBase' in state.queued[0]!.payload, false)
})
