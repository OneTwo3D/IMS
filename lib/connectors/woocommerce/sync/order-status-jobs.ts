/**
 * THE DURABLE "CANCEL / HOLD THIS STOREFRONT ORDER" JOBS (o3d-6ldlj).
 *
 * Pushing `cancelled` / `on-hold` to WooCommerce used to be a fire-and-forget call made after the order
 * committed: a failed PUT was only logged and nothing retried it, and a failed GET was ignored so the PUT went
 * out BLIND — over an order WooCommerce already held as completed or refunded. Now, exactly as for
 * `woocommerce/order.complete` (order-completion-jobs.ts, which this mirrors and deliberately does NOT replace
 * in this change):
 *
 *   - the intent is an `integration_outbox` row written INSIDE the transaction that flips the order, under the
 *     order lock, so it commits with the flip or not at all;
 *   - one un-awaited attempt runs after the commit; the `shopping-webhook-inbox` cron retries and parks;
 *   - EVERY ATTEMPT is fenced (attempt-fence.ts) and re-reads BOTH systems: IMS first (an order that is no
 *     longer in the status being pushed is `superseded`: success with ZERO WooCommerce requests), then
 *     WooCommerce (pushImsStatusToWc: a failed read is a retry, never a blind PUT);
 *   - the result is mapped by a CLOSED switch (ending in `never`): the only successes are pushed,
 *     already-at-target, superseded and finalised.
 *
 * Two named operations share this one runner, parameterised by a descriptor. They are NOT one parameterised
 * operation: see the registry comment on `order.cancel`.
 *
 * Retry bound: 8 attempts on the outbox's default 5, 10, 20, 40, 60 minute back-off, then PERMANENT_FAILED on
 * Sync > Exceptions, where Replay resets the row and the next attempt re-reads everything.
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
  type WcOrderStatusOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'

const CONNECTOR = 'woocommerce'
export const WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS = 8

type StatusPushTxClient = (Prisma.TransactionClient | typeof db) & IntegrationOutboxClient

/** What one job kind pushes and how it talks about itself. Everything else is shared. */
export type WcOrderStatusJobDescriptor = {
  operation: 'order.cancel' | 'order.hold'
  workerId: string
  /** The IMS status the order must STILL be in for the write to be wanted. */
  imsTarget: 'CANCELLED' | 'ON_HOLD'
  /** The WooCommerce slug being pushed (text only: the connector derives it from `imsTarget`). */
  wcTarget: 'cancelled' | 'on-hold'
  noun: 'cancellation' | 'hold'
  retryAction: 'wc_cancel_retry' | 'wc_hold_retry'
  deadLetterAction: 'wc_cancel_dead_lettered' | 'wc_hold_dead_lettered'
}

export const WC_ORDER_CANCEL_JOB: WcOrderStatusJobDescriptor = {
  operation: INTEGRATION_OUTBOX_OPERATIONS.woocommerce.orderCancel,
  workerId: 'woocommerce-order-cancel',
  imsTarget: 'CANCELLED',
  wcTarget: 'cancelled',
  noun: 'cancellation',
  retryAction: 'wc_cancel_retry',
  deadLetterAction: 'wc_cancel_dead_lettered',
}

export const WC_ORDER_HOLD_JOB: WcOrderStatusJobDescriptor = {
  operation: INTEGRATION_OUTBOX_OPERATIONS.woocommerce.orderHold,
  workerId: 'woocommerce-order-hold',
  imsTarget: 'ON_HOLD',
  wcTarget: 'on-hold',
  noun: 'hold',
  retryAction: 'wc_hold_retry',
  deadLetterAction: 'wc_hold_dead_lettered',
}

const DESCRIPTORS = [WC_ORDER_CANCEL_JOB, WC_ORDER_HOLD_JOB] as const

/** A scheduled job: enough for the post-commit attempt to name it. */
export type WcOrderStatusJobRef = { operation: WcOrderStatusJobDescriptor['operation']; key: string }

/**
 * One row per FLIP: a STRING epoch (a Date key part is truncated to the day), so hold -> release -> hold is two
 * rows while a replayed transaction dedups to one. PERMANENT_FAILED stays inert because the only enqueuer is
 * keyed per flip and returns the existing row untouched.
 */
export function wcOrderStatusPushIdempotencyKey(
  descriptor: Pick<WcOrderStatusJobDescriptor, 'operation'>,
  orderId: string,
  flippedAt: Date,
): string {
  return buildOutboxIdempotencyKey(CONNECTOR, descriptor.operation, orderId, String(flippedAt.getTime()))
}

/**
 * Enqueue the job on the TRANSACTION CLIENT of the transition that cancels / holds the order. Returns the job's
 * reference, or null when the order has no WooCommerce link. Must be called after the order lock is taken and
 * before commit; it writes one outbox row and does no WooCommerce I/O and no pooled query. Whether a runnable
 * connector exists is decided when the job DRAINS, not here.
 */
async function scheduleWcOrderStatusPush(
  descriptor: WcOrderStatusJobDescriptor,
  tx: StatusPushTxClient,
  input: { orderId: string; flippedAt: Date },
): Promise<WcOrderStatusJobRef | null> {
  const link = await tx.shoppingOrderLink.findFirst({
    where: { orderId: input.orderId, connector: CONNECTOR },
    select: { id: true },
  })
  if (!link) return null
  const key = wcOrderStatusPushIdempotencyKey(descriptor, input.orderId, input.flippedAt)
  await enqueueIntegrationOutbox({
    connector: CONNECTOR,
    operation: descriptor.operation,
    idempotencyKey: key,
    payloadJson: { orderId: input.orderId } satisfies WcOrderStatusOutboxPayload,
    nextAttemptAt: null,
  }, { client: tx })
  return { operation: descriptor.operation, key }
}

export function scheduleWcOrderCancel(tx: StatusPushTxClient, input: { orderId: string; flippedAt: Date }) {
  return scheduleWcOrderStatusPush(WC_ORDER_CANCEL_JOB, tx, input)
}

export function scheduleWcOrderHold(tx: StatusPushTxClient, input: { orderId: string; flippedAt: Date }) {
  return scheduleWcOrderStatusPush(WC_ORDER_HOLD_JOB, tx, input)
}

export type WcOrderStatusRunSummary = {
  claimed: number
  succeeded: number
  retried: number
  deadLettered: number
  skipped: number
  errors: string[]
}

export type WcOrderStatusRunOptions = {
  idempotencyKeys?: string[]
  limit?: number
  now?: Date
  /** Test seam: the attempt deadline. Production uses WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS. */
  attemptDeadlineMs?: number
}

/**
 * SURFACE (never re-drive) a cancel/hold whose worker died after claiming it.
 *
 * Both operations are `unsafe-to-replay`, so a PROCESSING row whose lock has gone stale is never handed to a
 * second worker automatically. Left alone it would stay PROCESSING for ever and never reach Sync > Exceptions.
 * This moves exactly those rows (stale lock past the drain lease) to PERMANENT_FAILED using a compare-and-set
 * on the lock the dead worker took, so a worker that is merely slow and finishes first wins and the park is a
 * no-op.
 *
 * THE MESSAGE IS ABOUT WHAT IS KNOWN: the dead worker may have sent the PUT or not, and nothing records which.
 * It must never say "nothing was sent". Replay is safe because the retry re-reads IMS and WooCommerce first, so
 * a push that did land is `already-at-target` and sends nothing more.
 */
export async function parkStaleWcOrderStatusClaims(
  now: Date = new Date(),
  descriptors: readonly WcOrderStatusJobDescriptor[] = DESCRIPTORS,
): Promise<number> {
  const { db } = await import('@/lib/db')
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } = await import('@/lib/domain/integrations/outbox-leases')
  const staleBefore = new Date(now.getTime() - INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default)
  let parked = 0
  for (const descriptor of descriptors) {
    const stale = await db.integrationOutbox.findMany({
      where: { connector: CONNECTOR, operation: descriptor.operation, status: 'PROCESSING', lockedAt: { lt: staleBefore } },
      select: { id: true, lockedAt: true, lockedBy: true, payloadJson: true },
      take: 50,
    })
    for (const row of stale) {
      const result = await db.integrationOutbox.updateMany({
        where: { id: row.id, status: 'PROCESSING', lockedAt: row.lockedAt },
        data: {
          status: 'PERMANENT_FAILED',
          nextAttemptAt: null,
          lastError: `The worker that claimed this ${descriptor.noun} stopped before recording a result. It is NOT known whether WooCommerce changed: the status write may or may not have been sent. Check the WooCommerce order, then Replay: the retry re-reads the IMS order and the WooCommerce order first, so a ${descriptor.noun} that already landed is not sent again.`,
          lockedAt: null,
          lockedBy: null,
          attempts: { increment: 1 },
        },
      })
      if (result.count === 0) continue
      parked++
      const orderId = (row.payloadJson as { orderId?: string } | null)?.orderId ?? 'unknown'
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: descriptor.deadLetterAction, tag: 'sync', level: 'ERROR',
        description: `The WooCommerce ${descriptor.noun} push for order ${orderId} was claimed by a worker that never recorded a result, so it is not known whether WooCommerce was changed. Check the storefront order, then Replay it from Sync exceptions; the replay re-reads both systems first.`,
        resolveUser: false,
      }).catch(() => {})
    }
  }
  return parked
}

/** What one attempt decided. The runner turns it into a row transition. */
type AttemptVerdict =
  | { kind: 'done' }
  | { kind: 'retry'; reason: string }
  | { kind: 'needs-operator'; reason: string }

async function readImsStatus(orderId: string): Promise<string | null> {
  const { db } = await import('@/lib/db')
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
  return order?.status ?? null
}

/**
 * ONE ATTEMPT, inside the fence. IMS first, then WooCommerce through the facade, then the closed result switch.
 */
async function attemptWcOrderStatusPush(descriptor: WcOrderStatusJobDescriptor, orderId: string): Promise<AttemptVerdict> {
  // (1) IMS RE-READ. The row says what IMS WANTED when it committed, not what it wants now: a hold released or
  // cancelled in the meantime must not be pushed. Superseded is a SUCCESS and touches WooCommerce not at all.
  const imsStatus = await readImsStatus(orderId)
  if (imsStatus !== descriptor.imsTarget) {
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_status_push_superseded', tag: 'sync', level: 'INFO',
      description: imsStatus === null
        ? `The WooCommerce ${descriptor.noun} push for order ${orderId} was dropped: the order no longer exists in IMS. This attempt sent nothing to WooCommerce.`
        : `The WooCommerce ${descriptor.noun} push for order ${orderId} was dropped: the order is now ${imsStatus} in IMS, not ${descriptor.imsTarget}. This attempt sent nothing to WooCommerce.`,
      resolveUser: false,
    }).catch(() => {})
    return { kind: 'done' }
  }

  // (2) The facade, not the connector: it owns "is a storefront connector runnable at all". It reads WooCommerce
  // and classifies (pushImsStatusToWc); the PUT is behind assertWcAttemptMayWrite.
  const { pushSalesOrderStatus } = await import('@/lib/shopping')
  const status = await pushSalesOrderStatus(orderId, descriptor.imsTarget)
  if (!status.success) return { kind: 'retry', reason: status.error ?? 'WooCommerce status push failed' }
  if (status.skipped) {
    return { kind: 'retry', reason: `no runnable WooCommerce connector (not configured or no credentials), so the ${descriptor.noun} was not pushed` }
  }
  const outcome = status.outcome
  if (!outcome) return { kind: 'retry', reason: `the status push returned no outcome, so the ${descriptor.noun} cannot be confirmed` }

  // (3) THE CLOSED RESULT SWITCH. Success is exactly: pushed, already at the target, or a finalised order left
  // alone. Everything else retries (and dead-letters visibly after the bound) or needs an operator.
  switch (outcome.kind) {
    case 'pushed': {
      // CONVERGENCE: the write succeeded, but IMS may have moved on while it was in flight (a hold released or
      // cancelled). Reporting done would leave WooCommerce on a status IMS no longer wants with nothing to say so.
      // Retry instead: the next attempt re-reads IMS (superseded) and, per order, the job for the LATEST intent
      // reads WooCommerce afresh and writes it.
      const after = await readImsStatus(orderId)
      if (after !== descriptor.imsTarget) {
        return { kind: 'retry', reason: `the ${descriptor.noun} was written, but the IMS order is now ${after ?? 'gone'}, not ${descriptor.imsTarget}; WooCommerce is being re-checked for the latest status` }
      }
      return { kind: 'done' }
    }
    case 'already-at-target':
      return { kind: 'done' }
    case 'unconfirmed':
      // The store answered 200 but did not hold the requested status: NOT done. The next attempt re-reads it.
      return { kind: 'retry', reason: outcome.error }
    case 'not-applicable':
      return { kind: 'retry', reason: `the order has no WooCommerce link or no pushable status, so the ${descriptor.noun} was not pushed` }
    case 'read-failed':
    case 'write-failed':
    case 'error':
      return { kind: 'retry', reason: outcome.error }
    case 'ineligible':
      switch (outcome.class) {
        case 'finalised':
          // Left alone on purpose: IMS must not overwrite a settled storefront order. A WARNING, NOT an exception.
          await logActivity({
            entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_status_push_left_alone', tag: 'sync', level: 'WARNING',
            description: `IMS ${descriptor.imsTarget === 'CANCELLED' ? 'cancelled' : 'held'} order ${orderId} but the WooCommerce order is "${outcome.wcStatus}", which IMS never overwrites, so this attempt did not push the ${descriptor.noun} and did not change WooCommerce. Check whether the two systems should agree.`,
            resolveUser: false,
          }).catch(() => {})
          return { kind: 'done' }
        case 'needs-operator':
          return {
            kind: 'needs-operator',
            reason: `IMS did not push the ${descriptor.noun} to this WooCommerce order because ${outcome.detail ?? `its status is "${outcome.wcStatus}"`}. IMS never pushes a ${descriptor.noun} over that automatically and this attempt did not change WooCommerce: decide what the ${descriptor.noun} should mean for that order in the storefront and apply it there. Replay only re-checks the order.`,
          }
        case 'unknown':
          return { kind: 'retry', reason: `WooCommerce order is "${outcome.wcStatus}", a status IMS has no reading of; add a status mapping for it, then the ${descriptor.noun} can be pushed` }
        case 'not-ready':
          return { kind: 'retry', reason: `WooCommerce order is "${outcome.wcStatus}", not in a state the ${descriptor.noun} can be pushed over` }
        default: {
          const unhandled: never = outcome.class
          throw new Error(`unhandled ineligible class ${String(unhandled)}`)
        }
      }
    default: {
      const unhandled: never = outcome
      throw new Error(`unhandled status push outcome ${JSON.stringify(unhandled)}`)
    }
  }
}

/**
 * The shared runner: claim this operation's rows and run one fenced attempt for each. Never throws for a job's
 * own failure.
 */
export async function runFencedWcOrderJob(
  descriptor: WcOrderStatusJobDescriptor,
  options: WcOrderStatusRunOptions = {},
): Promise<WcOrderStatusRunSummary> {
  const summary: WcOrderStatusRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options.idempotencyKeys?.length === 0) return summary
  const now = options.now
  const jobs = await claimIntegrationOutboxWork({
    connector: CONNECTOR,
    operation: descriptor.operation,
    idempotencyKeys: options.idempotencyKeys,
    limit: options.limit ?? 25,
    workerId: descriptor.workerId,
    maxAttempts: WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS,
    now,
    // ONE WRITER OF AN ORDER'S WOOCOMMERCE STATUS AT A TIME (order-status-claim-gate.ts): a cancel waits for a hold
    // PUT that is in flight instead of racing it.
    claimGate: wcOrderStatusClaimGate,
  })

  for (const job of jobs) {
    summary.claimed++
    if (!job.lockedAt) {
      summary.errors.push(`WooCommerce ${descriptor.noun} job ${job.id} was claimed without lockedAt`)
      continue
    }
    const claim = { id: job.id, workerId: descriptor.workerId, lockedAt: job.lockedAt }

    let orderId: string
    try {
      orderId = parseIntegrationOutboxPayload<WcOrderStatusOutboxPayload>({
        connector: CONNECTOR, operation: descriptor.operation, payloadJson: job.payloadJson, rowId: job.id,
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
        maxAttempts: WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS,
        now,
      })
      const dead = row.status === 'PERMANENT_FAILED'
      if (dead) summary.deadLettered++
      else summary.retried++
      summary.errors.push(error)
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId,
        action: dead ? descriptor.deadLetterAction : descriptor.retryAction,
        tag: 'sync', level: dead ? 'ERROR' : 'WARNING',
        description: dead
          ? `The WooCommerce ${descriptor.noun} push for order ${orderId} gave up after ${WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS} attempts (${error}). WooCommerce may not reflect the ${descriptor.noun}. Fix the cause, then Replay it from Sync exceptions; the replay re-reads both systems first.`
          : `The WooCommerce ${descriptor.noun} push for order ${orderId} will be retried (attempt ${job.attempts + 1} of ${WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS}): ${error}`,
        resolveUser: false,
      }).catch(() => {})
    }

    try {
      const { db } = await import('@/lib/db')
      const fence = {
        signal: AbortSignal.timeout(options.attemptDeadlineMs ?? WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS),
        stillOwned: async () => (await db.integrationOutbox.count({
          where: { id: job.id, status: 'PROCESSING', lockedBy: descriptor.workerId, lockedAt: job.lockedAt },
        })) === 1,
        // The re-read the PUT is gated on, as close to the write as the fence allows.
        stillWanted: async () => (await readImsStatus(orderId)) === descriptor.imsTarget,
      }
      const verdict = await runWithWcAttemptFence(fence, () => attemptWcOrderStatusPush(descriptor, orderId))
      switch (verdict.kind) {
        case 'done':
          await markIntegrationOutboxSuccess(claim)
          summary.succeeded++
          break
        case 'retry':
          await retry(verdict.reason)
          break
        case 'needs-operator': {
          // A stable refusal, not a transient failure: retrying cannot change it, so it goes straight to the
          // exception inbox rather than burning the retry window.
          await markIntegrationOutboxPermanentFailure({ ...claim, error: verdict.reason })
          summary.deadLettered++
          summary.errors.push(verdict.reason)
          await logActivity({
            entityType: 'SALES_ORDER', entityId: orderId, action: descriptor.deadLetterAction, tag: 'sync', level: 'ERROR',
            description: `The WooCommerce ${descriptor.noun} push for order ${orderId} needs an operator: ${verdict.reason}`,
            resolveUser: false,
          }).catch(() => {})
          break
        }
        default: {
          const unhandled: never = verdict
          throw new Error(`unhandled attempt verdict ${JSON.stringify(unhandled)}`)
        }
      }
    } catch (error) {
      await retry(error instanceof Error ? error.message : String(error)).catch((markError) => {
        summary.errors.push(markError instanceof Error ? markError.message : String(markError))
      })
    }
  }
  return summary
}

export const processWcOrderCancelJobs = (options?: WcOrderStatusRunOptions) => runFencedWcOrderJob(WC_ORDER_CANCEL_JOB, options)
export const processWcOrderHoldJobs = (options?: WcOrderStatusRunOptions) => runFencedWcOrderJob(WC_ORDER_HOLD_JOB, options)

/**
 * Both operations: the post-commit attempt (with keys) and the cron drain (without). The drain also surfaces
 * claims whose worker died.
 */
export async function processWcOrderStatusJobs(options: WcOrderStatusRunOptions = {}): Promise<WcOrderStatusRunSummary> {
  const total: WcOrderStatusRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options.idempotencyKeys?.length === 0) return total
  if (!options.idempotencyKeys) total.deadLettered += await parkStaleWcOrderStatusClaims(options.now ?? new Date())
  for (const descriptor of DESCRIPTORS) {
    const part = await runFencedWcOrderJob(descriptor, options)
    total.claimed += part.claimed
    total.succeeded += part.succeeded
    total.retried += part.retried
    total.deadLettered += part.deadLettered
    total.skipped += part.skipped
    total.errors.push(...part.errors)
  }
  return total
}
