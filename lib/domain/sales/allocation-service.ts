import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import {
  calculateDecimalCoverageByLine,
  calculateDecimalFulfillmentCoverage,
  requirementsMapToDecimalRows,
  type DecimalFulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  getFulfillmentAvailableQtyDecimal,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'
import { buildBackorderReport, type BackorderReportLine } from '@/lib/domain/inventory/backorder-report'
import {
  validateManualSalesOrderStatusTransition,
  validateSalesOrderStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const ALLOCATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const ALLOCATION_EPSILON = 0.000001
const ALLOCATION_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

export type AllocationServiceClient = Prisma.TransactionClient | typeof db

export type AllocateSalesOrderInput = {
  orderId: string
  refuseIfShipmentsExist?: boolean
}

export type AllocateSalesOrderResult = {
  success: boolean
  error?: string
  syncProductIds: string[]
  allocationCount: number
  unallocatedLines: AllocationUnallocatedLine[]
  unallocatedQty: number
  backorderLineCount: number
  orderRef?: string
  isShoppingOrder?: boolean
  shipFromWarehouseId?: string | null
  logAttempt?: boolean
}

export type AllocationUnallocatedLine = Pick<
  BackorderReportLine,
  | 'lineId'
  | 'productId'
  | 'sku'
  | 'description'
  | 'orderedQty'
  | 'committedShipmentQty'
  | 'allocatedQty'
  | 'unallocatedQty'
  | 'backorderEligible'
  | 'reason'
> & { componentBlockers: string[] }

type AllocationRowInput = {
  lineId: string
  productId: string
  warehouseId: string
  qty: Prisma.Decimal
}

type DecimalStockMap = Map<string, Map<string, Prisma.Decimal>>

function canRunTransaction(
  client: AllocationServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

export function buildAvailableStockMap(
  rows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
): DecimalStockMap {
  const stockMap: DecimalStockMap = new Map()
  for (const row of rows) {
    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(
      row.warehouseId,
      Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(row.quantity).sub(toDecimal(row.reservedQty))),
    )
  }
  return stockMap
}

export function buildAvailableStockMapIncludingOwnReservations(
  stockRows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
): DecimalStockMap {
  const ownByProductWarehouse = new Map<string, Prisma.Decimal>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByProductWarehouse.set(
      key,
      (ownByProductWarehouse.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)),
    )
  }

  const stockMap: DecimalStockMap = new Map()
  for (const row of stockRows) {
    const quantity = toDecimal(row.quantity)
    const reservedQty = toDecimal(row.reservedQty)
    const ownQty = ownByProductWarehouse.get(`${row.productId}:${row.warehouseId}`) ?? new Prisma.Decimal(0)
    if (ownQty.gt(reservedQty.add(ALLOCATION_EPSILON_DECIMAL))) {
      console.warn(
        `[allocation-service] own allocations exceed reserved stock for product ${row.productId} in warehouse ${row.warehouseId}; reservedQty=${reservedQty.toString()}, ownQty=${ownQty.toString()}`,
      )
    }
    const otherReservedQty = Prisma.Decimal.max(new Prisma.Decimal(0), reservedQty.sub(ownQty))
    const available = Prisma.Decimal.max(new Prisma.Decimal(0), quantity.sub(otherReservedQty))

    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(row.warehouseId, available)
  }
  return stockMap
}

function cloneAvailableStockMap(
  stockMap: DecimalStockMap,
): DecimalStockMap {
  const copy: DecimalStockMap = new Map()
  for (const [productId, byWarehouse] of stockMap) {
    copy.set(productId, new Map(byWarehouse))
  }
  return copy
}

function applyRequirementDeltaToAvailableMap(
  stockMap: DecimalStockMap,
  requirements: Map<string, DecimalInput>,
  warehouseId: string,
  direction: 'reserve' | 'release',
) {
  for (const [productId, qty] of requirements) {
    const byWarehouse = stockMap.get(productId) ?? new Map<string, Prisma.Decimal>()
    const current = byWarehouse.get(warehouseId) ?? new Prisma.Decimal(0)
    const delta = toDecimal(qty)
    byWarehouse.set(
      warehouseId,
      direction === 'reserve' ? current.sub(delta) : current.add(delta),
    )
    stockMap.set(productId, byWarehouse)
  }
}

export async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`,
  )
}

export async function lockStockLevels(
  tx: Prisma.TransactionClient,
  productIds: string[],
  warehouseIds: string[],
): Promise<void> {
  if (productIds.length === 0 || warehouseIds.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`
      SELECT id
      FROM "stock_levels"
      WHERE "productId" IN (${Prisma.join(productIds)})
        AND "warehouseId" IN (${Prisma.join(warehouseIds)})
      FOR UPDATE
    `,
  )
}

/**
 * If the daily batch A2 has already staged this order's allocations for
 * accounting (inventoryAllocatedDate is set), any subsequent allocation
 * edit would orphan the FIFO snapshots that Group B and refund reversals
 * depend on. Reset the accounting flags so A2 re-runs for this order on
 * the next daily batch, re-snapshotting the updated allocations.
 *
 * Invariant: allocation accounting is staged at the order level. A staged
 * order must treat every allocation snapshot as a single replaceable set; the
 * schema does not support mixed staged/unstaged snapshots for one order.
 *
 * Safe to call unconditionally; no-ops when inventoryAllocatedDate is null.
 * Must run inside the same transaction as the allocation mutation.
 */
export async function resetAllocationAccountingIfStaged(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const so = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { inventoryAllocatedDate: true },
  })
  if (!so?.inventoryAllocatedDate) return

  const journaledShipment = await tx.shipment.findFirst({
    where: { orderId, shipmentJournalDate: { not: null } },
    select: { id: true },
  })
  if (journaledShipment) {
    throw new Error(
      'Cannot modify allocations after shipments have been posted to accounting. ' +
      'Process a refund instead, or contact finance to reverse the journal entries first.',
    )
  }

  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    },
  })
  await tx.orderAllocation.updateMany({
    where: { orderId },
    data: { costLayerSnapshot: Prisma.DbNull },
  })
}

export async function updateSalesOrderStatusUnderLock(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string
    targetStatus: SalesOrderStatus
    data?: Prisma.SalesOrderUpdateInput
    bypass?: boolean
    beforeUpdate?: (context: {
      tx: Prisma.TransactionClient
      previousStatus: string
    }) => Promise<void>
  },
): Promise<{ previousStatus: string }> {
  await lockSalesOrder(tx, input.orderId)
  const lockedOrder = await tx.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { status: true },
  })
  if (!lockedOrder) throw new Error('Order not found')

  const transition = validateManualSalesOrderStatusTransition(lockedOrder.status, input.targetStatus, {
    bypass: input.bypass,
  })
  if (!transition.success) throw new Error(transition.error)

  await input.beforeUpdate?.({ tx, previousStatus: lockedOrder.status })
  await tx.salesOrder.update({
    where: { id: input.orderId },
    data: { ...(input.data ?? {}), status: input.targetStatus },
  })
  return { previousStatus: lockedOrder.status }
}

export async function applyAllocationReservationDelta(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
  direction: 'reserve' | 'release',
) {
  for (const row of rows) {
    const qty = toDecimal(row.qty)
    if (qty.lte(0)) continue
    if (direction === 'reserve') {
      const updated = await tx.stockLevel.updateMany({
        where: { productId: row.productId, warehouseId: row.warehouseId },
        data: { reservedQty: { increment: qty } },
      })
      if (updated.count === 0) {
        throw new Error(`Cannot reserve stock for product ${row.productId} in warehouse ${row.warehouseId}: no stock level exists`)
      }
      continue
    }

    // l4jq: guard the release decrement so it can never drive reservedQty
    // negative (the reserve branch above already checks updated.count).
    // reservedQty is a per-(product,warehouse) AGGREGATE: in the normal case
    // (reservedQty >= qty) the guarded decrement below releases exactly this
    // allocation's qty and PRESERVES any co-existing reservations from other
    // orders (reservedQty - qty stays positive). The floor branch only runs on
    // genuine upstream drift — a release exceeding the WHOLE aggregate
    // (reservedQty < qty) — where max(0, reserved - qty) is 0 anyway; we floor to
    // 0 rather than rely on the DB non-negative CHECK to abort the transaction.
    const released = await tx.stockLevel.updateMany({
      where: { productId: row.productId, warehouseId: row.warehouseId, reservedQty: { gte: qty } },
      data: { reservedQty: { decrement: qty } },
    })
    if (released.count === 0) {
      const floored = await tx.stockLevel.updateMany({
        where: { productId: row.productId, warehouseId: row.warehouseId },
        data: { reservedQty: 0 },
      })
      if (floored.count > 0) {
        // Loud: releasing more than the entire reserved aggregate means the
        // reservation ledger drifted upstream and needs reconciliation.
        console.error(
          `[allocation] reservedQty drift on release for product ${row.productId} @ ${row.warehouseId}: ` +
          `tried to release ${qty.toString()} but reserved was lower; floored to 0.`,
        )
      }
    }
  }
}

type ReservationScope = { productId: string; warehouseId: string }

function reservationScopeKey(scope: ReservationScope): string {
  return `${scope.productId}:${scope.warehouseId}`
}

function uniqueReservationScopes(rows: ReservationScope[]): ReservationScope[] {
  const scopes = new Map<string, ReservationScope>()
  for (const row of rows) {
    scopes.set(reservationScopeKey(row), row)
  }
  return [...scopes.values()]
}

function sumReservationRows(rows: Array<ReservationScope & { qty: DecimalInput }>): Map<string, Prisma.Decimal> {
  const totals = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    const key = reservationScopeKey(row)
    totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }
  return totals
}

export function assertReservationReleaseDelta(
  beforeRows: Array<ReservationScope & { reservedQty: DecimalInput }>,
  afterRows: Array<ReservationScope & { reservedQty: DecimalInput }>,
  releasedRows: Array<ReservationScope & { qty: DecimalInput }>,
): void {
  const beforeByKey = new Map(beforeRows.map((row) => [reservationScopeKey(row), toDecimal(row.reservedQty)]))
  const afterByKey = new Map(afterRows.map((row) => [reservationScopeKey(row), toDecimal(row.reservedQty)]))
  const releasedByKey = sumReservationRows(releasedRows)

  for (const [key, releasedQty] of releasedByKey) {
    const beforeQty = beforeByKey.get(key)
    const afterQty = afterByKey.get(key)
    if (beforeQty == null || afterQty == null) {
      throw new Error(`Reservation release invariant failed for ${key}: stock level missing`)
    }
    if (beforeQty.lt(releasedQty)) {
      throw new Error(
        `Cannot cancel order because reservedQty drifted below allocation for ${key}: reservedQty ${beforeQty.toString()}, allocationQty ${releasedQty.toString()}`,
      )
    }
    const expectedAfter = beforeQty.sub(releasedQty)
    if (afterQty.lt(0)) {
      throw new Error(`Reservation release invariant failed for ${key}: reservedQty cannot be negative`)
    }
    if (afterQty.sub(expectedAfter).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
      throw new Error(
        `Reservation release invariant failed for ${key}: expected reservedQty ${expectedAfter.toString()}, got ${afterQty.toString()}`,
      )
    }
  }
}

export async function cancelSalesOrderFulfillmentState(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string
    data?: Prisma.SalesOrderUpdateInput
    bypass?: boolean
  },
): Promise<{
  previousStatus: string
  releasedAllocationCount: number
  deletedShipmentCount: number
  releasedReservationScopes: ReservationScope[]
}> {
  await lockSalesOrder(tx, input.orderId)
  const lockedOrder = await tx.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { status: true },
  })
  if (!lockedOrder) throw new Error('Order not found')
  if (lockedOrder.status === 'SHIPPED') {
    throw new Error('Cannot cancel a shipped order — process a refund instead')
  }

  // A partially-shipped order stays ALLOCATED (it only flips to SHIPPED when ALL
  // shipments ship), so the order-status guard above is not enough. If any
  // shipment has already been dispatched/journaled, cancelling would release
  // reservations and delete pending shipments while the dispatched shipment's
  // COGS + revenue stay recognised in the ledger with no reversal. The
  // resetAllocationAccountingIfStaged check below is gated on inventoryAllocatedDate
  // (it early-returns when A2 hasn't run), so guard here unconditionally.
  const dispatchedShipment = await tx.shipment.findFirst({
    where: {
      orderId: input.orderId,
      OR: [{ shipmentJournalDate: { not: null } }, { status: 'SHIPPED' }],
    },
    select: { id: true },
  })
  if (dispatchedShipment) {
    throw new Error('Cannot cancel an order with a dispatched shipment — process a refund instead')
  }

  const transition = validateManualSalesOrderStatusTransition(lockedOrder.status, 'CANCELLED', {
    bypass: input.bypass,
  })
  if (!transition.success) throw new Error(transition.error)

  await resetAllocationAccountingIfStaged(tx, input.orderId)
  const currentAllocs = await tx.orderAllocation.findMany({
    where: { orderId: input.orderId },
    select: { productId: true, warehouseId: true, qty: true },
  })
  const releasedReservationScopes = uniqueReservationScopes(currentAllocs)
  await lockStockLevels(
    tx,
    releasedReservationScopes.map((scope) => scope.productId),
    releasedReservationScopes.map((scope) => scope.warehouseId),
  )
  const stockBefore = releasedReservationScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedReservationScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []

  // Keep the before/after reads bracketing the release: the extra locked-row
  // read is small, and it verifies the actual database delta rather than only
  // trusting the requested decrement shape.
  await applyAllocationReservationDelta(tx, currentAllocs, 'release')
  await tx.orderAllocation.deleteMany({ where: { orderId: input.orderId } })

  const deletedShipments = await tx.shipment.deleteMany({
    where: {
      orderId: input.orderId,
      status: { in: ['PENDING', 'PICKING', 'PACKED'] },
    },
  })

  const stockAfter = releasedReservationScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedReservationScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  assertReservationReleaseDelta(stockBefore, stockAfter, currentAllocs)

  await tx.salesOrder.update({
    where: { id: input.orderId },
    data: { ...(input.data ?? {}), status: 'CANCELLED' },
  })

  return {
    previousStatus: lockedOrder.status,
    releasedAllocationCount: currentAllocs.length,
    deletedShipmentCount: deletedShipments.count,
    releasedReservationScopes,
  }
}

export async function validateAllocationIntegrity(
  client: AllocationServiceClient,
  orderId: string,
  lineIds?: string[],
): Promise<string | null> {
  const lines = await client.salesOrderLine.findMany({
    where: {
      orderId,
      productId: { not: null },
      ...(lineIds?.length ? { id: { in: lineIds } } : {}),
    },
    select: {
      id: true,
      productId: true,
      qty: true,
      sku: true,
      description: true,
    },
  })
  if (lines.length === 0) return null

  const graph = await loadFulfillmentProductGraph(
    client,
    lines.map((line) => line.productId!).filter(Boolean),
  )
  const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
  for (const line of lines) {
    requirementsByLine.set(
      line.id,
      requirementsMapToDecimalRows(expandFulfillmentRequirementsDecimal(line.productId!, 1, graph)),
    )
  }

  const [allocations, activeShipmentLines] = await Promise.all([
    client.orderAllocation.findMany({
      where: {
        orderId,
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        warehouseId: true,
        qty: true,
      },
    }),
    client.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        qty: true,
      },
    }),
  ])

  const committedByLine = calculateDecimalCoverageByLine(
    requirementsByLine,
    activeShipmentLines,
  )

  for (const line of lines) {
    const requirements = requirementsByLine.get(line.id) ?? []
    if (requirements.length === 0) continue

    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))
    const lineAllocations = allocations.filter((allocation) => allocation.lineId === line.id)
    const byWarehouse = new Map<string, Map<string, Prisma.Decimal>>()

    for (const allocation of lineAllocations) {
      const quantities = byWarehouse.get(allocation.warehouseId) ?? new Map<string, Prisma.Decimal>()
      quantities.set(
        allocation.productId,
        (quantities.get(allocation.productId) ?? new Prisma.Decimal(0)).add(toDecimal(allocation.qty)),
      )
      byWarehouse.set(allocation.warehouseId, quantities)
    }

    let allocatedCoverage = new Prisma.Decimal(0)
    for (const [warehouseId, quantities] of byWarehouse) {
      const coverage = calculateDecimalFulfillmentCoverage(requirements, quantities)
      if (coverage.lte(ALLOCATION_EPSILON_DECIMAL)) {
        return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} does not contain a complete component set`
      }

      for (const requirement of requirements) {
        const actualQty = quantities.get(requirement.productId) ?? new Prisma.Decimal(0)
        const expectedQty = coverage.mul(requirement.factor)
        if (actualQty.sub(expectedQty).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
          return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} must keep bundle components in matching quantities`
        }
      }

      for (const productId of quantities.keys()) {
        if (!requiredProductIds.has(productId)) {
          return `Allocation for sales line ${line.sku ?? line.description} contains an unexpected component`
        }
      }

      allocatedCoverage = allocatedCoverage.add(coverage)
    }

    const committedCoverage = committedByLine.get(line.id) ?? new Prisma.Decimal(0)
    const remainingQty = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committedCoverage))
    if (allocatedCoverage.sub(remainingQty).abs().gt(ALLOCATION_EPSILON_DECIMAL) && allocatedCoverage.gt(remainingQty)) {
      return `Allocation for sales line ${line.sku ?? line.description} exceeds the remaining quantity to fulfill`
    }
  }

  return null
}

function mergeAllocationRows(rows: AllocationRowInput[]): AllocationRowInput[] {
  const merged = new Map<string, AllocationRowInput>()

  for (const row of rows) {
    const key = `${row.lineId}|${row.warehouseId}|${row.productId}`
    const existing = merged.get(key)
    if (existing) {
      existing.qty = existing.qty.add(row.qty)
      continue
    }
    merged.set(key, { ...row })
  }

  return [...merged.values()].filter((row) => row.qty.gt(0))
}

function collectNonOversellLeafComponents(
  productId: string,
  graph: Map<string, FulfillmentGraphNode>,
): string[] {
  const blockers = new Set<string>()

  function visit(currentProductId: string, stack: Set<string>) {
    if (stack.has(currentProductId)) return
    const node = graph.get(currentProductId)
    if (!node || node.type !== 'KIT') return

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      if (component.componentType === 'KIT') {
        visit(component.componentId, stack)
        continue
      }
      if (!component.componentOversellAllowed) {
        blockers.add(component.componentSku || component.componentId)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, new Set<string>())
  return [...blockers].sort()
}

function noAllocationResult(error: string): AllocateSalesOrderResult {
  return {
    success: false,
    error,
    syncProductIds: [],
    allocationCount: 0,
    unallocatedLines: [],
    unallocatedQty: 0,
    backorderLineCount: 0,
  }
}

export async function allocateSalesOrder(
  client: AllocationServiceClient,
  input: AllocateSalesOrderInput,
): Promise<AllocateSalesOrderResult> {
  const { orderId } = input
  const so = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      // b8i6.1: any shopping connector (not just WooCommerce) — a storefront order
      // allocates only from storefront-synced warehouses regardless of connector.
      shoppingLinks: { select: { id: true }, take: 1 },
      status: true,
      shipFromWarehouseId: true,
      lines: {
        select: {
          id: true,
          orderId: true,
          productId: true,
          qty: true,
          sku: true,
          description: true,
          product: {
            select: {
              id: true,
              sku: true,
              type: true,
              oversellAllowed: true,
            },
          },
        },
      },
    },
  })
  if (!so) return noAllocationResult('Order not found')

  const isShoppingOrder = so.shoppingLinks.length > 0
  const orderRef = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const allWarehouses = await client.warehouse.findMany({
    where: {
      active: true,
      availableForSale: true,
      ...(isShoppingOrder ? { syncToStore: true } : {}),
    },
    select: { id: true, code: true, name: true, isDefault: true, syncToStore: true },
    orderBy: { isDefault: 'desc' },
  })
  if (!allWarehouses.length) {
    return {
      ...noAllocationResult(isShoppingOrder ? 'No storefront-synced warehouses available for sale' : 'No warehouses available for sale'),
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
    }
  }

  const primaryId = so.shipFromWarehouseId
  const sorted = [...allWarehouses].sort((a, b) => {
    if (a.id === primaryId) return -1
    if (b.id === primaryId) return 1
    if (a.isDefault && !b.isDefault) return -1
    if (!a.isDefault && b.isDefault) return 1
    if (a.syncToStore && !b.syncToStore) return -1
    if (!a.syncToStore && b.syncToStore) return 1
    return 0
  })

  const productIds = so.lines.filter((line) => line.productId).map((line) => line.productId!)

  const runAllocation = async (tx: Prisma.TransactionClient) => {
    await lockSalesOrder(tx, orderId)

    if (input.refuseIfShipmentsExist) {
      const shipmentExists = await tx.shipment.findFirst({
        where: { orderId },
        select: { id: true },
      })
      if (shipmentExists) {
        return { nextAllocations: [], syncProductIds: [], refused: true as const }
      }
    }

    await resetAllocationAccountingIfStaged(tx, orderId)
    const graph = await loadFulfillmentProductGraph(tx, productIds)
    const requirementsByLine = new Map<string, DecimalFulfillmentRequirement[]>()
    for (const line of so.lines) {
      if (!line.productId) continue
      requirementsByLine.set(
        line.id,
        requirementsMapToDecimalRows(expandFulfillmentRequirementsDecimal(line.productId, 1, graph)),
      )
    }

    const leafProductIds = listFulfillmentLeafProductIds(productIds, graph)
    await lockStockLevels(tx, leafProductIds, sorted.map((warehouse) => warehouse.id))

    const stockLevels = await tx.stockLevel.findMany({
      where: { productId: { in: leafProductIds }, warehouseId: { in: sorted.map((warehouse) => warehouse.id) } },
      select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    })
    const ownAllocations = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { productId: true, warehouseId: true, qty: true },
    })
    const stockMap = buildAvailableStockMapIncludingOwnReservations(stockLevels, ownAllocations)

    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, productId: true, qty: true, shipment: { select: { status: true } } },
    })
    const committedByLine = calculateDecimalCoverageByLine(
      requirementsByLine,
      activeShipmentLines,
    )

    // Refunded quantities are no longer outstanding demand — a refund on a not-yet-
    // shipped order removes those units from what needs allocating. Only ever reduces
    // demand, so it is safe for every status (already-shipped lines clamp to 0).
    const refundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, qty: true },
    })
    const refundedByLine = new Map<string, Prisma.Decimal>()
    for (const refundLine of refundLines) {
      if (!refundLine.salesOrderLineId) continue
      refundedByLine.set(
        refundLine.salesOrderLineId,
        (refundedByLine.get(refundLine.salesOrderLineId) ?? new Prisma.Decimal(0)).add(toDecimal(refundLine.qty)),
      )
    }

    const lines = so.lines.filter((line) => line.productId).map((line) => {
      const committed = committedByLine.get(line.id) ?? new Prisma.Decimal(0)
      const refunded = refundedByLine.get(line.id) ?? new Prisma.Decimal(0)
      return {
        id: line.id,
        productId: line.productId!,
        sku: line.sku ?? line.productId!,
        qty: Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committed).sub(refunded)),
      }
    }).filter((line) => line.qty.gt(0))

    const lineOptions = new Map<string, string[]>()
    for (const line of lines) {
      const options: string[] = []
      for (const warehouse of sorted) {
        const avail = getFulfillmentAvailableQtyDecimal(line.productId, warehouse.id, graph, stockMap)
        if (avail.gte(line.qty)) options.push(warehouse.id)
      }
      lineOptions.set(line.id, options)
    }

    const forcedWarehouses = new Set<string>()
    for (const [, options] of lineOptions) {
      if (options.length === 1) forcedWarehouses.add(options[0])
    }

    const nextAllocationRows: AllocationRowInput[] = []
    const tempStock = cloneAvailableStockMap(stockMap)

    for (const line of lines) {
      const options = lineOptions.get(line.id) ?? []
      let bestWh: string | null = null
      let remaining = line.qty

      if (options.length > 0) {
        const forcedOption = options.find((warehouseId) => forcedWarehouses.has(warehouseId))
        bestWh = forcedOption ?? options[0]
      }

      if (bestWh) {
        const avail = getFulfillmentAvailableQtyDecimal(line.productId, bestWh, graph, tempStock)
        const allocQty = Prisma.Decimal.min(remaining, avail)
        if (allocQty.gt(ALLOCATION_EPSILON_DECIMAL)) {
          const requirements = expandFulfillmentRequirementsDecimal(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: bestWh, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, bestWh, 'reserve')
          remaining = remaining.sub(allocQty)
        }
      }

      if (remaining.gt(ALLOCATION_EPSILON_DECIMAL)) {
        for (const warehouse of sorted) {
          if (remaining.lte(ALLOCATION_EPSILON_DECIMAL)) break
          if (bestWh && warehouse.id === bestWh) continue
          const avail = getFulfillmentAvailableQtyDecimal(line.productId, warehouse.id, graph, tempStock)
          if (avail.lte(ALLOCATION_EPSILON_DECIMAL)) continue
          const allocQty = Prisma.Decimal.min(remaining, avail)
          const requirements = expandFulfillmentRequirementsDecimal(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: warehouse.id, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, warehouse.id, 'reserve')
          remaining = remaining.sub(allocQty)
        }
      }
    }

    const nextAllocations = mergeAllocationRows(nextAllocationRows)
    const existingAllocs = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    await applyAllocationReservationDelta(
      tx,
      existingAllocs.map((alloc) => ({
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
        qty: alloc.qty,
      })),
      'release',
    )
    await tx.orderAllocation.deleteMany({ where: { orderId } })

    for (const alloc of nextAllocations) {
      await tx.orderAllocation.create({
        data: {
          orderId,
          lineId: alloc.lineId,
          productId: alloc.productId,
          warehouseId: alloc.warehouseId,
          qty: alloc.qty,
        },
      })
    }
    await applyAllocationReservationDelta(
      tx,
      nextAllocations.map((alloc) => ({
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
        qty: alloc.qty,
      })),
      'reserve',
    )

    if (nextAllocations.length > 0 && ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING'].includes(so.status)) {
      const transition = validateSalesOrderStatusTransition(so.status, 'ALLOCATED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: 'ALLOCATED' } })
    }

    const report = buildBackorderReport({
      // Demand is net of refunds here too, so refunded units aren't reported as
      // unallocated/backordered (which would otherwise mark the result unsuccessful).
      lines: so.lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        qty: Prisma.Decimal.max(
          new Prisma.Decimal(0),
          toDecimal(line.qty).sub(refundedByLine.get(line.id) ?? new Prisma.Decimal(0)),
        ).toNumber(),
        product: line.product,
      })),
      allocations: nextAllocations.map((allocation) => ({
        lineId: allocation.lineId,
        productId: allocation.productId,
        qty: allocation.qty.toNumber(),
      })),
      shipmentLines: activeShipmentLines,
      requirementsByLine: new Map([...requirementsByLine].map(([lineId, requirements]) => [
        lineId,
        requirements.map((requirement) => ({
          productId: requirement.productId,
          factor: requirement.factor.toNumber(),
        })),
      ])),
    })

    return {
      nextAllocations,
      syncProductIds: [...new Set([
        ...existingAllocs.map((alloc) => alloc.productId),
        ...nextAllocations.map((alloc) => alloc.productId),
      ])],
      unallocatedLines: report.lines
        .filter((line) => line.unallocatedQty > ALLOCATION_EPSILON)
        .map((line) => {
          const sourceLine = so.lines.find((candidate) => candidate.id === line.lineId)
          return {
            lineId: line.lineId,
            productId: line.productId,
            sku: line.sku,
            description: line.description,
            orderedQty: line.orderedQty,
            committedShipmentQty: line.committedShipmentQty,
            allocatedQty: line.allocatedQty,
            unallocatedQty: line.unallocatedQty,
            backorderEligible: line.backorderEligible,
            reason: line.reason,
            componentBlockers: sourceLine?.product?.type === 'KIT' && sourceLine.productId
              ? collectNonOversellLeafComponents(sourceLine.productId, graph)
              : [],
          }
        }),
      unallocatedQty: report.summary.unallocatedQty,
      backorderLineCount: report.lines.filter((line) => line.unallocatedQty > ALLOCATION_EPSILON && line.backorderEligible).length,
      refused: false as const,
    }
  }

  const allocationResult = canRunTransaction(client)
    ? await client.$transaction(runAllocation, ALLOCATION_TX_OPTIONS)
    : await runAllocation(client)

  if (allocationResult.refused) {
    return {
      success: false,
      error: 'Order has existing shipments; reallocation refused',
      syncProductIds: [],
      allocationCount: 0,
      unallocatedLines: [],
      unallocatedQty: 0,
      backorderLineCount: 0,
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
    }
  }

  const allocationCount = allocationResult.nextAllocations.length
  const canLeaveUnallocated = allocationResult.unallocatedLines.every((line) => line.backorderEligible)
  const success = canLeaveUnallocated
  return {
    success,
    error: success
      ? undefined
      : allocationCount > 0
        ? 'Some lines could not be fully allocated and are not oversell-eligible'
        : 'No stock available for allocation',
    syncProductIds: allocationResult.syncProductIds,
    allocationCount,
    unallocatedLines: allocationResult.unallocatedLines,
    unallocatedQty: allocationResult.unallocatedQty,
    backorderLineCount: allocationResult.backorderLineCount,
    orderRef,
    isShoppingOrder,
    shipFromWarehouseId: so.shipFromWarehouseId,
    logAttempt: true,
  }
}
