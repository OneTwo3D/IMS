import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sweepUnallocatedProcessingOrders,
  type ReallocationSweepDeps,
  type SweepCursorState,
} from '@/lib/fulfillment/reallocation-sweep'

// o3d-9lx: the sweep re-runs allocation for PROCESSING orders with outstanding demand (a paid order
// whose poller allocation failed transiently), gated on allocation state — not payment state. It walks
// the PROCESSING set with a durable keyset cursor bounded by a per-cycle high-watermark, persisting the
// cursor only after a batch is processed. All collaborators are injected so the orchestration is
// verified without a DB.

type Deps = Partial<ReallocationSweepDeps>
type LogEntry = Parameters<ReallocationSweepDeps['logActivity']>[0]
type Candidate = Awaited<ReturnType<ReallocationSweepDeps['loadCandidatesPage']>>[number]

function order(id: string): Candidate {
  return {
    id,
    orderNumber: id,
    externalOrderNumber: null,
    lines: [{ id: `${id}-l1`, qty: 1, productId: 'p1' }],
  }
}

function baseDeps(over: Deps = {}) {
  const calls = {
    alloc: [] as string[],
    sync: [] as string[][],
    logs: [] as { action: string; level: string | undefined }[],
    stateWrites: [] as SweepCursorState[],
    snapshots: 0,
  }
  let state: SweepCursorState = { cursor: '', watermark: '' }
  const deps: Deps = {
    readState: async () => state,
    writeState: async (s) => {
      state = s
      calls.stateWrites.push(s)
    },
    snapshotWatermark: async () => {
      calls.snapshots += 1
      return 'WM-MAX'
    },
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2')],
    selectNeedingAllocation: async (c) => c, // by default all need allocation
    autoAllocateOrder: async (orderId) => {
      calls.alloc.push(orderId)
      return { success: true, allocationCount: 1, syncProductIds: ['p1'] }
    },
    enqueueStockSync: async (ids) => {
      calls.sync.push(ids)
    },
    logActivity: (async (entry: LogEntry) => {
      calls.logs.push({ action: entry.action, level: entry.level })
    }) as ReallocationSweepDeps['logActivity'],
    ...over,
  }
  return { deps, calls }
}

test('only orders that still need allocation are re-allocated (o3d-9lx)', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2'), order('SO-3')],
    // SO-2 is already fully allocated -> excluded by the coverage filter.
    selectNeedingAllocation: async (c) => c.filter((o) => o.id !== 'SO-2'),
  })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.deepEqual(calls.alloc, ['SO-1', 'SO-3'])
  assert.equal(result.scanned, 3)
  assert.equal(result.needing, 2)
  assert.equal(result.allocated, 2)
  assert.equal(result.errors, 0)
})

test('a benign "no stock" result is not counted or logged as an error', async () => {
  const { deps, calls } = baseDeps({
    autoAllocateOrder: async () => ({ success: false, error: 'No stock available for allocation' }),
  })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(result.allocated, 0)
  assert.equal(result.errors, 0)
  assert.equal(calls.logs.filter((l) => l.level === 'ERROR').length, 0)
})

test('a real allocation error is counted and logged', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1')],
    autoAllocateOrder: async () => ({ success: false, error: 'lock acquisition timeout' }),
  })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(result.errors, 1)
  assert.equal(result.allocated, 0)
  assert.equal(
    calls.logs.filter((l) => l.action === 'reallocation_sweep_failed' && l.level === 'ERROR').length,
    1,
  )
})

test('a throwing autoAllocateOrder is caught, counted, and does not abort the sweep', async () => {
  const { deps } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2')],
    autoAllocateOrder: async (orderId) => {
      if (orderId === 'SO-1') throw new Error('boom')
      return { success: true, allocationCount: 1, syncProductIds: [] }
    },
  })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(result.errors, 1)
  assert.equal(result.allocated, 1) // SO-2 still processed after SO-1 threw
})

test('per-order stock syncs are coalesced into a single push', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2')],
    autoAllocateOrder: async (orderId) => ({
      success: true,
      allocationCount: 1,
      syncProductIds: orderId === 'SO-1' ? ['p1', 'p2'] : ['p2', 'p3'],
    }),
  })
  await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(calls.sync.length, 1)
  assert.deepEqual([...calls.sync[0]].sort(), ['p1', 'p2', 'p3'])
})

test('nothing needing allocation -> no allocate calls, no sync', async () => {
  const { deps, calls } = baseDeps({ selectNeedingAllocation: async () => [] })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(result.needing, 0)
  assert.equal(calls.alloc.length, 0)
  assert.equal(calls.sync.length, 0)
})

test('no PROCESSING orders -> snapshot returns empty, state cleared, no work', async () => {
  const { deps, calls } = baseDeps({ snapshotWatermark: async () => '' })
  const result = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(result.scanned, 0)
  assert.deepEqual(calls.stateWrites, [{ cursor: '', watermark: '' }])
  assert.equal(calls.alloc.length, 0)
})

// --- Durable keyset cursor + per-cycle high-watermark -----------------------

test('a full page advances the cursor and keeps the cycle watermark', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2'), order('SO-3')], // limit+1 -> remainder
    selectNeedingAllocation: async () => [],
  })
  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(result.hasRemainder, true)
  assert.equal(result.scanned, 2) // extra row is a lookahead, not processed
  assert.deepEqual(calls.stateWrites, [{ cursor: 'SO-2', watermark: 'WM-MAX' }])
  assert.equal(calls.snapshots, 1) // snapshot taken once at cycle start
})

test('a short final page wraps: cursor and watermark cleared', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-9')],
    selectNeedingAllocation: async () => [],
  })
  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(result.hasRemainder, false)
  assert.deepEqual(calls.stateWrites, [{ cursor: '', watermark: '' }])
})

test('mid-cycle the snapshot is NOT retaken and the stored watermark bounds the page (o3d-9lx)', async () => {
  let passedWatermark = ''
  const { deps, calls } = baseDeps({
    readState: async () => ({ cursor: 'SO-2', watermark: 'WM-FIXED' }), // mid-cycle
    loadCandidatesPage: async (_c, wm) => {
      passedWatermark = wm
      return [order('SO-3')]
    },
    selectNeedingAllocation: async () => [],
  })
  await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(calls.snapshots, 0, 'no re-snapshot while a cycle is in progress')
  assert.equal(passedWatermark, 'WM-FIXED', 'the stored cycle watermark bounds the scan')
})

test('a stable first page of benign backorders does not starve a later eligible order (o3d-9lx)', async () => {
  // Page 1 = two permanent no-stock backorders. Page 2 (after the cursor advances) holds a genuinely
  // stranded order WITH stock. The cursor must reach it on the next tick.
  const pages: Record<string, Candidate[]> = {
    '': [order('SO-1'), order('SO-2'), order('SO-3')], // limit=2 -> remainder; batch = SO-1,SO-2
    'SO-2': [order('SO-3')],
  }
  let state: SweepCursorState = { cursor: '', watermark: '' }
  const attempted: string[] = []
  const deps: Deps = {
    readState: async () => state,
    writeState: async (s) => {
      state = s
    },
    snapshotWatermark: async () => 'SO-3',
    loadCandidatesPage: async (cur) => pages[cur] ?? [],
    selectNeedingAllocation: async (c) => c,
    autoAllocateOrder: async (orderId) => {
      attempted.push(orderId)
      if (orderId === 'SO-3') return { success: true, allocationCount: 1, syncProductIds: [] }
      return { success: false, error: 'No stock available for allocation' }
    },
    enqueueStockSync: async () => {},
    logActivity: (async () => {}) as ReallocationSweepDeps['logActivity'],
  }

  const run1 = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(run1.nextCursor, 'SO-2')
  assert.deepEqual(attempted, ['SO-1', 'SO-2'])

  const run2 = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(run2.allocated, 1)
  assert.ok(attempted.includes('SO-3'), 'the later eligible order is reached, not starved')
})

test('a batch-level failure leaves the cursor unchanged for an idempotent retry (o3d-9lx)', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2')],
    selectNeedingAllocation: async () => {
      throw new Error('selection query failed')
    },
  })
  await assert.rejects(() => sweepUnallocatedProcessingOrders({ deps }), /selection query failed/)
  // The cursor is persisted only AFTER the batch is handled, so a throw leaves it untouched.
  assert.deepEqual(calls.stateWrites, [])
})
