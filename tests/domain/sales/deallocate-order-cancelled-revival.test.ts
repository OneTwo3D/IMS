import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-e2mz r8 (o3d-psvi check) — CANCELLED HAD AN EXIT AFTER ALL, AND IT WAS THIS ONE.
 *
 * The whole branch leans on a sales order being able to LEAVE `CANCELLED` never — `SALES_ORDER_TRANSITIONS`
 * says `CANCELLED: []` — because that is what makes "re-read the sale and find it live" a proof that it
 * is not the cancelled case, and what makes retiring a row a terminal act rather than a pause.
 *
 * `deallocateOrder` broke it. It read the order's status at the TOP of the action, outside the
 * transaction and before `lockSalesOrder`, then decided on that stale value inside the lock and wrote
 * `where: { id: orderId }` with no status predicate. An order that was `ALLOCATED` when the operator
 * clicked, and was cancelled before the lock was taken, came back as `PROCESSING` — its accounting work
 * live again, `validateSalesOrderStatusTransition` unable to object because it was being shown
 * `ALLOCATED`. The cancellation deletes the order's PENDING/PICKING/PACKED shipments, so neither the
 * committed-shipment guard nor the belt-and-braces shipment count stands in the way either.
 */

type State = {
  /** What the PRE-LOCK read at the top of the action returns. */
  preLockStatus: string
  /** What the row actually is by the time the lock is taken — i.e. after a concurrent cancellation. */
  lockedStatus: string
  /** Every write aimed at the sales order, with the `where` it was scoped to. */
  orderWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  /** Ordered log, so "read under the lock" is an assertion and not a hope. */
  journal: string[]
}

const state: State = { preLockStatus: 'ALLOCATED', lockedStatus: 'ALLOCATED', orderWrites: [], journal: [] }

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-test', role: 'ADMIN' } }),
    requireAuth: async () => ({ user: { id: 'user-test', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/shopping', {
  namedExports: { enqueueStockSync: async () => {}, pushOrderDeliveryMetadata: async () => {} },
})

/**
 * The release itself is not what is under test and has its own suite; what matters here is that it
 * does NOT decide the status, and that the lock is taken before the decision.
 */
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => { state.journal.push(`lock:${orderId}`) },
    releaseOrderAllocationsForDeallocationInTx: async () => {
      state.journal.push('release')
      return {
        allocations: [],
        clampedReservationCount: 0,
        deletedPendingShipmentCount: 0,
        retiredPendingShipments: [],
      }
    },
    allocateSalesOrder: async () => ({}),
    applyAllocationReservationDelta: async () => {},
    buildAvailableStockMap: () => new Map(),
    canonicalAllocationQty: (value: unknown) => value,
    lockStockLevels: async () => {},
    releaseOrderAllocationsInTx: async () => ({ allocations: [], clampedReservationCount: 0, deletedPendingShipmentCount: 0, retiredPendingShipments: [] }),
    resetAllocationAccountingIfStaged: async () => {},
    validateAllocationIntegrity: async () => null,
  },
})

const tx = {
  $queryRaw: async () => [],
  salesOrder: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      state.journal.push(`locked-read:${where.id}`)
      return { status: state.lockedStatus }
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.orderWrites.push({ where, data })
      return {}
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.orderWrites.push({ where, data })
      // Honours the status predicate, so a write scoped to a status the row no longer holds really
      // matches nothing — a double returning a canned count would pass with the scoping removed.
      const matches = where.status === undefined || where.status === state.lockedStatus
      if (matches) state.lockedStatus = data.status as string
      return { count: matches ? 1 : 0 }
    },
  },
  shipment: {
    count: async () => 0,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          state.journal.push(`pre-lock-read:${where.id}`)
          return { orderNumber: 'SO-1', externalOrderNumber: null, status: state.preLockStatus }
        },
      },
      $transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
    },
  },
})

async function loadDeallocate() {
  return (await import('@/app/actions/allocation')).deallocateOrder
}

function reset(preLockStatus: string, lockedStatus: string) {
  state.preLockStatus = preLockStatus
  state.lockedStatus = lockedStatus
  state.orderWrites = []
  state.journal = []
}

test('o3d-e2mz r8: an order cancelled between the pre-lock read and the lock is NOT revived to PROCESSING', async () => {
  // The window: ALLOCATED when the operator clicked, CANCELLED by the time the lock was taken.
  reset('ALLOCATED', 'CANCELLED')

  const result = await (await loadDeallocate())('order-1')

  assert.equal(result.success, true, 'the allocations are still released — cancelling does not make the release wrong')
  assert.equal(state.lockedStatus, 'CANCELLED', 'and the cancelled order STAYS cancelled')
  assert.deepEqual(
    state.orderWrites,
    [],
    'no status write is even attempted: the demotion is decided on the status read under the lock',
  )
})

test('o3d-e2mz r8: the deciding status read is taken under the lock, after it, not before the transaction', async () => {
  // WHY the test above can be trusted. A pre-transaction read is one a cancellation can overtake, and
  // it is the read the old code decided on.
  reset('ALLOCATED', 'CANCELLED')

  await (await loadDeallocate())('order-1')

  assert.deepEqual(
    state.journal,
    ['pre-lock-read:order-1', 'lock:order-1', 'release', 'locked-read:order-1'],
    'the lock comes before the read that decides',
  )
})

test('o3d-e2mz r8: an order still ALLOCATED under the lock is demoted as before, scoped to that status', async () => {
  // THE COUNTER-GUARD, and the proof the fixtures above reach the state under test: the identical call
  // on an order that really is still ALLOCATED does perform the demotion.
  reset('ALLOCATED', 'ALLOCATED')

  const result = await (await loadDeallocate())('order-1')

  assert.equal(result.success, true)
  assert.equal(state.lockedStatus, 'PROCESSING', 'the ordinary deallocation still returns the order to PROCESSING')
  assert.deepEqual(state.orderWrites, [
    { where: { id: 'order-1', status: 'ALLOCATED' }, data: { status: 'PROCESSING' } },
  ], 'and the write names the status it was decided on, so it cannot land on a row that moved')
})

test('o3d-e2mz r8: an order that reached PICKING under the lock is not dragged back to PROCESSING either', async () => {
  // The same defect from the other side, and the reason the fix is a re-read rather than a CANCELLED
  // special case: ALLOCATED -> PICKING is a legal move that the stale read would also have overwritten.
  reset('ALLOCATED', 'PICKING')

  await (await loadDeallocate())('order-1')

  assert.equal(state.lockedStatus, 'PICKING')
  assert.deepEqual(state.orderWrites, [])
})
