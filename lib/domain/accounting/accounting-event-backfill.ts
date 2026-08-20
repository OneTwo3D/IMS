import { getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import { buildAccountingEventLog } from './accounting-event-builder'
import {
  buildMirroredAccountingEventDraft,
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
 * o3d-cvj9 r2: `createdAt` is selected on top of the shared reconciliation row shape because the
 * revision repair below has to establish which of two rows describes the document as it now
 * stands, and the sync log's enqueue time is this path's half of that comparison.
 */
type AccountingBackfillSyncLogRow = AccountingReconciliationRows['syncLogs'][number] & { createdAt: Date }
/** The holder row `resolveDocumentRevisionExternalIdClaim` reads when an external id is contested. */
type AccountingBackfillClaimHolderRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  createdAt: Date
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
        // o3d-cvj9 r2: the revision repair needs the enqueue time to establish which of two rows
        // describes the document as it now stands.
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
    // o3d-cvj9 r2: `createdAt` is stamped from the SYNC LOG, not left to now(). A mirrored event's
    // createdAt means "when this sync was enqueued" — that is what makes it usable as the ordering
    // key when two events of one document contend for its external id — and a backfilled row has to
    // mean the same thing or the two kinds of row cannot be compared. Left to the column default,
    // every row repaired in one pass would carry the same repair-time stamp, and a document with
    // two historical revisions could not be ordered at all. It also makes the oldest-PENDING
    // staleness signal in ops/health report the real age of the work rather than the repair's.
    data: { ...draft, createdAt: log.createdAt } as never,
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
 *  - `takeover` — the holder is an older event for this document. Release its claim and create the
 *    revision holding the id, auditing the supersession on the released row exactly as the mirror does.
 *  - `stale`    — a NEWER revision already holds the id. The historical edit still deserves a
 *    mirrored row, so it is created as SUPERSEDED with no claim, rather than yanking the id back
 *    off the revision that supersedes it.
 *  - `refused`  — a genuine collision (another document holds this id), or two revisions that cannot
 *    be ordered. Skipped with the SPECIFIC reason, so the report names it instead of a raw driver string.
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
      { createdAt: log.createdAt },
    )

    if (claim.claim === 'refused') return { claim: 'refused' as const, reason: claim.reason }

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

  return {
    ...syncLogResultBase(log),
    action: 'created',
    reason: outcome.claim === 'stale'
      ? 'created_missing_mirror_as_superseded_revision'
      : 'created_missing_mirror_after_superseding_prior_revision',
    idempotencyKey: draft.idempotencyKey,
    accountingEventId: outcome.eventId,
  }
}

async function createBackfilledEvent(
  client: AccountingBackfillClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
): Promise<AccountingEventBackfillResult> {
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
      results.push(await createBackfilledEvent(client, log, draft))
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
