import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsDispatchSweepCore,
  formatCursorInTimeZone,
} from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderStatus, WmsOrderTracking, WmsOrderPart } from '../lib/connectors/wms/types.ts'

// --- Fixtures --------------------------------------------------------------

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

function deps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    ...overrides,
  }
}

const NOW = new Date('2026-07-15T12:00:00Z')
const RECENT = new Date('2026-07-15T11:59:00Z').toISOString() // < 1800s ago → reconcile NOT due

// --- Timezone-correct cursor conversion ------------------------------------

test('formatCursorInTimeZone converts a UTC instant into the tenant wall-clock (BST = +1h)', () => {
  // 11:00 UTC in July (summer) → 12:00 London wall-clock.
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'Europe/London'), '2026-07-15T12:00:00')
  // Winter (GMT) → no offset.
  assert.equal(formatCursorInTimeZone(new Date('2026-01-15T11:00:00Z'), 'Europe/London'), '2026-01-15T11:00:00')
  // UTC / blank / invalid zone → no conversion.
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'UTC'), '2026-07-15T11:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), ''), '2026-07-15T11:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'Not/AZone'), '2026-07-15T11:00:00')
})

// --- Sweep-core delta behaviour --------------------------------------------

test('(a) an order present in the delta is processed WITHOUT a per-order fetchOrderStatus', async () => {
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return null
      },
      fetchDelta: async () => [
        status({ externalOrderNumber: 'WC-1001', status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1', carrier: 'DPD' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 0)
  assert.equal(counters.dispatched, 1)
  assert.equal(counters.totalChecked, 1)
})

test('(b) an order absent from the delta on a non-reconcile tick is skipped — no fetch, no strike, and the watermark still advances on the clean pass', async () => {
  let fetchStatusCalls = 0
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const cleared: string[] = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return null
      },
      fetchDelta: async () => [], // WC-1001 unchanged → absent
      getDeltaState: async () => ({ watermark: '2026-07-15T11:00:00Z', lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
      clearDispatchFailures: async (linkId) => { cleared.push(linkId) },
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 0)
  assert.equal(counters.totalChecked, 0) // skipped candidates are not counted
  assert.deepEqual(cleared, []) // no failure bookkeeping touched
  assert.equal(saved.length, 1)
  assert.equal(saved[0].watermark, NOW.toISOString()) // delta fetched → watermark advanced
  assert.equal(saved[0].lastReconcile, undefined) // no reconcile pass ran
})

test('(c) an order absent from the delta but reconcile-due falls back to a per-order fetchOrderStatus', async () => {
  let fetchStatusCalls = 0
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ status: 'DESPATCHED', dispatched: true })
      },
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: null, lastReconcile: null }), // never reconciled → due
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 1)
  assert.equal(counters.dispatched, 1)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].watermark, NOW.toISOString())
  assert.equal(saved[0].lastReconcile, NOW.toISOString()) // reconcile pass ran → stamped
})

test('(d) a delta fetch that throws falls back to a full per-order poll (every candidate fetched)', async () => {
  const fetched: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [
        { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
        { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
      ],
      fetchOrderStatus: async (orderNumber) => {
        fetched.push(orderNumber)
        return status({ status: 'PROCESSING' })
      },
      fetchDelta: async () => {
        throw new Error('Mintsoft 500')
      },
      getDeltaState: async () => ({ watermark: '2026-07-15T11:00:00Z', lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(fetched.sort(), ['WC-1001', 'WC-1002'])
  // Full poll fallback: no delta was fetched, so no watermark advance — only the
  // reconcile stamp (the pass ran cleanly).
  assert.equal(saved.length, 1)
  assert.equal(saved[0].watermark, undefined)
  assert.equal(saved[0].lastReconcile, NOW.toISOString())
})

test('(e) a split order number with >1 delta rows is NOT preloaded — the fetchOrderParts path still runs via a forced fetch', async () => {
  let fetchStatusCalls = 0
  const partsFetchedFor: string[] = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ status: 'PROCESSING', isSplit: true, partCount: 2 })
      },
      fetchOrderParts: async (orderNumber) => {
        partsFetchedFor.push(orderNumber)
        return [
          part({ externalId: 'M-1', partNumber: 1, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-A' })] }),
          part({ externalId: 'M-2', partNumber: 2, dispatched: true, tracking: [tracking({ trackingNumber: 'TN-B' })] }),
        ]
      },
      fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
      pushPartialShipment: async () => ({ ok: true }),
      // A split shares one OrderNumber across several part-rows in the delta.
      fetchDelta: async () => [
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', isSplit: true, partCount: 2 }),
        status({ externalOrderId: 'M-2', externalOrderNumber: 'WC-1001', isSplit: true, partCount: 2 }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 1) // forced fetch (ambiguous preload), not a delta preload
  assert.deepEqual(partsFetchedFor, ['WC-1001'])
  assert.equal(counters.dispatched, 1)
})

test('(f) a dirty pass (a reconcile error) does NOT advance the watermark — saveDeltaState is never called', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchDelta: async () => [
        status({ externalOrderNumber: 'WC-1001', status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
      ],
      applyDispatch: async () => ({ success: false, error: 'no stock to consume' }),
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(counters.errors, 1)
  assert.equal(saved.length, 0) // held back by the dirty pass
})

test('the delta stays inert when the connector supplies no fetchDelta (behaves exactly as pre-delta)', async () => {
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ status: 'DESPATCHED', dispatched: true })
      },
      // no fetchDelta / getDeltaState / saveDeltaState
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 1) // full per-order poll
  assert.equal(counters.dispatched, 1)
})

test('the feature flag deltaEnabled:false forces per-order polling even when a delta is available', async () => {
  let deltaCalls = 0
  let fetchStatusCalls = 0
  await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ status: 'PROCESSING' })
      },
      fetchDelta: async () => {
        deltaCalls += 1
        return []
      },
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW, deltaEnabled: false },
  )
  assert.equal(deltaCalls, 0)
  assert.equal(fetchStatusCalls, 1)
})
