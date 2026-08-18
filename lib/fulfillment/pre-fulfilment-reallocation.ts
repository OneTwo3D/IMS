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
  const { order, short } = await readCoverageUnderLock(tx, orderId)
  if (!order || !short) return { recorded: false }
  return writeShortfallRecord(tx, order, {
    how: `crossed ${previousStatus} -> ${targetStatus}`,
    metadata: { previousStatus, targetStatus },
  })
}

/** Marker action written atomically with an order created already in fulfilment. */
export const DIRECT_CREATE_PENDING_ACTION = 'fulfilment_entry_pending_verification'

/**
 * The marker row, to be created in the SAME transaction as the order (o3d-z82a).
 *
 * DURABLE PROVENANCE, and it has to be. An earlier revision inferred "was created in
 * fulfilment" from the order's CURRENT status on the retry path, which is unsound in both
 * directions (Codex review): an order created PROCESSING and later moved to PICKING by a
 * transition — which has its own recorder — would get a false "created directly at PICKING",
 * while a genuinely direct-created order that reached SHIPPED before the retry would be skipped
 * and lose its record permanently. Current status is not a proxy for creation status.
 *
 * It is also the FAIL-SAFE. Because it is atomic with the order it cannot be lost, so if the
 * coverage check below never succeeds the marker still stands as a visible WARNING that this
 * order entered fulfilment without its coverage being verified. That is what lets the recorder
 * be non-fatal to the import.
 */
export function directCreateMarker(orderId: string, createdStatus: string): Prisma.ActivityLogCreateInput {
  return {
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: DIRECT_CREATE_PENDING_ACTION,
    tag: 'sales',
    level: 'WARNING',
    description: `Order was created directly at ${createdStatus}, outside the reallocation `
      + 'sweep\'s reach. Allocation coverage has not yet been verified.',
    metadata: { orderId, createdAtStatus: createdStatus },
  }
}

/**
 * The o3d-9lx sweep's own eligible set, mirrored from REALLOCATION_ELIGIBLE_STATUSES in
 * lib/fulfillment/reallocation-sweep.ts.
 *
 * An order sitting in one of these is not "out of reach" at all: the sweep re-selects it on
 * every rotation, and if it later crosses back INTO fulfilment that crossing is a status
 * transition, which `recordShortfallUnderLock` already covers. So the direct-create obligation
 * has a real owner again — this is a HANDOFF to a named mechanism, not the assumption that
 * leaving a status made the question go away.
 */
const AUTOMATICALLY_REVISITED_STATUSES = new Set(['PROCESSING', 'ALLOCATED'])

/**
 * Statuses in which there is NO DEMAND left to cover.
 *
 * CANCELLED alone. `cancelSalesOrderFulfillmentState` releases every reservation and DELETES
 * every OrderAllocation row, so a cancelled order reads as maximally short while in fact owing
 * nothing at all. This is a statement about DEMAND, and it is the only reason "the order left
 * PICKING" may ever end in silence.
 *
 * SHIPPED / COMPLETED / DELIVERED are deliberately NOT here, and that is the correction (Codex
 * review r4). Dispatch decrements reservedQty but RETAINS the OrderAllocation rows, so
 * `OrderAllocation.qty` still equals outstanding demand plus every committed non-PENDING
 * shipment line. An order that shipped everything it was allocated therefore reads as COVERED on
 * its own and needs no special case; an order that still reads SHORT after shipping SHIPPED
 * SHORT — which is precisely the fact this whole feature exists to record, and which the earlier
 * "has it left fulfilment?" test discarded.
 */
const NO_DEMAND_STATUSES = new Set(['CANCELLED'])

/**
 * What is true about this order's demand RIGHT NOW — the question every caller actually has.
 *
 *   order-missing  the order is gone; there is nothing to describe.
 *   no-demand      there is nothing to cover (CANCELLED).
 *   covered        OrderAllocation covers net demand. Includes a fully shipped order, whose
 *                  allocation rows are retained, and a fully refunded one.
 *   handed-back    short, but the order is back in the sweep's eligible set, which will
 *                  revisit it — and a later crossing into fulfilment is recorded by the
 *                  transition path.
 *   uncovered      short, and NOTHING will cover it automatically. The recordable case.
 */
export type DemandVerdict = 'order-missing' | 'no-demand' | 'covered' | 'handed-back' | 'uncovered'

type LockedOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  refundStatus: string | null
  lines: Array<{ id: string; qty: unknown; productId: string | null }>
}

/**
 * ONE read of the order, serving both the status question and the coverage question.
 *
 * It used to be two `findUnique` calls with different selects — which meant every test double
 * had to discriminate them by whether `status` appeared in the select, and a double that got
 * that wrong answered the wrong question silently. One read, one shape, nothing to discriminate.
 */
async function readCoverageUnderLock(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ order: LockedOrder | null; short: boolean }> {
  const order = (await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      // The coverage selector treats FULL as unconditional zero demand, matching
      // allocateSalesOrder. Omitting it would make a fully-refunded order look short forever.
      refundStatus: true,
      lines: { select: { id: true, qty: true, productId: true } },
    },
  })) as LockedOrder | null
  if (!order) return { order: null, short: false }
  const short = (await selectOrdersNeedingAllocation([order], undefined, tx)).length > 0
  return { order, short }
}

/**
 * Is the demand covered, and if not, will anything cover it? Decided from the ORDER's own state
 * under the caller's lock — never from the fact that a status was left or a marker row vanished.
 */
export async function assessDemandCoverage(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ verdict: DemandVerdict; order: LockedOrder | null }> {
  const { order, short } = await readCoverageUnderLock(tx, orderId)
  if (!order) return { verdict: 'order-missing', order: null }
  if (NO_DEMAND_STATUSES.has(order.status)) return { verdict: 'no-demand', order }
  if (!short) return { verdict: 'covered', order }
  if (AUTOMATICALLY_REVISITED_STATUSES.has(order.status)) return { verdict: 'handed-back', order }
  return { verdict: 'uncovered', order }
}

/**
 * Resolve the marker: answer the coverage question under the order lock, record a shortfall when
 * the demand is genuinely uncovered, and clear the marker.
 *
 * THE MARKER IS THE PROVENANCE AND THE IDEMPOTENCY KEY. No marker means already resolved, so
 * this is safe to call repeatedly, and the created status is read back from the marker rather
 * than inferred from the order's current one.
 *
 * WHAT COUNTS AS RESOLUTION (Codex review r4). Not "the order left PICKING/PACKING" — an order
 * leaves that status cancelled, dispatched short, or moved back, and only one of those three is
 * the shortfall being covered. The obligation is discharged only against `assessDemandCoverage`:
 * the demand is covered, or there is no demand, or something else now owns covering it. Every
 * other outcome is the record being written. In particular a SHIPPED order that still reads
 * short shipped short, and now gets the record the previous "it has left fulfilment, the
 * question is moot" rule silently threw away.
 *
 * IT ALWAYS TERMINATES. Every branch clears the marker, including one whose metadata cannot be
 * read — the created status is then reported as unknown rather than left as a row nothing will
 * ever clear. That is what makes the retention exemption in lib/activity-log-cleanup.ts bounded
 * rather than an unbounded leak.
 */
export async function resolveDirectCreateMarker(params: {
  tx: Prisma.TransactionClient
  orderId: string
}): Promise<{ recorded: boolean; resolved: boolean; verdict: DemandVerdict | 'no-marker' }> {
  const { tx, orderId } = params

  const marker = await tx.activityLog.findFirst({
    where: { entityType: 'SALES_ORDER', entityId: orderId, action: DIRECT_CREATE_PENDING_ACTION },
    select: { id: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  })
  // Already resolved — by this order's own import, or by a concurrent resolver that got the lock
  // first. Either way the question has been answered once, which is all it needs.
  if (!marker) return { recorded: false, resolved: false, verdict: 'no-marker' }

  const metadata = marker.metadata as { createdAtStatus?: unknown } | null
  const createdStatus = typeof metadata?.createdAtStatus === 'string' ? metadata.createdAtStatus : null

  const { verdict, order } = await assessDemandCoverage(tx, orderId)

  let recorded = false
  if (verdict === 'uncovered' && order) {
    ({ recorded } = await writeShortfallRecord(tx, order, {
      how: createdStatus
        ? `was created directly at ${createdStatus}`
        : 'was created directly into fulfilment',
      metadata: { previousStatus: null, createdAtStatus: createdStatus, currentStatus: order.status },
    }))
  }

  // Cleared in the SAME transaction as the record, so if the record could not be written the
  // marker survives with it and the two can never disagree.
  //
  // deleteMany, NOT delete: a concurrent deletion of this row would make `delete` throw and
  // roll back the shortfall record we just wrote, losing BOTH (Codex review). Clearing a marker
  // that is already gone is exactly the no-op it should be.
  await tx.activityLog.deleteMany({ where: { id: marker.id } })
  return { recorded, resolved: true, verdict }
}

/**
 * How long a marker belongs to the import that wrote it before anything else may decide it.
 *
 * This is a SCHEDULING gate, not a verdict. Between the create transaction committing and the
 * importer's own `autoAllocateOrder` finishing, the order genuinely has no allocations yet — and
 * a resolver that looked then would read "short", record a shortfall for an order about to be
 * allocated, and discharge the marker so the real answer could never be written (Codex review
 * r4). The importer's allocation takes the same `FOR UPDATE` row lock this sweep does, so once
 * that allocation has STARTED the two are already serialised; the window this closes is only the
 * gap before it starts, and the grace is several times the import's own 20s transaction budget.
 *
 * Past it, an import that never allocated is an import that DIED, and "uncovered" is then the
 * true answer rather than a premature one.
 */
export const DIRECT_CREATE_RESOLVE_GRACE_SECONDS = 120

/** Bound the work per tick, like every other sweep here. */
const DIRECT_CREATE_SWEEP_LIMIT = 200

export type DirectCreateMarkerSweepResult = {
  scanned: number
  recorded: number
  resolved: number
  errors: number
}

/**
 * THE BOUNDED RESOLUTION MECHANISM for direct-create markers (o3d-z82a, Codex review r4).
 *
 * The marker is exempt from activity-log retention because deleting it would silently discharge
 * an open obligation. That exemption is only defensible if something is guaranteed to CLEAR the
 * marker; before this, the only other resolver was a WooCommerce redelivery of that same order,
 * which for most orders never arrives — so an import whose own resolve failed left a row nothing
 * would ever touch again, and the exemption accumulated without limit.
 *
 * It also replaces the redelivery resolve outright, which is why the hot webhook path now pays
 * NOTHING for this feature: an import that did not write a marker does not look for one, and a
 * redelivery never looks at all. The lock-free pre-check it used to need is gone with it, along
 * with the race that pre-check could not close.
 */
export async function sweepUnresolvedDirectCreateMarkers(
  options: { limit?: number; graceSeconds?: number } = {},
): Promise<DirectCreateMarkerSweepResult> {
  const limit = options.limit ?? DIRECT_CREATE_SWEEP_LIMIT
  const graceSeconds = options.graceSeconds ?? DIRECT_CREATE_RESOLVE_GRACE_SECONDS

  // Aged on the DATABASE clock, not this process's. One row per order (an order can only be
  // created once, but GROUP BY makes a duplicate marker one unit of work rather than two).
  const rows = await db.$queryRaw<Array<{ entityId: string }>>`
    SELECT "entityId"
    FROM "activity_logs"
    WHERE "entityType" = 'SALES_ORDER'
      AND action = ${DIRECT_CREATE_PENDING_ACTION}
      AND "createdAt" < NOW() - make_interval(secs => CAST(${graceSeconds} AS double precision))
    GROUP BY "entityId"
    ORDER BY MIN("createdAt") ASC
    LIMIT ${limit}
  `

  const result: DirectCreateMarkerSweepResult = { scanned: rows.length, recorded: 0, resolved: 0, errors: 0 }
  if (rows.length === 0) return result

  // Dynamic, matching the allocator import above: the lock helper lives in the allocation
  // service, and pulling it in statically would put that whole module on the import path of
  // every caller of this file, including the WooCommerce order importer.
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')

  for (const row of rows) {
    try {
      const outcome = await db.$transaction(async (tx) => {
        await lockSalesOrder(tx, row.entityId)
        return resolveDirectCreateMarker({ tx, orderId: row.entityId })
      }, { maxWait: 5_000, timeout: 20_000 })
      if (outcome.resolved) result.resolved += 1
      if (outcome.recorded) result.recorded += 1
    } catch (error) {
      // One poison order must not stop the rest of the page; it is retried next tick.
      result.errors += 1
      console.error(`[direct-create-sweep] could not resolve the marker for ${row.entityId}:`, error)
    }
  }

  return result
}

/**
 * Shared by both entry points: write the record in the SAME transaction as the decision, against
 * the order the caller already read under its lock.
 *
 * Never logActivity — it swallows its own insert failures by design ("never break the caller"),
 * so routing the authoritative record through it meant claiming `recorded: true` for a row that
 * may never have been written (o3d-c9mi r3). Inside the transaction the record and the event it
 * describes are one atomic fact.
 */
async function writeShortfallRecord(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
  context: { how: string; metadata: Record<string, unknown> },
): Promise<{ recorded: boolean }> {
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
