import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * THE definition of a LIVE reservation held by a sales order (o3d-4kfh).
 *
 * `StockLevel.reservedQty` is a per-(product, warehouse) AGGREGATE shared by every sales order
 * and every production order. Dispatch decrements it but DELIBERATELY RETAINS the
 * `OrderAllocation` rows — the accounting sub-ledger needs them (see
 * `shipment-service.ts`, and the contract note in `refund-service.ts`). So an allocation row's
 * quantity is NOT what that order still holds reserved: the RESIDUAL is.
 *
 * `OrderAllocation.qty` is the order's WHOLE claim on that (line, warehouse, product) — its
 * outstanding demand PLUS every committed (non-PENDING) shipment line, retained through pick, pack
 * and dispatch; `allocateSalesOrder` states the contract in full and is what keeps it true. Two
 * readings come off it, and this module owns the first:
 *
 *     live reservation = qty − SHIPPED        (here)
 *     open / to ship   = qty − non-PENDING    (confirmSalesOrderShipments, the backorder reports)
 *
 *     residual(row) = MAX(row.qty − already-dispatched qty for that row, 0)
 *
 * Every path that gives reservation back MUST release the residual. Releasing the raw retained
 * quantity releases more than the order holds, which — before this module existed — could not be
 * matched by the guarded decrement and fell through to a floor-the-whole-scope-to-zero branch,
 * annihilating every OTHER order's reservation in that (product, warehouse). The same netting is
 * what stops the under-reservation detector firing on a perfectly healthy dispatched order.
 *
 * This module is the single home of that definition so the invariant checker
 * (`invariants.ts` → `stock_reserved_source_mismatch`) and the release paths can never disagree
 * about what a live reservation is.
 */

/**
 * The ONLY shipment status at which `reservedQty` is decremented.
 *
 * `transitionShipmentStatus` performs the `quantity`/`reservedQty` decrement exclusively on the
 * transition to SHIPPED. A PENDING, PICKING or PACKED shipment has moved no stock and released no
 * reservation, so netting its lines out of a residual would under-release and strand reservation
 * on the stock level forever. Interpolated into the invariant-checker SQL as well, so the two
 * sides cannot drift apart.
 */
export const RESERVATION_RELEASING_SHIPMENT_STATUS = 'SHIPPED'

/**
 * The only shipment status that has committed NOTHING.
 *
 * A PENDING shipment is a draft the warehouse has not acted on — `confirmSalesOrderShipments`
 * rewrites it freely and `cancelSalesOrderFulfillmentState` deletes it. Everything else
 * (PICKING, PACKED, SHIPPED) is a COMMITMENT: stock is being physically handled against it, the
 * allocation row is required to cover it (see the contract in `allocateSalesOrder`), and the
 * accounting sub-ledger resolves through the allocation row it was picked from.
 *
 * `qty − non-PENDING` is therefore the OPEN (still-to-ship) reading, and the floor below which an
 * allocation row must never be edited or moved.
 */
export const UNCOMMITTED_SHIPMENT_STATUS = 'PENDING'

/** Identity of an allocation row — the grain both `OrderAllocation` and `ShipmentLine` share. */
export type AllocationScope = {
  lineId: string
  productId: string
  warehouseId: string
}

export type AllocationQtyRow = AllocationScope & { qty: DecimalInput }

/**
 * `OrderAllocation` is unique on (lineId, warehouseId, productId), and dispatched quantity is
 * attributed at exactly that grain — a shipment line carries lineId + productId and its shipment
 * carries the warehouseId.
 */
export function allocationScopeKey(scope: AllocationScope): string {
  return `${scope.lineId}|${scope.warehouseId}|${scope.productId}`
}

/** Dispatched quantity per allocation-row key. Input must already be limited to SHIPPED shipments. */
export function sumDispatchedQtyByAllocationScope(
  dispatchedLines: AllocationQtyRow[],
): Map<string, Prisma.Decimal> {
  const totals = new Map<string, Prisma.Decimal>()
  for (const line of dispatchedLines) {
    const key = allocationScopeKey(line)
    totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(line.qty)))
  }
  return totals
}

/**
 * Residual for ONE allocation row: what of it is still reserved on the stock level.
 *
 * Floored at zero PER ROW (not per scope), exactly as the invariant checker's
 * `GREATEST(oa.qty - COALESCE(asl.qty, 0), 0)` does — a row that shipped more than it allocated
 * must contribute 0, never a negative that would silently offset a sibling row.
 */
export function residualAllocationQty(
  allocation: AllocationQtyRow,
  dispatchedByScope: Map<string, Prisma.Decimal>,
): Prisma.Decimal {
  const dispatched = dispatchedByScope.get(allocationScopeKey(allocation)) ?? new Prisma.Decimal(0)
  return Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(allocation.qty).sub(dispatched))
}

/**
 * The allocation rows re-expressed as live reservation: same identity, `qty` replaced by the
 * residual. Rows are KEPT even when the residual is zero so callers still see the full set (the
 * reservation-delta applier skips non-positive quantities itself).
 */
export function residualAllocationRows<T extends AllocationQtyRow>(
  allocations: T[],
  dispatchedLines: AllocationQtyRow[],
): Array<T & { qty: Prisma.Decimal }> {
  const dispatchedByScope = sumDispatchedQtyByAllocationScope(dispatchedLines)
  return allocations.map((allocation) => ({
    ...allocation,
    qty: residualAllocationQty(allocation, dispatchedByScope),
  }))
}

/** Only the model this loader touches, so any transaction client (or the root client) satisfies it. */
type DispatchedLineLoaderClient = Pick<Prisma.TransactionClient, 'shipmentLine'>

/**
 * Load this order's DISPATCHED shipment lines at allocation-row grain.
 *
 * Deliberately scoped to one order: a release path releases one order's reservation, so it must
 * net against that order's dispatches only. Callers that already hold the order's shipment lines
 * in memory should filter those to {@link RESERVATION_RELEASING_SHIPMENT_STATUS} and use
 * {@link residualAllocationRows} directly rather than re-querying.
 */
export async function loadDispatchedAllocationLines(
  client: DispatchedLineLoaderClient,
  orderId: string,
): Promise<AllocationQtyRow[]> {
  const lines = await client.shipmentLine.findMany({
    where: { shipment: { orderId, status: RESERVATION_RELEASING_SHIPMENT_STATUS } },
    select: {
      lineId: true,
      productId: true,
      qty: true,
      shipment: { select: { warehouseId: true } },
    },
  })
  return lines.map((line) => ({
    lineId: line.lineId,
    productId: line.productId,
    warehouseId: line.shipment.warehouseId,
    qty: line.qty,
  }))
}

/** A committed shipment line at allocation-row grain, carrying the status that classifies it. */
export type CommittedAllocationLine = AllocationQtyRow & { status: string }

/**
 * The DISPATCHED subset of a committed set — the strict subset that has actually given reservation
 * back. Kept here so no caller re-derives "which statuses released stock" for itself.
 */
export function dispatchedAllocationLines<T extends { status: string }>(lines: T[]): T[] {
  return lines.filter((line) => line.status === RESERVATION_RELEASING_SHIPMENT_STATUS)
}

/**
 * Load this order's COMMITTED (non-PENDING) shipment lines at allocation-row grain, each tagged
 * with its shipment status.
 *
 * One query serves both readings: pass the result straight through for the open/committed view, or
 * through {@link dispatchedAllocationLines} for the live-reservation view. Callers that need both —
 * `updateAllocation` guards on committed quantity but moves reservation by dispatched quantity —
 * MUST derive them from the same snapshot, or the guard and the delta can disagree about the same
 * shipment.
 */
export async function loadCommittedAllocationLines(
  client: DispatchedLineLoaderClient,
  orderId: string,
): Promise<CommittedAllocationLine[]> {
  const lines = await client.shipmentLine.findMany({
    where: { shipment: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } } },
    select: {
      lineId: true,
      productId: true,
      qty: true,
      shipment: { select: { warehouseId: true, status: true } },
    },
  })
  return lines.map((line) => ({
    lineId: line.lineId,
    productId: line.productId,
    warehouseId: line.shipment.warehouseId,
    status: line.shipment.status as string,
    qty: line.qty,
  }))
}

/** Convenience: an order's allocation rows expressed as live reservation, loaded in one query. */
export async function residualAllocationRowsForOrder<T extends AllocationQtyRow>(
  client: DispatchedLineLoaderClient,
  orderId: string,
  allocations: T[],
): Promise<Array<T & { qty: Prisma.Decimal }>> {
  if (allocations.length === 0) return []
  const dispatchedLines = await loadDispatchedAllocationLines(client, orderId)
  return residualAllocationRows(allocations, dispatchedLines)
}
