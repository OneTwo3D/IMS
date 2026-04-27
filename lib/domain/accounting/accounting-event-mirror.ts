import { Prisma } from '@/app/generated/prisma/client'
import { roundMoney } from '@/lib/domain/math/decimal'
import {
  buildAccountingEvent,
  buildAccountingEventIdempotencyKey,
  buildAccountingEventLog,
} from './accounting-event-builder'
import {
  buildAccountingDocumentEvent,
  buildAccountingDocumentPayload,
  isAccountingDocumentEventType,
} from './accounting-document-event-builder'
import type { AccountingEventDraft, AccountingEventLine, AccountingEventStatus } from './accounting-event-types'
import { isIdempotencyKeyUniqueError } from './prisma-errors'

export type MirroredJournalAccountingSyncType =
  | 'DAILY_BATCH_REVENUE_DEFERRAL'
  | 'DAILY_BATCH_INVENTORY_ALLOC'
  | 'DAILY_BATCH_GROUP_B'
  | 'COGS_REVERSAL'
  | 'UNEARNED_REV_REVERSAL'

export type MirroredDocumentAccountingSyncType =
  | 'SALES_INVOICE'
  | 'CREDIT_NOTE'
  | 'PURCHASE_INVOICE'

export type MirroredAccountingSyncType = MirroredJournalAccountingSyncType | MirroredDocumentAccountingSyncType

type AccountingEventMirrorTransactionClient = Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingEventLog'>

export const MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
] as const

export const MIRRORED_ACCOUNTING_SYNC_TYPES = [
  ...MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES,
  'SALES_INVOICE',
  'CREDIT_NOTE',
  'PURCHASE_INVOICE',
] as const

const MIRRORED_JOURNAL_TYPES = new Set<string>(MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES)
const MIRRORED_TYPES = new Set<string>(MIRRORED_ACCOUNTING_SYNC_TYPES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function moneyValue(value: unknown, currency: string): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? roundMoney(value, currency).toNumber() : undefined
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {}
}

function extractJournalLines(payload: Record<string, unknown>, currency: string): AccountingEventLine[] | null {
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) return null

  const lines: AccountingEventLine[] = []
  for (const line of payload.lines) {
    if (!isRecord(line)) return null
    const accountCode = stringValue(line.accountCode)
    const description = stringValue(line.description)
    if (!accountCode || !description) return null
    const debit = moneyValue(line.debit, currency)
    const credit = moneyValue(line.credit, currency)

    lines.push({
      accountCode,
      description,
      ...(debit !== undefined ? { debit } : {}),
      ...(credit !== undefined ? { credit } : {}),
      ...(typeof line.taxType === 'string' || line.taxType === null ? { taxType: line.taxType } : {}),
      ...(isRecord(line.tracking) ? { tracking: line.tracking as AccountingEventLine['tracking'] } : {}),
      ...(isRecord(line.metadata) ? { metadata: line.metadata } : {}),
    })
  }

  return lines
}

function mapStatus(status: string | undefined): AccountingEventStatus {
  switch (status) {
    case 'SYNCED':
      return 'POSTED'
    case 'FAILED':
      return 'FAILED'
    default:
      return 'PENDING'
  }
}

function buildMirroredAccountingEventIdempotencyKey(params: {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
}): string | null {
  if (!isMirrorableAccountingSyncType(params.type)) return null

  const payload = normalizePayload(params.payload)
  const payloadIdempotencyKey = stringValue(payload._idempotencyKey)
  if (payloadIdempotencyKey) {
    return buildAccountingEventIdempotencyKey(['accounting-sync', params.connector, params.type, payloadIdempotencyKey])
  }

  const payloadDate = stringValue(payload.date)
  if (!payloadDate) return null

  return buildAccountingEventIdempotencyKey([
    'accounting-sync',
    params.connector,
    params.type,
    params.referenceType,
    params.referenceId,
    payloadDate,
  ])
}

export function isMirrorableAccountingSyncType(type: string): type is MirroredAccountingSyncType {
  return MIRRORED_TYPES.has(type)
}

function isMirrorableJournalAccountingSyncType(type: string): type is MirroredJournalAccountingSyncType {
  return MIRRORED_JOURNAL_TYPES.has(type)
}

export function buildMirroredAccountingEventDraft(params: {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
  currency: string
  status?: string
  externalId?: string | null
}): AccountingEventDraft | null {
  if (!isMirrorableAccountingSyncType(params.type)) return null

  if (isAccountingDocumentEventType(params.type)) {
    const idempotencyKey = buildMirroredAccountingEventIdempotencyKey(params)
    if (!idempotencyKey) return null

    const documentPayload = buildAccountingDocumentPayload({
      type: params.type,
      sourceEntityType: params.referenceType,
      sourceEntityId: params.referenceId,
      payload: params.payload,
      fallbackCurrency: params.currency,
    })

    return buildAccountingDocumentEvent({
      type: params.type,
      sourceEntityType: params.referenceType,
      sourceEntityId: params.referenceId,
      businessDate: documentPayload.date,
      currency: documentPayload.currency,
      status: mapStatus(params.status),
      idempotencyKey,
      payload: documentPayload,
      externalSystem: params.connector,
      externalId: params.externalId ?? null,
    })
  }

  if (!isMirrorableJournalAccountingSyncType(params.type)) return null

  const payload = normalizePayload(params.payload)
  const lines = extractJournalLines(payload, params.currency)
  if (!lines) return null

  const payloadDate = stringValue(payload.date)
  if (!payloadDate) return null
  const idempotencyKey = buildMirroredAccountingEventIdempotencyKey(params)
  if (!idempotencyKey) return null

  return buildAccountingEvent({
    type: params.type,
    sourceEntityType: params.referenceType,
    sourceEntityId: params.referenceId,
    businessDate: payloadDate,
    currency: params.currency,
    status: mapStatus(params.status),
    idempotencyKey,
    lines,
    externalSystem: params.connector,
    externalId: params.externalId ?? null,
  })
}

// Callers must pass the `tx` object from an enclosing db.$transaction so the
// mirrored event and its audit log commit or roll back with the sync log row.
export async function mirrorAccountingSyncLogToEvent(
  client: AccountingEventMirrorTransactionClient,
  params: Parameters<typeof buildMirroredAccountingEventDraft>[0],
): Promise<void> {
  const event = buildMirroredAccountingEventDraft(params)
  if (!event) return

  try {
    const created = await client.accountingEvent.create({
      data: event as never,
      select: { id: true },
    })
    await client.accountingEventLog.create({
      data: buildAccountingEventLog({
        accountingEventId: created.id,
        action: 'mirrored_from_sync_log',
        metadata: {
          connector: params.connector,
          syncType: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
        },
      }) as never,
    })
  } catch (error) {
    if (isIdempotencyKeyUniqueError(error)) return
    throw error
  }
}

export async function updateMirroredAccountingEventStatus(
  client: AccountingEventMirrorTransactionClient,
  params: {
    connector: string
    type: string
    referenceType: string
    referenceId: string
    payload: unknown
    status: AccountingEventStatus
    externalId?: string | null
    message?: string | null
  },
): Promise<void> {
  const idempotencyKey = buildMirroredAccountingEventIdempotencyKey(params)
  if (!idempotencyKey) return

  const event = await client.accountingEvent.update({
    where: { idempotencyKey },
    data: {
      status: params.status,
      ...(params.externalId !== undefined ? { externalId: params.externalId } : {}),
    },
    select: { id: true },
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return null
    throw error
  })
  if (!event) return

  await client.accountingEventLog.create({
    data: buildAccountingEventLog({
      accountingEventId: event.id,
      action: params.status === 'POSTED' ? 'posted_from_sync_log' : 'failed_from_sync_log',
      ...(params.message ? { message: params.message } : {}),
      metadata: {
        connector: params.connector,
        syncType: params.type,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        externalId: params.externalId ?? null,
      },
    }) as never,
  })
}

export async function resetMirroredAccountingEventsToPending(
  client: AccountingEventMirrorTransactionClient,
  params: {
    connector: string
    types: string[]
    referenceType: string
    referenceIds: string[]
  },
): Promise<void> {
  const types = params.types.filter(isMirrorableAccountingSyncType)
  const referenceIds = Array.from(new Set(params.referenceIds.filter((referenceId) => referenceId.trim())))
  if (types.length === 0 || referenceIds.length === 0) return

  const events = await client.accountingEvent.findMany({
    where: {
      externalSystem: params.connector,
      type: { in: types },
      sourceEntityType: params.referenceType,
      sourceEntityId: { in: referenceIds },
      status: 'FAILED',
    },
    select: {
      id: true,
      type: true,
      sourceEntityType: true,
      sourceEntityId: true,
    },
  })
  if (events.length === 0) return

  await client.accountingEvent.updateMany({
    where: { id: { in: events.map((event) => event.id) } },
    data: {
      status: 'PENDING',
      externalId: null,
    },
  })

  await client.accountingEventLog.createMany({
    data: events.map((event) => buildAccountingEventLog({
      accountingEventId: event.id,
      action: 'reset_from_sync_log',
      metadata: {
        connector: params.connector,
        syncType: event.type,
        referenceType: event.sourceEntityType,
        referenceId: event.sourceEntityId,
      },
    }) as never),
  })
}
