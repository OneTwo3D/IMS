import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyReturnInboundStockTx,
  createSalesOrderRefund,
  type RefundServiceClient,
} from '@/lib/domain/sales/refund-service'
import type { AccountingSettings } from '@/lib/accounting'

type Order = {
  id: string
  externalOrderNumber: string | null
  orderNumber: string | null
  status: string
  fxRateToBase: number
  totalBase: number
  revenueDeferredDate: Date | null
  unearnedRevenueAmount: number | null
  inventoryAllocatedDate: Date | null
  allocationBatchAmount: number | null
}

type SalesLine = {
  id: string
  orderId: string
  productId: string | null
  description: string
  qty: number
  totalBase: number
}

type Refund = {
  id: string
  orderId: string
  creditNoteNumber: string | null
  externalRefundId: number | null
  reason: string | null
  totalForeign: number
  totalBase: number
  returnWarehouseId: string | null
}

type RefundLine = {
  id: string
  refundId: string
  productId: string | null
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  totalForeign: number
  totalBase: number
  costLayerSnapshot?: unknown
}

type State = {
  orders: Order[]
  lines: SalesLine[]
  refunds: Refund[]
  refundLines: RefundLine[]
  shipments: Array<{
    id: string
    orderId: string
    status: string
    shipmentJournalDate: Date | null
    revenueRecognizedAmount: number | null
    cogsBatchAmount: number | null
    lines: Array<{ id: string; lineId: string; qty: number; costLayerSnapshot: unknown }>
  }>
  allocations: Array<{ id: string; orderId: string; lineId: string; warehouseId: string; costLayerSnapshot: unknown }>
  costLayers: Array<{ id: string; productId: string; poLineId: string | null; receivedQty: number; unitCostBase: number }>
  movements: Array<{ productId: string; qty: number; referenceType: string; referenceId: string }>
  stockLevels: Array<{ productId: string; warehouseId: string; quantity: number; reservedQty: number }>
  settings: Record<string, string>
  nextRefundId: number
  nextRefundLineId: number
  nextCostLayerId: number
}

const accountingSettings: AccountingSettings = {
  syncEnabled: true,
  salesAccount: '4000',
  shippingAccount: '4010',
  discountAccount: '',
  cogsAccount: '5000',
  inventoryAccount: '1200',
  allocatedInventoryAccount: '1210',
  unearnedRevenueAccount: '2100',
  transitAccount: '',
  accountsReceivableAccount: '',
  accountsPayableAccount: '',
  realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '',
  manufacturingOverheadAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      totalBase: 100,
    }],
    refunds: [],
    refundLines: [],
    shipments: [],
    allocations: [],
    costLayers: [],
    movements: [],
    stockLevels: [],
    settings: {},
    nextRefundId: 1,
    nextRefundLineId: 1,
    nextCostLayerId: 1,
    ...overrides,
  }
}

function createClient(state: State): RefundServiceClient {
  const client = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = state.settings[where.key]
        return value == null ? null : { value }
      },
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        state.settings[where.key] = state.settings[where.key] == null ? create.value : update.value
      },
    },
    salesOrder: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) return null
        if (select.fxRateToBase) {
          return {
            ...order,
            lines: state.lines
              .filter((line) => line.orderId === order.id)
              .map((line) => ({ id: line.id, productId: line.productId, qty: line.qty })),
            shipments: state.shipments
              .filter((row) => row.orderId === order.id && row.status === 'SHIPPED')
              .map((row) => ({ id: row.id })),
          }
        }
        if (select.allocations || select.shipments || select.refunds) {
          return {
            allocations: state.allocations.filter((row) => row.orderId === order.id),
            lines: state.lines.filter((row) => row.orderId === order.id),
            shipments: state.shipments.filter((row) => row.orderId === order.id && row.shipmentJournalDate),
            refunds: state.refunds
              .filter((refund) => refund.orderId === order.id)
              .map((refund) => ({
                id: refund.id,
                lines: state.refundLines.filter((line) => line.refundId === refund.id),
            })),
          }
        }
        return order
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Order> }) => {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) throw new Error('Order not found')
        Object.assign(order, data)
        return order
      },
    },
    salesOrderRefund: {
      findMany: async ({ where, select }: { where: { orderId?: string; creditNoteNumber?: { startsWith: string } }; select: Record<string, boolean> }) => {
        if (select.creditNoteNumber) {
          return state.refunds
            .filter((refund) => where.creditNoteNumber == null || refund.creditNoteNumber?.startsWith(where.creditNoteNumber.startsWith))
            .map((refund) => ({ creditNoteNumber: refund.creditNoteNumber }))
        }
        return state.refunds
          .filter((refund) => where.orderId == null || refund.orderId === where.orderId)
          .map((refund) => ({ totalBase: refund.totalBase }))
      },
      create: async ({ data }: { data: Omit<Refund, 'id'> }) => {
        const refund = { id: `refund-${state.nextRefundId++}`, ...data }
        state.refunds.push(refund)
        return { id: refund.id }
      },
    },
    salesOrderRefundLine: {
      findMany: async ({ where }: { where: { refund: { orderId: string } } }) => {
        const refundIds = state.refunds
          .filter((refund) => refund.orderId === where.refund.orderId)
          .map((refund) => refund.id)
        return state.refundLines
          .filter((line) => refundIds.includes(line.refundId))
          .map((line) => ({ productId: line.productId, qty: line.qty }))
      },
      create: async ({ data }: { data: Omit<RefundLine, 'id'> }) => {
        const line = { id: `refund-line-${state.nextRefundLineId++}`, ...data }
        state.refundLines.push(line)
        return line
      },
      update: async ({ where, data }: { where: { id: string }; data: { costLayerSnapshot: unknown } }) => {
        const line = state.refundLines.find((row) => row.id === where.id)
        if (line) line.costLayerSnapshot = data.costLayerSnapshot
      },
    },
    accountingSyncLog: {
      findMany: async () => [],
    },
    costLayer: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => state.costLayers
        .filter((layer) => where.id.in.includes(layer.id)),
      create: async ({ data }: { data: { productId: string; warehouseId: string; receivedQty: number; remainingQty: number; unitCostBase: number; poLineId: string | null } }) => {
        const layer = { id: `return-layer-${state.nextCostLayerId++}`, productId: data.productId, poLineId: data.poLineId, receivedQty: data.receivedQty, unitCostBase: data.unitCostBase }
        state.costLayers.push(layer)
        return { id: layer.id }
      },
      findUnique: async () => ({ receivedQty: 1, sourceLines: [] }),
    },
    stockMovement: {
      findMany: async ({ where }: { where: { referenceType: string; referenceId: string } }) => state.movements
        .filter((movement) => movement.referenceType === where.referenceType && movement.referenceId === where.referenceId),
      create: async ({ data }: { data: { productId: string; qty: number; referenceType: string; referenceId: string } }) => {
        state.movements.push(data)
      },
    },
    stockLevel: {
      upsert: async ({ where, create, update }: { where: { productId_warehouseId: { productId: string; warehouseId: string } }; create: { productId: string; warehouseId: string; quantity: number; reservedQty: number }; update: { quantity: { increment: number } } }) => {
        const row = state.stockLevels.find((stock) => (
          stock.productId === where.productId_warehouseId.productId &&
          stock.warehouseId === where.productId_warehouseId.warehouseId
        ))
        if (row) {
          row.quantity += update.quantity.increment
        } else {
          state.stockLevels.push({ ...create })
        }
      },
    },
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, sku: id.toUpperCase() })),
    },
  }
  return client as unknown as RefundServiceClient
}

test('createSalesOrderRefund creates a partial refund record', async () => {
  const state = baseState()
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].status, 'PARTIALLY_REFUNDED')
  assert.equal(state.refunds[0].creditNoteNumber, 'CN-2026-00001')
  assert.equal(state.refundLines[0].qty, 1)
  assert.equal(state.refundLines[0].unitPriceBase, 50)
})

test('createSalesOrderRefund converts refund totals from base to foreign currency', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 2,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.refunds[0].totalForeign, 100)
  assert.equal(state.refundLines[0].totalForeign, 100)
  assert.equal(state.refundLines[0].unitPriceForeign, 100)
})

test('createSalesOrderRefund rejects stock returns before shipment', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot return refunded stock before the order has shipped',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.movements.length, 0)
})

test('createSalesOrderRefund rejects stock returns for packed shipments', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PACKING',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'PACKED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot return refunded stock before the order has shipped',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.movements.length, 0)
})

test('createSalesOrderRefund surfaces stale shipment cost snapshots without fallback stock returns', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /accounting reversal staging failed/)
  assert.match(result.success === false ? result.error : '', /Cannot reverse COGS/)
  assert.equal(state.refunds.length, 1)
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
})

test('createSalesOrderRefund rejects refund quantities beyond remaining order quantity', async () => {
  const state = baseState({
    refunds: [{
      id: 'prior-refund',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: null,
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: null,
    }],
    refundLines: [{
      id: 'prior-refund-line',
      refundId: 'prior-refund',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 25,
      unitPriceBase: 25,
      totalForeign: 50,
      totalBase: 50,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 25 }],
    reason: 'Duplicate',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Refund qty 1 for product product-1 exceeds remaining refundable qty 0.00',
  })
})

test('createSalesOrderRefund rejects manual kit component refunds', async () => {
  const state = baseState({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      description: 'Kit 1',
      qty: 1,
      totalBase: 100,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'component-1', description: 'Component 1', qty: 1, totalBase: 50 }],
    reason: 'Wrong item',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.error.includes('kit component'), true)
})

test('createSalesOrderRefund stages COGS reversal and returns shipped stock from snapshots', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: 1,
    unitCostBase: 10,
    shipmentLineId: 'shipment-line-1',
    orderAllocationId: undefined,
    source: 'shipment',
  }])
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].qty, 1)
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.costLayers[1].unitCostBase, 10)
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
})

test('createSalesOrderRefund clears accounting deferral dates for full refunds', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].status, 'REFUNDED')
  assert.equal(state.orders[0].revenueDeferredDate, null)
  assert.equal(state.orders[0].inventoryAllocatedDate, null)
})

test('applyReturnInboundStockTx returns existing movement rows without duplicating stock', async () => {
  const state = baseState({
    movements: [{ productId: 'product-1', qty: 1, referenceType: 'SalesOrder', referenceId: 'order-1' }],
  })

  const rows = await applyReturnInboundStockTx(createClient(state) as Parameters<typeof applyReturnInboundStockTx>[0], {
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    warehouseId: 'warehouse-returns',
    rows: [{ productId: 'product-1', qty: 1, unitCostBase: 10 }],
    note: 'Refund return',
  })

  assert.deepEqual(rows, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
})
