import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * SHP-H1 (WMS retry half): when every shipment on an order is already SHIPPED but the order was
 * never promoted (the promotion failed or was interrupted after the dispatch committed), the next
 * external update has no shipment left to transition. The retry must reconcile the ORDER, on the
 * unfenced WMS path too, and must report success only once the order really is shipped.
 * It used to log `external_fulfillment_applied` and return success on every sweep tick while the
 * order sat un-promoted for ever.
 */

type Row = Record<string, unknown>

const state = {
  orderStatus: 'PROCESSING',
  reconcileCalls: [] as Array<{ orderId: string; options: Row | undefined }>,
  reconcileResult: { orderReachedShipped: true } as Row,
  activity: [] as Row[],
  /** Shipments not yet SHIPPED, and the total on the order. */
  openShipments: [] as Row[],
  totalShipments: 1,
  transitions: [] as Array<{ target: string; options: Row | undefined }>,
  notifications: [] as Row[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({ id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: state.orderStatus }),
      },
      user: { findMany: async () => [{ id: 'admin-1' }] },
      salesOrderLine: { findMany: async () => [] },
      shipmentLine: { findMany: async () => [] },
      salesOrderRefundLine: { findMany: async () => [] },
      stockMovement: { findMany: async () => [] },
      orderAllocation: { count: async () => 1 },
      // Every shipment is already SHIPPED, so none is `not: SHIPPED`.
      shipment: { count: async () => state.totalShipments, findMany: async () => state.openShipments },
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1, unallocatedQty: 0 }),
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (_id: string, target: string, _extra: unknown, options: Row | undefined) => {
      state.transitions.push({ target, options })
      return { success: true }
    },
  },
})

mock.module('@/lib/notifications', {
  namedExports: { notify: async (entry: Row) => { state.notifications.push(entry) } },
})

mock.module('@/lib/domain/sales/shipment-service', {
  namedExports: {
    reconcileOrderAfterShipment: async (_db: unknown, shipment: { orderId: string }, _extra: unknown, options: Row | undefined) => {
      state.reconcileCalls.push({ orderId: shipment.orderId, options })
      return { shouldGenerateInvoice: false, orderId: shipment.orderId, ...state.reconcileResult }
    },
  },
})

function reset() {
  state.orderStatus = 'PROCESSING'
  state.reconcileCalls = []
  state.reconcileResult = { orderReachedShipped: true }
  state.activity = []
  state.openShipments = []
  state.totalShipments = 1
  state.transitions = []
  state.notifications = []
}

async function apply(extra: Row = {}) {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({
    source: 'mintsoft',
    lookup: { orderId: 'so-1' },
    targetShipmentStatus: 'SHIPPED',
    ...extra,
  } as never)
}

test('SHP-H1: an unfenced WMS retry with every shipment already SHIPPED reconciles the order and enqueues the completion', async () => {
  reset()
  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.equal(state.reconcileCalls.length, 1, 'the order must be reconciled, not skipped')
  assert.equal(state.reconcileCalls[0].options?.completionAuthority, 'EXTERNAL')
  assert.equal(state.reconcileCalls[0].options?.storefrontCompletion, true)
  assert.equal(state.reconcileCalls[0].options?.fence, undefined)
})

test('SHP-H1: the retry is NOT reported as applied while the order is still not shipped', async () => {
  reset()
  state.reconcileResult = {}
  state.orderStatus = 'PROCESSING'

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(state.activity.some((row) => row.action === 'external_fulfillment_applied'), false)
})

test('SHP-H1: a retry for an order that is already SHIPPED stays a success', async () => {
  reset()
  state.reconcileResult = {}
  state.orderStatus = 'SHIPPED'

  assert.deepEqual(await apply(), { success: true })
})

test('SHP-H1: a retry for an order the storefront already completed does not enqueue another completion', async () => {
  reset()
  const result = await apply({ source: 'woocommerce', storefrontAlreadyCompleted: true })

  assert.deepEqual(result, { success: true })
  assert.equal(state.reconcileCalls[0].options?.storefrontCompletion, false)
})

for (const held of ['ON_HOLD', 'PENDING_PAYMENT']) {
  test(`SHP-H1: a WMS despatch of a ${held} order is recorded, the order is not promoted, and a notice is raised`, async () => {
    reset()
    state.orderStatus = held
    state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

    const result = await apply()

    assert.deepEqual(result, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.transitions.length, 1)
    assert.equal(state.transitions[0].target, 'SHIPPED')
    assert.equal(state.transitions[0].options?.recordDespatchOnly, true)
    assert.equal(state.transitions[0].options?.storefrontCompletion, false, 'no storefront completion is queued')
    assert.equal(state.transitions[0].options?.skipStorefrontPush, true)
    assert.equal(state.reconcileCalls.length, 0, 'the order is not reconciled or promoted')
    assert.ok(state.activity.some((row) => row.action === 'external_fulfillment_order_not_ready' && row.level === 'WARNING'))
    assert.equal(state.notifications.length, 1)
  })

  test(`SHP-H1: the next sweep tick for a recorded ${held} despatch is a quiet success, not a second notice`, async () => {
    reset()
    state.orderStatus = held

    const result = await apply()

    assert.deepEqual(result, { success: true, despatchedWhileNotReady: held })
    assert.equal(state.reconcileCalls.length, 0)
    assert.equal(state.notifications.length, 0)
    assert.equal(state.activity.length, 0)
  })
}

test('SHP-H1: a WMS despatch for a DRAFT order is not recorded: it stays an unreconciled despatch for the operator', async () => {
  reset()
  state.orderStatus = 'DRAFT'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(!result.success && result.refusal, 'order_not_ready_to_ship')
  assert.equal(!result.success && result.permanent, false, 'retried, then dead-lettered into the exception inbox')
  assert.equal(state.transitions.length, 0, 'nothing is written: a draft has no allocation to consume')
  assert.equal(state.reconcileCalls.length, 0)
})

test('SHP-H1: a WMS despatch for a held order with no shipment is not recorded (creating one would lift the hold)', async () => {
  reset()
  state.orderStatus = 'ON_HOLD'
  state.totalShipments = 0

  const result = await apply()

  assert.equal(!result.success && result.refusal, 'order_not_ready_to_ship')
  assert.equal(state.transitions.length, 0)
})

test('SHP-H1: a WMS despatch for a PROCESSING order still promotes it', async () => {
  reset()
  state.orderStatus = 'PROCESSING'
  state.openShipments = [{ id: 'shp-1', status: 'PACKED' }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.equal(state.transitions[0].options?.recordDespatchOnly, undefined)
  assert.equal(state.transitions[0].options?.storefrontCompletion, true)
})
