import assert from 'node:assert/strict'
import test from 'node:test'
import * as dispatchSyncNs from '../lib/connectors/mintsoft/sync/dispatch-sync.ts'
import type { WmsOrderStatus, WmsOrderTracking } from '../lib/connectors/wms/types.ts'

const dispatchSync = 'default' in dispatchSyncNs
  ? dispatchSyncNs.default as typeof import('../lib/connectors/mintsoft/sync/dispatch-sync.ts')
  : dispatchSyncNs

const {
  isMintsoftDispatched,
  toFulfillmentTracking,
  runMintsoftDispatchSyncCore,
} = dispatchSync

function tracking(partial: Partial<WmsOrderTracking>): WmsOrderTracking {
  return { trackingNumber: null, carrier: null, despatchedAt: null, ...partial }
}

function status(partial: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1',
    externalOrderNumber: 'WC-1001',
    status: 'PROCESSING',
    statusLabel: 'Processing',
    isSplit: false,
    partCount: null,
    isMerged: false,
    mergedOrderNumbers: [],
    deepLinkUrl: null,
    tracking: [],
    raw: null,
    ...partial,
  }
}

test('isMintsoftDispatched: DESPATCHED / INVOICED count as dispatched, case-insensitive', () => {
  assert.equal(isMintsoftDispatched(status({ status: 'DESPATCHED' })), true)
  assert.equal(isMintsoftDispatched(status({ status: 'Despatched' })), true)
  assert.equal(isMintsoftDispatched(status({ status: 'INVOICED' })), true)
})

test('isMintsoftDispatched: a despatch timestamp on tracking counts even when the status lags', () => {
  assert.equal(
    isMintsoftDispatched(status({ status: 'PROCESSING', tracking: [tracking({ despatchedAt: '2026-06-30T10:00:00Z' })] })),
    true,
  )
})

test('isMintsoftDispatched: not-yet-dispatched statuses are false', () => {
  assert.equal(isMintsoftDispatched(status({ status: 'PROCESSING' })), false)
  assert.equal(isMintsoftDispatched(status({ status: 'ONBACKORDER' })), false)
  assert.equal(isMintsoftDispatched(status({ status: '' })), false)
})

test('toFulfillmentTracking maps carrier->shippingService and drops entries without a tracking number', () => {
  assert.deepEqual(
    toFulfillmentTracking([
      tracking({ trackingNumber: 'TN1', carrier: 'DPD' }),
      tracking({ trackingNumber: null, carrier: 'Royal Mail' }),
    ]),
    [{ trackingNumber: 'TN1', shippingService: 'DPD' }],
  )
})

test('runMintsoftDispatchSyncCore applies dispatch for despatched orders only', async () => {
  const applied: Array<{ orderId: string; tracking: unknown }> = []
  const { counters, logs } = await runMintsoftDispatchSyncCore({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (orderNumber) =>
      orderNumber === 'WC-1001'
        ? status({ status: 'DESPATCHED', tracking: [tracking({ trackingNumber: 'TN1', carrier: 'DPD' })] })
        : status({ status: 'PROCESSING' }),
    applyDispatch: async (orderId, t) => {
      applied.push({ orderId, tracking: t })
      return { success: true }
    },
  })

  assert.equal(counters.totalChecked, 2)
  assert.equal(counters.dispatched, 1)
  assert.equal(counters.pending, 1)
  assert.equal(counters.errors, 0)
  assert.deepEqual(applied, [{ orderId: 'o1', tracking: [{ trackingNumber: 'TN1', shippingService: 'DPD' }] }])
  assert.equal(logs.find((l) => l.orderId === 'o1')?.action, 'dispatched')
  assert.equal(logs.find((l) => l.orderId === 'o2')?.action, 'pending')
})

test('runMintsoftDispatchSyncCore defers a despatched SPLIT order instead of marking it fully shipped', async () => {
  const applied: string[] = []
  const { counters, logs } = await runMintsoftDispatchSyncCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () =>
      status({ status: 'DESPATCHED', isSplit: true, partCount: 2, tracking: [tracking({ trackingNumber: 'TN1' })] }),
    applyDispatch: async (orderId) => {
      applied.push(orderId)
      return { success: true }
    },
  })
  assert.deepEqual(applied, [])
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.pending, 1)
  assert.match(logs[0]?.reason ?? '', /split/i)
})

test('runMintsoftDispatchSyncCore treats an order missing in Mintsoft as pending, not an error', async () => {
  const { counters } = await runMintsoftDispatchSyncCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
  })
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.errors, 0)
})

test('runMintsoftDispatchSyncCore records a failed apply as an error without throwing', async () => {
  const { counters, logs } = await runMintsoftDispatchSyncCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED' }),
    applyDispatch: async () => ({ success: false, error: 'on backorder' }),
  })
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(logs[0]?.action, 'error')
  assert.equal(logs[0]?.reason, 'on backorder')
})

test('runMintsoftDispatchSyncCore isolates a thrown fetch as a per-order error', async () => {
  const { counters } = await runMintsoftDispatchSyncCore({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1001') throw new Error('Mintsoft 500')
      return status({ status: 'DESPATCHED' })
    },
    applyDispatch: async () => ({ success: true }),
  })
  assert.equal(counters.totalChecked, 2)
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 1)
})
