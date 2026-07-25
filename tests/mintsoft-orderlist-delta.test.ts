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
