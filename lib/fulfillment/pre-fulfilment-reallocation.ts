import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { selectOrdersNeedingAllocation } from '@/lib/fulfillment/order-allocation-coverage'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'

/**
 * o3d-c9mi — one last allocation attempt as an order leaves the automatically-recoverable set.
 *
 * THE GAP. The o3d-9lx reallocation sweep recovers orders left with outstanding demand, but
 * its eligible set is PROCESSING + ALLOCATED. The state machine permits ALLOCATED -> PICKING
 * and ON_HOLD -> PICKING / PACKING, and nothing moves an order back out of PICKING or PACKING
 * automatically. So a partially-allocated order that crosses into fulfilment is never
 * revisited — while its one-shot replenishment trigger has ALREADY been consumed. The
 * shortfall is simply never allocated.
 *
 * WHY NOT REFUSE THE TRANSITION. The issue's preferred fix was to refuse on incomplete
 * coverage. The existing guard deliberately requires only that AT LEAST ONE allocation exists
 * (`allocCount === 0` is the error case), which is direct evidence that moving a partially
 * allocated order into picking is an intentional workflow — you pick and ship what you have
 * while the rest stays on backorder. Refusing would break it. The issue lists reconciliation
 * as the alternative, and its own test contract accepts either.
 *
 * WHY NOT WIDEN THE SWEEP. Explicitly rejected in the issue: fulfilment may already own those
 * allocations, and re-running allocation under PICKING/PACKING risks releasing and
 * re-reserving stock a picker is working against.
 *
 * So this runs at the one moment that is both useful and safe: the order is about to enter
 * fulfilment but has not yet, so nobody owns its allocations, and it is the last point at
 * which an automatic attempt will ever happen.
 *
 * DELIBERATELY BEST-EFFORT, and NOT under the status lock. `autoAllocateOrder` opens its own
 * transaction, so calling it inside the transition's lock would nest. Stock can therefore
 * move between this call and the transition — which is fine, because this is a backstop that
 * restores a lost retry, not a guarantee of coverage. A genuine shortfall still proceeds, as
 * it does today; what changes is that it is now attempted and, if still short, RECORDED
 * instead of vanishing silently.
 */

/** Statuses whose entry takes an order out of the sweep's reach for good. */
const FULFILMENT_STATUSES = new Set(['PICKING', 'PACKING'])

/**
 * Statuses an order may legally be in while still OUTSIDE fulfilment, per the state machine:
 * PICKING is reachable from ALLOCATED and ON_HOLD, PACKING from ON_HOLD.
 *
 * Doubles as `requireStatusUnderLock` for the allocator (o3d-6ab), which re-checks it while
 * holding the order lock. That is what makes the decision safe despite being taken outside
 * one — a status that moved in between turns the allocation into an explicit no-op.
 */
const PRE_FULFILMENT_STATUSES = ['ALLOCATED', 'ON_HOLD'] as const satisfies readonly SalesOrderStatus[]

/**
 * True only when this transition CROSSES INTO fulfilment from outside it.
 *
 * The target alone is not enough. PICKING -> PACKING is legal and targets a fulfilment
 * status, but the order is already being picked, and reallocating there is precisely what the
 * issue warns against: the allocator releases, deletes and recreates allocations that
 * fulfilment already owns (Codex review).
 */
export function entersFulfilment(currentStatus: string, targetStatus: string): boolean {
  return FULFILMENT_STATUSES.has(targetStatus) && !FULFILMENT_STATUSES.has(currentStatus)
}

export type PreFulfilmentReallocationResult =
  | { attempted: false; reason: 'not-fulfilment-entry' | 'fully-covered' | 'has-shipments' | 'order-missing' }
  | { attempted: true; stillShort: boolean }

export async function reconcileAllocationBeforeFulfilment(
  orderId: string,
): Promise<PreFulfilmentReallocationResult> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      // The coverage selector treats FULL as unconditional zero demand, matching
      // allocateSalesOrder. Omitting it would make a fully-refunded order look short forever.
      refundStatus: true,
      lines: { select: { id: true, qty: true, productId: true } },
      _count: { select: { shipments: true } },
    },
  })
  if (!order) return { attempted: false, reason: 'order-missing' }

  // autoAllocateOrder rebuilds OrderAllocation without touching committed ShipmentLines, so
  // reallocating an order that already has shipments would decrement stock against stale
  // rows. The sweep pre-excludes these for the same reason.
  // Coverage FIRST, so a short order is reported even when it cannot be reallocated.
  const needing = await selectOrdersNeedingAllocation([order])
  if (needing.length === 0) return { attempted: false, reason: 'fully-covered' }

  // autoAllocateOrder rebuilds OrderAllocation without touching committed ShipmentLines, so
  // reallocating an order that already has shipments would decrement stock against stale
  // rows. It is skipped — but it is still SHORT and still leaving the sweep's reach, and an
  // earlier revision returned here silently, which meant the partial-fulfilment workflow this
  // fix exists to protect got neither the attempt nor the warning (Codex review).
  if (order._count.shipments > 0) {
    await warnEnteringFulfilmentShort(order, 'existing shipments prevent an automatic reallocation')
    return { attempted: false, reason: 'has-shipments' }
  }

  const { autoAllocateOrder } = await import('@/app/actions/allocation')
  await autoAllocateOrder(orderId, {
    // The WooCommerce status mappings drive PICKING/PACKING through the SESSIONLESS
    // transition bypass, and autoAllocateOrder requires an authenticated permission. Without
    // this the webhook path failed the permission check, was swallowed by the catch, and the
    // order proceeded short with no attempt made at all (Codex review).
    internalBypassToken: INTERNAL_ACTION_BYPASS,
    // Closes the TOCTOU on the check above: a concurrent confirmation can create shipment
    // lines between that read and this call, and the allocator re-checks under its own lock.
    refuseIfShipmentsExist: true,
    // Likewise for the status: if the order reached PICKING/PACKING in between, this becomes
    // an explicit no-op rather than rewriting allocations fulfilment now owns.
    requireStatusUnderLock: PRE_FULFILMENT_STATUSES,
  }).catch(() => undefined)

  // Re-read: allocation rewrote the rows, so coverage has to be recomputed rather than
  // inferred from the allocator's return value, which reports its own run rather than the
  // resulting coverage.
  const after = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      refundStatus: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
  })
  const stillShort = after ? (await selectOrdersNeedingAllocation([after])).length > 0 : true

  if (stillShort) {
    await warnEnteringFulfilmentShort(order, 'a final allocation attempt did not close the shortfall')
  }

  return { attempted: true, stillShort }
}

/**
 * The record that an order crossed into fulfilment short. Nothing will retry it after this,
 * so without this line the shortfall simply disappears.
 */
async function warnEnteringFulfilmentShort(
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null },
  because: string,
): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'fulfilment_entry_under_allocated',
    tag: 'sales',
    level: 'WARNING',
    description: `Order ${order.orderNumber ?? order.externalOrderNumber ?? order.id} is entering fulfilment `
      + `without full allocation coverage: ${because}. The periodic reallocation sweep does not reach `
      + 'PICKING/PACKING, so the remainder will not be allocated automatically.',
    metadata: { orderId: order.id, reason: because },
  })
}
