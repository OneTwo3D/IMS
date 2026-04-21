import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { getMintsoftApiConfiguration, verifyMintsoftWebhookSignature } from '@/lib/connectors/mintsoft'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

type MintsoftReceiptWebhookPayload = {
  eventId?: string
  id?: string | number
  asnId?: string | number
  externalAsnId?: string | number
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

export async function POST(request: Request) {
  if (!(await isIntegrationPluginEnabled('mintsoft'))) {
    return NextResponse.json({ skipped: true, reason: 'Mintsoft plugin disabled' }, { status: 404 })
  }

  const rawBody = await request.text()
  if (!rawBody.trim()) {
    return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
  }

  const signatureHeader = request.headers.get('x-mintsoft-signature')
  const { webhookSecret } = await getMintsoftApiConfiguration()
  if (!webhookSecret) {
    return NextResponse.json({ error: 'Mintsoft webhook secret is not configured' }, { status: 503 })
  }

  if (!verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    return NextResponse.json({ error: 'Invalid Mintsoft webhook signature' }, { status: 401 })
  }

  let payload: MintsoftReceiptWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MintsoftReceiptWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const externalEventId = getExternalEventId(payload, rawBody)
  const externalAsnId = getExternalAsnId(payload)

  await db.wmsInboundReceiptEvent.upsert({
    where: {
      connector_externalEventId: {
        connector: 'mintsoft',
        externalEventId,
      },
    },
    create: {
      connector: 'mintsoft',
      externalEventId,
      externalAsnId,
      payload: payload as Prisma.InputJsonValue,
    },
    update: {
      externalAsnId,
      payload: payload as Prisma.InputJsonValue,
      processingError: null,
    },
  })

  return NextResponse.json({
    accepted: true,
    externalEventId,
    externalAsnId,
  })
}
