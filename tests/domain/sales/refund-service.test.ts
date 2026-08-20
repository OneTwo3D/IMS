import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  applyPostedShipmentUnitCosts,
  applyReturnInboundStockTx,
  buildChargebackRefundLines,
  createSalesOrderRefund,
  postedShipmentUnitCostKey,
  recordRefundCogsReversalFromSync,
  resolveRefundCogsReversalBase,
  retrySalesOrderRefundAccounting,
  type RefundAccountingSyncRequest,
  type RefundServiceClient,
} from '@/lib/domain/sales/refund-service'
import type { AccountingSettings } from '@/lib/accounting'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

type Order = {
  id: string
  externalOrderNumber: string | null
  orderNumber: string | null
  status: string
  refundStatus?: string
  fxRateToBase: number
  totalBase: number
  taxBase?: number
  taxRatePercent?: number
  taxRateName?: string | null
  revenueDeferredDate: Date | null
  unearnedRevenueAmount: number | null
  inventoryAllocatedDate: Date | null
  allocationBatchAmount: number | null
  // o3d-0qoo: the exact AccountingSyncLog.referenceId each stamp was staged into. Optional
  // here only so the many fixtures that never stage a batch stay unchanged; the un-stage
  // path must null them alongside the stamps they pair with.
  revenueDeferredBatchRef?: string | null
  inventoryAllocatedBatchRef?: string | null
}

type LineTaxRate = { accountingTaxType: string | null; reverseCharge: boolean | null }
type SalesLine = {
  id: string
  orderId: string
  productId: string | null
  description: string
  qty: number
  totalBase: number
  taxRate?: LineTaxRate | null
  /**
   * o3d-kouj: the line's PINNED fulfilment recipe. The refund's component factors — how many
   * component units one refunded kit unit reverses — now come from here, and the state double
   * passes the sales-line rows through verbatim, so setting it is all a fixture has to do.
   */
  fulfillmentRequirements?: unknown
}

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted columns).
function uniqueStockMovementError() {
  return adapterUniqueViolation(['idempotencyKey'], {
    modelName: 'StockMovement',
    constraintName: 'stock_movements_idempotencyKey_key',
  })
}

function uniqueStockLevelError() {
  return adapterUniqueViolation(['productId', 'warehouseId'], {
    modelName: 'StockLevel',
    constraintName: 'stock_levels_productId_warehouseId_key',
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
  totalsBasis?: string | null
  source?: string | null
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
  accountingTaxType?: string | null
  reverseCharge?: boolean | null
  lineKind?: string | null
}

type State = {
  orders: Order[]
  lines: SalesLine[]
  refunds: Refund[]
  refundLines: RefundLine[]
  // o3d-ee9: actionable WooCommerce refund parks, so createSalesOrderRefund's under-lock park check is testable.
  shoppingSyncLogs?: Array<{ id: string; connector: string; direction: string; entityType: string; entityId: string | null; externalId: string; status: string }>

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
  taxRates?: Array<{ name: string; accountingTaxType: string | null; active?: boolean }>
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
  const state: State = {
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
    taxRates: [],
    executeRawCalls: 0,
    nextRefundId: 1,
    nextRefundLineId: 1,
    nextCostLayerId: 1,
    ...overrides,
  }
  // Default seeded existing refunds to NET basis (the post-o3d-n8p norm); a test that exercises the
  // legacy/unknown-basis block pushes a refund with totalsBasis omitted AFTER baseState().
  state.refunds = state.refunds.map((refund) => ({ totalsBasis: 'NET' as const, ...refund }))
  return state
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
    shoppingSyncLog: {
      // o3d-ee9: the under-lock park queries in createSalesOrderRefund.
      findFirst: async ({ where }: { where: { externalId?: string; entityId?: { not?: string }; status?: { in?: string[] } } }) => {
        const notOrder = where.entityId?.not
        const statuses = where.status?.in
        const match = (state.shoppingSyncLogs ?? []).find((log) =>
          log.connector === 'woocommerce' &&
          log.direction === 'FROM_CONNECTOR' &&
          log.entityType === 'SalesOrder' &&
          (where.externalId == null || log.externalId === where.externalId) &&
          // Prisma `not` excludes NULL too, so a "different order" match requires a non-null, non-`notOrder` id.
          (notOrder == null || (log.entityId != null && log.entityId !== notOrder)) &&
          (statuses == null || statuses.includes(log.status)))
        return match ? { entityId: match.entityId } : null
      },
      updateMany: async ({ where, data }: { where: { externalId?: string; entityId?: string; status?: { in?: string[] } }; data: { status?: string } }) => {
        const statuses = where.status?.in
        let count = 0
        for (const log of state.shoppingSyncLogs ?? []) {
          if (
            log.connector === 'woocommerce' && log.direction === 'FROM_CONNECTOR' && log.entityType === 'SalesOrder' &&
            (where.externalId == null || log.externalId === where.externalId) &&
            (where.entityId == null || log.entityId === where.entityId) &&
            (statuses == null || statuses.includes(log.status))
          ) {
            if (data.status != null) log.status = data.status
            count += 1
          }
        }
        return { count }
      },
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
    taxRate: {
      findFirst: async ({ where }: { where: { name?: string; active?: boolean } }) => {
        const match = (state.taxRates ?? []).find((rate) =>
          rate.name === where.name && (where.active ? rate.active !== false : true))
        return match ? { accountingTaxType: match.accountingTaxType } : null
      },
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
    orderAllocation: {
      // o3d-67y: refund-release eligibility is residual reserved qty = allocated − shipped, under the lock.
      aggregate: async ({ where }: { where: { orderId: string } }) => ({
        _sum: { qty: state.allocations.filter((row) => row.orderId === where.orderId).reduce((sum, row) => sum + row.qty, 0) },
      }),
    },
    shipmentLine: {
      aggregate: async ({ where }: { where: { shipment: { orderId: string; status: string } } }) => ({
        _sum: {
          qty: state.shipments
            .filter((s) => s.orderId === where.shipment.orderId && s.status === where.shipment.status)
            .reduce((sum, s) => sum + s.lines.reduce((lineSum, line) => lineSum + line.qty, 0), 0),
        },
      }),
    },
    integrationOutbox: {
      // o3d-67y: the durable reservation-release backstop is enqueued inside the refund tx when the order holds
      // allocations. These unit tests don't assert on the outbox, so this is a sink.
      create: async ({ data }: { data: Record<string, unknown> }) => data,
      findUnique: async () => null,
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
              .map((line) => ({ id: line.id, productId: line.productId, qty: line.qty, taxRate: line.taxRate ?? null })),
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
      // Filters on whatever keys the caller supplied. The refund service queries this three
      // ways: by {orderId, externalRefundId} (external replay), by {orderId, chargeback} and
      // by {orderId} alone (the o3d-6oyu.18 cross-path conflict guard).
      findFirst: async ({ where }: { where: { orderId?: string; externalRefundId?: number; chargeback?: boolean } }) => {
        const refund = state.refunds.find((row) => (
          (where.orderId === undefined || row.orderId === where.orderId) &&
          (where.externalRefundId === undefined || row.externalRefundId === where.externalRefundId) &&
          (where.chargeback === undefined || (row.chargeback ?? false) === where.chargeback)
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
          .map((refund) => ({
            totalBase: refund.totalBase,
            accountingRetryRequired: refund.accountingRetryRequired ?? false,
            totalsBasis: refund.totalsBasis ?? null,
          }))
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
  assert.equal(state.orders[0].status, 'SHIPPED') // lifecycle status is left untouched
  assert.equal(state.orders[0].refundStatus, 'PARTIAL')
  assert.equal(state.refunds[0].creditNoteNumber, 'CN-2026-00001')
  assert.equal(state.refundLines[0].qty, 1)
  assert.equal(state.refundLines[0].unitPriceBase, 50)
  assert.equal(state.refundLines[0].salesOrderLineId, 'line-1')
})

test('createSalesOrderRefund dual-writes refundStatus=FULL on a full refund', async () => {
  const state = baseState()
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].status, 'SHIPPED') // lifecycle status is left untouched
  assert.equal(state.orders[0].refundStatus, 'FULL')
})

test('a full NET refund of a TAXABLE order reaches refundStatus=FULL, not stuck at PARTIAL (o3d-w00)', async () => {
  // Order: gross 120, tax 20, net 100. Refund lines are stored NET, so a full refund is net 100. Against
  // the GROSS 120 it stuck at PARTIAL forever; against the NET 100 it correctly reaches FULL.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 20, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL', 'a full net refund of a taxable order is FULL, not stuck PARTIAL')
})

test('a new refund is stamped totalsBasis=NET and a writer-derived source (o3d-n8p)', async () => {
  const state = baseState()
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-',
  })
  assert.equal(state.refunds[0].totalsBasis, 'NET', 'stored totals are marked NET')
  assert.equal(state.refunds[0].source, 'MANUAL_UI', 'no externalRefundId / chargeback => manual')

  const woo = baseState()
  await createSalesOrderRefund(createClient(woo), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
  })
  assert.equal(woo.refunds[0].source, 'WOO_SYNC', 'externalRefundId => woo sync')
})

test('createSalesOrderRefund fails closed when the refund id is parked for a DIFFERENT order (o3d-ee9 park-first)', async () => {
  // Park-first race: order B refused this refund id and wrote a park; order A must NOT silently create its
  // refund and leave B's actionable park stranded. Under the per-refund lock the create refuses.
  const state = baseState({
    shoppingSyncLogs: [{ id: 'p1', connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'order-OTHER', externalId: '4242', status: 'FAILED' }],
  })
  await assert.rejects(
    createSalesOrderRefund(createClient(state), {
      orderId: 'order-1',
      lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
      reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
    }),
    /parked for a different order/,
  )
  assert.equal(state.refunds.length, 0, 'no refund created for the cross-order-parked id')
  assert.equal(state.shoppingSyncLogs?.[0].status, 'FAILED', "the other order's park is untouched")
})

test('createSalesOrderRefund resolves a SAME-order park atomically when the refund lands (o3d-ee9)', async () => {
  // An earlier refused delivery of this refund parked it on THIS order; once the refund is created the park
  // must be resolved in the same transaction, not left lingering as an exception.
  const state = baseState({
    shoppingSyncLogs: [{ id: 'p2', connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'order-1', externalId: '4242', status: 'FAILED' }],
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
  })
  assert.equal(result.success, true, 'the same-order refund is created')
  assert.equal(state.refunds.length, 1)
  assert.equal(state.shoppingSyncLogs?.[0].status, 'SYNCED', "this order's park was resolved atomically")
})

test('a later refund on an order with a legacy/unknown-basis refund is BLOCKED for manual reconciliation, never over-refunded (o3d-w00 #3 / o3d-n8p)', async () => {
  // A legacy refund stored 100 (basis unknown/GROSS). Summing it with new NET totals against any single
  // ceiling can either over-refund (gross ceiling grosses the new line up) or mark FULL early (net
  // ceiling). Conversion is undecidable, so createSalesOrderRefund fails closed and refuses.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 20, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.refunds.push({
    id: 'legacy-refund', orderId: 'order-1', creditNoteNumber: 'CN-legacy', externalRefundId: null,
    reason: 'legacy', totalForeign: 100, totalBase: 100, returnWarehouseId: null, // totalsBasis omitted => legacy/unknown
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 15 }],
    reason: 'Small extra refund', creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, false, 'blocked rather than risk an over-refund / premature FULL')
  assert.equal(result.success === false && result.quarantine, true, 'routed to manual reconciliation')
  assert.equal(state.refundLines.length, 0, 'nothing created')
})

test('a refund line SNAPSHOTS the resolved tax identity at creation (o3d-w00)', async () => {
  // The linked sales line carries its own rate; the snapshot must capture that connector tax type so the
  // credit note posts under it instead of re-predicting from the order default at post time.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 20, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(state.refundLines[0].accountingTaxType, 'OUTPUT2', 'the resolved tax type is snapshotted')
  assert.equal(state.refundLines[0].reverseCharge, false)
})

test('a monetary-only refund PERSISTS lineKind=sale so a retry does not re-post it as shipping (o3d-w00 #4)', async () => {
  // A WooCommerce monetary-only refund is a null-product 'sale' line with a POSITIVE total. The retry
  // loader used to re-infer the kind from productId/sign (null product + positive total => 'shipping'),
  // sending the credit-note revenue to the shipping account on a retry. Persisting the kind fixes that.
  // The order is uniformly taxed so the monetary refund is allowed (mixed-rate orders are refused below).
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Goodwill refund', qty: 0, totalBase: 30, lineKind: 'sale' }],
    reason: 'Goodwill',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  const persisted = state.refundLines.find((line) => line.description === 'Goodwill refund')
  assert.ok(persisted, 'the monetary-only line was created')
  assert.equal(persisted?.productId, null, 'it is a null-product line (would infer as shipping)')
  assert.ok(persisted && persisted.totalBase > 0, 'with a positive total (would infer as shipping, not discount)')
  assert.equal(persisted?.lineKind, 'sale', 'the resolved kind is persisted, not left to be re-inferred on retry')
})

test('a mirrored order-discount refund line persists lineKind=discount (o3d-w00 #4)', async () => {
  // A discount line is exempt from the uniform-tax gate (it uses the order default, like the invoice).
  const state = baseState()
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Order discount', qty: 0, totalBase: 10, lineKind: 'discount' }],
    reason: 'Discount reversal',
    creditNotePrefix: 'CN-',
  })

  const persisted = state.refundLines.find((line) => line.description === 'Order discount')
  assert.equal(persisted?.lineKind, 'discount', 'a discount line persists its kind')
})

test('a monetary-only refund on a MIXED-rate order is REFUSED and quarantined (o3d-w00 #2/#5)', async () => {
  // Two order lines at different tax identities -> not uniform. A monetary-only SALE amount can't be
  // attributed, so it must be refused (fail closed) and flagged for quarantine, not posted under one rate.
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  state.lines.push({
    id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50,
    taxRate: { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: false },
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Partial monetary refund',
    externalRefundId: 9001,
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, false, 'a monetary refund on a mixed-rate order is refused')
  assert.equal(result.success === false && result.quarantine, true, 'and flagged for quarantine')
  assert.match(result.success === false ? result.error : '', /not itemised|not uniformly taxed/i)
  assert.equal(state.refundLines.length, 0, 'nothing was created')
})

test('a monetary-only refund on a REVERSE-CHARGE order is REFUSED (o3d-w00 #2/#5)', async () => {
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, false)
  assert.equal(result.success === false && result.quarantine, true)
})

test('a monetary-only refund on a UNIFORM order posts under the single safe identity, even if the default rate is deactivated (o3d-w00 #5)', async () => {
  // The order default rate is inactive, so the old order-default lookup (active=true) resolved NULL; the
  // identity must instead come from the line relation, which still carries the type.
  const state = baseState({
    orders: [{ ...baseState().orders[0], taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: false }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, true, 'a uniform order allows the monetary refund even with a deactivated default')
  const line = state.refundLines.find((l) => l.description === 'Monetary refund')
  assert.equal(line?.accountingTaxType, 'OUTPUT2', 'posted under the single safe identity from the line relation')
})

test('a reverse-charge line snapshots the SWAPPED tax type (o3d-w00)', async () => {
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 100, taxBase: 0, taxRatePercent: 0, taxRateName: 'RC' }],
    taxRates: [{ name: 'RC', accountingTaxType: 'ZERORATEDOUTPUT', active: true }],
    settings: { reverse_charge_sales_tax_type: 'REVERSECHARGE' },
  })
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return',
    creditNotePrefix: 'CN-',
    accountingSettings: { ...accountingSettings, reverseChargeSalesTaxType: 'REVERSECHARGE' },
  })

  assert.equal(state.refundLines[0].accountingTaxType, 'REVERSECHARGE', 'reverse-charge swap is captured in the snapshot')
  assert.equal(state.refundLines[0].reverseCharge, true)
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
  })

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

// ---------------------------------------------------------------------------
// o3d-6oyu.18 — concurrent double-reversal guard.
//
// A Xero payment removal and a WooCommerce refund can land inside one poll cycle.
// Both credit-note paths pre-check "has this order already been reversed?" OUTSIDE
// the refund transaction, so neither sees the other's uncommitted row and both post
// a credit note. The authoritative guard is re-taken inside the refund transaction,
// under pg_advisory_xact_lock + the sales_orders row lock, where the loser blocks
// until the winner COMMITS and then reads its row.
//
// These two tests pin the DECISION (both orderings) against the same in-memory
// client the rest of this suite uses. They cannot prove the LOCKING — the mock's
// $transaction is not concurrent and its statements never block. That half needs a
// real Postgres and lives in tests/concurrency/refund-chargeback-race.concurrent.test.ts.
// ---------------------------------------------------------------------------

function reversalRaceState(): State {
  return baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: 'WC-1001',
      orderNumber: null,
      status: 'SHIPPED',
      fxRateToBase: 1,
      // Gross (VAT-inclusive) order total. The chargeback's NET lines (£100) plus a small
      // WC refund still fit under it, which is precisely why the refund-total cap does not
      // catch this race and an explicit conflict guard is needed.
      totalBase: 120,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }] }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })
}

test('o3d-6oyu.18: WC refund commits first → the poller chargeback is refused as prior-refund, not double-credited', async () => {
  const state = reversalRaceState()
  // The WooCommerce refund webhook won the race: its row is COMMITTED by the time the
  // chargeback transaction takes the order lock, even though it was invisible to
  // raiseChargebackForReversedOrder's pre-check.
  state.refunds.push({
    id: 'refund-wc',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.conflict, 'prior-refund')
  assert.match(result.success === false ? result.error : '', /CN-0001/)
  // The decisive assertion: exactly ONE credit note exists for the order.
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0]?.id, 'refund-wc')
})

test('o3d-6oyu.18: chargeback commits first → the WC refund is refused as prior-chargeback, not double-credited', async () => {
  const state = reversalRaceState()
  // The payment poller won the race: its chargeback already unwound the WHOLE remaining
  // order, so the Woo-side refund arriving after must not add a second credit note.
  state.refunds.push({
    id: 'refund-chargeback',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0009',
    externalRefundId: null,
    reason: 'Payment reversed (chargeback)',
    totalForeign: 100,
    totalBase: 100,
    returnWarehouseId: null,
    chargeback: true,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7001,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.conflict, 'prior-chargeback')
  assert.match(result.success === false ? result.error : '', /CN-0009/)
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0]?.id, 'refund-chargeback')
})

test('o3d-6oyu.18: an ordinary partial refund on an order with prior NON-chargeback refunds is untouched', async () => {
  // The guard must not turn legitimate stacked partial refunds into conflicts — only a
  // prior CHARGEBACK blocks an ordinary refund.
  //
  // totalsBasis MUST be set here (o3d-w00/o3d-n8p): a NULL-basis prior refund is legacy/unknown
  // and now fails closed on its own, which would make this test pass for the wrong reason — it
  // would be asserting the basis guard rather than the chargeback guard it is named for.
  const state = reversalRaceState()
  state.refunds.push({
    id: 'refund-wc-1',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
    totalsBasis: 'NET',
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7002,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.refunds.length, 2)
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
  })

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

test('replaying a monetary-only external refund reconstructs lineKind=sale from the snapshot, not shipping (o3d-w00 #4)', async () => {
  // A duplicate WooCommerce delivery hits the external-refund replay query, which used to re-infer the
  // kind from salesOrderLineId (null => shipping) — re-posting a monetary 'sale' as shipping. It must now
  // reconstruct from the PERSISTED lineKind instead.
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false } // uniform: monetary refund allowed
  const input = {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Goodwill refund', qty: 0, totalBase: 30, lineKind: 'sale' as const }],
    reason: 'Goodwill',
    externalRefundId: 55555,
    creditNotePrefix: 'CN-',
    accountingSettings,
  }
  const first = await createSalesOrderRefund(createClient(state), input)
  assert.equal(first.success, true)

  const replay = await createSalesOrderRefund(createClient(state), input)
  assert.equal(replay.success, true)
  const line = replay.success ? replay.createdRefundLines.find((l) => l.description === 'Goodwill refund') : undefined
  assert.ok(line, 'the monetary-only line is present in the replay')
  assert.equal(line?.productId, null, 'null-product line (the shape that inferred as shipping)')
  assert.equal(line?.lineKind, 'sale', 'the replay uses the persisted kind, not the shipping inference')
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
  })

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

// 6oyu.5: after a post-dispatch landed-cost revaluation, updateSnapshotsForCost-
// LayerChange rewrites the shipment snapshot AND cogsBatchAmount to the CURRENT
// layer cost (£12), so the snapshot can NOT be the posted basis (scjz.19). The
// immutable CogsEntry dispatch rows (£10) are. The refund must reverse £10 (posted)
// and re-enter the returned stock at £10 — the +£2 revaluation delta stays in COGS.
test('createSalesOrderRefund reverses originally-posted COGS after an UPWARD landed-cost revaluation (6oyu.5)', async () => {
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
      // Revaluation mutated the snapshot AND cogsBatchAmount to the current £12.
      cogsBatchAmount: 24,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 12 }],
      }],
    }],
    // Immutable dispatch COGS: posted at £10/unit.
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
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 12 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after revaluation',
    returnWarehouseId: 'warehouse-returns',
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
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '10.000000',
    'return layer should re-enter at the originally-posted cost, not the revalued layer cost',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
  const sync = findCogsReversalSync(result)
  assert.equal((sync.payload as { _cogsReversalBase?: number })._cogsReversalBase, 10)
})

test('createSalesOrderRefund reverses originally-posted COGS after a DOWNWARD landed-cost revaluation (6oyu.5)', async () => {
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
      cogsBatchAmount: 16,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 8 }],
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
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 8 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after supplier credit',
    returnWarehouseId: 'warehouse-returns',
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
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '10.000000',
    'return layer should re-enter at the originally-posted cost after a downward revaluation',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
})

test('createSalesOrderRefund draws posted COGS proportionally on a PARTIAL refund after revaluation (6oyu.5)', async () => {
  // Shipped 2 units across two FIFO layers with DIFFERENT posted costs (£10, £20),
  // both revalued up to £15 after dispatch. A 1-unit partial refund must reverse
  // the FIFO-oldest layer's POSTED £10 (proportional draw), not the current £15.
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
      allocationBatchAmount: 30,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 30,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [
          { costLayerId: 'layer-1', qty: 1, unitCostBase: 15 },
          { costLayerId: 'layer-2', qty: 1, unitCostBase: 15 },
        ],
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
    cogsEntries: [
      { movementId: 'dispatch-movement-1', costLayerId: 'layer-1', qty: 1, unitCostBase: 10, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { movementId: 'dispatch-movement-1', costLayerId: 'layer-2', qty: 1, unitCostBase: 20, createdAt: new Date('2026-01-02T00:00:01.000Z') },
    ],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 1, unitCostBase: 15 },
      { id: 'layer-2', productId: 'product-1', poLineId: 'po-line-2', receivedQty: 1, unitCostBase: 15 },
    ],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Partial return after revaluation',
    returnWarehouseId: 'warehouse-returns',
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
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
})

test('applyPostedShipmentUnitCosts overrides shipment entries with the posted basis, keeps others (6oyu.5)', () => {
  const posted = new Map<string, number>([
    [postedShipmentUnitCostKey('shipment-line-1', 'layer-1'), 10],
  ])
  const entries = [
    // Shipment entry with a posted basis → overridden to £10.
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 12, shipmentLineId: 'shipment-line-1', source: 'shipment' as const },
    // Shipment entry with NO posted basis (legacy) → keeps its carrying cost.
    { costLayerId: 'layer-9', qty: 1, unitCostBase: 7, shipmentLineId: 'shipment-line-1', source: 'shipment' as const },
    // Allocation entry (no shipmentLineId) → untouched.
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 5, orderAllocationId: 'alloc-1', source: 'allocation' as const },
  ]
  assert.deepEqual(applyPostedShipmentUnitCosts(entries, posted), [
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 10, shipmentLineId: 'shipment-line-1', source: 'shipment' },
    { costLayerId: 'layer-9', qty: 1, unitCostBase: 7, shipmentLineId: 'shipment-line-1', source: 'shipment' },
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 5, orderAllocationId: 'alloc-1', source: 'allocation' },
  ])
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
      revenueDeferredBatchRef: 'A1-2026-01-01-deadbeef',
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-cafef00d',
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
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(state.orders[0].revenueDeferredDate, null)
  assert.equal(state.orders[0].inventoryAllocatedDate, null)
  // o3d-0qoo: each batch ref must be nulled in the SAME update as the stamp it pairs with.
  // A surviving ref with a cleared stamp still matches the delete guard's referenceId lookup,
  // so the order would be blocked forever on a batch it is no longer part of.
  assert.equal(state.orders[0].revenueDeferredBatchRef, null, 'A1 batch ref must be cleared with revenueDeferredDate')
  assert.equal(state.orders[0].inventoryAllocatedBatchRef, null, 'A2 batch ref must be cleared with inventoryAllocatedDate')
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
  assert.equal(state.orders[0].refundStatus, 'FULL')
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
  })

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
  })

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
  })

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

// ---------------------------------------------------------------------------
// bcz9.4: COGS-reversal subledger recording at queue time
// ---------------------------------------------------------------------------

test('resolveRefundCogsReversalBase prefers the 6dp structured base over 2dp credit lines', () => {
  const base = resolveRefundCogsReversalBase({
    date: '2026-01-02',
    _cogsReversalBase: 10.123456,
    lines: [
      { accountCode: '630', debit: 10.12 },
      { accountCode: '500', credit: 10.12 },
    ],
  })
  assert.equal(base, 10.123456)
})

test('resolveRefundCogsReversalBase falls back to summed credit lines without a structured base', () => {
  const base = resolveRefundCogsReversalBase({
    date: '2026-01-02',
    lines: [
      { accountCode: '630', debit: 7.5 },
      { accountCode: '500', credit: 7.5 },
    ],
  })
  assert.equal(base, 7.5)
})

test('resolveRefundCogsReversalBase returns null when no positive base is present', () => {
  assert.equal(resolveRefundCogsReversalBase({ date: '2026-01-02', lines: [{ credit: 0 }] }), null)
  assert.equal(resolveRefundCogsReversalBase({ date: '2026-01-02' }), null)
  assert.equal(resolveRefundCogsReversalBase(null), null)
})

function cogsLedgerProbe(): { rows: Array<Record<string, unknown>>; client: RefundServiceClient } {
  const rows: Array<Record<string, unknown>> = []
  const client = {
    cogsSubledgerMovement: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        rows.push(create)
        return create
      },
    },
  } as unknown as RefundServiceClient
  return { rows, client }
}

const cogsReversalSync: RefundAccountingSyncRequest = {
  type: 'COGS_REVERSAL',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-9',
  idempotencyKey: 'sales-order-refund:refund-9:cogs-reversal',
  payload: {
    date: '2026-01-02',
    reference: 'COGS reversal',
    _cogsReversalBase: 10.123456,
    lines: [
      { accountCode: '630', description: 'COGS reversal', debit: 10.12 },
      { accountCode: '500', description: 'COGS reversal', credit: 10.12 },
    ],
  },
}

test('recordRefundCogsReversalFromSync writes the negative 6dp row when the reversal will post', async () => {
  const { rows, client } = cogsLedgerProbe()
  await recordRefundCogsReversalFromSync(client, cogsReversalSync, true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceType, 'REFUND_REVERSAL')
  assert.equal(rows[0].sourceRef, 'refund-9')
  assert.equal(rows[0].idempotencyKey, 'sales-order-refund:refund-9:cogs-reversal')
  assert.equal(Number(rows[0].baseDelta), -10.123456)
})

test('recordRefundCogsReversalFromSync is a no-op when the reversal will not post', async () => {
  const { rows, client } = cogsLedgerProbe()
  await recordRefundCogsReversalFromSync(client, cogsReversalSync, false)
  assert.equal(rows.length, 0)
})

test('recordRefundCogsReversalFromSync ignores non-COGS_REVERSAL syncs', async () => {
  const { rows, client } = cogsLedgerProbe()
  const unearned: RefundAccountingSyncRequest = { ...cogsReversalSync, type: 'UNEARNED_REV_REVERSAL' }
  await recordRefundCogsReversalFromSync(client, unearned, true)
  assert.equal(rows.length, 0)
})

// ---------------------------------------------------------------------------
// o3d-mrwu — a refund/chargeback row is born OWING its accounting.
//
// The refund transaction COMMITS before stageRefundAccountingReversals runs. While
// accountingRetryRequired defaulted to false, a crash in that window left a committed
// row with no queued reversal and nothing marking it unfinished — so the concurrency
// guard read it as a completed reversal and refused the other source, while the poller
// read the false flag as completion and advanced. Both acknowledged; no reversal
// recoverable. The flag now starts true and is cleared ONLY by successful staging.
// ---------------------------------------------------------------------------

test('a refund that owes accounting is created with accountingRetryRequired set (o3d-mrwu)', async () => {
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

  // Capture the flag as it stood when the row was FIRST written, i.e. at the moment the
  // transaction would have committed — before staging gets a chance to clear it.
  let flagAtCreate: unknown
  const client = createClient(state)
  const realCreate = client.salesOrderRefund.create.bind(client.salesOrderRefund)
  client.salesOrderRefund.create = (async (args: { data: Record<string, unknown> }) => {
    flagAtCreate = args.data.accountingRetryRequired
    return realCreate(args as never)
  }) as unknown as typeof client.salesOrderRefund.create

  const result = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, true)
  assert.equal(
    flagAtCreate,
    true,
    'the row must commit already marked as owing accounting — a crash before staging must be visible',
  )
  assert.equal(
    state.refunds[0]?.accountingRetryRequired,
    false,
    'and staging succeeding is what clears it',
  )
})

test('a crash between commit and staging leaves the reversal recoverable, not silently complete (o3d-mrwu)', async () => {
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

  // Simulate the crash: the refund transaction commits, then the process dies before the
  // post-commit update that records the staged syncs. The row is left exactly as committed.
  const client = createClient(state)
  client.salesOrderRefund.update = (async () => {
    throw new Error('process died before staging was recorded')
  }) as unknown as typeof client.salesOrderRefund.update

  await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  }).catch(() => { /* the crash itself is not what this test asserts */ })

  assert.equal(state.refunds.length, 1, 'the refund row committed')
  assert.equal(
    state.refunds[0]?.accountingRetryRequired,
    true,
    'it must still be marked as owing accounting — this is what makes the reversal recoverable, '
      + 'and what stops the guard and the poller both reading it as complete',
  )
})

test('o3d-w00/o3d-n8p: a second refund on an order with a LEGACY-basis refund fails closed and quarantines', async () => {
  // The operationally consequential half of the basis marker, pinned explicitly because it
  // changes what happens to real money on real orders.
  //
  // Every refund written before the totals_basis migration has a NULL basis, and a NULL row's
  // stored total may be GROSS. Summing it with a new NET total is not sound: a legacy £60 gross
  // plus a new £60 net passes a 60+60=120 ceiling on a £120 order, yet the new line grosses up to
  // £72 — £132 of credit against £120 of goods. Converting a legacy mixed-rate gross refund back
  // to net is undecidable, so there is no safe automatic reconciliation.
  //
  // Hence: refuse and park for a human. This means an order carrying a pre-migration refund will
  // NOT take a second automated refund — it quarantines instead. That is deliberate, and it is
  // the behaviour someone working the exceptions inbox has to be ready for.
  const state = reversalRaceState()
  state.refunds.push({
    id: 'refund-legacy',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
    // No totalsBasis — exactly what every pre-migration row looks like.
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7002,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, false, 'a legacy-basis order does not take a second automated refund')
  assert.equal(result.success === false && result.quarantine, true, 'and it is parked, not merely failed')
  assert.match(result.success === false ? result.error : '', /legacy\/unknown amount basis/)
  assert.equal(state.refunds.length, 1, 'no second refund was written')
})

// ---------------------------------------------------------------------------
// o3d-kouj — THE COMPONENT FACTORS A REFUND REVERSES COME FROM THE LINE'S PIN.
//
// This is the money end of the snapshot. A refund is expressed in KIT units; the basis it relieves
// was recorded in COMPONENT units — by dispatch onto the shipment line, and by Group A2 onto the
// allocation row — in the units of the recipe the order was ALLOCATED from. Re-deriving the factors
// from the current graph makes the reversal reverse the wrong quantity of the right layers: too
// little and COGS never reconciles against inventory, too much and the take fails closed on
// "only M available across recorded shipments" and strands the refund in retry.
// ---------------------------------------------------------------------------

test('o3d-kouj: a kit re-composed AFTER dispatch still reverses the component units that actually shipped', async () => {
  // 3 kits shipped when 1 kit = 2 x comp-1, so 6 component units left and the shipment snapshot
  // holds 6. The catalogue has since been re-composed to 1 x comp-1. Reading the CURRENT graph
  // would reverse 3 units (£30) against 6 units of posted COGS (£60) — a permanent £30 hole
  // between the ledger and the goods.
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
      fulfillmentRequirements: {
        version: 1,
        productId: 'kit-1',
        graphVersion: 4,
        capturedAt: '2026-01-01T00:00:00.000Z',
        requirements: [{ productId: 'comp-1', factor: '2' }],
      },
    }],
    productGraph: {
      'kit-1': {
        type: 'KIT',
        // THE EDIT: the live recipe now needs ONE component per kit.
        productComponents: [{
          componentId: 'comp-1',
          qty: 1,
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
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '6.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }], '3 kits x the PINNED factor of 2 = the 6 component units that were dispatched')
  assert.equal(state.movements[0].productId, 'comp-1')
  assert.equal(state.movements[0].qty, 6, 'and the same 6 units are restocked, not 3')
})
