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

// Any allocated, not-yet-shipped order holds reservations a refund should release.
// Matches RELEASE_ELIGIBLE_STATUSES in post-refund-release.ts — PICKING/PACKING keep
// their allocations until dispatch (o3d-67y, Codex review r2); DRAFT / PENDING_PAYMENT
// (and terminal/shipped states) must never be promoted/reallocated by a refund.
const RELEASE_ELIGIBLE_STATUSES = new Set(['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'])

/** True when an order in this lifecycle status can hold reservations a refund should release. */
export function refundReleaseEligible(status: string): boolean {
  return RELEASE_ELIGIBLE_STATUSES.has(status)
}

export type ScheduleRefundReservationReleaseInput = {
  orderId: string
  refundId: string
  /** The order's lifecycle status AT REFUND TIME (read under the refund's order lock). */
  status: string
}

/**
 * Enqueue the durable reservation-release backstop — call INSIDE the
 * createSalesOrderRefund transaction so the outbox row commits atomically with the
 * refund. No-op for a non-release-eligible order. The idempotency key is per-refund
 * so a replayed refund dedups to a single backstop row.
 */
export async function scheduleRefundReservationReleaseOutbox(
  tx: Prisma.TransactionClient,
  input: ScheduleRefundReservationReleaseInput,
  options: { graceMs?: number; now?: Date } = {},
): Promise<void> {
  if (!refundReleaseEligible(input.status)) return
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
  // Set ONLY when the allocation transaction threw and rolled back (reservations
  // NOT mutated). A plain success:false — a shipment refuse or a committed
  // backorder/shortage — leaves reservations consistent and is a terminal outcome.
  failed?: boolean
}

export type RefundReservationReleaseDrainDeps = {
  claimWork: typeof claimIntegrationOutboxWork
  allocate: (orderId: string) => Promise<ReleaseAllocationResult>
  markSuccess: (options: Parameters<typeof markIntegrationOutboxSuccess>[0]) => Promise<unknown>
  markRetry: (options: Parameters<typeof markIntegrationOutboxRetryableFailure>[0]) => Promise<unknown>
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
})

export type ProcessRefundReservationReleaseResult = { claimed: number; succeeded: number; failed: number }

/**
 * Drain pending reservation-release backstop jobs. Each job re-runs allocation for
 * the refunded order — idempotent, so a job whose reservation was already released
 * by the immediate attempt is a harmless no-op, and a job left behind by a bypass /
 * crash recovers. Only a ROLLED-BACK allocation transaction (result.failed) retries
 * with exponential backoff; a shipment refuse or a committed backorder leaves the
 * reservation in a consistent state and completes the job.
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
    // Only a rolled-back allocation transaction stranded the reservation and must
    // retry. A plain success:false (shipment refuse / committed backorder) leaves
    // reservedQty consistent — the release either ran or is legitimately declined —
    // so the backstop's job is done.
    if (allocation.failed) {
      await deps.markRetry({
        id: job.id,
        workerId: REFUND_RESERVATION_RELEASE_OUTBOX_WORKER,
        lockedAt,
        error: new Error(allocation.error ?? 'reservation release transaction rolled back'),
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
