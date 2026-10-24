import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import * as realAccounting from '@/lib/accounting'
import * as realRefundService from '@/lib/domain/sales/refund-service'

/**
 * o3d-q0x56.8 - the credit-note retry loads the refund's conversion rate from the order's BOOKED rate
 * (`loadRefundAccountingQueueInput`). A foreign order without a usable stored rate makes the retry fail by name
 * instead of handing the connector a credit note converted at 1; nothing is queued.
 */

type Row = Record<string, unknown>
const state = { order: null as Row | null, queued: 0, activity: [] as Array<{ action: string }> }

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
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: { action: string }) => { state.activity.push(entry) }, redactActivityLogText: (v: string) => v },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/accounting', {
  namedExports: {
    ...realAccounting,
    getAccountingSettings: async () => ({ connector: null, syncEnabled: false }),
    isAccountingSyncTypeEnabledFor: async () => false,
    queueAccountingSync: async () => { state.queued++; return { queued: true } },
  },
})
mock.module('@/lib/domain/sales/refund-service', {
  namedExports: {
    ...realRefundService,
    retrySalesOrderRefundAccounting: async () => ({ success: true, refundId: 'rf-1', orderId: 'so-1', accountingSyncs: [], returnedRows: [], refundOrderRef: 'SO-1' }),
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrderRefund: {
        findUnique: async () => ({
          id: 'rf-1', orderId: 'so-1', creditNoteNumber: 'CN-1', order: state.order, lines: [],
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      setting: { findUnique: async () => null, findMany: async () => [] },
    },
  },
})

async function retry() {
  const { retryRefundAccounting } = await import('@/app/actions/sales')
  return retryRefundAccounting('rf-1')
}

test.beforeEach(() => { state.queued = 0; state.activity = [] })

test('[q0x56.8] a foreign order with no usable stored rate fails the retry by name and queues nothing', async () => {
  for (const fxRateToBase of [0, -1]) {
    state.order = { fxRateToBase, currency: 'USD', orderNumber: 'SO-1', externalOrderNumber: null }
    const result = await retry()
    assert.equal(result.success, false, String(fxRateToBase))
    assert.match(String(result.error), /Order SO-1 is in USD but has no usable stored FX rate to GBP/)
    assert.equal(state.queued, 0)
  }
})

test('[q0x56.8] a foreign order WITH a rate, and a base-currency order without one, load fine (the guard is the only difference)', async () => {
  for (const order of [
    { fxRateToBase: 1.25, currency: 'USD' },
    { fxRateToBase: 0, currency: 'GBP' },
  ]) {
    state.order = { ...order, orderNumber: 'SO-1', externalOrderNumber: null }
    const result = await retry()
    assert.doesNotMatch(String(result.error ?? ''), /stored FX rate/, JSON.stringify(order))
  }
})
