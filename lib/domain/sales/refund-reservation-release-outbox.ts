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
import { SalesRefundReservationReleaseOutboxPayloadSchema } from '@/lib/domain/integrations/outbox-registry'

type OutboxUpdateClient = {
  integrationOutbox: { updateMany(args: unknown): Promise<{ count: number }> }
}

export const REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR = 'sales'
export const REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION = 'refund.reservation-release'
const REFUND_RESERVATION_RELEASE_OUTBOX_WORKER = 'refund-reservation-release-drain'

// Delay the backstop drain past the immediate post-commit release so the drain
// never races it: by the next cron tick the immediate call has already released
// the reservation, so the drain's re-allocation is an idempotent no-op. A crash /
// bypass that lost the immediate call is still recovered on a following tick.
const DEFAULT_DRAIN_GRACE_MS = 120_000

export type ScheduleRefundReservationReleaseInput = {
  orderId: string
  refundId: string
  /**
   * Whether the order holds stock reservations to release — derived from persisted OrderAllocation rows under
   * the refund's order lock, NOT from lifecycle status (an ON_HOLD / PICKING / PACKING order can still hold
   * allocations; a never-allocated order holds none). Codex review r3.
   */
  eligible: boolean
}

/**
 * Enqueue the durable reservation-release backstop — call INSIDE the
 * createSalesOrderRefund transaction so the outbox row commits atomically with the
 * refund. No-op when the order holds no allocations. The idempotency key is per-refund
 * so a replayed refund dedups to a single backstop row.
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

/**
 * Mark the backstop row for this refund SUCCEEDED after the IMMEDIATE post-refund
 * release reconciled the reservation, so the cron drain does NOT re-run allocation.
 * Re-running allocation is not side-effect-idempotent (it deletes/recreates
 * OrderAllocation rows and resets staged allocation accounting), so once the
 * immediate attempt has released, the durable backstop's work is done (Codex review
 * r2). Only resolves a still-open (PENDING / RETRYABLE_FAILED) row — a row the drain
 * has already claimed (PROCESSING) or finished is left untouched. Best-effort: if this
 * fails, the drain re-runs the (numerically idempotent) release on the next tick.
 */
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
      status: { in: [INTEGRATION_OUTBOX_STATUS.PENDING, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED] },
    },
    data: { status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED, lockedAt: null, lockedBy: null },
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

export type RefundReservationReleaseDrainDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  allocate: (orderId: string) => Promise<ReleaseAllocationResult>
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
  /** Record an order-scoped deferral WARNING (o3d-67y r5) — best-effort, must never throw into the drain. */
  logDeferral: (params: { orderId: string; refundId: string }) => Promise<unknown>
}

const defaultDrainDeps = (): RefundReservationReleaseDrainDeps => ({
  claimWork: claimIntegrationOutboxWork,
  // Lazy import: allocation lives in a server-action module; importing it eagerly
  // from a lib module pulls the action graph into unrelated callers.
  allocate: async (orderId) => {
    const { autoAllocateOrder } = await import('@/app/actions/allocation')
    const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
    return autoAllocateOrder(orderId, {
      internalBypassToken: INTERNAL_ACTION_BYPASS,
      refuseIfShipmentsExist: true,
    })
  },
  markSuccess: markIntegrationOutboxSuccess,
  markRetry: markIntegrationOutboxRetryableFailure,
  logDeferral: async (params) =>
    writeRefundReleaseDeferralWarningOnce(params, {
      // Confirm PERSISTENCE (not logActivity's swallowed success) so delivery is retryable — if the write never
      // landed, no row exists and a later drain attempt writes it (Codex review r6).
      findExisting: async ({ orderId, refundId }) => {
        const existing = await db.activityLog.findFirst({
          where: {
            entityType: 'SALES_ORDER',
            entityId: orderId,
            action: DEFERRAL_WARNING_ACTION,
            metadata: { path: ['refundId'], equals: refundId },
          },
          select: { id: true },
        })
        return existing != null
      },
      log: async (logParams) => {
        const { logActivity } = await import('@/lib/activity-log')
        return logActivity(logParams)
      },
    }),
})

export const DEFERRAL_WARNING_ACTION = 'refund_reservation_release_deferred'

export type DeferralWarningDeps = {
  /** True when a deferral WARNING for this refund is already durably persisted. */
  findExisting: (params: { orderId: string; refundId: string }) => Promise<boolean>
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
 * Write the order-scoped reservation-release deferral WARNING at most once per refund, idempotently and
 * retryably: it writes ONLY when no persisted WARNING for the refund exists, so a swallowed logActivity failure
 * leaves no row and a later drain attempt re-attempts delivery, while a successful earlier write (from the
 * immediate helper or a prior drain attempt) suppresses a duplicate. The caller invokes this on EVERY refused
 * drain attempt — the persistence check, not an attempt counter, provides the once-only guarantee (Codex r6).
 */
export async function writeRefundReleaseDeferralWarningOnce(
  params: { orderId: string; refundId: string },
  deps: DeferralWarningDeps,
): Promise<'written' | 'skipped'> {
  if (await deps.findExisting(params)) return 'skipped'
  await deps.log({
    entityType: 'SALES_ORDER',
    entityId: params.orderId,
    action: DEFERRAL_WARNING_ACTION,
    tag: 'sales',
    level: 'WARNING',
    description: `Refund on order ${params.orderId} could not release its stock reservation because a shipment already exists (recovered by the durable backstop). The refunded units may still be reserved; verify the pending shipment nets the refund so they are neither stranded-reserved nor dispatched.`,
    metadata: { orderId: params.orderId, refundId: params.refundId, reason: 'existing_shipment', source: 'drain' },
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
    const allocation = await deps.allocate(payload.orderId)
    // The job is done ONLY when the allocation transaction COMMITTED (a full release or a committed backorder) —
    // that is the only outcome that actually reconciles reservedQty. Everything else must retry with backoff and
    // dead-letter visibly rather than be silently marked succeeded (Codex review r3/r4):
    //   - a rolled-back transaction (failed) or a pre-transaction bail (no eligible warehouse) did not run;
    //   - a shipment REFUSE declines without touching the stale OrderAllocation rows, so a partially-shipped
    //     order (alloc 5, ship 3, refund 2) keeps 2 units reserved — the residual is left as a durable
    //     dead-letter for shipment reconciliation (o3d-339), NEVER marked SUCCEEDED.
    // Eligibility is gated on residual OrderAllocation rows, so a fully-dispatched order never enqueues a row,
    // which bounds refused dead-letters to the genuine strand population.
    const reconciled = allocation.committed === true
    if (!reconciled) {
      // If the immediate helper was bypassed (crash / post-commit throw) — the exact case this backstop exists
      // to recover — a refuse here would otherwise dead-letter with only generic outbox health and no
      // order-scoped signal. logDeferral is idempotent+retryable (it writes only when no persisted WARNING for
      // the refund exists), so calling it on EVERY refused attempt delivers the warning at-most-once without
      // depending on a single attempt's swallowed log succeeding (Codex review r6). Best-effort — a logging
      // failure must not derail the retry.
      if (allocation.refused === true) {
        try {
          await deps.logDeferral({ orderId: payload.orderId, refundId: payload.refundId })
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
      return
    }
    await deps.markSuccess({ id: job.id, workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER, lockedAt })
    result.succeeded++
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
