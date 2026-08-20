import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
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
import { createMintsoftWebhookEventRepository } from '@/lib/jobs/wms/process-mintsoft-booked-in-event'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'

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

export type MintsoftBookedInWebhookRouteDependencies = {
  /** o3d-hl8l: the maintenance-mode fence. Injectable so the 503 path is unit-testable. */
  getMaintenanceModeResponse: (kind: 'cron' | 'webhook') => Promise<NextResponse | null>
  getMintsoftApiConfiguration: typeof getMintsoftApiConfiguration
  isIntegrationPluginEnabled: (plugin: 'mintsoft') => Promise<boolean>
  isUniqueConstraintError: (error: unknown) => boolean
  logActivity: typeof logActivity
  repository: MintsoftWebhookEventRepository
  now?: () => Date
  /**
   * o3d-hl8l r3 (Codex r2 finding 1): RECORD THAT A CALLBACK WAS REFUSED — without touching the
   * database, which is the one thing the fence exists to prevent.
   *
   * Round 2 left the refusal leaving no trace anywhere. The only thing that noticed was the WMS
   * watchdog, a day after the ETA at the earliest and seven days later when the ASN has no ETA, and
   * only if the WMS plugin is enabled and an active admin exists to notify. Between the refusal and
   * that alert there was nothing at all: no row, no log line, nothing an operator running a restore
   * could see even while standing over it.
   *
   * The server log is the only sink available here — persisting is what the fence refuses, and it
   * would mean writing rows from unauthenticated callers besides, since this runs before signature
   * verification. So the claim is deliberately small: the refusal is emitted at the moment it
   * happens, to the process log, and it is NOT an alert. The alert is still the watchdog's, and
   * `MAINTENANCE_MODE_REACH` in app/api/backup/restore/route.ts states its delay rather than
   * implying the loss is covered promptly.
   */
  recordMaintenanceRefusal: (detail: { route: string; reason: 'maintenance_mode' }) => void
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
  getMaintenanceModeResponse,
  getMintsoftApiConfiguration,
  isIntegrationPluginEnabled,
  isUniqueConstraintError(error) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  },
  logActivity,
  repository: createMintsoftWebhookEventRepository(),
  now: () => new Date(),
  recordMaintenanceRefusal(detail) {
    // console, NOT logActivity: logActivity writes a row, and a row written into this window is
    // being replayed over — which is the whole reason the callback is being refused.
    console.warn(
      `[mintsoft-webhook] refused an ASN booked-in callback (${detail.reason}) at ${detail.route} — `
        + 'the trigger is dropped unless the sender retries; recover it with "Re-check" on the ASN, '
        + 'which reconstructs the trigger and re-reads the quantities from the WMS',
    )
  },
}

export async function handleMintsoftBookedInWebhook(
  request: Request,
  dependencies: MintsoftBookedInWebhookRouteDependencies = defaultMintsoftBookedInWebhookDependencies,
) {
  // o3d-hl8l: MAINTENANCE-MODE FENCE. First statement, before the body is even read, so nothing
  // on this path can write while the flag is on — matching lib/connectors/woocommerce/webhooks.ts,
  // which is the only other inbound entry point that consults it.
  //
  // WHY REFUSE (503) RATHER THAN PERSIST-AND-DEFER (the o3d-56b shape used for the disabled
  // WooCommerce processing gate). The o3d-osl8 note recorded the choice as open, because a fenced
  // WooCommerce delivery is retried by WooCommerce and a dropped ASN callback may not be. Deciding
  // it needs one more fact: the ONLY caller that enables this flag is the backup RESTORE endpoint,
  // and the case it stays on for is a restore whose backend could not be confirmed dead. A row
  // written into that window is being replayed over — persisting would not save the event, it would
  // return `202 accepted` for a row the restore then destroys. A 503 makes no such promise and is
  // the standard retry signal, so a sender that retries at all is not lost.
  //
  // WHAT IS THEREFORE ACCEPTED, stated rather than implied: if the sender does NOT retry, the
  // booked-in TRIGGER is dropped. That is only defensible because the trigger can be RECREATED, and
  // an earlier revision of this comment claimed a recovery that did not exist — `replayDeadReceiptEvent`
  // and `replayMintsoftBookedInEventsForAsn` both re-drive rows that ALREADY EXIST, and a refused
  // callback leaves none, so neither could reach it. The wms-watchdog cron detected the loss (an
  // open ASN past its ETA with no callback) and then named no remedy.
  //
  // The recovery now exists: `enqueueMintsoftBookedInRecheckForAsn`, reachable from the ASN table on
  // the purchase order as "Re-check". It reconstructs the TRIGGER only — the webhook carries an ASN
  // id and nothing else that is used, and `processBookedInEvent` re-fetches the ASN from the WMS and
  // applies just the delta over what was already accounted. So the warehouse stays the authority for
  // the quantities, pressing it when nothing is outstanding books nothing in, and a real callback
  // arriving later finds the delta applied.
  //
  // WHY NOT PERSIST INSTEAD, weighed rather than asserted. Persisting returns `202 accepted` for a
  // row the restore may then destroy — the sender stops retrying AND the row is gone, which is a
  // lost trigger with the alarm switched off. A 503 at least leaves a retrying sender a path. And
  // decisively: this fence runs BEFORE signature verification (deliberately — see below), so
  // persisting here would mean creating receipt-event rows from unauthenticated callers. Verifying
  // first to make persistence safe would mean reading a 256KB body and doing HMAC work during a
  // restore window, and would let the flag's state be probed with a valid-signature oracle.
  //
  // Deliberately BEFORE signature verification, so a maintenance window cannot be probed for a
  // valid secret and a 256KB body is not read to be thrown away. That does disclose the flag's
  // state to an unauthenticated caller — the same trade the WooCommerce fence already makes.
  const maintenance = await dependencies.getMaintenanceModeResponse('webhook')
  if (maintenance) {
    // Emitted before the response is returned, and to the PROCESS LOG only — see
    // `recordMaintenanceRefusal`. Without it a refused callback left no trace whatsoever, and the
    // earliest anything noticed was the watchdog's overdue-ASN alert a day (or a week) later.
    dependencies.recordMaintenanceRefusal({
      route: 'app/api/webhooks/mintsoft/asn-booked-in',
      reason: 'maintenance_mode',
    })
    return maintenance
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

  if (!isMintsoftWebhookTimestampFresh(webhookTimestamp.date, dependencies.now?.() ?? new Date())) {
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
