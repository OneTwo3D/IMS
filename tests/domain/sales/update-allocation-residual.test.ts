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
type SalesOrderLineRow = { id: string; orderId: string; productId: string; qty: number; sku: string }

const state = {
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipmentLines: [] as ShipmentLineRow[],
  // The order's real lines. validateAllocationIntegrity runs at the end of EVERY updateAllocation
  // call; a double returning [] here made it exit at `lines.length === 0` before it compared
  // anything, so every assertion about the post-edit state was made against a validator that had
  // been switched off (Codex review of o3d-4kfh).
  lines: [] as SalesOrderLineRow[],
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
    findMany: async ({ where }: { where: { orderId: string; id?: { in: string[] } } }) => state.lines
      .filter((line) => line.orderId === where.orderId)
      .filter((line) => !where.id || where.id.in.includes(line.id))
      .map((line) => ({
        id: line.id,
        productId: line.productId,
        qty: line.qty,
        sku: line.sku,
        description: line.sku,
      })),
  },
  // Every product here is SIMPLE, so the fulfillment graph is a single self-requirement of
  // factor 1 — but validateAllocationIntegrity really does load it, so it has to be answerable.
  product: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({
      id,
      type: 'SIMPLE',
      productComponents: [],
    })),
  },
  shipmentLine: {
    // Honours BOTH status shapes production asks for, and they are not the same question:
    // `status: 'SHIPPED'` is the reservation residual (the only status that gives reservation
    // back), `status: { not: 'PENDING' }` is committed demand. A double that understood only one
    // of them would answer the other with the wrong set (o3d-4kfh).
    findMany: async ({ where }: {
      where: { shipment: { status: string | { not: string } }; lineId?: { in: string[] } }
    }) => state.shipmentLines
      .filter((line) => (
        typeof where.shipment.status === 'string'
          ? line.status === where.shipment.status
          : line.status !== where.shipment.status.not
      ))
      .filter((line) => !where.lineId || where.lineId.in.includes(line.lineId))
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
    // Filtered by the predicates production passes. Returning EVERY row regardless of `where`
    // would hand validateAllocationIntegrity another order's allocations as if they were this
    // order's, and hand the residual loader rows it never asked for.
    findMany: async ({ where }: { where?: { orderId?: string; lineId?: { in: string[] } } } = {}) => state
      .allocations
      .filter((row) => where?.orderId == null || row.orderId === where.orderId)
      .filter((row) => !where?.lineId || where.lineId.in.includes(row.lineId))
      .map((row) => ({ ...row })),
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

/** The order's own lines. Kept in step with the fixtures so the integrity check is answerable. */
function seedLines(qty: number) {
  state.lines = [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty, sku: 'SKU-1' }]
}

/**
 * Order A allocated 10 of product-1 @ warehouse-1 and dispatched 5 of them; order B holds 3 in the
 * same scope. reservedQty 8 = A's live 5 + B's 3.
 */
function seedPartiallyDispatched() {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 8, reservedQty: 8 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
}

function reservedAt(warehouseId: string): number | undefined {
  return state.stockLevels.find((row) => row.warehouseId === warehouseId)?.reservedQty
}

test('o3d-4kfh: updateAllocation releases the residual, so another order keeps its reservation', async () => {
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  // Trim A's row from 10 to 7: 5 dispatched + 2 still live, i.e. release 5 and reserve 2.
  const result = await updateAllocation('alloc-a', 'warehouse-1', 7)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 7)
  assert.equal(
    reservedAt('warehouse-1'),
    5,
    'A now holds 2 live and B still holds 3 — releasing the raw 10 used to floor this to 0',
  )
})

test('o3d-4kfh: a partially dispatched allocation cannot be REDUCED below what shipped from it', async () => {
  // The row is the only record of what shipped from this warehouse: the reservation residual, the
  // shipment remainder in confirmSalesOrderShipments and the accounting sub-ledger all read it as
  // `qty - shipped`. Shrinking it below 5 does not release anything (the residual is already
  // floored at zero) — it silently makes the dispatched units unaccounted for.
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 3)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10, 'the row is untouched')
  assert.equal(reservedAt('warehouse-1'), 8, 'and so is the reservation')
})

test('o3d-4kfh: deleting a fully dispatched allocation is REFUSED, and releases nothing either way', async () => {
  // Every allocated unit has shipped, so dispatch already returned the whole reservation: the only
  // correct release is zero, and releasing the retained 5 would come straight out of order B's 3.
  // Deleting the row would ALSO erase the dispatch attribution, so the edit is refused outright.
  seedLines(5)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations.length, 1, 'the dispatched row survives')
  assert.equal(reservedAt('warehouse-1'), 3, 'and order B\'s reservation is untouched')
})

test('o3d-4kfh: GROWING a fully dispatched allocation reserves only the added units', async () => {
  // The complement of the refusal above: dispatched quantity is a floor, not a freeze. Going 5 -> 8
  // on a row whose 5 have all shipped releases the residual (0) and reserves the 3 new units only.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 3 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 8)
  assert.equal(reservedAt('warehouse-1'), 6, 'order B keeps 3 and A reserves 3 more, not 8')
})

test('o3d-4kfh: a partially dispatched allocation cannot be MOVED to another warehouse (no merge)', async () => {
  // Dispatched quantity is attributed to the row it shipped from. Moving the row takes the history
  // with it: the destination has no dispatch to net, so it re-reserves the shipped units, and the
  // source keeps a shipment with no row to net it out of.
  seedPartiallyDispatched()
  state.stockLevels.push({ productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 0 })
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.equal(state.allocations[0].warehouseId, 'warehouse-1', 'the row stays where it shipped from')
  assert.equal(state.allocations[0].qty, 10)
  assert.equal(reservedAt('warehouse-1'), 8, 'warehouse-1 reservation untouched')
  assert.equal(reservedAt('warehouse-2'), 0, 'and nothing was re-reserved at the destination')
})

test('o3d-4kfh: nor MERGED into an existing row in another warehouse', async () => {
  // Codex\'s worked example. W1 holds 10 with 5 shipped, W2 holds 4; moving W1 to W2 at newQty 10
  // released W1\'s residual 5, wrote a W2 row of 14, saw no dispatch at W2 and reserved 10 more —
  // 14 live reserved units where 9 is correct, and the W1 row that nets the shipment destroyed.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 5 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 4 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 4 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'SHIPPED', qty: 5 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.deepEqual(
    state.allocations.map((row) => [row.warehouseId, row.qty]),
    [['warehouse-1', 10], ['warehouse-2', 4]],
    'both rows survive exactly as they were',
  )
  assert.equal(reservedAt('warehouse-1'), 5)
  assert.equal(reservedAt('warehouse-2'), 4, 'the destination did not gain a second reservation')
})

test('o3d-4kfh: an UNdispatched row still merges, and reserves only the units it moves', async () => {
  // The merge path is not blanket-refused: only a source scope with its own dispatch is. Here W1\'s
  // 6 have not shipped and W2 already holds 10 of which 6 shipped (residual 4). Moving W1 into W2
  // must reserve the 6 moved units and nothing else — not the 16-unit merged row, and not the 6
  // W2 units dispatch already gave back.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 10, reservedQty: 4 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', status: 'SHIPPED', qty: 6 },
  ]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(
    state.allocations.map((row) => [row.warehouseId, row.qty]),
    [['warehouse-2', 16]],
    'the W2 row keeps its 6 dispatched units and gains the 6 moved ones',
  )
  assert.equal(reservedAt('warehouse-1'), 0, 'W1 gave back its whole residual')
  assert.equal(reservedAt('warehouse-2'), 10, '4 residual + 6 moved — not 16')
})

test('o3d-4kfh: a PICKED (not dispatched) shipment nets nothing — its reservation is still live', async () => {
  // reservedQty is decremented on the transition to SHIPPED and nowhere else. Treating a PICKING
  // shipment as "already released" would under-release and strand reservation on the stock level.
  seedLines(10)
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
  assert.equal(reservedAt('warehouse-1'), 4, 'the full 10 was released and 4 re-reserved')
})

test('o3d-4kfh: a release bigger than the whole aggregate is REFUSED, not floored', async () => {
  // Genuine drift with no dispatch to explain it. There is no honest way to give 6 back out of a
  // scope holding 4, and zeroing it would take another order's reservation with it.
  seedLines(6)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 4 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot release 6 reserved unit\(s\)/)
  assert.equal(reservedAt('warehouse-1'), 4, 'the scope was NOT zeroed')
})

test('o3d-4kfh: the integrity check really runs — an edit past the remaining demand is refused', async () => {
  // Guards the doubles themselves. `salesOrderLine.findMany` returning [] made
  // validateAllocationIntegrity exit at `lines.length === 0`, so every test above was asserting
  // against a validator that never reached a comparison (Codex review of o3d-4kfh).
  seedLines(6)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 50, reservedQty: 6 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  // Stock is plentiful, so nothing before the integrity check can refuse this: 9 allocated units
  // against a 6-unit line is over-allocation and only the validator can say so.
  const result = await updateAllocation('alloc-a', 'warehouse-1', 9)

  assert.equal(result.success, false)
  assert.match(String(result.error), /exceeds the remaining quantity to fulfill/)
})

test('o3d-4kfh: and it does NOT refuse a partially dispatched order (the retained row is not over-allocation)', async () => {
  // The same validator on the fixture from the first test: 10 ordered, 5 shipped, a retained row of
  // 10. Comparing the RAW row against demand that already has the 5 subtracted read as 10 allocated
  // against 5 remaining and refused every manual edit — and every shipment confirmation — for the
  // rest of that order's life.
  seedPartiallyDispatched()
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 10)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 10)
})
