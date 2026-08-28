import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  confirmSalesOrderShipments,
  discardCancelledOrderShipmentsInTx,
  reconcileOrderAfterShipment,
  reopenShipmentForRepack,
  transitionShipmentStatus,
  type ShipmentServiceClient,
} from '@/lib/domain/sales/shipment-service'
import {
  claimIntegrationOutboxWork,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import { processRefundReservationReleaseOutbox } from '@/lib/domain/sales/refund-reservation-release-outbox'
import { SHIPMENT_STATUSES } from '@/lib/domain/workflows/status-types'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

type Order = {
  id: string
  orderNumber: string
  externalOrderNumber: string | null
  status: string
  shippedAt?: Date | null
  trackingNumber?: string | null
  /**
   * o3d-rbyg [wdraw]: the EU right-of-withdrawal markers. `withdrawalApprovedAt` is terminal (the
   * order is cancelled); `withdrawalHoldAt` is the SUBMITTED request, still being decided — and the
   * dispatch reads both under the order lock, because that is the only place the manual shipment
   * paths pass through.
   */
  withdrawalHoldAt?: Date | null
  withdrawalApprovedAt?: Date | null
  /**
   * o3d-0i5y: the orthogonal refund disposition. FULL is UNCONDITIONAL zero demand in the
   * completion check, matching selectOrdersNeedingAllocation (o3d-jby) — absent means NONE.
   */
  refundStatus?: string | null
}
type OrderLine = {
  id: string
  orderId: string
  productId: string
  qty: number
  sku: string
  description: string
  cogsBase?: number | null
  /** o3d-kouj: the line's PINNED fulfilment recipe; undefined is the NULL of a never-allocated line. */
  fulfillmentRequirements?: unknown
}
type Allocation = {
  id?: string
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
  qty: number
  /**
   * o3d-4kfh r6: the graph version this row was expanded against. The column is NOT NULL DEFAULT 0
   * and `state.graphVersions` defaults to 0 as well, so an ordinary fixture is matched and the CAS
   * is inert — a fixture has to say so explicitly to make it fire.
   */
  fulfillmentGraphVersion?: number
}
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
  /**
   * o3d-2k5r r7: the order's REFUNDS (not their lines), and the refund-reservation-release backstop
   * rows keyed off them. These are what `countUnfinishedRefundReservationReleases` reads, and they
   * are a DIFFERENT fact from `refundLines`: the lines say how much the dispatch cap must net off,
   * these say whether the reservation release behind that refund has actually happened yet.
   * Absent means "no refunds", which is every fixture that predates the dispatch fence.
   *
   * o3d-2k5r r8: the rest of the outbox row is optional so the SAME objects can be handed to the
   * real `claimIntegrationOutboxWork` (see `releaseOutboxClient`). The concurrency regression needs
   * the drain's claim and the dispatch fence's count to be looking at one row, not two copies.
   */
  refunds?: Array<{ id: string; orderId: string }>
  releaseOutbox?: Array<
    { idempotencyKey: string; status: string } & Partial<Omit<IntegrationOutboxRow, 'idempotencyKey' | 'status'>>
  >
  // Kit/BOM graph: productId -> its component requirements. Absent products are treated as SIMPLE.
  kits?: Record<string, Array<{ componentId: string; qty: number; sku?: string }>>
  /**
   * o3d-4kfh r6: productId -> `Product.fulfillmentGraphVersion`, served from the GRAPH read
   * (`product.findMany`) — the same statement as the component list, as in Postgres.
   */
  graphVersions?: Record<string, number>
  /**
   * o3d-4kfh r7 (Codex finding 1): THE OTHER SNAPSHOT — what a `salesOrderLine.findMany` selecting
   * `product: { fulfillmentGraphVersion }` returns, which is a statement EARLIER than the graph
   * read and can therefore see a different value.
   *
   * Absent means "the two agree" (the uncontended case). A fixture that sets it to something else
   * models a component-graph edit committing between the two statements, which is the race r6's
   * validation reopened. The double still OFFERS the field so that reverting the fix makes the test
   * pass again rather than crash.
   */
  lineProductGraphVersions?: Record<string, number>
  /** o3d-4kfh r6: in-transaction audit rows, and the order they were written in. */
  activityLogs?: Array<Record<string, unknown>>
  txWriteOrder?: string[]
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
    activityLogs: [],
    txWriteOrder: [],
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
        // o3d-4kfh r7: production no longer SELECTS this — the CAS reads the version off the graph
        // node instead, so that the version and the requirements come from one statement. The
        // double keeps answering it (from `lineProductGraphVersions`, defaulting to the graph's
        // value) purely so a revert of that fix is observable rather than a crash.
        .map((line) => ({
          id: line.id,
          productId: line.productId,
          qty: line.qty,
          sku: line.sku,
          description: line.description,
          // o3d-kouj: the pinned recipe the dispatch cap and the build-time refund netting are now
          // judged against. Answered from the SAME rows the fixture declares, so a test can pin a
          // line to a recipe the catalogue no longer has.
          fulfillmentRequirements: line.fulfillmentRequirements ?? null,
          product: {
            fulfillmentGraphVersion:
              state.lineProductGraphVersions?.[line.productId] ?? state.graphVersions?.[line.productId] ?? 0,
          },
        })),
      update: async ({ where, data }: { where: { id: string }; data: { cogsBase?: number | null } }) => {
        const line = state.lines.find((row) => row.id === where.id)
        if (line && 'cogsBase' in data) line.cogsBase = data.cogsBase
      },
    },
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => {
        const components = state.kits?.[id]
        if (components && components.length > 0) {
          return {
            id,
            type: 'KIT',
            fulfillmentGraphVersion: state.graphVersions?.[id] ?? 0,
            productComponents: components.map((component) => ({
              componentId: component.componentId,
              qty: component.qty,
              component: { sku: component.sku ?? component.componentId, type: 'SIMPLE', oversellAllowed: false },
            })),
          }
        }
        return {
          id,
          type: 'SIMPLE',
          fulfillmentGraphVersion: state.graphVersions?.[id] ?? 0,
          productComponents: [],
        }
      }),
    },
    orderAllocation: {
      // `lineId: { in: [...] }` is a real predicate the scoped integrity/coverage checks pass;
      // ignoring it would hand them the whole order's rows and let a check that should have been
      // scoped to one shipment's lines pass on the strength of an unrelated allocation.
      findMany: async ({ where }: { where: { orderId: string; lineId?: { in: string[] } } }) => state.allocations
        .filter((allocation) => allocation.orderId === where.orderId)
        .filter((allocation) => where.lineId?.in == null || where.lineId.in.includes(allocation.lineId))
        // The column is NOT NULL DEFAULT 0, so a real read never returns undefined.
        .map((allocation) => ({
          ...allocation,
          fulfillmentGraphVersion: allocation.fulfillmentGraphVersion ?? 0,
        })),
      findUnique: async ({ where }: { where: { lineId_warehouseId_productId: { lineId: string; warehouseId: string; productId: string } } }) => {
        const key = where.lineId_warehouseId_productId
        return state.allocations.find((allocation) => (
          allocation.lineId === key.lineId
          && allocation.warehouseId === key.warehouseId
          && allocation.productId === key.productId
        )) ?? null
      },
    },
    salesOrderRefund: {
      findMany: async ({ where }: { where: { orderId: string } }) => (state.refunds ?? [])
        .filter((refund) => refund.orderId === where.orderId)
        .map((refund) => ({ id: refund.id })),
    },
    integrationOutbox: {
      // o3d-2k5r r7: BOTH `in` filters are honoured, because both are load-bearing. A double that
      // ignored `idempotencyKey.in` would count another order's row; one that ignored `status.in`
      // would count a SUCCEEDED row and report a recovery that is already finished as outstanding.
      // Either way the fence would refuse dispatches it must let through, and the narrowness tests
      // below would pass without the narrowing existing.
      //
      // Each filter is OPTIONAL here, exactly as it is in Postgres: a `count` that omits one counts
      // more rows, it does not fail. Requiring them would turn "the production read lost a filter"
      // into a TypeError in the double, which fails every test at once and so proves nothing about
      // which one the filter was actually holding up.
      //
      // o3d-2k5r r9: the status filter now arrives in TWO shapes and the double evaluates both the
      // way Postgres does — the operator control asks `IN (...)`, the dispatch fence asks
      // `NOT (status = 'SUCCEEDED')`. A double that understood only `in` could never observe an
      // unknown status fencing, because it would drop such a row on both sides.
      count: async ({ where }: {
        where: {
          connector: string
          operation: string
          idempotencyKey?: { in: string[] }
          status?: { in: string[] } | { not: string }
        }
      }) => (state.releaseOutbox ?? []).filter((row) => (
        (where.idempotencyKey === undefined || where.idempotencyKey.in.includes(row.idempotencyKey))
        && (where.status === undefined || ('in' in where.status
          ? where.status.in.includes(row.status)
          : row.status !== where.status.not))
      )).length,
    },
    salesOrderRefundLine: {
      findMany: async ({ where }: { where: { refund: { orderId: string } } }) => (state.refundLines ?? [])
        .filter((refundLine) => refundLine.orderId === where.refund.orderId)
        .map((refundLine) => ({ salesOrderLineId: refundLine.salesOrderLineId, productId: refundLine.productId, qty: refundLine.qty })),
    },
    shipment: {
      // o3d-4kfh r6: the `{ status: { in: [...] } }` shape is real — `discardCancelledOrderShipmentsInTx`
      // asks for exactly PENDING/PICKING/PACKED, and a double that ignored it (or answered it with
      // every shipment) could not tell a repair that spares SHIPPED from one that deletes it.
      // o3d-2k5r r6: `reopenShipmentForRepack` asks for the order's OTHER shipments under the lock
      // (`id: { not: shipmentId }`). A double that ignored that exclusion would answer with the
      // shipment being reopened as well — and since a PACKED shipment is not unreopenable, the
      // sibling check would still pass and the test would prove nothing.
      findMany: async ({ where, select }: {
        where: { orderId: string; status?: string | { in: string[] } | { not: string }; id?: { not: string } }
        select?: Record<string, unknown>
      }) => state.shipments
        .filter((shipment) => shipment.orderId === where.orderId)
        .filter((shipment) => where.id?.not === undefined || shipment.id !== where.id.not)
        .filter((shipment) => {
          if (where.status == null) return true
          if (typeof where.status === 'string') return shipment.status === where.status
          if ('not' in where.status) return shipment.status !== where.status.not
          return where.status.in.includes(shipment.status)
        })
        .map((shipment) => {
          if (select?.lines) return {
            id: shipment.id,
            status: shipment.status,
            warehouseId: shipment.warehouseId,
            trackingNumber: shipment.trackingNumber,
            shippingService: shipment.shippingService,
            lines: state.shipmentLines
              .filter((line) => line.shipmentId === shipment.id)
              .map((line) => ({ id: line.id })),
          }
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
        // o3d-2k5: `reopenShipmentForRepack` asks for the shipment, its lines AND its parent order in
        // one projection. Checked BEFORE the narrow `select.status` branch below, which would
        // otherwise answer it with a two-key object and hand the reopen an undefined order status —
        // silently skipping the cancelled-order refusal.
        if (select?.lines && select?.order) {
          const parent = state.orders.find((row) => row.id === shipment.orderId)
          return {
            id: shipment.id,
            orderId: shipment.orderId,
            status: shipment.status,
            trackingNumber: shipment.trackingNumber,
            shippingService: shipment.shippingService,
            lines: state.shipmentLines
              .filter((line) => line.shipmentId === shipment.id)
              .map((line) => ({ id: line.id })),
            order: parent
              ? {
                status: parent.status,
                orderNumber: parent.orderNumber,
                externalOrderNumber: parent.externalOrderNumber,
              }
              : null,
          }
        }
        if (select?.status) {
          return select.orderId ? { status: shipment.status, orderId: shipment.orderId } : { status: shipment.status }
        }
        // o3d-2k5: the unlocked `{ orderId: true }` pre-read. Projected rather than returning the
        // whole row, so a test cannot pass by reading a field the production select never asked for.
        if (select?.orderId) return { orderId: shipment.orderId }
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
      deleteMany: async ({ where }: { where: { orderId?: string; status?: string; id?: { in: string[] } } }) => {
        state.txWriteOrder?.push('shipment.deleteMany')
        const doomedIds = state.shipments
          .filter((shipment) => where.orderId == null || shipment.orderId === where.orderId)
          .filter((shipment) => where.status == null || shipment.status === where.status)
          .filter((shipment) => where.id == null || where.id.in.includes(shipment.id))
          .map((shipment) => shipment.id)
        state.shipments = state.shipments.filter((shipment) => !doomedIds.includes(shipment.id))
        // The FK cascade takes the lines with it; leaving orphans behind would let a deleted
        // shipment keep showing up in every shipmentLine read.
        state.shipmentLines = state.shipmentLines.filter((line) => !doomedIds.includes(line.shipmentId))
        return { count: doomedIds.length }
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
    activityLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.activityLogs?.push(data)
        state.txWriteOrder?.push('activityLog.create')
        return data
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

test('transitionShipmentStatus refuses to dispatch under a SUBMITTED withdrawal hold (o3d-rbyg r2)', async () => {
  // ROUND 2, Codex finding 5: THE SIXTH FULFILMENT PATH. Only the APPROVED marker was checked here,
  // so a withdrawal the customer had filed and nobody had decided yet did not stop a manual
  // dispatch — and this transaction is the ONLY thing the manual paths pass through. The WMS paths
  // never showed it, because a hold pulls the order back out of the warehouse.
  const state = baseState({
    orders: [{
      id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ON_HOLD',
      withdrawalHoldAt: new Date('2026-08-19T09:00:00.000Z'),
    }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    allocations: [{ id: 'allocation-1', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match(
    result.success ? '' : String(result.error),
    /right-of-withdrawal hold/,
    'the refusal names the hold rather than failing generically',
  )
  assert.match(
    result.success ? '' : String(result.error),
    /Release the withdrawal hold on the order/,
    'and it names the remedy an operator can actually perform',
  )
  // Nothing irreversible happened: the goods are still on the shelf and no despatch was recorded.
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 2, 'no stock was relieved')
  assert.equal(state.stockLevels[0].reservedQty, 2, 'and the reservation still stands')
  assert.deepEqual(state.movements, [], 'no dispatch movement was written')
})

test('transitionShipmentStatus still refuses an APPROVED withdrawal, and says so differently (o3d-rbyg r2)', async () => {
  // The pair, pinned together: an approval is TERMINAL (the order is cancelled and the goods are
  // never going), so it throws; a submitted hold is a decision in progress, so it is a refusal with
  // a remedy. Collapsing the two would either make an approved withdrawal look retryable or make a
  // hold look permanent.
  const state = baseState({
    orders: [{
      id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PROCESSING',
      withdrawalApprovedAt: new Date('2026-08-19T09:00:00.000Z'),
    }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
    allocations: [{ id: 'allocation-1', orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 2 }],
  })

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'SHIPPED' }),
    /withdrawal request was approved/,
  )
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.deepEqual(state.movements, [])
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
    // o3d-0i5y: the two shipments now carry the LINES that cover the ordered qty (2). The fixture
    // previously had none at all, so it described two despatched shipments that shipped nothing —
    // exactly the state the completion check now refuses, and it would have passed either way.
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 1 },
      { id: 'shipment-line-2', shipmentId: 'shipment-2', lineId: 'line-1', productId: 'product-1', qty: 1 },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.deepEqual(result, { shouldGenerateInvoice: true, orderId: 'order-1' })
  assert.equal(state.orders[0].status, 'SHIPPED')
  assert.equal(state.orders[0].trackingNumber, 'TRACK-1, TRACK-2')
  assert.ok(state.orders[0].shippedAt instanceof Date)
})

// --- o3d-0i5y: "every shipment shipped" is not "order complete" ---------------------------------
//
// Partial fulfilment is intentional here — you ship what you have — but the remainder did NOT stay
// outstanding: once every EXISTING shipment reached SHIPPED the whole order was promoted to SHIPPED
// without ever comparing shipped qty against ordered demand, and SHIPPED only goes on to
// COMPLETED/DELIVERED, so nothing ever revisited the unshipped lines.

test('o3d-0i5y: an order that shipped short is NOT promoted to SHIPPED', async () => {
  // 10 ordered, only 4 allocated and shipped, no further stock. The order must not read as complete.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  // Held in the pre-shipment status it already had, not moved to SHIPPED and not given a shippedAt.
  assert.equal(state.orders[0].status, 'ALLOCATED')
  assert.equal(state.orders[0].shippedAt, undefined)
  assert.equal(state.orders[0].trackingNumber, undefined)
  // and not invoiced on the on_shipped trigger — billing for units that never left.
  assert.equal(result.shouldGenerateInvoice, false)
  // The refusal is REPORTED, with the specific line and the specific outstanding quantity, so the
  // caller can raise it for an operator. Nothing re-allocates a shipped-short order on its own.
  assert.deepEqual(result.shortfall, [{
    lineId: 'line-1',
    label: 'SKU-1',
    productId: 'product-1',
    orderedQty: 10,
    refundedQty: 0,
    shippedQty: 4,
    outstandingQty: 6,
  }])
})

test('o3d-0i5y: the shortfall basis NETS REFUNDS, so a partly refunded order still completes', async () => {
  // 10 ordered, 6 refunded, 4 shipped. Comparing against GROSS ordered qty would leave this order
  // permanently short and never closeable — the mistake o3d-jby fixed in the coverage selector.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED', refundStatus: 'PARTIAL' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 6 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.equal(result.shortfall, undefined)
  assert.equal(result.shouldGenerateInvoice, true)
  assert.equal(state.orders[0].status, 'SHIPPED')
})

test('o3d-0i5y: a FULL refund is unconditional zero demand, not a permanent shortfall', async () => {
  // A monetary-only or shipping-only refund line nets NOTHING per line, so without the
  // refundStatus short-circuit (the same one selectOrdersNeedingAllocation uses) a fully refunded
  // order would read as short forever and could never be closed automatically.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED', refundStatus: 'FULL' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    // Deliberately unlinked: no salesOrderLineId, so per-line netting cancels nothing.
    refundLines: [{ orderId: 'order-1', salesOrderLineId: null, productId: null, qty: 10 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 },
    ],
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.equal(result.shortfall, undefined)
  assert.equal(state.orders[0].status, 'SHIPPED')
})

test('o3d-0i5y: the shortfall is measured in LEAF units, so a half-shipped KIT is caught', async () => {
  // 2 kits ordered, each 2xA + 1xB. A shipment carrying one whole kit's worth (2xA + 1xB) is a
  // proportional, individually-valid set — the dispatch cap accepts it because no leaf EXCEEDS
  // demand — but it is only half the order. Comparing parent-kit qty against component shipment
  // rows would have made this read as complete.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 2, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'product-a', qty: 2 }, { componentId: 'product-b', qty: 1 }] },
    allocations: [],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-a', qty: 2 },
      { id: 'shipment-line-2', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-b', qty: 1 },
    ],
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  assert.equal(state.orders[0].status, 'ALLOCATED')
  // Named per LEAF product — the components actually short, not the kit.
  assert.deepEqual(
    result.shortfall?.map((line) => [line.productId, line.outstandingQty]).sort(),
    [['product-a', 2], ['product-b', 1]].sort(),
  )
})

// --- o3d-0i5y r2: the completion check is IMS's answer, and IMS does not always own the question --
//
// An externally fulfilled order (WooCommerce "completed", or a WMS/3PL dispatch) is completed by
// the system that shipped it — the WMS dispatch sweep reaches its own per-part verdict in
// reconcileSplitOrder and only applies a dispatch once EVERY part has despatched. The IMS shipment
// rows on such an order are back-filled by applyExternalFulfillmentUpdate from whatever IMS stock
// was on hand, so they routinely under-cover the ordered qty for reasons that say nothing about
// what the 3PL shipped. Running the shortfall check over them contradicted the owner: the order
// was held out of SHIPPED, the storefront completion push (and the customer despatch email it
// fires) was suppressed, and a `shipped_short` WARNING was raised on EVERY external dispatch.

test('o3d-0i5y r2: EXTERNAL completion authority promotes the order — the shortfall check does not run', async () => {
  // The EXACT fixture the IMS-authority test above holds open: 10 ordered, 4 shipped. The only
  // difference is who is reporting the dispatch.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(
    createClient(state),
    { orderId: 'order-1' },
    undefined,
    { completionAuthority: 'EXTERNAL' },
  )

  assert.equal(state.orders[0].status, 'SHIPPED')
  assert.ok(state.orders[0].shippedAt instanceof Date)
  assert.equal(state.orders[0].trackingNumber, 'TRACK-1')
  // No shortfall REPORTED, which is the specific thing that matters: it is what the caller turns
  // into the `shipped_short` WARNING, so a present-but-ignored shortfall would still be a false alarm.
  assert.equal(result.shortfall, undefined)
  assert.equal(result.shouldGenerateInvoice, true)
})

test('o3d-0i5y r2: authority DEFAULTS to IMS — an options object that omits it still holds a short order', async () => {
  // Pins the default against the `options?.completionAuthority ?? 'IMS'` reading specifically: a
  // caller may pass options for an unrelated reason, and that must not silently disable the check.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 4 }],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 },
    ],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const result = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' }, undefined, {})

  assert.equal(state.orders[0].status, 'ALLOCATED')
  assert.equal(result.shouldGenerateInvoice, false)
  assert.deepEqual(
    result.shortfall?.map((line) => [line.lineId, line.outstandingQty]),
    [['line-1', 6]],
  )
})

// ---------------------------------------------------------------------------
// o3d-0i5y r3 — THE REFUSAL NEEDED A REMEDY THAT WORKS FROM WHERE IT LEAVES THE ORDER.
//
// r1 stopped promoting a short order and left it in its pre-shipment status, then told the operator
// to "allocate and ship the remainder". That advice was only ever true from ALLOCATED. From PICKING
// or PACKING the residual allocation could be built, but `confirmSalesOrderShipments` ended by
// forcing the order to ALLOCATED — a DEMOTION those statuses have no transition for — so the confirm
// threw and the order was stranded: no way forward and no way back.
// ---------------------------------------------------------------------------

test('o3d-0i5y r3: an order HELD SHORT AT PICKING can still have its residual shipment created', async () => {
  // The exact shape r1 produces: 10 ordered, 4 despatched, the order left at PICKING. The allocation
  // row holds the WHOLE claim (10 = 6 outstanding + 4 committed) per the o3d-4kfh contract, which is
  // what a re-allocation of this order writes.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PICKING' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 }],
  })

  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.shipmentCount, 1)
  assert.equal(result.createdShipments[0].totalQty, 6, 'the 10-unit claim minus the 4 already despatched')
  const residual = state.shipments.find((shipment) => shipment.id !== 'shipment-1')
  assert.equal(residual?.status, 'PENDING')
  // And the order KEEPS the status it had. The floor is a floor: an order already past ALLOCATED is
  // not dragged back to it.
  assert.equal(state.orders[0].status, 'PICKING')
})

test('o3d-0i5y r3: an order HELD SHORT AT PACKING can still have its residual shipment created', async () => {
  // PACKING is the worse of the two: it has no edge back to PICKING either, so before this the order
  // could not even be walked backwards through the fulfilment states to reach the remedy.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PACKING' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 }],
  })

  const result = await confirmSalesOrderShipments(createClient(state), 'order-1')

  assert.equal(result.createdShipments[0].totalQty, 6)
  assert.equal(state.orders[0].status, 'PACKING')
})

test('o3d-0i5y r3: THE WHOLE RECOVERY CLOSES — a short order at PICKING reaches SHIPPED through its residual', async () => {
  // End to end, because a confirm that succeeds and then cannot be dispatched, or a dispatch that
  // still will not release the hold, is not a remedy. 10 ordered, 4 already gone, 6 still on hand.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'PICKING' }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 10, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 10 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 4 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 6, reservedQty: 6 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 6, unitCostBase: 5 }],
    settings: { invoice_trigger: 'on_shipped' },
  })

  const confirmed = await confirmSalesOrderShipments(createClient(state), 'order-1')
  const residualId = confirmed.createdShipments[0].id

  for (const targetStatus of ['PICKING', 'PACKED', 'SHIPPED'] as const) {
    const moved = await transitionShipmentStatus(createClient(state), { shipmentId: residualId, targetStatus })
    assert.equal(moved.success, true, moved.success ? undefined : `${targetStatus}: ${moved.error}`)
  }

  const reconciled = await reconcileOrderAfterShipment(createClient(state), { orderId: 'order-1' })

  // The hold RELEASES on its own once the order is whole again — no operator override, no closing it
  // short. PICKING -> SHIPPED is a legal transition, so nothing has to be unwound first.
  assert.equal(reconciled.shortfall, undefined)
  assert.equal(state.orders[0].status, 'SHIPPED')
  // ...and the invoice the hold was suppressing is finally due.
  assert.equal(reconciled.shouldGenerateInvoice, true)
})

test('o3d-0i5y r3: a CANCELLED order is refused IN WORDS, not by an accidental transition failure', async () => {
  // Before the floor became a floor, `CANCELLED -> ALLOCATED` being an illegal edge was the only
  // thing stopping a cancelled order from growing new shipments — an accident, and one that reported
  // itself as a state-machine complaint. Removing the incidental cover means stating the refusal.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED' }],
  })

  await assert.rejects(
    () => confirmSalesOrderShipments(createClient(state), 'order-1'),
    (error: Error) => {
      assert.match(error.message, /Cannot create shipments for a cancelled order/)
      assert.match(error.message, /Discard the shipments still on it/)
      return true
    },
  )
  assert.equal(state.shipments.length, 0)
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

test('o3d-i4qd: a fractional KIT with TWO components dispatches — the committed set IS complete', async () => {
  // `findUncoveredCommittedShipment` ran the same unquantised proportionality test
  // `validateAllocationIntegrity` did, so it refused the same sets — but at DISPATCH, after the
  // goods were picked and packed, with the operator holding the box.
  //
  // 0.5 kits of (0.3333 x comp-1 + 1 x comp-2). comp-1's entitlement is 0.16665, which
  // `Decimal(12,4)` stores as 0.1667; comp-2's is exactly 0.5. Inferring one coverage from comp-2
  // and multiplying it back out expects comp-1 = 0.16665, sees 0.1667, and calls a set that is as
  // proportional as the column permits "not a complete component set".
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 0.5, sku: 'KIT-1', description: 'Kit 1' }],
    kits: {
      'kit-1': [
        { componentId: 'comp-1', qty: 0.3333, sku: 'COMP-1' },
        { componentId: 'comp-2', qty: 1, sku: 'COMP-2' },
      ],
    },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-1', warehouseId: 'warehouse-1', qty: 0.1667 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-2', warehouseId: 'warehouse-1', qty: 0.5 },
    ],
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    shipmentLines: [
      { id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 0.1667 },
      { id: 'shipment-line-2', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-2', qty: 0.5 },
    ],
    stockLevels: [
      { productId: 'comp-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0.1667 },
      { productId: 'comp-2', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0.5 },
    ],
    costLayers: [
      { id: 'layer-1', productId: 'comp-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 },
      { id: 'layer-2', productId: 'comp-2', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 7 },
    ],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true, JSON.stringify(result))
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

// ---------------------------------------------------------------------------
// o3d-4kfh r6 (Codex finding 1) — the UNIFORM RESCALE the proportionality backstop cannot see.
//
// r5 stated that `validateCommittedShipmentCoverage` was the correctness boundary. It is not.
// Interleave an allocation with the component editor:
//
//   allocation reads 2xA + 1xB and computes A=2 / B=1;
//   the editor sees no committed allocation (that transaction is still open) and rescales the kit
//   to 4xA + 2xB;
//   the allocation commits A=2 / B=1.
//
// Coverage against the NEW graph is 0.5 and the expected component set at coverage 0.5 is exactly
// A=2 / B=1 — which is what is committed. The per-leaf dispatch cap sees neither leaf exceeding
// A=4 / B=2. Both pass, and half the current kit ships. Proportionality against a MUTABLE current
// graph cannot distinguish this race from a legitimate partial shipment, because on the numbers it
// is not distinguishable. Only a version that moves under a uniform rescale can.
// ---------------------------------------------------------------------------

/**
 * A KIT line of 1 whose allocation and PACKED shipment were both written against 2xA + 1xB, and
 * whose live recipe is now the UNIFORM double 4xA + 2xB.
 *
 * `graphVersion` is the product's current version; the allocation rows stamp 0 (what the allocation
 * read). Passing 0 models "the edit never happened"; passing 1 models the race.
 */
function uniformlyRescaledKitState(graphVersion: number) {
  return baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 1, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 4, sku: 'COMP-A' }, { componentId: 'comp-b', qty: 2, sku: 'COMP-B' }] },
    graphVersions: { 'kit-1': graphVersion },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 2, fulfillmentGraphVersion: 0 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-b', warehouseId: 'warehouse-1', qty: 1, fulfillmentGraphVersion: 0 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
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

test('o3d-4kfh r6 (finding 1): a uniform kit rescale DISPATCHES CLEANLY when only proportionality guards it', async () => {
  // THE DEMONSTRATION, not an aspiration: with the version stamp matching (as it did before r6,
  // when there was no stamp at all) every check IMS has passes and the goods leave. This test is
  // what makes the refusal below meaningful — without it, "dispatch is refused" would prove nothing
  // about WHY.
  const state = uniformlyRescaledKitState(0)

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(
    result.success,
    true,
    result.success ? undefined : `proportionality was supposed to accept this: ${result.error}`,
  )
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.stockLevels[0].quantity, 0, 'half a kit really did ship')
})

test('o3d-4kfh r6 (finding 1): the graph-version CAS refuses that dispatch', async () => {
  const state = uniformlyRescaledKitState(1)

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false, 'a rescaled kit must not dispatch against rows from the old recipe')
  assert.match(
    (result as { error: string }).error,
    /older version of that product's component graph/,
  )
  assert.match((result as { error: string }).error, /Re-allocate this order/, 'and it must name the exit')
  assert.equal(state.shipments[0].status, 'PACKED', 'nothing transitioned')
  assert.equal(state.movements.length, 0, 'and no stock moved')
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('o3d-4kfh r6 (finding 1): the CAS also refuses the PENDING -> PICKING commitment', async () => {
  // The commitment seam, not just the irreversible act — a shipment must not BECOME committed
  // against rows derived from a recipe that no longer exists.
  const state = uniformlyRescaledKitState(1)
  state.shipments[0].status = 'PENDING'

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'PICKING' }),
    /older version of that product's component graph/,
  )
  assert.equal(state.shipments[0].status, 'PENDING', 'the status flip is rolled back with the transaction')
})

test('o3d-4kfh r6 (finding 1): confirmSalesOrderShipments refuses a stale set rather than drafting from it', async () => {
  // Reached through validateAllocationIntegrity, so the operator hits this at draft time instead of
  // the warehouse hitting it at Start Picking.
  const state = uniformlyRescaledKitState(1)
  state.shipments = []
  state.shipmentLines = []

  await assert.rejects(
    () => confirmSalesOrderShipments(createClient(state), 'order-1'),
    /older version of that product's component graph/,
  )
})

test('o3d-4kfh r7 (finding 1): the dispatch CAS is not fooled by a pre-edit read of the product row', async () => {
  // The r6 hole, at the seam where it does the damage. Two statements, one edit between them:
  //
  //   statement 1 (salesOrderLine + product.fulfillmentGraphVersion) -> 0, matching the rows' stamp
  //   ...the editor commits 2xA+1xB -> 4xA+2xB and bumps the version to 1...
  //   statement 2 (the component graph) -> the NEW recipe
  //
  // r6 compared the stamp against statement 1, so the CAS passed; the quantities were then checked
  // against statement 2, where 2xA+1xB is a perfectly proportional half shipment, so the coverage
  // backstop passed too. Half the current kit dispatched with every check green.
  const state = uniformlyRescaledKitState(1)
  state.lineProductGraphVersions = { 'kit-1': 0 }

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false, 'the graph read is the authority — a stale product read must not certify these rows')
  assert.match((result as { error: string }).error, /older version of that product's component graph/)
  assert.equal(state.shipments[0].status, 'PACKED', 'nothing transitioned')
  assert.equal(state.movements.length, 0, 'and no stock moved')
})

test('o3d-4kfh r6 (finding 1): a matched stamp is inert — healthy orders still pack and dispatch', async () => {
  // The guard must not become a dead end. Same kit, rows written against the CURRENT recipe and
  // stamped with the CURRENT version.
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 1, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 4, sku: 'COMP-A' }, { componentId: 'comp-b', qty: 2, sku: 'COMP-B' }] },
    graphVersions: { 'kit-1': 7 },
    allocations: [
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 4, fulfillmentGraphVersion: 7 },
      { orderId: 'order-1', lineId: 'line-1', productId: 'comp-b', warehouseId: 'warehouse-1', qty: 2, fulfillmentGraphVersion: 7 },
    ],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [
      { id: 'shipment-line-a', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-a', qty: 4 },
      { id: 'shipment-line-b', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-b', qty: 2 },
    ],
    stockLevels: [
      { productId: 'comp-a', warehouseId: 'warehouse-1', quantity: 4, reservedQty: 4 },
      { productId: 'comp-b', warehouseId: 'warehouse-1', quantity: 2, reservedQty: 2 },
    ],
    costLayers: [
      { id: 'layer-a', productId: 'comp-a', warehouseId: 'warehouse-1', remainingQty: 4, unitCostBase: 5 },
      { id: 'layer-b', productId: 'comp-b', warehouseId: 'warehouse-1', remainingQty: 2, unitCostBase: 5 },
    ],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(state.shipments[0].status, 'SHIPPED')
})

// ---------------------------------------------------------------------------
// o3d-4kfh r6 (Codex finding 4) — a cancelled order's shipments neither advance nor dispatch, and
// there is an idempotent repair that removes them.
//
// r5 advertised dispatch as the exit for a PICKING/PACKED shipment blocking a component-graph edit,
// and its guard test explicitly relied on dispatch not requiring an open order. On a CANCELLED
// order that advised shipping goods for a cancelled sale — worse than the block — and the
// alternative it named (cancel the order) is not a transition CANCELLED has, so there was no exit
// at all.
// ---------------------------------------------------------------------------

function cancelledOrderWithShipment(shipmentStatus: string) {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED' }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: shipmentStatus, trackingNumber: 'TRACK-1', shippingService: 'DPD' }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })
  return state
}

test('o3d-4kfh r6 (finding 4): a CANCELLED order\'s PACKED shipment cannot be dispatched', async () => {
  const state = cancelledOrderWithShipment('PACKED')

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false, 'dispatching would ship goods for a cancelled sale')
  assert.match((result as { error: string }).error, /This order is CANCELLED/)
  assert.match((result as { error: string }).error, /Discard shipments/, 'and it must name the repair path')
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.movements.length, 0, 'no stock moved')
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('o3d-4kfh r6 (finding 4): a CANCELLED order\'s PENDING shipment cannot even start picking', async () => {
  // Blocking only the dispatch would leave PENDING -> PICKING -> PACKED free to run on a cancelled
  // sale, which is how a PICKING shipment reaches a CANCELLED order in the first place.
  const state = cancelledOrderWithShipment('PENDING')

  await assert.rejects(
    () => transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'PICKING' }),
    /This order is CANCELLED/,
  )
  assert.equal(state.shipments[0].status, 'PENDING')
})

test('o3d-4kfh r6 (finding 4): a LIVE order is unaffected — the refusal is scoped to cancelled', async () => {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 2 }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true, result.success ? undefined : result.error)
})

test('o3d-4kfh r6 (finding 4): discarding a cancelled order\'s shipments deletes the non-dispatched ones and KEEPS the shipped one', async () => {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED' }],
    shipments: [
      { id: 'ship-pending', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
      { id: 'ship-picking', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PICKING', trackingNumber: 'TRACK-PICKING', shippingService: 'DPD' },
      { id: 'ship-packed', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
      { id: 'ship-shipped', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-SHIPPED', shippingService: 'DPD' },
    ],
    shipmentLines: [
      { id: 'sl-1', shipmentId: 'ship-picking', lineId: 'line-1', productId: 'product-1', qty: 1 },
      { id: 'sl-2', shipmentId: 'ship-shipped', lineId: 'line-1', productId: 'product-1', qty: 1 },
    ],
  })
  const client = createClient(state)

  const result = await (client as unknown as { $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<{ discarded: Array<{ id: string }> }> })
    .$transaction((tx) => discardCancelledOrderShipmentsInTx(tx as never, 'order-1', { userId: 'user-1' }))

  assert.deepEqual(
    result.discarded.map((row) => row.id).sort(),
    ['ship-packed', 'ship-pending', 'ship-picking'],
  )
  assert.deepEqual(
    state.shipments.map((row) => row.id),
    ['ship-shipped'],
    'the dispatched shipment is evidence the sub-ledger resolves through — a refund reverses it, not this',
  )
  assert.deepEqual(state.shipmentLines.map((row) => row.id), ['sl-2'], 'and the cascade took the discarded lines')
  assert.equal(state.stockLevels[0].reservedQty, 2, 'reservedQty is untouched — none of these held any')
  assert.equal(state.activityLogs?.length, 1, 'one durable audit row')
  const entry = state.activityLogs![0] as {
    action: string
    metadata: { discardedTrackingNumbers: string[] }
  }
  assert.equal(entry.action, 'cancelled_order_shipments_discarded')
  assert.deepEqual(
    entry.metadata.discardedTrackingNumbers,
    ['TRACK-PICKING'],
    'naming the purchased label IMS no longer references',
  )
  assert.deepEqual(
    state.txWriteOrder,
    ['activityLog.create', 'shipment.deleteMany'],
    'the evidence is persisted BEFORE the rows it describes are destroyed',
  )
})

test('o3d-4kfh r6 (finding 4): the discard is IDEMPOTENT — a second run writes nothing at all', async () => {
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED' }],
    shipments: [{ id: 'ship-packed', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [],
  })
  const client = createClient(state) as unknown as {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<{ discarded: Array<{ id: string }> }>
  }

  const first = await client.$transaction((tx) => discardCancelledOrderShipmentsInTx(tx as never, 'order-1'))
  const second = await client.$transaction((tx) => discardCancelledOrderShipmentsInTx(tx as never, 'order-1'))

  assert.equal(first.discarded.length, 1)
  assert.deepEqual(second.discarded, [], 'nothing left to discard')
  assert.equal(state.activityLogs?.length, 1, 'and no second audit row — a retry must not create noise')
  assert.deepEqual(state.txWriteOrder, ['activityLog.create', 'shipment.deleteMany'], 'exactly one write pair, from the first run')
})

test('o3d-4kfh r6 (finding 4): the discard REFUSES on an order that is not cancelled', async () => {
  // This is not a general per-shipment cancel (o3d-q8r6 is still open). Cancelling the order is the
  // route for a live one, and it releases the reservations in the same transaction.
  const state = baseState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'ALLOCATED' }],
    shipments: [{ id: 'ship-packed', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [],
  })
  const client = createClient(state) as unknown as {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>
  }

  await assert.rejects(
    () => client.$transaction((tx) => discardCancelledOrderShipmentsInTx(tx as never, 'order-1')),
    /Only a cancelled order's shipments can be discarded/,
  )
  assert.deepEqual(state.shipments.map((row) => row.id), ['ship-packed'])
  assert.equal(state.activityLogs?.length, 0)
})

// ---------------------------------------------------------------------------
// o3d-kouj — THE DISPATCH CAP IS JUDGED AGAINST THE RECIPE THE ORDER WAS ALLOCATED FROM.
//
// The cap is `ordered − refunded − already-shipped`, expanded to leaf units. Expanding the CURRENT
// graph made a component-count REDUCTION wedge a legitimate packed shipment: the units are on the
// pallet, the allocation rows and the shipment lines agree with each other, and the only thing that
// changed is a catalogue row. The o3d-2uh worked example runs the other way (an increase lets a
// refunded kit ship); both are the same mistake, and the pin removes both.
// ---------------------------------------------------------------------------

/** A pinned 1-kit-needs-2-of-A recipe, as `allocateSalesOrder` would have written it. */
const PINNED_KIT_2A = {
  version: 1,
  productId: 'kit-1',
  graphVersion: 4,
  capturedAt: '2026-08-01T00:00:00.000Z',
  requirements: [{ productId: 'comp-a', factor: '2' }],
}

/** 2 kits ordered, allocated and PACKED at 4 x comp-a. The live recipe now says 1 x comp-a. */
function reducedKitState(options: { pinned: boolean }) {
  return baseState({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      qty: 2,
      sku: 'KIT-1',
      description: 'Kit 1',
      fulfillmentRequirements: options.pinned ? PINNED_KIT_2A : undefined,
    }],
    kits: { 'kit-1': [{ componentId: 'comp-a', qty: 1, sku: 'COMP-A' }] },
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'comp-a', warehouseId: 'warehouse-1', qty: 4 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-a', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-a', qty: 4 }],
    stockLevels: [{ productId: 'comp-a', warehouseId: 'warehouse-1', quantity: 4, reservedQty: 4 }],
    costLayers: [{ id: 'layer-a', productId: 'comp-a', warehouseId: 'warehouse-1', remainingQty: 4, unitCostBase: 5 }],
  })
}

test('o3d-kouj: a kit re-composed SMALLER after packing no longer wedges the packed shipment', async () => {
  const state = reducedKitState({ pinned: true })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true, 'the pinned line still ordered 4 component units, and 4 are packed')
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.stockLevels[0].quantity, 0, 'and the goods actually left')
  assert.equal(state.stockLevels[0].reservedQty, 0)
})

test('o3d-kouj: the same shipment WITHOUT a pin is still measured against the catalogue, and is refused', async () => {
  // The pre-snapshot behaviour, kept for every line that has never been allocated since the column
  // shipped. The refusal names the exact wedge: 4 packed against 2 "ordered" leaf units.
  const state = reducedKitState({ pinned: false })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-1',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.equal(
    (result as { error: string }).error,
    'Shipment quantity for line KIT-1 exceeds ordered quantity. Reload and retry.',
  )
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.stockLevels[0].quantity, 4, 'nothing moved')
})

// ---------------------------------------------------------------------------
// o3d-2k5 — THE WAY BACK FROM A PACKED SHIPMENT THE REFUND GUARD REFUSES.
//
// o3d-339 refuses to dispatch a PACKED shipment that would ship more than remains after a refund.
// That refusal stays exactly as it was; what these tests cover is the exit it now names, and that
// the exit actually reaches a dispatchable order rather than merely being a button.
// ---------------------------------------------------------------------------

function packedBeforeRefundState(overrides: Partial<State> = {}): State {
  return baseState({
    // 5 ordered, 5 packed, then 2 refunded — the shipment now exceeds what remains.
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', qty: 5, sku: 'SKU-1', description: 'Product 1' }],
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'product-1', warehouseId: 'warehouse-1', qty: 5 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: 'TRACK-1', shippingService: 'DPD' }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'product-1', qty: 5 }],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 2 }],
    stockLevels: [{ productId: 'product-1', warehouseId: 'warehouse-1', quantity: 5, reservedQty: 5 }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', warehouseId: 'warehouse-1', remainingQty: 5, unitCostBase: 5 }],
    ...overrides,
  })
}

test('o3d-2k5: reopening a PACKED shipment returns it to a PENDING draft and KEEPS its purchased label', async () => {
  const state = packedBeforeRefundState()

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1', { userId: 'user-1' })

  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(state.shipments[0].status, 'PENDING', 'the row itself is a draft again — that is what makes it rebuildable')
  assert.equal(state.shipments[0].trackingNumber, 'TRACK-1', 'a purchased label is a real carrier record; a delete would have destroyed it')
  assert.equal(state.shipments[0].shippingService, 'DPD')
  assert.deepEqual(state.shipmentLines.map((line) => line.id), ['shipment-line-1'], 'the lines are kept — the rebuild replaces them, this does not delete them')
  assert.equal(state.stockLevels[0].reservedQty, 5, 'reservedQty is UNTOUCHED: a PACKED shipment released nothing, so there is nothing to put back')
  assert.equal(state.activityLogs?.length, 1)
  const entry = state.activityLogs![0] as { action: string; level: string; description: string; metadata: { previousStatus: string; trackingNumber: string | null } }
  assert.equal(entry.action, 'shipment_reopened_for_repack')
  assert.equal(entry.level, 'WARNING', 'a human owes the warehouse a physical un-pack; that is not an INFO')
  assert.equal(entry.metadata.previousStatus, 'PACKED')
  assert.equal(entry.metadata.trackingNumber, 'TRACK-1')
  assert.match(entry.description, /unpacked in the warehouse/)
})

test('o3d-2k5: a DISPATCHED shipment cannot be reopened — a dispatch is reversed by a refund or a return', async () => {
  const state = packedBeforeRefundState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-1', shippingService: 'DPD' }],
  })

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1')

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /already been dispatched/)
  assert.equal(state.shipments[0].status, 'SHIPPED', 'nothing was written')
  assert.equal(state.activityLogs?.length, 0)
})

test('o3d-2k5: a PENDING draft is refused, and is sent to the rebuild control instead', async () => {
  const state = packedBeforeRefundState({
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null }],
  })

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1')

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /"Create Shipments"/)
  assert.equal(state.activityLogs?.length, 0, 'refusing must not leave an audit row claiming a reopen happened')
})

test('o3d-2k5: a CANCELLED order takes the discard repair, not the reopen', async () => {
  // Reopening would leave a draft on an order confirmSalesOrderShipments refuses to build for, so
  // the rebuild step would dead-end — the refusal has to send the operator to the path that works.
  const state = packedBeforeRefundState({
    orders: [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: null, status: 'CANCELLED' }],
  })

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1')

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /Discard shipments/)
  assert.equal(state.shipments[0].status, 'PACKED')
  assert.equal(state.activityLogs?.length, 0)
})

test('o3d-2k5r r6: a DISPATCHED sibling refuses the reopen under the lock, BEFORE the revert is written', async () => {
  // THE ENTRY TO THE DEAD END, closed at the write path rather than only in the UI. The order has a
  // packed shipment and an already-dispatched one. Reverting the packed one leaves a draft that
  // `allocateSalesOrder` will refuse to re-net for as long as the order exists — the dispatched
  // sibling is not PENDING and can never be reopened — so the revert buys nothing and costs the
  // order the last state it could still have been dispatched from.
  const state = packedBeforeRefundState({
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: 'TRACK-1', shippingService: 'DPD' },
      { id: 'shipment-2', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: 'TRACK-2', shippingService: 'DPD' },
    ],
  })

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1', { userId: 'user-1' })

  assert.equal(result.success, false)
  assert.equal((result as { code?: string }).code, 'UNREOPENABLE_SIBLING')
  assert.match((result as { error: string }).error, /1 dispatched shipment/)
  assert.equal(state.shipments[0].status, 'PACKED', 'the refusal is BEFORE the write, not after it')
  assert.equal(state.activityLogs?.length, 0, 'and nothing tells the warehouse to unpack a box that was never reopened')
})

test('o3d-2k5r r6: a PACKED sibling does NOT refuse it — that deadlock is what the partial commit exists to break', async () => {
  // The limit of the guard above, asserted so it cannot quietly widen into "any sibling". Two
  // packed shipments refuse each other's re-allocation; if the reopen refused here too, neither
  // could ever go first and the recovery this branch exists for would be unreachable.
  const state = packedBeforeRefundState({
    shipments: [
      { id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: 'TRACK-1', shippingService: 'DPD' },
      { id: 'shipment-2', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: 'TRACK-2', shippingService: 'DPD' },
    ],
  })

  const result = await reopenShipmentForRepack(createClient(state), 'shipment-1', { userId: 'user-1' })

  assert.equal(result.success, true, result.success ? undefined : result.error)
  assert.equal(state.shipments[0].status, 'PENDING')
  assert.equal(state.shipments[1].status, 'PACKED', 'and only the one asked for moved')
})

test('o3d-2k5: the WHOLE recovery — a refund lands after packing, and the order ends up dispatched at the reduced quantity', async () => {
  const state = packedBeforeRefundState()

  // 1. Today's dead end: the o3d-339 guard refuses the dispatch, and names the exit.
  const blocked = await transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'SHIPPED' })
  assert.equal(blocked.success, false)
  assert.match((blocked as { error: string }).error, /Reopen for repack/)
  assert.equal(state.shipments[0].status, 'PACKED')

  // 2. The exit.
  const reopened = await reopenShipmentForRepack(createClient(state), 'shipment-1', { userId: 'user-1' })
  assert.equal(reopened.success, true, reopened.success ? undefined : reopened.error)

  // 3. The rebuild — the path that only ever replaces PENDING shipments, which is why the revert
  //    had to be a revert. It nets the refund at build time: 5 allocated − 2 refunded = 3.
  const rebuilt = await confirmSalesOrderShipments(createClient(state), 'order-1')
  assert.equal(rebuilt.deletedPendingCount, 1, 'the reopened draft is the one it replaced')
  assert.equal(rebuilt.shipmentCount, 1)
  assert.equal(state.shipments.length, 1)
  const fresh = state.shipments[0]
  assert.equal(fresh.status, 'PENDING')
  assert.deepEqual(
    state.shipmentLines.filter((line) => line.shipmentId === fresh.id).map((line) => line.qty),
    [3],
    'rebuilt to what actually remains — this is the number the guard was defending',
  )

  // 4. And it now dispatches, which is the whole point: the remainder is shippable again.
  const picking = await transitionShipmentStatus(createClient(state), { shipmentId: fresh.id, targetStatus: 'PICKING' })
  assert.equal(picking.success, true, picking.success ? undefined : picking.error)
  const packed = await transitionShipmentStatus(createClient(state), { shipmentId: fresh.id, targetStatus: 'PACKED' })
  assert.equal(packed.success, true, packed.success ? undefined : packed.error)
  const shipped = await transitionShipmentStatus(createClient(state), { shipmentId: fresh.id, targetStatus: 'SHIPPED' })
  assert.equal(shipped.success, true, shipped.success ? undefined : shipped.error)
  assert.equal(state.shipments[0].status, 'SHIPPED')
  assert.equal(state.stockLevels[0].quantity, 2, '3 of the 5 units left the building')
})

test('o3d-2k5: the same recovery on a KIT nets the refund at LEAF level when the shipment is rebuilt', async () => {
  // 4 kits ordered and packed as 0.4 of a fractional component; 1 kit refunded. The rebuild must
  // produce 0.3 of the component, not "3 kits" — the leaf is the only unit the dispatch cap and the
  // builder can agree in.
  const state = baseState({
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'kit-1', qty: 4, sku: 'KIT-1', description: 'Kit 1' }],
    kits: { 'kit-1': [{ componentId: 'comp-1', qty: 0.1, sku: 'COMP-1' }] },
    allocations: [{ orderId: 'order-1', lineId: 'line-1', productId: 'comp-1', warehouseId: 'warehouse-1', qty: 0.4 }],
    shipments: [{ id: 'shipment-1', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null }],
    shipmentLines: [{ id: 'shipment-line-1', shipmentId: 'shipment-1', lineId: 'line-1', productId: 'comp-1', qty: 0.4 }],
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'kit-1', qty: 1 }],
    stockLevels: [{ productId: 'comp-1', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 0.4 }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 }],
  })

  const blocked = await transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'SHIPPED' })
  assert.equal(blocked.success, false)
  assert.match((blocked as { error: string }).error, /Reopen for repack/)

  const reopened = await reopenShipmentForRepack(createClient(state), 'shipment-1')
  assert.equal(reopened.success, true, reopened.success ? undefined : reopened.error)

  await confirmSalesOrderShipments(createClient(state), 'order-1')
  const fresh = state.shipments[0]
  const rebuiltQtys = state.shipmentLines.filter((line) => line.shipmentId === fresh.id).map((line) => line.qty)
  assert.equal(rebuiltQtys.length, 1)
  // Compared with a tolerance, not for equality: this double stores raw JS numbers, so 0.4 − 0.1
  // shows its float dust here where the real column (Decimal(12,4)) would persist 0.3000. The
  // tolerance is far tighter than one unit of that scale, so it still fails on a wrong quantity.
  assert.ok(
    Math.abs(rebuiltQtys[0] - 0.3) < 1e-9,
    `three kits worth of the component, netted through the kit recipe — got ${rebuiltQtys[0]}`,
  )

  const shipped = await transitionShipmentStatus(createClient(state), { shipmentId: fresh.id, targetStatus: 'PICKING' })
  assert.equal(shipped.success, true, shipped.success ? undefined : shipped.error)
})

test('o3d-2k5: after a FULL refund the rebuild has nothing to build, and says so instead of shipping', async () => {
  const state = packedBeforeRefundState({
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-1', productId: 'product-1', qty: 5 }],
  })

  const blocked = await transitionShipmentStatus(createClient(state), { shipmentId: 'shipment-1', targetStatus: 'SHIPPED' })
  assert.equal(blocked.success, false)
  assert.match((blocked as { error: string }).error, /Reopen for repack/)

  const reopened = await reopenShipmentForRepack(createClient(state), 'shipment-1')
  assert.equal(reopened.success, true, reopened.success ? undefined : reopened.error)

  await assert.rejects(
    () => confirmSalesOrderShipments(createClient(state), 'order-1'),
    /already covered by active shipments or refunds/,
    'every unit was refunded — the correct outcome is no shipment at all, not a smaller one',
  )
  assert.equal(state.shipments[0].status, 'PENDING', 'and the draft is left as a draft, which blocks nothing')
})

// ---------------------------------------------------------------------------
// o3d-2k5r r7 — THE DISPATCH FENCE FOR AN OUTSTANDING REPACK RECOVERY
//
// r6 established that a repack recovery must not CREATE a dead end: the partial commit that keeps
// a refused re-allocation's reopen survives only while every blocker is still reopenable, re-read
// under the order lock at the moment that transaction commits.
//
// That check is an instant, not a rule. The state it permits — one shipment reopened to a draft,
// its sibling still PACKED, the refund's reservation release still deferred — is one dispatch away
// from the exact wall the check exists to avoid, and nothing stopped that dispatch: not the
// shipment screen, not a label purchase, and least of all a WMS despatch feed, which never sees the
// operator warning. These four fix the rule at the irreversible act instead, under the same order
// lock, which is the single door every dispatch route goes through.
//
// Read them as a pair of opposites. The first two prove the fence REFUSES the dispatch that would
// foreclose a recovery the order still owes; the last two prove it lets everything else through,
// which is what stops it being a wedge.
// ---------------------------------------------------------------------------

/** The order's refunds and their still-unresolved backstop rows, as the fence reads them. */
function outstandingRecovery() {
  return {
    refunds: [{ id: 'refund-1', orderId: 'order-1' }],
    releaseOutbox: [{ idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'PENDING' }],
  }
}

/** Two lines, one shipment each: line-a partly refunded, line-b untouched and fully packed. */
function partlyRefundedTwoShipmentOrder(overrides: Partial<State> = {}): State {
  return baseState({
    lines: [
      { id: 'line-a', orderId: 'order-1', productId: 'product-a', qty: 3, sku: 'SKU-A', description: 'Product A' },
      { id: 'line-b', orderId: 'order-1', productId: 'product-b', qty: 1, sku: 'SKU-B', description: 'Product B' },
    ],
    allocations: [
      { orderId: 'order-1', lineId: 'line-a', productId: 'product-a', warehouseId: 'warehouse-1', qty: 3 },
      { orderId: 'order-1', lineId: 'line-b', productId: 'product-b', warehouseId: 'warehouse-1', qty: 1 },
    ],
    shipmentLines: [
      { id: 'shipment-line-a', shipmentId: 'shipment-a', lineId: 'line-a', productId: 'product-a', qty: 2 },
      { id: 'shipment-line-b', shipmentId: 'shipment-b', lineId: 'line-b', productId: 'product-b', qty: 1 },
    ],
    // One of line-a's three units was refunded after shipment-a was packed. Both shipments are
    // still within ordered-minus-refunded, so `validateActiveShipmentTotalsWithinOrder` PASSES —
    // which is what makes these tests about the fence and not about the dispatch cap.
    refundLines: [{ orderId: 'order-1', salesOrderLineId: 'line-a', productId: 'product-a', qty: 1 }],
    stockLevels: [
      { productId: 'product-a', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 3 },
      { productId: 'product-b', warehouseId: 'warehouse-1', quantity: 1, reservedQty: 1 },
    ],
    costLayers: [
      { id: 'layer-a', productId: 'product-a', warehouseId: 'warehouse-1', remainingQty: 3, unitCostBase: 5 },
      { id: 'layer-b', productId: 'product-b', warehouseId: 'warehouse-1', remainingQty: 1, unitCostBase: 5 },
    ],
    ...overrides,
  })
}

test('o3d-2k5r r7: a sibling cannot be dispatched out from under a repack recovery the partial commit left half-open', async () => {
  // THE LOAD-BEARING CASE, and it is a sequence, not a state. The operator pressed "Reopen for
  // repack" on shipment-a; the re-allocation was refused because shipment-b was PACKED; that
  // refusal DELIBERATELY COMMITTED the reopen, having checked — correctly, under the order lock —
  // that every blocker was still reopenable. shipment-b is that blocker, and this is the dispatch
  // that would falsify the check a moment after it was made.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    ...outstandingRecovery(),
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /repack recovery/)
  // Refused, not thrown, and refused BEFORE anything irreversible: the WMS path returns this as a
  // sync exception rather than an exception, and the order is left exactly where the recovery can
  // still be finished from.
  assert.equal(state.shipments[1].status, 'PACKED')
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  assert.equal(state.stockLevels[1].quantity, 1)
  assert.equal(state.stockLevels[1].reservedQty, 1)
})

test('o3d-2k5r r7: the same wall is refused with no reopen at all — pack two, refund, dispatch one', async () => {
  // No recovery has been started here. Two shipments were packed, a refund landed behind them, and
  // dispatching either one makes the deferred release unrecoverable just as surely as the sequence
  // above. A fence that only covered the post-reopen state would let this through.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    ...outstandingRecovery(),
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /repack recovery/)
  assert.equal(state.shipments[1].status, 'PACKED')
  assert.equal(state.movements.length, 0)
})

test('o3d-2k5r r7: the fence does NOT outlive the recovery it protects — an order already holding a dispatch still ships', async () => {
  // shipment-a is SHIPPED, so the recovery is ALREADY foreclosed: reopening it is refused outright
  // and the re-allocation will be declined for ever, outstanding backstop row or not. Refusing this
  // dispatch too would buy nothing and would strand goods that must still go out, on an order that
  // needs the o3d-339 reconciliation either way. Delete the `orderHasUnreopenableCommitment` arm of
  // `dispatchForeclosesRepackRecovery` and this test fails — which is the point of having it.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    ...outstandingRecovery(),
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[1].status, 'SHIPPED')
  assert.equal(state.movements.length, 1)
})

test('o3d-2k5r r7: a refund whose reservation release already happened does not fence anything', async () => {
  // The evidence is the UNRESOLVED row, not the refund. Once the recovery has run (or the backstop
  // cron drained it) the row is SUCCEEDED, the order owes nothing, and dispatch is ordinary. Widen
  // `UNRESOLVED_RELEASE_STATUSES` to include SUCCEEDED, or drop the `status` filter from the count,
  // and this test fails — so "outstanding" cannot quietly become "has ever been refunded".
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    refunds: [{ id: 'refund-1', orderId: 'order-1' }],
    releaseOutbox: [{ idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'SUCCEEDED' }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[1].status, 'SHIPPED')
  assert.equal(state.movements.length, 1)
})

test('o3d-2k5r r7: an unresolved row on ANOTHER order does not fence this one', async () => {
  // The count is keyed on the idempotency keys built from THIS order's refund ids. This order's own
  // recovery is done (refund-1, SUCCEEDED); a different order still owes one (refund-2, PENDING).
  //
  // The fixture is built so the key filter is the ONLY thing separating them: order-1 does have a
  // refund, so the "no refunds → 0" shortcut is passed and the count statement really runs. Drop
  // `idempotencyKey: { in: idempotencyKeys }` from that count and this test fails — without a
  // refund of its own, order-1 would never reach the statement and the loosening would go unseen.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    refunds: [
      { id: 'refund-1', orderId: 'order-1' },
      { id: 'refund-2', orderId: 'order-OTHER' },
    ],
    releaseOutbox: [
      { idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'SUCCEEDED' },
      { idempotencyKey: 'sales:refund.reservation-release:refund-2', status: 'PENDING' },
    ],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[1].status, 'SHIPPED')
})

// ---------------------------------------------------------------------------
// o3d-2k5r r8 (Codex) — THE CLAIM IS NOT UNDER THE ORDER LOCK.
//
// r7 put the fence inside the dispatch transaction, after `lockSalesOrder`, and reasoned that a
// repack recovery committing between the read and the dispatch is impossible because the recovery
// takes the same lock. True of the recovery. NOT true of the drain, and the drain does the same
// repair: `claimIntegrationOutboxWork` flips the backstop row to PROCESSING *before* allocation is
// called and without taking any sales-order lock. r7's fence reused the affordance's read, which
// excludes PROCESSING on purpose — so the claim opened a window in which the fence counted zero.
//
// The two tests below are the two halves of that. The first is the STATE: a claimed row is still an
// owed release. The second is the SEQUENCE, driven through the real claim and the real drain.
// ---------------------------------------------------------------------------

/** The order's refunds with the backstop row CLAIMED — the drain owns it and has not finished. */
function claimedRecovery() {
  return {
    refunds: [{ id: 'refund-1', orderId: 'order-1' }],
    releaseOutbox: [{ idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'PROCESSING' }],
  }
}

test('o3d-2k5r r8: a backstop row the drain has CLAIMED still fences the dispatch', async () => {
  // Point `validateDispatchPreservesRepackRecovery` back at the affordance's read
  // (`countResumableRefundReservationReleases`), or drop PROCESSING from
  // `UNFINISHED_RELEASE_STATUSES`, and this test fails — which is the finding, as a single state.
  //
  // The operator sees no "Finish repack recovery" button on this order right now, and that is
  // correct: a worker holds the row. It is not a reason to let the goods go.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    ...claimedRecovery(),
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /repack recovery/)
  assert.equal(state.shipments[1].status, 'PACKED')
  assert.equal(state.movements.length, 0)
})

test('o3d-2k5r r9: a backstop row carrying a status THIS BINARY DOES NOT KNOW still fences the dispatch', async () => {
  // THE VERSION-SKEW HOLE, END TO END (Codex r8 HIGH). r8 built the fence's set by filtering
  // `Object.values(INTEGRATION_OUTBOX_STATUS)` — a derivation that happens when this binary
  // COMPILES, against a `status` column that is an unconstrained string written at RUN TIME. Roll
  // one web process back, or drain from a newer one mid-deploy, and the row carries a state this
  // process cannot name. Under an `IN (...)` allowlist it matches nothing, the fence counts zero,
  // and the dispatch commits SHIPPED over a reservation that was never released — the exact
  // unrecoverable order (stock held, no control, no claimable row) this fence exists to prevent.
  //
  // MUTATION / ROUTE: restore r8's shape — `UNFINISHED_RELEASE_STATUS_PREDICATE =
  // { in: Object.values(INTEGRATION_OUTBOX_STATUS).filter((s) => s !== 'SUCCEEDED') }` — and this
  // fails with success === true and shipment-b at SHIPPED, while every other fence test in this
  // file still passes, because they all assert on statuses the enum happens to contain. Route:
  // transitionShipmentStatus → validateDispatchPreservesRepackRecovery →
  // countUnfinishedRefundReservationReleases → integrationOutbox.count({ where: { status } }).
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    refunds: [{ id: 'refund-1', orderId: 'order-1' }],
    // Not in `INTEGRATION_OUTBOX_STATUS`. That is the whole point: no list this file or that module
    // writes today contains it, and the fence must refuse anyway.
    releaseOutbox: [{ idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'QUARANTINED_BY_NEWER_RELEASE' }],
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, false)
  assert.match((result as { error: string }).error, /repack recovery/)
  assert.equal(state.shipments[1].status, 'PACKED')
  assert.equal(state.movements.length, 0)
})

const RELEASE_OUTBOX_EPOCH = new Date('2026-08-27T10:00:00.000Z')

type OutboxWhere = {
  id?: string
  connector?: string
  operation?: string
  idempotencyKey?: { in?: string[] }
  status?: string | { in?: string[]; not?: string }
  attempts?: { lt?: number; gte?: number }
  lockedAt?: Date | null | { lt?: Date }
  lockedBy?: string
  nextAttemptAt?: null | { lte?: Date }
  AND?: OutboxWhere[]
  OR?: OutboxWhere[]
}

function outboxRowMatches(row: IntegrationOutboxRow, where: OutboxWhere | undefined): boolean {
  if (!where) return true
  if (where.AND?.some((branch) => !outboxRowMatches(row, branch))) return false
  if (where.OR && !where.OR.some((branch) => outboxRowMatches(row, branch))) return false
  if (where.id !== undefined && row.id !== where.id) return false
  if (where.connector !== undefined && row.connector !== where.connector) return false
  if (where.operation !== undefined && row.operation !== where.operation) return false
  if (where.idempotencyKey?.in && !where.idempotencyKey.in.includes(row.idempotencyKey)) return false
  if (typeof where.status === 'string' && row.status !== where.status) return false
  if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(row.status)) return false
  if (typeof where.status === 'object' && where.status.not !== undefined && row.status === where.status.not) return false
  if (where.attempts?.lt !== undefined && row.attempts >= where.attempts.lt) return false
  if (where.attempts?.gte !== undefined && row.attempts < where.attempts.gte) return false
  if (where.lockedBy !== undefined && row.lockedBy !== where.lockedBy) return false
  if (where.lockedAt === null && row.lockedAt !== null) return false
  if (where.lockedAt instanceof Date && row.lockedAt?.getTime() !== where.lockedAt.getTime()) return false
  if (where.lockedAt && !(where.lockedAt instanceof Date) && where.lockedAt.lt) {
    if (row.lockedAt === null || row.lockedAt >= where.lockedAt.lt) return false
  }
  if (where.nextAttemptAt === null && row.nextAttemptAt !== null) return false
  if (where.nextAttemptAt?.lte && (row.nextAttemptAt === null || row.nextAttemptAt > where.nextAttemptAt.lte)) return false
  return true
}

/**
 * o3d-2k5r r8: an IntegrationOutbox client backed by `state.releaseOutbox` — the VERY SAME row
 * objects the shipment client's `integrationOutbox.count` reads.
 *
 * That sharing is the point. A double that handed the drain its own copy of the row would let the
 * claim write PROCESSING somewhere the fence never looks, and the interleaving test would pass with
 * the bug still in place. The fixture rows are hydrated in place with the columns the real
 * `claimIntegrationOutboxWork` predicates on (attempts / nextAttemptAt / lockedAt / lockedBy), so
 * the claim's due-and-unlocked rules are genuinely exercised rather than assumed.
 */
function releaseOutboxClient(state: State): IntegrationOutboxClient {
  const rows = (state.releaseOutbox ?? []).map((row, index) => {
    const target = row as Record<string, unknown>
    const defaults: Record<string, unknown> = {
      id: `release-outbox-${index + 1}`,
      connector: 'sales',
      operation: 'refund.reservation-release',
      payloadJson: { orderId: 'order-1', refundId: row.idempotencyKey.split(':').pop() ?? 'refund-1' },
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      createdAt: RELEASE_OUTBOX_EPOCH,
      updatedAt: RELEASE_OUTBOX_EPOCH,
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (target[key] === undefined) target[key] = value
    }
    return target as unknown as IntegrationOutboxRow
  })

  return {
    integrationOutbox: {
      create: async () => { throw new Error('the release-outbox double does not enqueue') },
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id?: string; idempotencyKey?: string } }
        return rows.find((row) => (
          (where.id === undefined || row.id === where.id)
          && (where.idempotencyKey === undefined || row.idempotencyKey === where.idempotencyKey)
        )) ?? null
      },
      findMany: async (args: unknown) => {
        const { where, take } = args as { where?: OutboxWhere; take?: number }
        return rows
          .filter((row) => outboxRowMatches(row, where))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, take)
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as {
          where?: OutboxWhere
          data: Record<string, unknown> & { attempts?: number | { increment: number } }
        }
        const matched = rows.filter((row) => outboxRowMatches(row, where))
        for (const row of matched) {
          const attempts = typeof data.attempts === 'object' && data.attempts !== null
            ? row.attempts + data.attempts.increment
            : data.attempts
          Object.assign(row, data, { attempts: attempts ?? row.attempts, updatedAt: RELEASE_OUTBOX_EPOCH })
        }
        return { count: matched.length }
      },
    },
  } as unknown as IntegrationOutboxClient
}

test('o3d-2k5r r8: claim -> PROCESSING -> a dispatch takes the order lock -> the worker allocates: the dispatch is refused', async () => {
  // THE INTERLEAVING THE FINDING DESCRIBES, DRIVEN RATHER THAN ASSERTED. Every step below is a real
  // call in the real order:
  //
  //   1. `processRefundReservationReleaseOutbox` runs the REAL `claimIntegrationOutboxWork`, which
  //      writes PROCESSING to the row — taking no sales-order lock, because the outbox claim never
  //      does.
  //   2. INSIDE the drain's `allocate`, i.e. after the claim and before the worker has reached the
  //      order lock, a dispatch runs end to end through `transitionShipmentStatus`. This is the
  //      window: under r7 the fence counted zero here and shipment-b went out.
  //   3. Only then does the worker's allocation resolve the way the real one does on an order that
  //      still holds shipments — `refuseIfShipmentsExist` declines, nothing is reconciled.
  //
  // The row and the fence read the SAME object (`releaseOutboxClient`), so step 2 sees exactly what
  // step 1 wrote. Revert the fence to the resumable read and step 2 succeeds — the assertions below
  // then fail on the dispatch AND on shipment-b's status, which is the whole irreversible act.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PENDING', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    refunds: [{ id: 'refund-1', orderId: 'order-1' }],
    releaseOutbox: [{ idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'PENDING' }],
  })
  const outbox = releaseOutboxClient(state)

  const statusSeenByDispatch: string[] = []
  let dispatch: Awaited<ReturnType<typeof transitionShipmentStatus>> | null = null

  const drained = await processRefundReservationReleaseOutbox({
    claimWork: (options) => claimIntegrationOutboxWork({ ...options, client: outbox }),
    allocate: async (orderId) => {
      assert.equal(orderId, 'order-1')
      // PRECONDITION, asserted rather than hoped for: the window really is open. If the claim did
      // not write PROCESSING this test would be exercising the PENDING path the r7 tests already
      // cover, and would prove nothing about the finding.
      statusSeenByDispatch.push(String(state.releaseOutbox?.[0].status))
      dispatch = await transitionShipmentStatus(createClient(state), {
        shipmentId: 'shipment-b',
        targetStatus: 'SHIPPED',
      })
      // What `autoAllocateOrder(..., { refuseIfShipmentsExist: true })` returns once it has the
      // order lock and finds a shipment: a deliberate, consistent no-op. Not `committed`.
      return { success: true, refused: true }
    },
    markSuccess: (options) => markIntegrationOutboxSuccess({ ...options, client: outbox }),
    markRetry: (options) => markIntegrationOutboxRetryableFailure({ ...options, client: outbox }),
    logDeferral: async () => 'written' as const,
  })

  assert.deepEqual(statusSeenByDispatch, ['PROCESSING'])
  assert.equal(drained.claimed, 1)
  const dispatched = dispatch as unknown as { success: boolean; error?: string }
  assert.equal(dispatched.success, false)
  assert.match(String(dispatched.error), /repack recovery/)
  // Nothing irreversible happened: no dispatch, no stock movement, no COGS relief.
  assert.equal(state.shipments[1].status, 'PACKED')
  assert.equal(state.movements.length, 0)
  assert.equal(state.cogsEntries.length, 0)
  // And the worker's own outcome is untouched by the fence: it refused, the row went back to a
  // status the operator control can pick up, and the order is still fully recoverable.
  assert.equal(drained.failed, 1)
  assert.equal(state.releaseOutbox?.[0].status, 'RETRYABLE_FAILED')
})

test('o3d-2k5r r8: the widened fence still does not outlive the recovery — a CLAIMED row on an order already dispatched ships', async () => {
  // The r7 narrowness test, re-asked against the state the widening added. shipment-a is SHIPPED,
  // so the recovery is already foreclosed however the backstop row is doing; refusing shipment-b as
  // well would strand goods that must still go out, on an order that needs the o3d-339
  // reconciliation either way. Widening WHAT the fence counts must not widen WHEN it refuses.
  const state = partlyRefundedTwoShipmentOrder({
    shipments: [
      { id: 'shipment-a', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'SHIPPED', trackingNumber: null, shippingService: null },
      { id: 'shipment-b', orderId: 'order-1', warehouseId: 'warehouse-1', status: 'PACKED', trackingNumber: null, shippingService: null },
    ],
    ...claimedRecovery(),
  })

  const result = await transitionShipmentStatus(createClient(state), {
    shipmentId: 'shipment-b',
    targetStatus: 'SHIPPED',
  })

  assert.equal(result.success, true)
  assert.equal(state.shipments[1].status, 'SHIPPED')
  assert.equal(state.movements.length, 1)
})
