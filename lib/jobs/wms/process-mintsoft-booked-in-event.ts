import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { Prisma } from '@/app/generated/prisma/client'
import { MintsoftConnector, fetchMintsoftAsns } from '@/lib/connectors/mintsoft'
import type {
  MintsoftWebhookEventRepository,
  PersistMintsoftWebhookEventInput,
} from '@/lib/connectors/mintsoft/webhook-events'
import type { WmsAsnRef, WmsConnector } from '@/lib/connectors/wms/types'
import {
  buildMintsoftWebhookReplayForAsnWhere,
  buildMintsoftWebhookSweepWhere,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS,
  processBookedInEvent,
  type ProcessMintsoftBookedInResult,
} from '@/lib/domain/wms/booked-in-service'

const DEFAULT_WEBHOOK_SWEEPER_PAGE_SIZE = 250
const MINTSOFT_USE_BULK_ASN_LOOKUP_ENV = 'MINTSOFT_USE_BULK_ASN_LOOKUP'
const MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE_ENV = 'MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE'

let mintsoftConnector: MintsoftConnector | null = null

type FetchMintsoftBookedInAsnOptions = {
  connector?: Pick<WmsConnector, 'fetchAsnById'>
  env?: Record<string, string | undefined>
  fetchAsns?: () => Promise<WmsAsnRef[]>
}

type ProcessMintsoftBookedInEventJobOptions = {
  fetchRemoteAsn?: (externalAsnId: string) => Promise<WmsAsnRef | null>
  approveReview?: boolean
}

type SweepUnprocessedMintsoftBookedInEventsOptions = ProcessMintsoftBookedInEventJobOptions & {
  env?: Record<string, string | undefined>
  pageSize?: number
}

type MintsoftWebhookEventDelegate = Pick<typeof db.wmsInboundReceiptEvent, 'create' | 'findUnique' | 'updateMany'>

type CreateMintsoftWebhookEventRepositoryOptions = {
  client?: MintsoftWebhookEventDelegate
  logActivity?: typeof logActivity
}

type MintsoftWebhookRetryResetSnapshot = {
  id: string
  processingStatus: string
  processingAttempts: number
  nextRetryAt: Date | null
  deadLetteredAt: Date | null
  lastError: string | null
}

type MintsoftBookedInCounters = {
  processed: number
  duplicates: number
  pending: number
  requiresReview: number
  failed: number
}

export type ProcessMintsoftBookedInEventsResult = MintsoftBookedInCounters & {
  attempted: number
}

function getMintsoftConnector(): MintsoftConnector {
  mintsoftConnector ??= new MintsoftConnector()
  return mintsoftConnector
}

function getConnectorName(connector: Pick<WmsConnector, 'fetchAsnById'>): string {
  return (connector as { constructor?: { name?: string } }).constructor?.name?.trim() || 'unknown connector'
}

export function shouldLogMintsoftWebhookRetryStateReset(
  previous: MintsoftWebhookRetryResetSnapshot,
): boolean {
  return previous.processingStatus !== MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending
    || previous.processingAttempts > 0
    || previous.nextRetryAt != null
    || previous.deadLetteredAt != null
    || previous.lastError != null
}

export function buildMintsoftWebhookRetryStateResetMetadata(
  previous: MintsoftWebhookRetryResetSnapshot,
): Record<string, unknown> {
  return {
    eventId: previous.id,
    priorStatus: previous.processingStatus,
    priorAttempts: previous.processingAttempts,
    priorNextRetryAt: previous.nextRetryAt?.toISOString() ?? null,
    priorDeadLetteredAt: previous.deadLetteredAt?.toISOString() ?? null,
    priorLastError: previous.lastError,
  }
}

export function createMintsoftWebhookEventRepository(
  options: CreateMintsoftWebhookEventRepositoryOptions = {},
): MintsoftWebhookEventRepository {
  const client = options.client ?? db.wmsInboundReceiptEvent
  const activityLogger = options.logActivity ?? logActivity

  return {
    async createEvent(input) {
      return client.create({
        data: {
          connector: 'mintsoft',
          externalEventId: input.externalEventId,
          externalAsnId: input.externalAsnId,
          payload: input.payload,
          processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending,
          processingAttempts: 0,
          nextRetryAt: null,
          deadLetteredAt: null,
          lastError: null,
        },
        select: { id: true },
      })
    },
    async findEvent(eventExternalId) {
      return client.findUnique({
        where: {
          connector_externalEventId: {
            connector: 'mintsoft',
            externalEventId: eventExternalId,
          },
        },
        select: { id: true, processedAt: true },
      })
    },
    async updatePendingEvent(id, input: PersistMintsoftWebhookEventInput) {
      const previous = await client.findUnique({
        where: { id },
        select: {
          id: true,
          processingStatus: true,
          processingAttempts: true,
          nextRetryAt: true,
          deadLetteredAt: true,
          lastError: true,
        },
      })
      const updated = await client.updateMany({
        where: {
          id,
          processedAt: null,
        },
        data: {
          externalAsnId: input.externalAsnId,
          payload: input.payload,
          processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending,
          processingAttempts: 0,
          nextRetryAt: null,
          deadLetteredAt: null,
          lastError: null,
          reviewDetails: Prisma.DbNull,
          reviewedAt: null,
          reviewedBy: null,
        },
      })
      if (updated.count > 0 && previous && shouldLogMintsoftWebhookRetryStateReset(previous)) {
        await activityLogger({
          entityType: 'SYNC',
          entityId: id,
          tag: 'sync',
          action: 'mintsoft_webhook_retry_state_reset',
          level: 'WARNING',
          description: `Reset Mintsoft webhook retry state for replayed event ${input.externalEventId}`,
          metadata: {
            ...buildMintsoftWebhookRetryStateResetMetadata(previous),
            externalEventId: input.externalEventId,
            externalAsnId: input.externalAsnId,
          },
          resolveUser: false,
        })
      }
      return updated.count > 0
    },
  }
}

export function isMintsoftBulkAsnLookupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[MINTSOFT_USE_BULK_ASN_LOOKUP_ENV]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export function getMintsoftWebhookSweeperPageSize(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE_ENV]?.trim()
  if (!raw) return DEFAULT_WEBHOOK_SWEEPER_PAGE_SIZE

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_SWEEPER_PAGE_SIZE
}

export async function fetchMintsoftBookedInAsn(
  externalAsnId: string,
  options?: FetchMintsoftBookedInAsnOptions,
): Promise<WmsAsnRef | null> {
  const normalizedExternalAsnId = externalAsnId.trim()
  if (!normalizedExternalAsnId) {
    throw new Error('externalAsnId is required')
  }

  if (isMintsoftBulkAsnLookupEnabled(options?.env)) {
    const asns = await (options?.fetchAsns ?? fetchMintsoftAsns)()
    return asns.find((asn) => asn.externalAsnId === normalizedExternalAsnId) ?? null
  }

  const connector = options?.connector ?? getMintsoftConnector()
  if (!connector.fetchAsnById) {
    throw new Error(
      `Configured WMS connector ${getConnectorName(connector)} does not support direct ASN lookup; `
      + `set ${MINTSOFT_USE_BULK_ASN_LOOKUP_ENV}=true to use the rollback bulk ASN lookup path.`,
    )
  }

  return connector.fetchAsnById(normalizedExternalAsnId)
}

export async function processMintsoftBookedInEvent(
  eventId: string,
  options?: ProcessMintsoftBookedInEventJobOptions,
): Promise<ProcessMintsoftBookedInResult> {
  return processBookedInEvent(eventId, {
    fetchRemoteAsn: options?.fetchRemoteAsn ?? fetchMintsoftBookedInAsn,
    approveReview: options?.approveReview,
  })
}

function incrementCounter(counters: MintsoftBookedInCounters, result: ProcessMintsoftBookedInResult): void {
  if (result.status === 'processed') {
    counters.processed += 1
  } else if (result.status === 'duplicate') {
    counters.duplicates += 1
  } else if (result.status === 'pending') {
    counters.pending += 1
  } else if (result.status === 'requires_review') {
    counters.requiresReview += 1
  } else {
    counters.failed += 1
  }
}

export async function replayMintsoftBookedInEventsForAsn(externalAsnId: string): Promise<MintsoftBookedInCounters> {
  const events = await db.wmsInboundReceiptEvent.findMany({
    where: buildMintsoftWebhookReplayForAsnWhere(externalAsnId),
    orderBy: { receivedAt: 'asc' },
    select: { id: true },
  })

  const counters = {
    processed: 0,
    duplicates: 0,
    pending: 0,
    requiresReview: 0,
    failed: 0,
  }

  for (const event of events) {
    incrementCounter(counters, await processMintsoftBookedInEvent(event.id))
  }

  return counters
}

export async function sweepUnprocessedMintsoftBookedInEvents(
  options: SweepUnprocessedMintsoftBookedInEventsOptions = {},
): Promise<ProcessMintsoftBookedInEventsResult> {
  const now = new Date()
  const events = await db.wmsInboundReceiptEvent.findMany({
    where: buildMintsoftWebhookSweepWhere(now),
    orderBy: { receivedAt: 'asc' },
    select: {
      id: true,
    },
    take: options.pageSize ?? getMintsoftWebhookSweeperPageSize(options.env),
  })

  const counters = {
    attempted: events.length,
    processed: 0,
    duplicates: 0,
    pending: 0,
    requiresReview: 0,
    failed: 0,
  }

  for (const event of events) {
    incrementCounter(counters, await processMintsoftBookedInEvent(event.id, {
      fetchRemoteAsn: options.fetchRemoteAsn,
      approveReview: options.approveReview,
    }))
  }

  return counters
}
