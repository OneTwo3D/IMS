import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getMintsoftApiConfiguration, verifyMintsoftWebhookSignature } from '@/lib/connectors/mintsoft'
import {
  extractMintsoftWebhookTimestamp,
  isMintsoftWebhookTimestampFresh,
} from '@/lib/connectors/mintsoft/webhook-validation'
import { processMintsoftBookedInEvent } from '@/lib/connectors/mintsoft/sync/booked-in-handler'
import { persistMintsoftWebhookEvent, type PersistMintsoftWebhookEventInput } from '@/lib/connectors/mintsoft/webhook-events'
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

export async function POST(request: Request) {
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
  const isPluginEnabled = await isIntegrationPluginEnabled('mintsoft')
  const { webhookSecret } = await getMintsoftApiConfiguration()
  if (!isPluginEnabled || !webhookSecret || !verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: MintsoftReceiptWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MintsoftReceiptWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const webhookTimestamp = extractMintsoftWebhookTimestamp(payload as Record<string, unknown>)
  if (webhookTimestamp && !isMintsoftWebhookTimestampFresh(webhookTimestamp)) {
    return NextResponse.json({ error: 'Stale webhook timestamp' }, { status: 401 })
  }

  const externalEventId = getExternalEventId(payload, rawBody)
  const externalAsnId = getExternalAsnId(payload)
  const eventInput: PersistMintsoftWebhookEventInput = {
    externalEventId,
    externalAsnId,
    payload: payload as Prisma.InputJsonValue,
  }

  const result = await persistMintsoftWebhookEvent(
    {
      async createEvent(input) {
        return db.wmsInboundReceiptEvent.create({
          data: {
            connector: 'mintsoft',
            externalEventId: input.externalEventId,
            externalAsnId: input.externalAsnId,
            payload: input.payload,
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
        const updated = await db.wmsInboundReceiptEvent.updateMany({
          where: {
            id,
            processedAt: null,
          },
          data: {
            externalAsnId: input.externalAsnId,
            payload: input.payload,
            processingError: null,
          },
        })
        return updated.count > 0
      },
    },
    eventInput,
    {
      isUniqueConstraintError(error) {
        return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      },
    },
  )

  if (result.status === 'duplicate') {
    await logActivity({
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

  const processingResult = await processMintsoftBookedInEvent(result.eventId)
  if (processingResult.status === 'failed') {
    return NextResponse.json({
      accepted: false,
      externalEventId,
      externalAsnId,
      error: processingResult.error,
    }, { status: 500 })
  }

  await logActivity({
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
    processed: processingResult.status === 'processed',
    pending: processingResult.status === 'pending',
  })
}
