import assert from 'node:assert/strict'
import test from 'node:test'
import * as dispatchSyncNs from '../lib/connectors/mintsoft/sync/dispatch-sync.ts'
import type { MintsoftDispatchSyncDeps, DispatchOrderPart } from '../lib/connectors/mintsoft/sync/dispatch-sync.ts'
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

function part(partial: Partial<DispatchOrderPart>): DispatchOrderPart {
  return { externalId: 'M-1', partNumber: 1, status: 'PROCESSING', tracking: [], ...partial }
}

// Default no-op deps so each test overrides only what it exercises.
function deps(overrides: Partial<MintsoftDispatchSyncDeps>): MintsoftDispatchSyncDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    ...overrides,
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
  const { counters, logs } = await runMintsoftDispatchSyncCore(deps({
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
  }))

  assert.equal(counters.totalChecked, 2)
  assert.equal(counters.dispatched, 1)
  assert.equal(counters.pending, 1)
  assert.equal(counters.errors, 0)
  assert.deepEqual(applied, [{ orderId: 'o1', tracking: [{ trackingNumber: 'TN1', shippingService: 'DPD' }] }])
  assert.equal(logs.find((l) => l.orderId === 'o1')?.action, 'dispatched')
  assert.equal(logs.find((l) => l.orderId === 'o2')?.action, 'pending')
})

test('split reconcile: all parts despatched → each part pushed + IMS order marked dispatched', async () => {
  const pushed: Array<{ part: number; totalParts: number; items: unknown }> = []
  const applied: Array<{ orderId: string; tracking: unknown }> = []
  const { counters, logs } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', tracking: [tracking({ trackingNumber: 'TN-A', carrier: 'DPD' })] }),
      part({ externalId: 'M-2', partNumber: 2, status: 'DESPATCHED', tracking: [tracking({ trackingNumber: 'TN-B', carrier: 'RM' })] }),
    ],
    fetchPartItems: async (id) => id === 'M-1' ? [{ sku: 'A', qty: 1 }] : [{ sku: 'B', qty: 2 }],
    pushPartialShipment: async (orderId, input) => { pushed.push({ part: input.part, totalParts: input.totalParts, items: input.items }); return { ok: true } },
    applyDispatch: async (orderId, t) => { applied.push({ orderId, tracking: t }); return { success: true } },
  }))

  assert.equal(counters.dispatched, 1)
  assert.equal(counters.pending, 0)
  assert.deepEqual(pushed, [
    { part: 1, totalParts: 2, items: [{ sku: 'A', qty: 1 }] },
    { part: 2, totalParts: 2, items: [{ sku: 'B', qty: 2 }] },
  ])
  // IMS order marked SHIPPED with aggregated tracking from both parts.
  assert.deepEqual(applied, [{ orderId: 'o1', tracking: [{ trackingNumber: 'TN-A', shippingService: 'DPD' }, { trackingNumber: 'TN-B', shippingService: 'RM' }] }])
  assert.equal(logs[0]?.action, 'dispatched')
})

test('split reconcile: only some parts despatched → pushes despatched parts, stays pending, no IMS dispatch', async () => {
  const pushed: number[] = []
  let appliedCount = 0
  const { counters, logs } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', tracking: [tracking({ trackingNumber: 'TN-A' })] }),
      part({ externalId: 'M-2', partNumber: 2, status: 'ONBACKORDER' }),
    ],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId, input) => { pushed.push(input.part); return { ok: true } },
    applyDispatch: async () => { appliedCount += 1; return { success: true } },
  }))

  assert.deepEqual(pushed, [1])
  assert.equal(appliedCount, 0)
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.match(logs[0]?.reason ?? '', /1\/2 parts/)
})

test('split reconcile: a failed partial-shipment push surfaces as an error', async () => {
  const { counters, logs } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED', isSplit: true, partCount: 1 }),
    fetchOrderParts: async () => [part({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', tracking: [tracking({ trackingNumber: 'TN-A' })] })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async () => ({ ok: false, error: 'WC unreachable' }),
  }))
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(logs[0]?.action, 'error')
  assert.match(logs[0]?.reason ?? '', /WC unreachable/)
})

test('runMintsoftDispatchSyncCore treats an order missing in Mintsoft as pending, not an error', async () => {
  const { counters } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => null,
  }))
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.errors, 0)
})

test('runMintsoftDispatchSyncCore records a failed apply as an error without throwing', async () => {
  const { counters, logs } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED' }),
    applyDispatch: async () => ({ success: false, error: 'on backorder' }),
  }))
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(logs[0]?.action, 'error')
  assert.equal(logs[0]?.reason, 'on backorder')
})

test('runMintsoftDispatchSyncCore isolates a thrown fetch as a per-order error', async () => {
  const { counters } = await runMintsoftDispatchSyncCore(deps({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1001') throw new Error('Mintsoft 500')
      return status({ status: 'DESPATCHED' })
    },
  }))
  assert.equal(counters.totalChecked, 2)
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 1)
})
