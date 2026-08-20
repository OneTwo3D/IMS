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

/**
 * The idempotency key a sync log's mirrored event is derived from — the row's IDENTITY, and the
 * only thing that answers "is THIS sync log mirrored?" rather than "does its document have some
 * event of this type?". o3d-cvj9 r5: exported because the administrative backfill has to ask the
 * first question about a document revision, where the second one is not the same question (a
 * document is revised many times, and every edit is its own sync log and its own event).
 */
export function buildMirroredAccountingEventIdempotencyKey(params: {
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

/**
 * EVERY idempotency key `updateMirroredAccountingEventStatus` would try for these params, in the
 * order it tries them: the primary key (which prefers the payload's `_idempotencyKey`, then the
 * sync-log id) and the legacy, syncLogId-less key it falls back to when the primary matches no
 * event. Empty for a non-mirrorable type — nothing is mirrored, so nothing can be touched.
 *
 * Exported because mirror identity is LOGICAL: two attempts at the same document share a key, so a
 * caller that is about to terminalise a mirror needs to know whether the event it is about to write
 * actually belongs to the row it is settling (o3d-nf9i / findMirrorOwnershipConflict). Both key
 * forms count: the payload branch is shared by construction, and the legacy
 * `<connector>:<type>:<ref>:<date>` form is shared by every attempt on the same day.
 */
export function mirroredAccountingEventIdempotencyKeys(params: {
  syncLogId?: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
}): string[] {
  const primary = buildMirroredAccountingEventIdempotencyKey(params)
  const legacy = buildMirroredAccountingEventIdempotencyKey({ ...params, syncLogId: undefined })
  return [...new Set([primary, legacy].filter((key): key is string => typeof key === 'string' && key.length > 0))]
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
 * o3d-cvj9 r4: every sync type that REVISES the document a family's CREATE type posted.
 *
 * Read by the administrative backfill, which has to ask "how many revisions of this document could
 * already have posted?" against the sync-log table rather than against whatever happens to be in
 * the batch in front of it (see `findContestedRevisionDocuments`). Derived from the SAME family
 * table as the mirror's lineage guard and reconciliation's exemption, so a family added in one
 * place cannot be missed by the other two.
 */
export function accountingDocumentRevisionSyncTypes(family: string): readonly string[] {
  return DOCUMENT_REVISION_FAMILIES[family] ?? []
}

/**
 * o3d-cvj9 r4: `accounting_events.revisionOrderBasis` for a row the ADMINISTRATIVE BACKFILL wrote.
 *
 * It is a CATEGORY, never a clock, and it records one specific provable fact about the row:
 *
 *   the write this row mirrors had ALREADY been recorded complete on its sync log when the backfill
 *   selected it.
 *
 * o3d-cvj9 r5: that is the WHOLE fact, and it is the whole of what this marker may be read for.
 * Round 4 leaned a second half on it — "and the backfill only selects a document with no mirrored
 * revision event at all" — which was untrue of the candidate scan; that half is gone.
 *
 * o3d-cvj9 r6 (Codex r5 finding 2): AND THE FACT DOES NOT ORDER THIS ROW AGAINST AN ARRIVING WRITE.
 * r4 argued it did: the rule it supports (rule 3 in `resolveDocumentRevisionOrder`) fires only
 * against an arrival carrying a live external stamp, "i.e. a write the connector is making NOW",
 * and now is after then. What is happening now is the RECORDING of that write, not the write. A
 * sync log is recorded when its transaction commits, which can be long after the connector call it
 * reports — a retry, a re-queued dead letter, a worker that posted and died before committing. The
 * arrival's stamp says when Xero applied it; this row has no stamp at all, so nothing places the
 * two against each other. Rule 3 therefore ASSUMES the order it returns, and says so: its verdict
 * carries basis `historical_repair_precedes_live_write` and `established: false`, and a caller that
 * has an alternative to acting on it (the backfill does; the live mirror does not) declines.
 *
 * It is written ONLY on a row the backfill actually lets CLAIM the document (a POSTED draft that
 * keeps the external id its sync log recorded) — see `writeBackfilledEvent`. A row repaired without
 * a claim asserts nothing about the document's edit order and must not carry a marker saying it
 * does, because such a row can later be driven to POSTED by the live mirror and would then hold the
 * id while still labelled a historical repair.
 *
 * And it is CLEARED by live operation: the moment `updateMirroredAccountingEventStatus` records a
 * connector write on the row, the marker is replaced by that write's stamp (or by
 * `live_write_unstamped`). A backfill artefact that no live operation could ever clear would be a
 * permanent fixture of the ledger written by an administrative repair, which is its own defect
 * whatever it says.
 */
export const HISTORICAL_BACKFILL_REVISION_ORDER_BASIS = 'historical_backfill_repair'

/**
 * o3d-cvj9 r5 (Codex r4 finding 4): `accounting_events.revisionOrderBasis` for a row that MADE A
 * CONNECTOR WRITE WHOSE TIME WE DO NOT KNOW.
 *
 * Round 4 answered "a replayed create cannot re-apply itself over an edit" by comparing external
 * stamps before the create rule. That is necessary and not sufficient, because it assumes a replay
 * that re-applied the create came back with a stamp. XERO'S `Idempotency-Key` IS RETAINED FOR SIX
 * MINUTES. Past that window the same request is a fresh one, and `POST /Invoices` carrying an
 * `InvoiceNumber` that already exists UPDATES that invoice (which is why invoice-number ownership
 * is its own piece of work — o3d-batch-invnum). So a create re-posted more than six minutes later
 * genuinely writes itself over an edit that landed in between; and if that response carries no
 * readable `UpdatedDateUTC`, the mirror recorded `externalRevisionAt: null` — WIPING whatever stamp
 * the row had — and a null stamp on a create is exactly what rule 2 reads as "this create has made
 * no write of its own, so it precedes every revision of the document". The overwritten edit would
 * then take the document id off the write that overwrote it.
 *
 * The wipe is right: a stamp from an earlier write no longer describes this row's latest write. It
 * is reading the wipe as "never wrote" that is wrong, and the two are only distinguishable if the
 * write is recorded. This value records it.
 *
 * o3d-cvj9 r6 (Codex r5 finding 1): AND THAT IS ALL IT RECORDS — one write, of unknown time. It is
 * NOT evidence of a late replay. r5 read it as one and made rule 2 refuse on it, which classifies
 * the ordinary case as the rare one: this marker is written by EVERY unstamped live write on the
 * row, and the write that leaves it in the overwhelming majority of cases is the create's own first
 * post, whose Xero response simply carried no readable `UpdatedDateUTC` (`xeroDocumentRevisionAt`
 * returns null for anything it cannot parse). Nothing on the row separates that from a re-post: both
 * leave a POSTED create with no stamp and one recorded write. And a create makes no further write,
 * so nothing ever clears the marker — under r5 every later edit of such a document was refused FOR
 * EVER. Rule 2 still answers "the create precedes", and now says the answer is ASSUMED.
 */
export const LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS = 'live_write_unstamped'

/**
 * The basis a LIVE write leaves on the row it wrote. o3d-cvj9 r5: a stamped write clears the field
 * — the stamp is now the basis, and any category the row was created with (an administrative
 * repair, an earlier unstamped write) is spent. That is what stops a backfill artefact outliving
 * live operation on the row.
 */
export function revisionOrderBasisForLiveWrite(externalRevisionAt: Date | null): string | null {
  return finiteRevisionStamp(externalRevisionAt) === null ? LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS : null
}

/**
 * o3d-cvj9 r3: WHICH OF TWO EVENTS DESCRIBES THE DOCUMENT AS IT NOW STANDS — AND HOW WE KNOW.
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
 * o3d-cvj9 r6 (Codex r5 findings 1-3): THE VERDICT CARRIES ITS BASIS. Only rule 1 reads the order
 * off the external system's own record of it. Rules 2 and 3 reach an answer by FALLING BACK on what
 * a row with no usable stamp most likely is, and rule 4 is not an ordering at all. An answer reached
 * by falling back is a materially weaker claim than the same answer read off Xero's stamps, so it is
 * no longer returned as if it were the same thing: every verdict names the basis it was reached on
 * and whether that basis ESTABLISHES the order or merely assumes it, and a caller acting on an
 * assumed one can name which it got. The live mirror acts on an assumed order — its only
 * alternative is to fail a sync log for ever — and records the basis on the audit trail. The
 * administrative backfill does not: it has an unclaimed repair to write instead, so it declines
 * (`acceptAssumedOrder: false`).
 *
 * 1. THE EXTERNAL SYSTEM'S OWN STAMPS, WHENEVER BOTH SIDES HAVE ONE — the one ESTABLISHED basis.
 *    Xero stamps `Invoice.UpdatedDateUTC` on the document as it applies each write and hands it back
 *    in the response to that write. Two writes to one invoice are serialised by Xero, against one
 *    clock, so those stamps are the order in which the edits were APPLIED — which is the only order
 *    that decides what the document says. `externalRevisionAt` carries that value and nothing else;
 *    it is never derived from a local clock, because a comparison key mixing two clocks is not a key.
 *
 *    o3d-cvj9 r4 (Codex r3 finding 4): this rule is checked FIRST, including when the holder is the
 *    document's CREATE. r3 short-circuited on the holder's TYPE before ever looking at the stamps,
 *    on the argument that a replayed create can never re-apply itself after an edit: the processor
 *    short-circuits a sync log that already carries an external id without calling the connector,
 *    and a genuine replay that does call it goes out under the same Xero `Idempotency-Key`, which
 *    returns the original record. THE SECOND HALF OF THAT IS NOT A GUARANTEE. Xero honours an
 *    idempotency key for SIX MINUTES; past that window the same request is a fresh one, and
 *    `POST /Invoices` carrying an `InvoiceNumber` that already exists UPDATES that invoice. So a
 *    create whose sync log is re-claimed and re-posted more than six minutes later DOES write the
 *    create's content over an edit that landed in between — and Xero stamps that write, so the
 *    create row ends up carrying a LATER `externalRevisionAt` than the revision it overwrote.
 *    Comparing the stamps first is what keeps rule 2 from deciding a pair the stamps can decide.
 *
 * 2. THE CREATE PRECEDES ITS REVISIONS — as the fallback, when the stamps cannot answer. A document
 *    cannot be revised before it exists, so the event that CREATED it cannot describe a later state
 *    than an event that revises it. No clock is involved and none is needed. This is what carries
 *    the ordinary create -> first-edit handover for every document whose create predates the
 *    `externalRevisionAt` column, and for any live write whose response carried no readable stamp.
 *
 *    o3d-cvj9 r7 (Codex r6, HIGH): it does NOT carry the processor's short-circuit path, and saying
 *    so here was the defect. That path makes no connector call, so rule 4 answers it — and rule 4 is
 *    therefore asked BEFORE this one. While it was asked after, this rule handed a short-circuit
 *    replay the create's claim on the strength of "a document cannot be revised before it exists",
 *    which is true and is not a licence to move a claim to an attempt that wrote nothing.
 *
 *    It applies only while the holding CREATE has NO stamp of its own. A stamped create has made a
 *    write this code can see the time of; if the arriving revision brings no stamp to compare it
 *    with, there is nothing to decide the pair on and it is refused rather than assumed.
 *
 *    o3d-cvj9 r6 (Codex r5 finding 1): a create that made an UNTIMED write is still read this way,
 *    but the verdict is marked ASSUMED (`create_precedes_untimed_write`) rather than declared. r5
 *    refused it outright, reading `live_write_unstamped` as evidence of a re-post past the
 *    six-minute window that may have overwritten the arriving edit. That is a real possibility, and
 *    a rare one, and it is NOT what the marker says: the same marker is left by the create's own
 *    first post whenever Xero's response carried no readable stamp, which is the ordinary case, and
 *    nothing on the row tells the two apart. Refusing therefore misclassified the common case as the
 *    rare one — and permanently, because a create makes no further write and so never clears the
 *    marker, freezing every later edit of that document out of the ledger for ever. Both readings
 *    are guesses; what is honest is to answer and to say the answer is a guess.
 *
 * 3. A HISTORICAL BACKFILL REPAIR YIELDS TO A LIVE, EXTERNALLY STAMPED WRITE — also ASSUMED. Without
 *    some rule here a backfilled holder freezes its document permanently (Codex r3 finding 3): it
 *    carries no stamp and is not the create, so rule 1 cannot order it and rule 2 does not reach it,
 *    and every later live revision is refused for ever. o3d-cvj9 r6 (Codex r5 finding 2): what r4
 *    called causal is not. See `HISTORICAL_BACKFILL_REVISION_ORDER_BASIS` — the repair's write had
 *    completed before the backfill selected it, but the arriving side is a RECORD being written now
 *    of a write that may have landed at any earlier time, so the two are not placed against each
 *    other. The rule stays, because a permanent freeze is worse than a named assumption, and it is
 *    labelled for what it is. The arriving side must still carry a real external stamp: a second
 *    backfill run brings none, so backfill-against-backfill stays unordered.
 *
 * 4. AN ARRIVAL THAT MADE NO WRITE TAKES NO CLAIM — which is NOT a statement about which write is
 *    newer. ASKED FIRST, ahead of rules 1-3, even though it is numbered last: it is the only rule
 *    that decides on the ARRIVAL alone, so no rule about the HOLDER may answer over it (o3d-cvj9 r7,
 *    Codex r6 HIGH — rule 2 did, and moved a claim onto a replay that called nothing). Rules 1 and 3
 *    need a finite arriving stamp and so cannot fire here anyway; rule 2 does not, and that is
 *    exactly why it had to be put behind this one. The one arrival that can never bring a stamp is
 *    the processor's short-circuit replay: a
 *    sync log that already carries its document id, replayed without calling the connector. Under r4
 *    it hit `recency_indeterminate` for ever, so the P2002 stayed fatal and the sync log retried to
 *    FAILED with nothing in live operation able to move it. o3d-cvj9 r6 (Codex r5 finding 3): r5
 *    cleared that by returning "the holder precedes", i.e. by declaring the arrival STALE — and
 *    staleness is a claim about where the arrival's ORIGINAL write sits, the post that put the
 *    document id on its sync log in the first place. This rule knows nothing about that write: it
 *    has no stamp for it, and none for the holder either, or rule 1 would have answered. What the
 *    absent field does prove is narrower and sufficient: THIS attempt called nothing, so it changed
 *    nothing about the document and has nothing to take the id for. The verdict is
 *    `arrival_wrote_nothing`; the caller records the row SUPERSEDED with no claim — terminal, so the
 *    retry loop still ends — and audits it as having yielded WITHOUT writing rather than as having
 *    been beaten by a newer write. This is decided from the caller's own signal — the field ABSENT
 *    means no connector call, `null` means a call whose stamp we did not get — never from a clock.
 *
 * Anything else is `null` — NOT ORDERED. A missing stamp on either side (the row predates the
 * column, the connector returned none, an administrative backfill wrote the row) and an exact tie
 * both land here. `null` is refused by the caller, which keeps the underlying P2002 fatal: the sync
 * log retries and an operator sees it, rather than a stale revision quietly taking the document id.
 */

/**
 * How a verdict was reached. `external_stamps` is the external system's own record of the order;
 * everything else is this code reading a row that has no usable stamp on it.
 */
export type RevisionOrderBasis =
  | 'external_stamps'
  | 'create_precedes_unwritten'
  | 'create_precedes_untimed_write'
  | 'historical_repair_precedes_live_write'
  | 'arrival_made_no_write'

/**
 * The bases that do NOT establish an order: rules 2 (a create whose write nobody timed) and 3 (a
 * historical repair) assume one, and rule 4 makes no ordering claim at all. Kept as one list so the
 * `established` flag, and the audit metadata derived from it, cannot drift from the rule that set it.
 */
const NON_ESTABLISHING_REVISION_ORDER_BASES = new Set<RevisionOrderBasis>([
  'create_precedes_untimed_write',
  'historical_repair_precedes_live_write',
  'arrival_made_no_write',
])

/** Did this basis ESTABLISH the order, as opposed to assuming one or asserting none? */
export function isEstablishedRevisionOrderBasis(basis: RevisionOrderBasis): boolean {
  return !NON_ESTABLISHING_REVISION_ORDER_BASES.has(basis)
}

/**
 * o3d-cvj9 r7 (Codex r7, HIGH): the `accounting_event_logs.action` for a takeover whose ordering was
 * ASSUMED rather than read off the external system's stamps.
 *
 * Round 6 already recorded the basis and `orderingEstablished: false` in the metadata of the
 * ordinary `superseded_by_revision` entry, and then said the honest thing about it: nothing LISTS
 * the documents whose identifier moved on an assumption. A flag inside a JSON column of an
 * append-only audit table is not an operator surface — no report reads it, no page shows it, and
 * finding one means knowing to go and look.
 *
 * Giving the assumed takeover its own action is what makes it listable: the accounting
 * reconciliation report selects on this action alone (indexed, bounded by its lookback) and raises
 * `document_claim_moved_on_assumed_order` for every one it finds. `superseded_by_revision` is
 * left meaning what a reader would expect it to mean — a handover the external system's own stamps
 * settled.
 *
 * THE REMEDY THE FINDING HANDS THE OPERATOR, which is what makes it actionable rather than a park:
 * the finding names the connector, the external document id and both event rows. Open that document
 * in the accounting system and compare its current content with the two payloads.
 *  - If the row that TOOK the id describes it, the assumption held; nothing to do.
 *  - If the row that RELEASED it describes it, the assumption was wrong: re-post the revision that
 *    does describe the document. That write comes back with a real external stamp, so the claim is
 *    then settled by rule 1 on the external system's own record — established, and the ledger
 *    self-corrects from there.
 * Neither remedy is reachable at all if the event is not surfaced, which is why this exists.
 */
export const ASSUMED_REVISION_ORDER_TAKEOVER_ACTION = 'superseded_by_assumed_order'

/**
 * The audit action for a handover, chosen by whether the order was ESTABLISHED. Derived in one place
 * and used by both callers that move a claim (the live mirror and the administrative backfill), so
 * the action can never disagree with the `orderingEstablished` recorded beside it. The backfill
 * cannot reach the assumed branch today — it passes `acceptAssumedOrder: false`, so an assumed
 * verdict comes back refused — but the branch it takes must be decided by the same fact, not by
 * which caller it is.
 */
export function revisionTakeoverLogAction(orderEstablished: boolean): string {
  return orderEstablished ? 'superseded_by_revision' : ASSUMED_REVISION_ORDER_TAKEOVER_ACTION
}

/**
 * `holder_first` — the holder wrote first and may hand its claim over.
 * `arrival_first` — the holder is the later write, so the arriving row is a stale replay. Only rule
 *                   1 can say this: it is a claim about where the arrival's write sits, and only the
 *                   external system's stamps place it.
 * `arrival_wrote_nothing` — this attempt made no connector call, so it takes no claim. NOT an
 *                   order, which is why it carries no `established` flag: there is no order here to
 *                   have established.
 */
export type RevisionOrderVerdict =
  | { order: 'holder_first'; basis: RevisionOrderBasis; established: boolean }
  | { order: 'arrival_first'; basis: 'external_stamps'; established: true }
  | { order: 'arrival_wrote_nothing'; basis: 'arrival_made_no_write' }

function finiteRevisionStamp(at: Date | null | undefined): number | null {
  const time = at?.getTime()
  if (time === undefined || !Number.isFinite(time)) return null
  return time
}

function holderFirst(basis: RevisionOrderBasis): RevisionOrderVerdict {
  return { order: 'holder_first', basis, established: isEstablishedRevisionOrderBasis(basis) }
}

function resolveDocumentRevisionOrder(
  holder: { type: string; externalRevisionAt: Date | null; revisionOrderBasis?: string | null },
  arriving: { externalRevisionAt?: Date | null },
  createType: string,
): RevisionOrderVerdict | null {
  const holderAt = finiteRevisionStamp(holder.externalRevisionAt)
  const arrivingAt = finiteRevisionStamp(arriving.externalRevisionAt)
  // o3d-cvj9 r5: `undefined` and `null` are DIFFERENT FACTS on the arriving side, and every caller
  // already keeps them apart — the processor's short-circuit omits the field because it made no
  // connector call at all, while a real write whose response carried no readable stamp passes
  // `null`, and the administrative backfill passes `null` for a historical write it knows happened.
  // Collapsing the two is what let "we wrote, time unknown" be read as "we never wrote".
  const arrivingWrote = arriving.externalRevisionAt !== undefined

  // RULE 4, ASKED FIRST — the numbering is by KIND, and this is the evaluation order (Codex r6, HIGH).
  //
  // Round 6 wrote this rule last, after the create fallback, and the fallback got to the pair first.
  // Trace the ordinary case: a sync log that already carries its document id is replayed, the
  // processor short-circuits WITHOUT calling the connector, and the arriving revision's holder is the
  // document's own unstamped CREATE. Rule 2 matches on the holder's type alone, answers
  // `holder_first / create_precedes_unwritten`, and the live mirror — which accepts an assumed order,
  // and must — TAKES THE CLAIM. Round 6's own finding was that a replay which made no call takes no
  // claim; deciding the pair by a rule about the HOLDER is how one gets taken anyway. And this is not
  // an exotic interleaving: create-then-revise is the ordinary shape of a document, and the
  // short-circuit replay is the ordinary way a settled revision comes back through here.
  //
  // Asking first costs nothing above it. Rules 1 and 3 both require a finite ARRIVING stamp, which an
  // arrival that made no write cannot have, so neither could have fired; the only rule this pre-empts
  // is the create fallback, and pre-empting it is the fix. It is also the right shape for a rule that
  // is about the ARRIVAL alone rather than about the pair: it needs nothing from the holder, so
  // nothing about the holder may answer over it.
  if (!arrivingWrote) return { order: 'arrival_wrote_nothing', basis: 'arrival_made_no_write' }

  // Rule 1: the external system stamped both writes, so it has already said which it applied last.
  // The ONLY rule that can declare the arrival stale, because it is the only one that places the
  // arriving write at all.
  if (holderAt !== null && arrivingAt !== null) {
    if (holderAt === arrivingAt) return null
    return holderAt < arrivingAt
      ? holderFirst('external_stamps')
      : { order: 'arrival_first', basis: 'external_stamps', established: true }
  }

  // Rule 2: the holder is the document's CREATE and has made no write this code can place in the
  // document's edit order. A create with a recorded but UNTIMED write may have re-posted itself over
  // the arriving edit (past Xero's six-minute idempotency window a replayed create is a fresh upsert
  // on the invoice number) — or, far more often, may simply be the original post with an unreadable
  // response stamp. The row cannot tell those apart, so the create rule still answers and the answer
  // is marked assumed. See LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS.
  if (holder.type === createType) {
    if (holderAt !== null) return null
    return holderFirst(holder.revisionOrderBasis === LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS
      ? 'create_precedes_untimed_write'
      : 'create_precedes_unwritten')
  }

  // Rule 3: the holder is a historical repair; the arrival is a live, externally stamped write.
  // Assumed, not established — nothing places the repair's write against the arriving stamp.
  if (holder.revisionOrderBasis === HISTORICAL_BACKFILL_REVISION_ORDER_BASIS && arrivingAt !== null) {
    return holderFirst('historical_repair_precedes_live_write')
  }

  // Rule 4 is not here: it is asked at the TOP of this function, above the create fallback, because
  // the fallback would otherwise answer for an arrival that made no write at all (Codex r6, HIGH).

  return null
}

/**
 * What may be done with an external document id that another event row already holds.
 *
 * `refused` carries the SPECIFIC reason rather than a bare no: every refusal keeps the underlying
 * P2002 fatal, and which one fired is the difference between "a second document is claiming this
 * invoice" and "we could not tell these two revisions apart".
 *
 * o3d-cvj9 r6: the two outcomes that MOVE or DENY a claim on the strength of an ordering also carry
 * the basis that ordering was reached on, and whether it was established or assumed — a takeover
 * decided by Xero's own stamps and one decided by falling back on "a create precedes its revisions"
 * are not the same claim, and whoever reads the audit trail has to be able to say which happened.
 * `yielded` is the third state r6 added: the arrival made no connector write at all, so it takes no
 * claim and NOTHING is asserted about which write is newer (Codex r5 finding 3).
 */
export type DocumentRevisionClaimOutcome =
  | { claim: 'takeover'; supersededEventId: string; orderBasis: RevisionOrderBasis; orderEstablished: boolean }
  | { claim: 'stale'; holderEventId: string; orderBasis: RevisionOrderBasis; orderEstablished: boolean }
  | { claim: 'yielded'; holderEventId: string; orderBasis: 'arrival_made_no_write' }
  | {
      claim: 'refused'
      reason:
        | 'not_a_revision_claim'
        | 'no_holder'
        | 'different_source_document'
        | 'unrelated_event_type'
        | 'recency_indeterminate'
        | 'recency_only_assumed'
        | 'claim_moved_concurrently'
    }

/**
 * o3d-cvj9 r4: the LINEAGE half of a revision claim, decided without touching anything.
 *
 * Split out of `resolveDocumentRevisionExternalIdClaim` for Codex r3 finding 2: the administrative
 * backfill has a path that writes an UNCLAIMED row (several revisions of one document, nothing
 * orders them), and because that path never puts an external id on the insert it never raises the
 * P2002 that used to carry it into the checks below. So it repaired rows whose external id belonged
 * to a DIFFERENT source document, or to an unrelated event type, without ever noticing — the exact
 * cross-document double post the unique index exists to catch, silently absorbed into a benign
 * "we could not order these" repair.
 *
 * Both callers now go through this one function, so "what counts as a legitimate predecessor" is
 * decided in a single place and the id-taking path and the id-declining path cannot drift apart.
 *
 * These four refusals are exactly the ones that are NOT about ordering:
 *  - `not_a_revision_claim`    — nothing here claims a document id (no id, or not a POSTED revision).
 *  - `no_holder`               — the id is free; there is no collision to classify.
 *  - `different_source_document` / `unrelated_event_type` — a genuine collision. Fatal, always.
 */
export type DocumentRevisionClaimLineage =
  | {
      lineage: 'eligible'
      externalId: string
      holder: { id: string; type: string; externalRevisionAt: Date | null; revisionOrderBasis: string | null }
      createType: string
    }
  | {
      lineage: 'refused'
      reason: 'not_a_revision_claim' | 'no_holder' | 'different_source_document' | 'unrelated_event_type'
    }

/**
 * The refusals that mean "this external id belongs to something else", as opposed to "we could not
 * order these two writes". A caller that declines to take a claim still has to fail on these.
 */
export function isCrossDocumentRevisionClaimRefusal(reason: string): boolean {
  return reason === 'different_source_document' || reason === 'unrelated_event_type'
}

/**
 * The refusals that mean "which of these two writes is newer was not settled here" — either nothing
 * ordered them at all, or the only thing that did was an assumption this caller declines to act on
 * (o3d-cvj9 r6). A caller with a truthful alternative — the backfill's unclaimed repair — writes it
 * for both; the claim is simply left where it is.
 */
export function isUnorderedRevisionClaimRefusal(reason: string): boolean {
  return reason === 'recency_indeterminate' || reason === 'recency_only_assumed'
}

export async function inspectDocumentRevisionExternalIdClaim(
  client: AccountingEventMirrorTransactionClient,
  params: { connector: string; type: string; referenceType: string; referenceId: string; status: AccountingEventStatus; externalId?: string | null },
): Promise<DocumentRevisionClaimLineage> {
  const externalId = params.externalId?.trim() ? params.externalId : null
  // o3d-cvj9 r5 (Codex r4 finding 2): LINEAGE ONLY. "Only a successful post owns a document id" is
  // a rule about who may TAKE a claim, and it now lives in `resolveDocumentRevisionExternalIdClaim`
  // where taking happens. It did not belong here, because it made this function return before the
  // holder lookup — i.e. a no-op — for exactly the rows the backfill's DECLINING path asks about: a
  // revision log that recorded an external document id without reaching SYNCED. Those are counted
  // as possibly-posted by the contest scan (`revisionSyncLogMayHavePosted`), so they reach the
  // decline path routinely, and a genuine cross-document collision on the id they recorded was
  // never looked for at all. The decline path writes no external id, so the unique index cannot
  // catch it either: this lookup is the only thing that can.
  if (!externalId) return { lineage: 'refused', reason: 'not_a_revision_claim' }
  const predecessorTypes = DOCUMENT_REVISION_PREDECESSOR_TYPES[params.type]
  const createType = DOCUMENT_REVISION_FAMILY_BY_TYPE[params.type]
  if (!predecessorTypes || !createType) return { lineage: 'refused', reason: 'not_a_revision_claim' }

  const holder = await client.accountingEvent.findUnique({
    where: { externalSystem_externalId: { externalSystem: params.connector, externalId } },
    select: { id: true, type: true, sourceEntityType: true, sourceEntityId: true, externalRevisionAt: true, revisionOrderBasis: true },
  })
  if (!holder) return { lineage: 'refused', reason: 'no_holder' }
  // The holder must be an earlier revision of the SAME source document. Anything else sharing an
  // external id is the duplicate-post the unique index exists to catch.
  if (holder.sourceEntityType !== params.referenceType || holder.sourceEntityId !== params.referenceId) {
    return { lineage: 'refused', reason: 'different_source_document' }
  }
  if (!predecessorTypes.includes(holder.type)) return { lineage: 'refused', reason: 'unrelated_event_type' }

  return {
    lineage: 'eligible',
    externalId,
    createType,
    holder: {
      id: holder.id,
      type: holder.type,
      externalRevisionAt: holder.externalRevisionAt,
      revisionOrderBasis: holder.revisionOrderBasis,
    },
  }
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
 * described a LATER state than it (see `resolveDocumentRevisionOrder` for the things that
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
  // response was never recorded — see `resolveDocumentRevisionOrder` rules 1 and 3.
  arriving: { externalRevisionAt?: Date | null },
  // o3d-cvj9 r6: does this caller act on an order that was ASSUMED rather than established? Stated
  // by every caller because the honest answer differs by caller and neither answer is a default:
  // the live mirror says yes (refusing leaves the sync log retrying to FAILED for ever, which is
  // the permanence Codex r5 finding 1 is about), the administrative backfill says no (it writes an
  // unclaimed repair instead, which is truthful and terminal). See `RevisionOrderVerdict`.
  options: { acceptAssumedOrder: boolean },
): Promise<DocumentRevisionClaimOutcome> {
  // Only a SUCCESSFUL post owns a document id: a PENDING or FAILED attempt has nothing to hand over
  // and nothing to take. o3d-cvj9 r5: checked here rather than in the lineage half, so declining to
  // claim still gets a cross-document check on the id the sync log recorded.
  if (params.status !== 'POSTED') return { claim: 'refused', reason: 'not_a_revision_claim' }
  // The lineage half — is there a holder at all, and is it a legitimate predecessor of THIS
  // document? — is shared with the backfill's decline path so the two cannot drift on what a
  // genuine cross-document collision is. See `inspectDocumentRevisionExternalIdClaim`.
  const lineage = await inspectDocumentRevisionExternalIdClaim(client, params)
  if (lineage.lineage === 'refused') return { claim: 'refused', reason: lineage.reason }
  const { holder, createType, externalId } = lineage

  const verdict = resolveDocumentRevisionOrder(holder, arriving, createType)
  if (verdict === null) return { claim: 'refused', reason: 'recency_indeterminate' }
  // The arrival called nothing, so it has nothing to claim the document for — and this says nothing
  // about which write is newer, which is why it is not `stale`.
  if (verdict.order === 'arrival_wrote_nothing') {
    return { claim: 'yielded', holderEventId: holder.id, orderBasis: verdict.basis }
  }
  if (!verdict.established && !options.acceptAssumedOrder) {
    return { claim: 'refused', reason: 'recency_only_assumed' }
  }
  if (verdict.order === 'arrival_first') {
    return { claim: 'stale', holderEventId: holder.id, orderBasis: verdict.basis, orderEstablished: verdict.established }
  }

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

  return {
    claim: 'takeover',
    supersededEventId: holder.id,
    orderBasis: verdict.basis,
    orderEstablished: verdict.established,
  }
}

/**
 * What a mirror write actually did. o3d-nf9i round 2 finding 4: the caller used to record
 * `mirrorUpdate: 'applied'` in its audit BEFORE calling this, while this function returned silently
 * when no event matched either key — so an audit row could assert a mirror update that never
 * happened. A missing mirror is a SUPPORTED state (the queue paths swallow mirror failures and keep
 * the sync row), so "not found" is not an error, it is a fact the caller has to be able to record.
 */
export type MirroredEventUpdateOutcome =
  /** The mirrored event was found and written. */
  | 'updated'
  /** Neither the primary nor the legacy key matched an event — nothing is mirrored for this row. */
  | 'not_found'
  /** The event exists but the caller's guard did not hold, so it was deliberately left alone. */
  | 'refused'

/**
 * A compare-and-swap on the mirrored event itself, for callers whose write must not clobber a
 * DIFFERENT attempt's record of the same logical document.
 *
 * Mirror identity is logical, not per-row: buildMirroredAccountingEventIdempotencyKey prefers the
 * payload's `_idempotencyKey`, and the legacy fallback key is shared by every attempt on the same
 * day — so one AccountingEvent can be the mirror of several AccountingSyncLog rows. Reading the
 * siblings first tells a caller who else might own it, but that read is not a lock: a sibling can
 * post between the read and the write. Guarding the write itself makes both interleavings safe —
 * the late poster overwrites a VOID with its POSTED, and the late VOID is refused against an
 * already-POSTED event — without any caller having to serialise on the mirror key.
 */
export type MirroredEventWriteGuard = {
  /** Write only while the event is in one of these statuses. */
  statusIn: readonly AccountingEventStatus[]
  /** Write only while the event names no external document (post evidence must never be erased). */
  requireExternalIdNull?: boolean
}

/**
 * Key-order-independent rendering of a JSON value, for deciding whether the posted payload
 * actually DIFFERS from the mirrored one.
 *
 * `linesJson` is a Postgres `jsonb` column, and jsonb does not preserve object key order — it
 * stores keys sorted by length then bytewise. A plain `JSON.stringify` comparison of the stored
 * value against a freshly built one therefore reports a difference on almost every post, which
 * would bury the real ones in noise.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * o3d-m26g: THE MIRRORED EVENT'S BODY, REBUILT FROM THE PAYLOAD THAT WAS ACTUALLY POSTED.
 *
 * The mirrored `AccountingEvent` is created by `mirrorAccountingSyncLogToEvent` at ENQUEUE time,
 * from the payload as it stood then. The status transition below used to write only `status` and
 * `externalId`, so whenever anything changed the queued payload between enqueue and post, the
 * internal audit event and the ledger disagreed and nothing said so. Rebuilding through the same
 * canonical builders the enqueue used (`buildAccountingDocumentPayload` for documents,
 * `buildAccountingEvent`'s line normalisation for journals) makes the POSTED event describe what
 * was sent.
 *
 * ONLY THE BODY MOVES. `type`, `sourceEntityType`, `sourceEntityId` and `idempotencyKey` are the
 * event's identity — they are what this update located the row by — and are never rewritten. The
 * idempotency key is not payload-content-derived either (it prefers `payload._idempotencyKey`,
 * then the sync-log id), so a rebuilt body cannot orphan the event from its next lookup.
 *
 * THE CURRENCY IS THE ROW'S OWN, not re-resolved. For a document payload it is only a fallback
 * (the payload carries its own currency, as it did at enqueue); for a journal payload it IS the
 * currency, and the enqueue path takes it from `getBaseCurrencyCode()`. Re-deriving it here from
 * anything else would risk silently re-denominating an event.
 */
function rebuildMirroredEventBody(
  params: Omit<Parameters<typeof buildMirroredAccountingEventDraft>[0], 'currency'>,
  existing: { currency: string },
): { linesJson: unknown; businessDate: Date; currency: string } | null {
  const draft = buildMirroredAccountingEventDraft({ ...params, currency: existing.currency })
  if (!draft) return null
  return { linesJson: draft.linesJson, businessDate: draft.businessDate, currency: draft.currency }
}

export async function updateMirroredAccountingEventStatus(
  client: AccountingEventMirrorTransactionClient,
  params: {
    connector: string
    syncLogId?: string
    type: string
    referenceType: string
    referenceId: string
    /**
     * o3d-m26g: THE PAYLOAD THE PROCESSOR ACTUALLY POSTED (or attempted). Both processors read it
     * from the sync-log row they claimed and hand it straight through, so on a POSTED transition
     * it is what went to the connector — which is why it, and not the enqueue-time copy, is what
     * the mirrored event's body is rebuilt from.
     */
    payload: unknown
    status: AccountingEventStatus
    externalId?: string | null
    /**
     * o3d-cvj9 r3: the EXTERNAL system's revision stamp for the write this attempt just made —
     * Xero's `Invoice.UpdatedDateUTC`, out of the response to that write. It is recorded because it
     * is the only thing that orders two revisions of one document (see
     * `resolveDocumentRevisionOrder`), and it is left undefined whenever no write was made in
     * this attempt or the connector returned none. It is never synthesised from a local clock.
     */
    externalRevisionAt?: Date | null
    message?: string | null
    /**
     * Optional. Absent = the historical unconditional write, which is what the connectors' own
     * success/failure writeback wants: it owns the attempt it is reporting on. Present = the write
     * lands only while the guard holds, and `'refused'` is returned instead of overwriting.
     */
    guard?: MirroredEventWriteGuard
  },
): Promise<MirroredEventUpdateOutcome> {
  const idempotencyKey = buildMirroredAccountingEventIdempotencyKey(params)
  if (!idempotencyKey) return 'not_found'

  const guard = params.guard

  // ---------------------------------------------------------------------------------------------
  // o3d-m26g: the mirrored body, rebuilt from the payload that was actually posted. Resolved per
  // KEY, immediately before the write for that key, so the primary/legacy fallback below rebuilds
  // against whichever row it ends up writing — and so the tail's audit logs describe that row.
  // ---------------------------------------------------------------------------------------------
  let rebuilt: { linesJson: unknown; businessDate: Date; currency: string } | null = null
  let rebuildError: string | null = null
  let previousLinesJson: unknown = undefined
  let bodyChanged = false

  async function resolveBodyRebuild(key: string): Promise<void> {
    rebuilt = null
    rebuildError = null
    previousLinesJson = undefined
    bodyChanged = false

    // Rebuilt ONLY on POSTED. A FAILED attempt put nothing in the ledger, so there is no ledger for
    // the event to disagree with, and the queued payload remains the honest record of what was
    // attempted.
    //
    // AND NEVER UNDER A GUARD. A guarded caller is an operator ASSERTION that made no connector
    // write (see the guard note on `updateByIdempotencyKey`); its `payload` is the stored row's,
    // not something this attempt sent. Rebuilding the event's body from it would rewrite the
    // mirror to describe a post that never happened — the precise inverse of what o3d-m26g is for.
    if (params.status !== 'POSTED' || guard) return

    const existing = await client.accountingEvent.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, currency: true, linesJson: true },
    })
    // No row: the write below reports `not_found` on its own terms. Nothing to rebuild against.
    if (!existing) return

    // A REBUILD FAILURE MUST NEVER COST THE POST. This runs inside the same transaction as the
    // sync log's SYNCED transition, so throwing here would roll that transition back on work that
    // has ALREADY been accepted by Xero — and the retry would post it a second time. A payload the
    // builders reject (a line that lost its account code, a date that is no longer parseable) is
    // therefore recorded as a rebuild failure against the event and the transition stands: the
    // mirror keeps its enqueue-time body, and the `payload_rebuild_failed` log names the reason so
    // an operator can see which event to re-derive.
    try {
      rebuilt = rebuildMirroredEventBody(params, existing)
      if (!rebuilt) {
        // A row exists, so this type WAS mirrorable when it was enqueued. `null` therefore means the
        // posted payload no longer yields an event at all — journal lines that went missing or lost
        // their account code / description. Treated exactly like a thrown rebuild rather than skipped
        // quietly, because a silent skip is the blind spot this whole change exists to close.
        rebuildError = 'the posted payload no longer builds a mirrorable event (missing or malformed lines)'
      }
    } catch (error) {
      rebuildError = error instanceof Error ? error.message : String(error)
    }
    previousLinesJson = existing.linesJson
    bodyChanged = rebuilt != null && canonicalJson(rebuilt.linesJson) !== canonicalJson(previousLinesJson)
  }

  function statusWriteData(
    // o3d-cvj9 r2: the STALE path records the same transition without claiming the document id,
    // because a newer revision already holds it. Both overrides are set together and only there.
    override?: { status: AccountingEventStatus; claimExternalId: false },
  ) {
    return {
        status: override?.status ?? params.status,
        ...(params.externalId !== undefined && override?.claimExternalId !== false
          ? { externalId: params.externalId }
          : {}),
        // The stamp is a true fact about THIS row's write whether or not the row keeps the claim,
        // so the stale path records it too — it is what a later comparison against this row needs.
        //
        // o3d-cvj9 r5: the BASIS is rewritten in the same statement, because the PRESENCE of this
        // field is the caller saying a connector write was made in this attempt — the short-circuit
        // omits it entirely and reaches neither branch. Two things follow:
        //
        //  - a STAMPED write CLEARS the basis. The row is now ordered by a real external stamp, so
        //    whatever category it was created with is spent — including an administrative repair's
        //    `historical_backfill_repair`. This is what stops a backfill artefact outliving live
        //    operation on the row it was written on (Codex r4 finding 3): the repair marker is a
        //    statement about a row nothing live had touched, and the moment something live does, it
        //    is no longer true and no longer recorded.
        //  - an UNSTAMPED write records `live_write_unstamped`, so the wiped stamp cannot be read
        //    as "this row never wrote" — see LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS.
        //
        // Only for types that can contend for a document id at all; a journal batch never does, and
        // a basis on one would assert nothing.
        ...(params.externalRevisionAt !== undefined
          ? {
              externalRevisionAt: params.externalRevisionAt,
              ...(accountingDocumentRevisionFamily(params.type)
                ? { revisionOrderBasis: revisionOrderBasisForLiveWrite(params.externalRevisionAt) }
                : {}),
            }
          : {}),
        // o3d-m26g: the body this attempt actually posted. Present on the SUPERSEDED paths too —
        // those rows did make a real connector write, and what they sent is what their body should
        // say; what they give up is the CLAIM on the document id, not the record of their own write.
        ...(rebuilt
          ? { linesJson: rebuilt.linesJson as never, businessDate: rebuilt.businessDate, currency: rebuilt.currency }
          : {}),
    }
  }

  async function applyStatus(
    key: string,
    override?: { status: AccountingEventStatus; claimExternalId: false },
  ) {
    return client.accountingEvent.update({
      where: { idempotencyKey: key },
      data: statusWriteData(override),
      select: { id: true },
    })
  }

  async function updateByIdempotencyKey(key: string): Promise<{ id: string } | 'not_found' | 'refused'> {
    // Before anything is written for THIS key (o3d-m26g).
    await resolveBodyRebuild(key)
    // o3d-nf9i: the CAS. `updateMany` rather than `update` because the where has to carry more than
    // the unique key, and because a guard that does not hold must be a zero-row no-op, not a throw.
    //
    // The guarded path deliberately does NOT enter the revision-claim machinery below. That
    // machinery exists to order two CONNECTOR WRITES against each other on the external system's own
    // revision stamps; a guarded caller is an operator ASSERTION that made no write and carries no
    // stamp, so it has nothing to order with and must never supersede a row that does. A collision
    // on the external reference therefore stays fatal here and rolls the caller's transaction back —
    // fail-closed, which is what a money-path assertion has to do.
    if (guard) {
      const written = await client.accountingEvent.updateMany({
        where: {
          idempotencyKey: key,
          status: { in: [...guard.statusIn] },
          ...(guard.requireExternalIdNull ? { externalId: null } : {}),
        },
        data: statusWriteData(),
      })
      // Read purely to explain the outcome. The CAS above, not this read, decided it.
      const event = await client.accountingEvent.findUnique({ where: { idempotencyKey: key }, select: { id: true } })
      if (written.count > 0) return event ?? 'not_found'
      return event ? 'refused' : 'not_found'
    }
    try {
      // o3d-cvj9: the SAVEPOINT is what makes the catch below usable at all. `client` is the
      // CALLER's interactive transaction (the same one that just marked the sync log SYNCED);
      // Postgres aborts the whole transaction on the unique violation, so without the savepoint
      // every statement after the catch fails with 25P02 and the COMMIT cannot succeed. Verified
      // live against onetwo3d_ims_dev: catching the P2002 unguarded makes the very next read fail
      // with "current transaction is aborted, commands ignored until end of transaction block".
      return await withSavepoint(client, () => applyStatus(key))
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return 'not_found'
      // Classified from the statement that RAISED it, not inferred from where we are: the only
      // other unique constraint on accounting_events is idempotencyKey, which this statement does
      // not write.
      if (!isExternalAccountingReferenceUniqueError(error)) throw error

      // o3d-cvj9 r3: WHICH revision describes the document has to be established, not assumed —
      // and the arriving half of that comparison is the stamp the connector returned for the write
      // this attempt just made, which the caller already holds. r2 re-read the arriving ROW here to
      // get its `createdAt`; that column is `DEFAULT CURRENT_TIMESTAMP`, i.e. transaction START
      // time, so it never carried the ordering it was read for. The read goes with it.
      const claim = await resolveDocumentRevisionExternalIdClaim(
        client,
        params,
        { externalRevisionAt: params.externalRevisionAt },
        // o3d-cvj9 r7 (Codex r7, HIGH): the live mirror ACTS on an assumed order, records that it
        // did, and now PUTS IT IN FRONT OF AN OPERATOR. Codex proposed a third outcome instead — a
        // terminal state that records the successful write without moving the claim — on the ground
        // that r6's defence ("the only alternative is a permanent failure loop") was a false
        // dichotomy. The loop half of that is right and is fixed by any terminal outcome. The
        // refusal half is not, for three reasons, and they are why the claim still moves:
        //
        //  - NOT MOVING THE CLAIM IS NOT NEUTRAL. The document id is already on the holder, and the
        //    holder is POSTED, so it already names the document. Declining to move it is not
        //    abstaining from the guess; it is making the OPPOSITE guess — "the holder describes the
        //    document" — silently, by inaction, on exactly the same absent evidence. Both bases that
        //    get here arise only when a write DID land in this attempt, so the two rows are two
        //    writes of unknown order and one of them must hold the id. (The genuinely neutral act,
        //    releasing the id from both, is worse still: it deletes the only link the ledger has to
        //    a real Xero document.) This is the difference from rule 4's `yielded`, whose defence
        //    does not transfer: there the arrival made NO write, so leaving the holder naming the
        //    document is contradicted by nothing.
        //
        //  - THE GUESS THAT MOVES CONVERGES; THE GUESS THAT PARKS NEVER DOES. A takeover leaves the
        //    arrival holding the id WITH the stamp of the write it just made (always, for rule 3,
        //    which requires one), so the NEXT revision of that document is settled by rule 1 on the
        //    external system's own stamps — established, not assumed. Parking leaves the id on a
        //    holder whose basis nothing clears (a create makes no further write; a repair makes
        //    none), so every later revision of that document meets the same assumed rule and parks
        //    again. It converts a one-off assumption per document into a permanent regime — the same
        //    permanence r6 removed, wearing a better status.
        //
        //  - AND THE ASSUMPTION IS NOW VISIBLE. r6's honest complaint against itself was that the
        //    assumption lived in metadata and nothing listed it. It does now: an assumed takeover is
        //    audited under its OWN action, and the accounting reconciliation report raises
        //    `document_claim_moved_on_assumed_order` for each one, naming the document, both rows
        //    and the basis. See ASSUMED_REVISION_ORDER_TAKEOVER_ACTION for the remedy that finding
        //    hands the operator.
        //
        // What has NOT changed: refusing is still not a safe default here. The P2002 stays fatal,
        // the sync log retries to FAILED, and for both assuming rules nothing in live operation ever
        // changes the inputs, so the refusal would be permanent as well as wrong-way-round.
        { acceptAssumedOrder: true },
      )
      // Nothing legitimate to supersede: this is a real collision (a different document claiming
      // an external id that is already spoken for), or two revisions we cannot order. Either way it
      // must stay fatal and visible.
      if (claim.claim === 'refused') throw error

      if (claim.claim === 'yielded') {
        // o3d-cvj9 r6 (Codex r5 finding 3): this attempt made no connector call — the processor's
        // short-circuit replay of a sync log that already carries its document id. It changed
        // nothing about the document, so it takes no claim; and because nothing here placed its
        // ORIGINAL write against the holder's, the audit does not say a newer write beat it. The
        // row is still terminal, which is what stops the sync log retrying to FAILED for ever.
        const event = await withSavepoint(client, () => applyStatus(key, { status: 'SUPERSEDED', claimExternalId: false }))
        await client.accountingEventLog.create({
          data: buildAccountingEventLog({
            accountingEventId: event.id,
            action: 'revision_claim_yielded_no_write',
            message: 'This replay made no connector write, so it took no claim on the document. '
              + 'Which of it and the event holding the document id describes the document now was not established.',
            metadata: {
              connector: params.connector,
              ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
              syncType: params.type,
              referenceType: params.referenceType,
              referenceId: params.referenceId,
              externalId: params.externalId ?? null,
              externalIdHeldByEventId: claim.holderEventId,
              orderingBasis: claim.orderBasis,
              orderingEstablished: isEstablishedRevisionOrderBasis(claim.orderBasis),
            },
          }) as never,
        })
        return event
      }

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
              orderingBasis: claim.orderBasis,
              orderingEstablished: claim.orderEstablished,
            },
          }) as never,
        })
        return event
      }

      const event = await withSavepoint(client, () => applyStatus(key))
      await client.accountingEventLog.create({
        data: buildAccountingEventLog({
          accountingEventId: claim.supersededEventId,
          // o3d-cvj9 r7: an ASSUMED takeover is a different claim from one Xero's stamps settled, so
          // it is a different entry — not the same entry with a flag buried in its metadata. This is
          // the row the reconciliation report selects on. See ASSUMED_REVISION_ORDER_TAKEOVER_ACTION.
          action: revisionTakeoverLogAction(claim.orderEstablished),
          ...(claim.orderEstablished
            ? {}
            : {
                message: 'The document id moved to a later revision on an ASSUMED order: nothing placed '
                  + 'these two writes against each other. Compare the document in the accounting system '
                  + 'with both payloads, and if the released row is the one that describes it, re-post '
                  + 'that revision — its write returns a real revision stamp and settles the claim.',
              }),
          metadata: {
            connector: params.connector,
            ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
            syncType: params.type,
            referenceType: params.referenceType,
            referenceId: params.referenceId,
            externalId: params.externalId ?? null,
            supersededByEventId: event.id,
            orderingBasis: claim.orderBasis,
            orderingEstablished: claim.orderEstablished,
          },
        }) as never,
      })
      return event
    }
  }

  let outcome = await updateByIdempotencyKey(idempotencyKey)
  // o3d-nf9i: only a genuine MISS falls through to the legacy key. A refusal means the primary event
  // exists and the guard declined it; trying a second key would be looking for a way to write anyway.
  if (outcome === 'not_found' && params.syncLogId) {
    const legacyIdempotencyKey = buildMirroredAccountingEventIdempotencyKey({
      connector: params.connector,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      payload: params.payload,
    })
    if (legacyIdempotencyKey && legacyIdempotencyKey !== idempotencyKey) {
      outcome = await updateByIdempotencyKey(legacyIdempotencyKey)
    }
  }

  if (outcome === 'not_found' || outcome === 'refused') return outcome
  const event = outcome

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

  if (bodyChanged) {
    // The superseded body travels INTO the log. Rewriting `linesJson` would otherwise destroy the
    // only record of what was queued, trading one blind spot for another — this way the event says
    // what was posted and its log still says what it was queued as, and the pair is the evidence
    // that they differed.
    await client.accountingEventLog.create({
      data: buildAccountingEventLog({
        accountingEventId: event.id,
        action: 'payload_rebuilt_from_posted',
        message: 'Mirrored payload rebuilt from the payload that was posted; it differed from the enqueued one.',
        metadata: {
          connector: params.connector,
          ...(params.syncLogId ? { syncLogId: params.syncLogId } : {}),
          syncType: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          externalId: params.externalId ?? null,
          enqueuedLinesJson: previousLinesJson as never,
        },
      }) as never,
    })
  }

  if (rebuildError) {
    await client.accountingEventLog.create({
      data: buildAccountingEventLog({
        accountingEventId: event.id,
        action: 'payload_rebuild_failed',
        message: `Mirrored payload could not be rebuilt from the posted payload: ${rebuildError}`,
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
  return 'updated'
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
