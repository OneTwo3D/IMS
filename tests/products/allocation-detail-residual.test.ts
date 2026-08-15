import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-4kfh — `getAllocationDetails` is the product page's "what is holding this reserved stock?"
 * popup. It answers with `OrderAllocation` rows, and it used to report their RAW `qty`.
 *
 * That is the whole-claim reading, not the live-reservation one: the row is retained through
 * dispatch, and only `qty − SHIPPED` still contributes to `StockLevel.reservedQty`. Its only guard
 * was an order-status filter, and a partially shipped order does NOT leave that filter —
 * `reconcileOrderAfterShipment` promotes an order to SHIPPED only when EVERY shipment has shipped,
 * so a multi-warehouse order with one dispatched and one packed shipment sits in ALLOCATED. The
 * popup therefore claimed 10 reserved units where 5 had already left, and its rows summed above the
 * reservedQty they exist to explain.
 */

type AllocationRow = { lineId: string; qty: number; orderId: string; status: string }
type ShipmentLineRow = { lineId: string; productId: string; warehouseId: string; status: string; qty: number }

const state = {
  allocations: [] as AllocationRow[],
  shipmentLines: [] as ShipmentLineRow[],
  /** Every `where` the shipment-line query was given, so the double cannot be over-permissive. */
  shipmentLineWheres: [] as Array<Record<string, unknown>>,
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('next/navigation', { namedExports: { redirect: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: { requireAuth: async () => ({}), requirePermission: async () => {} },
})
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushProductMetadata: async () => {},
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        findMany: async ({ where }: { where: { productId: string; warehouseId: string } }) => state
          .allocations
          .map((row) => ({
            lineId: row.lineId,
            qty: row.qty,
            order: { id: row.orderId, externalOrderNumber: `WC-${row.orderId}`, status: row.status },
            productId: where.productId,
            warehouseId: where.warehouseId,
          })),
      },
      shipmentLine: {
        // Honours the SHIPPED-only predicate: a PICKING/PACKED line has released no reservation, so
        // netting it here would UNDER-report the live reservation just as badly as the raw row
        // over-reported it. A double that ignored the status would make that untestable.
        findMany: async ({ where }: {
          where: {
            productId: string
            lineId: { in: string[] }
            shipment: { warehouseId: string; status: string }
          }
        }) => {
          state.shipmentLineWheres.push(where as unknown as Record<string, unknown>)
          return state.shipmentLines
            .filter((line) => line.productId === where.productId)
            .filter((line) => where.lineId.in.includes(line.lineId))
            .filter((line) => line.warehouseId === where.shipment.warehouseId)
            .filter((line) => line.status === where.shipment.status)
            .map((line) => ({
              lineId: line.lineId,
              productId: line.productId,
              qty: line.qty,
              shipment: { warehouseId: line.warehouseId },
            }))
        },
      },
      productionOrder: { findMany: async () => [] },
    },
  },
})

async function loadAction() {
  return (await import('@/app/actions/products')).getAllocationDetails
}

function reset() {
  state.allocations = []
  state.shipmentLines = []
  state.shipmentLineWheres = []
}

test('o3d-4kfh: a partially shipped order reports its LIVE reservation, not its whole claim', async () => {
  reset()
  state.allocations = [{ lineId: 'line-1', qty: 10, orderId: 'order-1', status: 'ALLOCATED' }]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const getAllocationDetails = await loadAction()

  const rows = await getAllocationDetails('product-1', 'warehouse-1')

  assert.deepEqual(
    rows.map((row) => [row.type, row.id, row.qty]),
    [['sales_order', 'order-1', 5]],
    'the 5 dispatched units no longer contribute to reservedQty and must not be reported as reserved',
  )
  assert.equal(
    state.shipmentLineWheres.length,
    1,
    'the dispatch is actually looked up rather than assumed absent',
  )
})

test('o3d-4kfh: a FULLY dispatched allocation is not listed at all', async () => {
  // Dispatch already gave the whole reservation back. Reporting a 0 would imply the reserved
  // balance has a source it does not have.
  reset()
  state.allocations = [{ lineId: 'line-1', qty: 4, orderId: 'order-1', status: 'ALLOCATED' }]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 4 },
  ]
  const getAllocationDetails = await loadAction()

  assert.deepEqual(await getAllocationDetails('product-1', 'warehouse-1'), [])
})

test('o3d-4kfh: a PICKED shipment nets NOTHING — those units are still reserved', async () => {
  // The complement, and the mistake in the opposite direction. reservedQty is decremented on the
  // transition to SHIPPED and nowhere else.
  reset()
  state.allocations = [{ lineId: 'line-1', qty: 10, orderId: 'order-1', status: 'PICKING' }]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 6 },
  ]
  const getAllocationDetails = await loadAction()

  const rows = await getAllocationDetails('product-1', 'warehouse-1')

  assert.deepEqual(rows.map((row) => row.qty), [10])
})

test('o3d-4kfh: a dispatch from ANOTHER warehouse does not reduce this warehouse\'s reservation', async () => {
  // Dispatch is attributed at (lineId, warehouseId, productId). Netting a warehouse-2 shipment out
  // of the warehouse-1 row would under-report warehouse-1 and leave warehouse-2 over-reported.
  reset()
  state.allocations = [{ lineId: 'line-1', qty: 7, orderId: 'order-1', status: 'ALLOCATED' }]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', status: 'SHIPPED', qty: 3 },
  ]
  const getAllocationDetails = await loadAction()

  const rows = await getAllocationDetails('product-1', 'warehouse-1')

  assert.deepEqual(rows.map((row) => row.qty), [7])
})

test('o3d-4kfh: with no shipments at all the whole allocation is still reported', async () => {
  reset()
  state.allocations = [
    { lineId: 'line-1', qty: 3, orderId: 'order-1', status: 'ALLOCATED' },
    { lineId: 'line-2', qty: 2, orderId: 'order-2', status: 'PROCESSING' },
  ]
  const getAllocationDetails = await loadAction()

  const rows = await getAllocationDetails('product-1', 'warehouse-1')

  assert.deepEqual(rows.map((row) => [row.id, row.qty]), [['order-1', 3], ['order-2', 2]])
})
