import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsDispatchSweepCore,
  formatCursorInTimeZone,
  resolveDispatchJobOutcome,
  isDispatchClientScoped,
} from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsDispatchSweepDeps, WmsDispatchCandidate } from '../lib/domain/wms/dispatch-sweep.ts'
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

// A candidate carrying the stable externalOrderId the delta pass joins on.
function candidate(partial: Partial<WmsDispatchCandidate> & Pick<WmsDispatchCandidate, 'linkId' | 'orderId'>): WmsDispatchCandidate {
  return { externalOrderNumber: 'WC-1001', externalOrderId: 'M-1', ...partial }
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
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'Europe/London'), '2026-07-15T12:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-01-15T11:00:00Z'), 'Europe/London'), '2026-01-15T11:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'UTC'), '2026-07-15T11:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), ''), '2026-07-15T11:00:00')
  assert.equal(formatCursorInTimeZone(new Date('2026-07-15T11:00:00Z'), 'Not/AZone'), '2026-07-15T11:00:00')
})

// --- Round-5 #3: unscoped Mintsoft must SKIP (not dead-letter) --------------

test('[o3d-bjc #3] isDispatchClientScoped: Mintsoft needs a positive integer ClientId; other connectors are always scoped', () => {
  // Mintsoft, unconfigured → NOT scoped → the wrapper SKIPs the whole sweep
  // (no per-order reconcile that would throw + dead-letter every link).
  assert.equal(isDispatchClientScoped('mintsoft', null), false)
  assert.equal(isDispatchClientScoped('mintsoft', ''), false)
  assert.equal(isDispatchClientScoped('mintsoft', '   '), false)
  assert.equal(isDispatchClientScoped('mintsoft', '0'), false)
  assert.equal(isDispatchClientScoped('mintsoft', '-5'), false)
  assert.equal(isDispatchClientScoped('mintsoft', 'abc'), false)
  assert.equal(isDispatchClientScoped('mintsoft', '12x'), false)
  // Mintsoft, configured → scoped → the sweep runs.
  assert.equal(isDispatchClientScoped('mintsoft', '1234'), true)
  assert.equal(isDispatchClientScoped('mintsoft', ' 1234 '), true)
  // A different WMS (e.g. shiphero) carries no shared-tenant scope → always ok.
  assert.equal(isDispatchClientScoped('shiphero', null), true)
  assert.equal(isDispatchClientScoped('shiphero', ''), true)
})

// --- Sweep-core delta behaviour --------------------------------------------

test('(a) an order present in the delta is processed WITHOUT a per-order fetchOrderStatus', async () => {
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return null
      },
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1', carrier: 'DPD' })] }),
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
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
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
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
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
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
        candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002', externalOrderId: 'M-2' }),
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
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
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
      // A split shares one OrderNumber across several part-rows (distinct ids).
      fetchDelta: async () => [
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', isSplit: true, partCount: 2 }),
        status({ externalOrderId: 'M-2', externalOrderNumber: 'WC-1001', isSplit: true, partCount: 2 }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 1) // forced fetch (shared number ⇒ ambiguous), not a delta preload
  assert.deepEqual(partsFetchedFor, ['WC-1001'])
  assert.equal(counters.dispatched, 1)
})

test('(f) a dirty pass (a reconcile error) does NOT advance the watermark — saveDeltaState is never called', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
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
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
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

test('(g) [o3d-bjc coverage] a changed order beyond the reconcile batch is processed via listActiveByExternalOrderIds and the watermark advances', async () => {
  const byIdQueried: string[][] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      // Full batch of an UNRELATED link (not the changed order).
      listCandidates: async () => [candidate({ linkId: 'other', orderId: 'oo', externalOrderNumber: 'WC-9999', externalOrderId: 'M-9' })],
      listActiveByExternalOrderIds: async (ids) => {
        byIdQueried.push(ids)
        return ids.includes('M-1')
          ? [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })]
          : []
      },
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return null
      },
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1', carrier: 'DPD' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, batchSize: 1 },
  )
  assert.deepEqual(byIdQueried, [['M-1']]) // delta drove the stable-ID lookup
  assert.equal(fetchStatusCalls, 0) // handled from the delta preload, no per-order poll
  assert.equal(counters.dispatched, 1) // the out-of-batch order WAS processed
  assert.equal(saved.length, 1)
  assert.equal(saved[0].watermark, NOW.toISOString()) // full coverage → watermark advanced
})

test('(h) [o3d-bjc coverage] fallback (no listActiveByExternalOrderIds): a FULL batch holds the watermark so an out-of-batch change is not aged out', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, batchSize: 1 },
  )
  assert.equal(counters.dispatched, 1) // the in-batch match is still processed
  assert.equal(saved.length, 0) // watermark HELD (coverage not provably complete, no reconcile due)
})

test('(i) [o3d-bjc coverage] an order handled in the delta pass is not double-processed by a due reconcile pass', async () => {
  let fetchStatusCalls = 0
  const cleared: string[] = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ status: 'DESPATCHED', dispatched: true })
      },
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: null }), // reconcile DUE
      saveDeltaState: async () => {},
      clearDispatchFailures: async (linkId) => { cleared.push(linkId) },
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 0) // processed once from the delta, not re-polled by reconcile
  assert.equal(counters.totalChecked, 1)
  assert.deepEqual(cleared, ['l1']) // bookkeeping ran exactly once
})

test('(j) [o3d-bjc rotation] the reconcile pass uses listReconcileCandidates (not listCandidates) and stamps EVERY verified link — delta + reconcile — with markReconcileChecked', async () => {
  let plainListCalls = 0
  let usedReconcileList = false
  const stamped: Array<{ ids: string[]; at: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => { plainListCalls += 1; return [] },
      listReconcileCandidates: async () => {
        usedReconcileList = true
        return [candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002', externalOrderId: 'M-2' })] // absent from delta → per-order poll
      },
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchOrderStatus: async () => status({ status: 'PROCESSING' }),
      fetchDelta: async () => [
        status({ status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: null }), // reconcile DUE
      saveDeltaState: async () => {},
      markReconcileChecked: async (ids, at) => { stamped.push({ ids: [...ids].sort(), at: at.toISOString() }) },
    }),
    { now: NOW },
  )
  assert.equal(usedReconcileList, true)
  assert.equal(plainListCalls, 0) // reconcile used the rotation-ordered list, not the plain one
  assert.equal(stamped.length, 1)
  assert.deepEqual(stamped[0].ids, ['l1', 'l2']) // delta-verified l1 AND reconcile-polled l2 both rotate to the back
  assert.equal(stamped[0].at, NOW.toISOString())
})

test('(k) [o3d-bjc rotation] on a NON-reconcile tick a delta-verified link is still stamped (so an alive order rotates back and does not hog the reconcile batch)', async () => {
  const stamped: string[][] = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      listReconcileCandidates: async () => { throw new Error('reconcile pass must not run on a non-due tick') },
      fetchDelta: async () => [status({ status: 'PROCESSING' })], // changed but not despatched
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }), // reconcile NOT due
      saveDeltaState: async () => {},
      markReconcileChecked: async (ids) => { stamped.push([...ids]) },
    }),
    { now: NOW },
  )
  assert.deepEqual(stamped, [['l1']]) // stamped from the delta pass alone — no reconcile ran
})

test('(l) [o3d-bjc finding 2] a delta row joins by STABLE externalOrderId — two local links sharing a number but with different ids: ONLY the id-matching link is dispatched, never both', async () => {
  const applied: string[] = []
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      // Both links carry the SAME order number but DIFFERENT stable ids.
      listActiveByExternalOrderIds: async () => [
        candidate({ linkId: 'lA', orderId: 'oA', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }), // matches the delta id
        candidate({ linkId: 'lB', orderId: 'oB', externalOrderNumber: 'WC-1001', externalOrderId: 'M-2' }), // same number, id NOT in the delta
      ],
      fetchOrderStatus: async () => { fetchStatusCalls += 1; return status({ status: 'DESPATCHED', dispatched: true }) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', dispatched: true, tracking: [tracking({ trackingNumber: 'TN1' })] }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }), // reconcile NOT due
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.deepEqual(applied, ['oA']) // ONLY the id-matching link — lB is never dispatched off WC-1001's despatch
  assert.equal(fetchStatusCalls, 0) // lA preloaded; lB skipped (its id M-2 is not in the delta)
  assert.equal(counters.dispatched, 1)
})

test('[o3d-bjc.2 finding 2] a renamed order is loaded and applied by stable ID even though the local link still has the old number', async () => {
  const queriedIds: string[][] = []
  const applied: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async (ids) => {
        queriedIds.push(ids)
        return [candidate({
          linkId: 'l1',
          orderId: 'o1',
          externalOrderId: 'M-1',
          externalOrderNumber: 'WC-OLD',
        })]
      },
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        throw new Error('renamed order must use its stable-ID delta row')
      },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [
        status({
          externalOrderId: 'M-1',
          externalOrderNumber: 'WC-RENAMED',
          status: 'DESPATCHED',
          dispatched: true,
          tracking: [tracking({ trackingNumber: 'TN-RENAMED' })],
        }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(queriedIds, [['M-1']])
  assert.equal(fetchStatusCalls, 0)
  assert.deepEqual(applied, ['o1'])
  assert.equal(counters.dispatched, 1)
  assert.equal(saved[0]?.watermark, NOW.toISOString())
})

test('[o3d-bjc.2 finding 2] a changed split sibling ID still finds the stored primary link by split order number and forces part enumeration', async () => {
  const queriedIds: string[][] = []
  const queriedNumbers: string[][] = []
  const partsFetchedFor: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  let fetchStatusCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      // The delta changed M-2, while the link stores sibling part M-1.
      listActiveByExternalOrderIds: async (ids) => { queriedIds.push(ids); return [] },
      listActiveByOrderNumbers: async (numbers) => {
        queriedNumbers.push(numbers)
        return [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })]
      },
      fetchOrderStatus: async () => {
        fetchStatusCalls += 1
        return status({ externalOrderId: 'M-1', isSplit: true, partCount: 2 })
      },
      fetchOrderParts: async (orderNumber) => {
        partsFetchedFor.push(orderNumber)
        return [
          part({ externalId: 'M-1', partNumber: 1, dispatched: true }),
          part({ externalId: 'M-2', partNumber: 2, dispatched: true }),
        ]
      },
      fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
      fetchDelta: async () => [
        status({
          externalOrderId: 'M-2',
          externalOrderNumber: 'WC-1001',
          isSplit: true,
          partCount: 2,
        }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(queriedIds, [['M-2']])
  assert.deepEqual(queriedNumbers, [['WC-1001']])
  assert.equal(fetchStatusCalls, 1)
  assert.deepEqual(partsFetchedFor, ['WC-1001'])
  assert.equal(counters.dispatched, 1)
  assert.equal(saved[0]?.watermark, NOW.toISOString())
})

test('[o3d-bjc.2 finding 2] split coverage without the shared-number dependency holds the watermark', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      fetchDelta: async () => [
        status({
          externalOrderId: 'M-2',
          externalOrderNumber: 'WC-1001',
          isSplit: true,
          partCount: 2,
        }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2 finding 2] the split number supplement cannot apply a reused-number link whose stable ID differs', async () => {
  const applied: string[] = []
  let partsCalls = 0
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'foreign-link', orderId: 'foreign-order', externalOrderId: 'M-OTHER' }),
      ],
      fetchOrderStatus: async () => status({
        externalOrderId: 'M-1',
        externalOrderNumber: 'WC-1001',
        isSplit: true,
        partCount: 2,
      }),
      fetchOrderParts: async () => { partsCalls += 1; return [] },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [
        status({
          externalOrderId: 'M-2',
          externalOrderNumber: 'WC-1001',
          isSplit: true,
          partCount: 2,
        }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.deepEqual(applied, [])
  assert.equal(partsCalls, 0)
  assert.equal(counters.pending, 1)
})

test('(m) [o3d-bjc finding 3a] a delta-fetch failure is surfaced as deltaError (not swallowed) while the sweep still per-order reconciles', async () => {
  const { counters, deltaError } = await runWmsDispatchSweepCore(
    deps({
      listReconcileCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchOrderStatus: async () => status({ status: 'DESPATCHED', dispatched: true }),
      fetchDelta: async () => { throw new Error('Mintsoft Order/List 503') },
      getDeltaState: async () => ({ watermark: '2026-07-15T11:00:00Z', lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.ok(deltaError, 'delta failure is surfaced, not swallowed')
  assert.equal(counters.dispatched, 1) // fell back to the per-order reconcile
})

test('(n) [o3d-bjc finding 3b] under PERSISTENT delta failure the rotation-ordered reconcile covers the whole active set across runs (no starvation)', async () => {
  // Two active links, batchSize 1. A stateful listReconcileCandidates rotates by
  // least-recently-checked using the timestamps markReconcileChecked records.
  const checkedAt = new Map<string, number>()
  const links = [
    candidate({ linkId: 'lOld', orderId: 'oOld', externalOrderNumber: 'WC-OLD', externalOrderId: 'M-OLD' }),
    candidate({ linkId: 'lNew', orderId: 'oNew', externalOrderNumber: 'WC-NEW', externalOrderId: 'M-NEW' }),
  ]
  const polled: string[] = []
  const reconcileList = async (limit: number) =>
    [...links]
      .sort((a, b) => (checkedAt.get(a.linkId) ?? -1) - (checkedAt.get(b.linkId) ?? -1))
      .slice(0, limit)
  const makeDeps = () => deps({
    fetchDelta: async () => { throw new Error('delta down') }, // persistent failure
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }), // reconcile always due
    saveDeltaState: async () => {},
    listReconcileCandidates: reconcileList,
    fetchOrderStatus: async (n) => { polled.push(n); return status({ status: 'PROCESSING' }) },
    markReconcileChecked: async (ids, at) => { for (const id of ids) checkedAt.set(id, at.getTime()) },
  })
  // Run 1 polls the first (both unchecked); run 2 must reach the OTHER link.
  await runWmsDispatchSweepCore(makeDeps(), { now: new Date(1), batchSize: 1 })
  await runWmsDispatchSweepCore(makeDeps(), { now: new Date(2), batchSize: 1 })
  assert.deepEqual(polled, ['WC-OLD', 'WC-NEW']) // the newer link IS reached — no starvation
})

test('the feature flag deltaEnabled:false forces per-order polling even when a delta is available', async () => {
  let deltaCalls = 0
  let fetchStatusCalls = 0
  await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
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

// --- Pure job-outcome mapping (finding 3a) ---------------------------------

test('resolveDispatchJobOutcome: a delta failure marks the job PARTIAL and counts as an error', () => {
  assert.deepEqual(resolveDispatchJobOutcome(0, null), { status: 'SUCCEEDED', effectiveErrors: 0 })
  assert.deepEqual(resolveDispatchJobOutcome(0, 'delta down'), { status: 'PARTIAL', effectiveErrors: 1 })
  assert.deepEqual(resolveDispatchJobOutcome(2, 'delta down'), { status: 'PARTIAL', effectiveErrors: 3 })
  assert.deepEqual(resolveDispatchJobOutcome(2, null), { status: 'PARTIAL', effectiveErrors: 2 })
})
