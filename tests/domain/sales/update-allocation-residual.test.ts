import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-4kfh — updateAllocation (the manual allocation editor) is the third release site, and the
 * one with NO shipment guard of any kind. It released `alloc.qty` verbatim: on a partially
 * dispatched line that is more than the order still holds, so the guarded decrement matched
 * nothing and the old floor branch zeroed the whole (product, warehouse) scope — taking every
 * other order's reservation with it.
 */

type StockLevelRow = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
type AllocationRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
}
type ShipmentLineRow = { lineId: string; productId: string; warehouseId: string; status: string; qty: number }

const state = {
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipmentLines: [] as ShipmentLineRow[],
}

function decimalLikeToNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return (value as { toNumber(): number }).toNumber()
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => {}, requireAuth: async () => ({}) },
})
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushOrderDeliveryMetadata: async () => {},
  },
})

const tx = {
  $queryRaw: async () => [],
  salesOrder: {
    findUnique: async () => ({ inventoryAllocatedDate: null }),
    update: async () => ({}),
  },
  shipment: {
    findFirst: async () => null,
  },
  salesOrderLine: {
    findMany: async () => [],
  },
  shipmentLine: {
    findMany: async ({ where }: { where: { shipment: { status: string } } }) => state.shipmentLines
      .filter((line) => line.status === where.shipment.status)
      .map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
        shipment: { warehouseId: line.warehouseId },
      })),
  },
  stockLevel: {
    findMany: async ({ where }: { where: { productId: string; warehouseId: { in: string[] } } }) =>
      state.stockLevels
        .filter((row) => row.productId === where.productId && where.warehouseId.in.includes(row.warehouseId))
        .map((row) => ({ ...row })),
    // Honours the guarded decrement, so a release bigger than the aggregate cannot silently "work".
    updateMany: async ({ where, data }: {
      where: { productId?: string; warehouseId?: string; reservedQty?: { gte?: unknown } }
      data: { reservedQty: { increment?: unknown; decrement?: unknown } }
    }) => {
      const rows = state.stockLevels.filter((row) => {
        if (where.productId != null && row.productId !== where.productId) return false
        if (where.warehouseId != null && row.warehouseId !== where.warehouseId) return false
        if (where.reservedQty?.gte != null && !(row.reservedQty >= decimalLikeToNumber(where.reservedQty.gte))) return false
        return true
      })
      for (const row of rows) {
        row.reservedQty += decimalLikeToNumber(data.reservedQty.increment)
        row.reservedQty -= decimalLikeToNumber(data.reservedQty.decrement)
      }
      return { count: rows.length }
    },
  },
  orderAllocation: {
    findUnique: async ({ where }: { where: { lineId_warehouseId_productId?: { lineId: string; warehouseId: string; productId: string } } }) => {
      const key = where.lineId_warehouseId_productId
      if (!key) return null
      return state.allocations.find((row) => (
        row.lineId === key.lineId && row.warehouseId === key.warehouseId && row.productId === key.productId
      )) ?? null
    },
    findMany: async () => state.allocations.map((row) => ({ ...row })),
    update: async ({ where, data }: { where: { id: string }; data: { warehouseId?: string; qty?: unknown } }) => {
      const row = state.allocations.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error('allocation not found')
      if (data.warehouseId) row.warehouseId = data.warehouseId
      if (data.qty !== undefined) row.qty = decimalLikeToNumber(data.qty)
      return row
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = state.allocations.findIndex((row) => row.id === where.id)
      if (index >= 0) state.allocations.splice(index, 1)
      return {}
    },
    updateMany: async () => ({ count: 0 }),
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...tx,
      orderAllocation: {
        ...tx.orderAllocation,
        findUnique: async ({ where }: { where: { id?: string } }) => {
          if (!where.id) return null
          const row = state.allocations.find((candidate) => candidate.id === where.id)
          if (!row) return null
          return {
            ...row,
            line: { qty: 10 },
            order: { orderNumber: 'SO-1', externalOrderNumber: null },
          }
        },
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  },
})

async function loadAction() {
  return import('@/app/actions/allocation')
}

/**
 * Order A allocated 10 of product-1 @ warehouse-1 and dispatched 5 of them; order B holds 3 in the
 * same scope. reservedQty 8 = A's live 5 + B's 3.
 */
function seedPartiallyDispatched() {
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 8, reservedQty: 8 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
}

test('o3d-4kfh: updateAllocation releases the residual, so another order keeps its reservation', async () => {
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  // Trim A's row from 10 to 7: 5 dispatched + 2 still live, i.e. release 5 and reserve 2.
  const result = await updateAllocation('alloc-a', 'warehouse-1', 7)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 7)
  assert.equal(
    state.stockLevels[0].reservedQty,
    5,
    'A now holds 2 live and B still holds 3 — releasing the raw 10 used to floor this to 0',
  )
})

test('o3d-4kfh: zeroing a fully dispatched allocation releases nothing at all', async () => {
  // Every allocated unit has shipped, so dispatch already returned the whole reservation. The only
  // correct release is zero; releasing the retained 5 would come straight out of order B's 3.
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(state.allocations, [], 'the row is removed')
  assert.equal(state.stockLevels[0].reservedQty, 3, 'order B\'s reservation is untouched')
})

test('o3d-4kfh: a PICKED (not dispatched) shipment nets nothing — its reservation is still live', async () => {
  // reservedQty is decremented on the transition to SHIPPED and nowhere else. Treating a PICKING
  // shipment as "already released" would under-release and strand reservation on the stock level.
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.equal(result.success, true, result.error)
  assert.equal(state.stockLevels[0].reservedQty, 4, 'the full 10 was released and 4 re-reserved')
})

test('o3d-4kfh: a release bigger than the whole aggregate is REFUSED, not floored', async () => {
  // Genuine drift with no dispatch to explain it. There is no honest way to give 6 back out of a
  // scope holding 4, and zeroing it would take another order's reservation with it.
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 4 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot release 6 reserved unit\(s\)/)
  assert.equal(state.stockLevels[0].reservedQty, 4, 'the scope was NOT zeroed')
})
