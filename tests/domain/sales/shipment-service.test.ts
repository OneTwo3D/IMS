import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  confirmSalesOrderShipments,
  reconcileOrderAfterShipment,
  transitionShipmentStatus,
  type ShipmentServiceClient,
} from '@/lib/domain/sales/shipment-service'
import { SHIPMENT_STATUSES } from '@/lib/domain/workflows/status-types'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

type Order = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  shippedAt?: Date | null
  trackingNumber?: string | null
}
type OrderLine = { id: string; orderId: string; productId: string; qty: number; sku: string; description: string; cogsBase?: number | null }
type Allocation = { id?: string; orderId: string; lineId: string; productId: string; warehouseId: string; qty: number }
type Shipment = {
  id: string
  orderId: string
  warehouseId: string
  status: string
  trackingNumber: string | null
  shippingService: string | null
  shippedAt?: Date | null
  cogsBatchAmount?: number | null
}
type ShipmentLine = {
  id: string
  shipmentId: string
  lineId: string
  productId: string
  qty: number
  costLayerSnapshot?: unknown
}
type StockLevel = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
type CostLayer = { id: string; productId: string; warehouseId: string; remainingQty: number; unitCostBase: number }

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted column).
function uniqueStockMovementError() {
  return adapterUniqueViolation(['idempotencyKey'], {
    modelName: 'StockMovement',
    constraintName: 'stock_movements_idempotencyKey_key',
  })
}

type State = {
  orders: Order[]
  lines: OrderLine[]
  allocations: Allocation[]
  refundLines?: Array<{ orderId: string; salesOrderLineId: string | null; productId: string | null; qty: number }>
  // Kit/BOM graph: productId -> its component requirements. Absent products are treated as SIMPLE.
  kits?: Record<string, Array<{ componentId: string; qty: number; sku?: string }>>
  shipments: Shipment[]
  shipmentLines: ShipmentLine[]
  stockLevels: StockLevel[]
  costLayers: CostLayer[]
  movements: Array<{
    id: string
    productId: string
    qty: number
    idempotencyKey?: string | null
    shipmentLineId?: string | null
    unitCostBase?: string | number | null
    totalValueBase?: string | number | null
  }>
  cogsEntries: Array<{ costLayerId: string; movementId: string; qty: string; unitCostBase: string; totalCostBase: string }>
  settings: Record<string, string>
}

type ClientOptions = {
  beforeTransaction?: () => void
}

function restoreState(state: State, snapshot: State) {
  state.orders = snapshot.orders
  state.lines = snapshot.lines
  state.allocations = snapshot.allocations
  state.shipments = snapshot.shipments
  state.shipmentLines = snapshot.shipmentLines
  state.stockLevels = snapshot.stockLevels
  state.costLayers = snapshot.costLayers
  state.movements = snapshot.movements
  state.cogsEntries = snapshot.cogsEntries
  state.settings = snapshot.settings
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PROCESSING' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    shipments: [],
    shipmentLines: [],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
    movements: [],
    cogsEntries: [],
    settings: { invoice_trigger: 'manual' },
    ...overrides,
  }
}

function createClient(state: State, options: ClientOptions = {}): ShipmentServiceClient {
  let shipmentSequence = state.shipments.length + 1
  let movementSequence = state.movements.length + 1
  const client = {
    $queryRaw: async (strings: TemplateStringsArray | unknown, ...values: unknown[]) => {
      const query = typeof (strings as { join?: unknown }).join === 'function'
        ? (strings as TemplateStringsArray).join('?')
        : ''
      if (query.includes('FROM "cost_layers"')) {
        const [productId, warehouseId] = values
        return state.costLayers
          .filter((layer) => layer.productId === productId)
          .filter((layer) => layer.warehouseId === warehouseId)
          .filter((layer) => layer.remainingQty > 0)
          .map((layer) => ({
            id: layer.id,
            remainingQty: new Prisma.Decimal(layer.remainingQty),
            unitCostBase: new Prisma.Decimal(layer.unitCostBase),
          }))
      }
      return []
    },
    $executeRaw: async () => 0,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      options.beforeTransaction?.()
      const snapshot = structuredClone(state)
      try {
        return await callback(client)
      } catch (error) {
        restoreState(state, snapshot)
        throw error
      }
    },
    salesOrder: {
      findUnique: async ({ where }: { where: { id: string } }) => state.orders.find((order) => order.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Order> }) => {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) throw new Error('Order not found')
        Object.assign(order, data)
        return order
      },
    },
    salesOrderLine: {
      findMany: async ({ where }: { where: { orderId?: string; lineId?: { in: string[] }; id?: { in: string[] } } }) => state.lines
        .filter((line) => where.orderId == null || line.orderId === where.orderId)
        .filter((line) => where.id?.in == null || where.id.in.includes(line.id))
        .map((line) => ({ id: line.id, productId: line.productId, qty: line.qty, sku: line.sku, description: line.description })),
      update: async ({ where, data }: { where: { id: string }; data: { cogsBase?: number | null } }) => {
        const line = state.lines.find((row) => row.id === where.id)
        if (line) line.cogsBase = data.cogsBase
      },
    },
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => {
        const components = state.kits?.[id]
        if (components && components.length > 0) {
          return {
            id,
            type: 'KIT',
            productComponents: components.map((component) => ({
              componentId: component.componentId,
              qty: component.qty,
              component: { sku: component.sku ?? component.componentId, type: 'SIMPLE', oversellAllowed: false },
            })),
          }
        }
        return { id, type: 'SIMPLE', productComponents: [] }
      }),
    },
    orderAllocation: {
      // `lineId: { in: [...] }` is a real predicate the scoped integrity/coverage checks pass;
      // ignoring it would hand them the whole order's rows and let a check that should have been
      // scoped to one shipment's lines pass on the strength of an unrelated allocation.
      findMany: async ({ where }: { where: { orderId: string; lineId?: { in: string[] } } }) => state.allocations
        .filter((allocation) => allocation.orderId === where.orderId)
        .filter((allocation) => where.lineId?.in == null || where.lineId.in.includes(allocation.lineId)),
      findUnique: async ({ where }: { where: { lineId_warehouseId_productId: { lineId: string; warehouseId: string; productId: string } } }) => {
        const key = where.lineId_warehouseId_productId
        return state.allocations.find((allocation) => (
          allocation.lineId === key.lineId
          && allocation.warehouseId === key.warehouseId
          && allocation.productId === key.productId
        )) ?? null
      },
    },
    salesOrderRefundLine: {
      findMany: async ({ where }: { where: { refund: { orderId: string } } }) => (state.refundLines ?? [])
        .filter((refundLine) => refundLine.orderId === where.refund.orderId)
        .map((refundLine) => ({ salesOrderLineId: refundLine.salesOrderLineId, productId: refundLine.productId, qty: refundLine.qty })),
    },
    shipment: {
      findMany: async ({ where, select }: { where: { orderId: string; status?: string }; select?: Record<string, boolean> }) => state.shipments
        .filter((shipment) => shipment.orderId === where.orderId)
        .filter((shipment) => where.status == null || shipment.status === where.status)
        .map((shipment) => {
          if (select?.warehouseId) return {
            warehouseId: shipment.warehouseId,
            trackingNumber: shipment.trackingNumber,
            shippingService: shipment.shippingService,
          }
          if (select?.trackingNumber) return { trackingNumber: shipment.trackingNumber }
          return { id: shipment.id, status: shipment.status }
        }),
      findUnique: async ({ where, include, select }: { where: { id: string }; include?: unknown; select?: Record<string, boolean> }) => {
        const shipment = state.shipments.find((row) => row.id === where.id)
        if (!shipment) return null
        // Projects exactly the keys asked for. Returning only `status` when the caller also asked
        // for `orderId` handed the commitment check an undefined order id, which would have made it
        // silently validate nothing (o3d-4kfh r3).
        if (select?.status) {
          return select.orderId ? { status: shipment.status, orderId: shipment.orderId } : { status: shipment.status }
        }
        if (!include) return shipment
        const order = state.orders.find((row) => row.id === shipment.orderId)!
        return {
          ...shipment,
          order,
          warehouse: { code: 'MAIN' },
          lines: state.shipmentLines
            .filter((line) => line.shipmentId === shipment.id)
            .map((line) => ({
              ...line,
              product: { sku: line.productId.toUpperCase() },
            })),
        }
      },
      create: async ({ data }: { data: { orderId: string; warehouseId: string; status: string; trackingNumber: string | null; shippingService: string | null; lines: { create: Array<{ lineId: string; productId: string; qty: number }> } } }) => {
        const shipment = {
          id: `shipment-${shipmentSequence++}`,
          orderId: data.orderId,
          warehouseId: data.warehouseId,
          status: data.status,
          trackingNumber: data.trackingNumber,
          shippingService: data.shippingService,
          cogsBatchAmount: null,
        }
        state.shipments.push(shipment)
        for (const line of data.lines.create) {
          state.shipmentLines.push({
            id: `shipment-line-${state.shipmentLines.length + 1}`,
            shipmentId: shipment.id,
            lineId: line.lineId,
            productId: line.productId,
            qty: line.qty,
          })
        }
        return { id: shipment.id }
      },
      deleteMany: async ({ where }: { where: { orderId: string; status: string } }) => {
        const pendingIds = state.shipments
          .filter((shipment) => shipment.orderId === where.orderId && shipment.status === where.status)
          .map((shipment) => shipment.id)
        state.shipments = state.shipments.filter((shipment) => !pendingIds.includes(shipment.id))
        state.shipmentLines = state.shipmentLines.filter((line) => !pendingIds.includes(line.shipmentId))
        return { count: pendingIds.length }
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Shipment> }) => {
        const shipment = state.shipments.find((row) => row.id === where.id)
        if (!shipment) throw new Error('Shipment not found')
        Object.assign(shipment, data)
        return shipment
      },
    },
    shipmentLine: {
      findMany: async ({ where, select }: { where: { shipmentId?: string; shipment?: { orderId?: string; status?: string | { not: string } }; lineId?: { in: string[] } }; select?: Record<string, boolean> }) => state.shipmentLines
        // The commitment check reads the transitioning shipment's OWN lines by shipmentId; without
        // this predicate the double would have returned every line on every shipment.
        .filter((line) => where.shipmentId == null || line.shipmentId === where.shipmentId)
        .filter((line) => {
          if (where.shipment == null) return true
          const shipment = state.shipments.find((row) => row.id === line.shipmentId)
          if (!shipment) return false
          if (where.shipment.orderId != null && shipment.orderId !== where.shipment.orderId) return false
          const statusFilter = where.shipment.status
          if (typeof statusFilter === 'string') return shipment.status === statusFilter
          if (statusFilter?.not != null) return shipment.status !== statusFilter.not
          return true
        })
        .filter((line) => where.lineId?.in == null || where.lineId.in.includes(line.lineId))
        .map((line) => {
          if (select?.shipment) {
            const shipment = state.shipments.find((row) => row.id === line.shipmentId)!
            return { lineId: line.lineId, productId: line.productId, qty: line.qty, shipment: { warehouseId: shipment.warehouseId, status: shipment.status } }
          }
          if (select?.costLayerSnapshot) return { lineId: line.lineId, costLayerSnapshot: line.costLayerSnapshot }
          return { lineId: line.lineId, productId: line.productId, qty: line.qty }
        }),
      update: async ({ where, data }: { where: { id: string }; data: { costLayerSnapshot: unknown } }) => {
        const line = state.shipmentLines.find((row) => row.id === where.id)
        if (line) line.costLayerSnapshot = data.costLayerSnapshot
      },
    },
    stockLevel: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          productId: string
          warehouseId: string
          quantity?: { gte: number | string }
          reservedQty?: { gte: number | string }
        }
        data: { quantity?: { decrement: number | string }; reservedQty?: { decrement: number | string } }
      }) => {
        const rows = state.stockLevels
          .filter((row) => row.productId === where.productId && row.warehouseId === where.warehouseId)
          .filter((row) => where.quantity?.gte == null || row.quantity >= Number(where.quantity.gte))
          .filter((row) => where.reservedQty?.gte == null || row.reservedQty >= Number(where.reservedQty.gte))
        for (const row of rows) {
          if (data.quantity) row.quantity -= Number(data.quantity.decrement)
          if (data.reservedQty) row.reservedQty -= Number(data.reservedQty.decrement)
        }
        return { count: rows.length }
      },
    },
    stockMovement: {
      createMany: async ({ data, skipDuplicates }: { data: Array<{ productId: string; qty: number; idempotencyKey?: string | null }>; skipDuplicates?: boolean }) => {
        let count = 0
        for (const entry of data) {
          if (skipDuplicates && entry.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === entry.idempotencyKey)) {
            continue
          }
          const movement = {
            id: `movement-${movementSequence++}`,
            productId: entry.productId,
            qty: entry.qty,
            idempotencyKey: entry.idempotencyKey,
          }
          state.movements.push(movement)
          count += 1
        }
        return { count }
      },
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
        const movement = state.movements.find((row) => row.idempotencyKey === where.idempotencyKey)
        if (!movement) return null
        return { id: movement.id }
      },
      create: async ({ data }: { data: { productId: string; qty: number; idempotencyKey?: string | null; shipmentLineId?: string | null } }) => {
        if (data.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === data.idempotencyKey)) {
          throw uniqueStockMovementError()
        }
        const movement = {
          id: `movement-${movementSequence++}`,
          productId: data.productId,
          qty: data.qty,
          idempotencyKey: data.idempotencyKey,
          shipmentLineId: data.shipmentLineId ?? null,
        }
        state.movements.push(movement)
        return { id: movement.id }
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: { unitCostBase?: string | number | null; totalValueBase?: string | number | null }
      }) => {
        const movement = state.movements.find((row) => row.id === where.id)
        if (!movement) throw new Error('Movement not found')
        Object.assign(movement, data)
        return movement
      },
    },
    costLayer: {
      findMany: async ({ where }: { where: { productId?: string; warehouseId?: string; remainingQty?: { gt: number }; id?: { in: string[] } } }) => state.costLayers
        .filter((layer) => where.productId == null || layer.productId === where.productId)
        .filter((layer) => where.warehouseId == null || layer.warehouseId === where.warehouseId)
        .filter((layer) => where.id?.in == null || where.id.in.includes(layer.id))
        .filter((layer) => where.remainingQty?.gt == null || layer.remainingQty > where.remainingQty.gt)
        .map((layer) => ({ id: layer.id, remainingQty: layer.remainingQty, unitCostBase: layer.unitCostBase })),
      update: async ({ where, data }: { where: { id: string }; data: { remainingQty: { decrement: number } } }) => {
        const layer = state.costLayers.find((row) => row.id === where.id)
        if (!layer) throw new Error('Layer not found')
        layer.remainingQty -= data.remainingQty.decrement
      },
    },
    cogsEntry: {
      createMany: async ({ data }: { data: State['cogsEntries'] }) => {
        state.cogsEntries.push(...data)
      },
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = state.settings[where.key]
        return value == null ? null : { value }
      },
    },
  }
  return client as unknown as ShipmentServiceClient
}

test('shipment workflow has no PICKED status', () => {
  assert.equal(SHIPMENT_STATUSES.includes('PICKED' as never), false)
})

test('confirmSalesOrderShipments creates a full pending shipment from allocations', async () => {
  const state = baseState()
  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  assert.equal(result.createdShipments[0].totalQty, 2)
  assert.equal(state.shipments[0].status, 'PENDING')
  assert.equal(state.shipmentLines[0].qty, 2)
  assert.equal(state.orders[0].status, 'ALLOCATED')
})

test('confirmSalesOrderShipments only creates shipment lines for unshipped allocation quantity', async () => {
  // o3d-4kfh r3 — THE FIXTURE USED TO PUT THE COMMITTED SHIPMENT IN A DIFFERENT WAREHOUSE
  // (warehouse-2) FROM THE ALLOCATION IT WAS SUPPOSED TO BE NETTED OUT OF (warehouse-1).
  // `committedByAllocationKey` is keyed on (lineId, warehouseId, productId), so that mismatch meant
  // the netting branch never fired: the expected `qty` of 2 was simply the whole allocation row,
  // i.e. the value that means NO netting happened. The test asserted the opposite of its own name,
  // and the shape it encoded — a picked shipment with no allocation behind it in that warehouse —
  // is itself the unbacked commitment `findUncoveredCommittedShipment` now rejects.
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    shipments: [{ id: 'shipment-active', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-active', shipmentId: 'shipment-active', lineId: 'line-1', productId: 'product-1', qty: 1 }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 3, sku: 'SKU-1', description: 'Product 1' }],
  })
  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  const pendingLine = state.shipmentLines.find((line) => line.shipmentId !== 'shipment-active')
  assert.equal(pendingLine?.qty, 1, 'the 2-unit row minus the 1 unit already committed to the PICKING shipment')
})

test('o3d-4kfh: confirmSalesOrderShipments is NOT blocked by a partially dispatched allocation', async () => {
  // The allocation row retains what it has dispatched (see the contract in allocation-service.ts),
  // so a 3-unit row with 1 unit already shipped is the CORRECT shape, not over-allocation.
  // validateAllocationIntegrity used to compare that raw 3 against a remaining demand of 2 — with
  // the same shipment subtracted from one side only — and refused, blocking every further
  // shipment of every partially dispatched order.
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 3 }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 3, sku: 'SKU-1', description: 'Product 1' }],
    shipments: [{ id: 'shipment-shipped', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-shipped', shipmentId: 'shipment-shipped', lineId: 'line-1', productId: 'product-1', qty: 1 }],
  })

  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  assert.equal(result.createdShipments[0].totalQty, 2, 'the 2 units that have not shipped yet')
  const pendingLine = state.shipmentLines.find((line) => line.shipmentId !== 'shipment-shipped')
  assert.equal(pendingLine?.qty, 2)
})

test('confirmSalesOrderShipments does not ship refunded quantity from stale allocations', async () => {
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 1 }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
  })
  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  assert.equal(result.createdShipments[0].totalQty, 1) // 2 allocated − 1 refunded
  assert.equal(state.shipmentLines[0].qty, 1)
})

test('transitionShipmentStatus rejects invalid shipment status jumps', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })
  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot transition shipment from PENDING to SHIPPED',
  })
  assert.equal(state.shipments[0].status, 'PENDING')
})

test('transitionShipmentStatus ships stock and stores FIFO COGS snapshot', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    allocations: [{ id: 'allocation-1', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
  })
  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(result.success && result.dispatched, true)
  assert.equal(result.success && result.shipment.status, 'SHIPPED')
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.stockLevels[0].quantity, 0)
  assert.equal(state.stockLevels[0].reservedQty, 0)
  assert.equal(state.costLayers[0].remainingQty, 0)
  assert.equal(state.shipments[0].cogsBatchAmount, 10)
  // Dispatch snapshot is decorated with the line's order allocation + source so the
  // Group B daily batch can relieve the Allocated-Inventory contra (scjz.18).
  assert.deepEqual(state.shipmentLines[0].costLayerSnapshot, [
    { costLayerId: 'layer-1', qty: '2.000000', unitCostBase: '5.000000', orderAllocationId: 'allocation-1', shipmentLineId: 'shipment-line-1', source: 'shipment' },
  ])
  assert.deepEqual(state.cogsEntries, [{
    costLayerId: 'layer-1',
    movementId: 'movement-1',
    qty: '2.000000',
    unitCostBase: '5.000000',
    totalCostBase: '10.000000',
  }])
  assert.equal(state.movements[0].idempotencyKey, 'SALE_DISPATCH:shipmentLine:shipment-line-1')
  assert.equal(state.movements[0].shipmentLineId, 'shipment-line-1')
  assert.equal(state.movements[0].unitCostBase, '5.000000')
  assert.equal(state.movements[0].totalValueBase, '10.000000')
  assert.equal(state.lines[0].cogsBase, 10)
})

test('transitionShipmentStatus treats an existing dispatch movement as an idempotent no-op for stock', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    movements: [{
      id: 'movement-existing',
      productId: 'product-1',
      qty: 2,
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.costLayers[0].remainingQty, 2)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus fails cleanly when dispatch shipment line quantity changes before lock', async () => {
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state, {
    beforeTransaction() {
      state.shipmentLines[0].qty = 1
    },
  }), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment lines changed. Reload and retry.',
  })
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.costLayers[0].remainingQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  assert.equal(state.shipmentLines[0].costLayerSnapshot, undefined)
})

test('transitionShipmentStatus fails cleanly when shipment status changes before dispatch lock', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state, {
    beforeTransaction() {
      state.shipments[0].status = 'PICKING'
    },
  }), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment status changed from PACKED to PICKING. Reload and retry.',
  })
  assert.equal(state.shipments[0].status, 'PICKING')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus fails cleanly when dispatch shipment lines are removed before lock', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state, {
    beforeTransaction() {
      state.shipmentLines = []
    },
  }), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment lines changed. Reload and retry.',
  })
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus fails cleanly when dispatch shipment lines are added before lock', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state, {
    beforeTransaction() {
      state.shipmentLines.push({ id: 'shipment-line-2', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 1 })
    },
  }), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment lines changed. Reload and retry.',
  })
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus rejects multi-warehouse shipment totals above the ordered quantity', async () => {
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
      { id: 'shipment-2', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'PICKING', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 },
      { id: 'shipment-line-2', shipmentId: 'shipment-2', lineId: 'line-1', productId: 'product-1', qty: 1 },
    ],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment quantity for line SKU-1 exceeds ordered quantity. Reload and retry.',
  })
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.costLayers[0].remainingQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus refuses to dispatch refunded units on a shipment built before the refund (o3d-339)', async () => {
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 },
    ],
    // 1 of the 2 ordered units was refunded AFTER this shipment was packed; the shipment was not rebuilt.
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 1 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /packed before the refund/)
  // Nothing dispatched: status unchanged, no stock decrement, no COGS.
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus dispatches a shipment whose quantity is within ordered minus refunds (o3d-339)', async () => {
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    // Only the 1 non-refunded unit is on the shipment (it was rebuilt / built after the refund).
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 1 },
    ],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 1 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.movements.length, 1) // the single still-owed unit dispatched
})

test('transitionShipmentStatus nets refunds at KIT leaf level so fractional components cannot over-dispatch (o3d-339)', async () => {
  // A kit needs 0.1 of comp-1 per kit. Two kits ordered → 0.2 comp-1 packed. One kit is refunded →
  // 0.1 comp-1 refunded, so only 0.1 comp-1 remains shippable. A LINE-level cap (ordered 2 − refunded 1
  // = 1 kit) would wrongly pass the 0.2 component shipment; the leaf-level cap (0.2 − 0.1 = 0.1) rejects
  // it, catching the refunded fractional component.
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 2, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-1', qty: 0.1, sku: 'COMP-1' }] },
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 0.2 },
    ],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'kit-1', qty: 1 }],
    stockLevels: [{ productId: 'comp-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /packed before the refund/)
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.movements.length, 0)
})

test('transitionShipmentStatus lets an unrelated line dispatch after another line was shipped then refunded (o3d-339)', async () => {
  // Line A shipped in full, THEN refunded (a post-delivery return). Its already-SHIPPED qty now exceeds
  // ordered-minus-refunded — but that is historical and must not wedge dispatching the still-owed line B.
  const state = baseState({
    lines: [
      { id: 'line-a', orderId: 'order-1', productId: 'product-a', qty: 2, sku: 'SKU-A', description: 'Product A' },
      { id: 'line-b', orderId: 'order-1', productId: 'product-b', qty: 1, sku: 'SKU-B', description: 'Product B' },
    ],
    // o3d-4kfh r4: the allocation rows behind the committed shipments. The default fixture rows are
    // for line-1/product-1, which this override replaces — leaving them made every committed line
    // here unbacked, which the dispatch-time coverage check now (correctly) refuses. Production
    // cannot reach that state: shipment lines are only ever built from allocation rows.
    allocations: [
      { orderId: 'order-1', lineId: 'line-a', productId: 'product-a', warehouseId: 'warehouse-1', qty: 2 },
      { orderId: 'order-1', lineId: 'line-b', productId: 'product-b', warehouseId: 'warehouse-1', qty: 1 },
    ],
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-a', shipmentId: 'shipment-a', lineId: 'line-a', productId: 'product-a', qty: 2 },
      { id: 'shipment-line-b', shipmentId: 'shipment-b', lineId: 'line-b', productId: 'product-b', qty: 1 },
    ],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-a', productId: 'product-a', qty: 2 }],
    stockLevels: [{ productId: 'product-b', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 }],
    costLayers: [{ id: 'layer-b', productId: 'product-b', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[1].status, 'SHIPPED') // line B dispatched, not wedged by line A's refund
  assert.equal(state.movements.length, 1)
})

test('transitionShipmentStatus fails cleanly when dispatch shipment starts with no lines', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Shipment has no lines to dispatch',
  })
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
})

test('transitionShipmentStatus rolls back when physical stock is insufficient for dispatch', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), {
      shipmentId: 'shipment-1',
      targetStatus: 'SHIPPED',
    }),
    /Insufficient physical or reserved stock to dispatch PRODUCT-1/,
  )

  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.stockLevels[0].reservedQty, 2)
  assert.equal(state.costLayers[0].remainingQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  assert.equal(state.shipmentLines[0].costLayerSnapshot, undefined)
})

test('transitionShipmentStatus rolls back when reserved stock is insufficient for dispatch', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 1 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), {
      shipmentId: 'shipment-1',
      targetStatus: 'SHIPPED',
    }),
    /Insufficient physical or reserved stock to dispatch PRODUCT-1/,
  )

  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2)
  assert.equal(state.stockLevels[0].reservedQty, 1)
  assert.equal(state.costLayers[0].remainingQty, 2)
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  assert.equal(state.shipmentLines[0].costLayerSnapshot, undefined)
})

test('transitionShipmentStatus rolls back earlier line mutations when a later dispatch line has insufficient stock', async () => {
  const state = baseState({
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 1, sku: 'SKU-1', description: 'Product 1' },
      { id: 'line-2', orderId: 'order-1', productId: 'product-2', qty: 1, sku: 'SKU-2', description: 'Product 2' },
    ],
    // o3d-4kfh r4: both committed lines need their backing allocation row, or the dispatch-time
    // coverage check refuses before the stock arithmetic this test is actually about.
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 1 },
      { orderId: 'order-1', lineId: 'line-2', productId: 'product-2', warehouseId: 'warehouse-1', qty: 1 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 1 },
      { id: 'shipment-line-2', shipmentId: 'shipment-1', lineId: 'line-2', productId: 'product-2', qty: 1 },
    ],
    stockLevels: [
      { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 },
      { productId: 'product-2', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0 },
    ],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 },
      { id: 'layer-2', productId: 'product-2', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 7 },
    ],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), {
      shipmentId: 'shipment-1',
      targetStatus: 'SHIPPED',
    }),
    /Insufficient physical or reserved stock to dispatch PRODUCT-2/,
  )

  assert.equal(state.shipments[0].status, 'PACKED')
  assert.deepEqual(state.stockLevels, [
    { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 },
    { productId: 'product-2', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0 },
  ])
  assert.deepEqual(state.costLayers, [
    { id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 },
    { id: 'layer-2', productId: 'product-2', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 7 },
  ])
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  assert.equal(state.shipmentLines[0].costLayerSnapshot, undefined)
  assert.equal(state.shipmentLines[1].costLayerSnapshot, undefined)
  assert.equal(state.shipments[0].cogsBatchAmount, undefined)
  assert.equal(state.lines[0].cogsBase, undefined)
  assert.equal(state.lines[1].cogsBase, undefined)
})

test('transitionShipmentStatus consumes fractional FIFO layers without binary remainder drift', async () => {
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 0.3, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ id: 'allocation-1', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 0.3 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 0.3 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 0.3, reservedQty: 0.3 }],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 0.1, unitCostBase: 0.1 },
      { id: 'layer-2', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 0.2, unitCostBase: 0.2 },
    ],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.costLayers[0].remainingQty, 0)
  assert.equal(state.costLayers[1].remainingQty, 0)
  assert.equal(state.shipments[0].cogsBatchAmount, 0.05)
  assert.deepEqual(state.shipmentLines[0].costLayerSnapshot, [
    { costLayerId: 'layer-1', qty: '0.100000', unitCostBase: '0.100000', orderAllocationId: 'allocation-1', shipmentLineId: 'shipment-line-1', source: 'shipment' },
    { costLayerId: 'layer-2', qty: '0.200000', unitCostBase: '0.200000', orderAllocationId: 'allocation-1', shipmentLineId: 'shipment-line-1', source: 'shipment' },
  ])
  assert.deepEqual(state.cogsEntries, [
    { costLayerId: 'layer-1', movementId: 'movement-1', qty: '0.100000', unitCostBase: '0.100000', totalCostBase: '0.010000' },
    { costLayerId: 'layer-2', movementId: 'movement-1', qty: '0.200000', unitCostBase: '0.200000', totalCostBase: '0.040000' },
  ])
})

test('transitionShipmentStatus rejects shipping when FIFO layers are insufficient', async () => {
  const state = baseState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), {
      shipmentId: 'shipment-1',
      targetStatus: 'SHIPPED',
    }),
    /Insufficient FIFO layers/,
  )
})

test('reconcileOrderAfterShipment leaves order open until every shipment is shipped', async () => {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
      { id: 'shipment-2', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
    ],
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(result, { shouldGenerateInvoice: false, orderId: 'order-1' })
  assert.equal(state.orders[0].status, 'ALLOCATED')
  assert.equal(state.orders[0].trackingNumber, undefined)
})

test('reconcileOrderAfterShipment marks fully shipped order and returns invoice trigger state', async () => {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
      { id: 'shipment-2', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'SHIPPED', trackingNumber: 'TRACK-2', shippingService: null },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(result, { shouldGenerateInvoice: true, orderId: 'order-1' })
  assert.equal(state.orders[0].status, 'SHIPPED')
  assert.equal(state.orders[0].trackingNumber, 'TRACK-1, TRACK-2')
  assert.ok(state.orders[0].shippedAt instanceof Date)
})

test('reconcileOrderAfterShipment does not rewrite terminal orders', async () => {
  const shippedAt = new Date('2026-01-01T00:00:00.000Z')
  const state = baseState({
    orders: [{
      id: 'order-1',
      orderNumber: 'SO-1',
      externalOrderNumber: null,
      status: 'COMPLETED',
      shippedAt,
      trackingNumber: 'EXISTING',
    }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(result, { shouldGenerateInvoice: true, orderId: 'order-1' })
  assert.equal(state.orders[0].status, 'COMPLETED')
  assert.equal(state.orders[0].trackingNumber, 'EXISTING')
  assert.equal(state.orders[0].shippedAt, shippedAt)
})

test('transitionShipmentStatus does not reject a fractional KIT on a rounding ulp (o3d-odu)', async () => {
  // The quantisation half of the guard, which nothing else pins.
  //
  // A kit needing 0.3333 of a component, ordered 0.5 kits, entitles 0.5 x 0.3333 = 0.16665 — a
  // 5-decimal figure. Shipment rows persist at Decimal(12,4), so the row the warehouse actually
  // writes is 0.1667. Comparing the persisted 0.1667 against the raw 0.16665 puts it 0.00005 over,
  // which is 50x the 0.000001 epsilon, so an unquantised guard REJECTS a shipment that is exactly
  // what the kit expansion asked for — the false-reject that made fractional kit dispatch
  // impossible. Rounding the entitlement to the same 4dp boundary the row lives on makes the two
  // comparable.
  //
  // Verified discriminating: dropping roundQuantity from shippableQty turns this red.
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 0.5, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-1', qty: 0.3333, sku: 'COMP-1' }] },
    // o3d-4kfh r4: the leaf allocation the draft was built from, quantised the same way.
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'comp-1', warehouseId: 'warehouse-1', qty: 0.1667 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      // 0.16665 quantised to the Decimal(12,4) column the row persists in.
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 0.1667 },
    ],
    stockLevels: [{ productId: 'comp-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0.1667 }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true, 'a kit shipped at exactly its persisted entitlement must dispatch')
  assert.equal(state.shipments[0].status, 'SHIPPED')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r3 — PENDING -> PICKING is a COMMITMENT, and it must be backed.
//
// A PENDING shipment is deliberately not a commitment: the deallocation refusal lets it through,
// the committed floor in updateAllocation does not count it, and allocateSalesOrder does not retain
// it. That is correct only for as long as nothing can turn an INVALIDATED draft into a commitment.
// This transition is that one thing, so it verifies coverage under the order lock before letting go.
// ---------------------------------------------------------------------------

test('o3d-4kfh r3: PENDING -> PICKING is REFUSED when the allocation has moved to another warehouse', async () => {
  // The exact UI sequence: raise a shipment, Deallocate, Re-Allocate (which lands in a different
  // warehouse), Start Picking. The draft's warehouse has no allocation at all, so committing it
  // would leave a pickable, dispatchable shipment whose units come out of whatever shared
  // (product, warehouse) reservedQty happens to be there.
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-2', qty: 2 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'PICKING' }),
    /commit 2 unit\(s\) but only 0 are allocated there/,
  )
  assert.equal(state.shipments[0].status, 'PENDING', 'the status flip is rolled back with the transaction')
})

test('o3d-4kfh r3: PENDING -> PICKING is REFUSED when the shipment is bigger than the row backing it', async () => {
  // Finding 3’s exact shape: committed 10 against an allocation row of 5. Both sides of
  // validateAllocationIntegrity’s quantity test floor at zero (open coverage 0, remaining demand 0),
  // so the full integrity check passed on it and the residual arithmetic credited only what was
  // left — five committed units with nothing behind them, invisible to every check IMS had.
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 10 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 5 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'PICKING' }),
    /commit 10 unit\(s\) but only 5 are allocated there/,
  )
  assert.equal(state.shipments[0].status, 'PENDING')
})

test('o3d-4kfh r3: the ordinary PENDING -> PICKING is untouched', async () => {
  // The guard must not turn "start picking" into a new operator dead end. This is the shape
  // confirmSalesOrderShipments produces: draft lines copied straight off the allocation rows.
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'PICKING',
  })

  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(state.shipments[0].status, 'PICKING')
})

test('o3d-4kfh r3: a partially committed KIT is refused, a proportional one is allowed', async () => {
  // Per-product coverage alone is not enough for a bundle. Committing 6 of comp-1 with none of
  // comp-2 is covered product-by-product (6 <= 6) while covering ZERO whole kits, so
  // calculateDecimalCoverageByLine credits nothing: those 6 units strand against demand that still
  // reads as entirely unshipped.
  const kitState = (shipmentLines: ShipmentLine[]) => baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 3, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-1', qty: 2, sku: 'COMP-1' }, { componentId: 'comp-2', qty: 1, sku: 'COMP-2' }] },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-1', warehouseId: 'warehouse-1', qty: 6 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-2', warehouseId: 'warehouse-1', qty: 3 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
    shipmentLines,
    stockLevels: [
      { productId: 'comp-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 },
      { productId: 'comp-2', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 3 },
    ],
  })

  const partial = kitState([
    { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 6 },
  ])
  await assert.rejects(
    () => transitionShipmentStatus(createClient(partial), { shipmentId: 'shipment-1', targetStatus: 'PICKING' }),
    /do not commit a complete component set/,
  )
  assert.equal(partial.shipments[0].status, 'PENDING')

  const proportional = kitState([
    { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 6 },
    { id: 'shipment-line-2', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-2', qty: 3 },
  ])
  const result = await transitionShipmentStatus(createClient(proportional), {
    shipmentId: 'shipment-1',
    targetStatus: 'PICKING',
  })
  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(proportional.shipments[0].status, 'PICKING')
})

test('o3d-4kfh r3: confirmSalesOrderShipments refuses an order carrying an unbacked commitment', async () => {
  // The same downward check reached through validateAllocationIntegrity rather than the
  // commitment transition, so BOTH entry points are covered. line-2 carries a PICKING shipment of
  // 10 against an allocation row of 5; line-1 is healthy, which is what keeps `effectiveAllocs`
  // non-empty and drives the run all the way to the integrity check instead of bailing out early.
  const state = baseState({
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 2, sku: 'SKU-1', description: 'Product 1' },
      { id: 'line-2', orderId: 'order-1', productId: 'product-2', qty: 10, sku: 'SKU-2', description: 'Product 2' },
    ],
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 },
      { orderId: 'order-1', lineId: 'line-2', productId: 'product-2', warehouseId: 'warehouse-1', qty: 5 },
    ],
    shipments: [{ id: 'shipment-committed', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-committed', shipmentId: 'shipment-committed', lineId: 'line-2', productId: 'product-2', qty: 10 }],
  })

  await assert.rejects(
    () => confirmSalesOrderShipments(createClient(state), 'order-1'),
    /commit 10 unit\(s\) but only 5 are allocated there/,
  )
})

// ---------------------------------------------------------------------------
// o3d-4kfh r4 (Codex finding 1) — the KIT graph edit that bypassed every proportionality backstop.
//
// The r3 check ran ONLY when the locked source status was PENDING, so it was unreachable from the
// mutation that creates the corruption. A KIT requiring 2xA + 1xB, allocated and PICKING at
// A=2/B=1, re-composed to 2xA + 2xB by the product-component editor, crosses no PENDING seam ever
// again: PICKING -> PACKED skipped the check entirely, and the per-leaf cap in
// validateActiveShipmentTotalsWithinOrder accepts A=2/B=1 because neither leaf EXCEEDS its (now
// larger) demand. IMS dispatched an incomplete kit and nothing reported it.
//
// The mutation itself is now refused at source (findComponentGraphEditBlockers), but the graph can
// still be reached by other routes, so the graph-aware check runs at EVERY transition including
// dispatch.
// ---------------------------------------------------------------------------

/**
 * A KIT line of 1, allocated and committed at A=2 / B=1, whose live recipe has since been changed
 * to require 2 of B. `shipmentStatus` is where the shipment already sits.
 */
function recomposedKitState(shipmentStatus: 'PICKING' | 'PACKED') {
  return baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 1, sku: 'KIT-1', description: 'Kit 1' }],
    // THE EDIT: the live graph now says 2xA + 2xB. The allocation and shipment rows were written
    // against the old 2xA + 1xB and nothing rewrote them.
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2, sku: 'COMP-A' }, { componentId: 'comp-b', qty: 2, sku: 'COMP-B' }] },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 2 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-b', warehouseId: 'warehouse-1', qty: 1 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: shipmentStatus, trackingNumber: null, shippingService: null }],
    shipmentLines: [
      { id: 'shipment-line-a', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-a', qty: 2 },
      { id: 'shipment-line-b', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-b', qty: 1 },
    ],
    stockLevels: [
      { productId: 'comp-a', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 },
      { productId: 'comp-b', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 },
    ],
    costLayers: [
      { id: 'layer-a', productId: 'comp-a', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 },
      { id: 'layer-b', productId: 'comp-b', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 },
    ],
  })
}

test('o3d-4kfh r4: DISPATCH is refused when a live KIT edit left the committed set disproportionate', async () => {
  const state = recomposedKitState('PACKED')

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false, 'an incomplete kit must not dispatch')
  assert.match((result as { error: string }).error, /do not commit a complete component set/)
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.movements.length, 0, 'and no stock moved')
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('o3d-4kfh r4: PICKING -> PACKED is refused too — every transition is checked, not just the first', async () => {
  // The seam that made the r3 residual wrong: gating the check on `locked.status === PENDING` meant
  // an already-committed shipment could never be re-checked, so the corruption sailed through here.
  const state = recomposedKitState('PICKING')

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'PACKED' }),
    /do not commit a complete component set/,
  )
  assert.equal(state.shipments[0].status, 'PICKING', 'the status flip is rolled back with the transaction')
})

test('o3d-4kfh r4: a proportional KIT still dispatches and still packs', async () => {
  // The guard must not become a dead end for healthy orders. Same kit, but the rows match the live
  // graph, so both transitions go through.
  const proportional = () => baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 1, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 2, sku: 'COMP-A' }, { componentId: 'comp-b', qty: 2, sku: 'COMP-B' }] },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 2 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-b', warehouseId: 'warehouse-1', qty: 2 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: null, shippingService: null }],
    shipmentLines: [
      { id: 'shipment-line-a', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-a', qty: 2 },
      { id: 'shipment-line-b', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-b', qty: 2 },
    ],
    stockLevels: [
      { productId: 'comp-a', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 },
      { productId: 'comp-b', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 },
    ],
    costLayers: [
      { id: 'layer-a', productId: 'comp-a', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 },
      { id: 'layer-b', productId: 'comp-b', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 },
    ],
  })

  const packing = proportional()
  const packed = await transitionShipmentStatus(createClient(packing), { shipmentId: 'shipment-1', targetStatus: 'PACKED' })
  assert.equal(packed.success, true, packed.success ? undefined : packed.error)
  assert.equal(packing.shipments[0].status, 'PACKED')

  const dispatching = proportional()
  dispatching.shipments[0].status = 'PACKED'
  const shipped = await transitionShipmentStatus(createClient(dispatching), { shipmentId: 'shipment-1', targetStatus: 'SHIPPED' })
  assert.equal(shipped.success, true, shipped.success ? undefined : shipped.error)
  assert.equal(dispatching.shipments[0].status, 'SHIPPED')
  assert.equal(dispatching.movements.length, 2)
})

test('o3d-4kfh r4: DISPATCH is refused when the allocation row behind a commitment was destroyed', async () => {
  // The flat half of the same check, reached at dispatch. A committed 2 against an allocation row
  // of 0 is invisible to every other consumer — they all compute `qty - committed` floored at zero.
  const state = baseState({
    allocations: [],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /commit 2 unit\(s\) but only 0 are allocated there/)
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.movements.length, 0)
})
