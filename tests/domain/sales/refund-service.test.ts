import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  applyReturnInboundStockTx,
  buildChargebackRefundLines,
  createSalesOrderRefund,
  retrySalesOrderRefundAccounting,
  type RefundServiceClient,
} from '@/lib/domain/sales/refund-service'
import type { AccountingSettings } from '@/lib/accounting'

// bcz9.1: the COGS subledger ledger row is gated on the COGS_REVERSAL journal posting.
// Unit tests have no live connector, so inject the enabled gate to exercise the
// "reversal will post" path that records the ledger row.
const cogsReversalEnabledDeps = { isCogsReversalSyncEnabled: async () => true }

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

function uniqueStockMovementError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['idempotencyKey'] },
  })
}

function uniqueStockLevelError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['productId', 'warehouseId'] },
  })
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
  chargeback?: boolean
  reversalStaged?: boolean
  accountingRetryRequired?: boolean
  accountingWarning?: string | null
  accountingRetrySyncs?: unknown
}

type RefundLine = {
  id: string
  refundId: string
  salesOrderLineId?: string | null
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
    lines: Array<{ id: string; lineId: string; productId?: string; qty: number; costLayerSnapshot: unknown }>
  }>
  allocations: Array<{ id: string; orderId: string; lineId: string; productId: string; warehouseId: string; qty: number; costLayerSnapshot: unknown }>
  costLayers: Array<{ id: string; productId: string; poLineId: string | null; receivedQty: number; unitCostBase: number }>
  movements: Array<{
    id?: string
    productId: string
    qty: number
    referenceType: string
    referenceId: string
    toWarehouseId?: string | null
    idempotencyKey?: string | null
  }>
  cogsEntries: Array<{
    movementId: string
    costLayerId: string
    qty: number
    unitCostBase: number
    createdAt: Date
  }>
  stockLevels: Array<{ productId: string; warehouseId: string; quantity: number; reservedQty: number }>
  // scjz.20: kit product graph so loadFulfillmentProductGraph can expand KIT lines to
  // components. Keyed by productId; absent ids default to SIMPLE with no components.
  productGraph?: Record<string, {
    type: string
    productComponents: Array<{ componentId: string; qty: number; component: { sku: string; type: string; oversellAllowed: boolean } }>
  }>
  activityLogs: unknown[]
  cogsSubledgerMovements: unknown[]
  settings: Record<string, string>
  executeRawCalls: number
  nextRefundId: number
  nextRefundLineId: number
  nextCostLayerId: number
  failStockLevelUnique?: boolean
  wrapTransactionErrors?: boolean
}

function cloneTestStateValue<T>(value: T): T {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map((entry) => cloneTestStateValue(entry)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneTestStateValue(entry)]),
    ) as T
  }
  return value
}

function restoreTestState(state: State, snapshot: State) {
  for (const key of Object.keys(state) as Array<keyof State>) {
    delete state[key]
  }
  Object.assign(state, cloneTestStateValue(snapshot))
}

const accountingSettings: AccountingSettings = {
  syncEnabled: true,
  salesAccount: '4000',
  shippingAccount: '4010',
  discountAccount: '',
  cogsAccount: '5000',
  inventoryRevaluationAccount: '',
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
  reverseChargeSalesTaxType: '',
  reverseChargePurchaseTaxType: '',
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
    cogsEntries: [],
    stockLevels: [],
    activityLogs: [],
    cogsSubledgerMovements: [],
    settings: {},
    executeRawCalls: 0,
    nextRefundId: 1,
    nextRefundLineId: 1,
    nextCostLayerId: 1,
    ...overrides,
  }
}

function createClient(state: State): RefundServiceClient {
  // This in-memory Prisma mock is intentionally scoped to refund-service unit
  // tests. It models transaction rollback and the two shipment read shapes used
  // by refund creation: physical SHIPPED rows for restocking and journaled rows
  // for accounting reversal snapshots.
  const client = {
    $queryRaw: async () => [],
    $executeRaw: async () => {
      state.executeRawCalls += 1
      return 0
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = cloneTestStateValue(state)
      try {
        return await callback(client)
      } catch (error) {
        restoreTestState(state, snapshot)
        if (state.wrapTransactionErrors) {
          throw new Error('Wrapped transaction error', { cause: error })
        }
        throw error
      }
    },
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
          const shipmentSelect = select.shipments as { where?: { shipmentJournalDate?: { not?: null }; status?: string } } | undefined
          const selectedShipments = state.shipments
            .filter((row) => row.orderId === order.id)
            .filter((row) => {
              if (shipmentSelect?.where?.shipmentJournalDate) return row.shipmentJournalDate != null
              if (shipmentSelect?.where?.status) return row.status === shipmentSelect.where.status
              return true
            })
          return {
            allocations: state.allocations.filter((row) => row.orderId === order.id),
            lines: state.lines.filter((row) => row.orderId === order.id),
            shipments: selectedShipments.map((shipment) => ({
              ...shipment,
              lines: shipment.lines.map((line) => ({
                ...line,
                // KIT shipment lines carry the COMPONENT productId; fall back to the
                // sales line's product for SIMPLE fixtures that don't set it (scjz.20).
                productId: line.productId ?? state.lines.find((salesLine) => salesLine.id === line.lineId)?.productId,
              })),
            })),
            refunds: state.refunds
              .filter((refund) => refund.orderId === order.id)
              .filter((refund) => {
                const refundSelect = select.refunds as { where?: { id?: { not?: string } } } | undefined
                return refundSelect?.where?.id?.not == null || refund.id !== refundSelect.where.id.not
              })
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
      findFirst: async ({ where }: { where: { orderId: string; externalRefundId: number } }) => {
        const refund = state.refunds.find((row) => (
          row.orderId === where.orderId &&
          row.externalRefundId === where.externalRefundId
        ))
        if (!refund) return null
        return {
          ...refund,
          lines: state.refundLines.filter((line) => line.refundId === refund.id),
        }
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const refund = state.refunds.find((row) => row.id === where.id)
        if (!refund) return null
        const order = state.orders.find((row) => row.id === refund.orderId)
        if (!order) return null
        return {
          ...refund,
          order,
          lines: state.refundLines.filter((line) => line.refundId === refund.id),
        }
      },
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
        const refund = {
          id: `refund-${state.nextRefundId++}`,
          accountingRetryRequired: false,
          accountingWarning: null,
          ...data,
        }
        state.refunds.push(refund)
        return { id: refund.id }
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Refund> }) => {
        const refund = state.refunds.find((row) => row.id === where.id)
        if (!refund) throw new Error('Refund not found')
        Object.assign(refund, data)
        return refund
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
    cogsSubledgerMovement: {
      // khdw: refund staging records the COGS reversal into the subledger ledger.
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        state.cogsSubledgerMovements.push(create)
        return create
      },
    },
    activityLog: {
      create: async ({ data }: { data: unknown }) => {
        state.activityLogs.push(data)
      },
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
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
        const movement = state.movements.find((row) => row.idempotencyKey === where.idempotencyKey)
        if (!movement?.id) return null
        return {
          cogsEntries: state.cogsEntries
            .filter((entry) => entry.movementId === movement.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        }
      },
      findMany: async ({ where }: { where: { referenceType: string; referenceId: string; toWarehouseId?: string } }) => state.movements
        .filter((movement) => movement.referenceType === where.referenceType && movement.referenceId === where.referenceId)
        .filter((movement) => where.toWarehouseId == null || movement.toWarehouseId === where.toWarehouseId),
      createMany: async ({ data, skipDuplicates }: { data: Array<{ productId: string; qty: number; referenceType: string; referenceId: string; idempotencyKey?: string | null }>; skipDuplicates?: boolean }) => {
        let count = 0
        for (const entry of data) {
          if (skipDuplicates && entry.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === entry.idempotencyKey)) {
            continue
          }
          state.movements.push({ id: `movement-${state.movements.length + 1}`, ...entry })
          count += 1
        }
        return { count }
      },
      create: async ({ data }: { data: { productId: string; qty: number; referenceType: string; referenceId: string; toWarehouseId?: string | null; idempotencyKey?: string | null } }) => {
        if (data.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === data.idempotencyKey)) {
          throw uniqueStockMovementError()
        }
        state.movements.push({ id: `movement-${state.movements.length + 1}`, ...data })
      },
    },
    stockLevel: {
      upsert: async ({ where, create, update }: { where: { productId_warehouseId: { productId: string; warehouseId: string } }; create: { productId: string; warehouseId: string; quantity: number; reservedQty: number }; update: { quantity: { increment: number } } }) => {
        if (state.failStockLevelUnique) throw uniqueStockLevelError()
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
      // Includes type + productComponents so loadFulfillmentProductGraph (scjz.20
      // kit-unit COGS conversion) can build its graph. These fixtures are all SIMPLE
      // products (1 component unit per sales-line unit); kit-unit conversion is
      // exercised end-to-end against a real DB in scripts/repro-scjz20.ts.
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id,
          sku: id.toUpperCase(),
          type: state.productGraph?.[id]?.type ?? 'SIMPLE',
          productComponents: state.productGraph?.[id]?.productComponents ?? [],
        })),
    },
  }
  return client as unknown as RefundServiceClient
}

function findReturnCostLayer(state: State) {
  const returnLayer = state.costLayers.find((layer) => layer.id.startsWith('return-layer-'))
  assert.ok(returnLayer, 'expected return cost layer to be created')
  return returnLayer
}

function findCogsReversalSync(result: Awaited<ReturnType<typeof createSalesOrderRefund>>) {
  if (!result.success) {
    assert.fail(result.error)
  }
  const sync = result.accountingSyncs.find((entry) => entry.type === 'COGS_REVERSAL')
  assert.ok(sync, 'expected COGS_REVERSAL sync')
  return sync
}

function findCogsReversalInventoryLine(result: Awaited<ReturnType<typeof createSalesOrderRefund>>) {
  const sync = findCogsReversalSync(result)
  const payload = sync.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }
  const inventoryLine = payload.lines?.find((line) => line.accountCode === accountingSettings.inventoryAccount)
  assert.ok(inventoryLine, 'expected COGS reversal inventory debit line')
  return inventoryLine
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
  assert.equal(state.refundLines[0].salesOrderLineId, 'line-1')
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

test('createSalesOrderRefund records accounting warnings without fallback stock returns', async () => {
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

  assert.equal(result.success, true)
  assert.match(result.success ? result.accountingWarning ?? '' : '', /accounting reversal staging failed/)
  assert.match(result.success ? result.accountingWarning ?? '' : '', /Cannot reverse COGS/)
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0].accountingRetryRequired, true)
  assert.match(state.refunds[0].accountingWarning ?? '', /Cannot reverse COGS/)
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
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].qty, 1)
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.movements[0].idempotencyKey, 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns')
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
})

test('createSalesOrderRefund records the COGS subledger row only when COGS_REVERSAL posts (bcz9.1)', async () => {
  const makeState = () => baseState({
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
  const refundInput = {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  }

  // Enabled: the reversal posts, so the ledger gets a negative REFUND_REVERSAL row.
  const enabledState = makeState()
  const enabled = await createSalesOrderRefund(createClient(enabledState), refundInput, cogsReversalEnabledDeps)
  assert.equal(enabled.success, true)
  assert.equal(enabledState.cogsSubledgerMovements.length, 1)
  const row = enabledState.cogsSubledgerMovements[0] as Record<string, unknown>
  assert.equal(row.sourceType, 'REFUND_REVERSAL')
  assert.equal(row.idempotencyKey, 'sales-order-refund:refund-1:cogs-reversal')
  assert.equal(Number(row.baseDelta), -10)

  // Disabled: no journal will post, so no ledger row — but the refund still succeeds
  // and restocks (a flagged-but-safe reconciliation, never a mis-sweep).
  const disabledState = makeState()
  const disabled = await createSalesOrderRefund(
    createClient(disabledState),
    refundInput,
    { isCogsReversalSyncEnabled: async () => false },
  )
  assert.equal(disabled.success, true)
  assert.equal(disabledState.cogsSubledgerMovements.length, 0)
  assert.equal(disabledState.movements[0].productId, 'product-1')
  assert.equal(disabledState.stockLevels[0].quantity, 1)
})

test('createSalesOrderRefund chargeback mode suppresses COGS reversal AND restock (scjz.70)', async () => {
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
    reason: 'Payment reversed (chargeback)',
    // A warehouse is supplied to prove the chargeback suppresses restock regardless.
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, true)
  // No COGS reversal — cost is kept as a loss.
  assert.equal(
    result.success && result.accountingSyncs.some((s) => s.type === 'COGS_REVERSAL'),
    false,
  )
  // No inventory restock — the customer keeps the goods.
  assert.equal(result.success && result.returnedRows.length, 0)
  assert.equal(state.movements.length, 0)
  // The refund is recorded as a chargeback that staged NO reversal (fully shipped →
  // credit-note-only), so the accounting evidence checks exempt it durably (scjz.71).
  assert.equal(state.refunds[0]?.chargeback, true)
  assert.equal(state.refunds[0]?.reversalStaged, false)
})

test('createSalesOrderRefund reverses kit COGS in component units, not kit units', async () => {
  // scjz.20: refund qty is in KIT units but cost-layer snapshots are in COMPONENT
  // units. A 1:2 kit refunded for 3 kits must reverse 3 * 2 = 6 component units of
  // basis (£60), not 3 (£30). Refund only the fully-shipped portion to isolate the
  // shipment-cost conversion.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 150,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 150,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 60,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      description: 'Kit',
      qty: 3,
      totalBase: 150,
    }],
    productGraph: {
      'kit-1': {
        type: 'KIT',
        productComponents: [{
          componentId: 'comp-1',
          qty: 2,
          component: { sku: 'COMP-1', type: 'SIMPLE', oversellAllowed: false },
        }],
      },
    },
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 150,
      cogsBatchAmount: 60,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        productId: 'comp-1',
        qty: 6,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 6, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', poLineId: 'po-line-1', receivedQty: 6, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'kit-1', description: 'Kit', qty: 3, totalBase: 150 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  // 3 kits * 2 components = 6 component units of basis at £10 = £60 reversed.
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '6.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  // Returned stock is restocked in component units against the component product.
  assert.equal(state.movements[0].productId, 'comp-1')
  assert.equal(state.movements[0].qty, 6)
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
})

test('createSalesOrderRefund replays external refunds without duplicate stock side effects', async () => {
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
  const input = {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'WooCommerce refund replay',
    returnWarehouseId: 'warehouse-returns',
    externalRefundId: 12345,
    creditNotePrefix: 'CN-',
    accountingSettings,
  }

  const first = await createSalesOrderRefund(createClient(state), input)
  assert.equal(first.success, true)
  const movementCount = state.movements.length
  const costLayerCount = state.costLayers.length
  const refundCount = state.refunds.length
  const refundLineCount = state.refundLines.length
  const stockQty = state.stockLevels[0]?.quantity

  const second = await createSalesOrderRefund(createClient(state), input)

  assert.equal(second.success, true)
  assert.equal(second.success && first.success && second.createdRefund.id, first.success && first.createdRefund.id)
  assert.deepEqual(second.success && second.accountingSyncs, [])
  assert.deepEqual(second.success && second.returnedRows, [])
  assert.equal(state.movements.length, movementCount)
  assert.equal(state.costLayers.length, costLayerCount)
  assert.equal(state.refunds.length, refundCount)
  assert.equal(state.refundLines.length, refundLineCount)
  assert.equal(state.stockLevels[0]?.quantity, stockQty)
})

test('createSalesOrderRefund reconstructs legacy shipment snapshots from COGS entries', async () => {
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
        costLayerSnapshot: null,
      }],
    }],
    movements: [{
      id: 'dispatch-movement-1',
      productId: 'product-1',
      qty: 2,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
    cogsEntries: [{
      movementId: 'dispatch-movement-1',
      costLayerId: 'layer-1',
      qty: 2,
      unitCostBase: 10,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
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
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.equal(result.success && result.accountingWarning, undefined)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
  const refundMovement = state.movements.find((movement) => movement.referenceType === 'SalesOrderRefund')
  assert.ok(refundMovement, 'expected refund return movement')
  assert.equal(refundMovement.qty, 1)
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
})

test('createSalesOrderRefund uses current cost layer cost after landed cost revaluation', async () => {
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
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 12 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after revaluation',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '12.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '12.000000',
    'return layer should be valued at the refreshed cost, not the shipment snapshot',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 12)
})

test('createSalesOrderRefund uses decreased current cost layer cost after landed cost revaluation', async () => {
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
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 8 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after supplier credit',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '8.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '8.000000',
    'return layer should follow downward landed-cost revaluation',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 8)
})

test('createSalesOrderRefund falls back to shipment snapshot cost when cost layer no longer exists', async () => {
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
    costLayers: [],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after layer cleanup',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
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
  assert.deepEqual(state.refunds[0].accountingRetrySyncs, result.success ? result.accountingSyncs : [])
})

test('createSalesOrderRefund reverses the FULL deferral on a full refund of a shipped-but-unjournaled order (qn8a)', async () => {
  // qn8a: a deferred order ships, but Group B has NOT yet journaled its revenue
  // recognition (shipmentJournalDate: null, revenueRecognizedAmount: 0), then a
  // FULL refund is issued. A concern was raised that the unearnedReversal cap
  // (unshippedQtyRevenue + nonQtyRevenue) would drop the shipped portion's
  // deferral, stranding it in the unearned account once the order flips to
  // REFUNDED (which Group B then excludes forever).
  //
  // It does NOT strand: the refund's shipment query filters to journaled
  // shipments only (refund-service.ts shipments where shipmentJournalDate not
  // null), so an unjournaled-but-shipped qty is classified as UNSHIPPED in the
  // revenue split and lands inside the cap. The full remaining deferral is
  // reversed; the credit-note ACCRECCREDIT document reverses Sales↔AR, netting
  // to Dr Unearned / Cr AR — a correct full unwind. This test locks that so the
  // journaled-only filter cannot silently regress.
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
      // Unjournaled: Group B has not run for this shipment yet.
      shipmentJournalDate: null,
      revenueRecognizedAmount: 0,
      cogsBatchAmount: 0,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    allocations: [{
      id: 'alloc-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
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
  const unearnedSync = result.success && result.accountingSyncs.find((s) => s.type === 'UNEARNED_REV_REVERSAL')
  assert.ok(unearnedSync, 'expected an UNEARNED_REV_REVERSAL sync')
  const debitLine = (unearnedSync.payload as { lines?: Array<{ accountCode?: string; debit?: number }> })
    .lines?.find((l) => l.accountCode === accountingSettings.unearnedRevenueAccount && l.debit)
  // The entire £100 deferral is reversed out of the unearned account — nothing stranded.
  assert.equal(debitLine?.debit, 100)
})

test('createSalesOrderRefund fallback stock return excludes the current refund from prior returns', async () => {
  const state = baseState({
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
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-main',
      qty: 2,
      costLayerSnapshot: [],
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].qty, 2)
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.movements[0].idempotencyKey, 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns')
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('createSalesOrderRefund rejects restocking a refund line with no shipped source stock', async () => {
  const state = baseState({
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
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50 },
    ],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-2',
      productId: 'product-2',
      warehouseId: 'warehouse-main',
      qty: 1,
      costLayerSnapshot: [],
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 1, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-2', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50 }],
    reason: 'Refund unshipped allocation',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot restock product product-2 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.refundLines.length, 0)
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
})

test('createSalesOrderRefund unwraps transaction-wrapped return source errors', async () => {
  const state = baseState({
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
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 100 }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [],
    }],
    wrapTransactionErrors: true,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 100 }],
    reason: 'Refund unshipped line',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot restock product product-1 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.refundLines.length, 0)
})

test('createSalesOrderRefund keeps same-product refund lines as distinct inbound movements', async () => {
  const state = baseState({
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
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1 A', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-1', description: 'Product 1 B', qty: 1, totalBase: 50 },
    ],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [
        { id: 'shipment-line-1', lineId: 'line-1', qty: 1, costLayerSnapshot: [] },
        { id: 'shipment-line-2', lineId: 'line-2', qty: 1, costLayerSnapshot: [] },
      ],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [
      { lineId: 'line-1', productId: 'product-1', description: 'Product 1 A', qty: 1, totalBase: 50 },
      { lineId: 'line-2', productId: 'product-1', description: 'Product 1 B', qty: 1, totalBase: 50 },
    ],
    reason: 'Return both same-SKU lines',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.deepEqual(
    state.movements.map((movement) => movement.idempotencyKey),
    [
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      'RETURN_INBOUND:refund:refund-1:line:refund-line-2:warehouse:warehouse-returns',
    ],
  )
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('applyReturnInboundStockTx scopes refund movement idempotency to the return warehouse', async () => {
  const state = baseState()

  await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-a',
    rows: [{ productId: 'product-1', qty: 1, refundLineId: 'refund-line-1' }],
    note: 'Refund return',
  })
  await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-b',
    rows: [{ productId: 'product-1', qty: 1, refundLineId: 'refund-line-1' }],
    note: 'Refund return',
  })

  assert.deepEqual(
    state.movements.map((movement) => movement.idempotencyKey),
    [
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-a',
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-b',
    ],
  )
  assert.deepEqual(state.stockLevels.map((stockLevel) => ({
    productId: stockLevel.productId,
    warehouseId: stockLevel.warehouseId,
    quantity: stockLevel.quantity,
  })), [
    { productId: 'product-1', warehouseId: 'warehouse-a', quantity: 1 },
    { productId: 'product-1', warehouseId: 'warehouse-b', quantity: 1 },
  ])
})

test('applyReturnInboundStockTx does not create return cost layers on movement idempotency conflict', async () => {
  const state = baseState({
    movements: [{
      productId: 'product-1',
      qty: 1,
      referenceType: 'SalesOrderRefund',
      referenceId: 'other-refund',
      idempotencyKey: 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      toWarehouseId: 'warehouse-returns',
    }],
  })

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
      unitCostBase: 10,
      poLineId: 'po-line-1',
      sourceCostLayerId: 'source-layer-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
  assert.equal(state.activityLogs.length, 1)
  assert.deepEqual(state.activityLogs[0], {
    entityType: 'SALES_ORDER',
    entityId: 'refund-1',
    action: 'refund_return_deduped',
    tag: 'sales',
    level: 'INFO',
    description: 'Skipped duplicate refund return for product product-1',
    metadata: {
      idempotencyKey: 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      productId: 'product-1',
      refundLineId: 'refund-line-1',
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
    },
  })
})

test('applyReturnInboundStockTx bubbles stock-level unique conflicts after movement creation', async () => {
  const state = baseState({ failStockLevelUnique: true })

  await assert.rejects(
    () => applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
      warehouseId: 'warehouse-returns',
      rows: [{
        productId: 'product-1',
        qty: 1,
        refundLineId: 'refund-line-1',
        unitCostBase: 10,
        poLineId: 'po-line-1',
      }],
      note: 'Refund return',
    }),
    /Unique constraint failed/,
  )

  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
  assert.equal(state.activityLogs.length, 0)
})

test('applyReturnInboundStockTx creates movement stock and cost layers on non-conflicting rows', async () => {
  const state = baseState()

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
      unitCostBase: 10,
      poLineId: 'po-line-1',
      sourceCostLayerId: 'source-layer-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.costLayers.length, 1)
  assert.equal(state.costLayers[0].unitCostBase, '10.000000')
})

test('applyReturnInboundStockTx allows return rows without cost layer inputs', async () => {
  const state = baseState()

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.costLayers.length, 0)
})

test('retrySalesOrderRefundAccounting replays persisted syncs after full refund clears deferral dates', async () => {
  const persistedSyncs = [{
    type: 'COGS_REVERSAL' as const,
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
    payload: {
      date: '2026-01-03',
      reference: 'COGS reversal: SO-1',
      lines: [
        { accountCode: '1200', description: 'COGS reversal: SO-1', debit: 20 },
        { accountCode: '5000', description: 'COGS reversal: SO-1', credit: 20 },
      ],
    },
  }]
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: null,
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Full return',
      totalForeign: 100,
      totalBase: 100,
      returnWarehouseId: null,
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting queueing failed',
      accountingRetrySyncs: persistedSyncs,
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 100,
      totalBase: 100,
    }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.deepEqual(result.success ? result.accountingSyncs : [], persistedSyncs)
  assert.equal(state.movements.length, 0)
})

test('applyReturnInboundStockTx returns existing movement rows without duplicating stock', async () => {
  const state = baseState({
    movements: [{
      productId: 'product-1',
      qty: 1,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      toWarehouseId: 'warehouse-returns',
    }],
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

test('retrySalesOrderRefundAccounting stages accounting and return stock for an existing refund', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
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

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
  assert.equal(
    result.success && result.accountingSyncs[0].idempotencyKey,
    'sales-order-refund:refund-1:cogs-reversal',
  )
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.executeRawCalls, 1)
})

test('retrySalesOrderRefundAccounting does not restock allocation-only refund rows', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 100,
      totalBase: 100,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 100,
      totalBase: 100,
    }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-main',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.equal(result.success, false)
  assert.equal(
    result.success ? '' : result.error,
    'Refund was created, but accounting reversal staging failed: Cannot restock product product-1 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  )
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.refunds[0].accountingRetryRequired, true)
})

test('retrySalesOrderRefundAccounting requires a pending accounting failure', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: false,
      accountingWarning: null,
    }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.deepEqual(result, {
    success: false,
    error: 'No failed refund accounting action is pending for this refund',
  })
})

test('retrySalesOrderRefundAccounting uses persisted sales line identity and refund-scoped stock returns', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
    ],
    refunds: [{
      id: 'prior-refund',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Earlier return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: false,
      accountingWarning: null,
    }, {
      id: 'refund-2',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00002',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'prior-refund-line',
      refundId: 'prior-refund',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
      costLayerSnapshot: [{
        costLayerId: 'layer-1',
        qty: 1,
        unitCostBase: 10,
        shipmentLineId: 'shipment-line-1',
        source: 'shipment',
      }],
    }, {
      id: 'refund-line-2',
      refundId: 'refund-2',
      salesOrderLineId: 'line-2',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 25,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 1,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 1, unitCostBase: 10 }],
      }, {
        id: 'shipment-line-2',
        lineId: 'line-2',
        qty: 1,
        costLayerSnapshot: [{ costLayerId: 'layer-2', qty: 1, unitCostBase: 15 }],
      }],
    }],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 1, unitCostBase: 10 },
      { id: 'layer-2', productId: 'product-1', poLineId: 'po-line-2', receivedQty: 1, unitCostBase: 15 },
    ],
    movements: [{ productId: 'product-1', qty: 1, referenceType: 'SalesOrderRefund', referenceId: 'prior-refund' }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-2',
    accountingSettings,
  }, cogsReversalEnabledDeps)

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[1].costLayerSnapshot, [{
    costLayerId: 'layer-2',
    qty: '1.000000',
    unitCostBase: '15.000000',
    shipmentLineId: 'shipment-line-2',
    source: 'shipment',
  }])
  assert.equal(state.movements.length, 2)
  assert.equal(state.movements[1].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[1].referenceId, 'refund-2')
})

// scjz.70 / .42a: full-order chargeback refund-line selection (pure).
test('buildChargebackRefundLines: full order with no prior refunds keeps qty + value exact', () => {
  const lines = buildChargebackRefundLines({
    lines: [
      { lineId: 'l1', productId: 'p1', description: 'Widget', qty: 3, totalBase: 30 },
      { lineId: 'l2', productId: 'p2', description: 'Gadget', qty: 1, totalBase: 12.5 },
    ],
  })
  assert.deepEqual(
    lines.map((l) => ({ lineId: l.lineId, qty: l.qty, totalBase: l.totalBase, lineKind: l.lineKind })),
    [
      { lineId: 'l1', qty: 3, totalBase: 30, lineKind: 'sale' },
      { lineId: 'l2', qty: 1, totalBase: 12.5, lineKind: 'sale' },
    ],
  )
})

test('buildChargebackRefundLines: preserves 4dp totals (no cent-rounding) — Codex P2', () => {
  // Decimal(18,4) totals must survive intact; rounding to 2dp would understate.
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Frac', qty: 1, totalBase: 12.3456 }],
  })
  assert.equal(lines[0]!.totalBase, 12.3456)
})

test('buildChargebackRefundLines: includes remaining shipping as a shipping-kind line — Codex P2', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 10 }],
    shipping: { totalBase: 5.5, priorRefundedBase: 1.5 },
  })
  const ship = lines.find((l) => l.lineKind === 'shipping')
  assert.ok(ship)
  assert.equal(ship.productId, null)
  assert.equal(ship.qty, 0)
  assert.equal(ship.totalBase, 4) // 5.5 − 1.5 remaining
})

test('buildChargebackRefundLines: order discount mirrored as a negative discount line, goods at full value — scjz.71', () => {
  // Goods 100 + shipping 10, a £10 order discount: the invoice posted full goods +
  // a separate −10 discount line, so the chargeback mirrors it (no goods scaling).
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 100 }],
    shipping: { totalBase: 10 },
    discount: { totalBase: 10 },
  })
  const sale = lines.find((l) => l.lineKind === 'sale')!
  const ship = lines.find((l) => l.lineKind === 'shipping')!
  const disc = lines.find((l) => l.lineKind === 'discount')!
  assert.equal(sale.totalBase, 100) // goods at FULL value — not scaled
  assert.equal(ship.totalBase, 10)
  assert.equal(disc.totalBase, -10) // negative discount line, mirrors the invoice
  assert.equal(disc.productId, null)
  assert.equal(disc.qty, 0)
  // Net reversed = goods + shipping − discount = the order's net total.
  assert.equal(sale.totalBase + ship.totalBase + disc.totalBase, 100)
})

test('buildChargebackRefundLines: no discount line emitted when no order discount — scjz.71', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 2, totalBase: 50 }],
    shipping: { totalBase: 5 },
  })
  assert.equal(lines.find((l) => l.lineKind === 'sale')!.totalBase, 50)
  assert.equal(lines.find((l) => l.lineKind === 'shipping')!.totalBase, 5)
  assert.equal(lines.some((l) => l.lineKind === 'discount'), false)
})

test('buildChargebackRefundLines: fully-refunded shipping is dropped', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 10 }],
    shipping: { totalBase: 5, priorRefundedBase: 5 },
  })
  assert.equal(lines.some((l) => l.lineKind === 'shipping'), false)
})

test('buildChargebackRefundLines: prior refunds reduce remaining qty AND remaining value', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 4, totalBase: 100 }],
    priorRefundedQtyByLineId: { l1: 1 },
    priorRefundedBaseByLineId: { l1: 25 },
  })
  assert.deepEqual(
    lines.map((l) => ({ qty: l.qty, totalBase: l.totalBase })),
    [{ qty: 3, totalBase: 75 }],
  )
})

test('buildChargebackRefundLines: non-proportional prior refund (price-only) reduces value not qty — Codex P2', () => {
  // A £10 price-only adjustment with no quantity: remaining qty unchanged, value − 10.
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 4, totalBase: 100 }],
    priorRefundedBaseByLineId: { l1: 10 },
  })
  assert.deepEqual(
    lines.map((l) => ({ qty: l.qty, totalBase: l.totalBase })),
    [{ qty: 4, totalBase: 90 }],
  )
})

test('buildChargebackRefundLines: fully-refunded (qty + value) and zero lines are dropped', () => {
  const lines = buildChargebackRefundLines({
    lines: [
      { lineId: 'l1', productId: 'p1', description: 'Done', qty: 2, totalBase: 20 },
      { lineId: 'l2', productId: 'p2', description: 'Zero', qty: 0, totalBase: 0 },
      { lineId: 'l3', productId: 'p3', description: 'Keep', qty: 1, totalBase: 10 },
    ],
    priorRefundedQtyByLineId: { l1: 2 },
    priorRefundedBaseByLineId: { l1: 20 },
  })
  assert.deepEqual(lines.map((l) => l.lineId), ['l3'])
})
