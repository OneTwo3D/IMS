import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sweepUnallocatedProcessingOrders,
  type ReallocationSweepDeps,
} from '@/lib/fulfillment/reallocation-sweep'

// o3d-9lx: the sweep re-runs allocation for PROCESSING orders with outstanding demand (a paid order
// whose poller allocation failed transiently), gated on allocation state — not payment state — and
// walks the PROCESSING set via a durable keyset cursor so permanent backorders can't starve later
// orders. All collaborators are injected so the orchestration is verified without a DB.

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
    cursorWrites: [] as string[],
  }
  let cursor = ''
  const deps: Deps = {
    readCursor: async () => cursor,
    writeCursor: async (c) => {
      cursor = c
      calls.cursorWrites.push(c)
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
  // SO-2 is still allocated even though SO-1 threw first — the loop doesn't abort.
  assert.equal(result.allocated, 1)
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

// --- Durable keyset cursor: guarantees progress, prevents starvation --------

test('a full page advances the cursor to the last-scanned id and reports a remainder', async () => {
  const { deps, calls } = baseDeps({
    // limit=2 -> loader returns limit+1=3; the 3rd row signals a remainder.
    loadCandidatesPage: async () => [order('SO-1'), order('SO-2'), order('SO-3')],
    selectNeedingAllocation: async () => [],
  })
  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(result.hasRemainder, true)
  assert.equal(result.scanned, 2) // the extra row is a lookahead, not processed
  assert.equal(result.nextCursor, 'SO-2') // cursor = last id in the processed batch
  assert.deepEqual(calls.cursorWrites, ['SO-2'])
})

test('a final (short) page wraps the cursor back to the start', async () => {
  const { deps, calls } = baseDeps({
    loadCandidatesPage: async () => [order('SO-9')], // fewer than limit+1 -> last page
    selectNeedingAllocation: async () => [],
  })
  const result = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(result.hasRemainder, false)
  assert.equal(result.nextCursor, '')
  assert.deepEqual(calls.cursorWrites, [''])
})

test('a stable first page of benign backorders does not starve a later eligible order (o3d-9lx)', async () => {
  // Page 1 = two permanent no-stock backorders (always PROCESSING, never allocatable). Page 2 (after the
  // cursor advances) holds a genuinely-stranded order WITH stock. The cursor must reach it on run 2.
  const pages: Record<string, Candidate[]> = {
    '': [order('SO-1'), order('SO-2'), order('SO-3')], // limit=2 -> remainder; batch = SO-1,SO-2
    'SO-2': [order('SO-3')], // next page: the eligible order
  }
  let cursor = ''
  const attempted: string[] = []
  const deps: Deps = {
    readCursor: async () => cursor,
    writeCursor: async (c) => {
      cursor = c
    },
    loadCandidatesPage: async (cur) => pages[cur] ?? [],
    // SO-1/SO-2 never need allocation-that-succeeds (benign); SO-3 does.
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
  assert.deepEqual(attempted, ['SO-1', 'SO-2']) // page 1 only

  const run2 = await sweepUnallocatedProcessingOrders({ limit: 2, deps })
  assert.equal(run2.allocated, 1)
  assert.ok(attempted.includes('SO-3'), 'the later eligible order is reached on the next tick, not starved')
  assert.equal(run2.nextCursor, '') // short page -> wrap
})
