import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0qoo — releaseOverallocations un-stages Group A2 for an order whose allocations it is
 * about to release. inventoryAllocatedBatchRef holds the exact AccountingSyncLog.referenceId
 * A2 staged that order into, and findSalesOrderDeleteBlocker matches on it INDEPENDENTLY of
 * inventoryAllocatedDate. So the ref has to be nulled in the same update as the stamp: a row
 * left holding a ref with no stamp is blocked forever against a batch it has already left.
 *
 * The rebalancer swallows every per-item failure into an activity log, so a broken double
 * would otherwise look like a pass. Every test below asserts the failure log stayed empty.
 */

type Row = Record<string, unknown>

const state = {
  /** Every salesOrder.update payload, in call order. */
  salesOrderUpdates: [] as Row[],
  /** Every orderAllocation.updateMany payload. */
  allocationUpdates: [] as Row[],
  activity: [] as Row[],
  stockLevel: { quantity: 0, reservedQty: 0 },
  allocations: [] as Row[],
  /** Set when the fixture wants a journaled (Group B posted) shipment on the order. */
  journaledShipment: null as Row | null,
  deletedAllocationIds: [] as string[],
  remainingAllocationsAfterRelease: 0,
}

function reset() {
  state.salesOrderUpdates.length = 0
  state.allocationUpdates.length = 0
  state.activity.length = 0
  state.allocations.length = 0
  state.deletedAllocationIds.length = 0
  state.stockLevel = { quantity: 0, reservedQty: 0 }
  state.journaledShipment = null
  state.remainingAllocationsAfterRelease = 0
}

mock.module('next/cache', {
  namedExports: { revalidatePath: () => {} },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

// Dynamically imported by the reconcile pass at the end of releaseOverallocations; stubbed so
// the test never reaches the real allocator (which would want a database).
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})

const tx = {
  $queryRaw: async () => [],
  stockLevel: {
    findUnique: async () => ({ ...state.stockLevel }),
    updateMany: async () => ({ count: 1 }),
  },
  shipmentLine: {
    findMany: async () => [],
  },
  shipment: {
    findFirst: async () => state.journaledShipment,
    deleteMany: async () => ({ count: 0 }),
  },
  salesOrder: {
    update: async ({ data }: { data: Row }) => {
      state.salesOrderUpdates.push(data)
      return {}
    },
  },
  orderAllocation: {
    findMany: async () => state.allocations.map((row) => ({ ...row })),
    updateMany: async ({ data }: { data: Row }) => {
      state.allocationUpdates.push(data)
      return { count: 1 }
    },
    update: async () => ({}),
    delete: async ({ where }: { where: { id: string } }) => {
      state.deletedAllocationIds.push(where.id)
      return {}
    },
    count: async () => state.remainingAllocationsAfterRelease,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        // Phase 1 candidate gather, outside the transaction.
        findMany: async () => state.allocations.map((row) => ({
          orderId: row.orderId,
          order: { createdAt: new Date('2026-01-01T00:00:00Z') },
        })),
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  },
})

async function loadRebalancer() {
  return import('@/lib/fulfillment/overallocation-rebalancer')
}

function seedStagedOverallocation() {
  // 1 unit on hand, 2 reserved by a single A2-staged order: excess 1, so the order's
  // allocation is fully released and the A2 un-stage branch runs.
  state.stockLevel = { quantity: 1, reservedQty: 2 }
  state.remainingAllocationsAfterRelease = 0
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    qty: 1,
    order: {
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      status: 'ALLOCATED',
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    },
  }]
}

/** The A2 un-stage write, distinguished from the ALLOCATED→PROCESSING status write. */
function unstageWrite() {
  return state.salesOrderUpdates.find((data) => 'inventoryAllocatedDate' in data)
}

function assertNoSwallowedFailure() {
  const failures = state.activity.filter((entry) => entry.action === 'overallocation_release_failed')
  assert.deepEqual(
    failures.map((entry) => entry.description),
    [],
    'releaseOverallocations swallows exceptions into an activity log — a failure here means the test never exercised the un-stage',
  )
}

test('releaseOverallocations clears inventoryAllocatedBatchRef in the same update as the stamp (o3d-0qoo)', async () => {
  reset()
  seedStagedOverallocation()
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 1, 'the overallocated unit was actually released')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-1'])

  const write = unstageWrite()
  assert.ok(write, 'the A2 un-stage write must have happened')
  // deepEqual, not a per-key lookup: it proves the ref key is PRESENT and null rather than
  // merely absent, which is exactly what an omitted Prisma field would look like.
  assert.deepEqual(write, {
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
  })
  assert.deepEqual(state.allocationUpdates.length, 1, 'and the cost snapshots are still nulled alongside it')
})

test('releaseOverallocations skips the order entirely when a shipment is journaled (o3d-0qoo)', async () => {
  // Group B posted means the release is refused, so neither the stamp nor the ref is touched —
  // the order stays findable against its A2 batch rather than silently losing the handle.
  reset()
  seedStagedOverallocation()
  state.journaledShipment = { id: 'shipment-1' }
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'transfer_dispatch', referenceId: 'tr-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 0)
  assert.equal(result.skipped, 1)
  assert.equal(unstageWrite(), undefined, 'no un-stage write at all on the refused path')
  assert.deepEqual(state.deletedAllocationIds, [], 'and the allocation survives')
})
