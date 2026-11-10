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
  orderStatus: 'ON_HOLD',
  reconcileCalls: [] as Array<{ orderId: string; options: Row | undefined }>,
  reconcileResult: { orderReachedShipped: true } as Row,
  activity: [] as Row[],
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
      salesOrderLine: { findMany: async () => [] },
      shipmentLine: { findMany: async () => [] },
      salesOrderRefundLine: { findMany: async () => [] },
      stockMovement: { findMany: async () => [] },
      orderAllocation: { count: async () => 1 },
      // Every shipment is already SHIPPED, so none is `not: SHIPPED`.
      shipment: { count: async () => 1, findMany: async () => [] },
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1, unallocatedQty: 0 }),
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async () => ({ success: true }),
  },
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
  state.orderStatus = 'ON_HOLD'
  state.reconcileCalls = []
  state.reconcileResult = { orderReachedShipped: true }
  state.activity = []
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
  state.orderStatus = 'ON_HOLD'

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
