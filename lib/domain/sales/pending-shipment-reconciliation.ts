import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  UNCOMMITTED_SHIPMENT_STATUS,
  allocationScopeKey,
  type AllocationQtyRow,
} from '@/lib/domain/inventory/reservation-residual'

/**
 * THE ONE PLACE A PENDING SHIPMENT DRAFT IS RECONCILED AGAINST THE ALLOCATION ROWS BEHIND IT
 * (o3d-4kfh r4).
 *
 * A PENDING shipment is a draft `confirmSalesOrderShipments` generated straight from
 * `OrderAllocation` — same (line, warehouse, product), same quantities. It commits nothing, so
 * every guard on every mutation path is entitled to ignore it: the deallocation refusal lets it
 * through, the committed floor in `updateAllocation` does not count it, `allocateSalesOrder` does
 * not retain it, and the overallocation rebalancer never looked at it at all. What it DOES do is
 * become a commitment the moment somebody presses Start Picking — and a draft whose backing rows
 * were shrunk, moved or deleted in the meantime becomes a commitment with nothing behind it.
 *
 * Four mutation paths can invalidate a draft, and before this module each had grown its OWN
 * cleanup — which is precisely how two round-4 defects happened:
 *
 *   - the ALLOCATOR rewrite (`allocateSalesOrder`) had a selective, coverage-charging sweep;
 *   - the DEALLOCATION teardown (`releaseOrderAllocationsInTx`) had a blanket
 *     `deleteMany({ orderId, status: 'PENDING' })`, correct only because it deletes every
 *     allocation row in the same breath;
 *   - the REBALANCER (`releaseOverallocations`) copied that blanket delete into a path that
 *     releases ONE allocation, so an unrelated, fully-backed draft in another warehouse was
 *     destroyed with it — and the warning recorded a bare count, so an externally purchased
 *     label could not even be correlated afterwards;
 *   - `updateAllocation` (the manual editor) had no cleanup at all, so shrinking 10 -> 5 left a
 *     10-unit draft that then failed the commitment guard at Start Picking or dead-lettered an
 *     external WMS dispatch.
 *
 * There is ONE rule here, and every caller gets it: a draft is retained only if EVERY one of its
 * lines still has OPEN allocation — `qty − committed` — at its own (line, warehouse, product), and
 * drafts are charged against that open quantity oldest-first so two drafts cannot both claim the
 * same units. A partially covered draft is retired WHOLE, because trimming it would silently ship
 * less than the operator confirmed. The teardown paths need no separate "delete everything" mode:
 * they delete the allocation rows first, so the open quantity is zero and the same rule retires
 * every draft.
 *
 * TRACKING / LABEL METADATA IS RETIRED, NOT SILENTLY DROPPED. IMS cannot re-attach a label to a
 * shipment that no longer exists, and a draft may legitimately already carry a tracking number and
 * shipping service an operator typed in (or a connector wrote back) before the allocation moved.
 * So this returns the full identity of everything it deleted — id, warehouse, tracking number,
 * shipping service, line count, total quantity — and every caller logs that detail. A bare count
 * is what made an externally purchased label impossible to correlate or cancel from IMS.
 * `confirmSalesOrderShipments` still PRESERVES tracking/service across its own delete-and-rebuild
 * (it re-applies them per warehouse), so the metadata survives the ordinary rebuild; it is only
 * genuinely retired when the draft is not rebuilt in the same transaction.
 */

/** Matches `ALLOCATION_EPSILON_DECIMAL` in allocation-service — the same quantity grain. */
const RECONCILIATION_EPSILON = new Prisma.Decimal('0.000001')

export type RetiredPendingShipment = {
  id: string
  warehouseId: string
  trackingNumber: string | null
  shippingService: string | null
  lineCount: number
  totalQty: number
}

export type PendingShipmentReconciliation = {
  /** Full identity of every draft deleted, so the caller can log something correlatable. */
  retired: RetiredPendingShipment[]
  /** Drafts the allocation set still backs, left completely untouched. */
  retainedCount: number
}

export const EMPTY_PENDING_SHIPMENT_RECONCILIATION: PendingShipmentReconciliation = {
  retired: [],
  retainedCount: 0,
}

/**
 * `Prisma.TransactionClient` rather than a hand-written structural type: every caller already holds
 * a real transaction (this MUST run under the sales order's row lock), and the generated client is
 * what type-checks the `select` shapes below against the schema. Tests pass their double as
 * `never`, the same convention the rest of this domain uses.
 */
export type PendingShipmentReconciliationClient = Prisma.TransactionClient

export type ReconcilePendingShipmentsOptions = {
  /**
   * The allocation rows the drafts must be backed by. Optional ONLY as an in-memory shortcut for a
   * caller that has just written them itself (`allocateSalesOrder` creates its rows a few lines
   * earlier); omitting it reads the order's rows through the SAME transaction client, which is the
   * correct default for every caller that has mutated one row rather than the whole set.
   *
   * NOT a semantic switch: the rule applied is identical either way. Supplying a set that differs
   * from what is persisted is a caller bug.
   */
  allocations?: AllocationQtyRow[]
  /** Same shortcut for the committed (non-PENDING) shipment lines subtracted from the rows. */
  committedShipmentLines?: AllocationQtyRow[]
}

/**
 * Retire the order's PENDING shipment drafts that its allocation rows no longer back.
 *
 * The caller MUST already hold the sales order's row lock (`lockSalesOrder`) and MUST have applied
 * its allocation writes first — this reads the POST-mutation state, which is the only state that
 * can answer "is this draft still backed?".
 */
export async function reconcilePendingShipments(
  client: PendingShipmentReconciliationClient,
  orderId: string,
  options: ReconcilePendingShipmentsOptions = {},
): Promise<PendingShipmentReconciliation> {
  const pendingShipments = await client.shipment.findMany({
    where: { orderId, status: UNCOMMITTED_SHIPMENT_STATUS },
    select: {
      id: true,
      warehouseId: true,
      trackingNumber: true,
      shippingService: true,
      lines: { select: { lineId: true, productId: true, qty: true } },
    },
    // Oldest first, so the charging order below is stable and the draft an operator raised first
    // is the one that keeps the units. `id` breaks ties deterministically.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (pendingShipments.length === 0) return { retired: [], retainedCount: 0 }

  const allocations = options.allocations ?? await client.orderAllocation.findMany({
    where: { orderId },
    select: { lineId: true, productId: true, warehouseId: true, qty: true },
  })
  const committedShipmentLines = options.committedShipmentLines ?? (
    await client.shipmentLine.findMany({
      where: { shipment: { orderId, status: { not: UNCOMMITTED_SHIPMENT_STATUS } } },
      select: {
        lineId: true,
        productId: true,
        qty: true,
        shipment: { select: { warehouseId: true } },
      },
    })
  ).map((line) => ({
    lineId: line.lineId,
    productId: line.productId,
    warehouseId: line.shipment.warehouseId,
    qty: line.qty,
  }))

  // OPEN quantity per allocation scope: what the rows claim, minus what is already committed to a
  // non-PENDING shipment. A draft may only be backed by what is still open — the committed part is
  // already spoken for by the shipment that committed it.
  const openByScope = new Map<string, Prisma.Decimal>()
  for (const allocation of allocations) {
    const key = allocationScopeKey(allocation)
    openByScope.set(key, (openByScope.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(allocation.qty)))
  }
  for (const committed of committedShipmentLines) {
    const key = allocationScopeKey(committed)
    openByScope.set(key, (openByScope.get(key) ?? new Prisma.Decimal(0)).sub(toDecimal(committed.qty)))
  }

  const doomed: RetiredPendingShipment[] = []
  let retainedCount = 0
  for (const shipment of pendingShipments) {
    const claim = new Map<string, Prisma.Decimal>()
    let backed = true
    let totalQty = new Prisma.Decimal(0)
    for (const line of shipment.lines) {
      const key = allocationScopeKey({
        lineId: line.lineId,
        productId: line.productId,
        warehouseId: shipment.warehouseId,
      })
      const wanted = (claim.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(line.qty))
      claim.set(key, wanted)
      totalQty = totalQty.add(toDecimal(line.qty))
      const open = openByScope.get(key) ?? new Prisma.Decimal(0)
      if (wanted.sub(open).gt(RECONCILIATION_EPSILON)) {
        backed = false
        // NOT `break`: totalQty is reported to the operator, so the whole draft is measured even
        // once it is known to be doomed.
      }
    }
    if (!backed) {
      doomed.push({
        id: shipment.id,
        warehouseId: shipment.warehouseId,
        trackingNumber: shipment.trackingNumber ?? null,
        shippingService: shipment.shippingService ?? null,
        lineCount: shipment.lines.length,
        totalQty: totalQty.toNumber(),
      })
      continue
    }
    // Only a RETAINED draft consumes open quantity. Charging a doomed one would let it starve a
    // later draft that is genuinely backed.
    for (const [key, qty] of claim) {
      openByScope.set(key, (openByScope.get(key) ?? new Prisma.Decimal(0)).sub(qty))
    }
    retainedCount += 1
  }

  if (doomed.length === 0) return { retired: [], retainedCount }

  await client.shipment.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } })
  return { retired: doomed, retainedCount }
}

/**
 * One operator-facing sentence describing what was retired, with enough identity in it to find an
 * externally purchased label. Shared so the four call sites cannot describe the same event four
 * different ways.
 */
export function describeRetiredPendingShipments(retired: RetiredPendingShipment[]): string {
  return retired
    .map((row) => {
      const parts = [`${row.id} (warehouse ${row.warehouseId}, ${row.lineCount} line(s), qty ${row.totalQty})`]
      if (row.trackingNumber) parts.push(`tracking ${row.trackingNumber}`)
      if (row.shippingService) parts.push(`service ${row.shippingService}`)
      return parts.join(', ')
    })
    .join('; ')
}

/** The activity-log metadata every caller attaches, so the shape cannot drift between them. */
export function retiredPendingShipmentMetadata(retired: RetiredPendingShipment[]) {
  return {
    retiredShipmentCount: retired.length,
    retiredShipments: retired.map((row) => ({
      shipmentId: row.id,
      warehouseId: row.warehouseId,
      trackingNumber: row.trackingNumber,
      shippingService: row.shippingService,
      lineCount: row.lineCount,
      totalQty: row.totalQty,
    })),
    // Called out separately: a retired draft that carried a tracking number is the case an operator
    // must act on (the label is bought and IMS no longer references it).
    retiredTrackingNumbers: retired
      .map((row) => row.trackingNumber)
      .filter((value): value is string => !!value),
  }
}
