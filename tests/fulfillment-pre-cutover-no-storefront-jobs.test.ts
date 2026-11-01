import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * A VERIFIED PRE-CUTOVER DISPATCH ENQUEUES ZERO STOREFRONT JOBS: ROWS AND JOBS COUNTED, NOT JUST THE TRANSPORT.
 *
 * The REAL `updateShipmentStatus` over the REAL `reconcileOrderAfterShipment`. The storage is an in-memory double with an
 * `integration_outbox` table (the completion scheduler inserts into it through the flip's own transaction client) and a
 * jobs log (the post-commit completion attempt and the tracking push). The same call is made twice: as an ordinary WMS
 * dispatch (the control: one outbox row, one completion attempt) and as a dispatch whose storefront record is already
 * complete (zero outbox rows, zero attempts, zero tracking pushes). The order is SHIPPED in both.
 *
 * What the SHIPPED transition still does for the already-complete case, and why each is not a storefront write of the
 * kind being suppressed: the IMS stock movement and COGS posting (IMS's own books; asserted by the shipment transition
 * double being reached), the stock-level sync (an absolute stock push triggered by the stock IMS just consumed, owned by
 * IMS from the cutover; it is not a repeat of the earlier writer's order write), the on_shipped invoice trigger and the
 * direct-order dispatch email (both inert for a storefront-linked order or unrelated to the storefront).
 */

type Order = { id: string; status: string; shippedAt?: Date | null; trackingNumber?: string | null }
const state = {
  order: { id: 'so-1', status: 'ALLOCATED' } as Order,
  shipments: [{ id: 'ship-1', orderId: 'so-1', status: 'PACKED', trackingNumber: 'T1' }],
  outbox: [] as Array<{ operation: string; orderId: string }>,
  jobs: [] as string[],
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'op-1' } }), requireInternalUser: async () => ({ user: { id: 'op-1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/dispatch-email', { namedExports: { queueDispatchEmailIfEligible: async () => { state.jobs.push('dispatch-email') } } })
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => { state.jobs.push('stock-sync') },
    pushOrderDeliveryMetadata: async (orderId: string) => { state.jobs.push(`tracking-push:${orderId}`); return { success: true } },
    scheduleShoppingOrderCompletion: async (_tx: unknown, input: { orderId: string }) => {
      state.outbox.push({ operation: 'woocommerce/order.complete', orderId: input.orderId })
      return `key-${input.orderId}`
    },
    processShoppingOrderCompletions: async (options: { idempotencyKeys?: string[] }) => {
      state.jobs.push(`completion-attempt:${(options.idempotencyKeys ?? []).join(',')}`)
      return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
    },
  },
})
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    allocateSalesOrder: async () => ({}), applyAllocationReservationDelta: async () => {}, buildAvailableStockMap: () => new Map(),
    canonicalAllocationQty: (v: unknown) => v, clearDormantFulfillmentPinsInTx: async () => {}, lockAccountedRecordsForScope: async () => {},
    floorAvailableStockMapToCanonicalScale: () => new Map(), lockSalesOrder: async () => {}, lockStockLevels: async () => {},
    refileAccountedRecordsForScope: async () => {}, releaseOrderAllocationsForDeallocationInTx: async () => ({ allocs: [], deletedPendingShipmentCount: 0 }),
    resetAllocationAccountingIfStaged: async () => {}, validateAllocationIntegrity: async () => {}, ALLOCATION_TX_OPTIONS: { maxWait: 5000, timeout: 20000 },
  },
})

// The storage the REAL reconcile runs over: a client whose transaction hands the callback a child of itself.
const client: Record<string, unknown> = {
  shipment: { findMany: async () => state.shipments },
  setting: { findUnique: async () => null },
  salesOrder: {
    findUnique: async () => ({ ...state.order }),
    update: async ({ data }: { data: Partial<Order> }) => { Object.assign(state.order, data); return state.order },
  },
  $queryRaw: async () => [],
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(Object.assign(Object.create(client), { isTransaction: true })),
}
mock.module('@/lib/db', { namedExports: { db: client } })

// The REAL shipment-service, with only the row-level transition replaced (that is storage, not the subject). Installed lazily
// (no top-level await in this CommonJS build) and BEFORE the action is first imported.
let installed = false
async function installShipmentServiceDouble() {
  if (installed) return
  installed = true
  const realShipmentService = await import('@/lib/domain/sales/shipment-service')
  mock.module('@/lib/domain/sales/shipment-service', {
    namedExports: {
      ...realShipmentService,
      transitionShipmentStatus: async (_client: unknown, input: { shipmentId: string; targetStatus: string }) => {
        const row = state.shipments.find((s) => s.id === input.shipmentId)!
        const previousStatus = row.status
        row.status = input.targetStatus
        state.jobs.push('stock-movement-and-cogs')
        return {
          success: true, transitioned: previousStatus !== input.targetStatus, dispatched: false, previousStatus, targetStatus: input.targetStatus,
          stockSyncProductIds: ['prod-1'],
          shipment: { id: row.id, orderId: row.orderId, lines: [], warehouse: { code: 'WH1' }, order: { orderNumber: 'SO-1', externalOrderNumber: 'WC-1' } },
        }
      },
    },
  })
}

beforeEach(() => {
  state.order = { id: 'so-1', status: 'ALLOCATED' }
  state.shipments = [{ id: 'ship-1', orderId: 'so-1', status: 'PACKED', trackingNumber: 'T1' }]
  state.outbox.length = 0
  state.jobs.length = 0
})

async function dispatch(options: Record<string, unknown>) {
  await installShipmentServiceDouble()
  const { updateShipmentStatus } = await import('@/app/actions/allocation')
  const result = await updateShipmentStatus('ship-1', 'SHIPPED', { trackingNumber: 'T1' }, { completionAuthority: 'EXTERNAL', internalBypassToken: (await import('@/lib/internal-action-bypass')).INTERNAL_ACTION_BYPASS, ...options })
  await new Promise((resolve) => setImmediate(resolve))
  return result
}

test('CONTROL: an ordinary WMS dispatch writes the completion outbox row and makes the completion attempt', async () => {
  const result = await dispatch({ storefrontCompletion: true })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.order.status, 'SHIPPED', 'PRECONDITION: the real reconcile flipped the order')
  assert.deepEqual(state.outbox, [{ operation: 'woocommerce/order.complete', orderId: 'so-1' }])
  assert.deepEqual(state.jobs.filter((j) => j.startsWith('completion-attempt')), ['completion-attempt:key-so-1'])
})

test('THE FINDING: a dispatch whose storefront record is already complete flips the order but writes ZERO outbox rows and makes ZERO storefront jobs', async () => {
  const result = await dispatch({ storefrontCompletion: false, skipStorefrontPush: true })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.order.status, 'SHIPPED', 'PRECONDITION: the order still reached SHIPPED in IMS')
  assert.ok(state.jobs.includes('stock-movement-and-cogs'), 'PRECONDITION: IMS booked the shipment')
  assert.equal(state.outbox.length, 0, 'no woocommerce/order.complete row')
  assert.deepEqual(state.jobs.filter((j) => j.startsWith('completion-attempt') || j.startsWith('tracking-push')), [], 'no completion attempt and no tracking push')
})

test('the storefront push is suppressed independently of the job: a dispatch that skips the push but still asks for the job writes the row (each guard is its own)', async () => {
  await dispatch({ storefrontCompletion: true, skipStorefrontPush: true })
  assert.equal(state.outbox.length, 1)
  assert.deepEqual(state.jobs.filter((j) => j.startsWith('completion-attempt')), [], 'no immediate attempt either')
})
