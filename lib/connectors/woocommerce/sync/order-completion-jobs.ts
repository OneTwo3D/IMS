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

export async function processWcOrderCompletionJobs(options?: {
  idempotencyKeys?: string[]
  limit?: number
  now?: Date
}): Promise<WcOrderCompletionRunSummary> {
  const summary: WcOrderCompletionRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options?.idempotencyKeys?.length === 0) return summary
  const now = options?.now
  const jobs = await claimIntegrationOutboxWork({
    connector: CONNECTOR,
    operation: OPERATION,
    idempotencyKeys: options?.idempotencyKeys,
    limit: options?.limit ?? 25,
    workerId: WORKER_ID,
    maxAttempts: WC_ORDER_COMPLETION_MAX_ATTEMPTS,
    now,
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
      // The facade, not the connector: it owns "is a storefront connector runnable at all".
      const { pushOrderDeliveryMetadata, pushSalesOrderStatus } = await import('@/lib/shopping')

      // (a) Tracking FIRST so WooCommerce's completed email carries it. A tracking failure does not hold
      // the status back (the completion matters more than the meta, and the two are written independently).
      try {
        const tracking = await pushOrderDeliveryMetadata(orderId)
        if (!tracking.success) console.warn('[order-completion] tracking push failed', tracking.error)
      } catch (trackingError) {
        console.warn('[order-completion] tracking push threw', trackingError)
      }

      // (b) The status, behind a fresh GET + eligibility classification on every attempt.
      const status = await pushSalesOrderStatus(orderId, 'SHIPPED')
      if (!status.success) {
        await retry(status.error ?? 'WooCommerce status push failed')
        continue
      }
      const outcome = status.outcome
      if (outcome?.kind === 'ineligible' && outcome.class !== 'finalised') {
        await retry(`WooCommerce order is "${outcome.wcStatus}" (${outcome.class === 'unknown' ? 'a status IMS has no reading of; add a status mapping' : 'not ready to complete'}), not completed`)
        continue
      }
      await markIntegrationOutboxSuccess(claim)
      if (status.skipped) summary.skipped++
      else summary.succeeded++
    } catch (error) {
      await retry(error instanceof Error ? error.message : String(error)).catch((markError) => {
        summary.errors.push(markError instanceof Error ? markError.message : String(markError))
      })
    }
  }
  return summary
}
