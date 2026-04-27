import { getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import { buildAccountingEventLog } from './accounting-event-builder'
import {
  buildMirroredAccountingEventDraft,
  MIRRORED_ACCOUNTING_SYNC_TYPES,
} from './accounting-event-mirror'
import type { AccountingEventDraft } from './accounting-event-types'
import { isIdempotencyKeyUniqueError } from './prisma-errors'
import type { AccountingReconciliationRows } from './reconciliation'

type AccountingBackfillSyncLogRow = AccountingReconciliationRows['syncLogs'][number]
type AccountingBackfillWriteClient = {
  accountingEvent: {
    create(args: unknown): Promise<{ id: string }>
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

export type AccountingEventBackfillReport = {
  checkedAt: string
  dryRun: boolean
  lookbackDays?: number
  limit: number
  reconciliationSummary: {
    total: number
    warning: number
    critical: number
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

function lookbackDate(days: number): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function eventKey(input: {
  externalSystem?: string | null
  type: string
  sourceEntityType: string
  sourceEntityId: string
}): string {
  return [
    input.externalSystem ?? '*',
    input.type,
    input.sourceEntityType,
    input.sourceEntityId,
  ].join('|')
}

function hasMirroredAccountingEvent(
  accountingEvents: AccountingBackfillEventRow[],
  log: AccountingBackfillSyncLogRow,
): boolean {
  const key = eventKey({
    externalSystem: log.connector,
    type: log.type,
    sourceEntityType: log.referenceType,
    sourceEntityId: log.referenceId,
  })
  return accountingEvents.some((event) => eventKey(event) === key)
}

function buildBackfillSyncLogWhere(lookbackDays: number | undefined): unknown {
  const fromDate = lookbackDate(lookbackDays ?? 90)
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
        externalSystem: log.connector,
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
  const pageSize = Math.max(1, Math.min(options.limit, BACKFILL_CANDIDATE_PAGE_SIZE))
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

async function createBackfilledEvent(
  client: AccountingBackfillClient,
  log: AccountingBackfillSyncLogRow,
  draft: AccountingEventDraft,
): Promise<AccountingEventBackfillResult> {
  try {
    const created = await client.$transaction(async (tx) => {
      const event = await tx.accountingEvent.create({
        data: draft as never,
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
    })

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
    reconciliationSummary: { total: candidates.length, warning: candidates.length, critical: 0 },
    summary: buildSummary(results),
    results,
  }
}
