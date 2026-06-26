import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import {
  type PersistShipheroWebhookEventInput,
  type ShipheroWebhookEventRecord,
  type ShipheroWebhookEventRepository,
} from '@/lib/connectors/shiphero/webhook-events'

const CONNECTOR = 'shiphero'
const DEFAULT_PAGE_SIZE = 250
const PAGE_SIZE_ENV = 'SHIPHERO_WEBHOOK_SWEEPER_PAGE_SIZE'

const RETRY_BASE_MS = 60 * 1000 // 1 minute
const RETRY_CAP_MS = 30 * 60 * 1000 // 30 minutes
const MAX_ATTEMPTS = 10
// Reconcile backstop: events stuck unprocessed longer than this are re-queued.
const STALE_AFTER_MS = 60 * 60 * 1000 // 1 hour

export type ShipheroWebhookProcessResult =
  | { status: 'processed'; eventId: string }
  | { status: 'superseded'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'pending'; eventId: string; error: string }
  | { status: 'dead'; eventId: string; error: string }
  | { status: 'missing'; eventId: string }

export type ShipheroWebhookCounters = {
  attempted: number
  processed: number
  superseded: number
  duplicates: number
  pending: number
  dead: number
}

// --- Prisma adapter for the staging repository -----------------------------

export function createShipheroWebhookEventRepository(): ShipheroWebhookEventRepository {
  return {
    async createEvent(input: PersistShipheroWebhookEventInput) {
      const created = await db.wmsWebhookEvent.create({
        data: {
          connector: CONNECTOR,
          eventType: input.eventType,
          externalEventId: input.externalEventId,
          externalOrderId: input.externalOrderId,
          statusRank: input.statusRank,
          payload: input.payload,
        },
        select: { id: true },
      })
      return { id: created.id }
    },
    async findEvent(externalEventId: string): Promise<ShipheroWebhookEventRecord | null> {
      return db.wmsWebhookEvent.findUnique({
        where: { connector_externalEventId: { connector: CONNECTOR, externalEventId } },
        select: { id: true, processedAt: true },
      })
    },
    async updatePendingEvent(id: string, input: PersistShipheroWebhookEventInput): Promise<boolean> {
      const result = await db.wmsWebhookEvent.updateMany({
        where: { id, processedAt: null },
        data: {
          eventType: input.eventType,
          externalOrderId: input.externalOrderId,
          statusRank: input.statusRank,
          payload: input.payload,
          // A re-delivery resets the retry clock so the sweeper picks it up promptly.
          processingStatus: 'PENDING',
          processingAttempts: 0,
          nextRetryAt: null,
          deadLetteredAt: null,
          lastError: null,
        },
      })
      return result.count > 0
    },
  }
}

// --- Pure primitives (unit-tested) -----------------------------------------

/**
 * Monotonic guard decision. An order-status event applies unless a higher-or-equal
 * rank already won for that order (strictly-lower rank → superseded no-op). Events
 * with no rank (inventory, or an unknown status) always apply.
 */
export function decideShipheroWebhookApplication(input: {
  statusRank: number | null
  appliedRank: number | null
}): 'apply' | 'superseded' {
  const { statusRank, appliedRank } = input
  if (statusRank == null || appliedRank == null) return 'apply'
  return statusRank < appliedRank ? 'superseded' : 'apply'
}

/** Exponential backoff with ±20% jitter, capped; dead-letters at MAX_ATTEMPTS. */
export function buildShipheroWebhookRetryUpdate(input: {
  attempts: number
  lastError: string
  now: Date
  maxAttempts?: number
  baseMs?: number
  capMs?: number
  random?: () => number
}): {
  processingStatus: string
  processingAttempts: number
  nextRetryAt: Date | null
  deadLetteredAt: Date | null
  lastError: string
} {
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS
  const baseMs = input.baseMs ?? RETRY_BASE_MS
  const capMs = input.capMs ?? RETRY_CAP_MS
  const attempts = input.attempts + 1

  if (attempts >= maxAttempts) {
    return {
      processingStatus: 'DEAD',
      processingAttempts: attempts,
      nextRetryAt: null,
      deadLetteredAt: input.now,
      lastError: input.lastError,
    }
  }

  const exponential = Math.min(capMs, baseMs * 2 ** (attempts - 1))
  const jitterFactor = 0.8 + (input.random ?? Math.random)() * 0.4 // [0.8, 1.2)
  const delayMs = Math.round(exponential * jitterFactor)
  return {
    processingStatus: 'PENDING_RETRY',
    processingAttempts: attempts,
    nextRetryAt: new Date(input.now.getTime() + delayMs),
    deadLetteredAt: null,
    lastError: input.lastError,
  }
}

export function buildShipheroWebhookSweepWhere(now: Date): Prisma.WmsWebhookEventWhereInput {
  return {
    connector: CONNECTOR,
    processedAt: null,
    OR: [
      { processingStatus: 'PENDING' },
      { processingStatus: 'PENDING_RETRY', nextRetryAt: { lte: now } },
    ],
  }
}

export function getShipheroWebhookSweeperPageSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PAGE_SIZE_ENV]?.trim()
  if (!raw) return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_SIZE
}

// --- Processor (transactional, monotonic-guarded writeback core) ------------

export type ProcessShipheroWebhookEventOptions = {
  now?: () => Date
  /**
   * Domain writeback hook, run inside the row lock once the monotonic guard
   * decides the event should apply. The default is a no-op: this slice (h02x.3)
   * delivers the ingress/staging/guard infrastructure; sales-order-status (h02x.9)
   * and stock-alignment (h02x.4) plug their domain mutations in here.
   */
  applyEvent?: (event: {
    id: string
    eventType: string
    externalOrderId: string | null
    statusRank: number | null
    payload: Prisma.JsonValue
  }, tx: Prisma.TransactionClient) => Promise<void>
}

/**
 * Apply one staged ShipHero webhook event. Shared by the (future) fast path and the
 * sweeper. Locks the event row, re-checks idempotency under the lock, runs the
 * monotonic guard against the highest already-applied rank for the order, invokes
 * the domain hook, and marks the event processed (or superseded).
 */
export async function processShipheroWebhookEvent(
  eventId: string,
  options: ProcessShipheroWebhookEventOptions = {},
): Promise<ShipheroWebhookProcessResult> {
  const now = options.now?.() ?? new Date()
  const applyEvent = options.applyEvent

  const event = await db.wmsWebhookEvent.findUnique({
    where: { id: eventId },
    select: { id: true, processedAt: true, processingAttempts: true },
  })
  if (!event) return { status: 'missing', eventId }
  if (event.processedAt) return { status: 'duplicate', eventId }

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wms_webhook_events WHERE id = ${eventId} FOR UPDATE`

      const locked = await tx.wmsWebhookEvent.findUnique({
        where: { id: eventId },
        select: { id: true, eventType: true, externalOrderId: true, statusRank: true, payload: true, processedAt: true },
      })
      if (!locked) return { status: 'missing', eventId }
      if (locked.processedAt) return { status: 'duplicate', eventId }

      let appliedRank: number | null = null
      if (locked.externalOrderId && locked.statusRank != null) {
        const applied = await tx.wmsWebhookEvent.aggregate({
          where: {
            connector: CONNECTOR,
            externalOrderId: locked.externalOrderId,
            processedAt: { not: null },
            supersededAt: null,
            statusRank: { not: null },
            id: { not: eventId },
          },
          _max: { statusRank: true },
        })
        appliedRank = applied._max.statusRank
      }

      const decision = decideShipheroWebhookApplication({ statusRank: locked.statusRank, appliedRank })
      if (decision === 'superseded') {
        await tx.wmsWebhookEvent.update({
          where: { id: eventId },
          data: { processedAt: now, supersededAt: now, processingStatus: 'PROCESSED' },
        })
        return { status: 'superseded', eventId }
      }

      if (applyEvent) await applyEvent(locked, tx)

      await tx.wmsWebhookEvent.update({
        where: { id: eventId },
        data: { processedAt: now, processingStatus: 'PROCESSED', lastError: null },
      })
      return { status: 'processed', eventId }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ShipHero webhook processing failed'
    const retry = buildShipheroWebhookRetryUpdate({ attempts: event.processingAttempts, lastError: message, now })
    await db.wmsWebhookEvent.update({ where: { id: eventId }, data: retry }).catch(() => undefined)
    return retry.processingStatus === 'DEAD'
      ? { status: 'dead', eventId, error: message }
      : { status: 'pending', eventId, error: message }
  }
}

function increment(counters: ShipheroWebhookCounters, result: ShipheroWebhookProcessResult): void {
  if (result.status === 'processed') counters.processed += 1
  else if (result.status === 'superseded') counters.superseded += 1
  else if (result.status === 'duplicate') counters.duplicates += 1
  else if (result.status === 'pending') counters.pending += 1
  else if (result.status === 'dead') counters.dead += 1
}

export type SweepShipheroWebhookEventsOptions = ProcessShipheroWebhookEventOptions & {
  pageSize?: number
  env?: NodeJS.ProcessEnv
}

/** Drain due ShipHero webhook events (PENDING or PENDING_RETRY past nextRetryAt). */
export async function sweepShipheroWebhookEvents(
  options: SweepShipheroWebhookEventsOptions = {},
): Promise<ShipheroWebhookCounters> {
  const now = options.now?.() ?? new Date()
  const events = await db.wmsWebhookEvent.findMany({
    where: buildShipheroWebhookSweepWhere(now),
    orderBy: { receivedAt: 'asc' },
    select: { id: true },
    take: options.pageSize ?? getShipheroWebhookSweeperPageSize(options.env),
  })

  const counters: ShipheroWebhookCounters = { attempted: events.length, processed: 0, superseded: 0, duplicates: 0, pending: 0, dead: 0 }
  for (const event of events) {
    const result = await processShipheroWebhookEvent(event.id, options)
    increment(counters, result)
  }
  return counters
}

export type ShipheroReconcileResult = {
  requeued: number
  deadLettered: number
}

/**
 * Reconciliation backstop. The webhook path is primary; this slower-cadence,
 * wider-lookback sweep re-queues events that have been stuck unprocessed past the
 * stale threshold (e.g. a writeback dependency that wasn't ready) and reports the
 * dead-letter backlog. Polling the remote for events that never arrived as webhooks
 * is layered on by the order-status (h02x.9) and stock (h02x.4) children.
 */
export async function runShipheroWebhookReconcile(options: { now?: () => Date } = {}): Promise<ShipheroReconcileResult> {
  const now = options.now?.() ?? new Date()
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS)

  const requeue = await db.wmsWebhookEvent.updateMany({
    where: {
      connector: CONNECTOR,
      processedAt: null,
      deadLetteredAt: null,
      processingStatus: 'PENDING_RETRY',
      receivedAt: { lte: staleBefore },
    },
    data: { processingStatus: 'PENDING', nextRetryAt: null },
  })

  const deadLettered = await db.wmsWebhookEvent.count({
    where: { connector: CONNECTOR, deadLetteredAt: { not: null }, processedAt: null },
  })

  return { requeued: requeue.count, deadLettered }
}
