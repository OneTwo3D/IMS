import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A WMS DISPATCH THE STOREFRONT ALREADY HOLDS (verified pre-cutover record) COMPLETES IMS ONLY.
 *
 * `applyExternalFulfillmentUpdate` asks for the durable `woocommerce/order.complete` job for every WMS dispatch. When the
 * dispatch sweep verified that the earlier writer already completed the storefront order, the job and the post-commit
 * storefront tracking/status push would be writes to a storefront that is already complete, so neither may be requested.
 * The ordinary dispatch still asks for both. (Rows actually written are counted in
 * tests/fulfillment-pre-cutover-no-storefront-jobs.test.ts.)
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
      // o3d-okbd (merged after this test was written): before driving the shipments to SHIPPED the
      // boundary checks that the IMS shipment lines COVER what was ordered, and refuses the update
      // outright when they do not. That check is not what these tests are about, so the fixture is
      // FULLY COVERED — one ordered unit, one shipped unit — rather than stubbed to "no shortfall":
      // a stub would also hide a real regression in the check, and an under-covered fixture would
      // make every completion-authority assertion below unreachable behind the refusal.
      salesOrderLine: {
        findMany: async () => [{
          id: 'line-1',
          productId: 'prod-1',
          qty: 1,
          sku: 'SKU-1',
          description: 'Product 1',
          product: { type: 'SIMPLE' },
        }],
      },
      shipmentLine: {
        findMany: async () => [{ lineId: 'line-1', productId: 'prod-1', qty: 1 }],
      },
      salesOrderRefundLine: { findMany: async () => [] },
      // The coverage check expands the ordered products through the fulfilment graph. A SIMPLE
      // product with no components expands to itself, which is what makes the one ordered unit and
      // the one shipped unit compare directly.
      product: {
        findMany: async () => [{
          id: 'prod-1',
          type: 'SIMPLE',
          fulfillmentGraphVersion: 0,
          productComponents: [],
        }],
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


test('an ordinary WMS dispatch still asks for the storefront completion job and the post-commit push', async () => {
  reset()
  const { applyExternalFulfillmentUpdate } = await loadModule()
  const result = await applyExternalFulfillmentUpdate({ source: 'mintsoft', lookup: { orderId: 'order-1' }, targetShipmentStatus: 'SHIPPED', tracking: [{ trackingNumber: 'T1' }] })
  assert.equal(result.success, true)
  assert.equal(state.shipmentStatusOptions.length, 1, 'PRECONDITION: the status walk was reached')
  assert.equal(state.shipmentStatusOptions[0]?.storefrontCompletion, true)
  assert.notEqual(state.shipmentStatusOptions[0]?.skipStorefrontPush, true)
})

test('a dispatch whose storefront record is already complete asks for NEITHER the completion job NOR the storefront push, and still completes IMS', async () => {
  reset()
  const { applyExternalFulfillmentUpdate } = await loadModule()
  const result = await applyExternalFulfillmentUpdate({ source: 'mintsoft', lookup: { orderId: 'order-1' }, targetShipmentStatus: 'SHIPPED', tracking: [{ trackingNumber: 'T1' }], storefrontAlreadyCompleted: true })
  assert.equal(result.success, true)
  assert.equal(state.shipmentStatusOptions.length, 1, 'PRECONDITION: the status walk was reached')
  assert.equal(state.shipmentStatusOptions[0]?.storefrontCompletion, false)
  assert.equal(state.shipmentStatusOptions[0]?.skipStorefrontPush, true)
  assert.equal(state.shipmentStatusOptions[0]?.completionAuthority, 'EXTERNAL')
  assert.equal(state.orderStatus, 'SHIPPED', 'IMS side completed')
})
