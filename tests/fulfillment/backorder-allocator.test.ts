import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-4kfh r5 (Codex finding 4) — THE POST-RELEASE REPAIR MUST NOT BE BLOCKED BY A RETAINED DRAFT.
 *
 * `allocateBackordersForProducts` is the repair pass the overallocation rebalancer runs after it
 * releases. The rebalancer releases ONE (product, warehouse) allocation at a time, so trimming leaf
 * A of an A+B kit leaves sibling B disproportionate, and this pass is what rebuilds the order.
 *
 * It used to exclude any order with ANY Shipment row (`shipments: { none: {} }`) and to pass
 * `refuseIfShipmentsExist` to the allocator. That was written before `reconcilePendingShipments`,
 * when rebuilding OrderAllocation really did leave stale draft ShipmentLines behind. Once the
 * reconciler started RETAINING an unrelated still-backed PENDING draft — deliberately, so an
 * operator's tracking number survives — that retained draft made this pass skip the order, and B's
 * reservation stayed stranded until it failed integrity at confirm-for-picking. The flat census
 * cannot see it, and the rebalancer's own tests mock this module out entirely, so nothing could.
 *
 * This file exists because that is the ONLY seam where the filter can be observed. It doubles the
 * two things the pass reads (the candidate query and the allocator) and asserts the predicate the
 * database is actually sent, plus the flag the allocator is actually given.
 */

type Row = Record<string, unknown>

type OrderFixture = {
  id: string
  lines: Array<{ id: string; qty: number; productId: string }>
}

const state = {
  /** The `where` the candidate query was sent — the predicate under test. */
  candidateWhere: null as Row | null,
  orders: [] as OrderFixture[],
  /** Every autoAllocateOrder call, with the options it was given. */
  allocateCalls: [] as Array<{ orderId: string; options: Row }>,
  activity: [] as Row[],
}

function reset() {
  state.candidateWhere = null
  state.orders.length = 0
  state.allocateCalls.length = 0
  state.activity.length = 0
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/shopping', {
  namedExports: { enqueueStockSync: async () => {} },
})

/**
 * The coverage selector decides which candidates have outstanding demand on a replenished leaf.
 * Stubbed to pass everything through: this file is about the SHIPMENT filter, and a selector that
 * silently dropped the fixture would make every assertion below vacuous in the passing direction.
 */
mock.module('@/lib/fulfillment/order-allocation-coverage', {
  namedExports: {
    selectOrdersNeedingAllocation: async (candidates: OrderFixture[]) => candidates,
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async (orderId: string, options: Row) => {
      state.allocateCalls.push({ orderId, options })
      return { success: true, allocationCount: 1, syncProductIds: [] }
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      productComponent: {
        // No KIT parents in these fixtures; the expansion walk is tested elsewhere.
        findMany: async () => [],
      },
      salesOrder: {
        findMany: async ({ where }: { where: Row }) => {
          state.candidateWhere = where
          return state.orders.map((order) => ({
            id: order.id,
            orderNumber: `SO-${order.id}`,
            externalOrderNumber: null,
            refundStatus: 'NONE',
            lines: order.lines,
          }))
        },
      },
    },
  },
})

async function loadAllocator() {
  return import('@/lib/fulfillment/backorder-allocator')
}

function seedOrder(id: string) {
  state.orders.push({ id, lines: [{ id: `${id}-line`, qty: 5, productId: 'leaf-a' }] })
}

test('o3d-4kfh r5: the candidate filter excludes only COMMITTED shipments, not PENDING drafts', async () => {
  // The predicate, read off the query the module actually sends. `{ none: {} }` — the old shape —
  // excluded an order because it had a draft at all, which is precisely the strand.
  reset()
  seedOrder('order-1')
  const { allocateBackordersForProducts } = await loadAllocator()

  await allocateBackordersForProducts(['leaf-a'], { source: 'stock_adjustment' })

  assert.ok(state.candidateWhere, 'the candidate query must have run')
  assert.deepEqual(
    (state.candidateWhere as { shipments: unknown }).shipments,
    { none: { status: { not: 'PENDING' } } },
    'an order whose only shipments are PENDING drafts is still a candidate for repair',
  )
})

test('o3d-4kfh r5: the under-lock re-check asks the SAME question as the candidate filter', async () => {
  // If the two disagreed the fix would be cosmetic: the order would be selected because its only
  // shipment is a draft and then refused the moment the row lock was granted, leaving the sibling
  // leaf stranded exactly as before.
  reset()
  seedOrder('order-1')
  const { allocateBackordersForProducts } = await loadAllocator()

  await allocateBackordersForProducts(['leaf-a'], { source: 'stock_adjustment' })

  assert.equal(state.allocateCalls.length, 1)
  const options = state.allocateCalls[0].options as {
    refuseIfShipmentsExist?: boolean
    refuseIfCommittedShipmentsExist?: boolean
    requireStatusUnderLock?: readonly string[]
  }
  assert.equal(
    options.refuseIfShipmentsExist,
    undefined,
    'the blanket refusal is what made a retained draft block the repair',
  )
  assert.equal(options.refuseIfCommittedShipmentsExist, true)
  assert.deepEqual(
    [...(options.requireStatusUnderLock ?? [])],
    ['PROCESSING', 'ALLOCATED'],
    'the o3d-6ab eligibility re-check is untouched',
  )
})

test('o3d-4kfh r5: candidates are still restricted to open, backorder-eligible orders', async () => {
  // The rest of the predicate must not have drifted while the shipment half was narrowed.
  reset()
  seedOrder('order-1')
  const { allocateBackordersForProducts } = await loadAllocator()

  await allocateBackordersForProducts(['leaf-a'], { source: 'stock_adjustment' })

  const where = state.candidateWhere as {
    status: { in: string[] }
    lines: { some: { productId: { in: string[] } } }
  }
  assert.deepEqual(where.status.in, ['PROCESSING', 'ALLOCATED'])
  assert.deepEqual(where.lines.some.productId.in, ['leaf-a'])
})
