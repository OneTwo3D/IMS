import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { fakeFxClient, type FakeFxRow } from '../helpers/fx-fake-client'

/**
 * o3d-q0x56.4 / .16 - addPayment (the customer-receipt caller of the settlement resolver), driven through the REAL
 * server action with the database recorded rather than mocked away.
 *
 * WHICH REFUSAL, AND WHY (see the comment in addPayment): a foreign receipt whose currency has no rate is refused
 * BEFORE the Payment row is created, so nothing is written (no Payment, no order update, no ledger registration).
 * The alternative - record the receipt and hold the FX journal - was rejected because nothing retries a held journal.
 */

type Row = Record<string, unknown>

const state = {
  order: null as Row | null,
  rates: [] as FakeFxRow[],
  created: [] as Row[],
  updates: [] as Row[],
  updateManys: [] as Row[],
  registered: [] as Row[],
  asOfs: [] as Date[],
}

function foreignOrder(overrides: Row = {}): Row {
  return {
    id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'SHIPPED', refundStatus: null,
    currency: 'USD', totalForeign: 100, totalBase: 80, fxRateToBase: 1.25, paidAt: null, invoiceNumber: 'INV-1',
    ...overrides,
  }
}

const tx = {
  $queryRaw: async () => [],
  $executeRaw: async () => 0,
  salesOrder: {
    findUnique: async () => state.order,
    update: async (args: Row) => { state.updates.push(args); return { id: 'so-1' } },
    updateMany: async (args: Row) => { state.updateManys.push(args); return { count: 1 } },
  },
  payment: {
    findMany: async () => [],
    create: async (args: { data: Row }) => { state.created.push(args.data); return { id: 'pay-1', paidAt: args.data.paidAt, amount: args.data.amount } },
  },
  salesOrderRefund: { findFirst: async (): Promise<{ totalForeign: number } | null> => null },
  fxRate: {
    groupBy: async (args: { where: { fetchedAt: { lte: Date } } }) => { state.asOfs.push(args.where.fetchedAt.lte); return fakeFxClient(state.rates).fxRate.groupBy(args as never) },
    findMany: async (args: never) => fakeFxClient(state.rates).fxRate.findMany(args),
  },
  activityLog: { create: async () => ({}) },
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requirePermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, redactActivityLogText: (value: string) => value } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/invoice-payment-enqueue', {
  namedExports: {
    registerInvoicePaymentWithLedger: async (args: Row) => { state.registered.push(args); return null },
    loadInvoicePaymentSyncRows: async () => [],
    payloadPaymentId: () => null,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...tx,
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      setting: { findUnique: async () => null },
    },
  },
})

async function addPayment(input: Row) {
  const mod = await import('../../app/actions/sales.ts')
  return mod.addPayment(input as never)
}

test.beforeEach(() => {
  state.order = foreignOrder()
  state.rates = []
  state.created = []
  state.updates = []
  state.updateManys = []
  state.registered = []
  state.asOfs = []
})

const usd = (rate: string, at: string): FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: 'USD', rate, fetchedAt: new Date(at) })
const receipt = (extra: Row = {}) => ({ orderId: 'so-1', amount: 100, currency: 'USD', method: 'Bank Transfer', paidAt: '2026-08-20', ...extra })

test('a foreign receipt with NO rate is refused by name and NOTHING is written', async () => {
  const result = await addPayment(receipt())
  assert.equal(result.success, false)
  assert.match(String(result.error), /Payment not recorded/)
  assert.match(String(result.error), /Missing GBP FX rate for USD/)
  assert.match(String(result.error), /Settings -> Currencies/)
  assert.equal(state.created.length, 0, 'no Payment row')
  assert.equal(state.updates.length + state.updateManys.length, 0, 'no order update (paid flag, provenance)')
  assert.equal(state.registered.length, 0, 'no ledger registration')
})

test('an ambiguous or non-positive stored rate also refuses, writing nothing', async () => {
  for (const rows of [[usd('1.2', '2026-08-19T00:00:00Z'), usd('1.3', '2026-08-19T00:00:00Z')], [usd('0', '2026-08-19T00:00:00Z')]]) {
    state.rates = rows
    const result = await addPayment(receipt())
    assert.equal(result.success, false)
    assert.equal(state.created.length, 0)
  }
})

test('the booked order rate is NOT a substitute: an order with a perfectly good fxRateToBase still refuses', async () => {
  state.order = foreignOrder({ fxRateToBase: 1.25 })
  const result = await addPayment(receipt())
  assert.equal(result.success, false)
  assert.equal(state.created.length, 0)
})

test('a BASE-currency receipt is still recorded, at 1, without reading the table', async () => {
  state.order = foreignOrder({ currency: 'GBP', fxRateToBase: 1, totalBase: 100 })
  const result = await addPayment(receipt({ currency: 'GBP' }))
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.created.length, 1)
  assert.equal(state.asOfs.length, 0)
  // o3d-q0x56.2: a base-currency receipt states there is no settlement rate to carry (null), not "unknown" (undefined, which would trigger a lookup).
  assert.equal((state.registered[0] as { settlementRateToBase?: number | null }).settlementRateToBase, null)
  assert.equal((state.created[0] as { settlementRateToBase?: number | null }).settlementRateToBase, null, 'a base-currency receipt stores null')
})

test('a refund-payment (refundId) never needs a rate: it produces no FX journal, so it is recorded with no rate in the table', async () => {
  // the refund exists and the payment settles it; the table is EMPTY and the receipt still goes through
  const original = tx.salesOrderRefund.findFirst
  tx.salesOrderRefund.findFirst = async () => ({ totalForeign: 100 })
  try {
    const result = await addPayment(receipt({ refundId: 'rf-1' }))
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(state.created.length, 1)
    assert.equal(state.asOfs.length, 0, 'the rate table was never read')
  } finally {
    tx.salesOrderRefund.findFirst = original
  }
})

test('[q0x56.16] a date-only paidAt looks the rate up as of the END of that day, and a 09:00 same-day rate is used', async () => {
  state.rates = [usd('1.25', '2026-08-19T09:00:00.000Z'), usd('1.60', '2026-08-20T09:00:00.000Z')]
  const result = await addPayment(receipt({ paidAt: '2026-08-20' }))
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.asOfs.length, 1)
  assert.equal(state.asOfs[0].toISOString(), '2026-08-20T23:59:59.999Z')
  // the stored paidAt is exactly what it was before the change
  assert.equal((state.created[0].paidAt as Date).toISOString(), '2026-08-20T00:00:00.000Z')
  // o3d-q0x56.2: the SAME rate that was resolved for this receipt is handed to the ledger registration, to ride on the queued payment as its CurrencyRate.
  assert.equal(state.registered.length, 1)
  assert.equal((state.registered[0] as { settlementRateToBase?: number | null }).settlementRateToBase, 1.6)
  assert.equal((state.created[0] as { settlementRateToBase?: number | null }).settlementRateToBase, 1.6, 'and the SAME rate is STORED with the receipt, which is what every re-drive reads')
})

test('[q0x56.16] a real timestamp stays an instant: a rate fetched AFTER it is not visible', async () => {
  state.rates = [usd('1.60', '2026-08-20T09:00:00.000Z')]
  const early = await addPayment(receipt({ paidAt: '2026-08-20T08:00:00.000Z' }))
  assert.equal(early.success, false, 'the 09:00 rate does not exist yet at 08:00')
  assert.equal(state.asOfs[0].toISOString(), '2026-08-20T08:00:00.000Z')
  const late = await addPayment(receipt({ paidAt: '2026-08-20T10:00:00.000Z' }))
  assert.equal(late.success, true, JSON.stringify(late))
})
