import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.78: a WMS despatch is evidence about the WMS warehouse only. A shipment IMS holds in another warehouse is never driven to
 * SHIPPED by it (that would take stock out of a warehouse the goods never left). The despatch is refused and surfaced instead.
 * Mocked: no database, no network.
 */
type Row = Record<string, unknown>
const state = {
  order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED', refundStatus: 'NONE', shipFromWarehouseId: 'wh-wms' } as Row,
  shipments: [] as Row[],
  transitions: [] as Array<[string, string]>,
  activity: [] as Row[],
  link: null as Row | null,
  allocationCount: 1,
  allocated: [] as string[],
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: { findUnique: async () => (state.link ? { ...state.link } : null) },
      salesOrder: { findUnique: async () => ({ ...state.order }), findFirst: async () => ({ ...state.order }) },
      salesOrderLine: { findMany: async () => [] },
      shipmentLine: { findMany: async () => [] },
      salesOrderRefundLine: { findMany: async () => [] },
      stockMovement: { findMany: async () => [] },
      orderAllocation: { count: async () => (state.allocationCount) },
      shipment: { count: async () => state.shipments.length, findMany: async () => state.shipments.map((row) => ({ ...row })) },
    },
  },
})
mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => { state.allocated.push('auto'); return { success: true, allocationCount: 1, unallocatedQty: 0 } },
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (shipmentId: string, target: string) => { state.transitions.push([shipmentId, target]); return { success: true } },
  },
})
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: { loadFulfillmentProductGraph: async () => new Map(), expandFulfillmentRequirementsDecimal: () => [] },
})

function reset(shipments: Row[]) {
  state.shipments = shipments
  state.transitions = []
  state.activity = []
  state.link = null
  state.allocated = []
  state.allocationCount = 1
  state.order.shipFromWarehouseId = 'wh-wms'
}

async function apply(source: 'mintsoft' | 'woocommerce') {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({ source, lookup: { orderId: 'so-1' }, targetShipmentStatus: 'SHIPPED' })
}

test('a Mintsoft despatch refuses when IMS also holds an unshipped shipment in ANOTHER warehouse, and ships nothing', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  const result = await apply('mintsoft')
  assert.equal(result.success, false)
  assert.equal((result as { refusal?: string }).refusal, 'wms_other_warehouse_shipments')
  assert.equal((result as { permanent?: boolean }).permanent, false, 'retryable once an operator reallocates')
  assert.deepEqual(state.transitions, [], 'neither shipment was driven to SHIPPED')
  const note = state.activity.find((entry) => entry.action === 'external_fulfillment_other_warehouse_shipments')
  assert.ok(note, 'the refusal is visible')
  assert.deepEqual((note.metadata as { shipmentIds: string[] }).shipmentIds, ['shp-home'])
})

test('a Mintsoft despatch whose shipments are all in the WMS warehouse ships them (control)', async () => {
  reset([{ id: 'shp-a', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-b', status: 'PICKING', warehouseId: 'wh-wms' }])
  const result = await apply('mintsoft')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions.filter(([, target]) => target === 'SHIPPED').map(([id]) => id), ['shp-a', 'shp-b'])
})

test('a storefront-sourced completion is not scoped by the WMS warehouse (control)', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  const result = await apply('woocommerce')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions, [['shp-home', 'SHIPPED']])
})

test('the WMS warehouse is the one the order was PUSHED for, not the current ship-from (ship-from changed after the push)', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }])
  state.link = { pushWarehouseId: 'wh-wms' }
  state.order.shipFromWarehouseId = 'wh-home' // an operator changed it after the push
  const result = await apply('mintsoft')
  assert.deepEqual(result, { success: true }, 'the genuine WMS shipment is not read as foreign')
  assert.deepEqual(state.transitions, [['shp-wms', 'SHIPPED']])
})

test('a shipment outside the PUSHED warehouse is refused even when ship-from now points at it', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.link = { pushWarehouseId: 'wh-wms' }
  state.order.shipFromWarehouseId = 'wh-home'
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_other_warehouse_shipments')
  assert.deepEqual(state.transitions, [])
})

test('a link without a pushed warehouse falls back to the order ship-from warehouse', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.link = { pushWarehouseId: null }
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_other_warehouse_shipments')
})

test('the refusal happens BEFORE any allocation side effect when the foreign shipment already exists', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.allocationCount = 0 // allocation would normally run
  const result = await apply('mintsoft')
  assert.equal((result as { refusal?: string }).refusal, 'wms_other_warehouse_shipments')
  assert.deepEqual(state.allocated, [], 'autoAllocateOrder never ran')
})
