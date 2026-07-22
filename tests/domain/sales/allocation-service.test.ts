import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocateSalesOrder,
  assertReservationReleaseDelta,
  buildAvailableStockMapIncludingOwnReservations,
  buildAvailableStockMap,
  cancelSalesOrderFulfillmentState,
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

function createClient(state: MemoryState): AllocationServiceClient {
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
      update: async ({ data }: { data: { status?: string } }) => {
        if (data.status) state.order.status = data.status
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
        const before = allocations.length
        for (let index = allocations.length - 1; index >= 0; index -= 1) {
          if (allocations[index].orderId === where.orderId) allocations.splice(index, 1)
        }
        return { count: before - allocations.length }
      },
      create: async ({ data }: { data: AllocationRow & { qty: number | { toNumber(): number } } }) => {
        allocations.push({ ...data, qty: decimalLikeToNumber(data.qty) })
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

test('a SHIPPED order with NO dispatch evidence refuses TRANSIENTLY (o3d-bx9)', async () => {
  // SalesOrder.status alone is not proof of dispatch: importWcOrder writes the configurable WooCommerce
  // status mapping straight into it, so a store can map a status to SHIPPED on an order that has no
  // shipment at all. Acknowledging that would strand IMS as SHIPPED while Woo says CANCELLED, so it must
  // stay retryable — the mapping may yet be corrected.
  const state = baseState({
    order: { ...baseState().order, status: 'SHIPPED' },
    shipments: [],
  })
  const client = createClient(state)

  const error = await cancelSalesOrderFulfillmentState(client as never, { orderId: 'order-1' }).catch((e) => e)
  assert.match(String(error?.message), /Cannot cancel a shipped order/)
  assert.equal(isPermanentStatusTransitionError(error), false, 'no dispatch evidence => not terminal')
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
