import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { selectOrdersNeedingAllocation } from '@/lib/fulfillment/order-allocation-coverage'
import { isSelectedByReallocationSweep } from '@/lib/fulfillment/reallocation-sweep-selection'
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

/**
 * The one action string for the shortfall record, so the writer and the reader of these rows can
 * never disagree about what to look for.
 */
const SHORTFALL_ACTION = 'fulfilment_entry_under_allocated'

/**
 * Marks a shortfall record as having come from the DIRECT-CREATE path, which is the only path
 * whose record can later turn out to be premature (see `retractSupersededShortfall`).
 *
 * A discriminator rather than a shape inference: `previousStatus === null` happens to identify
 * these today, but "the field a different writer omitted" is not a fact anyone maintains.
 */
const DIRECT_CREATE_SHORTFALL_SOURCE = 'direct-create'

/**
 * Withdrawal of a shortfall record that a late allocation proved premature.
 *
 * A separate row rather than a silent delete: an operator who acted on the WARNING must be able
 * to find out what happened to it, and "the alert vanished" is not an answer.
 */
export const SHORTFALL_RETRACTED_ACTION = 'fulfilment_entry_shortfall_retracted'

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
    action: SHORTFALL_ACTION,
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
 *   handed-back    short, but the reallocation sweep's OWN selector says it would take this
 *                  order, so it will be revisited — and a later crossing into fulfilment is
 *                  recorded by the transition path.
 *   uncovered      short, and NOTHING will cover it automatically. The recordable case.
 */
export type DemandVerdict = 'order-missing' | 'no-demand' | 'covered' | 'handed-back' | 'uncovered'

export type DirectCreateMarkerResolution = {
  /** a shortfall record was written for this order. */
  recorded: boolean
  /** a marker existed and was answered and cleared. */
  resolved: boolean
  /**
   * how many previously-written shortfall records were withdrawn because a late allocation
   * covered the demand after they were committed (see `retractSupersededShortfall`).
   */
  retracted: number
  verdict: DemandVerdict | 'no-marker'
}

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
 *
 * "Something else will cover it" is ASKED OF THE REALLOCATION SWEEP, not asserted from a status
 * (Codex review r5). The sweep selects on status AND on the order having no shipments, so a
 * status list — even one kept in perfect parity with the sweep's — calls an ALLOCATED order with
 * a shipment "handed back" when the sweep would never select it: the obligation would be
 * discharged to nobody, which is precisely what this verdict exists to prevent. The extra query
 * costs one indexed lookup, and only on the short-and-still-owing path.
 */
export async function assessDemandCoverage(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ verdict: DemandVerdict; order: LockedOrder | null }> {
  const { order, short } = await readCoverageUnderLock(tx, orderId)
  if (!order) return { verdict: 'order-missing', order: null }
  if (NO_DEMAND_STATUSES.has(order.status)) return { verdict: 'no-demand', order }
  if (!short) return { verdict: 'covered', order }
  if (await isSelectedByReallocationSweep(tx, orderId)) return { verdict: 'handed-back', order }
  return { verdict: 'uncovered', order }
}

/**
 * Resolve the marker: answer the coverage question under the order lock, record a shortfall when
 * the demand is genuinely uncovered, and clear the marker.
 *
 * THE MARKER IS THE PROVENANCE AND THE IDEMPOTENCY KEY — the marker SET, not the row: an order
 * may carry more than one, they assert one fact, and one answer discharges all of them (Codex
 * review r6, finding 2). No marker means the question was already answered once, so this is safe
 * to call repeatedly, and the created status is read back from the OLDEST marker rather than
 * inferred from the order's current one.
 *
 * "Already answered" is not the same as "answered correctly", though, which is why the no-marker
 * branch is a CORRECTION rather than a return: the answer may have been taken while this order's
 * import was still allocating. See `retractSupersededShortfall`.
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
}): Promise<DirectCreateMarkerResolution> {
  const { tx, orderId } = params

  // The OLDEST marker, because that is the one whose metadata records the creation this
  // obligation is about; any later duplicate is another assertion of the same fact.
  const marker = await tx.activityLog.findFirst({
    where: { entityType: 'SALES_ORDER', entityId: orderId, action: DIRECT_CREATE_PENDING_ACTION },
    select: { metadata: true },
    orderBy: { createdAt: 'asc' },
  })
  // Already resolved — by this order's own import, or by a concurrent resolver that got the lock
  // first. The question has been answered once, but the ANSWER may since have been overtaken by a
  // late allocation, so this is where that gets corrected rather than where we stop looking.
  if (!marker) {
    const retracted = await retractSupersededShortfall(tx, orderId)
    return { recorded: false, resolved: false, retracted, verdict: 'no-marker' }
  }

  const metadata = marker.metadata as { createdAtStatus?: unknown } | null
  const createdStatus = typeof metadata?.createdAtStatus === 'string' ? metadata.createdAtStatus : null

  const { verdict, order } = await assessDemandCoverage(tx, orderId)

  let recorded = false
  if (verdict === 'uncovered' && order) {
    ({ recorded } = await writeShortfallRecord(tx, order, {
      how: createdStatus
        ? `was created directly at ${createdStatus}`
        : 'was created directly into fulfilment',
      metadata: {
        // The discriminator `retractSupersededShortfall` looks for: only a record written from
        // THIS path can turn out to have been premature.
        source: DIRECT_CREATE_SHORTFALL_SOURCE,
        previousStatus: null,
        createdAtStatus: createdStatus,
        currentStatus: order.status,
      },
    }))
  }

  // EVERY marker for this order, not the one row that was read (Codex review r6, finding 2).
  //
  // The obligation is "this order entered fulfilment with its coverage unverified", and an order
  // has exactly ONE of those however many rows assert it. Clearing by row id left any duplicate
  // standing, and a surviving marker is not inert: the next resolver finds it, re-asks a question
  // already answered under this same lock, and writes a SECOND shortfall record for one event.
  // Worse, because the late-allocation correction only runs on the no-marker branch, the leftover
  // marker also keeps `retractSupersededShortfall` from ever withdrawing a record the late
  // allocation has since made false — the duplicate defeats the retraction as well as the
  // idempotency. Keyed on the obligation, both follow from one delete.
  //
  // deleteMany, NOT delete, for the older reason too: a concurrent deletion of a row named by id
  // would make `delete` throw and roll back the shortfall record we just wrote, losing BOTH
  // (Codex review). Clearing markers that are already gone is exactly the no-op it should be.
  await tx.activityLog.deleteMany({
    where: { entityType: 'SALES_ORDER', entityId: orderId, action: DIRECT_CREATE_PENDING_ACTION },
  })
  return { recorded, resolved: true, retracted: 0, verdict }
}

/**
 * THE LATE-ALLOCATION CORRECTION (o3d-z82a, Codex review r5, finding 2).
 *
 * The grace window is a scheduling gate; it decides WHO may answer the coverage question first,
 * and it cannot decide WHAT the answer is. An importer delayed past the window still finishes
 * allocating afterwards, so the sweep can commit "uncovered" for an order that is covered
 * moments later — a fabricated record, which is the one thing this whole feature exists not to
 * produce. No timer closes that, because no timer can tell a slow importer from a dead one.
 *
 * What CAN close it is making the pair mutually exclusive at the point of decision and letting
 * the later, better-informed decision correct the earlier one:
 *
 *   - MUTUAL EXCLUSION. Both the sweep and the importer's post-allocation pass answer inside a
 *     transaction holding this order's `FOR UPDATE` row lock, so the two never interleave: one
 *     of them commits a whole decision before the other reads anything.
 *   - SUPERSESSION. The importer's pass runs strictly AFTER its own `autoAllocateOrder`, so
 *     whatever it sees includes that allocation. If the sweep got there first, the importer
 *     finds no marker — and instead of returning "already resolved", it re-asks the coverage
 *     question and withdraws the record the sweep wrote if that record is now false.
 *
 * The record is only withdrawn when it is WRONG. Still `uncovered` and it stands untouched: a
 * shortfall that survived the late allocation is exactly the fact worth keeping. Withdrawal is
 * not silent either — it leaves a correction row, so an operator who saw the warning can find
 * out what happened to it.
 *
 * ONLY direct-create records are eligible. The transition path's record is atomic with the
 * crossing it describes; there is no window in which it can be premature, and nothing here may
 * touch it.
 *
 * RESIDUAL, stated rather than glossed: if the importer dies in the gap between its allocation
 * committing and this pass, a premature record survives with nobody to withdraw it. That needs
 * the process to both lose the race by more than the grace window AND die within one statement
 * of winning it back; the surviving artefact is an over-reported warning, never a lost one.
 */
async function retractSupersededShortfall(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  // Indexed on (entityType, entityId); an order has at most a couple of these. The source filter
  // is applied in memory because it lives in JSON, and a JSON-path filter here would be one more
  // thing every test double has to reimplement correctly to stay honest.
  const rows = await tx.activityLog.findMany({
    where: { entityType: 'SALES_ORDER', entityId: orderId, action: SHORTFALL_ACTION },
    select: { id: true, metadata: true },
  })
  const superseded = rows.filter(
    (row) => (row.metadata as { source?: unknown } | null)?.source === DIRECT_CREATE_SHORTFALL_SOURCE,
  )
  if (superseded.length === 0) return 0

  const { verdict, order } = await assessDemandCoverage(tx, orderId)
  // The record is still true. Leave it exactly as it is — and write nothing new, because the
  // event it describes happened once.
  if (verdict === 'uncovered' || !order) return 0

  const ids = superseded.map((row) => row.id)
  await tx.activityLog.deleteMany({ where: { id: { in: ids } } })
  await tx.activityLog.create({
    data: {
      entityType: 'SALES_ORDER',
      entityId: order.id,
      action: SHORTFALL_RETRACTED_ACTION,
      tag: 'sales',
      level: 'INFO',
      description: `Order ${order.orderNumber ?? order.externalOrderNumber ?? order.id} was recorded as `
        + 'entering fulfilment under-allocated while its import was still allocating. The allocation '
        + `has since landed (${verdict}), so that record was premature and has been withdrawn.`,
      metadata: { orderId: order.id, verdict, retractedCount: ids.length },
    },
  })
  return ids.length
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
 * IT IS NOT WHAT MAKES THE ANSWER TRUE, and an earlier revision claimed it was (Codex review
 * r5). "Past the window, an import that never allocated is an import that died" does not follow:
 * a delayed import finishes allocating afterwards, and no timer can tell a slow importer from a
 * dead one — that is a liveness question, and this is a clock. What the window buys is that the
 * race is rare; what makes the RECORD true is `retractSupersededShortfall`, which withdraws a
 * verdict the late allocation overtook. Lengthening the grace would trade one wrong answer
 * (premature "uncovered") for another (a marker nothing answers for minutes), which is why it
 * stays at a few times the import's own 20s transaction budget.
 */
export const DIRECT_CREATE_RESOLVE_GRACE_SECONDS = 120

/** Bound the number of markers per tick, like every other sweep here. */
const DIRECT_CREATE_SWEEP_LIMIT = 200

/**
 * Bound the TIME per tick, which the count above does not (Codex review r5, finding 4).
 *
 * Every marker costs a transaction that blocks on that order's row lock, so 200 of them is a
 * count of units, not a duration: a page of orders each waiting out `maxWait` behind a long
 * writer is 200 x 5s before any useful work happens, on a job that runs every 15 minutes.
 *
 * The deadline is checked AFTER each marker, never before, so the budget can throttle the sweep
 * but can never stop it making progress: a zero budget still attempts one marker per tick.
 * Worst-case overshoot is therefore one marker: the 20s transaction timeout, the 5s lock wait, and
 * — only when that marker failed — the deferral's own bounded stamp below.
 *
 * That is progress through the LOOP. Progress through the QUEUE is a different claim and needs
 * the deferral below — "oldest-first" alone guarantees it only while the oldest marker keeps
 * being resolved (Codex review r6, finding 1).
 */
const DIRECT_CREATE_SWEEP_BUDGET_MS = 120_000

/**
 * How long the deferral stamp may take before the DATABASE cancels it (Codex review r4, finding 3).
 *
 * The stamp is best-effort and runs inside the per-tick budget above, so it needs a bound of its
 * own or it can spend that budget on one order: the UPDATE takes row locks on marker rows that a
 * concurrent resolver may be holding for the length of its own transaction, and nothing about an
 * UPDATE limits how long it waits. Cancelled by `SET LOCAL statement_timeout`, so the bound is
 * enforced by Postgres and the connection comes back rather than being left in flight.
 *
 * Below the resolve transaction's own 20s timeout on purpose: the likeliest blocker IS a resolver
 * discharging this order's obligation, and losing the race to it costs nothing — the marker it is
 * deleting will not need deferring. One cycle of fairness is the whole downside, and the next tick
 * simply retries.
 */
export const DIRECT_CREATE_DEFERRAL_TIMEOUT_MS = 5_000

/**
 * THE JSON KEY THAT LETS A FAILING MARKER YIELD ITS TURN (Codex review r6, finding 1).
 *
 * A tight budget spends the whole tick on the head of the queue. If that marker RESOLVES it
 * leaves the queue, so the next tick starts on the next one and the page drains — which is why
 * "a zero budget still resolves one marker, oldest-first" sounded like a starvation argument. It
 * is not: a marker that FAILS is still there, still the oldest, and still the head next tick.
 * A single order whose row lock is permanently held — or whose coverage read reliably times out —
 * then consumes every tick forever and nothing behind it is ever reached. The markers behind it
 * are the ones exempt from retention, so the exemption grows without bound again, which is the
 * failure the sweep exists to prevent.
 *
 * A failed attempt therefore STAMPS this key on the order's markers and the queue is ordered by
 * GREATEST(MIN(createdAt), MAX(lastFailedAt)) — when the marker became due, which is its creation
 * until it fails and its last failure after that. So:
 *
 *   - it YIELDS: the stamp is one millisecond past the LATEST due time outstanding, so the failure
 *     puts it strictly behind every marker queued at that moment. No interval constant is involved
 *     and none would do, because a backoff shorter than the cron's own period would put it
 *     straight back at the head. Nor is a clock reading involved — see `deferFailedMarker`, which
 *     takes the bound from the queue precisely so a clock that steps backwards cannot undo this.
 *   - it does NOT LOSE ITS TURN: nothing is deleted, the obligation still stands, the grace
 *     predicate still reads the untouched `createdAt`, and once its peers have had their turn it
 *     is the oldest-due marker again and is retried.
 *
 * The invariant this restores is the one the budget check needs: EVERY marker leaves the head of
 * the queue after one attempt — resolved and deleted, or deferred behind its peers.
 *
 * Written into the marker's own metadata rather than a column: it is state about the obligation,
 * it dies with the marker, and it costs no migration on a table this size. Every read of it casts
 * it back to a timestamp, so this key must never hold anything else — the ONE statement that
 * writes it is `deferFailedMarker`, and it is read in exactly two places: the candidate query's
 * ORDER BY, and that same deferral statement, which has to know the queue's current maximum to
 * outrank it. All of them spell the key as a SQL literal (a JSON path cannot reference a TS
 * constant), and the pairing is asserted in tests/pre-fulfilment-reallocation.test.ts.
 *
 * Stored NAIVE UTC, which is how Prisma stores `createdAt` in this TIMESTAMP(3) column. The two are
 * compared against each other in that ORDER BY, and a timestamptz on one side would have to be
 * coerced through the session's TimeZone to meet a timestamp on the other — a correct ordering only
 * as long as nobody sets one. Every term the stamp is built from is naive UTC for that reason:
 * `NOW() AT TIME ZONE 'UTC'`, `createdAt`, and the previous stamps themselves.
 */
export const MARKER_DEFERRAL_KEY = 'lastFailedAt'

export type DirectCreateMarkerSweepResult = {
  scanned: number
  recorded: number
  resolved: number
  retracted: number
  errors: number
  /** true when the wall-clock budget ended the page early; the remainder is taken next tick. */
  budgetExhausted: boolean
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
  options: { limit?: number; graceSeconds?: number; budgetMs?: number; now?: () => number } = {},
): Promise<DirectCreateMarkerSweepResult> {
  const limit = options.limit ?? DIRECT_CREATE_SWEEP_LIMIT
  const graceSeconds = options.graceSeconds ?? DIRECT_CREATE_RESOLVE_GRACE_SECONDS
  const budgetMs = options.budgetMs ?? DIRECT_CREATE_SWEEP_BUDGET_MS
  const now = options.now ?? Date.now
  const deadline = now() + Math.max(0, budgetMs)

  // Aged on the DATABASE clock, not this process's. One row per order — an order has ONE
  // obligation however many marker rows assert it, and `resolveDirectCreateMarker` now answers
  // and clears the whole group in one go, so GROUP BY is the unit of work AND the unit of
  // resolution rather than just a way to avoid doing the same order twice in one tick.
  //
  // ORDER BY the DUE time, not the creation time: a marker whose last attempt FAILED is deferred
  // behind every marker that has not, which is what stops one unresolvable order owning the head
  // of the queue for good (see MARKER_DEFERRAL_KEY). GREATEST ignores NULLs in Postgres, so a
  // marker that has never failed is ordered by its creation exactly as before. The ageing
  // predicate is still `createdAt`: a failure must not re-open the import's grace window.
  const rows = await db.$queryRaw<Array<{ entityId: string }>>`
    SELECT "entityId"
    FROM "activity_logs"
    WHERE "entityType" = 'SALES_ORDER'
      AND action = ${DIRECT_CREATE_PENDING_ACTION}
      AND "createdAt" < NOW() - make_interval(secs => CAST(${graceSeconds} AS double precision))
    GROUP BY "entityId"
    ORDER BY GREATEST(MIN("createdAt"), MAX(("metadata"->>'lastFailedAt')::timestamp)) ASC, "entityId" ASC
    LIMIT ${limit}
  `

  const result: DirectCreateMarkerSweepResult = {
    scanned: 0,
    recorded: 0,
    resolved: 0,
    retracted: 0,
    errors: 0,
    budgetExhausted: false,
  }
  if (rows.length === 0) return result

  // Dynamic, matching the allocator import above: the lock helper lives in the allocation
  // service, and pulling it in statically would put that whole module on the import path of
  // every caller of this file, including the WooCommerce order importer.
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')

  for (const row of rows) {
    result.scanned += 1
    try {
      const outcome = await db.$transaction(async (tx) => {
        await lockSalesOrder(tx, row.entityId)
        return resolveDirectCreateMarker({ tx, orderId: row.entityId })
      }, { maxWait: 5_000, timeout: 20_000 })
      if (outcome.resolved) result.resolved += 1
      if (outcome.recorded) result.recorded += 1
      result.retracted += outcome.retracted
    } catch (error) {
      // One poison order must not stop the rest of the page; it is retried next tick.
      result.errors += 1
      console.error(`[direct-create-sweep] could not resolve the marker for ${row.entityId}:`, error)
      // ...and it must not be retried FIRST next tick, or a tight budget spends every tick on it
      // and the queue behind it is never reached (Codex review r6, finding 1).
      await deferFailedMarker(row.entityId)
    }
    // AFTER the work, so a tight budget throttles the page instead of emptying it. `scanned`
    // counts markers this tick actually attempted, not the candidates the query returned.
    if (now() >= deadline && result.scanned < rows.length) {
      result.budgetExhausted = true
      break
    }
  }

  return result
}

/**
 * Send a marker that just failed to the back of the queue, without taking it out of the queue.
 *
 * Stamped on EVERY marker row for the order, because the candidate query orders groups by
 * MAX(lastFailedAt) and the group is the obligation. Written outside the transaction whose failure
 * it records, and deliberately so: that attempt rolled back, and the one thing that must survive it
 * is the record that it happened.
 *
 * It does NOT need the order's row lock, which matters because the most likely reason to be here
 * is that the lock could not be taken — a deferral that queued behind the same lock would fail
 * for the same reason and defer nothing.
 *
 * `createdAt` is left strictly alone — a failed attempt must not re-open the import's grace window.
 *
 * THE STAMP IS TAKEN FROM THE QUEUE, NOT FROM THE CLOCK (Codex review r4, finding 2).
 *
 * It used to be plain `NOW()`, and the fairness argument rested on a property NOW() does not have.
 * What the ordering needs is that a failed marker ends up strictly BEHIND every marker outstanding
 * at that moment; NOW() delivers that only while the database clock runs forward, because every
 * queued marker's due time is a NOW() read from the past. Let the clock step backwards — an NTP
 * correction, a restored snapshot, a failover to a host that was never in step — and the stamp can
 * land BEFORE the peers it was supposed to yield to, or before this marker's own previous stamp.
 * The marker then keeps the head of the queue it just failed at, which is exactly the starvation
 * this mechanism exists to prevent, and it keeps it for as long as the clock is behind.
 *
 * So the stamp asks the queue instead: one millisecond later than the LATEST due time among all
 * outstanding markers — the same GREATEST(createdAt, lastFailedAt) the candidate query orders by,
 * maximised over rows rather than per group, which can only over-estimate and so can only order
 * this marker further back. That is a strict inequality against every peer and against this
 * marker's own previous stamp, and it holds whatever the clock is doing, because no term in it is
 * a clock reading. One millisecond because the column it is compared against is TIMESTAMP(3), so
 * that is the smallest increment both sides of the comparison can represent.
 *
 * NOW() survives as a FLOOR, which is what keeps the value meaningful: with a sane clock the stamp
 * is the real time of the failure (and already later than every peer), and only when the clock has
 * gone backwards does the queue term take over. The sub-select is not a new cost either — it reads
 * precisely the rows the partial index from 20260818090000 isolates, which is the same handful the
 * sweep's own candidate query walks.
 *
 * (The ageing predicate still reads NOW() directly, and that is fine: a backwards clock there
 * DELAYS a marker becoming eligible, which is safe. It is only the ORDER BY that a stale reading
 * could corrupt.)
 *
 * BOUNDED, in its own transaction and by the server (Codex review r4, finding 3).
 *
 * This runs inside the sweep's per-tick wall-clock budget, and an UPDATE has no time limit of its
 * own: it can queue behind a row lock on the very marker rows a concurrent resolver is deleting,
 * and there is no bound on how long that resolver's transaction takes. Waiting there would blow
 * the budget the same review round added, once per failed marker. `SET LOCAL statement_timeout`
 * makes Postgres itself cancel the statement, which is the only bound that also releases the
 * connection; it needs a transaction to be scoped to, so this is the ONE reason the deferral takes
 * one. It is its own transaction and commits on its own — nothing about "survives the attempt that
 * failed" changes.
 *
 * BEST EFFORT. A failure here — timeout included — is not a correctness failure: the marker keeps
 * its place, the next tick retries it first, and the only thing lost is fairness for one cycle.
 * Raising it would turn a fairness aid into a way to abort a sweep that is already dealing with a
 * failure.
 */
async function deferFailedMarker(orderId: string): Promise<void> {
  try {
    await db.$transaction([
      // $executeRawUnsafe because SET takes no bind parameters — it is a utility statement, and a
      // placeholder here is a syntax error. The interpolated value is a numeric module constant,
      // never anything a caller supplies.
      db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${DIRECT_CREATE_DEFERRAL_TIMEOUT_MS}`),
      db.$executeRaw`
        UPDATE "activity_logs"
        SET "metadata" = COALESCE("metadata", '{}'::jsonb)
                       || jsonb_build_object('lastFailedAt', GREATEST(
                            NOW() AT TIME ZONE 'UTC',
                            (SELECT MAX(GREATEST(q."createdAt", (q."metadata"->>'lastFailedAt')::timestamp))
                               FROM "activity_logs" q
                              WHERE q."entityType" = 'SALES_ORDER'
                                AND q.action = ${DIRECT_CREATE_PENDING_ACTION})
                            + interval '1 millisecond'
                          ))
        WHERE "entityType" = 'SALES_ORDER'
          AND action = ${DIRECT_CREATE_PENDING_ACTION}
          AND "entityId" = ${orderId}
      `,
    ])
  } catch (error) {
    console.error(`[direct-create-sweep] could not defer the failed marker for ${orderId}:`, error)
  }
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
      action: SHORTFALL_ACTION,
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
