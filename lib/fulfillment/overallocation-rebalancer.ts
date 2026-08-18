import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { canonicalAllocationQty } from '@/lib/domain/sales/allocation-service'
import { reconcilePendingShipments } from '@/lib/domain/sales/pending-shipment-reconciliation'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const RELEASABLE_STATUSES = ['PROCESSING', 'ALLOCATED'] as const

export type RebalanceItem = { productId: string; warehouseId: string }

export type RebalanceSource =
  | 'stock_adjustment'
  | 'transfer_dispatch'

/**
 * After a stock-decrease on one or more (product, warehouse) pairs, ensure
 * `reservedQty <= quantity` by releasing allocations — newest order first
 * (by SalesOrder.createdAt DESC). Customers who have been waiting longest
 * keep their reservations.
 *
 * Only touches orders in PROCESSING or ALLOCATED status. Skips orders
 * with a journaled shipment or with `inventoryAllocatedDate` already
 * staged for the accounting batch — those require a refund workflow to
 * reverse cleanly. Never throws; always logs per release.
 *
 * Returns the orderIds whose allocations changed so callers can trigger
 * a shopping-stock sync for them.
 */
export async function releaseOverallocations(
  items: RebalanceItem[],
  context: { source: RebalanceSource; referenceId?: string; referenceLabel?: string },
): Promise<{ orderIds: string[]; released: number; skipped: number }> {
  const result = { orderIds: [] as string[], released: 0, skipped: 0 }
  const key = (i: RebalanceItem) => `${i.productId}|${i.warehouseId}`
  const uniq = [...new Map(items.map((i) => [key(i), i])).values()]
  if (uniq.length === 0) return result

  const releaseLog: Array<{
    orderId: string
    orderRef: string
    productId: string
    warehouseId: string
    qty: number
  }> = []
  const touchedOrders = new Set<string>()

  type TxOutcome = {
    releases: Array<{ orderId: string; orderRef: string; productId: string; warehouseId: string; qty: number }>
    skipped: number
  }

  for (const item of uniq) {
    try {
      // Phase 1 (unlocked): gather candidate order IDs so we can acquire
      // sales_orders locks BEFORE stock_levels, matching the ordering used
      // in autoAllocateOrder/updateAllocation. Reversing the order would
      // cross-deadlock with allocation edits that touch the same SKU.
      //
      // We do NOT filter by order-level shipment status here. A partially
      // shipped order may have unshipped lines whose allocations on this
      // SKU still need to be released (an adjacent shipped line doesn't
      // protect them). Commitment is checked per-allocation below —
      // allocations whose own line+warehouse already has a non-PENDING
      // ShipmentLine are skipped.
      const preAllocs = await db.orderAllocation.findMany({
        where: {
          productId: item.productId,
          warehouseId: item.warehouseId,
          order: { status: { in: [...RELEASABLE_STATUSES] } },
        },
        select: { orderId: true, order: { select: { createdAt: true } } },
        orderBy: { order: { createdAt: 'desc' } },
      })
      if (preAllocs.length === 0) continue
      const candidateOrderIds = [...new Set(preAllocs.map((a) => a.orderId))]
      // Lock in deterministic (ASC) order to avoid deadlocks between
      // concurrent rebalancer calls touching overlapping orders.
      const lockOrderIds = [...candidateOrderIds].sort()

      const txOutcome: TxOutcome = await db.$transaction(async (tx) => {
        const pending: TxOutcome = { releases: [], skipped: 0 }

        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "sales_orders" WHERE id IN (${Prisma.join(lockOrderIds)}) FOR UPDATE`,
        )
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "stock_levels" WHERE "productId" = ${item.productId} AND "warehouseId" = ${item.warehouseId} FOR UPDATE`,
        )

        const level = await tx.stockLevel.findUnique({
          where: { productId_warehouseId: { productId: item.productId, warehouseId: item.warehouseId } },
          select: { quantity: true, reservedQty: true },
        })
        if (!level) return pending
        let excess = Number(level.reservedQty) - Number(level.quantity)
        if (excess <= 1e-6) return pending

        // Per-allocation commitment check: an OrderAllocation is committed
        // (and must not be released) if a non-PENDING ShipmentLine exists
        // with the same lineId+productId whose shipment ships from this
        // warehouse. updateShipmentStatus(..., 'SHIPPED') will drive stock
        // decrements from that ShipmentLine. Using a per-line check (not
        // per-order) means unshipped lines on a partially-shipped order
        // can still have their overallocations released.
        const committedKey = (lineId: string) => `${lineId}`
        const committedAllocLineKeys = new Set(
          (
            await tx.shipmentLine.findMany({
              where: {
                productId: item.productId,
                shipment: {
                  warehouseId: item.warehouseId,
                  status: { not: 'PENDING' },
                },
              },
              select: { lineId: true },
            })
          ).map((sl) => committedKey(sl.lineId)),
        )

        // Re-query allocations fresh under the lock WITHOUT the
        // orderId-in-candidates filter — another tx may have committed
        // a new allocation on this (productId, warehouseId) between our
        // pre-query and acquiring stock_level FOR UPDATE. Skipping those
        // new allocations (we don't hold sales_orders locks for them, so
        // can't safely touch) leaves their excess for the next rebalancer
        // call; unrelated release progress we CAN make is still applied.
        const allocs = await tx.orderAllocation.findMany({
          where: {
            productId: item.productId,
            warehouseId: item.warehouseId,
            order: { status: { in: [...RELEASABLE_STATUSES] } },
          },
          select: {
            id: true, orderId: true, lineId: true, qty: true,
            order: {
              select: {
                id: true, orderNumber: true, externalOrderNumber: true, status: true,
                inventoryAllocatedDate: true,
              },
            },
          },
          orderBy: { order: { createdAt: 'desc' } },
        })

        const lockedOrderIdSet = new Set(candidateOrderIds)
        // o3d-4kfh r4: the orders this pass actually WROTE to, reconciled once each after the
        // release loop. See the note at the reconciliation call below for why the cleanup cannot
        // happen inside the loop.
        const releasedOrderRefs = new Map<string, string>()
        for (const alloc of allocs) {
          if (excess <= 1e-6) break
          if (!lockedOrderIdSet.has(alloc.orderId)) { pending.skipped += 1; continue }
          if (committedAllocLineKeys.has(committedKey(alloc.lineId))) { pending.skipped += 1; continue }

          if (alloc.order.inventoryAllocatedDate) {
            const journaled = await tx.shipment.findFirst({
              where: { orderId: alloc.orderId, shipmentJournalDate: { not: null } },
              select: { id: true },
            })
            if (journaled) { pending.skipped += 1; continue }
            await tx.salesOrder.update({
              where: { id: alloc.orderId },
              // o3d-0qoo: the A2 batch ref is cleared with its stamp in the same update — see the
              // note at the REFUNDED un-stage in refund-service.ts for why the pair must move together.
              data: { inventoryAllocatedDate: null, inventoryAllocatedBatchRef: null, allocationBatchAmount: null },
            })
            await tx.orderAllocation.updateMany({
              where: { orderId: alloc.orderId },
              data: { costLayerSnapshot: Prisma.DbNull },
            })
          }

          const allocQty = Number(alloc.qty)
          const wantedRelease = Math.min(allocQty, excess)
          if (wantedRelease <= 0) continue

          // o3d-4kfh r7 (Codex finding 4): THE ROW IS QUANTISED, AND THE RESERVATION FOLLOWS THE
          // ROW. `excess` is `reservedQty − quantity`, and `reservedQty` carries more decimal
          // places than `OrderAllocation.qty` can hold, so `allocQty − wantedRelease` was routinely
          // a quantity Postgres rounded on write while `reservedQty` was decremented by the
          // unrounded figure. The difference is small and permanent, and it lands on an aggregate
          // shared with every other order in the scope. Deriving the decrement from what the row
          // ACTUALLY gave up — the same "one canonical representation" rule the allocator and the
          // manual writers now follow — keeps the two books equal by construction.
          const wholeRow = wantedRelease >= allocQty - 1e-6
          const nextQty = wholeRow ? null : canonicalAllocationQty(allocQty - wantedRelease)
          const release = wholeRow ? allocQty : allocQty - nextQty!.toNumber()
          // A release the column cannot represent is not a release: the row would be rewritten to
          // its own value and `reservedQty` decremented for a reduction that never happened.
          if (release <= 0) continue

          if (wholeRow) {
            await tx.orderAllocation.delete({ where: { id: alloc.id } })
          } else {
            await tx.orderAllocation.update({
              where: { id: alloc.id },
              data: { qty: nextQty! },
            })
          }
          await tx.stockLevel.updateMany({
            where: { productId: item.productId, warehouseId: item.warehouseId },
            data: { reservedQty: { decrement: release } },
          })

          const remainingForOrder = await tx.orderAllocation.count({ where: { orderId: alloc.orderId } })
          if (remainingForOrder === 0 && alloc.order.status === 'ALLOCATED') {
            await tx.salesOrder.update({ where: { id: alloc.orderId }, data: { status: 'PROCESSING' } })
          }

          excess -= release
          const orderRef = alloc.order.orderNumber ?? alloc.order.externalOrderNumber ?? alloc.orderId.slice(0, 8)
          releasedOrderRefs.set(alloc.orderId, orderRef)
          pending.releases.push({
            orderId: alloc.orderId,
            orderRef,
            productId: item.productId,
            warehouseId: item.warehouseId,
            qty: release,
          })
        }

        // o3d-4kfh r4: RETIRE ONLY THE DRAFTS THIS RELEASE ACTUALLY UNBACKED.
        //
        // This used to be `deleteMany({ orderId, status: 'PENDING' })` inside the loop above — a
        // blanket delete copied from the deallocation TEARDOWN, where it is correct only because
        // that path deletes every allocation row on the order in the same breath. Here exactly one
        // (product, warehouse) allocation is being trimmed, so the blanket delete destroyed drafts
        // that were still fully backed: with drafts A@W1 and B@W2 on one order, an A@W1 stock
        // decrease erased B@W2 too, cascaded its shipment lines, and threw away whatever tracking
        // number and shipping service it carried — recorded as a bare count, so the label could not
        // even be correlated afterwards.
        //
        // Runs AFTER the loop, once per order: the loop can trim several allocations on the same
        // order, and a mid-loop reconciliation would judge a draft against a half-applied release.
        // Uses the SAME shared rule as the allocator, the teardown and the manual editor.
        //
        // o3d-4kfh r5 (Codex finding 7): the retirement AUDIT ROW is written by the reconciler
        // inside THIS transaction, before the drafts are deleted. It used to be written here, after
        // the commit, via a `logActivity` that swallows its own failures — so a crash in that window
        // destroyed the only record of which purchased label IMS had stopped referencing.
        for (const [releasedOrderId, orderRef] of releasedOrderRefs) {
          await reconcilePendingShipments(tx, releasedOrderId, {
            cause: `an overallocation release due to ${context.referenceLabel ?? context.source}`,
            auditMetadata: {
              source: context.source,
              referenceId: context.referenceId ?? null,
              orderRef,
            },
          })
        }
        return pending
      }, STOCK_TX_OPTIONS)

      // Only merge into outer state AFTER the tx commits. If it rolled
      // back, any in-memory bookkeeping above is discarded.
      if (txOutcome) {
        result.skipped += txOutcome.skipped
        for (const entry of txOutcome.releases) {
          result.released += entry.qty
          touchedOrders.add(entry.orderId)
          releaseLog.push(entry)
        }
      }
    } catch (e) {
      await logActivity({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: context.referenceId ?? context.source,
        action: 'overallocation_release_failed',
        tag: 'sales',
        level: 'ERROR',
        description: `Failed to release overallocation for product ${item.productId} in warehouse ${item.warehouseId}: ${e instanceof Error ? e.message : String(e)}`,
        metadata: { source: context.source, referenceId: context.referenceId ?? null, productId: item.productId, warehouseId: item.warehouseId },
      })
    }
  }

  for (const entry of releaseLog) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: entry.orderId,
      action: 'allocation_released',
      tag: 'sales',
      level: 'WARNING',
      description: `Released ${entry.qty} allocated unit(s) from order ${entry.orderRef} due to ${context.referenceLabel ?? context.source}`,
      metadata: {
        source: context.source,
        referenceId: context.referenceId ?? null,
        productId: entry.productId,
        warehouseId: entry.warehouseId,
        qty: entry.qty,
      },
    })
  }

  // Reconcile: after a stock decrease causes releases, run a FIFO
  // backorder pass across ALL eligible orders for the affected products
  // — not just the (newest-first) orders we released. Without this,
  // alternate stock in another warehouse could be reclaimed by the
  // newly-backordered released order before an older-but-untouched
  // backorder gets its turn. allocateBackordersForProducts sorts by
  // createdAt ASC and also handles stranded sibling kit components via
  // autoAllocateOrder's rebuild.
  const releasedProductIds = [...new Set(releaseLog.map((r) => r.productId))]
  if (releasedProductIds.length > 0) {
    try {
      const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
      await allocateBackordersForProducts(releasedProductIds, {
        source: context.source === 'transfer_dispatch' ? 'transfer_receive' : 'stock_adjustment',
        referenceId: context.referenceId,
        referenceLabel: `${context.referenceLabel ?? context.source} (post-release FIFO)`,
      })
    } catch (reconcileError) {
      console.error(reconcileError)
    }
  }

  if (touchedOrders.size > 0) {
    revalidatePath('/sales')
    for (const orderId of touchedOrders) {
      revalidatePath(`/sales/${orderId}`)
    }
    for (const productId of releasedProductIds) {
      revalidatePath(`/inventory/${productId}`)
    }
  }

  result.orderIds = [...touchedOrders]
  return result
}
