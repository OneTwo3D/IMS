import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 — a shipment shipped INSIDE IMS must complete the WooCommerce order.
 *
 * `updateShipmentStatus` (the in-app dispatch) reconciled the order to SHIPPED and then pushed only
 * the tracking, so the WooCommerce order stayed `processing` and no "completed" email went out —
 * while the WMS path (`applyExternalFulfillmentUpdate`) did push the status. These tests drive the
 * REAL `updateShipmentStatus` and the REAL completion helper; only the storage and the connector
 * edge are doubles.
 *
 * The reconcile double mirrors the one thing the action reads from the real function — "did THIS
 * call move the order to SHIPPED" — over shipment rows it owns, and every arm asserts its
 * precondition from the double's own record (`reconcileResults`, the order's final status) so a
 * double that never reached the branch cannot pass an arm by examining nothing.
 */

type Shipment = { id: string; orderId: string; status: string }

const state = {
  orderStatus: 'ALLOCATED',
  shipments: [] as Shipment[],
  /** Everything the connector edge was asked to do, in order. */
  calls: [] as string[],
  reconcileResults: [] as Array<Record<string, unknown>>,
  reconcileOptions: [] as Array<Record<string, unknown> | undefined>,
  activity: [] as Array<Record<string, unknown>>,
  trackingBehaviour: 'ok' as 'ok' | 'throw',
  statusBehaviour: 'ok' as 'ok' | 'throw' | 'fail',
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    requireInternalUser: async () => ({ user: { id: 'op-1' } }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('@/lib/dispatch-email', {
  namedExports: { queueDispatchEmailIfEligible: async () => {} },
})
mock.module('@/lib/db', { namedExports: { db: {} } })

mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => { state.calls.push('stock') },
    pushOrderDeliveryMetadata: async (orderId: string) => {
      state.calls.push(`tracking:${orderId}`)
      if (state.trackingBehaviour === 'throw') throw new Error('tracking push exploded')
      return { success: true }
    },
    pushSalesOrderStatus: async (orderId: string, status: string) => {
      state.calls.push(`status:${orderId}:${status}`)
      if (state.statusBehaviour === 'throw') throw new Error('status push exploded')
      if (state.statusBehaviour === 'fail') return { success: false, error: 'WooCommerce: 503' }
      return { success: true }
    },
  },
})

mock.module('@/lib/domain/sales/shipment-service', {
  namedExports: {
    // Flips the shipment row; reports `transitioned: false` for a repeat, exactly like the real one.
    transitionShipmentStatus: async (_client: unknown, input: { shipmentId: string; targetStatus: string }) => {
      const row = state.shipments.find((s) => s.id === input.shipmentId)
      if (!row) return { success: false, error: 'Shipment not found' }
      const transitioned = row.status !== input.targetStatus
      const previousStatus = row.status
      row.status = input.targetStatus
      return {
        success: true,
        transitioned,
        dispatched: false,
        previousStatus,
        targetStatus: input.targetStatus,
        stockSyncProductIds: ['prod-1'],
        shipment: {
          id: row.id,
          orderId: row.orderId,
          lines: [],
          warehouse: { code: 'WH1' },
          order: { orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
        },
      }
    },
    // The decision the action consumes: every shipment SHIPPED and the order not already terminal
    // -> THIS call promoted it, and says so with `orderReachedShipped`.
    reconcileOrderAfterShipment: async (
      _client: unknown,
      shipment: { orderId: string },
      _extra?: unknown,
      options?: Record<string, unknown>,
    ) => {
      state.reconcileOptions.push(options)
      const allShipped = state.shipments.every((s) => s.status === 'SHIPPED')
      let result: Record<string, unknown> = { shouldGenerateInvoice: false, orderId: shipment.orderId }
      if (allShipped && !['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'].includes(state.orderStatus)) {
        state.orderStatus = 'SHIPPED'
        result = { ...result, orderReachedShipped: true }
      }
      state.reconcileResults.push(result)
      return result
    },
    confirmSalesOrderShipments: async () => ({}),
    discardCancelledOrderShipmentsInTx: async () => ({ discarded: [] }),
    reopenShipmentForRepack: async () => ({}),
  },
})

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    allocateSalesOrder: async () => ({}),
    applyAllocationReservationDelta: async () => {},
    buildAvailableStockMap: () => new Map(),
    canonicalAllocationQty: (v: unknown) => v,
    clearDormantFulfillmentPinsInTx: async () => {},
    lockAccountedRecordsForScope: async () => {},
    floorAvailableStockMapToCanonicalScale: () => new Map(),
    lockSalesOrder: async () => {},
    lockStockLevels: async () => {},
    refileAccountedRecordsForScope: async () => {},
    releaseOrderAllocationsForDeallocationInTx: async () => ({ allocs: [], deletedPendingShipmentCount: 0 }),
    resetAllocationAccountingIfStaged: async () => {},
    validateAllocationIntegrity: async () => {},
    ALLOCATION_TX_OPTIONS: { maxWait: 5000, timeout: 20000 },
  },
})

function seed(orderStatus: string, shipmentStatuses: string[]) {
  state.orderStatus = orderStatus
  state.shipments = shipmentStatuses.map((status, i) => ({ id: `ship-${i + 1}`, orderId: 'so-1', status }))
  state.calls.length = 0
  state.reconcileResults.length = 0
  state.reconcileOptions.length = 0
  state.activity.length = 0
  state.trackingBehaviour = 'ok'
  state.statusBehaviour = 'ok'
}

beforeEach(() => seed('ALLOCATED', ['PACKED']))

async function ship(shipmentId: string, options?: Record<string, unknown>) {
  const { updateShipmentStatus } = await import('@/app/actions/allocation')
  return updateShipmentStatus(shipmentId, 'SHIPPED', undefined, options)
}

const STATUS_CALLS = (calls: string[]) => calls.filter((c) => c.startsWith('status:'))

test('o3d-zvec.15 (a): the LAST shipment shipped pushes tracking THEN the status, exactly once', async () => {
  seed('ALLOCATED', ['PACKED'])
  const result = await ship('ship-1')

  // Preconditions: the shipment really shipped and THIS call really took the order to SHIPPED.
  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.reconcileResults.length, 1, 'the reconcile double was reached')
  assert.equal(state.reconcileResults[0].orderReachedShipped, true, 'and it promoted the order')
  assert.equal(state.orderStatus, 'SHIPPED')

  const pushes = state.calls.filter((c) => c !== 'stock')
  assert.deepEqual(pushes, ['tracking:so-1', 'status:so-1:SHIPPED'], 'tracking first so the completed email carries it, then the status, once')
})

test('o3d-zvec.15 (b): a PARTIAL shipment pushes tracking but never the status', async () => {
  seed('ALLOCATED', ['PACKED', 'PACKED'])
  const result = await ship('ship-1')

  // Preconditions: one shipment shipped, one still open, and the order did NOT reach SHIPPED.
  assert.equal(result.success, true)
  assert.deepEqual(state.shipments.map((s) => s.status), ['SHIPPED', 'PACKED'])
  assert.equal(state.reconcileResults.length, 1, 'the reconcile double was reached')
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.equal(state.orderStatus, 'ALLOCATED')

  assert.deepEqual(state.calls.filter((c) => c.startsWith('tracking:')), ['tracking:so-1'], 'tracking still flows for the shipped part')
  assert.deepEqual(STATUS_CALLS(state.calls), [], 'but the order has not reached SHIPPED, so nothing is promoted')
})

test('o3d-zvec.15 (b2): shipping the SECOND of two shipments is the one that completes it', async () => {
  seed('ALLOCATED', ['PACKED', 'PACKED'])
  await ship('ship-1')
  assert.deepEqual(STATUS_CALLS(state.calls), [], 'precondition: nothing pushed after the first')
  await ship('ship-2')

  assert.equal(state.orderStatus, 'SHIPPED', 'precondition: the second shipment completed the order')
  assert.deepEqual(STATUS_CALLS(state.calls), ['status:so-1:SHIPPED'])
})

test('o3d-zvec.15 (b3): a shortfall-held order (reconcile did not promote it) pushes no status', async () => {
  // The real reconcile leaves a short order in its pre-shipment status. Model it by an order the
  // double will not promote, and prove the double really declined (no `orderReachedShipped`).
  seed('CANCELLED', ['PACKED'])
  const result = await ship('ship-1')

  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.reconcileResults.length, 1)
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.deepEqual(STATUS_CALLS(state.calls), [])
})

test('o3d-zvec.15 (d): a status push that THROWS or FAILS does not fail the shipment, and is logged', async () => {
  for (const behaviour of ['throw', 'fail'] as const) {
    seed('ALLOCATED', ['PACKED'])
    state.statusBehaviour = behaviour
    const result = await ship('ship-1')

    // Preconditions: the failing double was actually called, and the order did reach SHIPPED.
    assert.deepEqual(STATUS_CALLS(state.calls), ['status:so-1:SHIPPED'], `${behaviour}: the status push was attempted`)
    assert.equal(state.orderStatus, 'SHIPPED')

    assert.equal(result.success, true, `${behaviour}: the shipment must not be failed by a storefront push`)
    assert.equal(state.shipments[0].status, 'SHIPPED', `${behaviour}: and not rolled back`)
    const logged = state.activity.filter((a) => a.action === 'shopping_status_push_failed')
    assert.equal(logged.length, 1, `${behaviour}: the failure is visible, not silent`)
  }
})

test('o3d-zvec.15 (d2): a tracking push that throws does not stop the status push, nor fail the shipment', async () => {
  seed('ALLOCATED', ['PACKED'])
  state.trackingBehaviour = 'throw'
  const result = await ship('ship-1')

  assert.ok(state.calls.includes('tracking:so-1'), 'precondition: the throwing tracking double was reached')
  assert.equal(result.success, true)
  assert.deepEqual(STATUS_CALLS(state.calls), ['status:so-1:SHIPPED'])
})

test('o3d-zvec.15 (e): re-running the same shipment (a retry) does not push the status twice', async () => {
  seed('ALLOCATED', ['PACKED'])
  await ship('ship-1')
  assert.deepEqual(STATUS_CALLS(state.calls), ['status:so-1:SHIPPED'], 'precondition: the first run pushed once')

  const retry = await ship('ship-1')
  assert.equal(retry.success, true)
  assert.equal(state.reconcileResults.length, 2, 'precondition: the retry reached reconcile')
  assert.equal(state.reconcileResults[1].orderReachedShipped, undefined, 'and reconcile reported nothing new')
  assert.deepEqual(STATUS_CALLS(state.calls), ['status:so-1:SHIPPED'], 'still exactly one status push')
})

test('o3d-zvec.15 (e2): an order ALREADY SHIPPED by another path is not pushed again when its last shipment lands', async () => {
  // The second-path case, isolated from the retry guard: this call DOES transition the shipment, so
  // only "did this call promote the order" can keep the push from happening twice.
  seed('SHIPPED', ['PACKED'])
  const result = await ship('ship-1')

  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED', 'precondition: the shipment really transitioned')
  assert.equal(state.reconcileResults.length, 1)
  assert.equal(state.reconcileResults[0].orderReachedShipped, undefined)
  assert.deepEqual(STATUS_CALLS(state.calls), [], 'the order was promoted elsewhere, which owns its status push')
})

test('o3d-zvec.15 (g): an EXTERNALLY fulfilled dispatch leaves the status push to its own caller', async () => {
  // applyExternalFulfillmentUpdate pushes the status itself after every shipment is applied, and a
  // storefront-sourced completion must never echo it back. Under EXTERNAL authority this action
  // pushes tracking only.
  seed('ALLOCATED', ['PACKED'])
  const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
  const result = await ship('ship-1', { internalBypassToken: INTERNAL_ACTION_BYPASS, completionAuthority: 'EXTERNAL' })

  assert.equal(result.success, true)
  assert.equal(state.reconcileResults[0]?.orderReachedShipped, true, 'precondition: the order did reach SHIPPED')
  assert.deepEqual(state.reconcileOptions[0], { completionAuthority: 'EXTERNAL' })
  assert.deepEqual(STATUS_CALLS(state.calls), [])
  assert.deepEqual(state.calls.filter((c) => c.startsWith('tracking:')), ['tracking:so-1'])
})
