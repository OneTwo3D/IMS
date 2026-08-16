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
/** A PENDING draft, with the label metadata a retirement has to report (o3d-4kfh r4). */
type PendingShipmentRow = {
  id: string
  orderId: string
  warehouseId: string
  trackingNumber: string | null
  shippingService: string | null
  createdAt: string
  lines: Array<{ lineId: string; productId: string; qty: number }>
}

const state = {
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipmentLines: [] as ShipmentLineRow[],
  // The order's real lines. validateAllocationIntegrity runs at the end of EVERY updateAllocation
  // call; a double returning [] here made it exit at `lines.length === 0` before it compared
  // anything, so every assertion about the post-edit state was made against a validator that had
  // been switched off (Codex review of o3d-4kfh).
  lines: [] as SalesOrderLineRow[],
  // Set by the concurrency test only: the snapshot the NON-transactional pre-read still sees after
  // a second editor has already committed. null = read the live rows like every other test.
  staleOuterAllocations: null as AllocationRow[] | null,
  // o3d-4kfh r4: the order's PENDING drafts. updateAllocation had NO draft cleanup at all, so a
  // double without them could not observe the defect in either direction.
  pendingShipments: [] as PendingShipmentRow[],
  /** Every activity-log entry, so the retirement record can be asserted rather than assumed. */
  activity: [] as Record<string, unknown>[],
}

function decimalLikeToNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return (value as { toNumber(): number }).toNumber()
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
  },
})
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
    // Honours the PENDING equality predicate and returns each draft's own lines plus its label
    // metadata, because that is exactly what `reconcilePendingShipments` reads. A double that
    // returned `[]` here (or ignored the status) would make every draft assertion below vacuous.
    findMany: async ({ where }: { where: { orderId: string; status?: string } }) => state.pendingShipments
      .filter((shipment) => shipment.orderId === where.orderId)
      .filter(() => where.status == null || where.status === 'PENDING')
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((shipment) => ({
        id: shipment.id,
        warehouseId: shipment.warehouseId,
        trackingNumber: shipment.trackingNumber,
        shippingService: shipment.shippingService,
        lines: shipment.lines.map((line) => ({ ...line })),
      })),
    // Real deletion, and it takes the draft's lines with it as the FK cascade does. Returning a
    // hard-coded `{ count: 0 }` here is precisely the vacuous double that hid the rebalancer's
    // destructive behaviour for a whole review round.
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = state.pendingShipments.length
      state.pendingShipments = state.pendingShipments.filter((shipment) => !where.id.in.includes(shipment.id))
      return { count: before - state.pendingShipments.length }
    },
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
        // The STATUS is part of the row, not just of the filter. loadCommittedAllocationLines
        // fetches the non-PENDING set once and splits it into "committed" (the edit floor) and
        // "dispatched" (the reservation delta) by this field — a double that omitted it made every
        // line look un-dispatched, so the residual silently became the whole row (o3d-4kfh r2).
        shipment: { warehouseId: line.warehouseId, status: line.status },
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
    // Answers BOTH unique shapes production uses: the merge-target lookup by
    // (lineId, warehouseId, productId), and — since o3d-4kfh round 3 — the re-read by `id` that
    // updateAllocation performs under the order lock. A double that answered only the compound key
    // would return null for the re-read and make every edit fail closed, which would look like the
    // guard working when in fact nothing was being exercised.
    findUnique: async ({ where }: { where: { id?: string; lineId_warehouseId_productId?: { lineId: string; warehouseId: string; productId: string } } }) => {
      if (where.id) return state.allocations.find((row) => row.id === where.id) ?? null
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
          // `staleOuterAllocations` models the ONE thing that separates the outer read from the
          // in-transaction one: it happens before the order lock, so another editor can commit in
          // between. When a test sets it, this read (and only this read) is served from that frozen
          // snapshot while `tx` keeps serving the committed state.
          const source = state.staleOuterAllocations ?? state.allocations
          const row = source.find((candidate) => candidate.id === where.id)
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
  state.staleOuterAllocations = null
  state.pendingShipments = []
  state.activity.length = 0
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

/** 10 allocated at W1 with a `status` shipment of 5 against it, and nothing dispatched. */
function seedCommittedNotDispatched(status: 'PICKING' | 'PACKED') {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status, qty: 5 },
  ]
}

test('o3d-4kfh: a PICKED (not dispatched) shipment nets nothing from the reservation, but it IS a floor', async () => {
  // Two different subtractions, and this row is subject to both. reservedQty is decremented on the
  // transition to SHIPPED and nowhere else, so a PICKING shipment has released NOTHING and the
  // reservation delta must not net it (netting it would under-release and strand reservation
  // forever). But the picked units are still attached to this row: the shipment carries
  // (lineId, productId) and its shipment the warehouseId, and that triple is the only thing tying
  // them together. Cutting the row to 4 used to SUCCEED and drop the reservation to 4, leaving a
  // 5-unit shipment that transitionShipmentStatus can only dispatch by taking the missing unit out
  // of another order's share of the aggregate.
  seedCommittedNotDispatched('PICKING')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.equal(result.success, false, 'the edit is refused, not applied')
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10, 'the row still covers its committed shipment')
  assert.equal(reservedAt('warehouse-1'), 10, 'and the reservation is untouched')
})

test('o3d-4kfh: a PICKED shipment can still be trimmed DOWN TO its committed quantity', async () => {
  // The floor is a floor, not a freeze: the 5 uncommitted units are still the operator's to give
  // back, and doing so must release exactly 5 (the residual of the old row minus the residual of
  // the new one) — the picked 5 stay reserved because they have not shipped.
  seedCommittedNotDispatched('PICKING')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 5)
  assert.equal(reservedAt('warehouse-1'), 5, 'the 5 picked units keep their live reservation')
})

test('o3d-4kfh: a PACKED shipment is a floor too — reducing below it is refused', async () => {
  // PACKED is further along than PICKING and just as un-dispatched. Both are non-PENDING, which is
  // the whole test: the floor is the COMMITTED set, not the shipped one.
  seedCommittedNotDispatched('PACKED')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations[0].qty, 10)
  assert.equal(reservedAt('warehouse-1'), 10)
})

test('o3d-4kfh: an allocation with a PACKED shipment cannot be MOVED to another warehouse', async () => {
  // The packed units were picked from warehouse-1. Moving the row takes their only attribution with
  // it: warehouse-2 has no shipment to net, so it re-reserves them, and warehouse-1 keeps a packed
  // shipment with no allocation row behind it.
  seedCommittedNotDispatched('PACKED')
  state.stockLevels.push({ productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 0 })
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-2', 10)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot move this allocation to another warehouse/)
  assert.equal(state.allocations[0].warehouseId, 'warehouse-1', 'the row stays where the shipment was picked')
  assert.equal(reservedAt('warehouse-1'), 10)
  assert.equal(reservedAt('warehouse-2'), 0, 'nothing was re-reserved at the destination')
})

test('o3d-4kfh: DELETING an allocation with a PACKED shipment is refused', async () => {
  // newQty 0 is the sharpest version of the under-allocation: the row that the shipment, the
  // residual and the accounting sub-ledger all resolve through simply stops existing, while the
  // packed shipment stays dispatchable.
  seedCommittedNotDispatched('PACKED')
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 0)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.equal(state.allocations.length, 1, 'the row survives')
  assert.equal(reservedAt('warehouse-1'), 10)
})

test('o3d-4kfh: after the refusal the reservation still satisfies the DISPATCH precondition', async () => {
  // The consequence the guard exists to prevent, stated as the condition dispatch actually tests.
  // transitionShipmentStatus decrements stock with
  //   where: { ..., quantity: { gte: qty }, reservedQty: { gte: qty } }
  // and throws "Insufficient physical or reserved stock to dispatch" when that matches no row.
  // reservedQty is the SHARED per-(product, warehouse) aggregate, so a shortfall is resolved
  // either by failing the dispatch outright or — when another order happens to be holding enough
  // there — by silently spending that order's reservation.
  seedCommittedNotDispatched('PICKING')
  const committedShipmentQty = state.shipmentLines[0].qty
  const { updateAllocation } = await loadAction()

  await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.ok(
    (reservedAt('warehouse-1') ?? 0) >= committedShipmentQty,
    `reservedQty ${reservedAt('warehouse-1')} must still cover the ${committedShipmentQty} picked units; `
    + 'letting the edit through left 4 and made the dispatch impossible without robbing another order',
  )
  assert.ok(
    state.allocations[0].qty >= committedShipmentQty,
    'and the allocation row still covers the shipment it will be dispatched against',
  )
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

test('o3d-4kfh r3: TWO CONCURRENT EDITORS of the same row cannot steal the neighbour\'s reservation', async () => {
  // The A/B shared-scope case, run through the exact window the pre-transaction read opens.
  //
  // A=10 and B=3 share (product-1, warehouse-1); reservedQty 13 backs both. Two operators open the
  // editor on A and both see 10. The first commits A=8 (release 10, reserve 8 -> reservedQty 11).
  // The second then enters its transaction, takes the order lock — and used to carry on with its
  // STALE 10: release 10 (11 >= 10, so the guarded decrement happily succeeds) and reserve 9,
  // leaving reservedQty at 10 while the rows claim 8+3=12... except A is now 9, so 9+3=12 against
  // an aggregate of 10. B is short by two units nobody will ever notice: validateAllocationIntegrity
  // never looks at a stock level, and the guarded decrement had enough to hand over.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 13 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    // Order B's own row in the SAME (product, warehouse) scope. It is not this order's, so nothing
    // in updateAllocation reads it — it exists purely to own 3 of the 13 reserved units.
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  state.shipmentLines = []
  const { updateAllocation } = await loadAction()

  // Editor one, in full.
  const first = await updateAllocation('alloc-a', 'warehouse-1', 8)
  assert.equal(first.success, true, first.error)
  assert.equal(reservedAt('warehouse-1'), 11, 'A now holds 8 live, B still holds 3')

  // Editor two: its pre-read happened BEFORE the write above, so it still sees A=10.
  state.staleOuterAllocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
    { id: 'alloc-b', orderId: 'order-2', lineId: 'line-2', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 },
  ]
  const second = await updateAllocation('alloc-a', 'warehouse-1', 9)

  // The invariant that actually matters FIRST, asserted independently of HOW it is kept: the shared
  // aggregate still equals the sum of the rows claiming it, so B's 3 units are still B's. Asserted
  // ahead of the message so a regression reports the theft rather than the wording.
  const rowTotal = state.allocations
    .filter((row) => row.productId === 'product-1' && row.warehouseId === 'warehouse-1')
    .reduce((sum, row) => sum + row.qty, 0)
  assert.equal(
    reservedAt('warehouse-1'),
    rowTotal,
    `reservedQty ${reservedAt('warehouse-1')} must equal the ${rowTotal} units the allocation rows claim`,
  )
  assert.equal(state.allocations.find((row) => row.id === 'alloc-b')?.qty, 3, 'B\'s row is untouched')
  assert.equal(second.success, false, 'the stale editor must be refused, not silently applied')
  assert.match(String(second.error), /changed while you were editing/)
})

// ---------------------------------------------------------------------------
// o3d-4kfh r4 (Codex finding 3) — a manual edit must reconcile the PENDING drafts it invalidates.
//
// updateAllocation validated only NON-PENDING commitments and then committed. Reducing an
// allocation 10 -> 5 left its 10-unit PENDING draft intact and perfectly ordinary-looking; the very
// next Start Picking — or a WMS dispatch applied against it — then failed the r3 commitment
// coverage guard. An external fulfilment dead-letter caused by an EARLIER SUCCESSFUL IMS action.
//
// The retirement now runs inside the same transaction, through the shared
// `reconcilePendingShipments`, and only drafts the post-edit rows no longer back are touched.
// ---------------------------------------------------------------------------

/** A PENDING draft on `warehouseId` for `qty` of product-1, as confirmAllocations would build it. */
function draft(
  id: string,
  warehouseId: string,
  qty: number,
  extra: { trackingNumber?: string; shippingService?: string; createdAt?: string; lineId?: string; productId?: string } = {},
) {
  return {
    id,
    orderId: 'order-1',
    warehouseId,
    trackingNumber: extra.trackingNumber ?? null,
    shippingService: extra.shippingService ?? null,
    createdAt: extra.createdAt ?? '2026-01-01T00:00:00Z',
    lines: [{ lineId: extra.lineId ?? 'line-1', productId: extra.productId ?? 'product-1', qty }],
  }
}

function draftIds(): string[] {
  return state.pendingShipments.map((shipment) => shipment.id).sort()
}

function retirementLog() {
  return state.activity.find((entry) => entry.action === 'pending_shipments_retired')
}

test('o3d-4kfh r4: SHRINKING an allocation retires the oversized PENDING draft it no longer backs', async () => {
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10)]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.equal(state.allocations[0].qty, 5)
  assert.deepEqual(draftIds(), [], 'the 10-unit draft cannot survive a 5-unit allocation')
  assert.deepEqual(
    (result.retiredPendingShipments ?? []).map((row) => row.id),
    ['draft-1'],
    'and the caller is told which draft went, not merely that one did',
  )
})

test('o3d-4kfh r4: an edit that still backs its draft leaves it — and its tracking number — alone', async () => {
  // The complement, and the reason this is a coverage charge rather than a blanket delete: growing
  // (or trimming to a quantity the draft still fits inside) invalidates nothing, so a draft an
  // operator has already put a tracking number on must survive untouched.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 4 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 4, { trackingNumber: 'TRACK-KEEP', shippingService: 'DPD' })]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 8)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), ['draft-1'])
  assert.equal(state.pendingShipments[0].trackingNumber, 'TRACK-KEEP', 'the label is not thrown away')
  assert.deepEqual(result.retiredPendingShipments, [], 'and nothing is reported as retired')
  assert.equal(retirementLog(), undefined, 'a no-op retirement writes no activity at all')
})

test('o3d-4kfh r4: MOVING an allocation retires the draft at the old warehouse only', async () => {
  // Warehouse moves invalidate a draft without changing any quantity: the draft still points at the
  // warehouse the units left. A draft in the destination warehouse that its own row still backs is
  // untouched — the per-draft, per-scope charge is what tells the two apart.
  seedLines(20)
  state.stockLevels = [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 },
    { productId: 'product-1', warehouseId: 'warehouse-2', quantity: 50, reservedQty: 3 },
  ]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 6 },
    { id: 'alloc-b', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 3 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [
    draft('draft-w1', 'warehouse-1', 6, { createdAt: '2026-01-01T00:00:00Z' }),
    draft('draft-w2', 'warehouse-2', 3, { createdAt: '2026-01-02T00:00:00Z', trackingNumber: 'TRACK-W2' }),
  ]
  const { updateAllocation } = await loadAction()

  // Move W1's 6 into W2, merging with the existing 3.
  const result = await updateAllocation('alloc-a', 'warehouse-2', 6)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), ['draft-w2'], 'only the draft whose warehouse lost its row is retired')
  assert.equal(state.pendingShipments[0].trackingNumber, 'TRACK-W2', 'the surviving draft keeps its label')
})

test('o3d-4kfh r4: a retired draft carrying a tracking number is logged with enough identity to cancel the label', async () => {
  // Codex finding 2's complaint, asserted on the shared retirement record: a bare count cannot tell
  // an operator WHICH externally purchased label IMS has stopped referencing.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = []
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10, { trackingNumber: 'TRACK-LOST', shippingService: 'DPD Next Day' })]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 2)

  assert.equal(result.success, true, result.error)
  const entry = retirementLog()
  assert.ok(entry, 'the retirement is recorded')
  const metadata = entry!.metadata as Record<string, unknown>
  assert.deepEqual(metadata.retiredTrackingNumbers, ['TRACK-LOST'])
  assert.deepEqual(metadata.retiredShipments, [{
    shipmentId: 'draft-1',
    warehouseId: 'warehouse-1',
    trackingNumber: 'TRACK-LOST',
    shippingService: 'DPD Next Day',
    lineCount: 1,
    totalQty: 10,
  }])
  assert.match(String(entry!.description), /TRACK-LOST/)
})

test('o3d-4kfh r4: a REFUSED edit retires nothing — the reconciliation is inside the transaction', async () => {
  // The floor refusal throws out of the transaction callback, so the draft must survive with the
  // row it is drawn from. A reconciliation that ran after the transaction (or that ignored the
  // throw) would delete a draft the edit never applied.
  seedCommittedNotDispatched('PICKING')
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 5)]
  const { updateAllocation } = await loadAction()

  const result = await updateAllocation('alloc-a', 'warehouse-1', 4)

  assert.equal(result.success, false)
  assert.match(String(result.error), /Cannot reduce this allocation below 5/)
  assert.deepEqual(draftIds(), ['draft-1'], 'the draft survives the refusal')
  assert.equal(retirementLog(), undefined)
})

test('o3d-4kfh r4: a committed shipment is NOT counted as backing for a draft on the same scope', async () => {
  // 10 allocated, 5 of them already PICKING. Open quantity is 5, so a 10-unit draft is not backed —
  // charging it against the raw row instead of `qty - committed` would let a draft and a commitment
  // both claim the same units, which is the exact over-commitment r3 exists to reject.
  seedLines(10)
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 10 }]
  state.allocations = [
    { id: 'alloc-a', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 },
  ]
  state.shipmentLines = [
    { lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', status: 'PICKING', qty: 5 },
  ]
  state.pendingShipments = [draft('draft-1', 'warehouse-1', 10)]
  const { updateAllocation } = await loadAction()

  // A no-op-sized edit (10 -> 10 is rejected as unchanged upstream, so trim to the floor).
  const result = await updateAllocation('alloc-a', 'warehouse-1', 5)

  assert.equal(result.success, true, result.error)
  assert.deepEqual(draftIds(), [], 'the draft claimed units the PICKING shipment already owns')
})
