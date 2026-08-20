import { getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import { buildAccountingEventLog } from './accounting-event-builder'
import {
  accountingDocumentRevisionFamily,
  accountingDocumentRevisionSyncTypes,
  buildMirroredAccountingEventDraft,
  HISTORICAL_BACKFILL_REVISION_ORDER_BASIS,
  inspectDocumentRevisionExternalIdClaim,
  isCrossDocumentRevisionClaimRefusal,
  isDocumentRevisionAccountingSyncType,
  MIRRORED_ACCOUNTING_SYNC_TYPES,
  resolveDocumentRevisionExternalIdClaim,
  type AccountingEventMirrorTransactionClient,
} from './accounting-event-mirror'
import type { AccountingEventDraft } from './accounting-event-types'
import { isExternalAccountingReferenceUniqueError, isIdempotencyKeyUniqueError } from './prisma-errors'
import {
  DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
  reconciliationLookbackDate,
  type AccountingReconciliationRows,
} from './reconciliation'

/**
 * `createdAt` is selected on top of the shared reconciliation row shape so a backfilled event can
 * be stamped with the time its sync log was enqueued rather than the repair's own clock (see
 * `writeBackfilledEvent`). o3d-cvj9 r3: it is NOT an ordering key. `accounting_events.createdAt`
 * defaults to `CURRENT_TIMESTAMP`, which PostgreSQL evaluates at TRANSACTION START, so it orders
 * neither the edits nor even the enqueues — see `documentRevisionHolderPrecedes`.
 */
type AccountingBackfillSyncLogRow = AccountingReconciliationRows['syncLogs'][number] & { createdAt: Date }
/** The holder row `resolveDocumentRevisionExternalIdClaim` reads when an external id is contested. */
type AccountingBackfillClaimHolderRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  externalRevisionAt: Date | null
  // o3d-cvj9 r4: how a stamp-less holder may be ordered — see HISTORICAL_BACKFILL_REVISION_ORDER_BASIS.
  revisionOrderBasis: string | null
}
type AccountingBackfillWriteClient = {
  accountingEvent: {
    create(args: unknown): Promise<{ id: string }>
    // o3d-cvj9 r2: the revision repair reads the current holder of an external id and releases it
    // under a compare-and-swap, exactly as the live mirror does.
    findUnique(args: unknown): Promise<AccountingBackfillClaimHolderRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  accountingEventLog: {
    create(args: unknown): Promise<unknown>
  }
}
type AccountingBackfillCandidateClient = {
  accountingSyncLog: {
    findMany(args: unknown): Promise<AccountingBackfillSyncLogRow[]>
  }
  accountingEvent: {
    findMany(args: unknown): Promise<AccountingBackfillEventRow[]>
  }
}
type AccountingBackfillClient = AccountingBackfillCandidateClient & AccountingBackfillWriteClient & {
  $transaction<T>(fn: (tx: AccountingBackfillWriteClient) => Promise<T>): Promise<T>
}

export type AccountingEventBackfillAction = 'would_create' | 'created' | 'skipped'

export type AccountingEventBackfillResult = {
  syncLogId: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  action: AccountingEventBackfillAction
  reason: string
  idempotencyKey?: string
  accountingEventId?: string
}

export type AccountingEventBackfillCandidateIssueSummary = {
  code: 'old_sync_log_without_mirrored_event'
  severity: 'warning' | 'critical'
  count: number
}

export type AccountingEventBackfillReport = {
  checkedAt: string
  dryRun: boolean
  lookbackDays?: number
  limit: number
  candidateSummary: {
    scope: 'accounting_event_backfill_candidates'
    total: number
    warning: number
    critical: number
    issues: AccountingEventBackfillCandidateIssueSummary[]
  }
  summary: {
    candidates: number
    wouldCreate: number
    created: number
    skipped: number
  }
  results: AccountingEventBackfillResult[]
}

export type RunAccountingEventBackfillOptions = {
  client?: AccountingBackfillClient
  dryRun?: boolean
  lookbackDays?: number
  limit?: number
  baseCurrency?: string
}

const DEFAULT_BACKFILL_LIMIT = 100
const BACKFILL_CANDIDATE_PAGE_SIZE = 100

type AccountingBackfillEventRow = Pick<
  AccountingReconciliationRows['accountingEvents'][number],
  'externalSystem' | 'type' | 'sourceEntityType' | 'sourceEntityId'
>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildSummary(results: AccountingEventBackfillResult[]): AccountingEventBackfillReport['summary'] {
  return results.reduce<AccountingEventBackfillReport['summary']>(
    (summary, result) => {
      summary.candidates += 1
      if (result.action === 'would_create') summary.wouldCreate += 1
      if (result.action === 'created') summary.created += 1
      if (result.action === 'skipped') summary.skipped += 1
      return summary
    },
    { candidates: 0, wouldCreate: 0, created: 0, skipped: 0 },
  )
}

function buildBackfillCandidateSummary(
  candidates: AccountingBackfillSyncLogRow[],
): AccountingEventBackfillReport['candidateSummary'] {
  const missingMirrorCount = candidates.length

  return {
    scope: 'accounting_event_backfill_candidates',
    total: missingMirrorCount,
    warning: missingMirrorCount,
    critical: 0,
    issues: missingMirrorCount > 0
      ? [{
          code: 'old_sync_log_without_mirrored_event',
          severity: 'warning',
          count: missingMirrorCount,
        }]
      : [],
  }
}

function syncLogResultBase(log: AccountingBackfillSyncLogRow): Omit<AccountingEventBackfillResult, 'action' | 'reason'> {
  return {
    syncLogId: log.id,
    connector: log.connector,
    type: log.type,
    referenceType: log.referenceType,
    referenceId: log.referenceId,
  }
}

function buildDraftForSyncLog(log: AccountingBackfillSyncLogRow, baseCurrency: string): AccountingEventDraft | null {
  return buildMirroredAccountingEventDraft({
    syncLogId: log.id,
    connector: log.connector,
    type: log.type,
    referenceType: log.referenceType,
    referenceId: log.referenceId,
    payload: log.payload,
    currency: baseCurrency,
    status: log.status,
    externalId: log.externalTransactionId,
  })
}

function hasMirroredAccountingEvent(
  accountingEvents: AccountingBackfillEventRow[],
  log: AccountingBackfillSyncLogRow,
): boolean {
  const connector = log.connector.trim()
  return accountingEvents.some((event) => {
    if (connector && event.externalSystem !== connector) return false
    return event.type === log.type &&
      event.sourceEntityType === log.referenceType &&
      event.sourceEntityId === log.referenceId
  })
}

function buildBackfillSyncLogWhere(lookbackDays: number | undefined): unknown {
  const fromDate = reconciliationLookbackDate(lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS)
  return {
    type: { in: [...MIRRORED_ACCOUNTING_SYNC_TYPES] },
    OR: [
      { status: { in: ['PENDING', 'PROCESSING'] } },
      { status: { in: ['SYNCED', 'FAILED'] }, createdAt: { gte: fromDate } },
    ],
  }
}

async function findExistingEventsForSyncLogs(
  client: AccountingBackfillCandidateClient,
  logs: AccountingBackfillSyncLogRow[],
): Promise<AccountingBackfillEventRow[]> {
  if (logs.length === 0) return []

  return client.accountingEvent.findMany({
    where: {
      OR: logs.map((log) => ({
        ...(log.connector.trim() ? { externalSystem: log.connector } : {}),
        type: log.type,
        sourceEntityType: log.referenceType,
        sourceEntityId: log.referenceId,
      })),
    },
    select: {
      externalSystem: true,
      type: true,
      sourceEntityType: true,
      sourceEntityId: true,
    },
  })
}

async function collectAccountingBackfillCandidateSyncLogs(
  client: AccountingBackfillCandidateClient,
  options: { lookbackDays?: number; limit: number },
): Promise<AccountingBackfillSyncLogRow[]> {
  const candidates: AccountingBackfillSyncLogRow[] = []
  const pageSize = BACKFILL_CANDIDATE_PAGE_SIZE
  let cursor: { id: string } | undefined

  while (candidates.length < options.limit) {
    const page = await client.accountingSyncLog.findMany({
      where: buildBackfillSyncLogWhere(options.lookbackDays),
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
      select: {
        id: true,
        connector: true,
        type: true,
        status: true,
        referenceType: true,
        referenceId: true,
        externalTransactionId: true,
        payload: true,
        // Stamped onto the repaired event so its age is the work's age, not the repair's.
        createdAt: true,
      },
    })
    if (page.length === 0) break

    const existingEvents = await findExistingEventsForSyncLogs(client, page)
    for (const log of page) {
      if (hasMirroredAccountingEvent(existingEvents, log)) continue
      candidates.push(log)
      if (candidates.length >= options.limit) break
    }

    cursor = { id: page[page.length - 1].id }
    if (page.length < pageSize) break
  }

  return candidates
}

async function writeBackfilledEvent(
  tx: AccountingBackfillWriteClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
): Promise<{ id: string }> {
  const event = await tx.accountingEvent.create({
    // `createdAt` is stamped from the SYNC LOG, not left to the column default: left to `now()`
    // every row repaired in one pass would carry the same repair-time stamp, and the oldest-PENDING
    // staleness signal in ops/health would report the age of the repair instead of the age of the
    // work. o3d-cvj9 r3: this is a reporting stamp ONLY. It is not, and after r2 is no longer read
    // as, the key that orders two revisions of one document.
    //
    // `externalRevisionAt` is deliberately left NULL. The only honest value is the stamp the
    // external system returned for the write, and a historical sync log never recorded the
    // connector response. Substituting the log's `syncedAt` or `createdAt` would put a second clock
    // into a comparison key that only means anything with one, so the row is repaired without a
    // stamp and the pairs it cannot order are refused rather than guessed at.
    //
    // o3d-cvj9 r4 (Codex r3 finding 3): what CAN be said is recorded instead, as a category rather
    // than a timestamp. A stamp-less row that ends up holding a document id was, under r3, ordered
    // by nothing at all — not the create rule (it is not the create) and not the stamp rule (it has
    // no stamp) — so every later live revision of that document was refused for ever and the ledger
    // froze on a historical edit. `revisionOrderBasis` says the one provable thing:
    // this repair mirrors a write the sync log had already recorded complete, for a document that
    // had no mirrored revision event when the candidate scan ran, so any live revision that can
    // later contend with it was enqueued afterwards. See HISTORICAL_BACKFILL_REVISION_ORDER_BASIS
    // and `documentRevisionHolderPrecedes` rule 3. Set only for revision types: nothing else ever
    // contends for a document id this way, and a basis on a journal row would assert nothing.
    data: {
      ...draft,
      createdAt: log.createdAt,
      ...(isDocumentRevisionAccountingSyncType(log.type)
        ? { revisionOrderBasis: HISTORICAL_BACKFILL_REVISION_ORDER_BASIS }
        : {}),
    } as never,
    select: { id: true },
  })
  await tx.accountingEventLog.create({
    data: buildAccountingEventLog({
      accountingEventId: event.id,
      action: 'backfilled_from_sync_log',
      metadata: {
        connector: log.connector,
        syncLogId: log.id,
        syncType: log.type,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
      },
    }) as never,
  })
  return event
}

/**
 * o3d-cvj9 r3: repair a historical revision WITHOUT contending for the document id.
 *
 * Used wherever the backfill knows the edit posted but cannot establish that it is the write the
 * document now reflects. The row is created so the sync log stops being invisible to
 * reconciliation, it takes no claim, and its audit log says in as many words that the ordering was
 * not established — as opposed to `revision_superseded_by_newer`, which asserts that it was.
 */
async function writeUnclaimedRevisionEvent(
  tx: AccountingBackfillWriteClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
): Promise<{ id: string }> {
  const externalId = draft.externalId?.trim() ? draft.externalId : null
  const holder = externalId
    ? await tx.accountingEvent.findUnique({
        where: { externalSystem_externalId: { externalSystem: log.connector, externalId } },
        select: { id: true },
      })
    : null
  const event = await writeBackfilledEvent(tx, log, { ...draft, status: 'SUPERSEDED', externalId: null })
  await tx.accountingEventLog.create({
    data: buildAccountingEventLog({
      accountingEventId: event.id,
      action: 'revision_claim_order_unverified',
      message: 'This revision posted, but which of it and the event holding the document id describes the '
        + 'document now could not be established, so the claim was left where it is.',
      metadata: {
        connector: log.connector,
        syncLogId: log.id,
        syncType: log.type,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
        externalId: draft.externalId ?? null,
        externalIdHeldByEventId: holder?.id ?? null,
        orderingBasis: 'unestablished',
      },
    }) as never,
  })
  return event
}

/**
 * o3d-cvj9 r3: does MORE THAN ONE revision of the same document need repairing?
 *
 * If so, none of them may take the document id — not even from the CREATE. "The create precedes its
 * revisions" is true of every one of them, so it says which of them is the LATEST exactly not at
 * all, and taking the claim on whichever one is reached first is a guess wearing a proof's clothes.
 * (r2 ordered them by the sync log's enqueue time, which is `CURRENT_TIMESTAMP` — transaction start
 * — and so was never edit order either.) With no external revision stamp on any historical row
 * there is nothing left that orders them, so all of them are repaired unclaimed and the id stays
 * wherever it already is.
 *
 * A document with exactly ONE revision that could have posted is unaffected: it contends only with
 * the create, and that pairing IS ordered.
 *
 * o3d-cvj9 r4 (Codex r3 finding 1) — THIS IS ASKED OF THE SYNC-LOG TABLE, NOT OF THE BATCH. r3
 * counted the revisions present in the current candidate list, which defeats the very guard it was
 * added for: the candidate scan stops at `limit`, and its `where` drops SYNCED logs older than the
 * lookback, so two revisions of one document are routinely NOT in front of the repair together.
 * Split across two runs, the first run sees one revision, calls it uncontested, hands it the id
 * taken from the create — and the second run then finds the id held by that backfilled revision and
 * leaves it alone. The arbitrary winner is left looking like a resolved claim, which is precisely
 * what deciding contestedness before the insert was meant to prevent.
 *
 * Counting instead every revision sync log recorded for the document closes the batch, the limit
 * and the lookback in one move, and it errs the safe way: a document whose other revision IS
 * already mirrored resolves to the same unclaimed repair anyway, because the holder is then a
 * revision and a historical arrival has no stamp to order itself against it.
 *
 * A sibling only counts if it MAY ALREADY HAVE POSTED — it is SYNCED, or it recorded an external
 * document id. A PENDING or FAILED revision that never reached the connector cannot be the write
 * the document now reflects, and when it does post later it posts through the LIVE mirror, which
 * carries Xero's stamp and can order itself against this repair (rule 3 in
 * `documentRevisionHolderPrecedes`). Counting those would refuse the ordinary single-edit repair
 * for nothing.
 */
type RevisionDocumentIdentity = {
  connector: string
  family: string
  referenceType: string
  referenceId: string
}

function revisionSyncLogMayHavePosted(
  log: Pick<AccountingBackfillSyncLogRow, 'status' | 'externalTransactionId'>,
): boolean {
  return log.status === 'SYNCED' || Boolean(log.externalTransactionId?.trim())
}

async function findContestedRevisionDocuments(
  client: AccountingBackfillCandidateClient,
  candidates: AccountingBackfillSyncLogRow[],
): Promise<Set<string>> {
  const documents = new Map<string, RevisionDocumentIdentity>()
  for (const log of candidates) {
    if (!isDocumentRevisionAccountingSyncType(log.type)) continue
    const family = accountingDocumentRevisionFamily(log.type)
    if (!family) continue
    documents.set(revisionDocumentKey(log), {
      connector: log.connector,
      family,
      referenceType: log.referenceType,
      referenceId: log.referenceId,
    })
  }
  if (documents.size === 0) return new Set()

  const siblings = await client.accountingSyncLog.findMany({
    where: {
      OR: [...documents.values()].map((document) => ({
        connector: document.connector,
        referenceType: document.referenceType,
        referenceId: document.referenceId,
        // Only the REVISION types of the family — the create is a legitimate predecessor of every
        // one of them, never a competitor for "which edit does the document reflect now".
        type: { in: [...accountingDocumentRevisionSyncTypes(document.family)] },
      })),
    },
    select: {
      id: true,
      connector: true,
      type: true,
      status: true,
      referenceType: true,
      referenceId: true,
      externalTransactionId: true,
    },
  })

  const postedRevisions = new Map<string, number>()
  for (const sibling of siblings) {
    if (!isDocumentRevisionAccountingSyncType(sibling.type)) continue
    if (!revisionSyncLogMayHavePosted(sibling)) continue
    const key = revisionDocumentKey(sibling)
    if (!documents.has(key)) continue
    postedRevisions.set(key, (postedRevisions.get(key) ?? 0) + 1)
  }
  return new Set([...postedRevisions].filter(([, count]) => count > 1).map(([key]) => key))
}

/**
 * The DOCUMENT a revision sync log edits. o3d-cvj9 r4: the recorded external id is deliberately NOT
 * part of it. Two revision logs raised from one source row are edits of one document whatever ids
 * they happen to carry, and keying on the id would split a document whose second edit recorded a
 * different one (or none) back into "uncontested" — the same arbitrary-winner hole, reached another
 * way. If the ids genuinely name different documents, that is a cross-document collision and the
 * lineage check refuses it by name.
 */
function revisionDocumentKey(
  log: Pick<AccountingBackfillSyncLogRow, 'connector' | 'type' | 'referenceType' | 'referenceId'>,
): string {
  return [
    log.connector,
    accountingDocumentRevisionFamily(log.type) ?? log.type,
    log.referenceType,
    log.referenceId,
  ].join('\u0000')
}

/**
 * o3d-cvj9 r2 — BACKFILLING A DOCUMENT REVISION THAT POSTED BEFORE THE MIRROR COULD RECORD IT.
 *
 * Round 1 fixed the live mirror and knowingly left this: every `*_INVOICE_UPDATE` that posted
 * while the mirror could not hand over an external id has a SYNCED sync log carrying the document
 * id, and no mirrored event. The backfill is the administrative repair for exactly that shape — and
 * it could not perform it, because its `create` hits the same `@@unique([externalSystem, externalId])`
 * the mirror hits, and the outer handler recorded the P2002 as an opaque `db_error:` string. The one
 * historical gap the backfill exists to close was the one it could not close.
 *
 * It now resolves the claim the same way the live path does, through the SAME function, so the two
 * cannot drift on what a legitimate takeover is:
 *
 *  - `takeover` — the holder is the document's CREATE, which provably precedes any revision of it.
 *    Release its claim and create the revision holding the id, auditing the supersession on the
 *    released row exactly as the mirror does.
 *  - `stale`    — a LATER write already holds the id. The historical edit still deserves a
 *    mirrored row, so it is created as SUPERSEDED with no claim, rather than yanking the id back
 *    off the revision that supersedes it.
 *  - `refused: recency_indeterminate` — TWO REVISIONS THAT CANNOT BE ORDERED. o3d-cvj9 r3: this is
 *    the backfill's ordinary case, not an edge one, and it must not be a skip. Ordering two
 *    revisions of one document requires the stamp the external system put on the document as it
 *    applied each write (`externalRevisionAt`), and a historical sync log never recorded the
 *    connector response — so the backfill has no stamp for its own row and often none for the
 *    holder either. Skipping strands exactly the rows this repair exists to rescue: the sync log
 *    stays SYNCED with no mirrored event at all, invisible to reconciliation, and every later run
 *    re-skips it.
 *
 *    So the row IS repaired, and the claim is NOT moved: the event is created with no external id,
 *    audited as `revision_claim_order_unverified` naming the row that keeps the claim, and reported
 *    as created-without-a-reference. That is the whole of what is known — this edit posted, and
 *    which of it and the holder describes the document now was not established — with nothing
 *    invented in either direction.
 *  - every other `refused` — a genuine collision: another document, or an unrelated event type,
 *    holds this id. Those must stay skipped and visible, with the SPECIFIC reason, so the report
 *    names it instead of a raw driver string.
 *
 * The whole repair runs in ONE transaction, so a released claim can never be left with no row
 * holding it. No savepoint is needed here (unlike the live mirror): the failed create rolled its own
 * transaction back, and this runs in a fresh one.
 */
async function backfillDocumentRevisionEvent(
  client: AccountingBackfillClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
): Promise<AccountingEventBackfillResult> {
  const outcome = await client.$transaction(async (tx) => {
    const claim = await resolveDocumentRevisionExternalIdClaim(
      // The backfill client is declared structurally (the real `db`, and the doubles the tests
      // inject); the shared resolver is typed against Prisma's transaction client.
      tx as unknown as AccountingEventMirrorTransactionClient,
      {
        connector: log.connector,
        type: log.type,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
        status: draft.status,
        externalId: draft.externalId,
      },
      // No connector response was ever recorded for a historical post, so this side of the
      // comparison has no external revision stamp and never pretends to.
      { externalRevisionAt: null },
    )

    if (claim.claim === 'refused' && claim.reason !== 'recency_indeterminate') {
      return { claim: 'refused' as const, reason: claim.reason }
    }

    if (claim.claim === 'refused') {
      return { claim: 'unordered' as const, eventId: (await writeUnclaimedRevisionEvent(tx, log, draft)).id }
    }

    if (claim.claim === 'stale') {
      const event = await writeBackfilledEvent(tx, log, {
        ...draft,
        status: 'SUPERSEDED',
        externalId: null,
      })
      await tx.accountingEventLog.create({
        data: buildAccountingEventLog({
          accountingEventId: event.id,
          action: 'revision_superseded_by_newer',
          metadata: {
            connector: log.connector,
            syncLogId: log.id,
            syncType: log.type,
            referenceType: log.referenceType,
            referenceId: log.referenceId,
            externalId: draft.externalId ?? null,
            externalIdHeldByEventId: claim.holderEventId,
          },
        }) as never,
      })
      return { claim: 'stale' as const, eventId: event.id }
    }

    const event = await writeBackfilledEvent(tx, log, draft)
    await tx.accountingEventLog.create({
      data: buildAccountingEventLog({
        accountingEventId: claim.supersededEventId,
        action: 'superseded_by_revision',
        metadata: {
          connector: log.connector,
          syncLogId: log.id,
          syncType: log.type,
          referenceType: log.referenceType,
          referenceId: log.referenceId,
          externalId: draft.externalId ?? null,
          supersededByEventId: event.id,
        },
      }) as never,
    })
    return { claim: 'takeover' as const, eventId: event.id }
  })

  if (outcome.claim === 'refused') {
    return {
      ...syncLogResultBase(log),
      action: 'skipped',
      reason: `external_reference_claimed_elsewhere: ${outcome.reason}`,
      idempotencyKey: draft.idempotencyKey,
    }
  }

  const reason = outcome.claim === 'stale'
    ? 'created_missing_mirror_as_superseded_revision'
    : outcome.claim === 'unordered'
      ? 'created_missing_mirror_unclaimed_revision_order_unverified'
      : 'created_missing_mirror_after_superseding_prior_revision'

  return {
    ...syncLogResultBase(log),
    action: 'created',
    reason,
    idempotencyKey: draft.idempotencyKey,
    accountingEventId: outcome.eventId,
  }
}

async function createBackfilledEvent(
  client: AccountingBackfillClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
  options: { contested: boolean },
): Promise<AccountingEventBackfillResult> {
  // o3d-cvj9 r3: several revisions of one document that may have posted — nothing orders them, so
  // none of them claims it. Decided BEFORE the insert, not in the collision handler: whichever of
  // them is reached first would otherwise find no holder at all, take the id unopposed, and the
  // arbitrary winner would look like a resolved claim.
  //
  // o3d-cvj9 r4 (Codex r3 finding 2): THE LINEAGE STILL HAS TO BE CHECKED. Writing the row with no
  // external id is exactly what stops the insert violating `@@unique([externalSystem, externalId])`
  // — and the P2002 was the only thing that carried the non-contested path into the cross-document
  // checks. So r3's contested branch repaired rows whose external id belonged to a DIFFERENT source
  // document, or to an unrelated event type, with a `revision_claim_order_unverified` audit that
  // says the two could not be ordered: it turned the double post the unique index exists to catch
  // into a benign-looking repair, and left the sync log reported as `created`. Those refusals are
  // not about ordering and are not excused by an unorderable pair, so they are asked for directly,
  // through the SAME lineage function the claiming path uses.
  if (options.contested) {
    const outcome = await client.$transaction(async (tx) => {
      const lineage = await inspectDocumentRevisionExternalIdClaim(
        tx as unknown as AccountingEventMirrorTransactionClient,
        {
          connector: log.connector,
          type: log.type,
          referenceType: log.referenceType,
          referenceId: log.referenceId,
          status: draft.status,
          externalId: draft.externalId,
        },
      )
      if (lineage.lineage === 'refused' && isCrossDocumentRevisionClaimRefusal(lineage.reason)) {
        return { claim: 'refused' as const, reason: lineage.reason }
      }
      return { claim: 'unordered' as const, eventId: (await writeUnclaimedRevisionEvent(tx, log, draft)).id }
    })

    if (outcome.claim === 'refused') {
      return {
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: `external_reference_claimed_elsewhere: ${outcome.reason}`,
        idempotencyKey: draft.idempotencyKey,
      }
    }

    return {
      ...syncLogResultBase(log),
      action: 'created',
      reason: 'created_missing_mirror_unclaimed_revision_order_unverified',
      idempotencyKey: draft.idempotencyKey,
      accountingEventId: outcome.eventId,
    }
  }

  try {
    const created = await client.$transaction((tx) => writeBackfilledEvent(tx, log, draft))

    return {
      ...syncLogResultBase(log),
      action: 'created',
      reason: 'created_missing_mirror',
      idempotencyKey: draft.idempotencyKey,
      accountingEventId: created.id,
    }
  } catch (error) {
    if (isIdempotencyKeyUniqueError(error)) {
      return {
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: 'accounting_event_already_exists',
        idempotencyKey: draft.idempotencyKey,
      }
    }
    // o3d-cvj9 r2: the external-document id is already claimed. For a REVISION that is expected —
    // it is what the whole feature is about — so resolve the claim instead of reporting a driver
    // error. Classified from the statement that raised it, so an idempotency-key clash above still
    // takes its own branch.
    if (isExternalAccountingReferenceUniqueError(error) && isDocumentRevisionAccountingSyncType(log.type)) {
      return backfillDocumentRevisionEvent(client, log, draft)
    }
    throw error
  }
}

async function resolveBaseCurrency(options: RunAccountingEventBackfillOptions): Promise<string> {
  if (options.baseCurrency) return options.baseCurrency
  if (options.client) {
    throw new Error('baseCurrency is required when a custom accounting backfill client is supplied')
  }
  return getBaseCurrencyCode()
}

export async function runAccountingEventBackfill(
  options: RunAccountingEventBackfillOptions = {},
): Promise<AccountingEventBackfillReport> {
  const client = options.client ?? (db as unknown as AccountingBackfillClient)
  const dryRun = options.dryRun ?? true
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_BACKFILL_LIMIT))
  const baseCurrency = await resolveBaseCurrency(options)
  const candidates = await collectAccountingBackfillCandidateSyncLogs(client, { lookbackDays: options.lookbackDays, limit })
  const contestedDocuments = await findContestedRevisionDocuments(client, candidates)

  const results: AccountingEventBackfillResult[] = []
  for (const log of candidates) {
    let draft: AccountingEventDraft | null
    try {
      draft = buildDraftForSyncLog(log, baseCurrency)
    } catch (error) {
      results.push({
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: `payload_validation_failed: ${errorMessage(error)}`,
      })
      continue
    }

    if (!draft) {
      results.push({
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: 'payload_not_mirrorable',
      })
      continue
    }

    if (draft.status === 'POSTED' && !draft.externalId?.trim()) {
      results.push({
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: 'posted_sync_log_missing_external_transaction_id',
        idempotencyKey: draft.idempotencyKey,
      })
      continue
    }

    if (dryRun) {
      results.push({
        ...syncLogResultBase(log),
        action: 'would_create',
        reason: 'dry_run',
        idempotencyKey: draft.idempotencyKey,
      })
      continue
    }

    try {
      results.push(await createBackfilledEvent(client, log, draft, {
        contested: isDocumentRevisionAccountingSyncType(log.type) && contestedDocuments.has(revisionDocumentKey(log)),
      }))
    } catch (error) {
      results.push({
        ...syncLogResultBase(log),
        action: 'skipped',
        reason: `db_error: ${errorMessage(error)}`,
        idempotencyKey: draft.idempotencyKey,
      })
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    dryRun,
    ...(options.lookbackDays !== undefined ? { lookbackDays: options.lookbackDays } : {}),
    limit,
    candidateSummary: buildBackfillCandidateSummary(candidates),
    summary: buildSummary(results),
    results,
  }
}
