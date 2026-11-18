import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Owner ruling 2026-11-18: a WMS despatch is evidence about the WMS warehouse only. It ships that warehouse's own shipments and leaves a shipment IMS
 * holds in another warehouse open (driving it would take stock out of a warehouse the goods never left). The despatch is a success, not a refusal.
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
  lines: [] as Row[],
  refused: [] as Row[],
  optionsSeen: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: { findUnique: async () => (state.link ? { ...state.link } : null) },
      salesOrder: { findUnique: async () => ({ ...state.order }), findFirst: async () => ({ ...state.order }) },
      salesOrderLine: { findMany: async () => [] },
      shipmentLine: { findMany: async (args?: { where?: { shipment?: unknown } }) => (args?.where?.shipment ? state.lines : []) },
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
    updateShipmentStatus: async (shipmentId: string, target: string, _extra?: unknown, options?: Record<string, unknown>) => { state.transitions.push([shipmentId, target]); if (options) state.optionsSeen.push(options); return { success: true } },
  },
})
mock.module('@/lib/domain/refused-actions', {
  namedExports: {
    REFUSED_ACTION_ENTITY_SALES_ORDER: 'SALES_ORDER',
    recordRefusedAction: async (_db: unknown, input: Row) => { state.refused.push(input); return { id: 'r1', episodeStarted: true, attempts: 1 } },
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
  state.lines = []
  state.refused = []
  state.optionsSeen = []
  state.allocationCount = 1
  state.order.shipFromWarehouseId = 'wh-wms'
}

async function apply(source: 'mintsoft' | 'woocommerce') {
  const { applyExternalFulfillmentUpdate } = await import('@/lib/fulfillment/external-fulfillment')
  return applyExternalFulfillmentUpdate({ source, lookup: { orderId: 'so-1' }, targetShipmentStatus: 'SHIPPED' })
}

test('a Mintsoft despatch on a mixed-warehouse order ships ONLY the WMS warehouse shipment and leaves the other open', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.lines = [{ lineId: 'l1', qty: 1, shipment: { warehouseId: 'wh-wms' } }, { lineId: 'l1', qty: 1, shipment: { warehouseId: 'wh-home' } }]
  const result = await apply('mintsoft')
  assert.equal(result.success, true, 'a success, not a refusal: the dispatch breaker never sees a failure')
  assert.deepEqual((result as { partialWarehouse?: unknown }).partialWarehouse, { shippedShipmentCount: 1, openShipmentIds: ['shp-home'], openWarehouseIds: ['wh-home'] })
  assert.deepEqual(state.transitions, [['shp-wms', 'SHIPPED']], 'the other warehouse shipment was never driven')
  const note = state.activity.find((entry) => entry.action === 'external_fulfillment_other_warehouse_open')
  assert.ok(note, 'the open shipment is visible')
  assert.deepEqual((note.metadata as { shipmentIds: string[] }).shipmentIds, ['shp-home'])
  assert.deepEqual(state.refused.map((row) => row.action), ['WMS_OTHER_WAREHOUSE_PART_OPEN'], 'a DURABLE row says the other warehouse part is still to ship; the line is covered in the WMS warehouse so no lines row')
  assert.ok(!state.activity.some((entry) => entry.action === 'external_fulfillment_failed'))
})

test('a mixed-warehouse despatch that covers a line held ONLY in the other warehouse ships nothing of it and raises a refused-action row', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.lines = [{ lineId: 'l1', qty: 1, shipment: { warehouseId: 'wh-wms' } }, { lineId: 'l2', qty: 1, shipment: { warehouseId: 'wh-home' } }]
  const result = await apply('mintsoft')
  assert.equal(result.success, true)
  assert.deepEqual(state.transitions, [['shp-wms', 'SHIPPED']])
  const linesRow = state.refused.find((row) => row.action === 'WMS_DESPATCH_OTHER_WAREHOUSE_LINES')
  assert.ok(linesRow && state.refused.some((row) => row.action === 'WMS_OTHER_WAREHOUSE_PART_OPEN'))
  assert.deepEqual((linesRow.intent as { lineIds: string[] }).lineIds, ['l2'])
  assert.match(String(linesRow.detail), /NOT shipped/)
  assert.doesNotMatch(String(linesRow.detail), /by hand/)
})

test('a despatch with nothing in the WMS warehouse ships nothing, is a success, and does not try the unflipped-order retry', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.lines = [{ lineId: 'l1', qty: 1, shipment: { warehouseId: 'wh-home' } }]
  const result = await apply('mintsoft')
  assert.equal(result.success, true)
  assert.deepEqual(state.transitions, [])
  assert.ok(state.refused.length >= 1)
  assert.ok(!state.activity.some((entry) => entry.action === 'external_fulfillment_applied'), 'no "applied" entry for a tick that applied nothing')
  assert.ok(!state.activity.some((entry) => entry.action === 'external_fulfillment_other_warehouse_open'), 'and no repeat entry on a re-apply that shipped nothing new')
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

test('a shipment outside the PUSHED warehouse is left open even when ship-from now points at it', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }, { id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }])
  state.link = { pushWarehouseId: 'wh-wms' }
  state.order.shipFromWarehouseId = 'wh-home'
  const result = await apply('mintsoft')
  assert.equal(result.success, true)
  assert.deepEqual(state.transitions, [['shp-wms', 'SHIPPED']])
})

test('a link without a pushed warehouse falls back to the order ship-from warehouse', async () => {
  reset([{ id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }, { id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }])
  state.link = { pushWarehouseId: null }
  const result = await apply('mintsoft')
  assert.equal(result.success, true)
  assert.deepEqual(state.transitions, [['shp-wms', 'SHIPPED']])
})

test('a storefront-sourced completion still ships every shipment (the storefront owns completion)', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  const result = await apply('woocommerce')
  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions.map(([id]) => id), ['shp-wms', 'shp-home'])
})

test('a mixed-warehouse WMS despatch asks for the storefront completion only through the shipment transition (which holds it until every shipment shipped)', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  await apply('mintsoft')
  assert.deepEqual(state.optionsSeen.map((o) => o.completionAuthority), ['EXTERNAL'])
})


test('coverage is per QUANTITY: a line split across warehouses raises the still-to-ship row even though the WMS warehouse holds part of it', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.lines = [{ lineId: 'l1', qty: 3, shipment: { warehouseId: 'wh-wms' } }, { lineId: 'l1', qty: 2, shipment: { warehouseId: 'wh-home' } }]
  await apply('mintsoft')
  assert.deepEqual(state.refused.map((row) => row.action), ['WMS_OTHER_WAREHOUSE_PART_OPEN'])
})

test('an order allocated by THIS despatch (pushed before it was allocated, so the WMS was sent every line) raises the lines row for the foreign lines', async () => {
  reset([{ id: 'shp-wms', status: 'PACKED', warehouseId: 'wh-wms' }, { id: 'shp-home', status: 'PACKED', warehouseId: 'wh-home' }])
  state.allocationCount = 0
  state.lines = [{ lineId: 'l1', qty: 3, shipment: { warehouseId: 'wh-wms' } }, { lineId: 'l1', qty: 2, shipment: { warehouseId: 'wh-home' } }]
  await apply('mintsoft')
  assert.ok(state.refused.some((row) => row.action === 'WMS_DESPATCH_OTHER_WAREHOUSE_LINES'))
})
