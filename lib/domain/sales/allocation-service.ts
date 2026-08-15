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
  RESERVATION_RELEASING_SHIPMENT_STATUS,
  UNCOMMITTED_SHIPMENT_STATUS,
  residualAllocationRows,
  residualAllocationRowsForOrder,
} from '@/lib/domain/inventory/reservation-residual'
import { cancelPendingSalesInvoiceSyncForOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { PermanentStatusTransitionError } from '@/lib/domain/sales/status-transition-errors'
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

/**
 * Available stock with THIS order's own reservation added back, so a recomputation is not fighting
 * reservations it already holds.
 *
 * `ownRows` MUST be residual rows (`residualAllocationRows`) — this order's LIVE reservation, not
 * its retained `OrderAllocation` quantities. Raw rows over-state ownQty on a dispatched order,
 * which under-computes `otherReservedQty` by the shipped amount and lets this order allocate
 * straight into another order's live reservation (o3d-4kfh).
 */
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

/**
 * (product, warehouse) scopes where this order's OWN LIVE reservation exceeds what is actually
 * reserved against it (o3d-4kfh).
 *
 * `ownRows` MUST be residual rows (`residualAllocationRows`), never raw `OrderAllocation` rows.
 * Dispatch decrements reservedQty and retains the allocation row, so on any partially or fully
 * dispatched order `rawQty > reservedQty` is the CORRECT steady state — feeding raw rows here made
 * this fire on healthy data, which is exactly the noise that hid the real leak.
 *
 * Detection only. The unconditional release/delete/recreate/reserve cycle does NOT repair such a
 * row — it releases this order's own quantity and reserves the same quantity straight back, which
 * nets to zero against the discrepancy. So neither allocating nor short-circuiting fixes it, and
 * forcing a rewrite would only reintroduce churn.
 *
 * With the release paths fixed to release residuals and to fail closed rather than floor a whole
 * scope to zero, the leak that GENERATED these shortfalls is gone. A surviving report now means a
 * writer outside these paths, and `invariants.ts` (`stock_reserved_source_mismatch`) is the census.
 */
export function findUnderReservedScopes(
  stockRows: Array<{ productId: string; warehouseId: string; reservedQty: DecimalInput }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
): Array<{ productId: string; warehouseId: string }> {
  const ownByScope = new Map<string, Prisma.Decimal>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByScope.set(key, (ownByScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)))
  }

  const scopes: Array<{ productId: string; warehouseId: string }> = []
  for (const row of stockRows) {
    const ownQty = ownByScope.get(`${row.productId}:${row.warehouseId}`)
    if (!ownQty) continue
    if (ownQty.gt(toDecimal(row.reservedQty).add(ALLOCATION_EPSILON_DECIMAL))) {
      scopes.push({ productId: row.productId, warehouseId: row.warehouseId })
    }
  }
  return scopes
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

/**
 * Which sales orders each open transaction has row-locked (o3d-3zgy).
 *
 * Postgres cannot answer this for us: an uncontended `SELECT ... FOR UPDATE` records the lock in the
 * tuple header, not in `pg_locks`, so there is nothing to query. This registry is therefore an
 * IN-PROCESS assertion aid, not a distributed guarantee — its job is to make a caller that forgot to
 * hoist the lock fail loudly instead of silently reopening the delete race.
 *
 * Keyed weakly on the transaction client, so entries disappear with the transaction object and
 * nothing has to clean up on commit or rollback.
 */
const ordersLockedByTx = new WeakMap<object, Set<string>>()

/** Has THIS transaction already row-locked this order? See ordersLockedByTx for the caveats. */
export function hasLockedSalesOrder(tx: Prisma.TransactionClient, orderId: string): boolean {
  return ordersLockedByTx.get(tx as object)?.has(orderId) ?? false
}

export async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`,
  )
  // Recorded AFTER the lock is actually held, so a failed lock never registers.
  const locked = ordersLockedByTx.get(tx as object)
  if (locked) locked.add(orderId)
  else ordersLockedByTx.set(tx as object, new Set([orderId]))
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
      // o3d-0qoo: the A2 batch ref goes with its stamp in the same update — see the note at the
      // REFUNDED un-stage in refund-service.ts for why a ref without a stamp is worse than neither.
      inventoryAllocatedDate: null,
      inventoryAllocatedBatchRef: null,
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
 * TEARDOWN release: give the reserved quantities back and DESTROY every allocation row, inside a
 * caller-supplied transaction. Extracted from deallocateOrder (o3d-5r8) so deleteSalesOrder
 * can run the guard checks, the release and the delete under ONE order-row lock — checking
 * deletability in one transaction and deleting in another reopens exactly the window a
 * posting worker needs to claim the order out from under the deleter.
 *
 * o3d-4kfh — THIS FUNCTION IS FOR PATHS WHERE THE ORDER ITSELF IS GOING AWAY (hard delete, and the
 * cancellation shape that deletes the shipments alongside it). It deletes the rows unconditionally,
 * so it destroys two things a surviving order still needs:
 *
 *   - the row a committed (PICKING/PACKED) shipment was picked from. The reservation goes back but
 *     the shipment stays dispatchable, and dispatch checks only the shared per-(product, warehouse)
 *     `reservedQty` — so it either fails or spends another order's reservation.
 *   - the allocation IDENTITY and its `costLayerSnapshot`, which the Group B shipment journal and
 *     the refund cost reversal resolve through `orderAllocationId`.
 *
 * User-initiated deallocation on a LIVE order must therefore go through
 * {@link releaseOrderAllocationsForDeallocationInTx}, which refuses instead.
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

  // o3d-4kfh: release the RESIDUAL, not the retained quantity. This path has no dispatched-shipment
  // guard at all, so it is routinely handed allocation rows whose units have already left: dispatch
  // decrements reservedQty and RETAINS the row. Releasing the raw row quantity therefore asked for
  // more than the order still holds, which the guarded decrement cannot satisfy.
  const releasedRows = await residualAllocationRowsForOrder(tx, orderId, currentAllocs)
  const releasedScopes = uniqueReservationScopes(releasedRows)
  const stockBefore = releasedScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  await applyAllocationReservationDelta(tx, releasedRows, 'release')
  const clampedReservations = await tx.stockLevel.updateMany({
    where: { reservedQty: { lt: 0 } },
    data: { reservedQty: 0 },
  })
  const stockAfter = releasedScopes.length
    ? await tx.stockLevel.findMany({
      where: { OR: releasedScopes },
      select: { productId: true, warehouseId: true, reservedQty: true },
    })
    : []
  // Bracket the release with the same fail-closed assertion cancelSalesOrderFulfillmentState uses,
  // so the actual database delta is verified rather than the requested decrement merely trusted.
  assertReservationReleaseDelta(stockBefore, stockAfter, releasedRows)
  await tx.orderAllocation.deleteMany({ where: { orderId } })

  return { allocations, clampedReservationCount: clampedReservations.count }
}

/**
 * USER deallocation: the same release, but REFUSED while the order holds any committed shipment
 * (o3d-4kfh).
 *
 * "Deallocate" is offered in the SO detail UI whenever allocations exist, and it used to run the
 * teardown release above on any order at all. On a PICKING or PACKED shipment that released the
 * live reservation while leaving the shipment dispatchable; on a SHIPPED-but-unjournaled one it
 * deleted the allocation identity and cost snapshot the Group B journal and the refund reversal
 * resolve through `orderAllocationId` — the very thing the manual-edit guard in `updateAllocation`
 * refuses to do one row at a time.
 *
 * The bounded fix is to refuse, not to invent cancellation semantics for a committed shipment.
 * A PENDING shipment is not a commitment and never blocks, so the ordinary case is unaffected.
 *
 * BUT NOTE WHAT THE OPERATOR IS ACTUALLY LEFT WITH, because it is narrower than it looks:
 * IMS has NO per-shipment cancel or rollback at all. `SHIPMENT_TRANSITIONS` is forward-only
 * (PENDING -> PICKING -> PACKED -> SHIPPED) and no action deletes a non-PENDING shipment. So the
 * only two ways out of this refusal are to DISPATCH the shipment, or to cancel the WHOLE order —
 * `cancelSalesOrderFulfillmentState` deletes the PENDING/PICKING/PACKED shipments in the same
 * transaction as the release, which is exactly the atomicity this path lacks. The refusal message
 * must therefore not tell the operator to "cancel the shipment": that button does not exist.
 * Filling that gap (o3d-tv1q) is a product decision, not part of this fix.
 *
 * The caller MUST already hold the order's row lock (lockSalesOrder).
 */
export async function releaseOrderAllocationsForDeallocationInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ allocations: ReleasedOrderAllocation[]; clampedReservationCount: number }> {
  const committedShipments = await tx.shipment.findMany({
    where: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } },
    select: { id: true, status: true },
  })
  if (committedShipments.length > 0) {
    const byStatus = new Map<string, number>()
    for (const shipment of committedShipments) {
      const status = String(shipment.status)
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    }
    const summary = [...byStatus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
      .join(', ')
    throw new Error(
      `Cannot deallocate this order while it has committed shipments (${summary}). `
      + 'A picked or packed shipment is stock the warehouse is already holding against this order, and a '
      + 'shipped one is the cost evidence the accounting sub-ledger reverses through its allocation row — '
      + 'releasing either would leave the shipment dispatchable against another order\'s reservation. '
      + 'Dispatch those shipments, or cancel the whole order.',
    )
  }
  return releaseOrderAllocationsInTx(tx, orderId)
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
    // orders (reservedQty - qty stays positive).
    const released = await tx.stockLevel.updateMany({
      where: { productId: row.productId, warehouseId: row.warehouseId, reservedQty: { gte: qty } },
      data: { reservedQty: { decrement: qty } },
    })
    if (released.count === 0) {
      // o3d-4kfh: FAIL CLOSED. This used to floor the WHOLE (product, warehouse) scope to 0 and
      // log about "upstream drift". reservedQty is an aggregate shared by every sales order and
      // every production order, so that floor annihilated every OTHER holder's reservation in the
      // scope — orders that were never touched by this transaction, and could not even be named in
      // the log line. It was also self-fulfilling: the commonest way to reach it was releasing an
      // allocation's RAW retained quantity instead of its residual after a partial dispatch, so the
      // line blaming "upstream drift" WAS the upstream drift.
      //
      // Refusing the write is strictly better. The caller's transaction rolls back, this order's
      // reservation is left exactly as it was, and no third party is silently robbed. It is the
      // same stance assertReservationReleaseDelta already took for cancellation — which is why
      // cancelSalesOrderFulfillmentState was the one release path that could not cause this.
      throw new Error(
        `Cannot release ${qty.toString()} reserved unit(s) of product ${row.productId} @ ${row.warehouseId}: `
        + 'reservedQty is lower than the release, or no stock level exists. Releasing anyway would '
        + 'zero the reservations of other orders sharing this product/warehouse (o3d-4kfh).',
      )
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
  // o3d-gz6: true when the order was SHIPPED with no dispatch evidence and its status was repaired to a
  // pre-ship state so this cancel could proceed. The caller should audit it.
  repairedFalseShipped: boolean
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

  // The status used to validate the CANCELLED transition. Normally the order's real status; for a
  // FALSE-SHIPPED order (o3d-gz6, below) it is repaired to the correct pre-ship state.
  let effectiveStatus: string = lockedOrder.status
  let repairedFalseShipped = false

  if (lockedOrder.status === 'SHIPPED') {
    if (dispatchedShipment) {
      // Genuinely dispatched — an irreversible fact. Cancelling would release reservations and delete
      // pending shipments while the dispatched shipment's recognised COGS + revenue stay in the ledger
      // with no reversal. Refuse permanently: process a refund instead.
      throw new PermanentStatusTransitionError(
        'Cannot cancel a shipped order — process a refund instead')
    }
    // FALSE-SHIPPED (o3d-gz6): the SHIPPED status came from the configurable WooCommerce status mapping
    // (importWcOrder writes it straight into status), NOT a real dispatch — there is no SHIPPED/journaled
    // shipment. The status is therefore unreliable, so REPAIR it to its correct pre-ship state and let
    // the Woo cancellation proceed to release fulfilment and reach CANCELLED, instead of the shipped-order
    // guard refusing it forever (the event exhausted its retries and dead-lettered). An order carrying
    // allocations is canonically ALLOCATED (allocation flow), else PROCESSING; both legally transition to
    // CANCELLED. The anomaly is surfaced via repairedFalseShipped so the caller can audit it.
    const allocCount = await tx.orderAllocation.count({ where: { orderId: input.orderId } })
    effectiveStatus = allocCount > 0 ? 'ALLOCATED' : 'PROCESSING'
    repairedFalseShipped = true
  }

  if (dispatchedShipment) {
    throw new PermanentStatusTransitionError('Cannot cancel an order with a dispatched shipment — process a refund instead')
  }

  const transition = validateManualSalesOrderStatusTransition(effectiveStatus, 'CANCELLED', {
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
    repairedFalseShipped,
  }
}

/**
 * Structural + quantity check on an order's allocation rows.
 *
 * o3d-4kfh — reads `OrderAllocation.qty` under the contract stated in `allocateSalesOrder`: a row
 * covers its committed shipment lines as well as the outstanding demand. So the quantity test
 * subtracts the SAME non-PENDING shipment set from both sides — from the rows (per allocation
 * scope) and from the line's ordered quantity — and compares what is left. Comparing raw rows
 * against a net demand figure is not a stricter check, it is an incoherent one.
 */
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
        // o3d-4kfh: the warehouse is what makes a shipment line attributable to the allocation row
        // it commits — (lineId, warehouseId, productId) is the grain both tables share.
        shipment: { select: { warehouseId: true } },
      },
    }),
  ])

  const committedByLine = calculateDecimalCoverageByLine(
    requirementsByLine,
    activeShipmentLines,
  )
  // o3d-4kfh: committed quantity per ALLOCATION ROW, the subtrahend that turns a retained row into
  // the open (still-to-ship) quantity this check is about. Same non-PENDING set as committedByLine
  // above, so the two sides of the final comparison net the SAME shipments out.
  const committedByAllocationScope = new Map<string, Prisma.Decimal>()
  for (const shipmentLine of activeShipmentLines) {
    const key = `${shipmentLine.lineId}|${shipmentLine.shipment.warehouseId}|${shipmentLine.productId}`
    committedByAllocationScope.set(
      key,
      (committedByAllocationScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)),
    )
  }

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

    // o3d-4kfh: the STRUCTURAL checks below (complete component set, proportional components, no
    // stranger components) run on the RAW row quantities, because that is what is persisted and
    // what every other consumer expands. Only the total is netted, in `openCoverage`.
    let openCoverage = new Prisma.Decimal(0)
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

      // The OPEN coverage of this warehouse's rows: the same rows with their own committed
      // shipment lines netted off, floored per row exactly as `residualAllocationQty` floors.
      // Without this the check compared a retained row (which covers its shipments by contract)
      // against a demand figure with those same shipments already subtracted, so every partially
      // dispatched order read as over-allocated by the dispatched amount — blocking shipment
      // confirmation and every manual allocation edit for the rest of that order's life.
      const openQuantities = new Map<string, Prisma.Decimal>()
      for (const [productId, qty] of quantities) {
        const committed = committedByAllocationScope.get(`${line.id}|${warehouseId}|${productId}`)
          ?? new Prisma.Decimal(0)
        openQuantities.set(productId, Prisma.Decimal.max(new Prisma.Decimal(0), qty.sub(committed)))
      }
      openCoverage = openCoverage.add(calculateDecimalFulfillmentCoverage(requirements, openQuantities))
    }

    const committedCoverage = committedByLine.get(line.id) ?? new Prisma.Decimal(0)
    const remainingQty = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committedCoverage))
    if (openCoverage.sub(remainingQty).abs().gt(ALLOCATION_EPSILON_DECIMAL) && openCoverage.gt(remainingQty)) {
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

/**
 * Is the freshly computed allocation set identical to what is already persisted (o3d-i5it)?
 *
 * Compared as a SET keyed on (lineId, warehouseId, productId) — the same key mergeAllocationRows
 * dedupes on — because row order is not meaningful and neither side is ordered.
 *
 * The quantity comparison is EXACT — Decimal.eq, not a tolerance. Comparing at one scale while
 * mutating reservations at another is precisely the mismatch that made an earlier version of this
 * check unreliable, so it must not quietly absorb a difference (o3d-i4qd).
 *
 * The consequence is that a computed quantity the column cannot represent exactly — a nested KIT's
 * 0.11102224 against its persisted 0.1110 — reports as a CHANGE, so the short-circuit does not fire
 * and that order keeps being rewritten. That is the pre-existing behaviour and is tracked as
 * o3d-i4qd; the fix belongs in how the set is canonicalised, not in loosening this comparison.
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
    // Loaded BEFORE the own-allocation read because the reservation view of those rows depends on
    // it: warehouseId is selected so a shipment line can be attributed to the allocation row it
    // dispatched, which is the (lineId, warehouseId, productId) grain.
    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: {
        lineId: true,
        productId: true,
        qty: true,
        shipment: { select: { status: true, warehouseId: true } },
      },
    })
    // Every COMMITTED shipment line at allocation-row grain. "Committed" is the demand view: any
    // non-PENDING shipment is a promise this order has already made, which is why the demand
    // netting below subtracts it and why the rows must keep covering it (see persistedAllocations).
    const committedAllocationLines = activeShipmentLines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      warehouseId: line.shipment.warehouseId,
      status: line.shipment.status,
      qty: toDecimal(line.qty),
    }))
    // o3d-4kfh: only DISPATCHED lines have given reservation back. The reservation view is
    // therefore a STRICT SUBSET of the committed set above: reservedQty is decremented solely on
    // the transition to SHIPPED, so a PICKING/PACKED line is committed demand AND live reservation
    // at the same time. Conflating the two under-releases (netting a picked line out of a residual
    // strands its reservation forever).
    const dispatchedAllocationLines = committedAllocationLines.filter(
      (line) => line.status === RESERVATION_RELEASING_SHIPMENT_STATUS,
    )

    const ownAllocations = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    // o3d-4kfh: this order's LIVE reservation, not its retained allocation rows. Feeding the raw
    // rows here did two separate kinds of damage on any partially/fully dispatched order:
    // otherReservedQty came out too low, over-stating availability and letting this order allocate
    // into another order's live reservation; and findUnderReservedScopes reported the perfectly
    // healthy steady state (ownQty > reservedQty by exactly the shipped amount) as an integrity
    // ERROR. Both are the same arithmetic mistake as the release paths.
    const ownReservationRows = residualAllocationRows(ownAllocations, dispatchedAllocationLines)
    const stockMap = buildAvailableStockMapIncludingOwnReservations(stockLevels, ownReservationRows)

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

    // NOT canonicalised to the persisted scale here — three attempts at that failed, and the
    // reasons are worth keeping (o3d-i4qd):
    //
    //   - ROUND_HALF_UP rounds UP, but feasibility was decided against the UNROUNDED value, so
    //     the row can claim more than was proven available: a 0.999960 residual becomes 1.0000
    //     and violates the reservedQty <= quantity constraint.
    //   - flooring each row INDEPENDENTLY breaks the KIT invariant. Components of one kit are a
    //     COUPLED, proportional set, and validateAllocationIntegrity enforces that to 1e-6.
    //     Flooring 0.11108889 -> 0.1110 while 0.3333 stays exact makes the two disagree about
    //     how many kits they represent, and shipment confirmation then refuses the order with
    //     "must keep bundle components in matching quantities". Excluding a sub-scale component
    //     while keeping its siblings is the same corruption by another route.
    //
    // Doing it correctly means canonicalising each (line, warehouse) fulfilment set ATOMICALLY:
    // derive one representable coverage, regenerate every component from it, verify integrity
    // BEFORE persisting, and drop the whole set — reserving none of it — if no proportional
    // representation exists. That is o3d-i4qd, and it is a redesign rather than a rounding call.
    //
    // Leaving it unrounded is the PRE-EXISTING behaviour: the column rounds on write, so the
    // reservation drift o3d-i4qd describes remains, and the unchanged-set check below simply does
    // not fire for a nested KIT whose expanded factor is unrepresentable. Both are unchanged from
    // before this branch — no new breakage, and the short-circuit still fires for every ordinary
    // line, which is the overwhelming majority.

    // The OUTSTANDING allocation: demand this run still had to place, and therefore the only part
    // of the persisted set the allocator was free to choose. The backorder report and the status
    // promotion read it, because both are about work still to do.
    const nextAllocations = mergeAllocationRows(nextAllocationRows)

    // o3d-4kfh — THE CONTRACT. `OrderAllocation.qty` is the order's WHOLE claim on that
    // (line, warehouse, product): outstanding demand PLUS every committed shipment line, retained
    // through pick, pack and dispatch. Two readings are derived from it, and both are subtractions
    // of a shipment set the row is guaranteed to cover:
    //
    //   live reservation   = qty − SHIPPED          (reservedQty is decremented only there)
    //   open (unshipped)   = qty − non-PENDING      (what still has to be picked and shipped)
    //
    // Dispatch decrements reservedQty and deliberately keeps the row (shipment-service, and the
    // contract note in refund-service). Every other consumer already reads it that way:
    // confirmSalesOrderShipments derives its remaining quantity as `alloc.qty − committed`, the
    // backorder-demand report as `alloc.qty − committed`, and the reservation breakdown plus the
    // `stock_reserved_source_mismatch` invariant as `GREATEST(oa.qty − shipped, 0)`.
    //
    // The one place that broke the contract was HERE: demand is netted by committed shipments, so
    // a rewrite shrank the rows to the undispatched remainder. From that moment neither reading is
    // recoverable from the row, and nothing in it says which one applies. That is not a formula
    // you can fix — it is an ambiguity you have to remove, by writing rows that cover the
    // commitments again.
    //
    // Retention is over the COMMITTED set, not the dispatched one. Retaining only dispatch would
    // rebuild the same bug one status earlier: a PICKING shipment is netted out of demand but has
    // released NO reservation, so a row shrunk to the outstanding remainder would under-state this
    // order's live reservation by the picked quantity — released short here, and released again by
    // the dispatch that follows.
    const persistedAllocations = mergeAllocationRows([
      ...nextAllocationRows,
      ...committedAllocationLines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        warehouseId: line.warehouseId,
        qty: line.qty,
      })),
    ])
    // What the persisted set claims on reservedQty: outstanding + picked/packed, i.e. everything
    // except the part dispatch has already given back. This — not `nextAllocations` — is the
    // reserve delta, precisely because the release below gives back the residual of the OLD rows
    // on the same definition. Release residual, reserve residual: the two are the same reading of
    // the same contract, so an unchanged commitment nets to exactly zero movement.
    const reservationRows = residualAllocationRows(persistedAllocations, dispatchedAllocationLines)

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
    // o3d-4kfh: surface an existing reservedQty shortfall, but do NOT force a rewrite for it.
    //
    // I first assumed the unconditional cycle repaired such a row as a side effect, and that
    // skipping it was therefore a regression. It does not: the cycle RELEASES this order's own
    // quantity and then RESERVES the same quantity back, which is a no-op on the discrepancy —
    // release 2 from a reservedQty of 0 and re-reserve 2 ends exactly where it started. Forcing
    // the rewrite would reintroduce the perpetual churn o3d-i5it removed and fix nothing.
    //
    // Compared against the order's LIVE reservation (residuals), so a dispatched order — where
    // retained rows legitimately exceed reservedQty — no longer reports a phantom shortfall.
    const underReserved = findUnderReservedScopes(stockLevels, ownReservationRows)
    if (underReserved.length > 0) {
      console.error(
        `[allocation-service] order ${orderId}: reservedQty is BELOW this order's own allocations for `
        + `${underReserved.map((scope) => `${scope.productId}@${scope.warehouseId}`).join(', ')} — `
        + 'stock this order believes it holds is available to another. Neither allocating nor '
        + 'short-circuiting repairs this; it needs reservation reconciliation (o3d-4kfh).',
      )
    }

    // Compared in PERSISTED space (retained commitments included), because that is what the rows
    // hold.
    //
    // o3d-4kfh — what this does NOT do: repair a row written under the pre-contract shape (shrunk
    // to the undispatched remainder after a dispatch). Such a row reads as residual 0 while the
    // order still holds a live reservation for it, and nothing here can tell that apart from
    // another order holding the same units — reservedQty is an aggregate with no per-holder
    // ledger. Either outcome is wrong: if the recomputed set matches, the short-circuit fires and
    // the row is left as it is; if it differs, the rewrite releases the under-stated residual and
    // reserves the full one, adding reservation rather than moving it. Neither is repaired here,
    // and no cheap guard can be: the repair is a recompute of reservedQty from every live
    // reservation source for the scope, which `invariants.ts`
    // (`stock_reserved_source_mismatch`) is the census for. IMS has no production data, and the
    // service is a single systemd unit restarted in place (deploy/systemd/ims-stage.service —
    // Type=simple, one instance), so no rolling deployment can run the two shapes against one
    // database and produce such a row after this ships.
    const unchanged = allocationSetsMatch(existingAllocs, persistedAllocations)

    if (!unchanged) {
      // Reached only for a real modification, so the accounting reset — and its posted-shipment
      // guard — applies to an actual allocation change rather than to a no-op re-run.
      await resetAllocationAccountingIfStaged(tx, orderId)

      // o3d-4kfh: release the RESIDUAL of the persisted rows, not their retained quantity.
      //
      // Worked example (the bug this replaces). Product P @ W holds 13 units, reservedQty 13:
      // order A allocated 10, order B allocated 3. Dispatch 5 of A -> reservedQty 8, and A's row
      // still says 10 because dispatch retains it. Re-allocating A recomputes demand net of the
      // dispatch, so the set changes and this branch runs. Releasing the raw 10 against a
      // reservedQty of 8 matched nothing, the old floor branch zeroed the WHOLE scope, and B's 3
      // reserved units vanished without B ever being touched. Releasing the residual (10 - 5 = 5)
      // takes reservedQty 8 -> 3, the re-reserve below puts A's 5 back, and B keeps its 3.
      await applyAllocationReservationDelta(
        tx,
        residualAllocationRows(existingAllocs, dispatchedAllocationLines),
        'release',
      )
      await tx.orderAllocation.deleteMany({ where: { orderId } })

      for (const alloc of persistedAllocations) {
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
      // Reserve the RESIDUAL of what was just written — the retained dispatch in those rows was
      // already given back by the dispatch itself and must not be reserved a second time, while
      // the retained PICK/PACK was never given back and must not be dropped.
      await applyAllocationReservationDelta(
        tx,
        reservationRows.map((alloc) => ({
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
      //
      // zeroDemand short-circuits to 0 (o3d-754w). CANCELLED and refundStatus=FULL are
      // UNCONDITIONALLY zero demand — that is why `lines` above is emptied for them — but the
      // per-line netting here only subtracts QUANTITY-linked refund lines. A cancelled order, or
      // a FULL refund that is monetary-only, therefore kept its original demand in the report
      // after a perfectly successful DEALLOCATION: every line read as unallocated, and for
      // non-oversell products canLeaveUnallocated then made the whole call return
      // success:false / 'No stock available for allocation'. Misleading failure activity on a
      // correct deallocation, and callers branching on success took the wrong path.
      lines: so.lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        qty: zeroDemand
          ? 0
          : Prisma.Decimal.max(
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
        ...persistedAllocations.map((alloc) => alloc.productId),
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
