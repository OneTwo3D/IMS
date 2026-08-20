import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
// Captured BEFORE the mock below replaces the module, so the real leaf expansion still runs.
import { expandFulfillmentRequirementsDecimal as realExpandFulfillmentRequirementsDecimal } from '../lib/products/kit-fulfillment.ts'

/**
 * o3d-okbd: an external (3PL / storefront) fulfilment update must not mark an order shipped
 * when the IMS shipment lines under-cover what was ordered.
 *
 * `applyExternalFulfillmentUpdate` auto-allocates only when the order has NO allocations,
 * and refuses only the all-or-nothing case — so a PARTIAL auto-allocation passed, and an
 * order that already held partial allocations skipped the allocator, and the refusal,
 * entirely. The shipments it then drove to SHIPPED covered whatever happened to be
 * allocated, and the order was promoted as complete.
 *
 * Unlike the operator flow, there is no outstanding remainder here for a later shipment to
 * carry: the goods have already left the 3PL. Under-recording is permanent — less stock
 * movement, less COGS, stock that stays on hand in IMS forever.
 */

type Row = Record<string, unknown>

const state = {
  order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED', refundStatus: 'NONE' } as Row,
  orderLines: [] as Row[],
  shipmentLines: [] as Row[],
  refundLines: [] as Row[],
  shipments: [] as Row[],
  allocationCount: 1,
  /** ('shipmentId', 'targetStatus') for every transition actually attempted. */
  transitions: [] as Array<[string, string]>,
  activity: [] as Row[],
  /** productId -> component requirements, for the KIT case. */
  kits: new Map<string, Array<{ componentId: string; qty: number }>>(),
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async () => ({ ...state.order }),
        findFirst: async () => ({ ...state.order }),
      },
      salesOrderLine: { findMany: async () => state.orderLines.map((row) => ({ ...row })) },
      /**
       * Honours `where.shipment` and refuses a shape it does not model. Answering every
       * query with the whole table made the cumulative-coverage test vacuous: narrowing the
       * production query to non-SHIPPED rows changed nothing and the test still passed.
       */
      shipmentLine: {
        findMany: async ({ where }: { where?: Row } = {}) => {
          const shipment = (where?.shipment ?? {}) as Row
          const unmodelled = Object.keys(shipment).filter((k) => k !== 'orderId' && k !== 'status')
          if (unmodelled.length > 0) {
            throw new Error(`shipmentLine.findMany double got an unmodelled where: ${JSON.stringify(where)}`)
          }
          const statusFilter = shipment.status as { not?: string } | string | undefined
          return state.shipmentLines
            .filter((row) => {
              const parent = state.shipments.find((s) => s.id === row.shipmentId)
              if (!parent) throw new Error(`shipment line references unknown shipment ${String(row.shipmentId)}`)
              if (shipment.orderId !== undefined && shipment.orderId !== state.order.id) return false
              if (typeof statusFilter === 'string') return parent.status === statusFilter
              if (statusFilter?.not !== undefined) return parent.status !== statusFilter.not
              return true
            })
            .map((row) => ({ ...row }))
        },
      },
      salesOrderRefundLine: { findMany: async () => state.refundLines.map((row) => ({ ...row })) },
      orderAllocation: { count: async () => state.allocationCount },
      shipment: {
        count: async () => state.shipments.length,
        findMany: async () => state.shipments.map((row) => ({ ...row })),
      },
    },
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async () => ({ success: true, allocationCount: 1, unallocatedQty: 0 }),
    confirmAllocations: async () => ({ success: true }),
    updateShipmentStatus: async (shipmentId: string, target: string) => {
      state.transitions.push([shipmentId, target])
      return { success: true }
    },
  },
})

/**
 * Only the graph LOAD is doubled; the real `expandFulfillmentRequirementsDecimal` runs, so
 * the kit case exercises the actual leaf expansion rather than a re-implementation of it.
 */
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async (_client: unknown, productIds: string[]) => {
      const graph = new Map<string, unknown>()
      for (const productId of productIds) {
        const components = state.kits.get(productId)
        graph.set(productId, {
          id: productId,
          type: components ? 'KIT' : 'SIMPLE',
          productComponents: (components ?? []).map((component) => ({
            componentId: component.componentId,
            componentType: 'SIMPLE',
            qty: component.qty,
          })),
        })
        for (const component of components ?? []) {
          graph.set(component.componentId, { id: component.componentId, type: 'SIMPLE', productComponents: [] })
        }
      }
      return graph
    },
    expandFulfillmentRequirementsDecimal: realExpandFulfillmentRequirementsDecimal,
  },
})

function reset() {
  state.order = { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED', refundStatus: 'NONE' }
  state.orderLines = []
  state.shipmentLines = []
  state.refundLines = []
  state.shipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.allocationCount = 1
  state.transitions = []
  state.activity = []
  state.kits = new Map()
}

async function loadModule() {
  return import('@/lib/fulfillment/external-fulfillment')
}

function apply(targetShipmentStatus: 'PACKED' | 'SHIPPED' = 'SHIPPED') {
  return loadModule().then((module) =>
    module.applyExternalFulfillmentUpdate({
      source: 'woocommerce',
      lookup: { orderId: 'so-1' },
      targetShipmentStatus,
    }),
  )
}

test('a 3PL dispatch covering 4 of 10 ordered units is refused, naming the uncovered quantity', async () => {
  reset()
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 4 }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /WIDGET \(6 of 10 uncovered\)/)
  assert.equal(state.transitions.length, 0, 'no shipment may be dispatched on a short external update')

  const refusal = state.activity.find((entry) => entry.action === 'external_fulfillment_short')
  assert.ok(refusal, 'the refusal must be visible in the activity log')
  assert.equal(refusal.level, 'WARNING')
  assert.deepEqual(refusal.metadata, {
    source: 'woocommerce',
    shortfalls: [{
      lineId: 'line-1',
      productId: 'p-1',
      label: 'WIDGET',
      demandQty: '10',
      shipmentQty: '4',
      outstandingQty: '6',
    }],
  })
})

test('a dispatch that covers every ordered unit proceeds to SHIPPED', async () => {
  reset()
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 10 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions, [['shp-1', 'SHIPPED']])
})

test('coverage is cumulative across shipments, so a second dispatch is not re-judged on the first', async () => {
  reset()
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }, { id: 'shp-2', status: 'PACKED' }]
  state.shipmentLines = [
    { shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 },
    { shipmentId: 'shp-2', lineId: 'line-1', productId: 'p-1', qty: 4 },
  ]

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('refunded units are netted out of demand, so a part-refunded order is not permanently short', async () => {
  reset()
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.refundLines = [{ salesOrderLineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 4 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('a MONETARY-only FULL refund does not exempt an uncovered dispatch', async () => {
  reset()
  // `refundStatus` reaches FULL on a refund that returned no goods at all — store credit, a
  // shipping-only refund, an unlinked external refund. Treating FULL as blanket zero demand
  // skipped the coverage check on exactly the orders that DID dispatch: a monetary refund
  // cannot un-ship what the 3PL already sent.
  state.order.refundStatus = 'FULL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  // No refund LINES at all, so per-line netting yields nothing and demand stands at 10.
  state.shipmentLines = []

  const result = await apply()

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /WIDGET \(10 of 10 uncovered\)/)
  assert.equal(state.transitions.length, 0)
})

test('a FULL refund that really returned the goods nets to zero and proceeds', async () => {
  reset()
  state.order.refundStatus = 'FULL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  // Quantity-bearing refund lines are what actually cancel goods, and the per-leaf
  // subtraction already handles them. No short-circuit is needed to reach zero demand.
  state.refundLines = [{ salesOrderLineId: 'line-1', productId: 'p-1', qty: 10 }]
  state.shipmentLines = []

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('a fully refunded order that DID ship in full is still dispatchable', async () => {
  reset()
  state.order.refundStatus = 'FULL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 10 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions, [['shp-1', 'SHIPPED']])
})

test('lines that can never receive shipment coverage do not refuse the dispatch', async () => {
  reset()
  state.orderLines = [
    { id: 'line-1', productId: 'p-1', qty: 2, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } },
    // A service/fee line: non-stock-tracked, never shipped.
    { id: 'line-2', productId: 'p-2', qty: 1, sku: 'DELIVERY', description: 'Delivery', product: { type: 'NON_INVENTORY' } },
    // A description-only line: no product to ship.
    { id: 'line-3', productId: null, qty: 5, sku: null, description: 'Gift message', product: null },
  ]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 2 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('a KIT line is compared in leaf units, so a missing component is caught', async () => {
  reset()
  state.kits.set('kit-1', [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 1 }])
  state.orderLines = [{ id: 'line-1', productId: 'kit-1', qty: 2, sku: 'KIT-1', description: 'Kit', product: { type: 'KIT' } }]
  // 2 kits require 4 x comp-a and 2 x comp-b. Only one comp-b was shipped.
  state.shipmentLines = [
    { shipmentId: 'shp-1', lineId: 'line-1', productId: 'comp-a', qty: 4 },
    { shipmentId: 'shp-1', lineId: 'line-1', productId: 'comp-b', qty: 1 },
  ]

  const result = await apply()

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /KIT-1 \(1 of 2 uncovered\)/)
  assert.doesNotMatch(result.error ?? '', /comp-a/)
})

test('a PACKED progress report is not judged on full coverage — only the SHIPPED step is', async () => {
  reset()
  state.shipments = [{ id: 'shp-1', status: 'PICKING' }]
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 4 }]

  const result = await apply('PACKED')

  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions, [['shp-1', 'PACKED']])
})
