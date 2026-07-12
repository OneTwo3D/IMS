import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
import { getShipheroApiConfiguration, verifyShipheroWebhookSignature } from '@/lib/connectors/shiphero'
import {
  deriveShipheroStatusRank,
  extractShipheroEventId,
  extractShipheroOrderRef,
  normalizeShipheroEventType,
  type ShipheroWebhookEventType,
} from '@/lib/connectors/shiphero/webhook-validation'
import {
  persistShipheroWebhookEvent,
  type ShipheroWebhookEventRepository,
} from '@/lib/connectors/shiphero/webhook-events'
import { createShipheroWebhookEventRepository } from '@/lib/jobs/wms/process-shiphero-webhook-event'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

// ShipHero does not sign a timestamp; the exact signature header is "verify on
// live tenant" in the reference plan, so accept the documented candidates.
const SIGNATURE_HEADERS = ['x-shiphero-hmac-sha256', 'x-shiphero-signature', 'x-hmac-sha256'] as const

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

async function readWebhookBody(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) throw new RequestBodyTooLargeError()
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
    if (totalBytes > maxBytes) throw new RequestBodyTooLargeError()
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

function readSignatureHeader(request: Request): string | null {
  for (const header of SIGNATURE_HEADERS) {
    const value = request.headers.get(header)
    if (value && value.trim()) return value.trim()
  }
  return null
}

export type ShipheroWebhookRouteDependencies = {
  getShipheroApiConfiguration: typeof getShipheroApiConfiguration
  isIntegrationPluginEnabled: (plugin: 'shiphero') => Promise<boolean>
  isUniqueConstraintError: (error: unknown) => boolean
  repository: ShipheroWebhookEventRepository
}

const defaultDependencies: ShipheroWebhookRouteDependencies = {
  getShipheroApiConfiguration,
  isIntegrationPluginEnabled,
  isUniqueConstraintError(error) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  },
  repository: createShipheroWebhookEventRepository(),
}

export async function handleShipheroWebhook(
  request: Request,
  eventParam: string,
  dependencies: ShipheroWebhookRouteDependencies = defaultDependencies,
): Promise<NextResponse> {
  const eventType: ShipheroWebhookEventType | null = normalizeShipheroEventType(eventParam)
  if (!eventType) {
    return NextResponse.json({ error: 'Unknown webhook event type' }, { status: 404 })
  }

  let rawBody: string
  try {
    rawBody = await readWebhookBody(request, MAX_WEBHOOK_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    throw error
  }

  const isPluginEnabled = await dependencies.isIntegrationPluginEnabled('shiphero')
  const { webhookSecret } = await dependencies.getShipheroApiConfiguration()
  if (!isPluginEnabled || !webhookSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const signatureHeader = readSignatureHeader(request)
  if (!verifyShipheroWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const externalEventId = extractShipheroEventId(payload, rawBody)
  const externalOrderId = extractShipheroOrderRef(payload)
  const statusRank = deriveShipheroStatusRank(eventType, payload)

  const result = await persistShipheroWebhookEvent(
    dependencies.repository,
    { eventType, externalEventId, externalOrderId, statusRank, payload: payload as Prisma.InputJsonValue },
    { isUniqueConstraintError: dependencies.isUniqueConstraintError },
  )

  if (result.status === 'duplicate') {
    return NextResponse.json({ accepted: true, duplicate: true, eventType, externalEventId })
  }
  return NextResponse.json(
    { accepted: true, queued: true, eventType, externalEventId, externalOrderId },
    { status: 202 },
  )
}

export async function POST(request: Request, context: { params: Promise<{ event: string }> }) {
  const { event } = await context.params
  return handleShipheroWebhook(request, event)
}
