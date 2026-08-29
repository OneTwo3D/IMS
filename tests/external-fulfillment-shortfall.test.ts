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
  /** RETURN_INBOUND movements: WHICH goods a restocking refund actually received back. */
  returnMovements: [] as Row[],
  allocationCount: 1,
  /** What the allocator answers. Stateful so the BACKORDER refusal can be reached (o3d-xnwu). */
  autoAllocate: { success: true, allocationCount: 1, unallocatedQty: 0 } as Row,
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
      /**
       * Refuses a fixture that does not state what its refund says about the goods. A row
       * missing `refund` would silently read as "no evidence the goods left" and make the
       * restock/chargeback tests below vacuous — the double must not answer a question the
       * fixture never posed.
       */
      salesOrderRefundLine: {
        findMany: async ({ select }: { select?: Row } = {}) => {
          if (!select?.refund) {
            throw new Error('salesOrderRefundLine.findMany double: production stopped selecting `refund`')
          }
          if (!select?.refundId) {
            throw new Error('salesOrderRefundLine.findMany double: production stopped selecting `refundId`')
          }
          return state.refundLines.map((row) => {
            if (!row.refund) {
              throw new Error(`refund line fixture must state its refund: ${JSON.stringify(row)}`)
            }
            if (!row.refundId) {
              throw new Error(`refund line fixture must state which refund it belongs to: ${JSON.stringify(row)}`)
            }
            return { ...row }
          })
        },
      },
      /**
       * The per-product record of what actually came back (round 5). Refuses any query shape it
       * does not model, so a production read that dropped the RETURN_INBOUND filter — and so
       * counted a sale dispatch or a Mintsoft return as refund evidence — fails here rather than
       * quietly answering with the whole table.
       */
      stockMovement: {
        findMany: async ({ where }: { where?: Row } = {}) => {
          const clause = (where ?? {}) as Row
          const unmodelled = Object.keys(clause).filter(
            (k) => k !== 'type' && k !== 'referenceType' && k !== 'referenceId',
          )
          if (unmodelled.length > 0) {
            throw new Error(`stockMovement.findMany double got an unmodelled where: ${JSON.stringify(where)}`)
          }
          if (clause.type !== 'RETURN_INBOUND' || clause.referenceType !== 'SalesOrderRefund') {
            throw new Error(`stockMovement.findMany double: unexpected filter ${JSON.stringify(where)}`)
          }
          const ids = ((clause.referenceId as { in?: string[] } | undefined)?.in ?? []) as string[]
          return state.returnMovements
            .filter((row) => ids.includes(String(row.referenceId)))
            .map((row) => ({ ...row }))
        },
      },
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
    autoAllocateOrder: async () => ({ ...state.autoAllocate }),
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

/** A refund that cancelled goods which never moved: nothing to receive back, no chargeback. */
const CANCELLED_BEFORE_DISPATCH = { returnWarehouseId: null, chargeback: false, accountingRetryRequired: false }
/**
 * A refund that RESTOCKED goods — they can only come back if they went out. Round 5: the COLUMN
 * only says a restock was attempted; `state.returnMovements` says which units actually arrived, and
 * that is what the refund is measured by.
 */
const RETURNED_TO_STOCK = { returnWarehouseId: 'wh-returns', chargeback: false, accountingRetryRequired: false }
/** A chargeback: scjz.70 suppresses restock precisely because the customer KEEPS the goods. */
const KEPT_BY_CUSTOMER = { returnWarehouseId: null, chargeback: true, accountingRetryRequired: false }
/** A restock whose return movements are still owed to the accounting-retry transaction. */
const RETURN_STILL_OWED = { returnWarehouseId: 'wh-returns', chargeback: false, accountingRetryRequired: true }

function reset() {
  state.order = { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1', status: 'ALLOCATED', refundStatus: 'NONE' }
  state.orderLines = []
  state.shipmentLines = []
  state.refundLines = []
  state.returnMovements = []
  state.shipments = [{ id: 'shp-1', status: 'PACKED' }]
  state.allocationCount = 1
  state.autoAllocate = { success: true, allocationCount: 1, unallocatedQty: 0 }
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
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: CANCELLED_BEFORE_DISPATCH }]
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
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 10, refund: CANCELLED_BEFORE_DISPATCH }]
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


test('a RESTOCKING partial refund does not excuse an uncovered dispatch', async () => {
  reset()
  // Order 10; IMS only ever allocated 6, so shipment A covers 6 and dispatched. The customer
  // returned those 6 and the refund restocked them — an INBOUND movement for units that only
  // exist because they went out. The 3PL now reports the remaining 4 dispatched with nothing
  // allocated to put on shipment B.
  //
  // Netting the restocked 6 out of demand gives 4 against coverage 6 and waves this through,
  // booking four units of movement for a dispatch of ten while the return has already added
  // six back. A restock is evidence the goods LEFT, not evidence they were never wanted.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }, { id: 'shp-2', status: 'PACKED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: RETURNED_TO_STOCK }]
  // All six came back, so all six are goods that left: the restock is fully measured.
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'p-1', qty: 6 }]

  const result = await apply()

  // The specific reason, not a bare failure: the restocked/kept units must still show as
  // uncovered demand, in the quantity the shipment lines fall short by.
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /WIDGET \(4 of 10 uncovered\)/)
  assert.equal(state.transitions.length, 0)
})

test('a CHARGEBACK refund does not excuse an uncovered dispatch either', async () => {
  reset()
  // A chargeback states the same fact the other way round: no restock and no COGS reversal
  // because the customer keeps the goods. They left the warehouse, so they still have to be
  // covered by shipment lines.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 3 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 7, refund: KEPT_BY_CUSTOMER }]

  const result = await apply()

  // The specific reason, not a bare failure: the restocked/kept units must still show as
  // uncovered demand, in the quantity the shipment lines fall short by.
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /WIDGET \(7 of 10 uncovered\)/)
  assert.equal(state.transitions.length, 0)
})

test('a restocking refund on a FULLY covered dispatch still proceeds', async () => {
  reset()
  // The complement, and the reason this is a netting rule rather than a blanket refusal: the
  // shipment lines cover all ten, the return is accounted for separately, and refusing here
  // would strand a perfectly ordinary return.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 10 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: RETURNED_TO_STOCK }]
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'p-1', qty: 6 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
  assert.deepEqual(state.transitions, [['shp-1', 'SHIPPED']])
})

/**
 * ROUND 5: a refund-level mark cannot answer a line-level question.
 *
 * `returnWarehouseId` is a column on the REFUND. One WooCommerce "Refund" press routinely mixes
 * goods that went out with goods that never did — the customer returns what arrived and cancels
 * what was still on back-order — and reading the mark per refund classified all of it as goods that
 * left. In this direction the error is not a missed under-booking but a PERMANENT REFUSAL: units
 * nobody ever shipped stay in demand, no shipment line can ever cover them, and every redelivery of
 * the 3PL dispatch is refused for them.
 *
 * The RETURN_INBOUND movements are the record of which goods actually came back, at the granularity
 * the question is asked. `buildRefundFallbackReturnRows` already refuses to restock a line with no
 * SHIPPED shipment behind it, so the movements are exactly the units that could have come back.
 */

test('a restocking refund that MIXES returned and cancelled units nets only the cancelled ones', async () => {
  reset()
  // Order 10. Six shipped and dispatched; the customer returned those six AND cancelled the four
  // that never made it onto a shipment, on one refund. Only the six have a return movement.
  //
  // Read per refund, all ten are "goods that left": demand stays 10 against coverage 6 and the
  // dispatch is refused for four units that were never shipped and never will be. Read per product,
  // six are goods that left and four are an ordinary cancellation that nets — demand 6, coverage 6.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 10, refund: RETURNED_TO_STOCK }]
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'p-1', qty: 6 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('a cancelled LINE of a restocking refund nets even when another line of it came back', async () => {
  reset()
  // The same mixing across PRODUCTS: p-1 shipped and was returned, p-2 never shipped at all and was
  // cancelled on the same refund. p-2 has no return movement, so nothing was received back for it.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [
    { id: 'line-1', productId: 'p-1', qty: 6, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } },
    { id: 'line-2', productId: 'p-2', qty: 4, sku: 'GADGET', description: 'Gadget', product: { type: 'SIMPLE' } },
  ]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.refundLines = [
    { refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: RETURNED_TO_STOCK },
    { refundId: 'ref-1', salesOrderLineId: 'line-2', productId: 'p-2', qty: 4, refund: RETURNED_TO_STOCK },
  ]
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'p-1', qty: 6 }]

  const result = await apply()

  // Line 1 still holds its six against six of coverage; line 2's four net away entirely.
  assert.deepEqual(result, { success: true })
})

test('a restock that received NOTHING back nets like the cancellation it is', async () => {
  reset()
  // A refund routed to a returns warehouse whose lines had no SHIPPED shipment behind them:
  // `buildRefundFallbackReturnRows` refuses to restock those, so no movement is written and no
  // goods came back. The column alone would hold all ten units of demand up against a dispatch
  // that has nothing to cover them with, forever.
  state.order.refundStatus = 'FULL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = []
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 10, refund: RETURNED_TO_STOCK }]
  state.returnMovements = []

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

test('a restock whose return is still OWED holds demand up, because nothing has been measured yet', async () => {
  reset()
  // `accountingRetryRequired` means the RETURN_INBOUND movements are written by a LATER transaction
  // (refund-service.ts defers them when accounting staging failed). An empty measurement there means
  // "not yet", not "nothing came back", so the mark stands for the whole refund — the recoverable
  // direction, which clears itself when the retry writes the movements.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: RETURN_STILL_OWED }]
  state.returnMovements = []

  const result = await apply()

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /WIDGET \(4 of 10 uncovered\)/)
  assert.equal(state.transitions.length, 0)
})

test('another refund\'s return movements are never borrowed as this one\'s evidence', async () => {
  reset()
  // Two restocking refunds on the order; only the FIRST actually received goods back. Keying the
  // measurement by refund is what stops the second one inheriting the first one's evidence and
  // holding four units of demand up against a dispatch that already covers them.
  state.order.refundStatus = 'PARTIAL'
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 6 }]
  state.refundLines = [
    { refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'p-1', qty: 6, refund: RETURNED_TO_STOCK },
    { refundId: 'ref-2', salesOrderLineId: 'line-1', productId: 'p-1', qty: 4, refund: RETURNED_TO_STOCK },
  ]
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'p-1', qty: 6 }]

  const result = await apply()

  // ref-1's six are goods that left and stay in demand; ref-2's four never came back and net away.
  assert.deepEqual(result, { success: true })
})

test('a KIT restock is measured in LEAF units, per component', async () => {
  reset()
  // Two kits refunded with a restock, but only the comp-a units were received back. comp-b's two
  // units never came back, so they are a cancellation and net — while comp-a's four hold their
  // demand up against the four that shipped.
  state.order.refundStatus = 'PARTIAL'
  state.kits.set('kit-1', [{ componentId: 'comp-a', qty: 2 }, { componentId: 'comp-b', qty: 1 }])
  state.orderLines = [{ id: 'line-1', productId: 'kit-1', qty: 2, sku: 'KIT-1', description: 'Kit', product: { type: 'KIT' } }]
  state.shipments = [{ id: 'shp-1', status: 'SHIPPED' }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'comp-a', qty: 4 }]
  state.refundLines = [{ refundId: 'ref-1', salesOrderLineId: 'line-1', productId: 'kit-1', qty: 2, refund: RETURNED_TO_STOCK }]
  state.returnMovements = [{ referenceId: 'ref-1', productId: 'comp-a', qty: 4 }]

  const result = await apply()

  assert.deepEqual(result, { success: true })
})

// ---------------------------------------------------------------------------
// o3d-xnwu — the refusals have a SHAPE, so a caller can tell "no" from "it broke".
// ---------------------------------------------------------------------------

test('o3d-xnwu: the physical-stock refusal is classified, RETRYABLE, and leaves a record', async () => {
  reset()
  // This refusal has existed since long before o3d-okbd and produced NOTHING: the WooCommerce
  // caller discarded the result and nothing was logged here either, so an order the store had
  // marked completed simply never became an IMS shipment and no surface said so.
  state.allocationCount = 0
  state.autoAllocate = { success: true, allocationCount: 0, unallocatedQty: 3 }
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 3, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.refusal, 'insufficient_physical_stock')
  // NOT permanent: it is a statement about IMS stock at this instant, not about the request, and it
  // clears the moment a receipt lands — the same reasoning that keeps a P2002 on `sku` transient.
  assert.equal(result.success === false && result.permanent, false)
  assert.equal(state.transitions.length, 0, 'nothing may be driven to SHIPPED')
  const logged = state.activity.filter((entry) => entry.action === 'external_fulfillment_backordered')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].level, 'WARNING')
  assert.match(String(logged[0].description), /3 unit\(s\)/)
})

test('o3d-xnwu: the coverage shortfall is classified PERMANENT — a redelivery reaches the same answer', async () => {
  reset()
  // The complement of the test above, and the reason the two must not share a classification: this
  // one is computed entirely from committed IMS state, so retrying it 24 times into the dead-letter
  // queue tells an operator nothing the first attempt did not.
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 10, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]
  state.shipmentLines = [{ shipmentId: 'shp-1', lineId: 'line-1', productId: 'p-1', qty: 4 }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.refusal, 'coverage_shortfall')
  assert.equal(result.success === false && result.permanent, true)
})

test('o3d-xnwu: a failure that is not a business refusal stays retryable', async () => {
  reset()
  // The safe direction, and the reason `permanent` is an allow-list rather than "everything that
  // is not a success": an allocator that errored may work on the next attempt, and acknowledging
  // it would discard a fulfilment that was always going to land.
  state.allocationCount = 0
  state.autoAllocate = { success: false, error: 'deadlock detected' }
  state.orderLines = [{ id: 'line-1', productId: 'p-1', qty: 3, sku: 'WIDGET', description: 'Widget', product: { type: 'SIMPLE' } }]

  const result = await apply()

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.refusal, 'auto_allocation_failed')
  assert.equal(result.success === false && result.permanent, false)
})
