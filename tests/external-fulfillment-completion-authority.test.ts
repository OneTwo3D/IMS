import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0i5y r2 — WHO DECIDES an externally fulfilled order is complete.
 *
 * `applyExternalFulfillmentUpdate` is the single boundary through which another system reports a
 * dispatch: the WooCommerce completion flow (Woo is "the dispatch authority for external storefront
 * orders") and the WMS dispatch sweep, which reaches its own verdict — per WMS part, in
 * `reconcileSplitOrder` — and only applies a dispatch once every part has despatched.
 *
 * The IMS shipment rows this function drives to SHIPPED are back-filled here from whatever IMS
 * stock was on hand, so they can under-cover the ordered qty while the 3PL shipped the lot. When
 * o3d-0i5y r1 added the shortfall check to the shared reconciliation, that check began evaluating
 * on these orders too: a correctly fulfilled WMS order was held out of SHIPPED, the storefront
 * completion push (and the customer despatch email it fires) was suppressed, and a `shipped_short`
 * WARNING was raised on EVERY external dispatch.
 *
 * So the boundary DECLARES the authority instead of the check guessing at it.
 */

type Row = Record<string, unknown>

const state = {
  orderStatus: 'PACKED',
  shipmentStatusOptions: [] as Array<Record<string, unknown> | undefined>,
  activity: [] as Row[],
  pushedStatuses: [] as string[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/shopping', {
  namedExports: {
    pushSalesOrderStatus: async (_orderId: string, status: string) => {
      state.pushedStatuses.push(status)
      return { success: true }
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1 }),
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (
      _shipmentId: string,
      _targetStatus: string,
      _extra?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      state.shipmentStatusOptions.push(options)
      // Stands in for the real reconciliation ON A SHORT ORDER, which is what an externally
      // fulfilled order's back-filled shipment rows generally are: promoted to SHIPPED only when
      // the caller declares that something else owns completion, held in its pre-shipment status
      // otherwise. Deliberately NOT a rubber stamp — a fake that always promotes would make the
      // completion-push test below pass with the declaration removed.
      if (options?.completionAuthority === 'EXTERNAL') state.orderStatus = 'SHIPPED'
      return { success: true }
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({
          id: 'order-1',
          orderNumber: 'SO-1',
          externalOrderNumber: 'WC-1',
          status: state.orderStatus,
        }),
      },
      // Already allocated and already has a shipment, so the auto-allocate / confirm branches stay
      // out of the way and the run is purely the status walk this test is about.
      orderAllocation: { count: async () => 1 },
      shipment: {
        count: async () => 1,
        findMany: async () => [{ id: 'shipment-1', status: 'PACKED' }],
      },
    },
  },
})

function reset() {
  state.orderStatus = 'PACKED'
  state.shipmentStatusOptions.length = 0
  state.activity.length = 0
  state.pushedStatuses.length = 0
}

async function loadModule() {
  return import('@/lib/fulfillment/external-fulfillment')
}

test('o3d-0i5y r2: a WMS dispatch declares EXTERNAL completion authority, so IMS does not re-derive completion', async () => {
  reset()
  const { applyExternalFulfillmentUpdate } = await loadModule()

  const result = await applyExternalFulfillmentUpdate({
    source: 'mintsoft',
    lookup: { orderId: 'order-1' },
    targetShipmentStatus: 'SHIPPED',
    tracking: [{ trackingNumber: 'TRACK-1', shippingService: 'DPD' }],
  })

  assert.equal(result.success, true)
  assert.equal(state.shipmentStatusOptions.length, 1)
  // The SPECIFIC declaration, not merely "some options were passed".
  assert.equal(state.shipmentStatusOptions[0]?.completionAuthority, 'EXTERNAL')
})

test('o3d-0i5y r2: the storefront completion path declares the same authority — one boundary, one owner', async () => {
  reset()
  const { applyExternalFulfillmentUpdate } = await loadModule()

  const result = await applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId: 'order-1' },
    targetShipmentStatus: 'SHIPPED',
    tracking: [{ trackingNumber: 'TRACK-1', shippingService: null }],
  })

  assert.equal(result.success, true)
  assert.equal(state.shipmentStatusOptions[0]?.completionAuthority, 'EXTERNAL')
})

test('o3d-0i5y r2: the storefront completion push survives — it is gated on the order reaching SHIPPED', async () => {
  // The visible customer-facing consequence of r1's regression: while the order was held out of
  // SHIPPED, shouldPushStorefrontCompletion returned false and the despatch email never fired.
  reset()
  const { applyExternalFulfillmentUpdate } = await loadModule()

  await applyExternalFulfillmentUpdate({
    source: 'mintsoft',
    lookup: { orderId: 'order-1' },
    targetShipmentStatus: 'SHIPPED',
    tracking: [{ trackingNumber: 'TRACK-1', shippingService: 'DPD' }],
  })

  assert.deepEqual(state.pushedStatuses, ['SHIPPED'])
})
