import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmSalesOrderShipments,
  reconcileOrderAfterShipment,
  transitionShipmentStatus,
  type ShipmentServiceClient,
} from '@/lib/domain/sales/shipment-service'

type Order = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  shippedAt?: Date | null
  trackingNumber?: string | null
}
type OrderLine = { id: string; orderId: string; productId: string; qty: number; sku: string; description: string; cogsBase?: number | null }
type Allocation = { orderId: string; lineId: string; productId: string; warehouseId: string; qty: number }
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

type State = {
  orders: Order[]
  lines: OrderLine[]
  allocations: Allocation[]
  shipments: Shipment[]
  shipmentLines: ShipmentLine[]
  stockLevels: StockLevel[]
  costLayers: CostLayer[]
  movements: Array<{ id: string; productId: string; qty: number }>
  cogsEntries: Array<{ costLayerId: string; movementId: string; qty: number; unitCostBase: number; totalCostBase: number }>
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
    $queryRaw: async () => [],
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
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({
        id,
        type: 'SIMPLE',
        productComponents: [],
      })),
    },
    orderAllocation: {
      findMany: async ({ where }: { where: { orderId: string } }) => state.allocations
        .filter((allocation) => allocation.orderId === where.orderId),
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
        if (select?.status) return { status: shipment.status }
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
      findMany: async ({ where, select }: { where: { shipment?: { orderId: string; status?: { not: string } }; lineId?: { in: string[] } }; select?: Record<string, boolean> }) => state.shipmentLines
        .filter((line) => {
          if (where.shipment == null) return true
          const shipment = state.shipments.find((row) => row.id === line.shipmentId)
          if (!shipment || shipment.orderId !== where.shipment.orderId) return false
          return where.shipment.status?.not == null || shipment.status !== where.shipment.status.not
        })
        .filter((line) => where.lineId?.in == null || where.lineId.in.includes(line.lineId))
        .map((line) => {
          if (select?.shipment) {
            const shipment = state.shipments.find((row) => row.id === line.shipmentId)!
            return { lineId: line.lineId, productId: line.productId, qty: line.qty, shipment: { warehouseId: shipment.warehouseId } }
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
      create: async ({ data }: { data: { productId: string; qty: number } }) => {
        const movement = { id: `movement-${movementSequence++}`, productId: data.productId, qty: data.qty }
        state.movements.push(movement)
        return { id: movement.id }
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
  const state = baseState({
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
    shipments: [{ id: 'shipment-active', orderId: 'order-1', warehouseId: 'warehouse-2', status: 'PICKING', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-active', shipmentId: 'shipment-active', lineId: 'line-1', productId: 'product-1', qty: 1 }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 3, sku: 'SKU-1', description: 'Product 1' }],
  })
  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  const pendingLine = state.shipmentLines.find((line) => line.shipmentId !== 'shipment-active')
  assert.equal(pendingLine?.qty, 2)
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
  assert.deepEqual(state.shipmentLines[0].costLayerSnapshot, [
    { costLayerId: 'layer-1', qty: 2, unitCostBase: 5 },
  ])
  assert.deepEqual(state.cogsEntries, [{
    costLayerId: 'layer-1',
    movementId: 'movement-1',
    qty: 2,
    unitCostBase: 5,
    totalCostBase: 10,
  }])
  assert.equal(state.lines[0].cogsBase, 10)
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
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 0.3 }],
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
    { costLayerId: 'layer-1', qty: 0.1, unitCostBase: 0.1 },
    { costLayerId: 'layer-2', qty: 0.2, unitCostBase: 0.2 },
  ])
  assert.deepEqual(state.cogsEntries, [
    { costLayerId: 'layer-1', movementId: 'movement-1', qty: 0.1, unitCostBase: 0.1, totalCostBase: 0.01 },
    { costLayerId: 'layer-2', movementId: 'movement-1', qty: 0.2, unitCostBase: 0.2, totalCostBase: 0.04 },
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
