import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  getMintsoftApiConfiguration,
  verifyMintsoftWebhookSignature,
} from '@/lib/connectors/mintsoft'
import {
  extractMintsoftWebhookTimestampCandidateFromRequest,
  isMintsoftWebhookTimestampFresh,
} from '@/lib/connectors/mintsoft/webhook-validation'
import {
  persistMintsoftWebhookEvent,
  type MintsoftWebhookEventRepository,
  type PersistMintsoftWebhookEventInput,
} from '@/lib/connectors/mintsoft/webhook-events'
import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '@/lib/connectors/mintsoft/sync/booked-in-handler'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

type MintsoftReceiptWebhookPayload = {
  eventId?: string
  id?: string | number
  asnId?: string | number
  externalAsnId?: string | number
  timestamp?: string | number
  eventTime?: string | number
  occurredAt?: string | number
  createdAt?: string | number
}

type MintsoftWebhookRetryResetSnapshot = {
  id: string
  processingStatus: string
  processingAttempts: number
  nextRetryAt: Date | null
  deadLetteredAt: Date | null
  lastError: string | null
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

export type MintsoftBookedInWebhookRouteDependencies = {
  getMintsoftApiConfiguration: typeof getMintsoftApiConfiguration
  isIntegrationPluginEnabled: (plugin: 'mintsoft') => Promise<boolean>
  isUniqueConstraintError: (error: unknown) => boolean
  logActivity: typeof logActivity
  repository: MintsoftWebhookEventRepository
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

function getExternalEventId(payload: MintsoftReceiptWebhookPayload, rawBody: string): string {
  const directId = payload.eventId ?? payload.id
  if (directId != null && `${directId}`.trim()) return `${directId}`.trim()

  return createHash('sha256').update(rawBody).digest('hex')
}

function getExternalAsnId(payload: MintsoftReceiptWebhookPayload): string | null {
  const value = payload.externalAsnId ?? payload.asnId
  return value == null ? null : `${value}`.trim() || null
}

async function readWebhookBody(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError()
    }
  }

  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError()
    }

    chunks.push(value)
  }

  const buffer = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(buffer)
}

const defaultMintsoftBookedInWebhookDependencies: MintsoftBookedInWebhookRouteDependencies = {
  getMintsoftApiConfiguration,
  isIntegrationPluginEnabled,
  isUniqueConstraintError(error) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  },
  logActivity,
  repository: {
    async createEvent(input) {
      return db.wmsInboundReceiptEvent.create({
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
      return db.wmsInboundReceiptEvent.findUnique({
        where: {
          connector_externalEventId: {
            connector: 'mintsoft',
            externalEventId: eventExternalId,
          },
        },
        select: { id: true, processedAt: true },
      })
    },
    async updatePendingEvent(id, input) {
      const previous = await db.wmsInboundReceiptEvent.findUnique({
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
      const updated = await db.wmsInboundReceiptEvent.updateMany({
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
        },
      })
      if (updated.count > 0 && previous && shouldLogMintsoftWebhookRetryStateReset(previous)) {
        await logActivity({
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
  },
}

export async function handleMintsoftBookedInWebhook(
  request: Request,
  dependencies: MintsoftBookedInWebhookRouteDependencies = defaultMintsoftBookedInWebhookDependencies,
) {
  let rawBody: string
  try {
    rawBody = await readWebhookBody(request, MAX_WEBHOOK_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    throw error
  }

  if (!rawBody.trim()) {
    return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
  }

  const signatureHeader = request.headers.get('x-mintsoft-signature')
  const isPluginEnabled = await dependencies.isIntegrationPluginEnabled('mintsoft')
  const { webhookSecret } = await dependencies.getMintsoftApiConfiguration()
  if (!isPluginEnabled || !webhookSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhookTimestamp = extractMintsoftWebhookTimestampCandidateFromRequest(rawBody, request.headers)
  if (!webhookTimestamp) {
    await dependencies.logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'mintsoft_webhook_rejected_missing_timestamp',
      level: 'WARNING',
      description: 'Rejected Mintsoft ASN webhook without a signed timestamp',
      metadata: {},
      resolveUser: false,
    })
    return NextResponse.json({ error: 'Missing webhook timestamp' }, { status: 401 })
  }

  const signatureValid = verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret, {
    timestamp: webhookTimestamp.value,
  })
  if (!signatureValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isMintsoftWebhookTimestampFresh(webhookTimestamp.date)) {
    await dependencies.logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'mintsoft_webhook_rejected_stale_timestamp',
      level: 'WARNING',
      description: 'Rejected Mintsoft ASN webhook with a stale signed timestamp',
      metadata: {
        timestamp: webhookTimestamp.date.toISOString(),
        timestampSource: webhookTimestamp.source,
        timestampKey: webhookTimestamp.key,
      },
      resolveUser: false,
    })
    return NextResponse.json({ error: 'Stale webhook timestamp' }, { status: 401 })
  }

  let payload: MintsoftReceiptWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MintsoftReceiptWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const externalEventId = getExternalEventId(payload, rawBody)
  const externalAsnId = getExternalAsnId(payload)

  const eventInput: PersistMintsoftWebhookEventInput = {
    externalEventId,
    externalAsnId,
    payload: payload as Prisma.InputJsonValue,
  }

  const result = await persistMintsoftWebhookEvent(
    dependencies.repository,
    eventInput,
    {
      isUniqueConstraintError: dependencies.isUniqueConstraintError,
    },
  )

  if (result.status === 'duplicate') {
    await dependencies.logActivity({
      entityType: 'SYNC',
      entityId: result.eventId,
      tag: 'sync',
      action: 'mintsoft_webhook_duplicate_ignored',
      description: 'Ignored duplicate Mintsoft ASN webhook after successful processing',
      metadata: { externalEventId, externalAsnId },
      resolveUser: false,
    })
    return NextResponse.json({
      accepted: true,
      duplicate: true,
      externalEventId,
      externalAsnId,
    })
  }

  await dependencies.logActivity({
    entityType: 'SYNC',
    entityId: result.eventId,
    tag: 'sync',
    action: result.status === 'created' ? 'mintsoft_webhook_event_created' : 'mintsoft_webhook_event_updated',
    description: result.status === 'created'
      ? 'Recorded Mintsoft ASN webhook event'
      : 'Updated pending Mintsoft ASN webhook event payload',
    metadata: { externalEventId, externalAsnId },
    resolveUser: false,
  })

  return NextResponse.json({
    accepted: true,
    externalEventId,
    externalAsnId,
    queued: true,
    pending: true,
  }, { status: 202 })
}

export async function POST(request: Request) {
  return handleMintsoftBookedInWebhook(request)
}
