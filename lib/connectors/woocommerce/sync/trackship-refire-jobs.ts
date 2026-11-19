/**
 * THE TRACKSHIP RE-FIRE SWEEP (see trackship-refire.ts for what is asked of the storefront, and why).
 *
 *   - OFF BY DEFAULT: nothing is scanned, queued, claimed or sent unless the setting `trackship_refire_enabled` is `true`;
 *   - the scan finds shipped, tracked storefront orders inside the re-fire window (7 days from despatch) and gives each ONE durable state row
 *     (`trackship_refire_states`): how many looks it has had and when the next is due. The first look is due an hour after despatch, which is
 *     long enough for TrackShip's own trigger to have done its work;
 *   - an order whose look is due is queued as one outbox job through the producer seam: with the producer-side hold on the job is a SHADOW (a
 *     record, no row, nothing sent), and its state does not advance;
 *   - BACK-OFF IS PER ORDER AND DURABLE: every look moves `nextAttemptAt` out by 5 min, 10, 20, 40 ... doubling, capped at 24 h (the plugin's
 *     numbers); a look that fired TrackShip waits at least an hour for TrackShip's background job. The order leaves the sweep when the
 *     storefront reports it covered (COVERED) or the window closes (EXPIRED);
 *   - the drain claims nothing while the hold stands, and every attempt is fenced (deadline, row ownership, the writer-side cut-off, and that the
 *     switch is still on and the order still wanted), re-reads IMS and the state, and writes through the one transport behind the egress barrier;
 *   - a held, refused or failed write is a RETRY, never a success; the only successes are the storefront's own answers (covered, fired, not
 *     eligible, no tracking, order gone) and an order the sweep no longer wants.
 *
 * Retry bound for a failed TRANSPORT: 8 attempts on the outbox's default back-off, then PERMANENT_FAILED on Sync > Exceptions, where Replay resets
 * the row and the next attempt re-reads everything.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  buildOutboxIdempotencyKey,
  claimIntegrationOutboxWork,
  enqueueIntegrationOutbox,
  isOutboxEnqueueShadowed,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  currentOutboxRowBeforeCutoff,
  refuseClaimedJobBeforeCutoff,
  type IntegrationOutboxClient,
} from '@/lib/domain/integrations/outbox'
import { WC_DRAIN_CLAIM_BUDGET_MS, WC_DRAIN_SCAN_WINDOW } from './order-status-claim-gate'
import { runWithWcAttemptFence, WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS } from '../attempt-fence'
import { createWriteLedger, runInWriteLedger } from '@/lib/security/write-ledger'
import { wooDrainHold } from '../producer-egress'
import {
  INTEGRATION_OUTBOX_OPERATIONS,
  parseIntegrationOutboxPayload,
  type WcTrackshipRefireOutboxPayload,
} from '@/lib/domain/integrations/outbox-registry'
import {
  TRACKSHIP_REFIRE_ALERT_ATTEMPTS,
  TRACKSHIP_REFIRE_BACKOFF_BASE_MS,
  TRACKSHIP_REFIRE_PENDING_GRACE_MS,
  TRACKSHIP_REFIRE_WINDOW_MS,
  isTrackshipRefireEnabled,
  postTrackshipRefire,
  trackshipRefireBackoffMs,
} from './trackship-refire'

const CONNECTOR = 'woocommerce'
const OPERATION = INTEGRATION_OUTBOX_OPERATIONS.woocommerce.trackshipRefire
const WORKER_ID = 'woocommerce-trackship-refire'
export const WC_TRACKSHIP_REFIRE_MAX_ATTEMPTS = 8
/** Orders looked at per tick (new candidates registered, and due looks queued). */
export const WC_TRACKSHIP_REFIRE_QUEUE_LIMIT = 25

/** What the status of a shipped order must be for TrackShip to hold a shipment for it. */
const SHIPPED_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const

type RefireTxClient = (Prisma.TransactionClient | typeof db) & IntegrationOutboxClient

/** One job per (order, look): a repeat scan, or a replayed transaction, dedups to the same row. */
export function wcTrackshipRefireIdempotencyKey(orderId: string, attempt: number): string {
  return buildOutboxIdempotencyKey(CONNECTOR, OPERATION, orderId, String(attempt))
}

export type WcTrackshipRefireScanSummary = {
  /** New orders given a state row this tick. */
  registered: number
  /** Orders whose window closed (or that have no storefront link any more): no more looks. */
  expired: number
  /** Looks queued as a job. */
  queued: number
  /** Looks the producer-side hold kept as a shadow (nothing queued, nothing sent). */
  shadowed: number
  /** Looks not queued because an earlier job for the order is still queued, running or retrying. */
  inFlight: number
}

/** The despatch time the window is measured from: the order's own, else its latest shipped shipment's. Null when there is none. */
function despatchedAt(order: { shippedAt: Date | null; shipments: Array<{ shippedAt: Date | null }> }): Date | null {
  const times = [order.shippedAt, ...order.shipments.map((shipment) => shipment.shippedAt)].filter((value): value is Date => value instanceof Date)
  if (times.length === 0) return null
  return new Date(Math.max(...times.map((value) => value.getTime())))
}

/**
 * REGISTER the shipped, tracked storefront orders that have no state row yet, then EXPIRE the rows whose window has closed. Orders only: no
 * storefront call. The first look is due an hour after despatch.
 */
async function registerCandidates(now: Date, limit: number, orderIds?: string[]): Promise<{ registered: number }> {
  const windowStart = new Date(now.getTime() - TRACKSHIP_REFIRE_WINDOW_MS)
  const candidates = await db.salesOrder.findMany({
    where: {
      ...(orderIds ? { id: { in: orderIds } } : {}),
      status: { in: [...SHIPPED_STATUSES] },
      erasedAt: null,
      shoppingLinks: { some: { connector: CONNECTOR } },
      trackshipRefireState: { is: null },
      AND: [
        { OR: [{ trackingNumber: { not: null } }, { shipments: { some: { status: 'SHIPPED', trackingNumber: { not: null } } } }] },
        { OR: [{ shippedAt: { gte: windowStart } }, { shipments: { some: { status: 'SHIPPED', shippedAt: { gte: windowStart } } } }] },
      ],
    },
    select: { id: true, shippedAt: true, shipments: { where: { status: 'SHIPPED' }, select: { shippedAt: true } } },
    orderBy: { shippedAt: 'asc' },
    take: limit,
  })
  if (candidates.length === 0) return { registered: 0 }
  const { count } = await db.trackshipRefireState.createMany({
    data: candidates.map((order) => {
      const shipped = despatchedAt(order) ?? now
      const firstLook = new Date(shipped.getTime() + TRACKSHIP_REFIRE_PENDING_GRACE_MS)
      return { orderId: order.id, nextAttemptAt: firstLook.getTime() > now.getTime() ? firstLook : now }
    }),
    skipDuplicates: true,
  })
  return { registered: count }
}

/** Is a job for this order still queued, claimed or retrying? Such an order is not asked again until it settles. */
async function hasUnsettledJob(orderId: string): Promise<boolean> {
  const row = await db.integrationOutbox.findFirst({
    where: {
      connector: CONNECTOR,
      operation: OPERATION,
      status: { in: ['PENDING', 'PROCESSING', 'RETRYABLE_FAILED'] },
      payloadJson: { path: ['orderId'], equals: orderId },
    },
    select: { id: true },
  })
  return row !== null
}

class LostRaceError extends Error {}

/**
 * Is the order STILL one a look may be sent for, read from IMS now: not erased, still shipped, despatched inside the window, still linked to the
 * storefront. Asked again at send time, because a job that waited (retries, a Replay from Sync exceptions) can outlive the window the scan judged it in,
 * and re-registering a parcel that has arrived would e-mail the customer about a delivery they already had.
 */
export async function trackshipRefireOrderStillEligible(orderId: string, now: Date = new Date()): Promise<boolean> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { status: true, erasedAt: true, shippedAt: true, shipments: { where: { status: 'SHIPPED' }, select: { shippedAt: true } }, shoppingLinks: { where: { connector: CONNECTOR }, select: { id: true }, take: 1 } },
  })
  if (!order || order.erasedAt !== null || !(SHIPPED_STATUSES as readonly string[]).includes(order.status) || order.shoppingLinks.length === 0) return false
  const shipped = despatchedAt(order)
  return shipped !== null && shipped.getTime() >= now.getTime() - TRACKSHIP_REFIRE_WINDOW_MS
}

/**
 * Queue the look that is due for one state row, in one transaction with the row's move to the next look. Compare-and-set on the attempt count, so
 * two scanners cannot queue the same look. A shadow (the hold) writes its record, queues nothing and moves the row only by the first back-off,
 * so a held tick does not scan the same order every five minutes and the order is looked at again once the hold lifts.
 */
export async function scheduleWcTrackshipRefire(
  input: { stateId: string; orderId: string; attempts: number; now: Date; obligationAt: Date },
): Promise<'queued' | 'shadowed' | 'raced'> {
  const attempt = input.attempts + 1
  try {
    return await db.$transaction(async (tx) => {
      const enqueued = await enqueueIntegrationOutbox({
        connector: CONNECTOR,
        operation: OPERATION,
        idempotencyKey: wcTrackshipRefireIdempotencyKey(input.orderId, attempt),
        payloadJson: { orderId: input.orderId, attempt } satisfies WcTrackshipRefireOutboxPayload,
        nextAttemptAt: null,
        producer: { subjectType: 'SalesOrder', subjectId: input.orderId, obligationAt: input.obligationAt, summary: { trackshipRefireAttempt: attempt } },
      }, { client: tx as RefireTxClient })
      if (isOutboxEnqueueShadowed(enqueued)) {
        await tx.trackshipRefireState.updateMany({
          where: { id: input.stateId, status: 'ACTIVE', attempts: input.attempts },
          data: { nextAttemptAt: new Date(input.now.getTime() + TRACKSHIP_REFIRE_BACKOFF_BASE_MS) },
        })
        return 'shadowed' as const
      }
      const moved = await tx.trackshipRefireState.updateMany({
        where: { id: input.stateId, status: 'ACTIVE', attempts: input.attempts, nextAttemptAt: { lte: input.now } },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: input.now,
          nextAttemptAt: new Date(input.now.getTime() + trackshipRefireBackoffMs(attempt)),
        },
      })
      if (moved.count !== 1) throw new LostRaceError()
      return 'queued' as const
    })
  } catch (error) {
    if (error instanceof LostRaceError) return 'raced'
    throw error
  }
}

/**
 * The scan: register new orders, close the ones whose window passed, queue every look that is due. Does nothing while the sweep is switched off.
 */
export async function enqueueTrackshipRefires(
  options: { limit?: number; now?: Date; /** Restrict the scan to these orders (a one-order catch-up, or a test that must not touch other orders). */ orderIds?: string[] } = {},
): Promise<WcTrackshipRefireScanSummary> {
  const summary: WcTrackshipRefireScanSummary = { registered: 0, expired: 0, queued: 0, shadowed: 0, inFlight: 0 }
  if (!(await isTrackshipRefireEnabled())) return summary
  const now = options.now ?? new Date()
  const limit = options.limit ?? WC_TRACKSHIP_REFIRE_QUEUE_LIMIT
  const windowStart = new Date(now.getTime() - TRACKSHIP_REFIRE_WINDOW_MS)

  summary.registered = (await registerCandidates(now, limit, options.orderIds)).registered

  const due = await db.trackshipRefireState.findMany({
    where: { status: 'ACTIVE', nextAttemptAt: { lte: now }, ...(options.orderIds ? { orderId: { in: options.orderIds } } : {}) },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: {
      id: true,
      orderId: true,
      attempts: true,
      order: { select: { shippedAt: true, shipments: { where: { status: 'SHIPPED' }, select: { shippedAt: true } }, shoppingLinks: { where: { connector: CONNECTOR }, select: { id: true }, take: 1 } } },
    },
  })
  for (const row of due) {
    const shipped = despatchedAt(row.order)
    // Past the window (or never despatched, or no storefront link left): the parcel has arrived or there is nowhere to ask, and re-registering
    // it now would e-mail the customer about a delivery they already had.
    if (shipped === null || shipped.getTime() < windowStart.getTime() || row.order.shoppingLinks.length === 0) {
      const closed = await db.trackshipRefireState.updateMany({ where: { id: row.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', lastResult: 'window-closed' } })
      summary.expired += closed.count
      continue
    }
    if (await hasUnsettledJob(row.orderId)) {
      summary.inFlight++
      continue
    }
    const scheduled = await scheduleWcTrackshipRefire({ stateId: row.id, orderId: row.orderId, attempts: row.attempts, now, obligationAt: shipped })
    if (scheduled === 'queued') summary.queued++
    else if (scheduled === 'shadowed') summary.shadowed++
  }
  return summary
}

export type WcTrackshipRefireRunSummary = {
  claimed: number
  succeeded: number
  retried: number
  deadLettered: number
  skipped: number
  errors: string[]
}

export type WcTrackshipRefireRunOptions = {
  idempotencyKeys?: string[]
  limit?: number
  now?: Date
  /** Test seam: the attempt deadline. Production uses WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS. */
  attemptDeadlineMs?: number
  clock?: () => Date
  drainBudgetMs?: number
}

/**
 * SURFACE (never re-drive) a re-fire whose worker died after claiming it: a PROCESSING row whose lock is past the drain lease moves to
 * PERMANENT_FAILED by a compare-and-set on the lock the dead worker took, so it shows on Sync > Exceptions. The message is about what is known:
 * the request may or may not have reached the storefront. Replay is safe because the next attempt asks the storefront what TrackShip holds.
 */
export async function parkStaleWcTrackshipRefireClaims(now: Date = new Date()): Promise<number> {
  const { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } = await import('@/lib/domain/integrations/outbox-leases')
  const staleBefore = new Date(now.getTime() - INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default)
  const stale = await db.integrationOutbox.findMany({
    where: { connector: CONNECTOR, operation: OPERATION, status: 'PROCESSING', lockedAt: { lt: staleBefore } },
    select: { id: true, lockedAt: true, payloadJson: true },
    take: 50,
  })
  let parked = 0
  for (const row of stale) {
    const result = await db.integrationOutbox.updateMany({
      where: { id: row.id, status: 'PROCESSING', lockedAt: row.lockedAt },
      data: {
        status: 'PERMANENT_FAILED',
        nextAttemptAt: null,
        lastError: 'The worker that claimed this TrackShip re-fire stopped before recording a result. It is NOT known whether the request reached the storefront. Replay: the next attempt asks the storefront what TrackShip holds, and fires only for a tracking number TrackShip does not hold.',
        lockedAt: null,
        lockedBy: null,
        attempts: { increment: 1 },
      },
    })
    if (result.count === 0) continue
    parked++
    const orderId = (row.payloadJson as { orderId?: string } | null)?.orderId ?? 'unknown'
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'trackship_refire_dead_lettered', tag: 'sync', level: 'ERROR',
      description: `The TrackShip re-fire for order ${orderId} was claimed by a worker that never recorded a result, so it is not known whether the storefront was asked. Replay it from Sync exceptions; the replay asks the storefront what TrackShip holds first.`,
      resolveUser: false,
    }).catch(() => {})
  }
  return parked
}

type AttemptVerdict =
  | { kind: 'done' }
  | { kind: 'retry'; reason: string }

/** The result words stored on the state row and in the log: a fixed vocabulary. */
const RESULT = {
  covered: 'covered',
  fired: 'fired',
  notEligible: 'not-eligible',
  noTracking: 'no-tracking',
  orderGone: 'order-gone',
} as const

/**
 * ONE ATTEMPT, inside the fence. IMS and the state are re-read, the storefront is asked once, and the answer is mapped by a closed switch: a
 * transport failure is a retry of this same job; every answer of the storefront's own is a success that moves the state.
 */
async function attemptWcTrackshipRefire(orderId: string): Promise<AttemptVerdict> {
  // The switch, re-read: turned off while the job waited means nothing is sent. Not a retry: a job the operator no longer wants is settled, and
  // the scan queues the next look itself once it is switched on again.
  if (!(await isTrackshipRefireEnabled())) return { kind: 'done' }
  const state = await db.trackshipRefireState.findUnique({ where: { orderId }, select: { status: true, attempts: true } })
  if (!state || state.status !== 'ACTIVE') return { kind: 'done' }
  const link = await db.shoppingOrderLink.findFirst({ where: { orderId, connector: CONNECTOR }, select: { externalOrderId: true } })
  if (!link?.externalOrderId) {
    await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'EXPIRED', lastResult: RESULT.orderGone } })
    return { kind: 'done' }
  }

  // The window, the order's status and its erasure marker, re-read at SEND time: an expired or ineligible job is settled without a request.
  if (!(await trackshipRefireOrderStillEligible(orderId))) {
    await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'EXPIRED', lastResult: 'window-closed' } })
    return { kind: 'done' }
  }

  const outcome = await postTrackshipRefire(link.externalOrderId)
  const now = new Date()
  switch (outcome.kind) {
    case 'covered':
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'COVERED', lastResult: RESULT.covered } })
      return { kind: 'done' }
    case 'fired': {
      // TrackShip registers from a background job, so the next look waits at least the grace, and never less than the order's own back-off.
      const wait = Math.max(TRACKSHIP_REFIRE_PENDING_GRACE_MS, trackshipRefireBackoffMs(state.attempts))
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { lastResult: RESULT.fired, nextAttemptAt: new Date(now.getTime() + wait) } })
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'trackship_refired', tag: 'sync', level: 'INFO',
        description: `TrackShip had no shipment for ${outcome.missing} tracking number${outcome.missing === 1 ? '' : 's'} on this order, so IMS asked the storefront to re-submit ${outcome.missing === 1 ? 'it' : 'them'} to TrackShip (look ${state.attempts}). The next look is in ${Math.round(wait / 60_000)} minutes.`,
        resolveUser: false,
      }).catch(() => {})
      if (state.attempts === TRACKSHIP_REFIRE_ALERT_ATTEMPTS) await warnStuck(orderId, state.attempts)
      return { kind: 'done' }
    }
    case 'not-eligible':
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { lastResult: RESULT.notEligible } })
      if (state.attempts === TRACKSHIP_REFIRE_ALERT_ATTEMPTS) await warnStuck(orderId, state.attempts)
      return { kind: 'done' }
    case 'no-tracking':
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { lastResult: RESULT.noTracking } })
      if (state.attempts === TRACKSHIP_REFIRE_ALERT_ATTEMPTS) await warnStuck(orderId, state.attempts)
      return { kind: 'done' }
    case 'order-gone':
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'EXPIRED', lastResult: RESULT.orderGone } })
      return { kind: 'done' }
    case 'outside-window':
      await db.trackshipRefireState.updateMany({ where: { orderId, status: 'ACTIVE' }, data: { status: 'EXPIRED', lastResult: 'window-closed' } })
      return { kind: 'done' }
    case 'failed':
      return { kind: 'retry', reason: outcome.error }
    default: {
      const unhandled: never = outcome
      throw new Error(`unhandled TrackShip re-fire outcome ${JSON.stringify(unhandled)}`)
    }
  }
}

/** Reported once, when the order reaches the alert count: an order that stays unregistered is a courier TrackShip does not take, or a TrackShip fault. */
async function warnStuck(orderId: string, attempts: number): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER', entityId: orderId, action: 'trackship_refire_stuck', tag: 'sync', level: 'WARNING',
    description: `TrackShip still has no shipment for this order after ${attempts} looks. IMS keeps asking, less often each time, until the order is registered or seven days have passed since it shipped. Check the courier is one TrackShip supports and that the TrackShip account is healthy.`,
    resolveUser: false,
  }).catch(() => {})
}

/** The runner: claim this operation's rows and run one fenced attempt for each. Never throws for a job's own failure. */
export async function runWcTrackshipRefireJobs(options: WcTrackshipRefireRunOptions = {}): Promise<WcTrackshipRefireRunSummary> {
  const summary: WcTrackshipRefireRunSummary = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (options.idempotencyKeys?.length === 0) return summary
  // The claim boundary of the producer-side hold: while WooCommerce is held, claim nothing and spend no attempt.
  if (wooDrainHold(undefined, 'order.trackship-refire').held) return summary
  const now = options.now
  const clock = options.clock ?? (() => new Date())
  const startedAt = clock().getTime()
  const budgetMs = options.drainBudgetMs ?? WC_DRAIN_CLAIM_BUDGET_MS
  const maxJobs = options.limit ?? 25
  const attempted: string[] = []

  while (attempted.length < maxJobs) {
    if (clock().getTime() - startedAt > budgetMs) break
    const [job] = await claimIntegrationOutboxWork({
      connector: CONNECTOR,
      operation: OPERATION,
      idempotencyKeys: options.idempotencyKeys,
      limit: WC_DRAIN_SCAN_WINDOW,
      claimLimit: 1,
      excludeIds: attempted,
      workerId: WORKER_ID,
      maxAttempts: WC_TRACKSHIP_REFIRE_MAX_ATTEMPTS,
      now: now ?? clock(),
    })
    if (!job) break
    attempted.push(job.id)
    summary.claimed++
    if (!job.lockedAt) {
      summary.errors.push(`TrackShip re-fire job ${job.id} was claimed without lockedAt`)
      continue
    }
    const claim = { id: job.id, workerId: WORKER_ID, lockedAt: job.lockedAt }

    let orderId: string
    try {
      orderId = parseIntegrationOutboxPayload<WcTrackshipRefireOutboxPayload>({
        connector: CONNECTOR, operation: OPERATION, payloadJson: job.payloadJson, rowId: job.id,
      }).orderId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markIntegrationOutboxPermanentFailure({ ...claim, error: message })
      summary.deadLettered++
      summary.errors.push(message)
      continue
    }

    // THE WRITER-SIDE CUT-OFF, RE-DERIVED IMMEDIATELY BEFORE THE SEND: park a pre-cutoff job without sending.
    const parkedBeforeCutoff = await refuseClaimedJobBeforeCutoff(job, WORKER_ID, now ? { now } : {})
    if (parkedBeforeCutoff !== null) {
      summary.deadLettered++
      summary.errors.push(parkedBeforeCutoff)
      continue
    }

    const ledger = createWriteLedger()
    const retry = async (error: string) => {
      const row = await markIntegrationOutboxRetryableFailure({
        ...claim,
        error,
        noWriteSent: ledger.writes === 0,
        attemptsBeforeFailure: job.attempts,
        maxAttempts: WC_TRACKSHIP_REFIRE_MAX_ATTEMPTS,
        now,
      })
      const dead = row.status === 'PERMANENT_FAILED'
      if (dead) summary.deadLettered++
      else summary.retried++
      summary.errors.push(error)
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId,
        action: dead ? 'trackship_refire_dead_lettered' : 'trackship_refire_retry',
        tag: 'sync', level: dead ? 'ERROR' : 'WARNING',
        description: dead
          ? `The TrackShip re-submission for order ${orderId} gave up after ${WC_TRACKSHIP_REFIRE_MAX_ATTEMPTS} attempts (${error}). Fix the cause, then Replay it from Sync exceptions; the replay asks the storefront what TrackShip holds first.`
          : `The TrackShip re-submission for order ${orderId} will be retried (attempt ${job.attempts + 1} of ${WC_TRACKSHIP_REFIRE_MAX_ATTEMPTS}): ${error}`,
        resolveUser: false,
      }).catch(() => {})
    }

    try {
      const fence = {
        signal: AbortSignal.timeout(options.attemptDeadlineMs ?? WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS),
        stillOwned: async () => (await db.integrationOutbox.count({
          where: { id: job.id, status: 'PROCESSING', lockedBy: WORKER_ID, lockedAt: job.lockedAt },
        })) === 1,
        mayStillSend: async () => (await currentOutboxRowBeforeCutoff(job)) === null,
        // Asked again immediately before the POST: the sweep is still switched on and the order is still waiting for a look.
        stillWanted: async () => (await isTrackshipRefireEnabled())
          && (await db.trackshipRefireState.count({ where: { orderId, status: 'ACTIVE' } })) === 1
          && (await trackshipRefireOrderStillEligible(orderId)),
      }
      const verdict = await runInWriteLedger(ledger, () => runWithWcAttemptFence(fence, () => attemptWcTrackshipRefire(orderId)))
      switch (verdict.kind) {
        case 'done':
          await markIntegrationOutboxSuccess(claim)
          summary.succeeded++
          break
        case 'retry':
          await retry(verdict.reason)
          break
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

export type WcTrackshipRefireTickResult = WcTrackshipRefireRunSummary & { reason?: string; scan?: WcTrackshipRefireScanSummary }

/**
 * The cron entry: park dead claims, queue what is due, drain. Does NOTHING while the switch is off: no scan, no shadow record, no claim.
 */
export async function processWcTrackshipRefires(options: WcTrackshipRefireRunOptions = {}): Promise<WcTrackshipRefireTickResult> {
  const total: WcTrackshipRefireTickResult = { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
  if (!(await isTrackshipRefireEnabled())) return { ...total, reason: 'trackship_refire_disabled' }
  if (!options.idempotencyKeys) {
    total.deadLettered += await parkStaleWcTrackshipRefireClaims(options.now ?? new Date())
    total.scan = await enqueueTrackshipRefires({ now: options.now })
  }
  const part = await runWcTrackshipRefireJobs(options)
  total.claimed += part.claimed
  total.succeeded += part.succeeded
  total.retried += part.retried
  total.deadLettered += part.deadLettered
  total.skipped += part.skipped
  total.errors.push(...part.errors)
  return total
}
