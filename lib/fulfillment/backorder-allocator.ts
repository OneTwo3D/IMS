import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { enqueueStockSync } from '@/lib/shopping'
import { selectOrdersNeedingAllocation } from '@/lib/fulfillment/order-allocation-coverage'

const BACKORDER_ELIGIBLE_STATUSES = ['PROCESSING', 'ALLOCATED'] as const

const MAX_KIT_EXPANSION_DEPTH = 16

export type BackorderSource =
  | 'purchase_receipt'
  | 'transfer_receive'
  | 'transfer_cancel'
  | 'stock_adjustment'
  | 'customer_return'

/**
 * Auto-allocate backordered sales orders when stock becomes available.
 *
 * Finds open sales orders (PROCESSING / ALLOCATED) whose shortfall sits
 * on a line that references one of `productIds` — including any KIT/BOM
 * parent (at any nesting depth) whose descendant components match — and
 * re-runs autoAllocateOrder FIFO so the oldest waiting customer gets
 * stock first. Orders whose shortfall is on an unrelated SKU are left
 * alone so we don't churn their existing allocations.
 *
 * Call this after a stock-increase operation and BEFORE enqueueStockSync
 * so the shopping portal sees the post-reservation availability. Errors
 * are logged per-order; never throws.
 */
export async function allocateBackordersForProducts(
  productIds: string[],
  context: { source: BackorderSource; referenceId?: string; referenceLabel?: string },
): Promise<{ orderIds: string[]; allocated: number; errors: number }> {
  const result = { orderIds: [] as string[], allocated: 0, errors: 0 }
  const directIds = [...new Set(productIds.filter(Boolean))]
  if (directIds.length === 0) return result

  // Walk only through KIT parents to every depth. BOM parents are treated
  // as leaf stock by expandFulfillmentRequirementsDecimal — receiving a BOM's
  // component doesn't improve BOM-line coverage (BOM orders need the
  // assembled BOM, not its components), so chasing through BOMs would
  // retry orders whose fulfillable qty didn't actually increase.
  const expandedSet = new Set(directIds)
  let frontier: string[] = directIds
  for (let depth = 0; depth < MAX_KIT_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const parents = await db.productComponent.findMany({
      where: {
        componentId: { in: frontier },
        product: { type: 'KIT' },
      },
      select: { productId: true },
    })
    const next: string[] = []
    for (const row of parents) {
      if (!expandedSet.has(row.productId)) {
        expandedSet.add(row.productId)
        next.push(row.productId)
      }
    }
    frontier = next
  }
  const expanded = [...expandedSet]
  const directIdsSet = new Set(directIds)

  // Exclude orders that already have any Shipment row. confirmAllocations
  // creates PENDING ShipmentLines tied to specific warehouses/qtys; calling
  // autoAllocateOrder here rebuilds OrderAllocation without touching those
  // ShipmentLines, so the later dispatch would decrement stock against
  // stale shipment rows. Let manual intervention handle those cases.
  const candidates = await db.salesOrder.findMany({
    where: {
      status: { in: [...BACKORDER_ELIGIBLE_STATUSES] },
      lines: { some: { productId: { in: expanded } } },
      shipments: { none: {} },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (candidates.length === 0) return result

  // Keep only orders with outstanding demand on a line whose leaf requirements touch a
  // directly-replenished product — otherwise a KIT parent whose bottleneck component is elsewhere
  // would get its allocation needlessly rewritten without improving fulfillable qty. Coverage is the
  // shared, KIT-aware computation used by the periodic reallocation sweep too (o3d-9lx).
  const needsAllocation = await selectOrdersNeedingAllocation(
    candidates,
    (_line, reqs) => reqs.some((r) => directIdsSet.has(r.productId)),
  )
  if (needsAllocation.length === 0) return result

  const { autoAllocateOrder } = await import('@/app/actions/allocation')

  // autoAllocateOrder normally emits a stock sync per call. When we
  // re-allocate many backordered orders after a single stock increase,
  // the fanout of per-order syncs creates a burst of redundant storefront
  // updates. Defer each inner sync, then coalesce into one sync at the
  // end across the union of affected product IDs.
  // autoAllocateOrder catches its own exceptions and reports them via
  // { success: false, error }. The benign "No stock available" case is
  // expected here — the order simply couldn't be covered by the current
  // replenishment. Any other error (lock timeout, validation, etc.) is
  // a real failure and must be logged so replenishment flows don't
  // silently miss eligible backorders.
  const BENIGN_ALLOC_ERRORS = new Set([
    'No stock available for allocation',
    'Order has existing shipments; reallocation refused',
  ])
  const syncProductIds = new Set<string>()
  for (const order of needsAllocation) {
    const orderRef = order.orderNumber ?? order.externalOrderNumber ?? order.id.slice(0, 8)
    try {
      const res = await autoAllocateOrder(order.id, {
        internalBypassToken: INTERNAL_ACTION_BYPASS,
        deferStockSync: true,
        refuseIfShipmentsExist: true,
      })
      for (const productId of res.syncProductIds ?? []) syncProductIds.add(productId)
      if (res.success && (res.allocationCount ?? 0) > 0) {
        result.allocated += 1
        result.orderIds.push(order.id)
      } else if (res.error && !BENIGN_ALLOC_ERRORS.has(res.error)) {
        result.errors += 1
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'backorder_allocation_failed',
          tag: 'sales',
          level: 'ERROR',
          description: `Backorder allocation failed for ${orderRef}: ${res.error}`,
          metadata: { source: context.source, referenceId: context.referenceId ?? null },
        })
      }
    } catch (e) {
      result.errors += 1
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'backorder_allocation_failed',
        tag: 'sales',
        level: 'ERROR',
        description: `Backorder allocation failed for ${orderRef}: ${e instanceof Error ? e.message : String(e)}`,
        metadata: { source: context.source, referenceId: context.referenceId ?? null },
      })
    }
  }

  if (syncProductIds.size > 0) {
    try {
      await enqueueStockSync([...syncProductIds], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }
  }

  if (result.allocated > 0) {
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: context.referenceId ?? context.source,
      action: 'backorder_allocated',
      tag: 'sales',
      level: 'INFO',
      description: `Auto-allocated ${result.allocated} backordered order(s) after ${context.referenceLabel ?? context.source}`,
      metadata: {
        source: context.source,
        referenceId: context.referenceId ?? null,
        productIds: expanded,
        orderCount: result.allocated,
      },
    })
  }

  return result
}
