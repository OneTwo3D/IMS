import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { PEG_HOLDING_ORDER_STATUSES, sweepPegs, type EndedPeg } from '@/lib/domain/sales/peg-service'

/**
 * SO-to-PO pegging: after stock has landed on a purchase-order line, allocate it to the order pegged to that line FIRST, before
 * the oldest-order-first pass (allocateBackordersForProducts) hands the remainder out.
 *
 * Every receipt path comes through here: the manual receipt via allocateBackordersForProducts (source purchase_receipt), and
 * the WMS book-in and the ASN stock-sync alignment directly. A receipt whose call never happens (a crash after commit) is not
 * lost: the landed units are earmarked for the peg by the next allocation of ANY order, which also holds them back from that
 * order, and the reallocation sweep re-runs allocation.
 *
 * Each order is allocated with `capPeggedLines`: the pegged line may grow only by what has landed for its pegs, so being
 * allocated first never lets it take free stock an older order is owed. Never throws: a failure is counted in `errors` (and logged per order); every caller reads the count.
 *
 * No outbound write: this pass does not enqueue a storefront stock sync. Every caller enqueues one for the received products
 * straight after it (the manual receipt, the WMS book-in and the ASN alignment all do), which covers the reservations made here.
 */
export type PegPassSource = 'purchase_receipt' | 'wms_booked_in' | 'wms_alignment'

export async function allocatePeggedOrdersForProducts(
  productIds: string[],
  context: { source: PegPassSource; referenceId?: string; referenceLabel?: string },
): Promise<{ orderIds: string[]; allocated: number; skipped: number; errors: number }> {
  const result = { orderIds: [] as string[], allocated: 0, skipped: 0, errors: 0 }
  const ids = [...new Set(productIds.filter(Boolean))]
  if (ids.length === 0) return result

  let pegs: Array<{ createdAt: Date; salesOrderLine: { orderId: string; order: { orderNumber: string | null; externalOrderNumber: string | null } } }>
  try {
    pegs = await db.salesOrderLinePeg.findMany({
    where: {
      endedAt: null,
      salesOrderLine: {
        productId: { in: ids },
        order: {
          status: { in: [...PEG_HOLDING_ORDER_STATUSES] },
          // The same refusal the backorder pass makes: rebuilding rows under a picked, packed or shipped commitment is the hazard.
          shipments: { none: { status: { not: 'PENDING' } } },
        },
      },
    },
    select: { createdAt: true, salesOrderLine: { select: { orderId: true, order: { select: { orderNumber: true, externalOrderNumber: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  } catch (error) {
    // Never throws (the callers are receipt paths): the failure is counted, and the reallocation sweep re-runs allocation.
    console.error(error)
    result.errors += 1
    return result
  }
  const orders = new Map<string, string>()
  for (const peg of pegs) {
    const order = peg.salesOrderLine.order
    if (!orders.has(peg.salesOrderLine.orderId)) orders.set(peg.salesOrderLine.orderId, order.orderNumber ?? order.externalOrderNumber ?? peg.salesOrderLine.orderId.slice(0, 8))
  }
  if (orders.size === 0) return result

  const { autoAllocateOrder } = await import('@/app/actions/allocation')
  for (const [orderId, orderRef] of orders) {
    try {
      const res = await autoAllocateOrder(orderId, {
        internalBypassToken: INTERNAL_ACTION_BYPASS,
        deferStockSync: true,
        refuseIfCommittedShipmentsExist: true,
        requireStatusUnderLock: PEG_HOLDING_ORDER_STATUSES,
        capPeggedLines: true,
      })
      if (res.skipped) result.skipped += 1
      else if (res.success && (res.allocationCount ?? 0) > 0) {
        result.allocated += 1
        result.orderIds.push(orderId)
      } else if (res.error && res.error !== 'No stock available for allocation' && res.error !== 'Order has existing shipments; reallocation refused') {
        result.errors += 1
        await logActivity({
          entityType: 'SALES_ORDER', entityId: orderId, action: 'peg_allocation_failed', tag: 'sales', level: 'ERROR',
          description: `Pegged allocation failed for ${orderRef}: ${res.error}`,
          metadata: { source: context.source, referenceId: context.referenceId ?? null },
        })
      }
    } catch (error) {
      result.errors += 1
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'peg_allocation_failed', tag: 'sales', level: 'ERROR',
        description: `Pegged allocation failed for ${orderRef}: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { source: context.source, referenceId: context.referenceId ?? null },
      })
    }
  }
  if (result.allocated > 0) {
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT', entityId: context.referenceId ?? context.source, action: 'peg_allocated', tag: 'sales', level: 'INFO',
      description: `Allocated ${result.allocated} pegged order(s) first after ${context.referenceLabel ?? context.source}`,
      metadata: { source: context.source, referenceId: context.referenceId ?? null, orderCount: result.allocated },
    })
  }
  return result
}

/**
 * The reallocation sweep's peg pass: end pegs whose order or purchase order has gone (whatever allocation did or did not run),
 * then hand what they were holding on to the oldest waiting order. Never throws.
 */
export async function sweepPegsAndRelease(): Promise<{ checked: number; ended: number; errors: number }> {
  const result = await sweepPegs(db)
  const released: EndedPeg[] = result.ended
  const productIds = [...new Set(released.map((peg) => peg.productId))]
  let errors = 0
  if (productIds.length > 0) {
    try {
      const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
      // The hand-on is the cron's work: its per-order failures are folded into the tick's `errors` so the run is reported failed.
      errors += (await allocateBackordersForProducts(productIds, { source: 'stock_adjustment', referenceLabel: 'ended peg(s)' })).errors
    } catch (error) {
      console.error(error)
      errors += 1
    }
  }
  return { checked: result.checked, ended: released.length, errors }
}
