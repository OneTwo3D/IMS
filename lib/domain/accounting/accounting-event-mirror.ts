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
import { isExternalAccountingReferenceUniqueError, isIdempotencyKeyUniqueError } from './prisma-errors'
import { withSavepoint } from '@/lib/db/savepoint'

export type MirroredJournalAccountingSyncType =
  | 'DAILY_BATCH_REVENUE_DEFERRAL'
  | 'DAILY_BATCH_INVENTORY_ALLOC'
  | 'DAILY_BATCH_GROUP_B'
  | 'COGS_REVERSAL'
  | 'UNEARNED_REV_REVERSAL'

export type MirroredDocumentAccountingSyncType =
  | 'SALES_INVOICE'
  | 'SALES_INVOICE_UPDATE'
  | 'CREDIT_NOTE'
  | 'PURCHASE_INVOICE'
  | 'PURCHASE_INVOICE_UPDATE'

export type MirroredAccountingSyncType = MirroredJournalAccountingSyncType | MirroredDocumentAccountingSyncType

type AccountingEventMirrorTransactionClient = Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingEventLog'>

export const MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES = [
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  // cogs-audit scjz.60.4: mirror the inventory rounding-difference sweep so the
  // internal accounting-event ledger reflects the same correction posted to Xero.
  'DAILY_BATCH_INVENTORY_RECONCILIATION',
  // khdw: mirror the COGS rounding-difference sweep on the same basis.
  'DAILY_BATCH_COGS_RECONCILIATION',
  // 6oyu.4 (khdw): mirror the STOCK_IN_TRANSIT rounding-difference sweep likewise.
  'DAILY_BATCH_TRANSIT_RECONCILIATION',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
] as const

export const MIRRORED_ACCOUNTING_SYNC_TYPES = [
  ...MIRRORED_JOURNAL_ACCOUNTING_SYNC_TYPES,
  'SALES_INVOICE',
  'SALES_INVOICE_UPDATE',
  'CREDIT_NOTE',
  'PURCHASE_INVOICE',
  'PURCHASE_INVOICE_UPDATE',
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
  syncLogId?: string
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

  if (params.syncLogId?.trim()) {
    return buildAccountingEventIdempotencyKey(['accounting-sync-log', params.connector, params.syncLogId])
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
  syncLogId?: string
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
    // o3d-slrn: `client` is the CALLER's transaction and the catch below returns normally, so
    // the caller carries on issuing queries. Without a savepoint the duplicate-key abort would
    // roll back the sync log / outbox the caller believes it just queued. Both creates sit inside
    // one savepoint so the event and its log stay atomic.
    await withSavepoint(client, async () => {
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
          ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
          syncType: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
        },
        }) as never,
      })
    })
  } catch (error) {
    if (isIdempotencyKeyUniqueError(error)) return
    throw error
  }
}

/**
 * Sync types that REVISE an external document that already exists, mapped to the event types that
 * may legitimately be holding that document's external id when the revision posts.
 *
 * A Xero `updateSalesInvoice` returns the SAME InvoiceID as the original post, so the revision's
 * mirrored event and the event it revises compete for one `(externalSystem, externalId)` row —
 * see `supersedePriorDocumentRevision`. `SALES_INVOICE_UPDATE` may follow the original
 * `SALES_INVOICE` *or* an earlier `SALES_INVOICE_UPDATE`, because a document can be revised any
 * number of times (each edit hashes to its own sync log, and so to its own mirrored event).
 */
const DOCUMENT_REVISION_PREDECESSOR_TYPES: Record<string, readonly string[]> = {
  SALES_INVOICE_UPDATE: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'],
  PURCHASE_INVOICE_UPDATE: ['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE'],
}

/** Does this sync type revise an existing external document rather than create a new one? */
export function isDocumentRevisionAccountingSyncType(type: string): boolean {
  return type in DOCUMENT_REVISION_PREDECESSOR_TYPES
}

/**
 * o3d-cvj9: hand a document's external id from the event that last described it to the revision
 * that now does, so the revision can reach POSTED.
 *
 * `accounting_events` is `@@unique([externalSystem, externalId])` — at most one event row may
 * claim an external document. That is the right invariant (two events claiming one Xero invoice is
 * a double post), but it means a revision cannot simply also record the id: the update raises
 * P2002 and, before this, took the entire enclosing transaction down with it, so a remotely
 * SUCCESSFUL invoice update was recorded locally as a failure and retried to FAILED.
 *
 * The claim therefore MOVES: the row that held the id becomes SUPERSEDED with a null externalId
 * (its payload and its log stay, so the revision chain is still readable), and the revision takes
 * the id together with the payload that matches what the ledger now holds.
 *
 * Returns the superseded event's id, or `null` when nothing may legitimately be superseded — a
 * holder for a DIFFERENT source document, an unrelated event type, a non-POSTED transition, or a
 * caller that was not writing an external id at all. `null` keeps the P2002 fatal, so a genuine
 * cross-document collision is never silently absorbed into a no-op.
 */
async function supersedePriorDocumentRevision(
  client: AccountingEventMirrorTransactionClient,
  params: { connector: string; type: string; referenceType: string; referenceId: string; status: AccountingEventStatus; externalId?: string | null },
): Promise<string | null> {
  const externalId = params.externalId?.trim() ? params.externalId : null
  // Only a successful post owns a document id, and only a revision may take one over.
  if (!externalId || params.status !== 'POSTED') return null
  const predecessorTypes = DOCUMENT_REVISION_PREDECESSOR_TYPES[params.type]
  if (!predecessorTypes) return null

  const holder = await client.accountingEvent.findUnique({
    where: { externalSystem_externalId: { externalSystem: params.connector, externalId } },
    select: { id: true, type: true, sourceEntityType: true, sourceEntityId: true },
  })
  if (!holder) return null
  // The holder must be an earlier revision of the SAME source document. Anything else sharing an
  // external id is the duplicate-post the unique index exists to catch.
  if (holder.sourceEntityType !== params.referenceType || holder.sourceEntityId !== params.referenceId) return null
  if (!predecessorTypes.includes(holder.type)) return null

  // Compare-and-swap on the id we are taking, not just on the row: if a concurrent worker released
  // or moved this claim between the read and here, we must not stamp SUPERSEDED over whatever it
  // did. `count === 0` leaves the P2002 fatal, and the sync log retries against the new reality.
  const released = await client.accountingEvent.updateMany({
    where: { id: holder.id, externalSystem: params.connector, externalId },
    data: { status: 'SUPERSEDED', externalId: null },
  })
  if (released.count === 0) return null

  return holder.id
}

export async function updateMirroredAccountingEventStatus(
  client: AccountingEventMirrorTransactionClient,
  params: {
    connector: string
    syncLogId?: string
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

  async function applyStatus(key: string) {
    return client.accountingEvent.update({
      where: { idempotencyKey: key },
      data: {
        status: params.status,
        ...(params.externalId !== undefined ? { externalId: params.externalId } : {}),
      },
      select: { id: true },
    })
  }

  async function updateByIdempotencyKey(key: string) {
    try {
      // o3d-cvj9: the SAVEPOINT is what makes the catch below usable at all. `client` is the
      // CALLER's interactive transaction (the same one that just marked the sync log SYNCED);
      // Postgres aborts the whole transaction on the unique violation, so without the savepoint
      // every statement after the catch fails with 25P02 and the COMMIT cannot succeed. Verified
      // live against onetwo3d_ims_dev: catching the P2002 unguarded makes the very next read fail
      // with "current transaction is aborted, commands ignored until end of transaction block".
      return await withSavepoint(client, () => applyStatus(key))
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return null
      // Classified from the statement that RAISED it, not inferred from where we are: the only
      // other unique constraint on accounting_events is idempotencyKey, which this statement does
      // not write.
      if (!isExternalAccountingReferenceUniqueError(error)) throw error

      const supersededEventId = await supersedePriorDocumentRevision(client, params)
      // Nothing legitimate to supersede: this is a real collision (a different document claiming
      // an external id that is already spoken for), so it must stay fatal and visible.
      if (supersededEventId === null) throw error

      const event = await withSavepoint(client, () => applyStatus(key))
      await client.accountingEventLog.create({
        data: buildAccountingEventLog({
          accountingEventId: supersededEventId,
          action: 'superseded_by_revision',
          metadata: {
            connector: params.connector,
            ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
            syncType: params.type,
            referenceType: params.referenceType,
            referenceId: params.referenceId,
            externalId: params.externalId ?? null,
            supersededByEventId: event.id,
          },
        }) as never,
      })
      return event
    }
  }

  let event = await updateByIdempotencyKey(idempotencyKey)
  if (!event && params.syncLogId) {
    const legacyIdempotencyKey = buildMirroredAccountingEventIdempotencyKey({
      connector: params.connector,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload: params.payload,
    })
    if (legacyIdempotencyKey && legacyIdempotencyKey !== idempotencyKey) {
      event = await updateByIdempotencyKey(legacyIdempotencyKey)
    }
  }

  if (!event) return

  await client.accountingEventLog.create({
    data: buildAccountingEventLog({
      accountingEventId: event.id,
      action: params.status === 'POSTED' ? 'posted_from_sync_log' : 'failed_from_sync_log',
      ...(params.message ? { message: params.message } : {}),
      metadata: {
        connector: params.connector,
        ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
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

/**
 * Terminalise (VOID) the mirrored events for an order's not-yet-posted documents — used when the order
 * is cancelled, so a never-shipped sale leaves no dangling PENDING/FAILED event that reconciliation
 * would otherwise treat as work still owed. Only un-posted events (PENDING/FAILED) are voided; an
 * already-POSTED event is left for the normal reversal path (a cancel of a dispatched order is blocked
 * upstream, so this should not arise). Mirror of resetMirroredAccountingEventsToPending, opposite way.
 */
export async function voidMirroredAccountingEventsForOrder(
  client: AccountingEventMirrorTransactionClient,
  params: { types: string[]; referenceType: string; referenceId: string; reason?: string },
): Promise<void> {
  const types = params.types.filter(isMirrorableAccountingSyncType)
  if (types.length === 0 || !params.referenceId.trim()) return

  const events = await client.accountingEvent.findMany({
    where: {
      type: { in: types },
      sourceEntityType: params.referenceType,
      sourceEntityId: params.referenceId,
      status: { in: ['PENDING', 'FAILED'] },
    },
    select: { id: true, type: true, sourceEntityType: true, sourceEntityId: true },
  })
  if (events.length === 0) return

  // Compare-and-swap: re-assert status IN (PENDING, FAILED) in the update itself, not just the read. A
  // concurrent worker can flip one of these events to POSTED (with an external id) between the findMany
  // and here; without the predicate we would clobber that real post to VOID and lose its id. `count` is
  // the rows we actually voided, so only those get an audit log.
  const voidableIds = events.map((event) => event.id)
  const updated = await client.accountingEvent.updateMany({
    where: { id: { in: voidableIds }, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'VOID', externalId: null },
  })
  if (updated.count === 0) return

  // Re-read to log exactly the events that ended up VOID (the CAS may have skipped a now-POSTED one).
  const voided = await client.accountingEvent.findMany({
    where: { id: { in: voidableIds }, status: 'VOID' },
    select: { id: true, type: true, sourceEntityType: true, sourceEntityId: true },
  })
  await client.accountingEventLog.createMany({
    data: voided.map((event) => buildAccountingEventLog({
      accountingEventId: event.id,
      action: 'voided_source_cancelled',
      metadata: {
        syncType: event.type,
        referenceType: event.sourceEntityType,
        referenceId: event.sourceEntityId,
        reason: params.reason ?? 'source order cancelled',
      },
    }) as never),
  })
}
