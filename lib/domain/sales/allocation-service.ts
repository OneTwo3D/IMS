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
import { cancelPendingSalesInvoiceSyncForOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { PermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'
import {
  validateManualSalesOrderStatusTransition,
  validateSalesOrderStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import { floorQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const ALLOCATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const ALLOCATION_EPSILON = 0.000001
const ALLOCATION_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

export type AllocationServiceClient = Prisma.TransactionClient | typeof db

export type AllocateSalesOrderInput = {
  orderId: string
  refuseIfShipmentsExist?: boolean
  /**
   * o3d-67y (Codex review r11): run INSIDE the allocation transaction, after reservations are mutated and
   * immediately before it commits, ONLY on the committed (non-refused) path. Lets the caller atomically mark a
   * durable backstop resolved so a redundant, non-idempotent re-allocation cannot run in the window between the
   * allocation commit and a separate resolve. A throw here rolls the allocation back (the backstop then retries).
   */
  onReconciledInTx?: (tx: Prisma.TransactionClient) => Promise<void>
  /**
   * o3d-6ab: the set of statuses the order must STILL be in when the row lock is acquired, for this
   * allocation to be legitimate. Batch callers (the backorder allocator, the periodic reallocation
   * sweep) pick candidates by status OUTSIDE the lock; the lock serializes the writes but does not
   * revalidate the REASON for writing, so an order that moved PROCESSING→ON_HOLD (or →PICKING) in the
   * selection→lock window would still be released, deleted, recreated and re-reserved. When set and the
   * under-lock status is not in the set, allocation is an explicit no-op: nothing is written, and the
   * result is `skipped` — NOT an error (the caller's premise simply expired; another actor now owns the
   * order). Leave unset for user- and event-driven callers that allocate a specific order on purpose.
   *
   * CANCELLED / refundStatus=FULL are deliberately exempt: those already take the zero-demand path
   * below, which RELEASES reservations. Deallocation is always safe and always wanted, so the guard
   * must not turn it into a no-op that strands reservations on a cancelled order.
   */
  requireStatusUnderLock?: readonly SalesOrderStatus[]
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
  // o3d-67y: true when refuseIfShipmentsExist declined because a shipment exists — the
  // reservation was deliberately left untouched (not a failure, not a reconciliation).
  refused?: boolean
  // o3d-6ab: true when requireStatusUnderLock was set and the under-lock status was no longer
  // allocation-eligible. Explicit no-op: nothing was written, nothing was committed, and it is NOT a
  // failure — `error` is undefined so batch callers don't log it as one.
  skipped?: boolean
  // o3d-6ab: the under-lock status that caused the skip, for logging/telemetry.
  skippedStatus?: SalesOrderStatus
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

export type ReleasedOrderAllocation = {
  lineId: string
  productId: string
  warehouseId: string
  qty: number
}

/**
 * Release every allocation on an order and give the reserved quantities back, inside a
 * caller-supplied transaction. Extracted from deallocateOrder (o3d-5r8) so deleteSalesOrder
 * can run the guard checks, the release and the delete under ONE order-row lock — checking
 * deletability in one transaction and deleting in another reopens exactly the window a
 * posting worker needs to claim the order out from under the deleter.
 *
 * The caller MUST already hold the order's row lock (lockSalesOrder).
 *
 * Throws (via resetAllocationAccountingIfStaged) when a shipment on this order has already
 * been journaled — those allocations back a posted cost entry and must not be released.
 */
export async function releaseOrderAllocationsInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ allocations: ReleasedOrderAllocation[]; clampedReservationCount: number }> {
  await resetAllocationAccountingIfStaged(tx, orderId)
  const currentAllocs = await tx.orderAllocation.findMany({
    where: { orderId },
    select: { lineId: true, productId: true, warehouseId: true, qty: true },
  })
  await lockStockLevels(
    tx,
    [...new Set(currentAllocs.map((alloc) => alloc.productId))],
    [...new Set(currentAllocs.map((alloc) => alloc.warehouseId))],
  )

  const allocations = currentAllocs.map((alloc) => ({
    lineId: alloc.lineId,
    productId: alloc.productId,
    warehouseId: alloc.warehouseId,
    qty: Number(alloc.qty),
  }))
  await applyAllocationReservationDelta(tx, allocations, 'release')
  const clampedReservations = await tx.stockLevel.updateMany({
    where: { reservedQty: { lt: 0 } },
    data: { reservedQty: 0 },
  })
  await tx.orderAllocation.deleteMany({ where: { orderId } })

  return { allocations, clampedReservationCount: clampedReservations.count }
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
    // Construct a clean scope rather than storing `row`: callers pass allocation rows that also carry
    // `qty`, and these scopes are fed straight into `stockLevel.findMany({ where: { OR: scopes } })`.
    // A stray `qty` there is an "Unknown argument `qty`" Prisma error that makes cancelling any
    // ALLOCATED order throw (unallocated orders skip the read, which is why it stayed hidden).
    scopes.set(reservationScopeKey(row), { productId: row.productId, warehouseId: row.warehouseId })
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

  // Durable evidence that goods actually left. Read BEFORE the status guard because it is what decides
  // whether a refusal is PERMANENT: SalesOrder.status alone is not proof of dispatch — importWcOrder
  // writes the configurable WooCommerce status mapping straight into it, and a store may map a status to
  // SHIPPED on an order that has allocations but no shipment at all (o3d-bx9).
  //
  // A partially-shipped order stays ALLOCATED (it only flips to SHIPPED when ALL
  // shipments ship), so the order-status guard below is not enough on its own. If any
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

  if (lockedOrder.status === 'SHIPPED') {
    // Only irreversible once something actually shipped. A SHIPPED status with NO dispatch evidence is a
    // data inconsistency rather than a terminal fact, so it is NOT marked permanent.
    //
    // KNOWN GAP (o3d-gz6), unchanged by o3d-bx9: such an order also cannot currently self-heal, because
    // importWcOrder's existing-order path refreshes addresses/notes/paidAt but never status, and nothing
    // re-runs a status sync. So a Woo cancel of a falsely-SHIPPED order still exhausts its retries — as
    // it did before this change. Deciding to let that cancel through would release fulfilment state on an
    // order the IMS believes shipped, which is a product call, not a classification one.
    const message = 'Cannot cancel a shipped order — process a refund instead'
    throw dispatchedShipment ? new PermanentStatusTransitionError(message) : new Error(message)
  }

  if (dispatchedShipment) {
    throw new PermanentStatusTransitionError('Cannot cancel an order with a dispatched shipment — process a refund instead')
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

  // Retire any still-pending SALES_INVOICE accounting work in the SAME transaction, so the real-time
  // sync drain cannot post an ACCREC invoice for this now-cancelled, never-shipped order (o3d-5rs).
  await cancelPendingSalesInvoiceSyncForOrder(tx, input.orderId, new Date())

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

/** Scale of `OrderAllocation.qty` — `@db.Decimal(12, 4)`. */
const ALLOCATION_QTY_SCALE = 4

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

/**
 * Is the freshly computed allocation set identical to what is already persisted (o3d-i5it)?
 *
 * Compared as a SET keyed on (lineId, warehouseId, productId) — the same key mergeAllocationRows
 * dedupes on — because row order is not meaningful and neither side is ordered.
 *
 * Both sides are at the persisted scale by the time they reach here: the caller canonicalises the
 * computed set to ALLOCATION_QTY_SCALE, and the column can hold nothing else. So the quantity
 * comparison is EXACT, not tolerance-based — comparing at one scale while mutating reservations at
 * another is precisely the mismatch that made this check unreliable (o3d-i4qd).
 *
 * Decimal.eq rather than `===` because two Decimals of equal value can differ in representation.
 */
export function allocationSetsMatch(
  existing: Array<{ lineId: string; productId: string; warehouseId: string; qty: Prisma.Decimal }>,
  next: AllocationRowInput[],
): boolean {
  if (existing.length !== next.length) return false

  const key = (row: { lineId: string; warehouseId: string; productId: string }) =>
    `${row.lineId}|${row.warehouseId}|${row.productId}`

  const existingByKey = new Map(existing.map((row) => [key(row), toDecimal(row.qty)]))
  if (existingByKey.size !== existing.length) return false // duplicate keys: not a canonical set

  for (const row of next) {
    const persisted = existingByKey.get(key(row))
    if (!persisted || !persisted.eq(row.qty)) return false
  }
  return true
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

    // Re-read status UNDER the row lock. `so.status` above was read for warehouse selection BEFORE
    // the lock, and the order may have moved since — a concurrent CANCELLED, ON_HOLD, or full refund.
    // Every decision below that depends on status uses THIS value, not the stale one (o3d-2s8, Codex
    // review of #496).
    const locked = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { status: true, refundStatus: true },
    })
    const lockedStatus = locked?.status ?? so.status

    if (input.refuseIfShipmentsExist) {
      const shipmentExists = await tx.shipment.findFirst({
        where: { orderId },
        select: { id: true },
      })
      if (shipmentExists) {
        return { nextAllocations: [], syncProductIds: [], refused: true as const, skippedStatus: null }
      }
    }

    // A CANCELLED or fully-refunded order has ZERO allocation demand — it must hold no reservations.
    // We do NOT refuse (that would strand its existing allocations); instead demand is treated as zero
    // so the release-and-delete below runs and reserves nothing, making allocation a pure
    // deallocation. FULL is included because it is a MONETARY classification (a full-value refund can
    // occur with less than full product QUANTITY — an amount-only or shipping refund), so the
    // per-line quantity demand can be non-zero even when the order is fully refunded; without this an
    // order refunded in full could be re-reserved and promoted. Both are read UNDER the lock, so a
    // refund committing between the payment advance and this allocation is honoured (Codex review #496).
    const zeroDemand = lockedStatus === 'CANCELLED' || locked?.refundStatus === 'FULL'

    // o3d-6ab: revalidate the CALLER'S PREMISE under the lock, not just the order's own state. Batch
    // callers select candidates by status outside the lock; by the time the lock is granted the order
    // may have moved to a status that no longer wants (re)allocation — ON_HOLD, or already advanced past
    // PROCESSING into PICKING/PACKED/SHIPPED. Without this the release/delete/recreate + re-reserve below
    // still runs, silently re-reserving stock for a held order and churning an order someone else now
    // owns. Skipped BEFORE the first write (resetAllocationAccountingIfStaged) so the no-op is total.
    // zeroDemand is exempt on purpose — see requireStatusUnderLock's doc comment: releasing a
    // cancelled/fully-refunded order's reservations is always correct, so it must not be short-circuited.
    if (
      !zeroDemand &&
      input.requireStatusUnderLock &&
      !input.requireStatusUnderLock.includes(lockedStatus)
    ) {
      return {
        nextAllocations: [],
        syncProductIds: [],
        refused: false as const,
        skippedStatus: lockedStatus,
      }
    }

    // NOTE: resetAllocationAccountingIfStaged is deliberately NOT called here (o3d-i5it). It used
    // to run before the allocation was even computed, so a re-run that changed nothing still
    // cleared inventoryAllocatedDate and the cost snapshots. It now runs only once the computed
    // set is known to DIFFER from the persisted one — see the unchanged-set check below.
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

    const lines = zeroDemand ? [] : so.lines.filter((line) => line.productId).map((line) => {
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

    // Canonicalise ONCE, at the point the set is produced (o3d-i4qd, o3d-i5it).
    //
    // OrderAllocation.qty is @db.Decimal(12,4) and nothing here rounded before writing — the
    // COLUMN did it. But the reservation delta was applied from the UNROUNDED value against
    // StockLevel.reservedQty, which holds 6dp. So a reserve wrote X while the row recorded
    // round(X,4), and the later release — which reads the ROW — gave back round(X,4). The
    // difference leaked into reservedQty as a phantom reservation on every cycle, worst for
    // nested KITs where the expanded factor is unquantized (0.3332 x 0.3332 = 0.11102224).
    //
    // FLOOR, not half-up. An allocation quantity is a CLAIM on stock, and feasibility was decided
    // against the unrounded value, so rounding UP can claim more than was checked: a 0.999960
    // residual would become 1.0000 and violate the reservedQty <= quantity constraint, and a
    // nested KIT's 0.11108889 would become 0.1111 — representing 1.0001 kits, which
    // validateAllocationIntegrity later rejects at shipment confirmation as over-allocated.
    // Flooring can only ever claim LESS than was proven available, so it cannot manufacture
    // either failure; the cost is that such a line reports as slightly short, which is the
    // remaining half of o3d-i4qd.
    //
    // Rounding here makes the row, the reservation delta, the coverage comparison and the
    // report all speak in the same units, so reserve and release are symmetric and the
    // unchanged-set check compares like with like.
    const canonicalAllocations = mergeAllocationRows(nextAllocationRows)
      .map((row) => ({ ...row, qty: floorQuantity(row.qty, ALLOCATION_QTY_SCALE) }))

    // A positive requirement that floors away is NOT nothing — StockLevel carries 6dp, so the
    // demand is real but smaller than an OrderAllocation row can represent. It is left out of the
    // set (so the line reports as unallocated rather than silently satisfied) and surfaced, because
    // silently dropping it is how a partial allocation disappears without trace.
    for (const dropped of canonicalAllocations.filter((row) => !row.qty.gt(0))) {
      console.warn(
        `[allocation] order ${orderId} line ${dropped.lineId}: component ${dropped.productId} requires `
        + `less than the ${ALLOCATION_QTY_SCALE}dp OrderAllocation scale can represent; left unallocated`,
      )
    }

    const nextAllocations = canonicalAllocations.filter((row) => row.qty.gt(0))
    const existingAllocs = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })

    // o3d-i5it: when the computed set is identical to the persisted one, write NOTHING.
    //
    // The reset + release/delete/recreate/reserve cycle used to run unconditionally. That was
    // tolerable while a stock event was the only driver. The o3d-9lx sweep rotates every 15
    // minutes and selects every order with outstanding demand — including permanent partial
    // backorders that cannot improve because no more stock exists — so each rotation destructively
    // rewrote them.
    //
    // The damaging part is the accounting reset: for an ALLOCATED partial backorder already
    // processed by Group A2, clearing inventoryAllocatedDate and the cost snapshots lets the next
    // daily batch stage and post the SAME inventory reclassification again, and AccountingSyncLog
    // has no uniqueness constraint that would stop the later-dated journal. Duplicate journals, not
    // merely churn. Redundant storefront syncs and allocation activity came with it.
    //
    // Only the WRITES are skipped. The backorder report, the status promotion and the return value
    // are all still computed from in-memory state, so an unchanged run reports exactly what a
    // changed one would — callers cannot tell the difference except that nothing moved.
    const unchanged = allocationSetsMatch(existingAllocs, nextAllocations)

    if (!unchanged) {
      // Reached only for a real modification, so the accounting reset — and its posted-shipment
      // guard — applies to an actual allocation change rather than to a no-op re-run.
      await resetAllocationAccountingIfStaged(tx, orderId)

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
    }

    // Promote to ALLOCATED only off the UNDER-LOCK status. Deciding on the stale pre-lock so.status
    // is how a concurrent PROCESSING→ON_HOLD (or →CANCELLED) got resumed to ALLOCATED off a value
    // that was no longer true (o3d-2s8, Codex review of #496). ON_HOLD/CANCELLED are not in the set,
    // so a held or cancelled order keeps its status; it is simply not un-paused by allocation.
    if (nextAllocations.length > 0 && ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING'].includes(lockedStatus)) {
      const transition = validateSalesOrderStatusTransition(lockedStatus, 'ALLOCATED')
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

    // o3d-67y (Codex r11): resolve the durable release backstop atomically with the reservation mutations, so a
    // crash between this commit and a separate resolve cannot leave the row pending for a redundant re-allocation.
    // NOTE: the storefront stock-sync (enqueueStockSync in autoAllocateOrder) still runs POST-commit and remains
    // best-effort — a crash after commit can lose it. That is a pre-existing, cross-cutting stock-sync durability
    // gap (all allocation flows, non-Woo connectors), tracked separately in o3d-jhq, not resolved here.
    await input.onReconciledInTx?.(tx)

    return {
      nextAllocations,
      // Nothing moved on an unchanged run, so nothing to push to the storefront. Emitting these
      // unconditionally is what produced the endless redundant syncs (o3d-i5it).
      syncProductIds: unchanged ? [] : [...new Set([
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
      skippedStatus: null,
    }
  }

  const allocationResult = canRunTransaction(client)
    ? await client.$transaction(runAllocation, ALLOCATION_TX_OPTIONS)
    : await runAllocation(client)

  // o3d-6ab: the under-lock status no longer satisfied requireStatusUnderLock. Nothing was written and
  // the transaction is a no-op, so this is neither a success nor a failure — `error` stays undefined so
  // batch callers don't record it as an allocation failure, and logAttempt stays false so it isn't
  // written to the activity log as an attempt that never happened.
  if (allocationResult.skippedStatus) {
    return {
      success: false,
      syncProductIds: [],
      allocationCount: 0,
      unallocatedLines: [],
      unallocatedQty: 0,
      backorderLineCount: 0,
      orderRef,
      isShoppingOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
      skipped: true,
      skippedStatus: allocationResult.skippedStatus,
    }
  }

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
      refused: true,
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
