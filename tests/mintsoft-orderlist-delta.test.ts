import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsDispatchSweepCore,
  formatCursorInTimeZone,
  resolveDispatchJobOutcome,
  isDispatchClientScoped,
  coherentSplitPartIds,
  SPLIT_PROBE_BUDGET_PER_SWEEP,
  isUnresolvedDriftSystemic,
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
    // Merge evidence is number-based, so the sweep asks how many links claim each
    // number before it will repoint. Default: one claimant per number (the normal
    // case); tests that model a reused number override this.
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
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
        return status({ externalOrderNumber: orderNumber, externalOrderId: orderNumber === 'WC-1001' ? 'M-1' : 'M-2', status: 'PROCESSING' })
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

// --- o3d-bjc.2.1: merged orders must not slip the delta's coverage -----------
// A merge survivor's delta row carries the COMBINED number ("WC-1001+WC-1002")
// and the survivor's stable id, while our links still hold an ORIGINAL component
// number and the ABSORBED order's id until repointLink runs. Neither index would
// find them, yet coverage read complete and the watermark advanced — so an
// out-of-batch merged order could stay unreconciled while its delta row aged out.

const MERGED_SURVIVOR = {
  externalOrderId: 'M-9',
  externalOrderNumber: 'WC-1001+WC-1002',
  isMerged: true,
  mergedOrderNumbers: ['WC-1001', 'WC-1002'],
  status: 'DESPATCHED',
  dispatched: true,
}

test('[o3d-bjc.2.1] an out-of-batch merged order is enumerated by COMPONENT number, repointed and dispatched — and the watermark advances', async () => {
  const numbersAsked: string[][] = []
  const repointed: Array<{ linkId: string; externalOrderId: string; externalOrderNumber: string }> = []
  const applied: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []

  const { counters } = await runWmsDispatchSweepCore(
    deps({
      // The link's stored id (M-1) is the ABSORBED order's — the survivor's row
      // carries M-9, so the stable-id join finds nothing.
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async (numbers) => {
        numbersAsked.push([...numbers])
        return [candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' })]
      },
      // The authoritative number lookup resolves WC-1001 to its merge survivor.
      fetchOrderStatus: async () => status(MERGED_SURVIVOR),
      repointLink: async (linkId, to) => { repointed.push({ linkId, ...to }) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )

  // Both components are supplemented, not just the combined key.
  assert.ok(numbersAsked.length === 1, 'the number supplement ran exactly once')
  assert.ok(numbersAsked[0].includes('WC-1001'), 'component WC-1001 was enumerated')
  assert.ok(numbersAsked[0].includes('WC-1002'), 'component WC-1002 was enumerated')
  // The stable-id change is accepted BECAUSE the survivor names our number.
  assert.deepEqual(repointed, [{ linkId: 'l1', externalOrderId: 'M-9', externalOrderNumber: 'WC-1001+WC-1002' }])
  assert.deepEqual(applied, ['o1'])
  assert.equal(counters.dispatched, 1)
  assert.deepEqual(saved, [{ watermark: NOW.toISOString() }])
})

test('[o3d-bjc.2.1] merged components hold the watermark when the connector cannot enumerate by number', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      // no listActiveByOrderNumbers → the component links cannot be proven covered
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] the merge exception does NOT admit a reused number: a non-merged row with a different stable ID stays pending', async () => {
  const repointed: string[] = []
  const applied: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      // WC-1001 now resolves to a DIFFERENT, non-merged order (number reuse) —
      // no merge evidence, so the stable-ID guard must reject it.
      fetchOrderStatus: async () => status({
        externalOrderId: 'M-77',
        externalOrderNumber: 'WC-1001',
        status: 'DESPATCHED',
        dispatched: true,
      }),
      repointLink: async (linkId) => { repointed.push(linkId) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(applied, [])
  assert.deepEqual(repointed, [])
  assert.equal(counters.pending, 1)
  // Codex round-6 #1: a stable-ID rejection means UNRESOLVED, not "checked and
  // pending". Advancing here would age the merge out before it was ever applied.
  assert.deepEqual(saved, [], 'the watermark is held on an unresolved order')
})

test('[o3d-bjc.2.1] a supplemented link whose number resolves to NOTHING is unresolved — the watermark is held', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      fetchOrderStatus: async () => null, // the authoritative lookup finds nothing
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(counters.pending, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] an AMBIGUOUS merge (several active links share the number) repoints nothing and holds the watermark', async () => {
  const repointed: string[] = []
  const applied: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  let statusFetches = 0
  const { counters, logs } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      // Order numbers are not unique: two links both claim WC-1001. The survivor
      // absorbed only ONE of them, and nothing in the row says which.
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
        candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1001', externalOrderId: 'M-77' }),
      ],
      countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, n === 'WC-1001' ? 2 : 1])),
      fetchOrderStatus: async () => { statusFetches += 1; return status(MERGED_SURVIVOR) },
      repointLink: async (linkId) => { repointed.push(linkId) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(repointed, [], 'neither link is repointed off ambiguous number evidence')
  assert.deepEqual(applied, [], 'neither IMS order is dispatched')
  assert.equal(statusFetches, 0, 'the ambiguity is refused before any lookup')
  assert.equal(counters.pending, 2)
  assert.ok(logs.every((entry) => /Ambiguous merge/.test(entry.reason)), 'the ambiguity is surfaced')
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a watermark older than the lookback clamps the window and must NOT advance', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const sinceSeen: string[] = []
  // Watermark 30h old, lookback 24h → the window is clamped and cannot cover the
  // 6h gap. Advancing here is how a row held back by a failure silently ages out.
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      fetchDelta: async (since) => { sinceSeen.push(since); return [] },
      getDeltaState: async () => ({
        watermark: new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString(),
        lastReconcile: RECENT,
      }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC' },
  )
  assert.equal(sinceSeen.length, 1)
  assert.deepEqual(saved, [], 'a truncated window never advances the watermark')
})

test('[o3d-bjc.2.1] a fresh watermark inside the lookback still advances normally', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      fetchDelta: async () => [],
      getDeltaState: async () => ({
        watermark: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
        lastReconcile: RECENT,
      }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC' },
  )
  assert.deepEqual(saved, [{ watermark: NOW.toISOString() }])
})

// --- Codex round 7: every delta-triggered "unknown" must hold the watermark ---

const SPLIT_ROW = { externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', isSplit: true, partCount: 2 }

test('[o3d-bjc.2.1] a split delta row with NO parts visible is unresolved — the watermark is held', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters, unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => status(SPLIT_ROW),
      fetchOrderParts: async () => [], // the WMS says it split but shows no parts
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(counters.pending, 1)
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a split delta row with FEWER part rows than the WMS reports is unresolved', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => status(SPLIT_ROW),
      // partCount says 2, only part 1 is visible → enumeration incomplete.
      fetchOrderParts: async () => [part({ partNumber: 1, status: 'PICKED' })],
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a FULLY enumerated split that is genuinely part-way despatched is clean pending — the watermark advances', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters, unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      // A split number needs the shared-number supplement for coverage to be provable.
      listActiveByOrderNumbers: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => status(SPLIT_ROW),
      // Both parts visible; one shipped. State is KNOWN — just not complete.
      fetchOrderParts: async () => [
        part({ externalId: 'P1', partNumber: 1, status: 'DESPATCHED', dispatched: true }),
        part({ externalId: 'P2', partNumber: 2, status: 'PICKED' }),
      ],
      fetchPartItems: async () => [{ sku: 'SKU-1', qty: 1 }],
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(counters.pending, 1)
  assert.equal(unresolved, 0, 'a known-but-incomplete split is not "unresolved"')
  assert.deepEqual(saved, [{ watermark: NOW.toISOString() }])
})

test('[o3d-bjc.2.1] a split delta row on a connector with no per-part support is unresolved', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      partsSupported: false,
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => status(SPLIT_ROW),
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a delta-triggered forced fetch that returns nothing is unresolved even with no expected stable ID', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      // Split → forced authoritative fetch (no expectedExternalOrderId) → null.
      fetchOrderStatus: async () => null,
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a TERMINAL link sharing the number still makes a merge ambiguous (the count is not taken from the candidate set)', async () => {
  const repointed: string[] = []
  const applied: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      // Only ONE eligible link is returned — the other claimant is shipped or
      // dead-lettered, so the candidate queries filter it out entirely.
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      // …but the complete claimant count still sees both.
      countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, n === 'WC-1001' ? 2 : 1])),
      fetchOrderStatus: async () => status(MERGED_SURVIVOR),
      repointLink: async (linkId) => { repointed.push(linkId) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(repointed, [])
  assert.deepEqual(applied, [])
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a connector that cannot count claimants refuses the merge relaxation outright', async () => {
  const repointed: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      countLinksByOrderNumber: undefined,
      fetchOrderStatus: async () => status(MERGED_SURVIVOR),
      repointLink: async (linkId) => { repointed.push(linkId) },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.deepEqual(repointed, [])
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] the RECONCILE pass also refuses to repoint a merge on a shared number', async () => {
  const repointed: string[] = []
  const applied: string[] = []
  const { counters, unresolved } = await runWmsDispatchSweepCore(
    deps({
      // No delta at all — this is the pure per-order reconcile path, which used to
      // repoint on the merge marker with no ambiguity check whatsoever.
      listCandidates: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, n === 'WC-1001' ? 2 : 1])),
      fetchOrderStatus: async () => status(MERGED_SURVIVOR),
      repointLink: async (linkId) => { repointed.push(linkId) },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    }),
    { now: NOW },
  )
  assert.deepEqual(repointed, [])
  assert.deepEqual(applied, [])
  assert.equal(counters.pending, 1)
  assert.equal(unresolved, 1)
})

test('[o3d-bjc.2.1] a truncated watermark RECOVERS once a reconcile pass verifies the whole active set', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const staleWatermark = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString()
  const { deltaWindowTruncated } = await runWmsDispatchSweepCore(
    deps({
      // A short reconcile batch (1 < batchSize 50) means every eligible link was
      // just authoritatively verified, so the un-queryable gap IS covered.
      listReconcileCandidates: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      listActiveByExternalOrderIds: async () => [],
      fetchOrderStatus: async () => status({ status: 'PROCESSING' }),
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: staleWatermark, lastReconcile: null }), // reconcile DUE
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC' },
  )
  assert.equal(deltaWindowTruncated, true, 'still reported as degraded')
  assert.deepEqual(saved, [{ watermark: NOW.toISOString(), lastReconcile: NOW.toISOString() }])
})

test('[o3d-bjc.2.1] a truncated watermark does NOT recover while the reconcile backlog is still full', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const staleWatermark = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString()
  await runWmsDispatchSweepCore(
    deps({
      // More eligible links than the batch → links beyond it were not verified, so
      // the gap is not covered. The sweep asks for batchSize + 1 and uses the extra
      // row as a has-more sentinel, so the fake honours the limit.
      listReconcileCandidates: async (limit) => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
        candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002', externalOrderId: 'M-2' }),
        candidate({ linkId: 'l3', orderId: 'o3', externalOrderNumber: 'WC-1003', externalOrderId: 'M-3' }),
      ].slice(0, limit),
      listActiveByExternalOrderIds: async () => [],
      fetchOrderStatus: async (orderNumber) => status({
        externalOrderNumber: orderNumber,
        externalOrderId: `M-${orderNumber.slice(-1)}`,
        status: 'PROCESSING',
      }),
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: staleWatermark, lastReconcile: null }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC', batchSize: 2 },
  )
  assert.deepEqual(saved, [{ lastReconcile: NOW.toISOString() }], 'lastReconcile only — no watermark')
})

test('[o3d-bjc.2.1] truncation recovery does NOT certify an unresolvable read', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const staleWatermark = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString()
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      // The whole eligible set is one link — but its status lookup returns nothing,
      // so this pass establishes nothing and cannot certify the un-queryable gap.
      listReconcileCandidates: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      listActiveByExternalOrderIds: async () => [],
      fetchOrderStatus: async () => null,
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: staleWatermark, lastReconcile: null }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC' },
  )
  assert.equal(unresolved, 1)
  // lastReconcile IS stamped (the pass ran) so a permanently unresolvable link does
  // not force a full recovery reconcile every tick — but the watermark is withheld.
  assert.deepEqual(saved, [{ lastReconcile: NOW.toISOString() }])
})

test('[o3d-bjc.2.1] truncation recovery does NOT certify a BLANK order status', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const staleWatermark = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString()
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listReconcileCandidates: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      listActiveByExternalOrderIds: async () => [],
      // An unmapped OrderStatusId reaches the lenient per-order path as status ''.
      fetchOrderStatus: async () => status({ status: '', dispatched: false }),
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: staleWatermark, lastReconcile: null }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC' },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [{ lastReconcile: NOW.toISOString() }], 'cadence stamped, watermark withheld')
})

test('[o3d-bjc.2.1] a delta-triggered forced fetch with a BLANK status is unresolved', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      // Merge survivor resolves, the link repoints — but the survivor's own status is
      // blank, so its dispatch state was never established.
      fetchOrderStatus: async () => status({ ...MERGED_SURVIVOR, status: '', dispatched: false }),
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] a split part with an UNKNOWN status is unresolved, not "part-way despatched"', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { unresolved } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      listActiveByOrderNumbers: async () => [candidate({ linkId: 'l1', orderId: 'o1' })],
      fetchOrderStatus: async () => status(SPLIT_ROW),
      // Both parts visible, but part 2's status is blank (unmapped OrderStatusId) —
      // this used to read as a known "1/2 despatched" and advance the watermark.
      fetchOrderParts: async () => [
        part({ externalId: 'P1', partNumber: 1, status: 'DESPATCHED', dispatched: true }),
        part({ externalId: 'P2', partNumber: 2, status: '', dispatched: false }),
      ],
      fetchPartItems: async () => [{ sku: 'SKU-1', qty: 1 }],
      fetchDelta: async () => [status(SPLIT_ROW)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  assert.equal(unresolved, 1)
  assert.deepEqual(saved, [])
})

test('[o3d-bjc.2.1] truncation recovers when the eligible set EQUALS batchSize (has-more sentinel, not a short batch)', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const staleWatermark = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString()
  await runWmsDispatchSweepCore(
    deps({
      // Exactly batchSize eligible links: `length < batchSize` would never be true,
      // so this could never recover before the sentinel fix.
      listReconcileCandidates: async (limit) => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ].slice(0, limit),
      listActiveByExternalOrderIds: async () => [],
      fetchOrderStatus: async () => status({ status: 'PROCESSING' }),
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: staleWatermark, lastReconcile: null }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW, deltaTimeZone: 'UTC', batchSize: 1 },
  )
  assert.deepEqual(saved, [{ watermark: NOW.toISOString(), lastReconcile: NOW.toISOString() }])
})

test('[o3d-bjc.2.1] an unresolved order does NOT reset the dead-letter streak (it is not evidence of health)', async () => {
  const cleared: string[] = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, n === 'WC-1001' ? 2 : 1])),
      fetchOrderStatus: async () => status(MERGED_SURVIVOR),
      clearDispatchFailures: async (linkId) => { cleared.push(linkId) },
      fetchDelta: async () => [status(MERGED_SURVIVOR)],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.deepEqual(cleared, [])
})

test('[o3d-bjc.2.1] a DIRTY pass still stamps the reconcile cadence (no full-reconcile-every-tick amplification)', async () => {
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(
    deps({
      listReconcileCandidates: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
      ],
      listActiveByExternalOrderIds: async () => [],
      fetchOrderStatus: async () => { throw new Error('Mintsoft 500') },
      fetchDelta: async () => [],
      getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )
  // The watermark is withheld (the pass errored) but the cadence advances, so the
  // reconcile honours its interval instead of re-running on every scheduler tick.
  assert.deepEqual(saved, [{ lastReconcile: NOW.toISOString() }])
})

test('resolveDispatchJobOutcome: unresolved orders and a truncated window both mark the job PARTIAL', async () => {
  assert.deepEqual(resolveDispatchJobOutcome(0, null, {}), { status: 'SUCCEEDED', effectiveErrors: 0 })
  assert.deepEqual(resolveDispatchJobOutcome(0, null, { unresolved: 2 }), { status: 'PARTIAL', effectiveErrors: 2 })
  assert.deepEqual(
    resolveDispatchJobOutcome(0, null, { deltaWindowTruncated: true }),
    { status: 'PARTIAL', effectiveErrors: 1 },
  )
  assert.deepEqual(
    resolveDispatchJobOutcome(1, 'delta down', { unresolved: 1, deltaWindowTruncated: true }),
    { status: 'PARTIAL', effectiveErrors: 4 },
  )
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

// --- o3d-6j8: an unusable WMS record is UNRESOLVED, never a per-link strike -----

test('[o3d-6j8] a WmsUnresolvableRecordError holds the watermark WITHOUT striking the link', async () => {
  const { WmsUnresolvableRecordError } = await import('../lib/connectors/wms/errors.ts')
  const strikes: string[] = []
  const cleared: string[] = []
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []

  const { counters, unresolved } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      // The connector refuses the record: dispatched but missing the fulfilment block.
      fetchOrderStatus: async () => {
        throw new WmsUnresolvableRecordError('reads as dispatched but omits TrackingNumber — refusing to apply an incomplete dispatch')
      },
      recordDispatchError: async (c) => { strikes.push(c.linkId); return { deadLettered: false } },
      clearDispatchFailures: async (linkId) => { cleared.push(linkId) },
      saveDeltaState: async (state) => { saved.push(state) },
    }),
    { now: NOW },
  )

  // Systemic drift would otherwise strike EVERY link and dead-letter the tenant.
  assert.deepEqual(strikes, [], 'no per-link failure strike')
  assert.deepEqual(cleared, [], 'and it is not treated as evidence of health either')
  assert.equal(counters.errors, 0)
  assert.equal(counters.pending, 1)
  assert.equal(unresolved, 1, 'counted so the job goes PARTIAL')
  assert.deepEqual(saved, [], 'no delta state saved: the pass was not clean')
})

test('[o3d-6j8] an ORDINARY reconcile error still strikes the link (the classification is narrow)', async () => {
  const strikes: string[] = []
  const { counters, unresolved } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchOrderStatus: async () => { throw new Error('Mintsoft request failed with status 500') },
      recordDispatchError: async (c) => { strikes.push(c.linkId); return { deadLettered: false } },
    }),
    { now: NOW },
  )
  assert.deepEqual(strikes, ['l1'])
  assert.equal(counters.errors, 1)
  assert.equal(unresolved, 0)
})

// --- o3d-9vv: the fast path must SAY it engaged -------------------------------
// The delta shipped with a page Limit the API rejects, so every fetch 400'd and the
// sweep fell back to the per-order poll on every tick. It failed SAFE — correct sync,
// zero errors — so a completely dead optimisation looked exactly like a healthy run.
// A fail-safe fallback hides the very failure it protects against.

test('[o3d-9vv] the sweep reports how many orders the delta hot path actually served', async () => {
  let fetchStatusCalls = 0
  const { counters, deltaPreloadServed } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
        candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002', externalOrderId: 'M-2' }),
      ],
      fetchOrderStatus: async () => { fetchStatusCalls += 1; return null },
      fetchDelta: async () => [
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'PROCESSING' }),
        status({ externalOrderId: 'M-2', externalOrderNumber: 'WC-1002', status: 'PROCESSING' }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(fetchStatusCalls, 0, 'both orders came off the bulk delta')
  assert.equal(deltaPreloadServed, 2, 'and the sweep says so, rather than leaving it assumed')
  assert.equal(counters.pending, 2)
})

test('[o3d-9vv] a dead fast path is visible: 0 served even though the run "succeeds"', async () => {
  // The exact production symptom — a delta that always fails, a fallback that always
  // works. Counters look healthy; deltaPreloadServed is what betrays it.
  const { counters, deltaPreloadServed, deltaError } = await runWmsDispatchSweepCore(
    deps({
      listCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      listReconcileCandidates: async () => [candidate({ linkId: 'l1', orderId: 'o1', externalOrderId: 'M-1' })],
      fetchOrderStatus: async () => status({ status: 'PROCESSING' }),
      fetchDelta: async () => { throw new Error('Mintsoft request failed with status 400') },
      getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(counters.errors, 0, 'the fallback keeps the sync correct — nothing looks broken')
  assert.equal(counters.pending, 1)
  assert.equal(deltaPreloadServed, 0, 'but the hot path served nothing')
  assert.match(String(deltaError), /400/, 'and the cause is surfaced')
})

test('[o3d-9vv] a row the connector had to RE-READ is not counted as served fetch-free', async () => {
  const { deltaPreloadServed, deltaAuthoritativeRereads, deltaRowCount } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [
        candidate({ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }),
        candidate({ linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002', externalOrderId: 'M-2' }),
      ],
      fetchDelta: async () => [
        // M-1 came straight off the bulk feed; M-2 cost an authoritative detail read
        // (o3d-6j8). Counting M-2 as "served from the bulk delta" would hide that cost.
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'PROCESSING' }),
        { ...status({ externalOrderId: 'M-2', externalOrderNumber: 'WC-1002', status: 'PROCESSING' }), authoritativeReread: true },
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => {},
    }),
    { now: NOW },
  )
  assert.equal(deltaRowCount, 2)
  assert.equal(deltaPreloadServed, 1, 'only the untouched bulk row counts')
  assert.equal(deltaAuthoritativeRereads, 1, 'and the re-read is reported separately')
})

test('resolveDispatchJobOutcome: incomplete coverage marks the job PARTIAL (o3d-bjc.5)', async () => {
  // When the sweep cannot prove it enumerated every changed order — a full
  // candidate batch, or a shared-number/split group it could not resolve — it
  // PINS the watermark. That is the correct safe behaviour, but it used to be
  // invisible: the job reported SUCCEEDED with zero errors while the delta made
  // no forward progress, so a pinned watermark could repeat every sweep
  // indefinitely with nothing to alert on.
  assert.deepEqual(
    resolveDispatchJobOutcome(0, null, { deltaCoverageIncomplete: true }),
    { status: 'PARTIAL', effectiveErrors: 1 },
  )
  // Complete coverage is still a clean success.
  assert.deepEqual(
    resolveDispatchJobOutcome(0, null, { deltaCoverageIncomplete: false }),
    { status: 'SUCCEEDED', effectiveErrors: 0 },
  )
  // And it composes with the other degradations rather than masking them.
  assert.deepEqual(
    resolveDispatchJobOutcome(1, null, {
      unresolved: 2,
      deltaWindowTruncated: true,
      deltaCoverageIncomplete: true,
    }),
    { status: 'PARTIAL', effectiveErrors: 5 },
  )
})

// ---------------------------------------------------------------------------
// o3d-bjc.5: a RENAMED split whose sibling changed must not age out.
//
// The supplement looks links up by the delta row's CURRENT number, but the link
// stores the number the split had when we created it. If Mintsoft renamed it and
// only a SIBLING changed, neither the stable-ID join (wrong part id) nor the
// number lookup (wrong number) finds the link — so the order is invisible and
// ages out when the watermark advances.
//
// Attempt 1 fixed that by claiming coverage on number matches, which Codex
// rejected: order numbers are not unique even within our own client, so that
// risked dispatching one order's parts onto another's. Coverage is therefore
// claimed only on STABLE-ID evidence, and an incoherent group is refused.
// ---------------------------------------------------------------------------

function splitPart(externalId: string, partNumber: number): WmsOrderPart {
  return { externalId, partNumber, status: 'NEW', dispatched: false, tracking: [] }
}

test('coherentSplitPartIds: accepts one coherent group', () => {
  assert.deepEqual(coherentSplitPartIds([splitPart('M-1', 1), splitPart('M-2', 2)], 2), ['M-1', 'M-2'])
  assert.deepEqual(coherentSplitPartIds([splitPart('M-1', 1), splitPart('M-2', 2)], null), ['M-1', 'M-2'])
})

test('coherentSplitPartIds: refuses anything ambiguous', () => {
  // Two records claiming the same part — two splits stapled together by a
  // reused number. Enumerating against this could dispatch a stranger's parts.
  assert.equal(coherentSplitPartIds([splitPart('M-1', 1), splitPart('M-9', 1)], 2), null)
  // Duplicate external id.
  assert.equal(coherentSplitPartIds([splitPart('M-1', 1), splitPart('M-1', 2)], 2), null)
  // Count disagrees with what the delta row said the split has.
  assert.equal(coherentSplitPartIds([splitPart('M-1', 1), splitPart('M-2', 2)], 3), null)
  // Missing/blank id, or a nonsense part number.
  assert.equal(coherentSplitPartIds([splitPart('', 1)], 1), null)
  assert.equal(coherentSplitPartIds([splitPart('M-1', 0)], 1), null)
  assert.equal(coherentSplitPartIds([], 2), null)
})

test('[o3d-bjc.5] a renamed split is found AND reconciled under its new number', async () => {
  // The link stores the OLD number and the PRIMARY part id. The delta carries
  // only the changed sibling, under the NEW number.
  //
  // The status stub EXACT-MATCHES the number, like the production Mintsoft
  // adapter: looking the order up by the stale number returns nothing. A weaker
  // stub hides the second half of this bug — the probe finds the link and then
  // reconciliation fails anyway because it still uses the old number.
  const applied: string[] = []
  const idLookups: string[][] = []
  const statusLookups: string[] = []
  let saved = false
  const { counters } = await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async (ids) => {
        idLookups.push([...ids])
        return ids.includes('M-OLD-1')
          ? [candidate({ linkId: 'L1', orderId: 'O1', externalOrderId: 'M-OLD-1', externalOrderNumber: 'WC-OLD' })]
          : []
      },
      listActiveByOrderNumbers: async () => [],
      fetchOrderParts: async () => [splitPart('M-OLD-1', 1), splitPart('M-NEW-2', 2)],
      fetchOrderStatus: async (number) => {
        statusLookups.push(number)
        if (number !== 'WC-NEW') return null       // the rename is real
        return status({
          externalOrderId: 'M-OLD-1', externalOrderNumber: 'WC-NEW',
          isSplit: false, partCount: 1, dispatched: true,
          tracking: [{ trackingNumber: 'TRK-1', carrier: 'RM', despatchedAt: '2026-07-23' }],
        })
      },
      applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
      fetchDelta: async () => [
        status({ externalOrderId: 'M-NEW-2', externalOrderNumber: 'WC-NEW', isSplit: true, partCount: 2 }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => { saved = true },
    }),
    { now: NOW },
  )
  assert.ok(idLookups.some((ids) => ids.includes('M-OLD-1') && ids.includes('M-NEW-2')),
    'must enumerate links by the group\'s stable part ids')
  assert.ok(statusLookups.includes('WC-NEW'),
    'must reconcile under the CURRENT number, not the link\'s stale one')
  assert.deepEqual(applied, ['O1'], 'the renamed split must actually dispatch')
  assert.ok(counters.totalChecked > 0)
  assert.equal(saved, true, 'a clean pass must advance the watermark')
})

test('[o3d-bjc.5] an incoherent part set is refused and holds the watermark', async () => {
  let saved = false
  const idLookups: string[][] = []
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async (ids) => { idLookups.push([...ids]); return [] },
      listActiveByOrderNumbers: async () => [],
      // Two records both claiming part 1 — a reused number, not one split.
      fetchOrderParts: async () => [splitPart('M-A', 1), splitPart('M-B', 1)],
      fetchDelta: async () => [
        status({ externalOrderId: 'M-X', externalOrderNumber: 'WC-DUP', isSplit: true, partCount: 2 }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => { saved = true },
    }),
    { now: NOW },
  )
  // Never enumerated against the ambiguous group...
  assert.ok(!idLookups.some((ids) => ids.includes('M-A') || ids.includes('M-B')),
    'must not enumerate links against an incoherent group')
  // ...and the watermark is held rather than advanced past the unresolved group.
  assert.equal(saved, false, 'an unresolved group must hold the watermark')
})

test('[o3d-bjc.5] a failing probe stops immediately and holds the watermark', async () => {
  let partsCalls = 0
  let saved = false
  await runWmsDispatchSweepCore(
    deps({
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => [],
      fetchOrderParts: async () => { partsCalls += 1; throw new Error('WMS throttled') },
      fetchDelta: async () => [
        status({ externalOrderId: 'M-1', externalOrderNumber: 'WC-A', isSplit: true, partCount: 2 }),
        status({ externalOrderId: 'M-2', externalOrderNumber: 'WC-B', isSplit: true, partCount: 2 }),
      ],
      getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
      saveDeltaState: async () => { saved = true },
    }),
    { now: NOW },
  )
  assert.equal(partsCalls, 1, 'must stop on the FIRST failure, not hammer a degraded dependency')
  assert.equal(saved, false, 'a failed probe must hold the watermark')
})

test('[o3d-bjc.5] the probe budget is bounded', () => {
  assert.ok(SPLIT_PROBE_BUDGET_PER_SWEEP > 0 && SPLIT_PROBE_BUDGET_PER_SWEEP <= 100,
    'a cold window with many unlinked split groups must not storm the WMS')
})

// --- o3d-bjc.9: quarantine the record, circuit-break the drift --------------
// The two extremes are both wrong. NEVER isolating means one permanently
// unreadable record pins the delta watermark forever and never reaches the
// exception inbox; ALWAYS isolating means a vocabulary or schema change
// quarantines the whole tenant, each with its own alert, needing a manual
// release after the dependency recovers. These pin the line between them.

/** A link whose record the WMS answers for but cannot be resolved into a state. */
function unresolvableLink(n: number) {
  return candidate({ linkId: `L-${n}`, orderId: `O-${n}`, externalOrderNumber: `WC-${1000 + n}`, externalOrderId: `M-${n}` })
}

/** A split delta row with no parts visible — the sweep's canonical "unresolved". */
function unresolvableRow(n: number) {
  return status({
    externalOrderId: `M-${n}`,
    externalOrderNumber: `WC-${1000 + n}`,
    status: 'DESPATCHED',
    dispatched: true,
    isSplit: true,
    partCount: 2,
  })
}

type QuarantineHarness = {
  streaks: Map<string, number>
  quarantined: string[]
  cleared: string[]
  drifts: Array<{ linkCount: number; touched: number }>
  drift: { consecutive: number; cohortKey: string | null; stableFor: number }
  saved: Array<{ watermark?: string; lastReconcile?: string }>
}

function quarantineDeps(links: WmsDispatchCandidate[], h: QuarantineHarness, overrides: Partial<WmsDispatchSweepDeps> = {}) {
  const live = () => links.filter((link) => !h.quarantined.includes(link.linkId))
  return deps({
    listCandidates: async () => live(),
    listActiveByExternalOrderIds: async (ids) => live().filter((link) => ids.includes(link.externalOrderId ?? '')),
    listActiveByOrderNumbers: async (numbers) => live().filter((link) => numbers.includes(link.externalOrderNumber)),
    fetchDelta: async () => live().map((link) => unresolvableRow(Number(link.linkId.slice(2)))),
    fetchOrderParts: async () => [],
    getDeltaState: async () => ({ watermark: null, lastReconcile: RECENT }),
    saveDeltaState: async (state) => { h.saved.push(state) },
    recordUnresolvedRead: async (c) => {
      const next = (h.streaks.get(c.linkId) ?? 0) + 1
      h.streaks.set(c.linkId, next)
      return { count: next }
    },
    clearUnresolvedReads: async (linkId) => { h.cleared.push(linkId); h.streaks.set(linkId, 0) },
    quarantineUnresolved: async (c) => { h.quarantined.push(c.linkId); return { quarantined: true } },
    // No control links by default: the harness's whole active set IS the cohort.
    probeControlLinks: async () => ({ probed: 0, resolved: 0, representative: 0 }),
    getUnresolvedDriftState: async () => h.drift,
    saveUnresolvedDriftState: async (state) => { h.drift = state; return true },
    reportUnresolvedDrift: async (input) => { h.drifts.push({ linkCount: input.linkCount, touched: input.touched }) },
    ...overrides,
  })
}

function harness(): QuarantineHarness {
  return {
    streaks: new Map(), quarantined: [], cleared: [], drifts: [],
    drift: { consecutive: 0, cohortKey: null, stableFor: 0 }, saved: [],
  }
}

test('[o3d-bjc.9] ONE permanently unreadable record is isolated after a bounded number of passes — and releases the watermark', async () => {
  const h = harness()
  // Three links: one unreadable, two healthy — so the cohort is well under the
  // systemic floor and this is unambiguously a record-local defect.
  const broken = unresolvableLink(1)
  const healthy = [unresolvableLink(2), unresolvableLink(3)]
  const linksFor = () => [broken, ...healthy]

  const run = () => runWmsDispatchSweepCore(
    quarantineDeps(linksFor(), h, {
      // Only L-1's row is unresolvable; the others despatch cleanly.
      fetchDelta: async () => linksFor()
        .filter((link) => !h.quarantined.includes(link.linkId))
        .map((link) => (link.linkId === 'L-1'
          ? unresolvableRow(1)
          : status({
              externalOrderId: link.externalOrderId!,
              externalOrderNumber: link.externalOrderNumber,
              status: 'DESPATCHED',
              dispatched: true,
              tracking: [tracking({ trackingNumber: `TRK-${link.linkId}` })],
            }))),
    }),
    { now: NOW },
  )

  // Passes 1-4: still in play, so the watermark stays held — the row it could
  // not read is still owed.
  for (let pass = 1; pass <= 4; pass += 1) {
    const result = await run()
    assert.equal(result.unresolvedQuarantined, 0, `pass ${pass} must not isolate yet`)
    assert.equal(h.quarantined.length, 0, `pass ${pass} must not isolate yet`)
    assert.deepEqual(h.saved.at(-1)?.watermark, undefined, `pass ${pass} holds the watermark`)
  }

  // Pass 5 reaches the bound: isolate THAT record, and only that record.
  const fifth = await run()
  assert.equal(fifth.unresolvedQuarantined, 1)
  assert.deepEqual(h.quarantined, ['L-1'])
  assert.equal(fifth.unresolvedSystemic, false)
  assert.ok(h.saved.at(-1)?.watermark, 'the isolated record no longer holds the watermark')

  // ...and it stays out: the next pass never sees it again.
  const sixth = await run()
  assert.equal(sixth.unresolved, 0, 'a quarantined link leaves the candidate set')
  assert.deepEqual(h.quarantined, ['L-1'], 'and is not re-quarantined every tick')
})

test('[o3d-bjc.9] connector-wide drift quarantines NOTHING and raises ONE incident', async () => {
  const h = harness()
  const links = [1, 2, 3, 4].map(unresolvableLink)   // every link unreadable at once
  const result = await runWmsDispatchSweepCore(quarantineDeps(links, h), { now: NOW })

  assert.equal(result.unresolvedSystemic, true)
  assert.equal(result.unresolvedQuarantined, 0, 'drift must not quarantine the tenant one record at a time')
  assert.deepEqual(h.quarantined, [])
  assert.deepEqual(h.drifts, [{ linkCount: 4, touched: 4 }], 'exactly one incident for the cohort')
  assert.deepEqual(h.saved, [], 'drift holds the watermark: the rows are still owed')
  assert.equal(h.drift.consecutive, 1, 'the drift is counted, so a sustained one can escalate')
  assert.equal(h.drift.cohortKey, 'L-1,L-2,L-3,L-4', 'and WHO it was, so a frozen cohort can be told from real drift')
})

test('[o3d-bjc.9] a lone broken record in a BUSY tenant is still isolated (the ratio must not excuse it)', async () => {
  const h = harness()
  h.streaks.set('L-1', 4)                            // one read away from the cap
  const broken = unresolvableLink(1)
  const healthy = [2, 3, 4, 5, 6].map(unresolvableLink)
  const links = [broken, ...healthy]
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      fetchDelta: async () => links
        .filter((link) => !h.quarantined.includes(link.linkId))
        .map((link) => (link.linkId === 'L-1'
          ? unresolvableRow(1)
          : status({
              externalOrderId: link.externalOrderId!,
              externalOrderNumber: link.externalOrderNumber,
              status: 'DESPATCHED',
              dispatched: true,
              tracking: [tracking({ trackingNumber: 'TRK' })],
            }))),
    }),
    { now: NOW },
  )
  assert.equal(result.unresolvedSystemic, false, '1 of 6 is not drift')
  assert.deepEqual(h.quarantined, ['L-1'])
})

test('[o3d-bjc.9] sustained drift is ESCALATED, never converted into mass quarantine', async () => {
  const h = harness()
  h.drift = { consecutive: 12, cohortKey: null, stableFor: 1 }   // drifting for a long time
  const links = [1, 2, 3, 4].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 40))   // each far past its own cap
  const result = await runWmsDispatchSweepCore(quarantineDeps(links, h), { now: NOW })

  // A pass counter expiring is not evidence that N records are individually
  // broken. Isolating the cohort on it would need a manual replay per order,
  // instead of every link recovering by itself the moment the connector does.
  assert.equal(result.unresolvedSystemic, true)
  assert.equal(result.unresolvedQuarantined, 0)
  assert.deepEqual(h.quarantined, [])
  assert.equal(h.drift.consecutive, 13, 'the streak keeps counting so the incident can escalate')
})

test('[o3d-bjc.9] a failed streak WRITE must not reclassify drift into broken records', async () => {
  const h = harness()
  const links = [1, 2, 3, 4].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 4))   // all at their own cap
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, { saveUnresolvedDriftState: async () => false }),
    { now: NOW },
  )
  // The streak is an observability write. Letting it flip the verdict would
  // quarantine the whole tenant off one transient Setting upsert failure.
  assert.equal(result.unresolvedSystemic, true)
  assert.equal(result.unresolvedQuarantined, 0)
  assert.deepEqual(h.quarantined, [])
})

test('[o3d-bjc.9] a drift incident carries how long it has been drifting', async () => {
  const h = harness()
  h.drift = { consecutive: 2, cohortKey: null, stableFor: 1 }
  const links = [1, 2, 3, 4].map(unresolvableLink)
  const passes: number[] = []
  await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      reportUnresolvedDrift: async (input) => { passes.push(input.consecutivePasses) },
    }),
    { now: NOW },
  )
  assert.deepEqual(passes, [3])
})

test('[o3d-bjc.9] the FIRST resolved read clears the streak', async () => {
  const h = harness()
  h.streaks.set('L-1', 4)
  const link = unresolvableLink(1)
  await runWmsDispatchSweepCore(
    quarantineDeps([link], h, {
      fetchDelta: async () => [status({
        externalOrderId: 'M-1',
        externalOrderNumber: 'WC-1001',
        status: 'DESPATCHED',
        dispatched: true,
        tracking: [tracking({ trackingNumber: 'TRK-1' })],
      })],
    }),
    { now: NOW },
  )
  assert.deepEqual(h.cleared, ['L-1'])
  assert.equal(h.streaks.get('L-1'), 0, 'only CONSECUTIVE unresolved reads count toward isolation')
  assert.deepEqual(h.quarantined, [])
})

test('[o3d-bjc.9] the drift classifier needs BOTH a floor and a ratio', async () => {
  // Two unresolved links is under the floor however small the tenant...
  assert.equal(isUnresolvedDriftSystemic(2, 2), false)
  // ...three of four is drift...
  assert.equal(isUnresolvedDriftSystemic(3, 4), true)
  // ...but three of a hundred is three broken records.
  assert.equal(isUnresolvedDriftSystemic(3, 100), false)
})

test('[o3d-bjc.9] the core counts one unresolved read per PASS — which is why the sweep must be serialized', async () => {
  // Each pass counts a link once, so five OVERLAPPING passes of a single
  // transient incident would walk the streak to the cap and park the link — the
  // cap is meant to mean "five passes apart", not "five callers at once".
  // Nothing in the core can tell the difference, so runWmsDispatchSweep holds a
  // per-connector advisory lock and skips a concurrent run.
  const h = harness()
  const link = unresolvableLink(1)
  await Promise.all([1, 2, 3, 4, 5].map(() =>
    runWmsDispatchSweepCore(quarantineDeps([link], h), { now: NOW })))
  assert.equal(h.streaks.get('L-1'), 5, 'five passes, five counts — the lock is what makes them five REAL passes')
})

test('[o3d-bjc.9] the dispatch lock key is stable per connector and distinct across them', async () => {
  const { dispatchSweepLockKey } = await import('../lib/domain/wms/dispatch-sweep-lock.ts')
  assert.equal(dispatchSweepLockKey('mintsoft'), dispatchSweepLockKey('mintsoft'))
  assert.notEqual(dispatchSweepLockKey('mintsoft'), dispatchSweepLockKey('shiphero'))
  // int4: pg advisory-lock keys are signed 32-bit.
  for (const id of ['mintsoft', 'shiphero', 'a-very-long-connector-identifier']) {
    const key = dispatchSweepLockKey(id)
    assert.ok(Number.isSafeInteger(key) && key >= -(2 ** 31) && key < 2 ** 31, id)
  }
})

test('[o3d-bjc.9] with NO healthy control, a stable cohort stays drift — the tenant is never mass-isolated', async () => {
  // A deterministic schema break produces the same cohort every pass — all the
  // more so because holding the watermark re-serves the same rows. Reading that
  // stability as "these records are broken" would quarantine the entire active
  // set for a fault one connector fix would have cleared, and every order would
  // then need a manual replay. Held watermark + a loud incident is the
  // recoverable failure; mass isolation is not.
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)          // the whole active set
  const run = () => runWmsDispatchSweepCore(
    quarantineDeps(links, h, { probeControlLinks: async () => ({ probed: 0, resolved: 0, representative: 0 }) }),
    { now: NOW },
  )
  for (let pass = 0; pass < 8; pass += 1) {
    const result = await run()
    assert.equal(result.unresolvedSystemic, true, `pass ${pass} must stay drift`)
    assert.equal(result.unresolvedQuarantined, 0)
  }
  assert.deepEqual(h.quarantined, [])
  assert.deepEqual([...h.streaks.values()].filter((n) => n > 0), [], 'no per-link budget is spent either')
  assert.equal(h.drift.stableFor, 8, 'how long it has been stuck is still recorded, for the escalation')
  assert.deepEqual(h.saved, [], 'and the rows stay owed')
})

test('[o3d-bjc.9] a REAL outage (a rotating cohort) never spends any record\'s budget', async () => {
  // What actually distinguishes a connector fault from broken records is that
  // the fault sweeps in DIFFERENT orders as they change, while broken records
  // are the same ids every time. Partial recovery is where "increment first,
  // classify later" bites: the outage would have driven every counter to the
  // cap, so the moment recovery leaves one lagging record it is isolated
  // immediately — despite being about to recover on its own.
  const h = harness()
  const all = [1, 2, 3, 4, 5, 6].map(unresolvableLink)
  let changed = all.slice(0, 4)          // which orders changed this pass
  let broken = new Set(all.map((link) => link.linkId))
  const run = () => runWmsDispatchSweepCore(
    quarantineDeps(all, h, {
      listActiveByExternalOrderIds: async (ids) => changed.filter((link) => ids.includes(link.externalOrderId ?? '')),
      fetchDelta: async () => changed
        .filter((link) => !h.quarantined.includes(link.linkId))
        .map((link) => (broken.has(link.linkId)
          ? unresolvableRow(Number(link.linkId.slice(2)))
          : status({
              externalOrderId: link.externalOrderId!,
              externalOrderNumber: link.externalOrderNumber,
              status: 'DESPATCHED',
              dispatched: true,
              tracking: [tracking({ trackingNumber: 'TRK' })],
            }))),
    }),
    { now: NOW },
  )

  // Six passes of a full outage, a different slice of the tenant each time.
  for (let pass = 0; pass < 6; pass += 1) {
    changed = [all[pass % 3], all[(pass + 1) % 6], all[(pass + 2) % 6], all[(pass + 3) % 6]]
    const result = await run()
    assert.equal(result.unresolvedSystemic, true, `pass ${pass} is drift, not records`)
  }
  assert.deepEqual(h.quarantined, [])
  assert.deepEqual([...h.streaks.values()].filter((n) => n > 0), [],
    'a systemic pass is not evidence about any individual record')

  // The dependency comes back for all but one straggler.
  broken = new Set(['L-6'])
  changed = all
  const recovering = await run()
  assert.equal(recovering.unresolvedSystemic, false, '1 of 6 is not drift')
  assert.deepEqual(h.quarantined, [], 'the straggler starts its OWN budget at one, not at the cap')
  assert.equal(h.streaks.get('L-6'), 1)
})

test('[o3d-bjc.9] a healthy CONTROL read proves the cohort is record-local, however systemic the ratio looks', async () => {
  // The ratio cannot settle this on its own: "3 of the 3 orders that changed
  // were unreadable" is what a broken trio and a broken connector both look
  // like. A control link that reads cleanly is decisive — the connector answers,
  // so these records are the problem.
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 4))
  const excluded: string[][] = []
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      probeControlLinks: async (exclude) => { excluded.push(exclude); return { probed: 3, resolved: 3, representative: 3 } },
    }),
    { now: NOW },
  )
  assert.equal(result.unresolvedSystemic, false)
  assert.deepEqual(h.quarantined.sort(), ['L-1', 'L-2', 'L-3'])
  assert.deepEqual(excluded[0]?.sort(), ['L-1', 'L-2', 'L-3'], 'the cohort itself can never be its own control')
})

test('[o3d-bjc.9] controls that ALSO fail keep it drift, however long it lasts', async () => {
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 40))
  const run = () => runWmsDispatchSweepCore(
    quarantineDeps(links, h, { probeControlLinks: async () => ({ probed: 3, resolved: 0, representative: 0 }) }),
    { now: NOW },
  )
  // Same cohort every pass — identity alone would have called this local by now.
  for (let pass = 0; pass < 5; pass += 1) {
    const result = await run()
    assert.equal(result.unresolvedSystemic, true, `pass ${pass}`)
  }
  assert.deepEqual(h.quarantined, [], 'nothing else on the connector reads either — never isolate the tenant')
})

test('[o3d-bjc.9] a failed control probe is not counter-evidence', async () => {
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 4))
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      probeControlLinks: async () => { throw new Error('connector down') },
    }),
    { now: NOW },
  )
  // No evidence ≠ evidence of health. It falls back to the conservative branch.
  assert.equal(result.unresolvedSystemic, true)
  assert.deepEqual(h.quarantined, [])
})

test('[o3d-bjc.9] an ambiguous merge accrues a streak and is eventually replayable', async () => {
  // It used to hold the watermark on every pass while accruing nothing: no
  // streak, no exception-inbox row, no replay — an invisible permanent hold.
  const h = harness()
  const link = candidate({ linkId: 'L-9', orderId: 'O-9', externalOrderNumber: 'WC-1009', externalOrderId: 'M-9' })
  const survivor = status({
    externalOrderId: 'M-99',
    externalOrderNumber: 'WC-1009+WC-1010',
    isMerged: true,
    mergedOrderNumbers: ['WC-1009', 'WC-1010'],
  })
  const run = () => runWmsDispatchSweepCore(
    quarantineDeps([link], h, {
      fetchDelta: async () => [survivor],
      listActiveByExternalOrderIds: async () => [],
      listActiveByOrderNumbers: async () => (h.quarantined.includes('L-9') ? [] : [link]),
      // Two links claim the number ⇒ the repoint is refused as ambiguous.
      countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 2])),
      probeControlLinks: async () => ({ probed: 2, resolved: 2, representative: 2 }),
    }),
    { now: NOW },
  )
  for (let pass = 0; pass < 5; pass += 1) await run()
  assert.deepEqual(h.quarantined, ['L-9'], 'it reaches the exception inbox instead of pinning the cursor forever')
})

test('[o3d-bjc.9] controls that RESOLVE but are not dispatched prove nothing', async () => {
  // The completeness guard only rejects records that read as DISPATCHED, so a
  // connector-wide change that mangles every despatch leaves pending orders
  // reading perfectly. Counting those as healthy evidence is exactly how the
  // breaker would come to quarantine the tenant it exists to protect.
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 4))   // all one read from the cap
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      // Three pending controls read fine; none of them exercises the invariant
      // every dispatched record is failing.
      probeControlLinks: async () => ({ probed: 3, resolved: 3, representative: 0 }),
    }),
    { now: NOW },
  )
  assert.equal(result.unresolvedSystemic, true)
  assert.deepEqual(h.quarantined, [])
  assert.deepEqual([...h.streaks.values()], [4, 4, 4], 'and no budget is spent on them')
})

test('[o3d-bjc.9] a PARTS-path outage is not excused by a healthy non-split control', async () => {
  // Unresolved outcomes come from split enumeration and part-item reads too, so
  // a connector-wide fetchOrderParts degradation leaves an ordinary non-split
  // order answering perfectly while every split order breaks. The control has
  // to walk the same paths, or that one clean status read quarantines the whole
  // split cohort five passes later.
  const h = harness()
  const links = [1, 2, 3].map(unresolvableLink)
  links.forEach((link) => h.streaks.set(link.linkId, 4))
  const result = await runWmsDispatchSweepCore(
    quarantineDeps(links, h, {
      // The probe walked status AND parts; parts is what is down, so nothing
      // qualifies as representative.
      probeControlLinks: async () => ({ probed: 3, resolved: 3, representative: 0 }),
    }),
    { now: NOW },
  )
  assert.equal(result.unresolvedSystemic, true)
  assert.deepEqual(h.quarantined, [])
})
