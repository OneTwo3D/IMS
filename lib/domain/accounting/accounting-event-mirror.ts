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

export type AccountingEventMirrorTransactionClient = Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingEventLog'>

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
 * The DOCUMENT REVISION FAMILIES: the sync type that CREATES an external document, mapped to the
 * sync types that REVISE that same document afterwards.
 *
 * A Xero `updateSalesInvoice` returns the SAME InvoiceID as the original post, so the revision's
 * mirrored event and the event it revises compete for one `(externalSystem, externalId)` row —
 * see `resolveDocumentRevisionExternalIdClaim`. A document can be revised any number of times
 * (each edit hashes to its own sync log, and so to its own mirrored event), so a revision may
 * follow the original create *or* an earlier revision of the same family.
 *
 * ONE TABLE, because three things have to agree about what a family is and they are read in three
 * different files: the takeover's lineage guard, the "is this a revision?" predicate, and
 * reconciliation's duplicate-reference exemption. Deriving all three from here is what keeps
 * reconciliation from exempting a pairing the mirror would refuse.
 */
const DOCUMENT_REVISION_FAMILIES: Record<string, readonly string[]> = {
  SALES_INVOICE: ['SALES_INVOICE_UPDATE'],
  PURCHASE_INVOICE: ['PURCHASE_INVOICE_UPDATE'],
}

/** Revision type -> the event types that may legitimately hold the document id when it posts. */
const DOCUMENT_REVISION_PREDECESSOR_TYPES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(DOCUMENT_REVISION_FAMILIES).flatMap(([createType, revisionTypes]) =>
    revisionTypes.map((revisionType) => [revisionType, [createType, ...revisionTypes]] as const),
  ),
)

/** Every type in a family (create and revisions alike) -> the family's key, its CREATE type. */
const DOCUMENT_REVISION_FAMILY_BY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DOCUMENT_REVISION_FAMILIES).flatMap(([createType, revisionTypes]) => [
    [createType, createType] as const,
    ...revisionTypes.map((revisionType) => [revisionType, createType] as const),
  ]),
)

/** Does this sync type revise an existing external document rather than create a new one? */
export function isDocumentRevisionAccountingSyncType(type: string): boolean {
  return type in DOCUMENT_REVISION_PREDECESSOR_TYPES
}

/**
 * Which document-revision family this sync type belongs to, or `null` for a type that neither
 * creates nor revises a revisable document (a journal batch, a credit note, ...).
 *
 * Two logs may only share one external reference when they are in the SAME family: a sales invoice
 * and a purchase bill are different documents in the ledger however their source rows are keyed,
 * so one Xero id across both is a real duplicate whatever the source entity says. This is the same
 * lineage rule `resolveDocumentRevisionExternalIdClaim` enforces when it refuses to take an id from
 * an unrelated event type — exported so reconciliation cannot drift laxer than the mirror.
 */
export function accountingDocumentRevisionFamily(type: string): string | null {
  return DOCUMENT_REVISION_FAMILY_BY_TYPE[type] ?? null
}

/**
 * o3d-cvj9 r3: WHICH OF TWO EVENTS DESCRIBES THE DOCUMENT AS IT NOW STANDS.
 *
 * Round 2 answered this from `accounting_events.createdAt`, arguing that a mirrored event is
 * written at ENQUEUE and so a document's edits are stamped in edit order. THAT IS NOT WHAT THE
 * COLUMN CONTAINS. Its default is `CURRENT_TIMESTAMP`, and in PostgreSQL that is TRANSACTION START
 * time, not the time the row was written — verified against onetwo3d_ims_dev in a rolled-back
 * transaction: after `pg_sleep(0.75)`, a row inserted with `DEFAULT now()` came back stamped
 * `clock_timestamp() - created_at = 00:00:00.774525` in the past, and `created_at =
 * transaction_timestamp()` was true. So an enqueue inside a long-running transaction carries an
 * EARLIER stamp than an enqueue that began and committed after it, and the ordering is neither
 * edit order nor even enqueue order. The row-`id` tie-break r2 layered on top ordered by cuid mint
 * time, which is the same quantity measured a different way, so it went with it.
 *
 * There are exactly two things we can say truthfully about which of two events describes the
 * document now, and this function says only those two:
 *
 * 1. THE CREATE ALWAYS PRECEDES ITS REVISIONS. A document cannot be revised before it exists, so
 *    the event that CREATED it cannot describe a later state than an event that revises it. No
 *    clock is involved and none is needed. This is the ordinary create -> first-edit handover, so
 *    it keeps working for every document whose create predates the `externalRevisionAt` column.
 *    (A replayed create never re-applies an edit after the fact: the processor short-circuits a
 *    sync log that already carries an external id without calling the connector, and a genuine
 *    replay that does call it goes out under the same Xero idempotency key, which returns the
 *    original record rather than writing a new revision.)
 *
 * 2. REVISION AGAINST REVISION IS ORDERED BY THE EXTERNAL SYSTEM, OR NOT AT ALL. Xero stamps
 *    `Invoice.UpdatedDateUTC` on the document as it applies each write and hands it back in the
 *    response to that write. Two writes to one invoice are serialised by Xero, against one clock,
 *    so those stamps are the order in which the edits were APPLIED — which is the only order that
 *    decides what the document says. `externalRevisionAt` carries that value and nothing else; it
 *    is never derived from a local clock, because a comparison key mixing two clocks is not a key.
 *
 * Anything else is `null` — NOT ORDERED. A missing stamp on either side (the row predates the
 * column, the connector returned none, an administrative backfill wrote the row) and an exact tie
 * both land here. `null` is refused by the caller, which keeps the underlying P2002 fatal: the sync
 * log retries and an operator sees it, rather than a stale revision quietly taking the document id.
 *
 * Returns true when the HOLDER is the earlier write and may hand its claim over, false when the
 * holder is the later one (the arriving row is a stale replay), `null` when the two are not ordered.
 */
function documentRevisionHolderPrecedes(
  holder: { type: string; externalRevisionAt: Date | null },
  arriving: { externalRevisionAt?: Date | null },
  createType: string,
): boolean | null {
  // Rule 1: the holder is the document's CREATE, and the arriving row revises it.
  if (holder.type === createType) return true

  // Rule 2: two revisions of one document — only the external system's stamp orders them.
  const holderAt = holder.externalRevisionAt?.getTime()
  const arrivingAt = arriving.externalRevisionAt?.getTime()
  if (holderAt === undefined || arrivingAt === undefined) return null
  if (!Number.isFinite(holderAt) || !Number.isFinite(arrivingAt)) return null
  if (holderAt === arrivingAt) return null
  return holderAt < arrivingAt
}

/**
 * What may be done with an external document id that another event row already holds.
 *
 * `refused` carries the SPECIFIC reason rather than a bare no: every refusal keeps the underlying
 * P2002 fatal, and which one fired is the difference between "a second document is claiming this
 * invoice" and "we could not tell these two revisions apart".
 */
export type DocumentRevisionClaimOutcome =
  | { claim: 'takeover'; supersededEventId: string }
  | { claim: 'stale'; holderEventId: string }
  | {
      claim: 'refused'
      reason:
        | 'not_a_revision_claim'
        | 'no_holder'
        | 'different_source_document'
        | 'unrelated_event_type'
        | 'recency_indeterminate'
        | 'claim_moved_concurrently'
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
 * On `takeover` the claim MOVES: the row that held the id becomes SUPERSEDED with a null
 * externalId (its payload and its log stay, so the revision chain is still readable), and the
 * caller writes the id onto the arriving revision.
 *
 * o3d-cvj9 r2 — `stale` IS THE OTHER HALF, and r1 did not have it. r1 established that the holder
 * was a legitimate PREDECESSOR TYPE for the same document, but never that the arriving revision
 * described a LATER state than it (see `documentRevisionHolderPrecedes` for the two things that
 * can be said truthfully about that). Two workers can have their writes land at Xero in one order
 * and record them in the other, so a revision whose write landed FIRST can arrive here after the
 * one that landed second has already taken the id — and it would take it straight back, leaving
 * the mirror naming an overwritten edit as the document's current state. A stale arrival takes
 * nothing: the caller records it as SUPERSEDED without the id, which is what it truthfully is.
 *
 * Everything else is `refused`, which keeps the P2002 fatal — a genuine cross-document collision is
 * never silently absorbed into a no-op, and neither is a pair we cannot order.
 */
export async function resolveDocumentRevisionExternalIdClaim(
  client: AccountingEventMirrorTransactionClient,
  params: { connector: string; type: string; referenceType: string; referenceId: string; status: AccountingEventStatus; externalId?: string | null },
  // The external system's revision stamp for the write this arrival just made, when it made one.
  // Absent for the administrative backfill, which is repairing a historical post whose connector
  // response was never recorded — see `documentRevisionHolderPrecedes` rule 2.
  arriving: { externalRevisionAt?: Date | null },
): Promise<DocumentRevisionClaimOutcome> {
  const externalId = params.externalId?.trim() ? params.externalId : null
  // Only a successful post owns a document id, and only a revision may take one over.
  if (!externalId || params.status !== 'POSTED') return { claim: 'refused', reason: 'not_a_revision_claim' }
  const predecessorTypes = DOCUMENT_REVISION_PREDECESSOR_TYPES[params.type]
  const createType = DOCUMENT_REVISION_FAMILY_BY_TYPE[params.type]
  if (!predecessorTypes || !createType) return { claim: 'refused', reason: 'not_a_revision_claim' }

  const holder = await client.accountingEvent.findUnique({
    where: { externalSystem_externalId: { externalSystem: params.connector, externalId } },
    select: { id: true, type: true, sourceEntityType: true, sourceEntityId: true, externalRevisionAt: true },
  })
  if (!holder) return { claim: 'refused', reason: 'no_holder' }
  // The holder must be an earlier revision of the SAME source document. Anything else sharing an
  // external id is the duplicate-post the unique index exists to catch.
  if (holder.sourceEntityType !== params.referenceType || holder.sourceEntityId !== params.referenceId) {
    return { claim: 'refused', reason: 'different_source_document' }
  }
  if (!predecessorTypes.includes(holder.type)) return { claim: 'refused', reason: 'unrelated_event_type' }

  const holderPrecedes = documentRevisionHolderPrecedes(holder, arriving, createType)
  if (holderPrecedes === null) return { claim: 'refused', reason: 'recency_indeterminate' }
  if (!holderPrecedes) return { claim: 'stale', holderEventId: holder.id }

  // Compare-and-swap on the id we are taking, not just on the row: if a concurrent worker released
  // or moved this claim between the read and here, we must not stamp SUPERSEDED over whatever it
  // did. A refusal leaves the P2002 fatal, and the sync log retries against the new reality.
  //
  // This is also what protects the recency decision from a concurrent NEWER revision: taking the
  // claim is exactly what nulls the holder's `externalId`, so a winner between the two statements
  // makes this predicate match nothing and the loser re-reads the new reality on its retry.
  const released = await client.accountingEvent.updateMany({
    where: { id: holder.id, externalSystem: params.connector, externalId },
    data: { status: 'SUPERSEDED', externalId: null },
  })
  if (released.count === 0) return { claim: 'refused', reason: 'claim_moved_concurrently' }

  return { claim: 'takeover', supersededEventId: holder.id }
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
    /**
     * o3d-cvj9 r3: the EXTERNAL system's revision stamp for the write this attempt just made —
     * Xero's `Invoice.UpdatedDateUTC`, out of the response to that write. It is recorded because it
     * is the only thing that orders two revisions of one document (see
     * `documentRevisionHolderPrecedes`), and it is left undefined whenever no write was made in
     * this attempt or the connector returned none. It is never synthesised from a local clock.
     */
    externalRevisionAt?: Date | null
    message?: string | null
  },
): Promise<void> {
  const idempotencyKey = buildMirroredAccountingEventIdempotencyKey(params)
  if (!idempotencyKey) return

  async function applyStatus(
    key: string,
    // o3d-cvj9 r2: the STALE path records the same transition without claiming the document id,
    // because a newer revision already holds it. Both overrides are set together and only there.
    override?: { status: AccountingEventStatus; claimExternalId: false },
  ) {
    return client.accountingEvent.update({
      where: { idempotencyKey: key },
      data: {
        status: override?.status ?? params.status,
        ...(params.externalId !== undefined && override?.claimExternalId !== false
          ? { externalId: params.externalId }
          : {}),
        // The stamp is a true fact about THIS row's write whether or not the row keeps the claim,
        // so the stale path records it too — it is what a later comparison against this row needs.
        ...(params.externalRevisionAt !== undefined ? { externalRevisionAt: params.externalRevisionAt } : {}),
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

      // o3d-cvj9 r3: WHICH revision describes the document has to be established, not assumed —
      // and the arriving half of that comparison is the stamp the connector returned for the write
      // this attempt just made, which the caller already holds. r2 re-read the arriving ROW here to
      // get its `createdAt`; that column is `DEFAULT CURRENT_TIMESTAMP`, i.e. transaction START
      // time, so it never carried the ordering it was read for. The read goes with it.
      const claim = await resolveDocumentRevisionExternalIdClaim(client, params, {
        externalRevisionAt: params.externalRevisionAt,
      })
      // Nothing legitimate to supersede: this is a real collision (a different document claiming
      // an external id that is already spoken for), or two revisions we cannot order. Either way it
      // must stay fatal and visible.
      if (claim.claim === 'refused') throw error

      if (claim.claim === 'stale') {
        // A NEWER revision of this document already holds the id. This edit did post remotely, but
        // it no longer describes the ledger, so it is recorded for what it is — SUPERSEDED, with no
        // claim on the document — instead of yanking the id back off the revision that supersedes
        // it. Idempotent: a further replay finds the row already in exactly this state.
        const event = await withSavepoint(client, () => applyStatus(key, { status: 'SUPERSEDED', claimExternalId: false }))
        await client.accountingEventLog.create({
          data: buildAccountingEventLog({
            accountingEventId: event.id,
            action: 'revision_superseded_by_newer',
            metadata: {
              connector: params.connector,
              ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
              syncType: params.type,
              referenceType: params.referenceType,
              referenceId: params.referenceId,
              externalId: params.externalId ?? null,
              externalIdHeldByEventId: claim.holderEventId,
            },
          }) as never,
        })
        return event
      }

      const event = await withSavepoint(client, () => applyStatus(key))
      await client.accountingEventLog.create({
        data: buildAccountingEventLog({
          accountingEventId: claim.supersededEventId,
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
