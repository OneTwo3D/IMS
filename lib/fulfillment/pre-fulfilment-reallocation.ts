import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
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
 * Statuses an order may be in while still OUTSIDE fulfilment. The state machine reaches
 * PICKING from ALLOCATED and ON_HOLD and PACKING from ON_HOLD — but PROCESSING belongs here
 * too, because the WooCommerce status mappings drive transitions through the FULL bypass,
 * which deliberately permits moves the state machine would refuse. Omitting it meant a forced
 * PROCESSING -> PICKING ran the helper and then had its allocation skipped, so the attempt
 * this fix promises never actually happened (Codex review, r2).
 *
 * Doubles as `requireStatusUnderLock` for the allocator (o3d-6ab), which re-checks it while
 * holding the order lock. That is what makes the decision safe despite being taken outside
 * one — a status that moved in between turns the allocation into an explicit no-op.
 */
const PRE_FULFILMENT_STATUSES = ['PROCESSING', 'ALLOCATED', 'ON_HOLD'] as const satisfies readonly SalesOrderStatus[]

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

/** Exported so callers outside this module do not re-hardcode the set. */
export function isFulfilmentStatus(status: string): boolean {
  return FULFILMENT_STATUSES.has(status)
}

export type PreFulfilmentReallocationResult =
  | { attempted: false; reason: 'not-fulfilment-entry' | 'fully-covered' | 'has-shipments' | 'order-missing' }
  /** The allocator declined under its own lock — a shipment or status appeared in between. */
  | { attempted: false; reason: 'refused-under-lock'; stillShort: true }
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
  const run = await autoAllocateOrder(orderId, {
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

  // The allocator declines cleanly rather than throwing when a shipment or a status change
  // appeared under its lock. Reporting that as "an attempt did not close the shortfall" is
  // untrue — no allocation ran at all (Codex review, r2).
  if (run?.refused || run?.skipped) {
    await warnEnteringFulfilmentShort(
      order,
      run.refused
        ? 'a shipment appeared before the allocation could run'
        : `the order was already ${run.skippedStatus ?? 'past this point'} when the allocation ran`,
    )
    return { attempted: false, reason: 'refused-under-lock', stillShort: true }
  }

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

/**
 * The AUTHORITATIVE shortfall check, run INSIDE the status transition's lock.
 *
 * The attempt above is necessarily made outside that lock — `autoAllocateOrder` opens its own
 * transaction — which means every input it used can be stale by the time the transition
 * commits (Codex review, r2):
 *
 *   - the SOURCE status: a request can read PICKING and target PACKING, so the hook is skipped
 *     as "already in fulfilment"; if another request moves PICKING -> ON_HOLD first, the
 *     locked validation then accepts ON_HOLD -> PACKING and the order crosses in unexamined.
 *   - COVERAGE: after the helper observes full coverage, the over-allocation rebalancer can
 *     reduce allocations without eliminating them, and the picking guard only requires a
 *     non-zero count.
 *
 * Either way the order enters fulfilment short with nothing recorded. The ATTEMPT cannot move
 * under the lock, but the DETECTION can, so this runs there against the real previous status.
 *
 * WHAT IT DOES AND DOES NOT GUARANTEE. It closes the two races above: both inputs are read
 * under the lock, and the record commits with the transition.
 *
 * It does NOT guarantee a record when the KIT GRAPH ITSELF changes underneath. Component edits
 * (app/actions/products.ts) run on the global client, take no order lock and join no
 * transaction, so a definition replaced between this graph load and the status write leaves
 * coverage computed against the old shape: an allocation of 1xX reads as complete while the
 * new definition needs 2xX, and the order commits short unrecorded. No isolation level or
 * ordering available here closes it — that needs product-structure edits to participate in
 * order-level locking, which is its own change (o3d-ryyd). Written down rather than glossed,
 * because an overstated guarantee is worse than a documented gap.
 *
 * COST, honestly. Not cheap: it holds the order lock through an order/lines read, one product
 * query per level of KIT nesting, and the coverage queries. Justified only because it runs
 * solely on an actual crossing — and the nesting depth is unbounded (o3d-ryyd).
 */
export async function recordShortfallUnderLock(params: {
  tx: Prisma.TransactionClient
  orderId: string
  previousStatus: string
  targetStatus: string
}): Promise<{ recorded: boolean }> {
  const { tx, orderId, previousStatus, targetStatus } = params
  if (!entersFulfilment(previousStatus, targetStatus)) return { recorded: false }
  return writeShortfallRecord(tx, orderId, {
    reachedStatus: targetStatus,
    how: `crossed ${previousStatus} -> ${targetStatus}`,
    metadata: { previousStatus, targetStatus },
  })
}

/**
 * The same authoritative record, for an order CREATED already in fulfilment rather than moved
 * there (o3d-z82a).
 *
 * The WooCommerce importer writes an operator-configured status straight into
 * `SalesOrder.status`, and the mapping UI offers PICKING and PACKING. Such an order never
 * transitions, so `recordShortfallUnderLock` never sees it — and passing its status as both
 * previous and target would not help: `entersFulfilment` requires the SOURCE to be outside
 * fulfilment, so it would silently return false. Faking a previous status would work
 * mechanically and write a lie into the record.
 *
 * NO allocation attempt here. The importer already calls autoAllocateOrder immediately after
 * creating the order, so re-running it would be a redundant release/re-reserve cycle. What was
 * missing is only the record.
 */
export async function recordShortfallOnDirectCreate(params: {
  tx: Prisma.TransactionClient
  orderId: string
  createdStatus: string
}): Promise<{ recorded: boolean }> {
  const { tx, orderId, createdStatus } = params
  if (!isFulfilmentStatus(createdStatus)) return { recorded: false }

  // IDEMPOTENT, unlike the transition-side entry point, and it has to be. The import is
  // RETRIED — a webhook redelivery or a re-run bulk import reaches the same order again — so
  // this must be safe to call repeatedly, and must be callable from the already-imported path
  // so a retry can finish a record an earlier attempt failed to write (Codex review).
  const existing = await tx.activityLog.count({
    where: { entityType: 'SALES_ORDER', entityId: orderId, action: 'fulfilment_entry_under_allocated' },
  })
  if (existing > 0) return { recorded: false }

  // Re-checked under the lock: the order was created and allocated in earlier, already
  // committed transactions, so it can have been cancelled in the gap. Recording a shortfall
  // for an order that is no longer heading for fulfilment would be a false alarm.
  const current = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
  if (!current || !isFulfilmentStatus(current.status)) return { recorded: false }

  return writeShortfallRecord(tx, orderId, {
    reachedStatus: createdStatus,
    how: `was created directly at ${createdStatus}`,
    metadata: { previousStatus: null, createdAtStatus: createdStatus },
  })
}

/**
 * Shared by both entry points: read the order under the caller's lock, decide coverage against
 * the same client, and write the record in the SAME transaction.
 *
 * Never logActivity — it swallows its own insert failures by design ("never break the caller"),
 * so routing the authoritative record through it meant claiming `recorded: true` for a row that
 * may never have been written (o3d-c9mi r3). Inside the transaction the record and the event it
 * describes are one atomic fact.
 */
async function writeShortfallRecord(
  tx: Prisma.TransactionClient,
  orderId: string,
  context: { reachedStatus: string; how: string; metadata: Record<string, unknown> },
): Promise<{ recorded: boolean }> {
  const order = (await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      refundStatus: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
  })) as
    | { id: string; orderNumber: string | null; externalOrderNumber: string | null; refundStatus: string | null; lines: Array<{ id: string; qty: unknown; productId: string | null }> }
    | null
  if (!order) return { recorded: false }

  const short = await selectOrdersNeedingAllocation([order], undefined, tx)
  if (short.length === 0) return { recorded: false }

  await tx.activityLog.create({
    data: {
      entityType: 'SALES_ORDER',
      entityId: order.id,
      action: 'fulfilment_entry_under_allocated',
      tag: 'sales',
      level: 'WARNING',
      description: `Order ${order.orderNumber ?? order.externalOrderNumber ?? order.id} ${context.how} `
        + 'without full allocation coverage. The periodic reallocation sweep does not reach '
        + 'PICKING/PACKING, so the remainder will not be allocated automatically.',
      metadata: { orderId: order.id, ...context.metadata },
    },
  })
  return { recorded: true }
}
