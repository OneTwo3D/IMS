import { getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import { buildAccountingEventLog } from './accounting-event-builder'
import { buildMirroredAccountingEventDraft } from './accounting-event-mirror'
import type { AccountingEventDraft } from './accounting-event-types'
import { isIdempotencyKeyUniqueError } from './prisma-errors'
import {
  collectAccountingReconciliationRows,
  evaluateAccountingReconciliationRows,
  type AccountingReconciliationFinding,
  type AccountingReconciliationRows,
} from './reconciliation'

type AccountingBackfillSyncLogRow = AccountingReconciliationRows['syncLogs'][number]
type AccountingBackfillWriteClient = {
  accountingEvent: {
    create(args: unknown): Promise<{ id: string }>
  }
  accountingEventLog: {
    create(args: unknown): Promise<unknown>
  }
}
type AccountingBackfillClient = Parameters<typeof collectAccountingReconciliationRows>[0] & AccountingBackfillWriteClient & {
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

function candidateSyncLogIds(findings: AccountingReconciliationFinding[]): Set<string> {
  return new Set(findings.flatMap((finding) => (
    finding.code === 'old_sync_log_without_mirrored_event' && finding.syncLogId
      ? [finding.syncLogId]
      : []
  )))
}

function selectCandidateSyncLogs(
  rows: AccountingReconciliationRows,
  findings: AccountingReconciliationFinding[],
  limit: number,
): AccountingBackfillSyncLogRow[] {
  const ids = candidateSyncLogIds(findings)
  if (ids.size === 0) return []

  return rows.syncLogs
    .filter((log) => ids.has(log.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit)
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
  const rows = await collectAccountingReconciliationRows(client, { lookbackDays: options.lookbackDays })
  const findings = evaluateAccountingReconciliationRows(rows)
  const candidates = selectCandidateSyncLogs(rows, findings, limit)

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
    reconciliationSummary: findings.reduce(
      (summary, finding) => {
        summary.total += 1
        summary[finding.severity] += 1
        return summary
      },
      { total: 0, warning: 0, critical: 0 },
    ),
    summary: buildSummary(results),
    results,
  }
}
