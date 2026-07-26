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
  let state: SweepCursorState = { cursor: '', watermark: '', generation: 0 }
  const deps: Deps = {
    readState: async () => state,
    // Mirrors the production compare-and-swap: the GENERATION decides, and a successful write
    // bumps it, so a stale run cannot pass by finding a reused cursor/watermark tuple.
    writeState: async (s, expected) => {
      if (state.generation !== expected.generation) return false
      state = { ...s, generation: state.generation + 1 }
      calls.stateWrites.push(s)
      return true
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
  assert.deepEqual(calls.stateWrites, [{ cursor: '', watermark: '', generation: 0 }])
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
  assert.deepEqual(calls.stateWrites, [{ cursor: 'SO-2', watermark: 'WM-MAX', generation: 0 }])
  assert.equal(calls.snapshots, 1) // snapshot taken once at cycle start
})

test('a short final page wraps: cursor and watermark cleared', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-9')],
    selectNeedingAllocation: async () => [],
  })
  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(result.hasRemainder, false)
  assert.deepEqual(calls.stateWrites, [{ cursor: '', watermark: '', generation: 0 }])
})

test('mid-cycle the snapshot is NOT retaken and the stored watermark bounds the page (o3d-9lx)', async () => {
  let passedWatermark = ''
  const { deps, calls } = baseDeps({
    readState: async () => ({ cursor: 'SO-2', watermark: 'WM-FIXED', generation: 0 }), // mid-cycle
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
  let state: SweepCursorState = { cursor: '', watermark: '', generation: 0 }
  const attempted: string[] = []
  const deps: Deps = {
    readState: async () => state,
    writeState: async (s, expected) => {
      if (state.generation !== expected.generation) return false
      state = { ...s, generation: state.generation + 1 }
      return true
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

// --- o3d-lvcb: the sweep and the o3d-6ab under-lock guard are only correct TOGETHER ---

test('the sweep re-asserts its own eligible set under the order lock (o3d-lvcb)', async () => {
  const seen: Array<readonly string[] | undefined> = []
  const { deps } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1')],
    autoAllocateOrder: async (_id, opts) => {
      seen.push(opts.requireStatusUnderLock)
      return { success: true, allocationCount: 1, syncProductIds: [] }
    },
  })

  await sweepUnallocatedProcessingOrders({ deps })

  // Without this the sweep reintroduces the very ON_HOLD race o3d-6ab closes: candidates are
  // selected outside the lock, so an order held in that window would be re-reserved.
  //
  // ALLOCATED matters as much as PROCESSING. The replenishment allocator selects both, and a skip
  // there consumes a one-shot stock trigger; ON_HOLD -> ALLOCATED is a legal transition, so a sweep
  // scanning only PROCESSING would leave an order returned to ALLOCATED outside its own backstop.
  assert.deepEqual(
    seen,
    [['PROCESSING', 'ALLOCATED']],
    'the guard must match the sweep\'s selection AND the replenishment allocator\'s eligible set',
  )
})

test('an order skipped while ALLOCATED is still re-selected by the sweep (o3d-lvcb)', async () => {
  // The status-set hole: the replenishment allocator treats ALLOCATED as eligible, so an ALLOCATED
  // order can skip and burn its trigger. If the sweep did not scan ALLOCATED, that shortfall would
  // be stranded permanently.
  let held = true
  const attempts: string[] = []
  const { deps } = baseDeps({
    loadCandidatesPage: async () => [order('SO-ALLOC')],
    autoAllocateOrder: async (orderId) => {
      attempts.push(orderId)
      if (held) return { success: false, skipped: true, allocationCount: 0, syncProductIds: [] }
      return { success: true, allocationCount: 1, syncProductIds: [] }
    },
  })

  const first = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(first.skipped, 1)

  held = false
  const second = await sweepUnallocatedProcessingOrders({ deps })

  assert.deepEqual(attempts, ['SO-ALLOC', 'SO-ALLOC'])
  assert.equal(second.allocated, 1, 'recovered without any new stock trigger')
})

test('a concurrent run that already advanced the cursor is not overwritten (o3d-lvcb)', async () => {
  // No lease guards the sweep — the cron rate limit is not mutual exclusion. A slow run finishing
  // after a newer one used to overwrite the newer cursor with its own stale value, repeating pages
  // and postponing later ones indefinitely. The compare-and-swap makes the stale write a no-op.
  let stored: SweepCursorState = { cursor: 'SO-5', watermark: 'WM', generation: 7 }
  const writes: SweepCursorState[] = []
  const { deps } = baseDeps({
    readState: async () => ({ cursor: 'SO-5', watermark: 'WM', generation: 7 }),
    loadCandidatesPage: async () => [order('SO-6'), order('SO-7'), order('SO-8')],
    selectNeedingAllocation: async () => [],
    writeState: async (next, expected) => {
      // A newer run advanced the cursor while this one was processing its batch.
      stored = { cursor: 'SO-99', watermark: 'WM', generation: 8 }
      if (stored.generation !== expected.generation) return false
      writes.push(next)
      return true
    },
  })

  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })

  assert.equal(result.cursorPersisted, false, 'the stale write is reported as discarded')
  assert.deepEqual(writes, [], 'and nothing was written')
  assert.equal(stored.cursor, 'SO-99', 'the newer run\'s progress stands')
})

test('a skipped order is counted, not logged as an error, and not counted as allocated (o3d-lvcb)', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2')],
    autoAllocateOrder: async (orderId) => {
      calls.alloc.push(orderId)
      // SO-1 left PROCESSING between selection and the lock: an explicit no-op, error undefined.
      if (orderId === 'SO-1') return { success: false, skipped: true, allocationCount: 0, syncProductIds: [] }
      return { success: true, allocationCount: 1, syncProductIds: ['p1'] }
    },
  })

  const result = await sweepUnallocatedProcessingOrders({ deps })

  assert.equal(result.skipped, 1, 'the skip is visible in telemetry rather than an invisible no-op')
  assert.equal(result.allocated, 1, 'a skip is not an allocation')
  assert.equal(result.errors, 0, 'and it is not a failure')
  assert.deepEqual(
    calls.logs.filter((log) => log.level === 'ERROR'),
    [],
    'a deliberate skip is never logged at ERROR',
  )
})

test('an order skipped on one cycle is re-selected on a later one — the trigger is not consumed (o3d-lvcb)', async () => {
  // The defect this pairing exists to prevent: a stock receipt is a ONE-SHOT replenishment
  // trigger. If allocation skips because the order was briefly ON_HOLD, the backorder path
  // records nothing and no status transition re-runs allocation. The sweep is gated on
  // ALLOCATION state, not on any trigger, so the order comes back round.
  let onHold = true
  const attempts: string[] = []
  const { deps } = baseDeps({
    // Cycle-invariant candidate set: the order stays under-allocated either way.
    loadCandidatesPage: async () => [order('SO-1')],
    autoAllocateOrder: async (orderId) => {
      attempts.push(orderId)
      if (onHold) return { success: false, skipped: true, allocationCount: 0, syncProductIds: [] }
      return { success: true, allocationCount: 1, syncProductIds: ['p1'] }
    },
  })

  const first = await sweepUnallocatedProcessingOrders({ deps })
  assert.equal(first.skipped, 1)
  assert.equal(first.allocated, 0, 'nothing allocated while the order was held')

  // The order returns to PROCESSING. No new stock event, no status hook — only the next sweep.
  onHold = false
  const second = await sweepUnallocatedProcessingOrders({ deps })

  assert.deepEqual(attempts, ['SO-1', 'SO-1'], 'the sweep re-attempted it without any new trigger')
  assert.equal(second.allocated, 1, 'and allocated it once it was eligible again')
  assert.equal(second.skipped, 0)
})

test('ABA: a stale run is rejected even when the cursor tuple has cycled back to what it read (o3d-lvcb)', async () => {
  // Comparing only cursor+watermark is not enough. Both are REUSABLE: a wrap writes
  // { cursor: '', watermark: '' }, which is also where every cycle starts. So a stalled run can
  // wake to find the exact tuple it read — after newer runs completed a whole cycle — and a
  // value-only CAS would pass, persisting a page computed from the previous cycle.
  const readAt: SweepCursorState = { cursor: '', watermark: 'WM', generation: 3 }
  let stored: SweepCursorState = { ...readAt }
  const writes: SweepCursorState[] = []

  const { deps } = baseDeps({
    readState: async () => readAt,
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2'), order('SO-3')],
    selectNeedingAllocation: async () => [],
    writeState: async (next, expected) => {
      // Two full cycles ran while this one was working. The tuple is byte-identical to what the
      // stale run read; only the generation records that anything happened.
      stored = { cursor: '', watermark: 'WM', generation: 5 }
      assert.deepEqual(
        { cursor: stored.cursor, watermark: stored.watermark },
        { cursor: expected.cursor, watermark: expected.watermark },
        'precondition: the values really did cycle back, so only the generation can catch this',
      )
      if (stored.generation !== expected.generation) return false
      writes.push(next)
      return true
    },
  })

  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })

  assert.equal(result.cursorPersisted, false, 'the stale write must be rejected on generation')
  assert.deepEqual(writes, [], 'nothing was persisted')
  assert.equal(stored.generation, 5, 'the newer generation stands')
})
