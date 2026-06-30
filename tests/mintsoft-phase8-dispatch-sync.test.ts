import assert from 'node:assert/strict'
import test from 'node:test'
import * as sweepNs from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import * as mintsoftOrdersNs from '../lib/connectors/mintsoft/api/orders.ts'
import type { WmsOrderStatus, WmsOrderTracking, WmsOrderPart } from '../lib/connectors/wms/types.ts'

const sweep = 'default' in sweepNs
  ? sweepNs.default as typeof import('../lib/domain/wms/dispatch-sweep.ts')
  : sweepNs
const { toFulfillmentTracking, runWmsDispatchSweepCore } = sweep

const mintsoftOrders = 'default' in mintsoftOrdersNs
  ? mintsoftOrdersNs.default as typeof import('../lib/connectors/mintsoft/api/orders.ts')
  : mintsoftOrdersNs
const { isMintsoftDispatched } = mintsoftOrders

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
    dispatched: false,
    raw: null,
    ...partial,
  }
}

function part(partial: Partial<WmsOrderPart>): WmsOrderPart {
  return { externalId: 'M-1', partNumber: 1, status: 'PROCESSING', dispatched: false, tracking: [], ...partial }
}

// Default no-op deps so each test overrides only what it exercises.
function deps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    ...overrides,
  }
}

// --- Mintsoft's connector-specific dispatched detection (normalised onto WmsOrderStatus) ---

test('isMintsoftDispatched: DESPATCHED / INVOICED count as dispatched, case-insensitive', () => {
  assert.equal(isMintsoftDispatched({ status: 'DESPATCHED', tracking: [] }), true)
  assert.equal(isMintsoftDispatched({ status: 'Despatched', tracking: [] }), true)
  assert.equal(isMintsoftDispatched({ status: 'INVOICED', tracking: [] }), true)
})

test('isMintsoftDispatched: a despatch timestamp on tracking counts even when the status lags', () => {
  assert.equal(isMintsoftDispatched({ status: 'PROCESSING', tracking: [tracking({ despatchedAt: '2026-06-30T10:00:00Z' })] }), true)
})

test('isMintsoftDispatched: not-yet-dispatched statuses are false', () => {
  assert.equal(isMintsoftDispatched({ status: 'PROCESSING', tracking: [] }), false)
  assert.equal(isMintsoftDispatched({ status: 'ONBACKORDER', tracking: [] }), false)
  assert.equal(isMintsoftDispatched({ status: '', tracking: [] }), false)
})

// --- Generic dispatch sweep core (reads the normalised status.dispatched / part.dispatched) ---

test('toFulfillmentTracking maps carrier->shippingService and drops entries without a tracking number', () => {
  assert.deepEqual(
    toFulfillmentTracking([
      tracking({ trackingNumber: 'TN1', carrier: 'DPD' }),
      tracking({ trackingNumber: null, carrier: 'Royal Mail' }),
    ]),
    [{ trackingNumber: 'TN1', shippingService: 'DPD' }],
  )
})

test('runWmsDispatchSweepCore applies dispatch for despatched orders only', async () => {
  const applied: Array<{ orderId: string; tracking: unknown }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (orderNumber) =>
      orderNumber === 'WC-1001'
        ? status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1', carrier: 'DPD' })] })
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
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A', carrier: 'DPD' })] }),
      part({ externalId: 'M-2', partNumber: 2, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-B', carrier: 'RM' })] }),
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
  assert.deepEqual(applied, [{ orderId: 'o1', tracking: [{ trackingNumber: 'TN-A, TN-B', shippingService: 'DPD' }] }])
  assert.equal(logs[0]?.action, 'dispatched')
})

test('split reconcile: a despatched part with no line items holds off completion (not silently shipped)', async () => {
  let appliedCount = 0
  const pushed: number[] = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED', dispatched: true, isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
      part({ externalId: 'M-2', partNumber: 2, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-B' })] }),
    ],
    fetchPartItems: async (id) => id === 'M-1' ? [{ sku: 'A', qty: 1 }] : [], // part 2 has no items
    pushPartialShipment: async (orderId, input) => { pushed.push(input.part); return { ok: true } },
    applyDispatch: async () => { appliedCount += 1; return { success: true } },
  }))
  assert.deepEqual(pushed, [1])
  assert.equal(appliedCount, 0)
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.match(logs[0]?.reason ?? '', /no line items/)
})

test('split reconcile: uses part count as the authoritative total (no early completion)', async () => {
  let appliedCount = 0
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED', dispatched: true, isSplit: true, partCount: 3 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
      part({ externalId: 'M-2', partNumber: 2, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-B' })] }),
    ],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    applyDispatch: async () => { appliedCount += 1; return { success: true } },
  }))
  assert.equal(appliedCount, 0) // 2/3 → not completed even though both visible parts shipped
  assert.equal(counters.pending, 1)
})

test('split reconcile: only some parts despatched → pushes despatched parts, stays pending, no IMS dispatch', async () => {
  const pushed: number[] = []
  let appliedCount = 0
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
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
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED', dispatched: true, isSplit: true, partCount: 1 }),
    fetchOrderParts: async () => [part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async () => ({ ok: false, error: 'WC unreachable' }),
  }))
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(logs[0]?.action, 'error')
  assert.match(logs[0]?.reason ?? '', /WC unreachable/)
})

test('merge: a merged order repoints its link to the survivor, then dispatches under the survivor number', async () => {
  const repoints: Array<{ linkId: string; to: { externalOrderId: string; externalOrderNumber: string } }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({
      externalOrderId: 'M-SURV',
      externalOrderNumber: 'WC-1001+WC-1002',
      status: 'DESPATCHED',
      dispatched: true,
      isMerged: true,
      tracking: [tracking({ trackingNumber: 'TN-S', carrier: 'DPD' })],
    }),
    repointLink: async (linkId, to) => { repoints.push({ linkId, to }) },
    applyDispatch: async () => ({ success: true }),
  }))
  assert.deepEqual(repoints, [{ linkId: 'l1', to: { externalOrderId: 'M-SURV', externalOrderNumber: 'WC-1001+WC-1002' } }])
  assert.equal(counters.dispatched, 1)
  assert.equal(logs[0]?.action, 'dispatched')
})

test('merge + split: survivor number used to fetch parts; reconciled ATOMICALLY (no per-part pushes)', async () => {
  const partsFetchedFor: string[] = []
  const pushed: number[] = []
  let appliedCount = 0
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({
      externalOrderId: 'M-SURV',
      externalOrderNumber: 'WC-1001+WC-1002',
      status: 'PROCESSING',
      isMerged: true,
      isSplit: true,
      partCount: 2,
    }),
    fetchOrderParts: async (orderNumber) => {
      partsFetchedFor.push(orderNumber)
      return [
        part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
        part({ externalId: 'M-2', partNumber: 2, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-B' })] }),
      ]
    },
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId, input) => { pushed.push(input.part); return { ok: true } },
    applyDispatch: async () => { appliedCount += 1; return { success: true } },
  }))
  assert.deepEqual(partsFetchedFor, ['WC-1001+WC-1002']) // survivor number, not "WC-1001"
  assert.deepEqual(pushed, [])  // merged → NO per-part partial shipments (would cross-contaminate)
  assert.equal(appliedCount, 1) // but still marked shipped atomically once all parts despatched
  assert.equal(counters.dispatched, 1)
})

test('non-merged split still pushes per-part', async () => {
  const pushed: number[] = []
  await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'PROCESSING', isSplit: true, partCount: 1 }),
    fetchOrderParts: async () => [part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId, input) => { pushed.push(input.part); return { ok: true } },
  }))
  assert.deepEqual(pushed, [1])
})

test('runWmsDispatchSweepCore treats an order missing in the WMS as pending, not an error', async () => {
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => null,
  }))
  assert.equal(counters.pending, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.errors, 0)
})

test('runWmsDispatchSweepCore records a failed apply as an error without throwing', async () => {
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ status: 'DESPATCHED', dispatched: true }),
    applyDispatch: async () => ({ success: false, error: 'on backorder' }),
  }))
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 0)
  assert.equal(logs[0]?.action, 'error')
  assert.equal(logs[0]?.reason, 'on backorder')
})

test('runWmsDispatchSweepCore isolates a thrown fetch as a per-order error', async () => {
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1001') throw new Error('Mintsoft 500')
      return status({ status: 'DESPATCHED', dispatched: true })
    },
  }))
  assert.equal(counters.totalChecked, 2)
  assert.equal(counters.errors, 1)
  assert.equal(counters.dispatched, 1)
})
