import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocateSalesOrder,
  allocationSetsMatch,
  findUnderReservedScopes,
  assertReservationReleaseDelta,
  buildAvailableStockMapIncludingOwnReservations,
  buildAvailableStockMap,
  cancelSalesOrderFulfillmentState,
  resetAllocationAccountingIfStaged,
  updateSalesOrderStatusUnderLock,
  type AllocationServiceClient,
} from '@/lib/domain/sales/allocation-service'
import {
  expandFulfillmentRequirementsDecimal,
  getFulfillmentAvailableQtyDecimal,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'
import { toDecimal } from '@/lib/domain/math/decimal'
import { isPermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'

type ProductRow = {
  id: string
  type: 'SIMPLE' | 'KIT'
  sku?: string
  oversellAllowed?: boolean
  productComponents?: Array<{
    componentId: string
    componentSku?: string
    qty: number
    componentType: 'SIMPLE' | 'KIT'
    componentOversellAllowed?: boolean
  }>
}

type OrderLineRow = {
  id: string
  productId: string | null
  qty: number
  sku: string | null
  description: string
  product: {
    id: string
    sku: string
    type: 'SIMPLE' | 'KIT'
    oversellAllowed: boolean
  } | null
}

type OrderRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  shoppingLinks: Array<{ id: string }>
  status: string
  refundStatus?: string | null
  shipFromWarehouseId: string | null
  inventoryAllocatedDate?: Date | null
  allocationBatchAmount?: number | null
  lines: OrderLineRow[]
}

type WarehouseRow = {
  id: string
  code: string
  name: string
  active: boolean
  availableForSale: boolean
  isDefault: boolean
  syncToStore: boolean
}

type StockLevelRow = {
  productId: string
  warehouseId: string
  quantity: number
  reservedQty: number
}

type AllocationRow = {
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
}

type ShipmentRow = {
  id: string
  orderId: string
  status?: string
  shipmentJournalDate: Date | null
}

type RefundLineRow = {
  orderId: string
  salesOrderLineId: string | null
  qty: number
}

type MemoryState = {
  order: OrderRow
  products: ProductRow[]
  warehouses: WarehouseRow[]
  stockLevels: StockLevelRow[]
  allocations?: AllocationRow[]
  shipments?: ShipmentRow[]
  refundLines?: RefundLineRow[]
}

function decimalLikeToNumber(value: number | { toNumber(): number } | undefined): number {
  return typeof value === 'number' ? value : (value?.toNumber() ?? 0)
}

/** Write counters, so a test can prove o3d-i5it SKIPS the destructive cycle rather than
 *  merely ending with equal row values — a delete+recreate leaves those identical. */
const writeCounts = { allocationCreates: 0, allocationDeletes: 0 }

function createClient(state: MemoryState): AllocationServiceClient {
  writeCounts.allocationCreates = 0
  writeCounts.allocationDeletes = 0
  const allocations = state.allocations ?? []
  const shipments = state.shipments ?? []
  const refundLines = state.refundLines ?? []
  const client = {
    $queryRaw: async () => [],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== state.order.id) return null
        return { ...state.order }
      },
      update: async ({ data }: {
        data: { status?: string; inventoryAllocatedDate?: Date | null; allocationBatchAmount?: number | null }
      }) => {
        if (data.status) state.order.status = data.status
        // resetAllocationAccountingIfStaged clears these. The double used to ignore them, which
        // made any assertion about the A2 stamp vacuous — o3d-i5it turns on exactly that write.
        if ('inventoryAllocatedDate' in data) state.order.inventoryAllocatedDate = data.inventoryAllocatedDate ?? null
        if ('allocationBatchAmount' in data) state.order.allocationBatchAmount = data.allocationBatchAmount ?? null
        return state.order
      },
    },
    warehouse: {
      findMany: async ({ where }: { where: { syncToStore?: boolean } }) => state.warehouses
        .filter((warehouse) => warehouse.active && warehouse.availableForSale)
        .filter((warehouse) => where.syncToStore == null || warehouse.syncToStore === where.syncToStore)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    },
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => state.products
        .filter((product) => where.id.in.includes(product.id))
        .map((product) => ({
          id: product.id,
          type: product.type,
          productComponents: (product.productComponents ?? []).map((component, index) => ({
            componentId: component.componentId,
            qty: component.qty,
            component: {
              sku: component.componentSku ?? component.componentId,
              type: component.componentType,
              oversellAllowed: component.componentOversellAllowed ?? false,
            },
            sortOrder: index,
          })),
        })),
    },
    stockLevel: {
      findMany: async ({ where }: { where: { OR?: Array<{ productId: string; warehouseId: string }>; productId?: { in: string[] }; warehouseId?: { in: string[] } } }) => {
        if (where.OR) {
          // Mimic Prisma's argument validation: a scope may only filter by productId/warehouseId.
          // Passing an allocation row verbatim (which also carries `qty`) is exactly the bug that made
          // cancelling an allocated order throw "Unknown argument `qty`" — reject it here so a mock,
          // unlike a permissive one, catches the regression a real database would.
          for (const scope of where.OR) {
            const extra = Object.keys(scope).filter((k) => k !== 'productId' && k !== 'warehouseId')
            if (extra.length) throw new Error(`Unknown argument \`${extra[0]}\` in stockLevel.findMany where.OR scope`)
          }
          return state.stockLevels.filter((row) => (
            where.OR?.some((scope) => scope.productId === row.productId && scope.warehouseId === row.warehouseId)
          )).map((row) => ({ ...row }))
        }
        return state.stockLevels
          .filter((row) => where.productId == null || where.productId.in.includes(row.productId))
          .filter((row) => where.warehouseId == null || where.warehouseId.in.includes(row.warehouseId))
          .map((row) => ({ ...row }))
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { productId: string; warehouseId: string }
        data: { reservedQty: { increment?: number | { toNumber(): number }; decrement?: number | { toNumber(): number } } }
      }) => {
        const rows = state.stockLevels.filter((row) => row.productId === where.productId && row.warehouseId === where.warehouseId)
        for (const row of rows) {
          row.reservedQty += decimalLikeToNumber(data.reservedQty.increment)
          row.reservedQty -= decimalLikeToNumber(data.reservedQty.decrement)
        }
        return { count: rows.length }
      },
    },
    orderAllocation: {
      findMany: async ({ where }: { where: { orderId: string } }) => allocations
        .filter((allocation) => allocation.orderId === where.orderId)
        .map((allocation) => ({ ...allocation })),
      count: async ({ where }: { where: { orderId: string } }) => allocations
        .filter((allocation) => allocation.orderId === where.orderId)
        .length,
      deleteMany: async ({ where }: { where: { orderId: string } }) => {
        writeCounts.allocationDeletes += 1
        const before = allocations.length
        for (let index = allocations.length - 1; index >= 0; index -= 1) {
          if (allocations[index].orderId === where.orderId) allocations.splice(index, 1)
        }
        return { count: before - allocations.length }
      },
      create: async ({ data }: { data: AllocationRow & { qty: number | { toNumber(): number } } }) => {
        writeCounts.allocationCreates += 1
        // OrderAllocation.qty is @db.Decimal(12,4) — coerce on write, or a test can observe a
        // precision production would never persist and pass while production fails (o3d-i4qd).
        allocations.push({ ...data, qty: persistAllocationQty(decimalLikeToNumber(data.qty)) })
        return data
      },
      updateMany: async () => ({ count: 0 }),
    },
    shipment: {
      findFirst: async ({ where }: { where: { orderId: string; shipmentJournalDate?: { not: null }; status?: string; OR?: Array<{ shipmentJournalDate?: { not: null }; status?: string }> } }) => {
        const rows = shipments.filter((shipment) => shipment.orderId === where.orderId)
        const matchesClause = (clause: { shipmentJournalDate?: { not: null }; status?: string }, shipment: ShipmentRow) => {
          if (clause.shipmentJournalDate?.not === null) return shipment.shipmentJournalDate != null
          if (clause.status !== undefined) return shipment.status === clause.status
          return false
        }
        if (where.OR) {
          return rows.find((shipment) => where.OR!.some((clause) => matchesClause(clause, shipment))) ?? null
        }
        if (where.shipmentJournalDate?.not === null) {
          return rows.find((shipment) => shipment.shipmentJournalDate != null) ?? null
        }
        return rows[0] ?? null
      },
      deleteMany: async ({ where }: { where: { orderId: string; status: { in: string[] } } }) => {
        const before = shipments.length
        for (let index = shipments.length - 1; index >= 0; index -= 1) {
          const shipment = shipments[index]
          if (shipment.orderId === where.orderId && shipment.status && where.status.in.includes(shipment.status)) {
            shipments.splice(index, 1)
          }
        }
        return { count: before - shipments.length }
      },
    },
    shipmentLine: {
      findMany: async () => [],
    },
    salesOrderRefundLine: {
      findMany: async ({ where }: { where: { refund: { orderId: string } } }) => refundLines
        .filter((refundLine) => refundLine.orderId === where.refund.orderId)
        .map((refundLine) => ({ salesOrderLineId: refundLine.salesOrderLineId, qty: refundLine.qty })),
    },
    // Cancelling retires the order's pending SALES_INVOICE accounting work in the same tx
    // (cancel-order-invoice-sync); these stubs let that run without a real accounting queue.
    accountingSyncLog: {
      updateMany: async () => ({ count: 0 }),
    },
    accountingEvent: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    accountingEventLog: {
      createMany: async () => ({ count: 0 }),
    },
  }

  return client as unknown as AllocationServiceClient
}

/** Postgres numeric(12,4) rounds half-up on write. The mock must do the same to stay faithful. */
function persistAllocationQty(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function baseState(overrides: Partial<MemoryState> = {}): MemoryState {
  const product = { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE' as const, oversellAllowed: false }
  return {
    order: {
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      shoppingLinks: [],
      status: 'PROCESSING',
      shipFromWarehouseId: null,
      inventoryAllocatedDate: null,
      lines: [{ id: 'line-1', productId: 'product-1', qty: 3, sku: 'SKU-1', description: 'Product 1', product }],
    },
    products: [product],
    warehouses: [{
      id: 'warehouse-1',
      code: 'MAIN',
      name: 'Main',
      active: true,
      availableForSale: true,
      isDefault: true,
      syncToStore: false,
    }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 0 }],
    allocations: [],
    shipments: [],
    refundLines: [],
    ...overrides,
  }
}

test('allocateSalesOrder excludes refunded quantity from demand', async () => {
  // Line qty 3, 2 already refunded → only 1 unit remains to allocate.
  const state = baseState({ refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', qty: 2 }] })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 1,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 1)
})

test('allocateSalesOrder creates no allocation when the whole line is refunded', async () => {
  const state = baseState({ refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', qty: 3 }] })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.allocationCount, 0)
  assert.deepEqual(state.allocations, [])
})

test('allocateSalesOrder allocates available stock and advances order status', async () => {
  const state = baseState()
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.deepEqual(result.unallocatedLines, [])
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 3,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 3)
  assert.equal(state.order.status, 'ALLOCATED')
})

test('allocateSalesOrder returns a no-stock result without creating allocations', async () => {
  const state = baseState({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 0 }],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, false)
  assert.equal(result.error, 'No stock available for allocation')
  assert.equal(result.allocationCount, 0)
  assert.equal(result.unallocatedQty, 3)
  assert.equal(result.unallocatedLines[0]?.backorderEligible, false)
  assert.deepEqual(state.allocations, [])
  assert.equal(state.order.status, 'PROCESSING')
})

test('allocateSalesOrder accepts oversell demand without creating phantom reservations', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 3,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true },
      }],
    },
    products: [{ id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 0 }],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 0)
  assert.equal(result.unallocatedQty, 3)
  assert.equal(result.backorderLineCount, 1)
  assert.equal(result.unallocatedLines[0]?.backorderEligible, true)
  assert.deepEqual(state.allocations, [])
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(state.order.status, 'PROCESSING')
})

test('allocateSalesOrder reserves only physical stock and reports oversell remainder', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 3,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true },
      }],
    },
    products: [{ id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 }],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.equal(result.unallocatedQty, 1)
  assert.equal(result.unallocatedLines[0]?.allocatedQty, 2)
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 2,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.order.status, 'ALLOCATED')
})

test('allocateSalesOrder reports failure when any short line is not oversell eligible', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [
        {
          id: 'line-1',
          productId: 'product-1',
          qty: 5,
          sku: 'SKU-1',
          description: 'Product 1',
          product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: false },
        },
        {
          id: 'line-2',
          productId: 'product-2',
          qty: 3,
          sku: 'SKU-2',
          description: 'Product 2',
          product: { id: 'product-2', sku: 'SKU-2', type: 'SIMPLE', oversellAllowed: true },
        },
      ],
    },
    products: [
      { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: false },
      { id: 'product-2', sku: 'SKU-2', type: 'SIMPLE', oversellAllowed: true },
    ],
    stockLevels: [
      { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 },
      { productId: 'product-2', warehouseId: 'warehouse-1', quantity: 0, reservedQty: 0 },
    ],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Some lines could not be fully allocated and are not oversell-eligible')
  assert.equal(result.allocationCount, 1)
  assert.deepEqual(
    result.unallocatedLines.map((line) => [line.lineId, line.unallocatedQty, line.backorderEligible]),
    [
      ['line-1', 3, false],
      ['line-2', 3, true],
    ],
  )
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 2,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 2)
})

test('allocateSalesOrder expands kit lines into component allocations', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'kit-1',
        qty: 2,
        sku: 'KIT-1',
        description: 'Kit 1',
        product: { id: 'kit-1', sku: 'KIT-1', type: 'KIT', oversellAllowed: false },
      }],
    },
    products: [{
      id: 'kit-1',
      type: 'KIT',
      productComponents: [
        { componentId: 'component-1', qty: 2, componentType: 'SIMPLE' },
        { componentId: 'component-2', qty: 1, componentType: 'SIMPLE' },
      ],
    }],
    stockLevels: [
      { productId: 'component-1', warehouseId: 'warehouse-1', quantity: 4, reservedQty: 0 },
      { productId: 'component-2', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 },
    ],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 2)
  assert.deepEqual(state.allocations, [
    { orderId: 'order-1', lineId: 'line-1', productId: 'component-1', warehouseId: 'warehouse-1', qty: 4 },
    { orderId: 'order-1', lineId: 'line-1', productId: 'component-2', warehouseId: 'warehouse-1', qty: 2 },
  ])
  assert.deepEqual(state.stockLevels.map((row) => [row.productId, row.reservedQty]), [
    ['component-1', 4],
    ['component-2', 2],
  ])
})

test('allocateSalesOrder preserves fractional kit component quantities without float drift', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'kit-1',
        qty: 0.2,
        sku: 'KIT-1',
        description: 'Kit 1',
        product: { id: 'kit-1', sku: 'KIT-1', type: 'KIT', oversellAllowed: false },
      }],
    },
    products: [{
      id: 'kit-1',
      type: 'KIT',
      productComponents: [
        { componentId: 'component-1', qty: 0.1, componentType: 'SIMPLE' },
      ],
    }],
    stockLevels: [
      { productId: 'component-1', warehouseId: 'warehouse-1', quantity: 0.02, reservedQty: 0 },
    ],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.equal(state.allocations?.[0]?.qty, 0.02)
  assert.equal(state.stockLevels[0].reservedQty, 0.02)
})

test('Decimal fulfillment helpers preserve repeated fractional component sums', () => {
  const graph: Map<string, FulfillmentGraphNode> = new Map([
    ['kit-1', {
      id: 'kit-1',
      type: 'KIT',
      productComponents: Array.from({ length: 100 }, (_, index) => ({
        componentId: 'component-1',
        componentSku: `COMP-${index}`,
        qty: toDecimal('0.1'),
        componentType: 'SIMPLE',
        componentOversellAllowed: false,
      })),
    }],
  ])

  const requirements = expandFulfillmentRequirementsDecimal('kit-1', 1, graph)

  assert.equal(requirements.get('component-1')?.toString(), '10')
})

test('Decimal fulfillment availability preserves fractional kit component coverage', () => {
  const graph: Map<string, FulfillmentGraphNode> = new Map([
    ['kit-1', {
      id: 'kit-1',
      type: 'KIT',
      productComponents: [{
        componentId: 'component-1',
        componentSku: 'COMP-1',
        qty: toDecimal('0.1'),
        componentType: 'SIMPLE',
        componentOversellAllowed: false,
      }],
    }],
  ])
  const stockMap = buildAvailableStockMap([
    { productId: 'component-1', warehouseId: 'warehouse-1', quantity: 0.02, reservedQty: 0 },
  ])

  const available = getFulfillmentAvailableQtyDecimal('kit-1', 'warehouse-1', graph, stockMap)

  assert.equal(available.toString(), '0.2')
})

test('allocateSalesOrder exposes non-oversell kit component blockers in unallocated metadata', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'kit-1',
        qty: 2,
        sku: 'KIT-1',
        description: 'Kit 1',
        product: { id: 'kit-1', sku: 'KIT-1', type: 'KIT', oversellAllowed: true },
      }],
    },
    products: [{
      id: 'kit-1',
      sku: 'KIT-1',
      type: 'KIT',
      oversellAllowed: true,
      productComponents: [
        {
          componentId: 'component-1',
          componentSku: 'COMP-1',
          qty: 2,
          componentType: 'SIMPLE',
          componentOversellAllowed: false,
        },
        {
          componentId: 'component-2',
          componentSku: 'COMP-2',
          qty: 1,
          componentType: 'SIMPLE',
          componentOversellAllowed: true,
        },
      ],
    }],
    stockLevels: [
      { productId: 'component-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 },
      { productId: 'component-2', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 },
    ],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.unallocatedQty, 1)
  assert.deepEqual(result.unallocatedLines[0]?.componentBlockers, ['COMP-1'])
})

test('allocateSalesOrder preserves this order own reservations when reallocating', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 2,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: false },
      }],
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
    }],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 2,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 2)
})

test('allocateSalesOrder caps legacy own over-reservations to physical stock', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 5,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true },
      }],
    },
    products: [{ id: 'product-1', sku: 'SKU-1', type: 'SIMPLE', oversellAllowed: true }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 5 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 5,
    }],
  })
  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.equal(result.unallocatedQty, 3)
  assert.deepEqual(state.allocations, [{
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 2,
  }])
  assert.equal(state.stockLevels[0].reservedQty, 2)
})

test('buildAvailableStockMapIncludingOwnReservations warns when own allocations exceed reserved stock', () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message?: unknown) => {
    warnings.push(String(message))
  }
  try {
    const stockMap = buildAvailableStockMapIncludingOwnReservations(
      [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 1 }],
      [{ productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    )
    assert.equal(stockMap.get('product-1')?.get('warehouse-1')?.toNumber(), 5)
    assert.match(warnings[0] ?? '', /own allocations exceed reserved stock/)
  } finally {
    console.warn = originalWarn
  }
})

test('allocateSalesOrder refuses to rebuild allocations when guarded shipments exist', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', shipmentJournalDate: null }],
  })
  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    refuseIfShipmentsExist: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'Order has existing shipments; reallocation refused')
  assert.deepEqual(state.allocations, [])
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(state.order.status, 'PROCESSING')
})

test('onReconciledInTx runs on the committed path (atomic backstop resolve) — o3d-67y r11', async () => {
  const state = baseState()
  let calls = 0
  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    onReconciledInTx: async () => { calls++ },
  })
  assert.equal(result.success, true)
  assert.equal(calls, 1, 'the in-tx resolve hook fires exactly once when allocation commits')
})

test('onReconciledInTx does NOT run on the refused path — the backstop stays pending for the drain (o3d-67y r11)', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', shipmentJournalDate: null }],
  })
  let calls = 0
  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    refuseIfShipmentsExist: true,
    onReconciledInTx: async () => { calls++ },
  })
  assert.equal(result.success, false)
  assert.equal(calls, 0, 'a refuse must not resolve the backstop')
})

test('allocateSalesOrder blocks allocation edits after shipment accounting is journaled', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    },
    shipments: [{ id: 'shipment-1', orderId: 'order-1', shipmentJournalDate: new Date('2026-01-02T00:00:00Z') }],
  })

  await assert.rejects(
    () => allocateSalesOrder(createClient(state), { orderId: 'order-1' }),
    /Cannot modify allocations after shipments have been posted to accounting/,
  )
  assert.deepEqual(state.allocations, [])
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(state.order.status, 'PROCESSING')
})

test('assertReservationReleaseDelta verifies exact per-scope reservation release', () => {
  assert.doesNotThrow(() => assertReservationReleaseDelta(
    [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: 5 }],
    [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: 3 }],
    [{ productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
  ))

  assert.throws(
    () => assertReservationReleaseDelta(
      [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: 5 }],
      [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: 4 }],
      [{ productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    ),
    /Reservation release invariant failed/,
  )

  assert.throws(
    () => assertReservationReleaseDelta(
      [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: 1 }],
      [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: -1 }],
      [{ productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    ),
    /reservedQty drifted below allocation/,
  )
})

test('cancelSalesOrderFulfillmentState aggregates multi-scope reservation release deltas', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
    },
    stockLevels: [
      { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 7 },
      { productId: 'product-b', warehouseId: 'warehouse-1', quantity: 20, reservedQty: 3 },
      { productId: 'product-a', warehouseId: 'warehouse-2', quantity: 20, reservedQty: 2 },
    ],
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'product-a', warehouseId: 'warehouse-1', qty: 2 },
      { orderId: 'order-1', lineId: 'line-2', productId: 'product-a', warehouseId: 'warehouse-1', qty: 3 },
      { orderId: 'order-1', lineId: 'line-3', productId: 'product-b', warehouseId: 'warehouse-1', qty: 3 },
      { orderId: 'order-1', lineId: 'line-4', productId: 'product-a', warehouseId: 'warehouse-2', qty: 2 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', status: 'PICKING', shipmentJournalDate: null }],
  })
  const client = createClient(state)

  const result = await cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' })

  assert.equal(result.previousStatus, 'ALLOCATED')
  assert.equal(result.releasedAllocationCount, 4)
  assert.equal(result.deletedShipmentCount, 1)
  assert.equal(state.order.status, 'CANCELLED')
  assert.deepEqual(state.allocations, [])
  assert.deepEqual(state.shipments, [])
  assert.deepEqual(state.stockLevels.map((row) => [row.productId, row.warehouseId, row.reservedQty]), [
    ['product-a', 'warehouse-1', 2],
    ['product-b', 'warehouse-1', 0],
    ['product-a', 'warehouse-2', 0],
  ])
})

test('cancelSalesOrderFulfillmentState refuses a partially-shipped order with a journaled shipment', async () => {
  const state = baseState({
    order: { ...baseState().order, status: 'ALLOCATED' },
    // A2 never ran (no inventoryAllocatedDate) but a partial shipment was
    // dispatched and posted to accounting — cancelling would orphan its COGS.
    shipments: [{ id: 'shipment-1', orderId: 'order-1', status: 'SHIPPED', shipmentJournalDate: new Date('2026-06-01T00:00:00.000Z') }],
  })
  const client = createClient(state)

  await assert.rejects(
    () => cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' }),
    /Cannot cancel an order with a dispatched shipment/,
  )
  assert.equal(state.order.status, 'ALLOCATED')
})

test('a SHIPPED order WITH a dispatched shipment refuses PERMANENTLY', async () => {
  // Goods actually left, so this refusal can never become valid — the webhook may acknowledge it.
  const state = baseState({
    order: { ...baseState().order, status: 'SHIPPED' },
    shipments: [{ id: 'shipment-1', orderId: 'order-1', status: 'SHIPPED', shipmentJournalDate: null }],
  })
  const client = createClient(state)

  const error = await cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' }).catch((e) => e)
  assert.match(String(error?.message), /Cannot cancel a shipped order/)
  assert.equal(isPermanentStatusTransitionError(error), true)
})

test('a FALSE-SHIPPED order (no dispatch evidence) is REPAIRED and cancelled, not refused (o3d-gz6)', async () => {
  // SalesOrder.status alone is not proof of dispatch: importWcOrder writes the configurable WooCommerce
  // status mapping straight into it, so a store can map a status to SHIPPED on an order that has no
  // shipment at all. Rather than refuse the Woo cancellation forever (it exhausted its retries and
  // dead-lettered), repair the unreliable status to its pre-ship state and let the cancel release
  // fulfilment and reach CANCELLED.
  const state = baseState({
    order: { ...baseState().order, status: 'SHIPPED' },
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    shipments: [],
  })
  const client = createClient(state)

  const result = await cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' })

  assert.equal(result.repairedFalseShipped, true, 'the false-SHIPPED anomaly is flagged for audit')
  assert.equal(result.previousStatus, 'SHIPPED')
  assert.equal(result.releasedAllocationCount, 1)
  assert.equal(state.order.status, 'CANCELLED', 'the cancel now completes instead of dead-lettering')
  assert.equal(state.stockLevels[0].reservedQty, 0, 'reservations are released')
})

test('a FALSE-SHIPPED order with no allocations still cancels (repairs to PROCESSING) (o3d-gz6)', async () => {
  const state = baseState({
    order: { ...baseState().order, status: 'SHIPPED' },
    allocations: [],
    shipments: [],
  })
  const client = createClient(state)

  const result = await cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' })
  assert.equal(result.repairedFalseShipped, true)
  assert.equal(state.order.status, 'CANCELLED')
})

test('updateSalesOrderStatusUnderLock refuses PICKING when allocations disappeared before locked update', async () => {
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
    },
    allocations: [],
  })
  const client = createClient(state)

  await assert.rejects(
    () => updateSalesOrderStatusUnderLock(client as never, {
      orderId: 'order-1',
      targetStatus: 'PICKING',
      beforeUpdate: async ({ tx }) => {
        const allocCount = await tx.orderAllocation.count({ where: { orderId: 'order-1' } })
        if (allocCount === 0) {
          throw new Error('Cannot start picking — no products have been allocated. Allocate stock first.')
        }
      },
    }),
    /Cannot start picking/,
  )
  assert.equal(state.order.status, 'ALLOCATED')
})

// --- concurrency: the payment path can advance an order that is then cancelled/held before the
// allocation row lock. The under-lock status must decide, not the stale pre-lock read (o3d-2s8). ---

/** Model a concurrent status change that committed between the pre-lock read and the row lock: the
 *  order's REAL (stored) status is already the new value, but the pre-lock `so` read (many-field
 *  select) still returns the stale value. The under-lock read (select: { status }) stays truthful. If
 *  the fix works, decisions use the real status, not the stale one. */
function withStalePreLockStatus(state: MemoryState, staleStatus: string): AllocationServiceClient {
  const client = createClient(state) as unknown as {
    salesOrder: { findUnique: (a: { select?: Record<string, unknown> }) => Promise<{ status: string } | null> }
  }
  const real = client.salesOrder.findUnique
  client.salesOrder.findUnique = async (args) => {
    const row = await real(args)
    if (!row) return row
    const sel = args?.select ?? {}
    // Only the big pre-lock `so` read is stale. The under-lock read selects status (+refundStatus)
    // and the reset read selects inventoryAllocatedDate; leave both truthful.
    const isUnderLockRead = 'status' in sel && !('lines' in sel)
    const isResetRead = 'inventoryAllocatedDate' in sel
    if (!isUnderLockRead && !isResetRead) row.status = staleStatus
    return row
  }
  return client as unknown as AllocationServiceClient
}

test('allocateSalesOrder on a CANCELLED order deallocates (releases, no reserve, stays CANCELLED)', async () => {
  // A cancelled order must hold no reservations. Allocation becomes pure deallocation — NOT a refusal
  // that would strand its existing allocations.
  const state = baseState({
    order: { ...baseState().order, status: 'CANCELLED' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
  })
  await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(state.allocations, [], 'existing allocations released and deleted')
  assert.equal(state.stockLevels[0].reservedQty, 0, 'reservations released')
  assert.equal(state.order.status, 'CANCELLED', 'not resumed to ALLOCATED')
})

test('allocateSalesOrder does NOT resume a held order (PROCESSING→ON_HOLD committed before the lock)', async () => {
  // Real status is ON_HOLD; the stale pre-lock read still says PROCESSING. Off the stale value the
  // code would promote to ALLOCATED — the fix uses the under-lock ON_HOLD and does not.
  const state = baseState({ order: { ...baseState().order, status: 'ON_HOLD' } })
  const client = withStalePreLockStatus(state, 'PROCESSING')

  await allocateSalesOrder(client, { orderId: 'order-1' })

  assert.equal(state.stockLevels[0].reservedQty, 3, 'stock still reserved for the held order')
  assert.equal(state.order.status, 'ON_HOLD', 'a held order is NOT promoted to ALLOCATED off stale status')
})

test('allocateSalesOrder cancelled before the lock is a clean deallocation, not a stale resume', async () => {
  // Real status is CANCELLED; the stale pre-lock read says PROCESSING.
  const state = baseState({
    order: { ...baseState().order, status: 'CANCELLED' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
  })
  const client = withStalePreLockStatus(state, 'PROCESSING')

  await allocateSalesOrder(client, { orderId: 'order-1' })

  assert.deepEqual(state.allocations, [], 'released and deleted, not re-reserved')
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(state.order.status, 'CANCELLED', 'not resumed to ALLOCATED off the stale PROCESSING read')
})

test('allocateSalesOrder on a fully-refunded order (refundStatus=FULL) deallocates, even at full monetary refund with non-zero line qty', async () => {
  // FULL is a MONETARY classification: a full-value refund can leave product quantities unrefunded
  // (amount-only/shipping refund). Line demand would be non-zero, but the order must hold no
  // reservations — so FULL is zero-demand under the lock, not a re-reservation.
  const state = baseState({
    order: { ...baseState().order, status: 'PROCESSING', refundStatus: 'FULL' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
    // No refundLines — models a full monetary refund that did NOT refund product quantity.
  })
  await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(state.allocations, [], 'reservations released and allocations deleted')
  assert.equal(state.stockLevels[0].reservedQty, 0, 'no stock reserved for a fully-refunded order')
  assert.notEqual(state.order.status, 'ALLOCATED', 'a fully-refunded order is not promoted/fulfilled')
})

// --- o3d-6ab: under-lock ELIGIBILITY guard. The tests above prove the order's OWN state is
// revalidated under the lock (CANCELLED/FULL refund). These prove the CALLER'S PREMISE is too: batch
// callers select candidates by status outside the lock, and by the time the lock is granted the order
// may no longer want allocating at all. requireStatusUnderLock makes that an explicit no-op. ---

const BATCH_ELIGIBLE = ['PROCESSING', 'ALLOCATED'] as const

test('o3d-6ab: PROCESSING→ON_HOLD between selection and the lock is an explicit no-op, not a re-reservation', async () => {
  // The exact race: the caller selected this order while it was PROCESSING; ON_HOLD committed before
  // the lock was granted. Without the guard the release/delete/recreate below still runs and re-reserves
  // stock for a held order (that is what the older "does NOT resume a held order" test documents —
  // it asserts reservedQty 3). With the guard the whole transaction is a no-op.
  const state = baseState({ order: { ...baseState().order, status: 'ON_HOLD' } })
  const client = withStalePreLockStatus(state, 'PROCESSING')

  const result = await allocateSalesOrder(client, {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, true, 'reported as an explicit skip')
  assert.equal(result.skippedStatus, 'ON_HOLD', 'reports the under-lock status that caused the skip')
  assert.equal(result.error, undefined, 'a stale premise is NOT an error — callers must not log a failure')
  assert.equal(result.allocationCount, 0)
  assert.equal(state.stockLevels[0].reservedQty, 0, 'no stock reserved for the held order')
  assert.deepEqual(state.allocations, [], 'no allocation rows created')
  assert.equal(state.order.status, 'ON_HOLD', 'status untouched')
})

test('o3d-6ab: a skip leaves EXISTING allocations and reservations completely untouched', async () => {
  // The no-op must be total: it must not release-and-delete either. The held order keeps whatever it
  // already held until whoever held it decides otherwise.
  const state = baseState({
    order: { ...baseState().order, status: 'ON_HOLD' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
  })

  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, true)
  assert.equal(state.stockLevels[0].reservedQty, 3, 'existing reservation NOT released')
  assert.equal(state.allocations?.length, 1, 'existing allocation rows NOT deleted/recreated')
})

test('o3d-6ab: an order that already advanced past PROCESSING (→PICKING) is skipped', async () => {
  // Not just ON_HOLD: anything the caller did not select for. A picker is working the order; rebuilding
  // its allocation under them would churn rows that the pick is already based on.
  const state = baseState({ order: { ...baseState().order, status: 'PICKING' } })
  const client = withStalePreLockStatus(state, 'PROCESSING')

  const result = await allocateSalesOrder(client, {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, true)
  assert.equal(result.skippedStatus, 'PICKING')
  assert.equal(state.stockLevels[0].reservedQty, 0, 'no re-reservation under the picker')
})

test('o3d-6ab: a still-eligible order allocates normally with the guard set', async () => {
  // The guard must not break the common case it is wrapping.
  const state = baseState()
  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, undefined, 'not skipped')
  assert.equal(result.success, true)
  assert.equal(result.allocationCount, 1)
  assert.equal(state.stockLevels[0].reservedQty, 3)
  assert.equal(state.order.status, 'ALLOCATED')
})

test('o3d-6ab: without requireStatusUnderLock the guard is inert (existing callers unchanged)', async () => {
  // Opt-in only. User/event-driven callers allocate a specific order on purpose and must keep the
  // pre-existing behaviour, including on a held order.
  const state = baseState({ order: { ...baseState().order, status: 'ON_HOLD' } })

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.skipped, undefined)
  assert.equal(state.stockLevels[0].reservedQty, 3, 'unchanged pre-o3d-6ab behaviour')
})

test('o3d-6ab: the guard does NOT suppress the CANCELLED deallocation', async () => {
  // CANCELLED is not in the eligible set, but it takes the zero-demand path, which RELEASES. Turning
  // that into a no-op would strand reservations on a cancelled order — strictly worse than the bug.
  const state = baseState({
    order: { ...baseState().order, status: 'CANCELLED' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
  })

  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, undefined, 'deallocation is not skipped')
  assert.deepEqual(state.allocations, [], 'released and deleted')
  assert.equal(state.stockLevels[0].reservedQty, 0)
})

test('o3d-6ab: the guard does NOT suppress the fully-refunded (refundStatus=FULL) deallocation on a HELD order', async () => {
  // Both conditions at once: an ineligible status AND zero monetary demand. Release still wins.
  const state = baseState({
    order: { ...baseState().order, status: 'ON_HOLD', refundStatus: 'FULL' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
  })

  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.skipped, undefined)
  assert.deepEqual(state.allocations, [], 'a fully-refunded held order still releases')
  assert.equal(state.stockLevels[0].reservedQty, 0)
})

test('o3d-6ab: refuseIfShipmentsExist still wins over the guard and reports the refusal', async () => {
  // Both guards are opt-in and both are no-ops; the shipment refusal is the one that carries an error
  // string the batch callers already treat as benign, so it must not be masked by a skip.
  const state = baseState({
    order: { ...baseState().order, status: 'ON_HOLD' },
    shipments: [{ id: 'shipment-1', orderId: 'order-1', status: 'PENDING', shipmentJournalDate: null }],
  })

  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    refuseIfShipmentsExist: true,
    requireStatusUnderLock: BATCH_ELIGIBLE,
  })

  assert.equal(result.refused, true)
  assert.equal(result.skipped, undefined)
  assert.equal(result.error, 'Order has existing shipments; reallocation refused')
})

test('o3d-6ab: onReconciledInTx does NOT run on a skipped allocation (backstop stays pending)', async () => {
  // A skip commits nothing, so a durable backstop must NOT be marked resolved — it has to retry once
  // the order is eligible again.
  const state = baseState({ order: { ...baseState().order, status: 'ON_HOLD' } })
  let ran = false

  const result = await allocateSalesOrder(createClient(state), {
    orderId: 'order-1',
    requireStatusUnderLock: BATCH_ELIGIBLE,
    onReconciledInTx: async () => { ran = true },
  })

  assert.equal(result.skipped, true)
  assert.equal(ran, false, 'the backstop resolve did not run on the no-op path')
})

// ---------------------------------------------------------------------------
// o3d-i5it — re-allocating an UNCHANGED set must write nothing.
//
// The reset + release/delete/recreate/reserve cycle used to run unconditionally.
// With the o3d-9lx sweep rotating every 15 minutes over every order with
// outstanding demand — including permanent partial backorders that cannot improve —
// that meant destructively rewriting them forever. Clearing inventoryAllocatedDate
// and the cost snapshots on an already-processed Group A2 order lets the next daily
// batch post the SAME inventory reclassification again, and AccountingSyncLog has no
// uniqueness constraint that would stop the later-dated journal.
// ---------------------------------------------------------------------------

test('allocationSetsMatch: identical sets match regardless of row order (o3d-i5it)', () => {
  const persisted = [
    { lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) },
    { lineId: 'l2', productId: 'p2', warehouseId: 'w1', qty: toDecimal(3) },
  ]
  const computed = [
    { lineId: 'l2', productId: 'p2', warehouseId: 'w1', qty: toDecimal(3) },
    { lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) },
  ]
  assert.equal(allocationSetsMatch(persisted, computed), true)
})

test('allocationSetsMatch: a quantity difference is a change (o3d-i5it)', () => {
  const persisted = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) }]
  const computed = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(3) }]
  assert.equal(allocationSetsMatch(persisted, computed), false)
})

test('allocationSetsMatch: a different warehouse for the same line is a change (o3d-i5it)', () => {
  const persisted = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) }]
  const computed = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w2', qty: toDecimal(2) }]
  assert.equal(allocationSetsMatch(persisted, computed), false)
})

test('allocationSetsMatch: a differing row COUNT is a change in both directions (o3d-i5it)', () => {
  const one = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) }]
  const two = [
    { lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) },
    { lineId: 'l2', productId: 'p2', warehouseId: 'w1', qty: toDecimal(1) },
  ]
  assert.equal(allocationSetsMatch(one, two), false)
  assert.equal(allocationSetsMatch(two, one), false)
})

test('allocationSetsMatch: equal VALUE at different Decimal scale still matches (o3d-i5it)', () => {
  // OrderAllocation.qty persists at Decimal(12,4). A computed value that differs only in
  // representation must not read as a change, or the check never fires and the whole
  // short-circuit is dead code.
  const persisted = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal('2.0000') }]
  const computed = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) }]
  assert.equal(allocationSetsMatch(persisted, computed), true)
})

test('allocationSetsMatch: an empty set matches an empty set (o3d-i5it)', () => {
  // A zero-demand order that already has no allocations must not be rewritten either.
  assert.equal(allocationSetsMatch([], []), true)
})

test('allocationSetsMatch: duplicate persisted keys are never treated as canonical (o3d-i5it)', () => {
  // Two rows on the same (line, warehouse, product) is not a set mergeAllocationRows could
  // produce. Treating it as a match would leave corrupt data in place forever, so it must
  // report a change and let the rewrite normalise it.
  const persisted = [
    { lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(1) },
    { lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(1) },
  ]
  const computed = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal(2) }]
  assert.equal(allocationSetsMatch(persisted, computed), false)
})

test('re-allocating an unchanged set preserves accounting state and emits no syncs (o3d-i5it)', async () => {
  // A partial backorder that is already fully allocated for the stock that exists: line qty 3,
  // only 2 units on hand, 2 already allocated and reserved, and Group A2 has already stamped
  // inventoryAllocatedDate. The sweep re-runs this every 15 minutes and can never improve it.
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
    }],
  })
  const before = {
    allocations: (state.allocations ?? []).map((row) => ({ ...row })),
    reservedQty: state.stockLevels[0].reservedQty,
    inventoryAllocatedDate: state.order.inventoryAllocatedDate,
  }

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  // The report is still faithful: 2 of 3 allocated, 1 outstanding.
  assert.equal(result.allocationCount, 1, 'one allocation row')
  assert.deepEqual(state.allocations, before.allocations, 'allocations untouched')
  assert.equal(state.stockLevels[0].reservedQty, before.reservedQty, 'no reservation churn')
  assert.equal(
    state.order.inventoryAllocatedDate,
    before.inventoryAllocatedDate,
    'inventoryAllocatedDate must SURVIVE — clearing it lets the daily batch re-post the same A2 journal',
  )
  assert.deepEqual(result.syncProductIds, [], 'nothing moved, so nothing to push to the storefront')
  // Row VALUES being equal is not evidence: a delete+recreate leaves them identical. The write
  // counters are what prove the destructive cycle was skipped rather than repeated.
  assert.equal(writeCounts.allocationDeletes, 0, 'no deleteMany')
  assert.equal(writeCounts.allocationCreates, 0, 'no re-create')
})

test('a genuine allocation change still resets accounting state (o3d-i5it)', async () => {
  // The other side of the same line: more stock has arrived, so the set really does change and
  // the reset must still run. Skipping it here would leave a stale A2 stamp against new numbers.
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 2 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
    }],
  })

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(state.allocations?.[0].qty, 3, 'the extra unit was allocated')
  assert.equal(state.order.inventoryAllocatedDate, null, 'a real change still resets the A2 stamp')
  assert.ok(result.syncProductIds.includes('product-1'), 'and still pushes the storefront update')
  assert.ok(writeCounts.allocationDeletes > 0, 'and the destructive cycle DID run for a real change')
  assert.ok(writeCounts.allocationCreates > 0)
})

test('an unchanged set is not refused even when a shipment has been journaled (o3d-i5it)', async () => {
  // resetAllocationAccountingIfStaged throws once a shipment is posted to accounting. That guard
  // exists to refuse MODIFYING allocations — so with nothing to modify there is nothing to refuse.
  // Previously the sweep hit this on every rotation and counted it as an error forever.
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
    }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', shipmentJournalDate: new Date('2026-01-02T00:00:00Z') }],
  })

  await assert.doesNotReject(() => allocateSalesOrder(createClient(state), { orderId: 'order-1' }))
  assert.equal(state.order.inventoryAllocatedDate?.toISOString(), '2026-01-01T00:00:00.000Z')
})

test('allocationSetsMatch compares EXACTLY and absorbs no scale mismatch (o3d-i4qd)', () => {
  // The helper must not paper over a value the column cannot represent. Comparing at one scale
  // while reservations move at another is what made an earlier version of this check unreliable.
  // The consequence is deliberate: a nested-KIT quantity reports as a CHANGE and the short-circuit
  // does not fire for it, which is the pre-existing behaviour tracked as o3d-i4qd — the fix
  // belongs in how the set is canonicalised, not in loosening this comparison.
  const persisted = [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal('0.1110') }]

  assert.equal(
    allocationSetsMatch(persisted, [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal('0.1110') }]),
    true,
    'equal canonical values match',
  )
  assert.equal(
    allocationSetsMatch(persisted, [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal('0.11102224') }]),
    false,
    'a value the column cannot represent exactly is NOT silently treated as equal',
  )
  assert.equal(
    allocationSetsMatch(persisted, [{ lineId: 'l1', productId: 'p1', warehouseId: 'w1', qty: toDecimal('0.1112') }]),
    false,
    'and a real difference at the persisted scale is still a change',
  )
})

test('the persisted allocation and the reservation move by the same amount', async () => {
  // Reserve and release must agree, or reservedQty drifts. NOTE this double does not model the
  // column's 4dp rounding, so it cannot reproduce the real o3d-i4qd drift (reserve writes the
  // unrounded value, the row stores 4dp, and the later release reads the ROW). It pins the
  // in-memory symmetry only; the persisted-scale half needs a real database.
  const state = baseState({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 0 }],
  })

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  const allocatedTotal = (state.allocations ?? []).reduce((sum, row) => sum + Number(row.qty), 0)
  assert.equal(
    state.stockLevels[0].reservedQty,
    allocatedTotal,
    'reservedQty must equal the sum of the persisted allocation rows, not an unrounded intermediate',
  )
})

test('re-running that same allocation is a no-op and does not move reservedQty (o3d-i4qd)', async () => {
  const state = baseState({
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 0 }],
  })

  await allocateSalesOrder(createClient(state), { orderId: 'order-1' })
  const afterFirst = state.stockLevels[0].reservedQty
  const rowsAfterFirst = (state.allocations ?? []).map((row) => ({ ...row }))

  await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(state.stockLevels[0].reservedQty, afterFirst, 'no reservation drift across cycles')
  assert.deepEqual(state.allocations, rowsAfterFirst, 'same rows')
  assert.equal(writeCounts.allocationDeletes, 0, 'and genuinely no rewrite — not a delete+recreate')
  assert.equal(writeCounts.allocationCreates, 0)
})

test('KNOWN DEFECT o3d-i4qd: the persisted quantity can exceed the stock it was checked against', async () => {
  // CHARACTERISATION, not an invariant. Feasibility is decided against the UNROUNDED value, but
  // OrderAllocation.qty is @db.Decimal(12,4) and Postgres rounds HALF-UP on write. With 0.999960
  // available the allocator accepts 0.999960 and the column stores 1.0000 — more than was proven
  // available, which against the real database violates reservedQty <= quantity.
  //
  // This is pinned rather than asserted away because three attempts to canonicalise it all broke
  // something worse (see o3d-i4qd: over-claiming, then KIT proportionality). When that issue is
  // fixed this test SHOULD fail, and whoever fixes it should replace it with the invariant.
  const state = baseState({
    order: {
      ...baseState().order,
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 1,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE' as const, oversellAllowed: false },
      }],
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0.99996, reservedQty: 0 }],
  })

  await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  const persisted = (state.allocations ?? []).reduce((sum, row) => sum + Number(row.qty), 0)
  assert.equal(persisted, 1, 'the column rounds 0.999960 up to 1.0000 — the defect, documented')
  assert.ok(persisted > 0.99996, 'and that exceeds the 0.99996 the allocator checked against')
})

// ---------------------------------------------------------------------------
// o3d-4kfh — allocation-row equality is not evidence the RESERVATIONS are right.
// ---------------------------------------------------------------------------

test('findUnderReservedScopes flags a scope whose reservedQty is below the order own rows (o3d-4kfh)', () => {
  const scopes = findUnderReservedScopes(
    [{ productId: 'p1', warehouseId: 'w1', reservedQty: 0 }],
    [{ productId: 'p1', warehouseId: 'w1', qty: 2 }],
  )
  assert.deepEqual(scopes, [{ productId: 'p1', warehouseId: 'w1' }])
})

test('findUnderReservedScopes ignores a consistent scope, and one this order does not touch (o3d-4kfh)', () => {
  assert.deepEqual(
    findUnderReservedScopes(
      [{ productId: 'p1', warehouseId: 'w1', reservedQty: 2 }],
      [{ productId: 'p1', warehouseId: 'w1', qty: 2 }],
    ),
    [],
    'reserved exactly covers the rows',
  )
  assert.deepEqual(
    findUnderReservedScopes(
      [{ productId: 'p9', warehouseId: 'w1', reservedQty: 0 }],
      [{ productId: 'p1', warehouseId: 'w1', qty: 2 }],
    ),
    [],
    'a scope with none of this order\'s allocations is not its problem',
  )
})

test('findUnderReservedScopes tolerates float noise rather than flagging it (o3d-4kfh)', () => {
  // reservedQty carries 6dp; a sub-epsilon difference is representation, not a real shortfall,
  // and flagging it would force a rewrite on every cycle — reintroducing the churn o3d-i5it fixed.
  assert.deepEqual(
    findUnderReservedScopes(
      [{ productId: 'p1', warehouseId: 'w1', reservedQty: 1.999999 }],
      [{ productId: 'p1', warehouseId: 'w1', qty: 2 }],
    ),
    [],
  )
})

test('an UNDER-RESERVED order is REPORTED, and the rewrite would not have repaired it (o3d-4kfh)', async () => {
  // I first assumed the unconditional cycle repaired this as a side effect, so skipping it was a
  // regression. It does not. The cycle releases this order's own quantity and reserves the same
  // quantity back — release 2 from a reservedQty of 0, re-reserve 2, and you are exactly where
  // you started. Forcing a rewrite here would reintroduce the churn o3d-i5it removed and fix
  // nothing, so the condition is reported loudly instead.
  //
  // Line 2, stock 2, allocated 2 — the computed set is IDENTICAL, so only reservedQty is wrong.
  const state = baseState({
    order: {
      ...baseState().order,
      status: 'ALLOCATED',
      lines: [{
        id: 'line-1',
        productId: 'product-1',
        qty: 2,
        sku: 'SKU-1',
        description: 'Product 1',
        product: { id: 'product-1', sku: 'SKU-1', type: 'SIMPLE' as const, oversellAllowed: false },
      }],
    },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 0 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
    }],
  })

  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    await allocateSalesOrder(createClient(state), { orderId: 'order-1' })
  } finally {
    console.error = realError
  }

  assert.equal(errors.length, 1, 'the shortfall is reported')
  assert.match(errors[0], /reservedQty is BELOW/)
  assert.match(errors[0], /needs reservation reconciliation/)
  assert.equal(writeCounts.allocationDeletes, 0, 'and it does NOT trigger a pointless rewrite')
  assert.equal(
    state.stockLevels[0].reservedQty,
    0,
    'the shortfall persists — this documents that neither path repairs it, which is why o3d-4kfh stays open',
  )
})

// ---------------------------------------------------------------------------
// o3d-754w — a zeroDemand deallocation is a SUCCESS, not a backorder failure.
// ---------------------------------------------------------------------------

test('a CANCELLED order deallocates and reports success, not "No stock available" (o3d-754w)', async () => {
  // zeroDemand empties the allocation input, but the report used to reconstruct demand from
  // order qty minus only QUANTITY-linked refund lines. A cancelled order therefore kept its
  // original demand after a perfectly successful deallocation: every line read as unallocated,
  // and for a non-oversell product that made the whole call return success:false.
  const state = baseState({
    order: { ...baseState().order, status: 'CANCELLED' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 3,
    }],
  })

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true, 'deallocating a cancelled order is a success')
  assert.equal(result.error, undefined, 'and carries no error for callers to log')
  assert.deepEqual(result.unallocatedLines, [], 'nothing is outstanding on a cancelled order')
  assert.equal(result.unallocatedQty, 0)
  assert.deepEqual(state.allocations, [], 'the allocations were released')
  assert.equal(state.stockLevels[0].reservedQty, 0, 'and so was the reservation')
})

test('a FULL MONETARY refund deallocates and reports success too (o3d-754w)', async () => {
  // The harder half: refundStatus FULL with NO quantity-linked refund lines, so per-line netting
  // subtracts nothing. Only the zeroDemand short-circuit makes this report honestly.
  const state = baseState({
    order: { ...baseState().order, status: 'PROCESSING', refundStatus: 'FULL' },
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 3 }],
    allocations: [{
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 3,
    }],
    refundLines: [],
  })

  const result = await allocateSalesOrder(createClient(state), { orderId: 'order-1' })

  assert.equal(result.success, true)
  assert.notEqual(result.error, 'No stock available for allocation')
  assert.equal(result.unallocatedQty, 0)
  assert.deepEqual(state.allocations, [])
})

// ---------------------------------------------------------------------------
// o3d-0qoo — un-staging must clear the persisted batch reference TOGETHER with
// the stamp it pairs with, in the same update. inventoryAllocatedBatchRef holds
// the exact AccountingSyncLog.referenceId Group A2 staged the order into, and
// findSalesOrderDeleteBlocker matches on it independently of the stamp. A row
// left with a ref but no stamp is therefore blocked forever against a batch it
// is no longer part of, which is strictly worse than clearing both.
// ---------------------------------------------------------------------------

/** Minimal transaction double: records every salesOrder.update payload verbatim. */
function createResetTx(options: {
  inventoryAllocatedDate: Date | null
  journaledShipmentId?: string | null
}) {
  const salesOrderUpdates: Array<Record<string, unknown>> = []
  const allocationUpdates: Array<Record<string, unknown>> = []
  const tx = {
    salesOrder: {
      findUnique: async () => (
        options.inventoryAllocatedDate === null
          ? { inventoryAllocatedDate: null }
          : { inventoryAllocatedDate: options.inventoryAllocatedDate }
      ),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        salesOrderUpdates.push(data)
        return {}
      },
    },
    shipment: {
      findFirst: async () => (options.journaledShipmentId ? { id: options.journaledShipmentId } : null),
    },
    orderAllocation: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        allocationUpdates.push(data)
        return { count: 1 }
      },
    },
  }
  return { tx, salesOrderUpdates, allocationUpdates }
}

test('resetAllocationAccountingIfStaged clears inventoryAllocatedBatchRef in the same update as the stamp (o3d-0qoo)', async () => {
  const { tx, salesOrderUpdates, allocationUpdates } = createResetTx({
    inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
  })

  await resetAllocationAccountingIfStaged(
    tx as unknown as Parameters<typeof resetAllocationAccountingIfStaged>[0],
    'order-1',
  )

  assert.equal(salesOrderUpdates.length, 1, 'the un-stage is a single write, not a stamp write plus a ref write')
  // deepEqual, not a per-key lookup: it proves the key is PRESENT and null rather than merely
  // absent-and-therefore-undefined, which is what an omitted Prisma field would look like.
  assert.deepEqual(salesOrderUpdates[0], {
    inventoryAllocatedDate: null,
    inventoryAllocatedBatchRef: null,
    allocationBatchAmount: null,
  })
  assert.equal(allocationUpdates.length, 1, 'and the cost snapshots are still nulled alongside it')
})

test('resetAllocationAccountingIfStaged writes nothing when A2 never staged the order (o3d-0qoo)', async () => {
  // The no-op path must stay a no-op: an unstaged order has no ref to clear, and touching it
  // would be a write the surrounding allocation transaction does not expect.
  const { tx, salesOrderUpdates } = createResetTx({ inventoryAllocatedDate: null })

  await resetAllocationAccountingIfStaged(
    tx as unknown as Parameters<typeof resetAllocationAccountingIfStaged>[0],
    'order-1',
  )

  assert.deepEqual(salesOrderUpdates, [])
})

test('resetAllocationAccountingIfStaged refuses (and clears no ref) once a shipment is journaled (o3d-0qoo)', async () => {
  // The Group B guard runs BEFORE the un-stage, so a posted shipment leaves both the stamp and
  // the ref intact — the order stays findable against its A2 batch instead of silently losing it.
  const { tx, salesOrderUpdates } = createResetTx({
    inventoryAllocatedDate: new Date('2026-01-01T00:00:00Z'),
    journaledShipmentId: 'shipment-1',
  })

  await assert.rejects(
    () => resetAllocationAccountingIfStaged(
      tx as unknown as Parameters<typeof resetAllocationAccountingIfStaged>[0],
      'order-1',
    ),
    /posted to accounting/,
  )
  assert.deepEqual(salesOrderUpdates, [])
})
