// ---------------------------------------------------------------------------
// Post-refund reservation-release durable outbox (o3d-67y)
//
// A refund reduces an already-allocated, not-yet-shipped order's outstanding
// demand, so the refunded units' stock reservation must be released by re-running
// allocation. That release runs AFTER the refund transaction commits (it cannot be
// folded into it), which makes the immediate attempt (releaseReservationsAfterRefund
// in app/actions/sales.ts) inherently best-effort:
//   - a throw in the post-commit accounting/WMS work can bypass it entirely, and
//   - a crash between commit and release loses it,
// leaving a committed refund silently holding reservations on stockLevel.reservedQty.
//
// This enqueues a backstop row into the generic IntegrationOutbox INSIDE the refund
// transaction (so it commits atomically with the refund — a post-commit throw or a
// crash can no longer lose the intent) and a cron-drained processor re-runs
// allocation. autoAllocateOrder is idempotent — re-running it on an order whose
// reservation was already released (by the immediate attempt) is a harmless no-op —
// so the immediate call stays for timeliness and the outbox is a pure durability
// backstop. Durability therefore comes from THIS in-tx row, NOT from the immediate
// attempt's activity-log warning (logActivity swallows write failures).
//
// The order lock inside allocateSalesOrder makes re-running safe regardless of how
// the order has moved on by drain time (CANCELLED / fully-refunded → zero-demand
// release; existing shipment → a conservative refuse; the residual shipment-vs-refund
// reservation reconciliation is tracked separately, o3d-339).
// ---------------------------------------------------------------------------

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  enqueueIntegrationOutbox,
  claimIntegrationOutboxWork,
  markIntegrationOutboxSuccess,
  markIntegrationOutboxRetryableFailure,
  buildOutboxIdempotencyKey,
  INTEGRATION_OUTBOX_STATUS,
  DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  type IntegrationOutboxClient,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  SalesRefundReservationReleaseOutboxPayloadSchema,
  SalesRefundUnmatchedWarningOutboxPayloadSchema,
} from '@/lib/domain/integrations/outbox-registry'

export type OutboxUpdateClient = {
  integrationOutbox: { updateMany(args: unknown): Promise<{ count: number }> }
}

/** o3d-2k5r r4: the READ half — what "is a repack recovery still outstanding?" needs. */
export type OutstandingReleaseReadClient = {
  salesOrderRefund: { findMany(args: unknown): Promise<Array<{ id: string }>> }
  integrationOutbox: { count(args: unknown): Promise<number> }
}

export const REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR = 'sales'
export const REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION = 'refund.reservation-release'
const REFUND_RESERVATION_RELEASE_OUTBOX_WORKER = 'refund-reservation-release-drain'

// Delay the backstop drain past the immediate post-commit release so the drain
// never races it: by the next cron tick the immediate call has already released
// the reservation, so the drain's re-allocation is an idempotent no-op. A crash /
// bypass that lost the immediate call is still recovered on a following tick.
const DEFAULT_DRAIN_GRACE_MS = 120_000

// Sub-unit tolerance for residual reserved qty (fractional kit/BOM quantities can leave rounding dust).
export const REFUND_RESERVATION_EPSILON = 1e-6

export type RefundReleaseLine = { lineKind: string; qty: number; lineId: string | null }

/** A positive-quantity sale refund line linked to a persisted sales-order line — the only partial-refund shape
 *  that actually reduces a tracked line's fulfilment demand (allocation ignores refund rows with a null
 *  salesOrderLineId). */
function isMatchedDemandLine(line: RefundReleaseLine): boolean {
  return line.lineKind === 'sale' && line.qty > 0 && line.lineId != null
}

/** A positive-quantity sale refund line with NO persisted line link — WooCommerce permits this unmatched shape
 *  ({ lineId: null, productId: null, lineKind: 'sale', qty: >0 }). Allocation cannot map it to a line, so it
 *  neither reduces demand nor is a safe release target; treated as a data-quality anomaly, not demand-reducing. */
export function hasUnmatchedSaleRefund(refundLines: ReadonlyArray<RefundReleaseLine>): boolean {
  return refundLines.some((line) => line.lineKind === 'sale' && line.qty > 0 && line.lineId == null)
}

/**
 * A post-refund reservation release is warranted only when BOTH hold (Codex review r7/r8):
 *   - there is a live residual reservation (allocated − shipped > 0), and
 *   - the refund actually REDUCES fulfilment demand: a positive-quantity sale line LINKED to a persisted
 *     sales-order line, or a FULL refund (zero remaining demand is intentional, released via refundStatus=FULL).
 * An amount-only partial (shipping/discount/goodwill/price-only) OR an unmatched external quantity line changes
 * no tracked line's demand — allocation would ignore it — so it must not enqueue release work that would then be
 * falsely resolved as successful while the reservation stays held (letting a later shipment include the
 * refunded quantity).
 */
export function isRefundReleaseEligible(input: {
  residualReserved: number
  newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED'
  refundLines: ReadonlyArray<RefundReleaseLine>
}): boolean {
  if (input.residualReserved <= REFUND_RESERVATION_EPSILON) return false
  return input.newStatus === 'REFUNDED' || input.refundLines.some(isMatchedDemandLine)
}

export type ScheduleRefundReservationReleaseInput = {
  orderId: string
  refundId: string
  /**
   * Whether this refund reduces a MATCHED line's demand and the order holds a live reservation — derived under
   * the refund's order lock (isRefundReleaseEligible + residual reservation). Drives the release re-attempt.
   */
  eligible: boolean
}

/**
 * Enqueue the durable reservation-RELEASE backstop — call INSIDE the createSalesOrderRefund transaction so the
 * outbox row commits atomically with the refund. No-op when the refund does not reduce a matched line's demand.
 * The idempotency key is per-refund so a replayed refund dedups to a single row. Kept separate from the
 * unmatched-warning row so delivering that WARNING never re-runs allocation (Codex review r10).
 */
export async function scheduleRefundReservationReleaseOutbox(
  tx: Prisma.TransactionClient,
  input: ScheduleRefundReservationReleaseInput,
  options: { graceMs?: number; now?: Date } = {},
): Promise<void> {
  if (!input.eligible) return
  const now = options.now ?? new Date()
  const idempotencyKey = buildOutboxIdempotencyKey(
    REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
    input.refundId,
  )
  await enqueueIntegrationOutbox(
    {
      connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
      operation: REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
      idempotencyKey,
      payloadJson: { orderId: input.orderId, refundId: input.refundId },
      nextAttemptAt: new Date(now.getTime() + (options.graceMs ?? DEFAULT_DRAIN_GRACE_MS)),
    },
    { client: tx as unknown as IntegrationOutboxClient },
  )
}

export const REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION = 'refund.unmatched-warning'
const REFUND_UNMATCHED_WARNING_OUTBOX_WORKER = 'refund-unmatched-warning-drain'

export type ScheduleRefundUnmatchedWarningInput = {
  orderId: string
  refundId: string
  refundOrderRef?: string
  /** Whether this refund has an unmatched positive-qty sale line with a live residual reservation (Codex r8/r9). */
  unmatched: boolean
}

/**
 * Enqueue the durable unmatched-refund-line WARNING backstop — call INSIDE the createSalesOrderRefund
 * transaction. This row's ONLY duty is delivering the operator WARNING (allocation cannot release an unmatched
 * external quantity line), so it never re-runs allocation. No-op unless the anomaly holds.
 */
export async function scheduleRefundUnmatchedWarningOutbox(
  tx: Prisma.TransactionClient,
  input: ScheduleRefundUnmatchedWarningInput,
  options: { graceMs?: number; now?: Date } = {},
): Promise<void> {
  if (!input.unmatched) return
  const now = options.now ?? new Date()
  const idempotencyKey = buildOutboxIdempotencyKey(
    REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION,
    input.refundId,
  )
  await enqueueIntegrationOutbox(
    {
      connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
      operation: REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION,
      idempotencyKey,
      payloadJson: { orderId: input.orderId, refundId: input.refundId, refundOrderRef: input.refundOrderRef ?? '' },
      nextAttemptAt: new Date(now.getTime() + (options.graceMs ?? DEFAULT_DRAIN_GRACE_MS)),
    },
    { client: tx as unknown as IntegrationOutboxClient },
  )
}

/**
 * Mark the backstop row for this refund SUCCEEDED after the IMMEDIATE post-refund
 * release reconciled the reservation, so the cron drain does NOT re-run allocation.
 * Re-running allocation is not side-effect-idempotent (it deletes/recreates
 * OrderAllocation rows and resets staged allocation accounting), so once the
 * immediate attempt has released, the durable backstop's work is done (Codex review
 * r2). Only resolves a row an operator can still finish (`RESUMABLE_RELEASE_STATUSES` — including a
 * dead-lettered PERMANENT_FAILED one, which is the whole point of o3d-2k5r r6: the
 * in-transaction recovery is now the only thing that can ever clear it) — a row the
 * drain has already claimed (PROCESSING) or finished is left untouched. Best-effort: if
 * this fails, the drain re-runs the (numerically idempotent) release on the next tick.
 */
/**
 * TWO QUESTIONS ABOUT THE SAME COLUMN, AND THEY ARE NOT THE SAME QUESTION (o3d-2k5r r8, Codex).
 *
 * r4 shipped ONE status set behind ONE count, on the principle that a reader and a resolver which
 * disagree leave a control that can be pressed and can never go away. That principle still holds —
 * for the OPERATOR CONTROL. It does not hold for the DISPATCH FENCE added in r7, which reused the
 * same count and so inherited the one exclusion that is exactly backwards for it: PROCESSING.
 *
 *   "May the operator press Finish repack recovery?"  PROCESSING is a NO. The drain owns the row
 *                                                     and is running the same repair right now;
 *                                                     offering the button invites a race with it.
 *   "May this dispatch go?"                           PROCESSING is the strongest YES-IT-IS-OWED
 *                                                     there is. A worker is mid-repair on it.
 *
 * And it MATTERS rather than merely reading oddly, because of WHERE the claim happens.
 * `claimIntegrationOutboxWork` flips the row to PROCESSING BEFORE the drain calls allocation, and
 * that claim takes NO sales-order lock. So a dispatch can take the order lock inside the window
 * between the claim and the worker's allocation, count zero outstanding rows, and commit SHIPPED.
 * The worker then takes the lock, finds a dispatched shipment, refuses, and hands the row back as
 * RETRYABLE_FAILED — now pointing at an order no click can ever recover. The order lock does not
 * serialize that, because the claim never took it. The fence has to count the claim itself.
 *
 * So: two named sets, two named reads, one question each. Neither is the "correct" one.
 */

/**
 * THE STATUSES AN OPERATOR CAN STILL PICK UP AND FINISH (o3d-2k5r r4, widened in r6).
 *
 * One set, used by BOTH the evidence read that offers the recovery control and the write that
 * resolves the row when the recovery runs — because a status the reader counts as outstanding but
 * the resolver refuses to clear is a control that can be pressed and can never go away.
 *
 * PENDING / RETRYABLE_FAILED — the drain still owns them; the release is owed.
 *
 * PERMANENT_FAILED — the drain has GIVEN UP on them, and that is the strongest evidence of all
 * (o3d-2k5r r6). The drain refuses while any shipment exists and burns an attempt each time, so an
 * order stranded long enough dead-letters here; `claimIntegrationOutboxWork` never claims a
 * PERMANENT_FAILED row again, so nothing else in the system will ever release that reservation.
 * Excluding it inverted the design's own promise: the orders the resume path was BUILT for — the
 * ones stranded by the earlier non-transactional shape, which have had the longest to exhaust their
 * retries — were the exact orders it withheld the control from, leaving stock reserved indefinitely.
 *
 * PROCESSING is deliberately NOT here. The drain holds the row and is running the same repair right
 * now; offering the operator the button then is inviting them to race a worker that already has it,
 * and a resolver that cleared a claimed row would let the recovery and the drain both believe they
 * finished it. If the drain fails it returns the row to RETRYABLE_FAILED and the control comes back
 * on the next read. THE DISPATCH FENCE MUST NOT COPY THIS EXCLUSION — see
 * `UNFINISHED_RELEASE_STATUSES`.
 *
 * SUCCEEDED is the recovery already done.
 */
const RESUMABLE_RELEASE_STATUSES: string[] = [
  INTEGRATION_OUTBOX_STATUS.PENDING,
  INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
  INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
]

/**
 * THE STATUSES THAT MEAN THE RELEASE HAS NOT HAPPENED (o3d-2k5r r8, Codex).
 *
 * Every status that is not SUCCEEDED, and derived from the status enum rather than listed, so a
 * status added to `INTEGRATION_OUTBOX_STATUS` later fences dispatch by default instead of quietly
 * becoming a hole in it. Being wrong in this direction costs a refused dispatch whose message names
 * the remedy; being wrong in the other costs an order nobody can repair.
 *
 * NOTHING STRANDS ON THIS. Every status here has a way out that does not require a dispatch:
 *   - PENDING / RETRYABLE_FAILED / PERMANENT_FAILED are all resumable by the operator control
 *     (`RESUMABLE_RELEASE_STATUSES` above is exactly those three), and while the order holds no
 *     dispatched shipment that control's own prerequisite — reopen the committed siblings — is
 *     reachable too.
 *   - PROCESSING cannot be terminal. `attempts` is only ever incremented by the same write that
 *     moves the row OUT of PROCESSING, so a claimed row always satisfies the `attempts < maxAttempts`
 *     half of `claimableWhere`, and its other half re-claims any PROCESSING row whose `lockedAt` is
 *     older than the stale-lock window. A crashed worker's row therefore returns to a resumable
 *     status on a later drain tick rather than sitting here for ever.
 * And the fence has its own escape hatch regardless: `dispatchForeclosesRepackRecovery` stops
 * refusing once the order already holds a dispatch, so an order past the wall still ships.
 */
const UNFINISHED_RELEASE_STATUSES: string[] = Object.values(INTEGRATION_OUTBOX_STATUS)
  .filter((status) => status !== INTEGRATION_OUTBOX_STATUS.SUCCEEDED)

/**
 * o3d-2k5r r4 — THE DURABLE EVIDENCE THAT A REPACK RECOVERY IS STILL OUTSTANDING.
 *
 * The recovery's third step resolves these rows. So a row still sitting at one of the caller's
 * statuses, for one of this order's refunds, is exactly "the refunded units' reservation has not
 * been released for this order yet", committed inside the refund's own transaction and therefore
 * surviving every crash the recovery can suffer.
 *
 * Deliberately NOT "the order has a PENDING shipment": every order with a draft has one, and
 * offering the control on all of them would be an invitation to re-run a repair that is already
 * done. Nor "an activity-log row exists": logActivity swallows write failures, so its absence
 * proves nothing.
 *
 * Private: callers pick a QUESTION (one of the two exported reads below), never a status list.
 */
async function countRefundReservationReleasesAt(
  orderId: string,
  statuses: string[],
  options: { client?: OutstandingReleaseReadClient },
): Promise<number> {
  const client = options.client ?? (db as unknown as OutstandingReleaseReadClient)
  const refunds = await client.salesOrderRefund.findMany({ where: { orderId }, select: { id: true } })
  if (refunds.length === 0) return 0
  const idempotencyKeys = refunds.map((refund) => buildOutboxIdempotencyKey(
    REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
    refund.id,
  ))
  return client.integrationOutbox.count({
    where: {
      connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
      operation: REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
      idempotencyKey: { in: idempotencyKeys },
      status: { in: statuses },
    },
  })
}

/**
 * THE AFFORDANCE READ — "does this order owe a recovery an OPERATOR can finish right now?"
 *
 * Gates the "Finish repack recovery" control (`getOrderShipments`), so it appears only where there
 * is something to finish and disappears once there is not. Excludes PROCESSING on purpose: while
 * the drain holds the row the operator has nothing to press, and `resolveRefundReservationReleaseOutbox`
 * would refuse to clear a claimed row anyway.
 *
 * NOT the dispatch fence's question — use `countUnfinishedRefundReservationReleases` for that.
 */
export async function countResumableRefundReservationReleases(
  orderId: string,
  options: { client?: OutstandingReleaseReadClient } = {},
): Promise<number> {
  return countRefundReservationReleasesAt(orderId, RESUMABLE_RELEASE_STATUSES, options)
}

/**
 * THE DISPATCH-FENCE READ — "has this order's deferred reservation release actually happened?"
 *
 * Counts a claimed (PROCESSING) row as outstanding, which is the whole difference from the
 * affordance read above: a worker OWNING the row is precisely when a dispatch must not proceed,
 * because the claim took no order lock and the worker's allocation has not run yet.
 *
 * NOT the affordance's question — a row counted here may be one the operator can do nothing about
 * this second, and that is fine: the fence refuses a dispatch, it does not render a button.
 */
export async function countUnfinishedRefundReservationReleases(
  orderId: string,
  options: { client?: OutstandingReleaseReadClient } = {},
): Promise<number> {
  return countRefundReservationReleasesAt(orderId, UNFINISHED_RELEASE_STATUSES, options)
}

export async function resolveRefundReservationReleaseOutbox(
  refundId: string,
  options: { client?: OutboxUpdateClient } = {},
): Promise<number> {
  const client = options.client ?? (db as unknown as OutboxUpdateClient)
  const idempotencyKey = buildOutboxIdempotencyKey(
    REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
    refundId,
  )
  const { count } = await client.integrationOutbox.updateMany({
    where: {
      connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
      operation: REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
      idempotencyKey,
      status: { in: RESUMABLE_RELEASE_STATUSES },
    },
    // `nextAttemptAt` is cleared with the rest: a PERMANENT_FAILED row carries null already, and a
    // RETRYABLE_FAILED one must not keep a due time on a row nothing will drain again.
    data: {
      status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: null,
    },
  })
  return count
}

/** The subset of autoAllocateOrder's result the drain classifies on. */
export type ReleaseAllocationResult = {
  success: boolean
  error?: string
  // Set ONLY when the allocation transaction threw and rolled back (reservations NOT mutated).
  failed?: boolean
  // Set when refuseIfShipmentsExist declined — a deliberate, consistent no-op (deferred to o3d-339).
  refused?: boolean
  // Set true ONLY when the allocation transaction committed (reservedQty reconciled). A pre-transaction bail
  // (no eligible warehouse) leaves it false — that is NOT a completed release and must retry (Codex review r3).
  committed?: boolean
}

export type RefundWarningParams = { orderId: string; refundId: string; refundOrderRef?: string }

/** The transaction client the drain hands to allocation's onReconciledInTx (structurally a Prisma tx). */
export type ReconcileTxClient = Parameters<typeof markIntegrationOutboxSuccess>[0]['client']

export type RefundReservationReleaseDrainDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  // o3d-67y r12: the drain resolves its CLAIMED row inside allocation's transaction (onReconciledInTx),
  // symmetric to the immediate path, so a crash between the allocation commit and a separate SUCCEEDED write
  // can't leave the row PROCESSING for stale-lock recovery to re-run allocation.
  allocate: (orderId: string, opts?: { onReconciledInTx?: (tx: ReconcileTxClient) => Promise<void> }) => Promise<ReleaseAllocationResult>
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
  /** Deliver the shipment-refuse deferral WARNING (o3d-67y r5) — idempotent, returns 'written'|'skipped'. */
  logDeferral: (params: RefundWarningParams) => Promise<'written' | 'skipped'>
}

export const DEFERRAL_WARNING_ACTION = 'refund_reservation_release_deferred'
export const UNMATCHED_WARNING_ACTION = 'refund_reservation_release_unmatched'

// Advisory-lock namespace for the per-refund WARNING dedup (distinct from REFUND_ACCOUNTING_LOCK_KEY).
import { REFUND_RELEASE_WARNING_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

/** Stable signed-int32 hash of a refund id for the second pg_advisory_xact_lock parameter. */
function advisoryHash(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  }
  return hash
}

const deferralDescription = (p: RefundWarningParams) =>
  `Refund on order ${p.refundOrderRef || p.orderId} could not release its stock reservation because a shipment already exists (recovered by the durable backstop). The refunded units may still be reserved; verify the pending shipment nets the refund so they are neither stranded-reserved nor dispatched.`

const unmatchedDescription = (p: RefundWarningParams) =>
  `Refund on order ${p.refundOrderRef || p.orderId} includes a quantity line not linked to any order line, so its stock reservation could not be released automatically. Reconcile the reservation manually — a later shipment could otherwise include the refunded quantity.`

/**
 * Build the DEFAULT idempotent + retryable WARNING writer for one action. It serializes the check-then-write
 * under a per-refund advisory lock so two concurrent workers (stale-lock reclamation, a delayed immediate
 * helper) cannot both observe "no row" and both insert — ActivityLog has no refund-scoped unique constraint, so
 * the lock is what makes it at-most-once (Codex r7). It confirms PERSISTENCE inside the same transaction, so a
 * swallowed earlier write leaves no row and a later attempt re-delivers (Codex r6). Keyed on (action, refundId)
 * so the deferral and unmatched warnings dedup independently.
 */
function lockedRefundWarningWriter(spec: {
  action: string
  reason: string
  describe: (p: RefundWarningParams) => string
}): (params: RefundWarningParams) => Promise<'written' | 'skipped'> {
  return async (params) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_RELEASE_WARNING_LOCK_NAMESPACE}, ${advisoryHash(params.refundId)})`
      return writeRefundWarningOnce(
        { ...params, action: spec.action, description: spec.describe(params), reason: spec.reason },
        {
          findExisting: async ({ orderId, refundId, action }) => {
            const existing = await tx.activityLog.findFirst({
              where: {
                entityType: 'SALES_ORDER',
                entityId: orderId,
                action,
                metadata: { path: ['refundId'], equals: refundId },
              },
              select: { id: true },
            })
            return existing != null
          },
          log: async (logParams) => tx.activityLog.create({
            data: {
              entityType: logParams.entityType,
              entityId: logParams.entityId,
              action: logParams.action,
              tag: logParams.tag,
              level: logParams.level,
              description: logParams.description,
              metadata: logParams.metadata as Prisma.InputJsonValue,
            },
          }),
        },
      )
    })
}

const defaultDrainDeps = (): RefundReservationReleaseDrainDeps => ({
  claimWork: claimIntegrationOutboxWork,
  // Lazy import: allocation lives in a server-action module; importing it eagerly
  // from a lib module pulls the action graph into unrelated callers.
  allocate: async (orderId, opts) => {
    const { autoAllocateOrder } = await import('@/app/actions/allocation')
    const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
    return autoAllocateOrder(orderId, {
      internalBypassToken: INTERNAL_ACTION_BYPASS,
      refuseIfShipmentsExist: true,
      onReconciledInTx: opts?.onReconciledInTx,
    })
  },
  markSuccess: markIntegrationOutboxSuccess,
  markRetry: markIntegrationOutboxRetryableFailure,
  logDeferral: lockedRefundWarningWriter({ action: DEFERRAL_WARNING_ACTION, reason: 'existing_shipment', describe: deferralDescription }),
})

export type RefundWarningWriteDeps = {
  /** True when a WARNING with this (action, refundId) is already durably persisted. */
  findExisting: (params: { orderId: string; refundId: string; action: string }) => Promise<boolean>
  log: (params: {
    entityType: 'SALES_ORDER'
    entityId: string
    action: string
    tag: string
    level: 'WARNING'
    description: string
    metadata: object
    resolveUser: false
  }) => Promise<unknown>
}

/**
 * Write an order-scoped refund WARNING at most once per (action, refund), idempotently and retryably: it writes
 * ONLY when no persisted WARNING for that (action, refundId) exists, so a swallowed write leaves no row and a
 * later attempt re-delivers, while an earlier success (from the immediate helper or a prior attempt) suppresses
 * a duplicate. CONCURRENCY: findExisting + log are separate ops, so strict at-most-once requires the caller to
 * run them atomically (the default writer wraps this in a per-refund advisory-lock transaction, Codex r7).
 */
export async function writeRefundWarningOnce(
  params: { orderId: string; refundId: string; action: string; description: string; reason: string },
  deps: RefundWarningWriteDeps,
): Promise<'written' | 'skipped'> {
  if (await deps.findExisting({ orderId: params.orderId, refundId: params.refundId, action: params.action })) return 'skipped'
  await deps.log({
    entityType: 'SALES_ORDER',
    entityId: params.orderId,
    action: params.action,
    tag: 'sales',
    level: 'WARNING',
    description: params.description,
    metadata: { orderId: params.orderId, refundId: params.refundId, reason: params.reason, source: 'drain' },
    resolveUser: false,
  })
  return 'written'
}

export type ProcessRefundReservationReleaseResult = { claimed: number; succeeded: number; failed: number }

/**
 * Drain pending reservation-release backstop jobs. Each job re-runs allocation for
 * the refunded order — idempotent, so a job whose reservation was already released
 * by the immediate attempt is a harmless no-op, and a job left behind by a bypass /
 * crash recovers. A job completes ONLY when allocation COMMITTED (a full release or a
 * committed backorder); a rollback, a pre-transaction bail, or a shipment refuse (which
 * does not touch the stale reservation) retries with backoff and dead-letters visibly
 * for shipment reconciliation (o3d-339) rather than being silently marked succeeded.
 */
export async function processRefundReservationReleaseOutbox(
  deps: RefundReservationReleaseDrainDeps = defaultDrainDeps(),
  limit = 50,
): Promise<ProcessRefundReservationReleaseResult> {
  const jobs = await deps.claimWork({
    connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    operation: REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
    workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER,
    limit,
    maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  })
  const result: ProcessRefundReservationReleaseResult = { claimed: jobs.length, succeeded: 0, failed: 0 }
  for (const job of jobs) {
    await processOneRefundReservationReleaseJob(job, deps, result)
  }
  return result
}

async function processOneRefundReservationReleaseJob(
  job: IntegrationOutboxRow,
  deps: RefundReservationReleaseDrainDeps,
  result: ProcessRefundReservationReleaseResult,
): Promise<void> {
  if (!job.lockedAt) { result.failed++; return }
  const lockedAt = job.lockedAt
  try {
    const payload = SalesRefundReservationReleaseOutboxPayloadSchema.parse(job.payloadJson)
    const warningParams = { orderId: payload.orderId, refundId: payload.refundId }
    // Mark this CLAIMED row SUCCEEDED INSIDE allocation's transaction (committed path only) so the release and
    // the PROCESSING→SUCCEEDED transition commit or roll back together — a crash can't leave the row PROCESSING
    // for stale-lock recovery to re-run the non-idempotent allocation (Codex review r12).
    const allocation = await deps.allocate(payload.orderId, {
      onReconciledInTx: async (tx) => {
        await deps.markSuccess({ id: job.id, workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER, lockedAt, client: tx })
      },
    })
    // The job is done ONLY when allocation COMMITTED (a full release or a committed backorder) — the only
    // outcome that reconciles reservedQty, and the only one where the in-tx hook marked the row SUCCEEDED. A
    // rollback (failed), a pre-transaction bail (no eligible warehouse), or a shipment REFUSE (which leaves the
    // stale reservation for o3d-339) must retry and dead-letter visibly (Codex review r3/r4).
    if (allocation.committed === true) {
      result.succeeded++
      return
    }
    if (allocation.refused === true) {
      try {
        await deps.logDeferral(warningParams)
      } catch (logError) {
        console.error('[refund] drain failed to record reservation-release deferral warning', logError)
      }
    }
    await deps.markRetry({
      id: job.id,
      workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER,
      lockedAt,
      error: new Error(
        allocation.refused === true
          ? 'reservation release refused: a shipment holds the units — needs shipment reconciliation (o3d-339)'
          : allocation.error ?? 'reservation release did not commit (no eligible warehouse or rolled back)',
      ),
      attemptsBeforeFailure: job.attempts,
      maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
    })
    result.failed++
  } catch (error) {
    await deps.markRetry({
      id: job.id,
      workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER,
      lockedAt,
      error,
      attemptsBeforeFailure: job.attempts,
      maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
    })
    result.failed++
  }
}

// ---------------------------------------------------------------------------
// Unmatched-refund-line WARNING drain (o3d-67y r10) — a SEPARATE row/duty so
// delivering the WARNING never re-runs the non-idempotent allocation.
// ---------------------------------------------------------------------------

export type RefundUnmatchedWarningDrainDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
  /** Deliver the unmatched-refund-line WARNING — idempotent, returns 'written'|'skipped'. */
  logUnmatched: (params: RefundWarningParams) => Promise<'written' | 'skipped'>
}

const defaultUnmatchedWarningDrainDeps = (): RefundUnmatchedWarningDrainDeps => ({
  claimWork: claimIntegrationOutboxWork,
  markSuccess: markIntegrationOutboxSuccess,
  markRetry: markIntegrationOutboxRetryableFailure,
  logUnmatched: lockedRefundWarningWriter({ action: UNMATCHED_WARNING_ACTION, reason: 'unmatched_refund_line', describe: unmatchedDescription }),
})

/**
 * Drain pending unmatched-refund-line WARNING rows. Each job idempotently delivers the order-scoped WARNING and
 * completes only once delivery is confirmed persisted (so a swallowed immediate write or a crash is recovered).
 * No allocation is ever run here — this row's sole duty is the durable operator signal (Codex review r10).
 */
export async function processRefundUnmatchedWarningOutbox(
  deps: RefundUnmatchedWarningDrainDeps = defaultUnmatchedWarningDrainDeps(),
  limit = 50,
): Promise<ProcessRefundReservationReleaseResult> {
  const jobs = await deps.claimWork({
    connector: REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
    operation: REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION,
    workerId: REFUND_UNMATCHED_WARNING_OUTBOX_WORKER,
    limit,
    maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
  })
  const result: ProcessRefundReservationReleaseResult = { claimed: jobs.length, succeeded: 0, failed: 0 }
  for (const job of jobs) {
    if (!job.lockedAt) { result.failed++; continue }
    const lockedAt = job.lockedAt
    try {
      const payload = SalesRefundUnmatchedWarningOutboxPayloadSchema.parse(job.payloadJson)
      await deps.logUnmatched({ orderId: payload.orderId, refundId: payload.refundId, refundOrderRef: payload.refundOrderRef })
      await deps.markSuccess({ id: job.id, workerId: REFUND_UNMATCHED_WARNING_OUTBOX_WORKER, lockedAt })
      result.succeeded++
    } catch (error) {
      await deps.markRetry({
        id: job.id,
        workerId: REFUND_UNMATCHED_WARNING_OUTBOX_WORKER,
        lockedAt,
        error,
        attemptsBeforeFailure: job.attempts,
        maxAttempts: DEFAULT_INTEGRATION_OUTBOX_MAX_ATTEMPTS,
      })
      result.failed++
    }
  }
  return result
}
