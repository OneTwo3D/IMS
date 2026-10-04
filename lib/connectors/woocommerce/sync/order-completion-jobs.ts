/**
 * THE DURABLE "COMPLETE THIS STOREFRONT ORDER" JOB (o3d-zvec.15, closes the o3d-ekujm window for completion).
 *
 * Pushing `completed` to WooCommerce used to be a fire-and-forget call made after the shipment committed.
 * A failure (a WooCommerce outage, an unreadable status) lost the completion for good: a retry finds the
 * order already SHIPPED and never tries again, and no sweep looks for a despatched order. So the intent is
 * written as an `integration_outbox` row INSIDE the transaction that flips the order to SHIPPED — it commits
 * with the flip or not at all — and is drained by the existing `shopping-webhook-inbox` cron, with one
 * immediate un-awaited attempt after the commit.
 *
 * EVERY ATTEMPT RE-READS WOOCOMMERCE (pushImsStatusToWc does a fresh GET and classifies it), so a retry never
 * resurrects an order an operator cancelled in the meantime, and a repeat after the status landed sends
 * nothing. TRACKING FIRST, then the status, so the completed email carries the tracking.
 *
 * Retry bound: 8 attempts. The outbox backs off 5, 10, 20, 40 then 60 minutes (capped, plus up to ~30 s of
 * jitter), so the row survives roughly four and a quarter hours of WooCommerce outage after the immediate
 * attempt before it dead-letters to /sync/exceptions, where Replay resets it and re-reads the store.
 */
import type { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  buildOutboxIdempotencyKey,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxClient,
} from '@/lib/domain/integrations/outbox'
import { wcOrderStatusClaimGate } from './order-status-claim-gate'
import { runWithWcAttemptFence, WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS } from '../attempt-fence'
import {
  INTEGRATION_OUTBOX_OPERATIONS,
  parseIntegrationOutboxPayload,
  type WcOrderCompletionOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'

const CONNECTOR = 'woocommerce'
const OPERATION = INTEGRATION_OUTBOX_OPERATIONS.woocommerce.orderComplete
const WORKER_ID = 'woocommerce-order-completion'
export const WC_ORDER_COMPLETION_MAX_ATTEMPTS = 8

type CompletionTxClient = (Prisma.TransactionClient | typeof db) & IntegrationOutboxClient

/** One row per flip to SHIPPED: a STRING epoch (a Date key part is truncated to the day), so a re-ship
 *  after a reopen gets a fresh row while a replayed transaction dedups to the same one. */
export function wcOrderCompletionIdempotencyKey(orderId: string, shippedAt: Date): string {
  return buildOutboxIdempotencyKey(CONNECTOR, OPERATION, orderId, String(shippedAt.getTime()))
}

/**
 * Enqueue the completion job on the TRANSACTION CLIENT of the shipment that completes the order. Returns the
 * idempotency key, or null when the order has no WooCommerce link (nothing to complete). Must be called
 * after the order lock is taken and before commit; it writes one outbox row and does no WooCommerce I/O.
 */
export async function scheduleWcOrderCompletion(
  tx: CompletionTxClient,
  input: { orderId: string; shippedAt: Date },
): Promise<string | null> {
  const link = await tx.shoppingOrderLink.findFirst({
    where: { orderId: input.orderId, connector: CONNECTOR },
    select: { id: true },
  })
  if (!link) return null
  const key = wcOrderCompletionIdempotencyKey(input.orderId, input.shippedAt)
  await enqueueIntegrationOutbox({
    connector: CONNECTOR,
    operation: OPERATION,
    idempotencyKey: key,
    payloadJson: { orderId: input.orderId } satisfies WcOrderCompletionOutboxPayload,
    nextAttemptAt: null,
  }, { client: tx })
  return key
}

export type WcOrderCompletionRunSummary = {
  claimed: number
  succeeded: number
  retried: number
  deadLettered: number
  skipped: number
  errors: string[]
}

/**
 * SURFACE (never re-drive) a completion whose worker died after claiming it.
 *
 * `woocommerce/order.complete` is `unsafe-to-replay` (the registry says why), so a PROCESSING row whose lock
 * has gone stale is never handed to a second worker automatically, and until now it stayed PROCESSING for ever
 * — never reaching PERMANENT_FAILED, so never on Sync > Exceptions. This moves exactly those rows (stale lock
 * past the drain lease) to PERMANENT_FAILED with a message that says what happened, using a compare-and-set on
 * the lock the dead worker took, so a worker that is merely slow and finishes in the meantime wins and the
 * park is a no-op.
 *
 * Why this is the safe recovery and an automatic re-drive is not: nothing proves whether the PUT landed. Why
 * Replay IS safe: it resets the row to PENDING and the next attempt re-reads WooCommerce first, so a PUT that
 * did land is `already-at-target` and sends nothing, and one that did not is simply made. PERMANENT_FAILED is
 * inert for this operation (the only enqueue is keyed per flip and returns the existing row untouched), unlike
 * the stock push, so the row stays put until an operator acts.
 */
export async function parkStaleWcOrderCompletionClaims(now: Date = new Date()): Promise<number> {
  const { db } = await import('@/lib/db')
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } = await import('@/lib/domain/integrations/outbox-leases')
  const staleBefore = new Date(now.getTime() - INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default)
  const stale = await db.integrationOutbox.findMany({
    where: { connector: CONNECTOR, operation: OPERATION, status: 'PROCESSING', lockedAt: { lt: staleBefore } },
    select: { id: true, lockedAt: true, lockedBy: true, payloadJson: true },
    take: 50,
  })
  let parked = 0
  for (const row of stale) {
    const result = await db.integrationOutbox.updateMany({
      where: { id: row.id, status: 'PROCESSING', lockedAt: row.lockedAt },
      data: {
        status: 'PERMANENT_FAILED',
        nextAttemptAt: null,
        lastError: 'The worker that claimed this completion stopped before recording a result, so it is not known whether WooCommerce was completed. Replay it: the retry re-reads the order first, so a completion that already landed is not sent again.',
        lockedAt: null,
        lockedBy: null,
        attempts: { increment: 1 },
      },
    })
    if (result.count === 0) continue
    parked++
    const orderId = (row.payloadJson as { orderId?: string } | null)?.orderId ?? 'unknown'
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_completion_dead_lettered', tag: 'sync', level: 'ERROR',
      description: `WooCommerce completion for order ${orderId} was claimed by a worker that never finished. Replay it from Sync exceptions; the replay re-reads the storefront order.`,
      resolveUser: false,
    }).catch(() => {})
  }
  return parked
}

export async function processWcOrderCompletionJobs(options?: {
  idempotencyKeys?: string[]
  limit?: number
  now?: Date
  /** Test seam: the attempt deadline. Production uses WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS. */
  attemptDeadlineMs?: number
}): Promise<WcOrderCompletionRunSummary> {
  const summary: WcOrderCompletionRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options?.idempotencyKeys?.length === 0) return summary
  const now = options?.now
  // The cron drain (no explicit keys) also surfaces claims whose worker died.
  if (!options?.idempotencyKeys) summary.deadLettered += await parkStaleWcOrderCompletionClaims(now ?? new Date())
  const jobs = await claimIntegrationOutboxWork({
    connector: CONNECTOR,
    operation: OPERATION,
    idempotencyKeys: options?.idempotencyKeys,
    limit: options?.limit ?? 25,
    workerId: WORKER_ID,
    maxAttempts: WC_ORDER_COMPLETION_MAX_ATTEMPTS,
    now,
    // One writer of an order's WooCommerce status at a time (order-status-claim-gate.ts, o3d-6ldlj).
    claimGate: wcOrderStatusClaimGate,
  })

  for (const job of jobs) {
    summary.claimed++
    if (!job.lockedAt) {
      summary.errors.push(`WooCommerce order-completion job ${job.id} was claimed without lockedAt`)
      continue
    }
    const claim = { id: job.id, workerId: WORKER_ID, lockedAt: job.lockedAt }

    let orderId: string
    try {
      orderId = parseIntegrationOutboxPayload<WcOrderCompletionOutboxPayload>({
        connector: CONNECTOR, operation: OPERATION, payloadJson: job.payloadJson, rowId: job.id,
      }).orderId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markIntegrationOutboxPermanentFailure({ ...claim, error: message })
      summary.deadLettered++
      summary.errors.push(message)
      continue
    }

    const retry = async (error: string) => {
      const row = await markIntegrationOutboxRetryableFailure({
        ...claim,
        error,
        attemptsBeforeFailure: job.attempts,
        maxAttempts: WC_ORDER_COMPLETION_MAX_ATTEMPTS,
        now,
      })
      const dead = row.status === 'PERMANENT_FAILED'
      if (dead) summary.deadLettered++
      else summary.retried++
      summary.errors.push(error)
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId,
        action: dead ? 'wc_completion_dead_lettered' : 'wc_completion_retry',
        tag: 'sync', level: dead ? 'ERROR' : 'WARNING',
        description: dead
          ? `WooCommerce completion for order ${orderId} gave up after ${WC_ORDER_COMPLETION_MAX_ATTEMPTS} attempts (${error}). Fix the cause, then Replay it from Sync exceptions; the replay re-reads the storefront order.`
          : `WooCommerce completion for order ${orderId} will be retried (attempt ${job.attempts + 1} of ${WC_ORDER_COMPLETION_MAX_ATTEMPTS}): ${error}`,
        resolveUser: false,
      }).catch(() => {})
    }

    try {
      // ONE FENCED ATTEMPT (attempt-fence.ts): a hard overall deadline over every WooCommerce request below,
      // and a pre-write check that this worker still owns its row. Returns the retry reason, or null when the
      // order is completed / deliberately left alone.
      const { db } = await import('@/lib/db')
      const deadlineMs = options?.attemptDeadlineMs ?? WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS
      const fence = {
        signal: AbortSignal.timeout(deadlineMs),
        stillOwned: async () => (await db.integrationOutbox.count({
          where: { id: job.id, status: 'PROCESSING', lockedBy: WORKER_ID, lockedAt: job.lockedAt },
        })) === 1,
      }
      const retryReason = await runWithWcAttemptFence(fence, async (): Promise<string | null> => {
        // The facade, not the connector: it owns "is a storefront connector runnable at all".
        const { pushOrderDeliveryMetadata, pushSalesOrderStatus } = await import('@/lib/shopping')

        // (a) Tracking FIRST so WooCommerce's completed email carries it. A failed or thrown tracking push is a
        // RETRYABLE OBLIGATION that blocks the completion PUT for this attempt: the customer email must not fire
        // without the tracking it promises. Tracking that is legitimately not there (no tracking number yet, an
        // unlinked order) comes back `skipped`, which is not a failure, so completion stays possible. A
        // tracking failure that outlasts the bound dead-letters like any other, for an operator to replay.
        let trackingError: string | null = null
        try {
          const tracking = await pushOrderDeliveryMetadata(orderId)
          if (!tracking.success && !tracking.skipped) trackingError = tracking.error ?? 'unknown error'
        } catch (thrown) {
          trackingError = thrown instanceof Error ? thrown.message : String(thrown)
        }
        if (trackingError !== null) {
          return `tracking push failed, completion held back so the customer email carries it: ${trackingError}`
        }

        // (b) The status, behind a fresh GET + eligibility classification on every attempt. The GET is made
        // immediately before the PUT inside pushImsStatusToWc. WooCommerce has no conditional update, so an
        // operator edit landing between those two requests can still be overwritten: an ACCEPTED, documented
        // inter-system race, the window kept as small as one round trip.
        const status = await pushSalesOrderStatus(orderId, 'SHIPPED')
        if (!status.success) {
          return status.error ?? 'WooCommerce status push failed'
        }
        // SUCCESS means the storefront is now complete or deliberately left alone, and nothing else: pushed,
        // already-at-target, or a finalised order (cancelled/refunded/completed by hand). A skipped result (no
        // runnable connector), `not-applicable`, a not-ready/unknown status, or no outcome at all is NOT success:
        // it stays retryable so that restoring the connector (or releasing the hold) can still complete the
        // order, and dead-letters visibly after the bound.
        const outcome = status.outcome
        if (status.skipped) {
          return 'no runnable WooCommerce connector (not configured or no credentials), so the order was not completed'
        }
        if (!outcome) {
          return 'the status push returned no outcome, so completion cannot be confirmed'
        }
        if (outcome?.kind === 'not-applicable') {
          return 'the order has no WooCommerce link or no pushable status, so it was not completed'
        }
        if (outcome?.kind === 'ineligible' && outcome.class !== 'finalised') {
          return `WooCommerce order is "${outcome.wcStatus}" (${outcome.class === 'unknown' ? 'a status IMS has no reading of; add a status mapping' : 'not ready to complete'}), not completed`
        }
        return null
      })
      if (retryReason !== null) {
        await retry(retryReason)
        continue
      }
      await markIntegrationOutboxSuccess(claim)
      summary.succeeded++
    } catch (error) {
      await retry(error instanceof Error ? error.message : String(error)).catch((markError) => {
        summary.errors.push(markError instanceof Error ? markError.message : String(markError))
      })
    }
  }
  return summary
}
