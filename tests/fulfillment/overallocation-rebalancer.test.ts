import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0qoo — releaseOverallocations un-stages Group A2 for an order whose allocations it is
 * about to release. inventoryAllocatedBatchRef holds the exact AccountingSyncLog.referenceId
 * A2 staged that order into, and findSalesOrderDeleteBlocker matches on it INDEPENDENTLY of
 * inventoryAllocatedDate. So the ref has to be nulled in the same update as the stamp: a row
 * left holding a ref with no stamp is blocked forever against a batch it has already left.
 *
 * The rebalancer swallows every per-item failure into an activity log, so a broken double
 * would otherwise look like a pass. Every test below asserts the failure log stayed empty.
 *
 * o3d-4kfh r4 (Codex finding 2) — THE DOUBLE BELOW USED TO BE VACUOUS.
 *
 * `shipment.deleteMany` returned `{ count: 0 }` unconditionally and `shipment.findMany` did not
 * exist, so the destructive behaviour of this module was never exercised at all: it ran
 * `deleteMany({ orderId, status: 'PENDING' })` — every draft on the order — while releasing ONE
 * allocation, and the tests could not tell the difference. Drafts are now real rows with real
 * lines, real label metadata and a real cascade, and the allocation/stock state actually mutates,
 * so a regression to the blanket delete turns these red.
 */

type Row = Record<string, unknown>

type AllocationRow = {
  id: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  order: {
    id: string
    orderNumber: string | null
    externalOrderNumber: string | null
    status: string
    createdAt: string
    inventoryAllocatedDate: Date | null
  }
}

type StockLevelRow = { productId: string; warehouseId: string; quantity: number; reservedQty: number }

type ShipmentRow = {
  id: string
  orderId: string
  warehouseId: string
  status: string
  trackingNumber: string | null
  shippingService: string | null
  createdAt: string
}

type ShipmentLineRow = { id: string; shipmentId: string; lineId: string; productId: string; qty: number }

const state = {
  /** Every salesOrder.update payload, in call order. */
  salesOrderUpdates: [] as Row[],
  /** Every orderAllocation.updateMany payload. */
  allocationUpdates: [] as Row[],
  activity: [] as Row[],
  stockLevels: [] as StockLevelRow[],
  allocations: [] as AllocationRow[],
  shipments: [] as ShipmentRow[],
  shipmentLines: [] as ShipmentLineRow[],
  /** Set when the fixture wants a journaled (Group B posted) shipment on the order. */
  journaledShipment: null as Row | null,
  deletedAllocationIds: [] as string[],
}

function reset() {
  state.salesOrderUpdates.length = 0
  state.allocationUpdates.length = 0
  state.activity.length = 0
  state.allocations.length = 0
  state.shipments.length = 0
  state.shipmentLines.length = 0
  state.stockLevels.length = 0
  state.deletedAllocationIds.length = 0
  state.journaledShipment = null
}

mock.module('next/cache', {
  namedExports: { revalidatePath: () => {} },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

// Dynamically imported by the reconcile pass at the end of releaseOverallocations; stubbed so
// the test never reaches the real allocator (which would want a database).
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})

function decimalLikeToNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return (value as { toNumber(): number }).toNumber()
}

const tx = {
  $queryRaw: async () => [],
  stockLevel: {
    findUnique: async ({ where }: { where: { productId_warehouseId: { productId: string; warehouseId: string } } }) => {
      const key = where.productId_warehouseId
      const row = state.stockLevels.find((candidate) => (
        candidate.productId === key.productId && candidate.warehouseId === key.warehouseId
      ))
      return row ? { ...row } : null
    },
    // Real decrement against real rows: a no-op double would let the release loop believe it had
    // given back units it never did, and `excess` would then never converge.
    updateMany: async ({ where, data }: {
      where: { productId: string; warehouseId: string }
      data: { reservedQty: { decrement?: unknown; increment?: unknown } }
    }) => {
      const rows = state.stockLevels.filter((row) => (
        row.productId === where.productId && row.warehouseId === where.warehouseId
      ))
      for (const row of rows) {
        row.reservedQty += decimalLikeToNumber(data.reservedQty.increment)
        row.reservedQty -= decimalLikeToNumber(data.reservedQty.decrement)
      }
      return { count: rows.length }
    },
  },
  shipmentLine: {
    // The COMMITTED (non-PENDING) set, joined to its shipment for the warehouse. Honours the
    // `not: 'PENDING'` predicate, so a PENDING draft's lines are never mistaken for a commitment.
    findMany: async ({ where }: {
      where: {
        productId?: string
        shipment: { orderId?: string; warehouseId?: string; status: string | { not: string } }
      }
    }) => state.shipmentLines.flatMap((line) => {
      const shipment = state.shipments.find((row) => row.id === line.shipmentId)
      if (!shipment) return []
      if (where.shipment.orderId != null && shipment.orderId !== where.shipment.orderId) return []
      if (where.shipment.warehouseId != null && shipment.warehouseId !== where.shipment.warehouseId) return []
      if (where.productId != null && line.productId !== where.productId) return []
      const status = where.shipment.status
      const matches = typeof status === 'string' ? shipment.status === status : shipment.status !== status.not
      if (!matches) return []
      return [{
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
        shipment: { warehouseId: shipment.warehouseId },
      }]
    }),
  },
  shipment: {
    findFirst: async () => state.journaledShipment,
    // PENDING drafts with their own lines and label metadata, ordered oldest-first exactly as
    // production asks for them.
    findMany: async ({ where }: { where: { orderId: string; status?: string } }) => state.shipments
      .filter((shipment) => shipment.orderId === where.orderId)
      .filter((shipment) => where.status == null || shipment.status === where.status)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((shipment) => ({
        id: shipment.id,
        warehouseId: shipment.warehouseId,
        trackingNumber: shipment.trackingNumber,
        shippingService: shipment.shippingService,
        lines: state.shipmentLines
          .filter((line) => line.shipmentId === shipment.id)
          .map((line) => ({ lineId: line.lineId, productId: line.productId, qty: line.qty })),
      })),
    // Deletes for real AND cascades the lines, as the FK does. Leaving orphaned lines behind would
    // let a deleted draft keep answering every shipmentLine query.
    deleteMany: async ({ where }: { where: { id?: { in: string[] }; orderId?: string; status?: string } }) => {
      const doomed = state.shipments.filter((shipment) => {
        if (where.id && !where.id.in.includes(shipment.id)) return false
        if (where.orderId != null && shipment.orderId !== where.orderId) return false
        if (where.status != null && shipment.status !== where.status) return false
        return true
      })
      const doomedIds = new Set(doomed.map((shipment) => shipment.id))
      state.shipments = state.shipments.filter((shipment) => !doomedIds.has(shipment.id))
      state.shipmentLines = state.shipmentLines.filter((line) => !doomedIds.has(line.shipmentId))
      return { count: doomed.length }
    },
  },
  salesOrder: {
    update: async ({ data }: { data: Row }) => {
      state.salesOrderUpdates.push(data)
      return {}
    },
  },
  orderAllocation: {
    // Honours BOTH shapes production asks for: the release loop's
    // `{ productId, warehouseId, order: { status: { in } } }` scan, and the reconciler's
    // `{ orderId }`. A double that ignored the predicate would hand the reconciler another order's
    // rows and make an unbacked draft look backed.
    findMany: async ({ where }: {
      where: { productId?: string; warehouseId?: string; orderId?: string; order?: { status: { in: string[] } } }
    }) => state.allocations
      .filter((row) => where.productId == null || row.productId === where.productId)
      .filter((row) => where.warehouseId == null || row.warehouseId === where.warehouseId)
      .filter((row) => where.orderId == null || row.orderId === where.orderId)
      .filter((row) => where.order == null || where.order.status.in.includes(row.order.status))
      .slice()
      .sort((a, b) => (a.order.createdAt < b.order.createdAt ? 1 : -1))
      .map((row) => ({ ...row, order: { ...row.order } })),
    updateMany: async ({ data }: { data: Row }) => {
      state.allocationUpdates.push(data)
      return { count: 1 }
    },
    update: async ({ where, data }: { where: { id: string }; data: { qty: number } }) => {
      const row = state.allocations.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error('allocation not found')
      row.qty = decimalLikeToNumber(data.qty)
      return row
    },
    delete: async ({ where }: { where: { id: string } }) => {
      state.deletedAllocationIds.push(where.id)
      const index = state.allocations.findIndex((row) => row.id === where.id)
      if (index >= 0) state.allocations.splice(index, 1)
      return {}
    },
    count: async ({ where }: { where: { orderId: string } }) => state.allocations
      .filter((row) => row.orderId === where.orderId).length,
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      orderAllocation: {
        // Phase 1 candidate gather, outside the transaction.
        findMany: async ({ where }: { where: { productId: string; warehouseId: string } }) => state.allocations
          .filter((row) => row.productId === where.productId && row.warehouseId === where.warehouseId)
          .map((row) => ({ orderId: row.orderId, order: { createdAt: new Date(row.order.createdAt) } })),
      },
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
    },
  },
})

async function loadRebalancer() {
  return import('@/lib/fulfillment/overallocation-rebalancer')
}

function order(
  id: string,
  overrides: { status?: string; createdAt?: string; inventoryAllocatedDate?: Date | null } = {},
) {
  return {
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    status: overrides.status ?? 'ALLOCATED',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    inventoryAllocatedDate: overrides.inventoryAllocatedDate ?? null,
  }
}

function seedStagedOverallocation() {
  // 1 unit on hand, 2 reserved by a single A2-staged order: excess 1, so the order's
  // allocation is fully released and the A2 un-stage branch runs.
  state.stockLevels = [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 2 }]
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 1,
    order: order('order-1', { inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z') }),
  }]
}

/** The A2 un-stage write, distinguished from the ALLOCATED→PROCESSING status write. */
function unstageWrite() {
  return state.salesOrderUpdates.find((data) => 'inventoryAllocatedDate' in data)
}

function assertNoSwallowedFailure() {
  const failures = state.activity.filter((entry) => entry.action === 'overallocation_release_failed')
  assert.deepEqual(
    failures.map((entry) => entry.description),
    [],
    'releaseOverallocations swallows exceptions into an activity log — a failure here means the test never exercised the un-stage',
  )
}

function retirementEntries() {
  return state.activity.filter((entry) => entry.action === 'pending_shipments_retired')
}

function shipmentIds(): string[] {
  return state.shipments.map((shipment) => shipment.id).sort()
}

test('releaseOverallocations clears inventoryAllocatedBatchRef in the same update as the stamp (o3d-0qoo)', async () => {
  reset()
  seedStagedOverallocation()
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 1, 'the overallocated unit was actually released')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-1'])

  const write = unstageWrite()
  assert.ok(write, 'the A2 un-stage write must have happened')
  // deepEqual, not a per-key lookup: it proves the ref key is PRESENT and null rather than
  // merely absent, which is exactly what an omitted Prisma field would look like.
  assert.deepEqual(write, {
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
  })
  assert.deepEqual(state.allocationUpdates.length, 1, 'and the cost snapshots are still nulled alongside it')
})

test('releaseOverallocations skips the order entirely when a shipment is journaled (o3d-0qoo)', async () => {
  // Group B posted means the release is refused, so neither the stamp nor the ref is touched —
  // the order stays findable against its A2 batch rather than silently losing the handle.
  reset()
  seedStagedOverallocation()
  state.journaledShipment = { id: 'shipment-1' }
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-1', warehouseId: 'warehouse-1' }],
    { source: 'transfer_dispatch', referenceId: 'tr-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 0)
  assert.equal(result.skipped, 1)
  assert.equal(unstageWrite(), undefined, 'no un-stage write at all on the refused path')
  assert.deepEqual(state.deletedAllocationIds, [], 'and the allocation survives')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r4 (Codex finding 2) — the release must retire ONLY the drafts it unbacked.
// ---------------------------------------------------------------------------

/**
 * One order with two independent drafts: A@W1 (the SKU about to lose stock) and B@W2 (an unrelated
 * product in another warehouse, fully backed by its own allocation row and carrying a purchased
 * label). Codex's worked example.
 */
function seedTwoWarehouseOrder() {
  state.stockLevels = [
    { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 },
    { productId: 'product-b', warehouseId: 'warehouse-2', quantity: 3, reservedQty: 3 },
  ]
  state.allocations = [
    {
      id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-1'),
    },
    {
      id: 'alloc-b', orderId: 'order-1', lineId: 'line-b', productId: 'product-b',
      warehouseId: 'warehouse-2', qty: 3, order: order('order-1'),
    },
  ]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'draft-b', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'PENDING', trackingNumber: 'TRACK-B', shippingService: 'DPD Next Day', createdAt: '2026-01-02T00:00:00Z' },
  ]
  state.shipmentLines = [
    { id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 2 },
    { id: 'sl-b', shipmentId: 'draft-b', lineId: 'line-b', productId: 'product-b', qty: 3 },
  ]
}

test('o3d-4kfh r4: releasing A@W1 does not destroy the unrelated, still-backed B@W2 draft', async () => {
  reset()
  seedTwoWarehouseOrder()
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2, 'A@W1 is fully released — its stock went to zero')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-a'])
  assert.deepEqual(shipmentIds(), ['draft-b'], 'B@W2 survives: its own allocation row still backs it')
  assert.equal(
    state.shipments[0].trackingNumber,
    'TRACK-B',
    'and it keeps the tracking number — the blanket delete threw this away',
  )
  assert.deepEqual(
    state.shipmentLines.map((line) => line.id),
    ['sl-b'],
    'only the retired draft\'s lines cascade away',
  )
})

test('o3d-4kfh r4: the retirement is logged with shipment identity and tracking number, not a bare count', async () => {
  // The whole point of the metadata: an externally purchased label on a retired draft has to be
  // correlatable from the activity log, because IMS no longer holds the row.
  reset()
  seedTwoWarehouseOrder()
  // This time BOTH warehouses lose their stock, so both drafts go — and the one with the label is
  // the one the operator has to act on.
  state.stockLevels = [
    { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 },
    { productId: 'product-b', warehouseId: 'warehouse-2', quantity: 0, reservedQty: 3 },
  ]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [
      { productId: 'product-a', warehouseId: 'warehouse-1' },
      { productId: 'product-b', warehouseId: 'warehouse-2' },
    ],
    { source: 'stock_adjustment', referenceId: 'adj-1', referenceLabel: 'stock adjustment ADJ-1' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(shipmentIds(), [], 'both drafts lost their backing')
  const entries = retirementEntries()
  assert.equal(entries.length, 2, 'one entry per release pass that retired something')
  const withLabel = entries.find((entry) => {
    const metadata = entry.metadata as { retiredTrackingNumbers?: string[] }
    return (metadata.retiredTrackingNumbers ?? []).includes('TRACK-B')
  })
  assert.ok(withLabel, 'the label-carrying retirement is recorded with its tracking number')
  const metadata = withLabel!.metadata as Record<string, unknown>
  assert.deepEqual(metadata.retiredShipments, [{
    shipmentId: 'draft-b',
    warehouseId: 'warehouse-2',
    trackingNumber: 'TRACK-B',
    shippingService: 'DPD Next Day',
    lineCount: 1,
    totalQty: 3,
  }])
  assert.match(String(withLabel!.description), /draft-b/)
  assert.match(String(withLabel!.description), /cancel the label/)
})

test('o3d-4kfh r4: a PARTIAL release retires the draft it no longer fully backs', async () => {
  // 5 allocated, stock drops to 3: the row is trimmed to 3 and the 5-unit draft no longer fits.
  // Trimming the draft instead would silently ship less than the operator confirmed, so it goes
  // whole and the operator re-runs confirm-for-picking.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 5 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 5, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 5 }]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2)
  assert.equal(state.allocations[0].qty, 3, 'the row is trimmed, not deleted')
  assert.deepEqual(shipmentIds(), [], 'and the 5-unit draft it no longer covers is retired')
})

test('o3d-4kfh r4: a release that leaves the draft fully backed retires nothing at all', async () => {
  // The complement — and the property the blanket delete could never have: trimming 5 -> 3 with a
  // 3-unit draft invalidates nothing, so the draft and its label stay put and no warning is logged.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 5 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 5, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'draft-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: 'TRACK-A', shippingService: 'DPD', createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'draft-a', lineId: 'line-a', productId: 'product-a', qty: 3 }]
  const { releaseOverallocations } = await loadRebalancer()

  await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.deepEqual(shipmentIds(), ['draft-a'])
  assert.equal(state.shipments[0].trackingNumber, 'TRACK-A')
  assert.deepEqual(retirementEntries(), [], 'nothing retired, nothing logged')
})

test('o3d-4kfh r4: an UNTOUCHED order on the same SKU keeps its drafts', async () => {
  // The release loop is newest-order-first and stops as soon as the excess is covered. An older
  // order that was never touched must not have its drafts swept up — the blanket delete only
  // avoided this by accident (it was keyed on the released order), and the per-order reconciliation
  // makes it explicit.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 4 }]
  state.allocations = [
    {
      id: 'alloc-new', orderId: 'order-new', lineId: 'line-new', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-new', { createdAt: '2026-02-01T00:00:00Z' }),
    },
    {
      id: 'alloc-old', orderId: 'order-old', lineId: 'line-old', productId: 'product-a',
      warehouseId: 'warehouse-1', qty: 2, order: order('order-old', { createdAt: '2026-01-01T00:00:00Z' }),
    },
  ]
  state.shipments = [
    { id: 'draft-new', orderId: 'order-new', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null, createdAt: '2026-02-01T00:00:00Z' },
    { id: 'draft-old', orderId: 'order-old', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: 'TRACK-OLD', shippingService: 'DPD', createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [
    { id: 'sl-new', shipmentId: 'draft-new', lineId: 'line-new', productId: 'product-a', qty: 2 },
    { id: 'sl-old', shipmentId: 'draft-old', lineId: 'line-old', productId: 'product-a', qty: 2 },
  ]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 2, 'the newest order gives back the whole excess')
  assert.deepEqual(state.deletedAllocationIds, ['alloc-new'])
  assert.deepEqual(shipmentIds(), ['draft-old'], 'the older, untouched order keeps its draft')
  assert.equal(state.shipments[0].trackingNumber, 'TRACK-OLD')
})

test('o3d-4kfh r4: a COMMITTED shipment on the released order is never deleted', async () => {
  // The reconciliation only ever looks at PENDING rows. A PICKING draft is a commitment the
  // warehouse is already acting on — and this order's allocation is skipped for exactly that
  // reason, so nothing about it changes.
  reset()
  state.stockLevels = [{ productId: 'product-a', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 2 }]
  state.allocations = [{
    id: 'alloc-a', orderId: 'order-1', lineId: 'line-a', productId: 'product-a',
    warehouseId: 'warehouse-1', qty: 2, order: order('order-1'),
  }]
  state.shipments = [
    { id: 'picking-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: null, shippingService: null, createdAt: '2026-01-01T00:00:00Z' },
  ]
  state.shipmentLines = [{ id: 'sl-a', shipmentId: 'picking-a', lineId: 'line-a', productId: 'product-a', qty: 2 }]
  const { releaseOverallocations } = await loadRebalancer()

  const result = await releaseOverallocations(
    [{ productId: 'product-a', warehouseId: 'warehouse-1' }],
    { source: 'stock_adjustment', referenceId: 'adj-1' },
  )

  assertNoSwallowedFailure()
  assert.equal(result.released, 0, 'the committed allocation is skipped')
  assert.equal(result.skipped, 1)
  assert.deepEqual(shipmentIds(), ['picking-a'], 'and its shipment is untouched')
  assert.deepEqual(retirementEntries(), [])
})
