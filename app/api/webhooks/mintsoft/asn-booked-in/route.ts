import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
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
  const rawBody = await request.text()
  if (!rawBody.trim()) {
    return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
  }

  const signatureHeader = request.headers.get('x-mintsoft-signature')
  const isPluginEnabled = await isIntegrationPluginEnabled('mintsoft')
  const { webhookSecret } = await getMintsoftApiConfiguration()
  if (!isPluginEnabled || !webhookSecret || !verifyMintsoftWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'mintsoft_webhook_rejected',
      level: 'WARNING',
      description: 'Rejected Mintsoft ASN webhook request',
      metadata: {
        pluginEnabled: isPluginEnabled,
        hasWebhookSecret: Boolean(webhookSecret),
      },
      resolveUser: false,
    })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: MintsoftReceiptWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MintsoftReceiptWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  const externalEventId = getExternalEventId(payload, rawBody)
  const externalAsnId = getExternalAsnId(payload)
  const existing = await db.wmsInboundReceiptEvent.findUnique({
    where: {
      connector_externalEventId: {
        connector: 'mintsoft',
        externalEventId,
      },
    },
    select: { id: true, processedAt: true },
  })

  if (existing?.processedAt) {
    await logActivity({
      entityType: 'SYNC',
      entityId: existing.id,
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

  if (existing) {
    const event = await db.wmsInboundReceiptEvent.update({
      where: { id: existing.id },
      data: {
        externalAsnId,
        payload: payload as Prisma.InputJsonValue,
        processingError: null,
      },
      select: { id: true },
    })

    await logActivity({
      entityType: 'SYNC',
      entityId: event.id,
      tag: 'sync',
      action: 'mintsoft_webhook_event_updated',
      description: 'Updated pending Mintsoft ASN webhook event payload',
      metadata: { externalEventId, externalAsnId },
      resolveUser: false,
    })
  } else {
    try {
      const event = await db.wmsInboundReceiptEvent.create({
        data: {
          connector: 'mintsoft',
          externalEventId,
          externalAsnId,
          payload: payload as Prisma.InputJsonValue,
        },
        select: { id: true },
      })

      await logActivity({
        entityType: 'SYNC',
        entityId: event.id,
        tag: 'sync',
        action: 'mintsoft_webhook_event_created',
        description: 'Recorded Mintsoft ASN webhook event',
        metadata: { externalEventId, externalAsnId },
        resolveUser: false,
      })
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2002'
      ) {
        const concurrent = await db.wmsInboundReceiptEvent.findUnique({
          where: {
            connector_externalEventId: {
              connector: 'mintsoft',
              externalEventId,
            },
          },
          select: { processedAt: true },
        })

        if (concurrent?.processedAt) {
          await logActivity({
            entityType: 'SYNC',
            tag: 'sync',
            action: 'mintsoft_webhook_duplicate_ignored',
            description: 'Ignored duplicate Mintsoft ASN webhook after concurrent processing',
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
      } else {
        throw error
      }
    }
  }

  return NextResponse.json({
    accepted: true,
    externalEventId,
    externalAsnId,
  })
}
