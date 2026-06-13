/**
 * Process pending XeroSyncLog entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one Xero API call.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { pushSalesInvoice, updateSalesInvoice } from './invoices'
import { pushPurchaseBill, updatePurchaseBill } from './bills'
import { pushCreditNote } from './credit-notes'
import { pushManualJournal } from './journals'
import { xeroUploadAttachment, xeroPost } from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { applyBackReference, backReferenceIsMissing, syncTypeWritesBackReference } from '@/lib/domain/accounting/back-reference'
import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import {
  claimIntegrationOutboxWork,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  parseXeroAccountingOutboxPayload,
  scheduleXeroAccountingOutbox,
  XERO_ACCOUNTING_POST_OPERATION,
  XERO_OUTBOX_CONNECTOR,
} from './outbox'
import { resolveStoredInvoiceUploadPath } from '@/lib/upload-storage'

const MAX_RETRIES = 5
const MAX_PER_RUN = 50 // Xero rate limit: 60/min — leave headroom
const CLAIM_STALE_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000
const XERO_CONNECTOR = 'xero'
const XERO_ACCOUNTING_WORKER_ID = 'xero-accounting-sync'

class XeroOutboxCompletionError extends Error {}

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>
type FollowUpSyncType = 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE'
type InvoicePaymentOrderingEntry = {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  createdAt: Date
}

export function isXeroAccountingOutboxEnabled(value = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED): boolean {
  return !['false', '0', 'off'].includes(String(value ?? 'true').trim().toLowerCase())
}

export function buildXeroIdempotencyKey(entryId: string, operation: string, payload?: SyncPayload): string {
  if (typeof payload?._idempotencyKey === 'string' && payload._idempotencyKey.trim()) {
    const digest = createHash('sha256').update(payload._idempotencyKey).digest('hex')
    return `ims-${operation}-${digest}`
  }
  return `ims-${operation}-${entryId}`
}

function getRateLimitBackoffMs(retryCount: number, message: string): number {
  const hinted = message.match(/retry after (\d+)ms/i)
  const hintedMs = hinted ? Number.parseInt(hinted[1] ?? '0', 10) : 0
  const exponential = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** retryCount, RATE_LIMIT_BACKOFF_MAX_MS)
  return Math.max(hintedMs, exponential)
}

function isRateLimitError(message: string): boolean {
  return /rate limit|rate limited|http 429|status 429/i.test(message)
}

async function updateMirroredEventForSyncLog(client: Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingEventLog'>, params: {
  syncLogId: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: SyncPayload
  status: 'POSTED' | 'FAILED'
  externalId?: string | null
  message?: string
}): Promise<void> {
  await updateMirroredAccountingEventStatus(client, {
    connector: XERO_CONNECTOR,
    syncLogId: params.syncLogId,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    payload: params.payload,
    status: params.status,
    externalId: params.externalId,
    message: params.message,
  })
}

export async function markSyncLogForFollowUpRetry(
  entry: { id: string; retryCount: number },
  error: unknown,
  client?: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
): Promise<{ errorMessage: string; finalFailure: boolean }> {
  const errorMessage = `Xero follow-up work failed after connector post: ${String(error)}`
  const retryCount = entry.retryCount + 1
  const finalFailure = retryCount >= MAX_RETRIES
  const conn = client ?? db
  // Optimistic-concurrency guard: only advance from the retryCount we observed.
  // Two workers handling the same sync log (e.g. duplicate outbox jobs pointing
  // at one AccountingSyncLog) must not both increment from a stale value and
  // double-write the failure transition. The compound where makes the update a
  // no-op for the loser of the race.
  const updated = await conn.accountingSyncLog.updateMany({
    where: { id: entry.id, retryCount: entry.retryCount },
    data: {
      status: finalFailure ? 'FAILED' : 'PENDING',
      retryCount,
      errorMessage,
      processingStartedAt: null,
    },
  })
  if (updated.count > 0) {
    return { errorMessage, finalFailure }
  }
  // Lost the race: another worker already advanced this row. Reflect the
  // PERSISTED state so the caller's outbox decision (permanent vs retry) acts on
  // reality, not our stale view — otherwise we could mark the outbox job for
  // retry while the row is already terminally FAILED (or vice-versa).
  const current = await conn.accountingSyncLog.findUnique({
    where: { id: entry.id },
    select: { retryCount: true, status: true },
  })
  return {
    errorMessage,
    finalFailure: current
      ? current.status === 'FAILED' || current.retryCount >= MAX_RETRIES
      : finalFailure,
  }
}

async function logFollowUpRetry(entryId: string, error: unknown): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_followup_error',
    tag: 'sync',
    level: 'WARNING',
    description: `Xero sync entry ${entryId} posted successfully but follow-up work failed and will be retried: ${String(error)}`,
  })
}

async function hasExistingSyncLog(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  const count = await db.accountingSyncLog.count({
    where: {
      connector: XERO_CONNECTOR,
      type,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
  })
  return count > 0
}

async function enqueueFollowUpSyncLog(
  type: FollowUpSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
): Promise<void> {
  if (await hasExistingSyncLog(type, referenceType, referenceId)) return
  await db.$transaction(async (tx) => {
    const log = await tx.accountingSyncLog.create({
      data: {
        connector: XERO_CONNECTOR,
        type,
        status: 'PENDING',
        referenceType,
        referenceId,
        payload: payload as never,
      },
    })
    await scheduleXeroAccountingOutbox(tx, {
      accountingSyncLogId: log.id,
    })
  })
}

function syncLogNextAttemptAt(log: { status: string; processingStartedAt: Date | null }): Date | null {
  if (log.status === 'PENDING' && log.processingStartedAt && log.processingStartedAt > new Date()) {
    return log.processingStartedAt
  }
  return null
}

function invoicePaymentReferenceKey(entry: Pick<InvoicePaymentOrderingEntry, 'referenceType' | 'referenceId'>): string {
  return `${entry.referenceType}\u0000${entry.referenceId}`
}

export async function findInvoicePaymentsBlockedByEarlierLiveLogs(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entries: InvoicePaymentOrderingEntry[],
): Promise<Set<string>> {
  const paymentEntries = entries.filter((entry) => entry.type === 'INVOICE_PAYMENT')
  if (paymentEntries.length === 0) return new Set()

  const referenceFilters = [...new Map(
    paymentEntries.map((entry) => [invoicePaymentReferenceKey(entry), {
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
    }]),
  ).values()]
  const liveLogs = await client.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'INVOICE_PAYMENT',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: referenceFilters,
    },
    select: { id: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const earliestLiveByReference = new Map<string, { id: string; createdAt: Date }>()
  for (const log of liveLogs) {
    const key = invoicePaymentReferenceKey(log)
    if (!earliestLiveByReference.has(key)) {
      earliestLiveByReference.set(key, log)
    }
  }

  const blocked = new Set<string>()
  for (const entry of paymentEntries) {
    const earliest = earliestLiveByReference.get(invoicePaymentReferenceKey(entry))
    if (earliest && earliest.id !== entry.id && earliest.createdAt < entry.createdAt) {
      blocked.add(entry.id)
    }
  }
  return blocked
}

async function deferPaymentUntilEarlierLogsPost(entry: { id: string }): Promise<void> {
  await db.accountingSyncLog.update({
    where: { id: entry.id },
    data: {
      status: 'PENDING',
      // Future processingStartedAt is the existing retry gate for PENDING sync
      // rows. Treat future values on PENDING rows as "earliest next claim time".
      processingStartedAt: new Date(Date.now() + 60_000),
      errorMessage: 'Deferred until older invoice payment sync logs post',
    },
  })
}

// audit-H5: an *_INVOICE_UPDATE must not post before the invoice's CREATE. The
// CREATE and its UPDATE share (referenceType, referenceId) — SALES_INVOICE /
// SalesOrder and PURCHASE_INVOICE / PurchaseOrder respectively.
const INVOICE_UPDATE_TO_CREATE_TYPE: Partial<Record<AccountingSyncType, AccountingSyncType>> = {
  SALES_INVOICE_UPDATE: 'SALES_INVOICE',
  PURCHASE_INVOICE_UPDATE: 'PURCHASE_INVOICE',
}

function invoiceCreateKey(createType: AccountingSyncType, referenceType: string, referenceId: string): string {
  return `${createType} ${referenceType} ${referenceId}`
}

/**
 * audit-H5: find *_INVOICE_UPDATE entries that should be deferred because the
 * invoice's CREATE row for the same document is still live (PENDING/PROCESSING).
 * Processing the UPDATE first fails with "invoice not found" and burns retries.
 * Same shape/pattern as findInvoicePaymentsBlockedByEarlierLiveLogs.
 */
export async function findInvoiceUpdatesBlockedByPendingCreate(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entries: InvoicePaymentOrderingEntry[],
): Promise<Set<string>> {
  const updateEntries = entries.filter((entry) => INVOICE_UPDATE_TO_CREATE_TYPE[entry.type])
  if (updateEntries.length === 0) return new Set()

  const orFilters = [...new Map(updateEntries.map((entry) => {
    const createType = INVOICE_UPDATE_TO_CREATE_TYPE[entry.type]!
    return [invoiceCreateKey(createType, entry.referenceType, entry.referenceId), {
      type: createType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
    }]
  })).values()]

  const liveCreates = await client.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: orFilters,
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const earliestLiveCreateByKey = new Map<string, { id: string; createdAt: Date }>()
  for (const log of liveCreates) {
    const key = invoiceCreateKey(log.type, log.referenceType, log.referenceId)
    if (!earliestLiveCreateByKey.has(key)) earliestLiveCreateByKey.set(key, log)
  }

  const blocked = new Set<string>()
  for (const entry of updateEntries) {
    const createType = INVOICE_UPDATE_TO_CREATE_TYPE[entry.type]!
    const liveCreate = earliestLiveCreateByKey.get(invoiceCreateKey(createType, entry.referenceType, entry.referenceId))
    // Defer only when the live CREATE was queued no later than the UPDATE — the
    // normal case (CREATE first, possibly same millisecond). A CREATE queued
    // AFTER this UPDATE (a re-issued invoice) does not block it, so the UPDATE is
    // never deferred indefinitely waiting on a newer CREATE.
    if (liveCreate && liveCreate.createdAt <= entry.createdAt) {
      blocked.add(entry.id)
    }
  }
  return blocked
}

async function deferUpdateUntilCreatePosts(entry: { id: string }): Promise<void> {
  await db.accountingSyncLog.update({
    where: { id: entry.id },
    data: {
      status: 'PENDING',
      processingStartedAt: new Date(Date.now() + 60_000),
      errorMessage: 'Deferred until the invoice CREATE for this document posts',
    },
  })
}

async function ensureXeroOutboxForPendingSyncLogs(limit: number, staleClaimCutoff: Date): Promise<void> {
  const now = new Date()
  const logs = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      OR: [
        {
          status: 'PENDING',
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lte: now } },
          ],
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleClaimCutoff },
        },
      ],
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  for (const log of logs) {
    await scheduleXeroAccountingOutbox(db, {
      accountingSyncLogId: log.id,
      nextAttemptAt: syncLogNextAttemptAt(log),
      attempts: log.retryCount,
      resetAttempts: true,
    })
  }
}

function accountingSyncLogClaimWhere(id: string, staleClaimCutoff: Date) {
  return {
    id,
    connector: XERO_CONNECTOR,
    retryCount: { lt: MAX_RETRIES },
    OR: [
      {
        status: 'PENDING' as const,
        OR: [
          { processingStartedAt: null },
          { processingStartedAt: { lte: new Date() } },
        ],
      },
      {
        status: 'PROCESSING' as const,
        processingStartedAt: { lt: staleClaimCutoff },
      },
    ],
  }
}

async function deferOutboxForRateLimit(
  client: Pick<Prisma.TransactionClient, 'integrationOutbox'>,
  job: IntegrationOutboxRow,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  const released = await client.integrationOutbox.updateMany({
    where: {
      id: job.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedBy: XERO_ACCOUNTING_WORKER_ID,
      lockedAt: job.lockedAt,
    },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      nextAttemptAt: new Date(Date.now() + retryDelayMs),
      lastError: error.slice(0, 1000),
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (released.count === 0) throw new Error(`Xero outbox job ${job.id} is not claimed by ${XERO_ACCOUNTING_WORKER_ID}`)
}

async function markXeroOutboxRetry(job: IntegrationOutboxRow, error: string, client?: Pick<Prisma.TransactionClient, 'integrationOutbox'>): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  await markIntegrationOutboxRetryableFailure({
    client,
    id: job.id,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    lockedAt: job.lockedAt,
    error,
    attemptsBeforeFailure: job.attempts,
    maxAttempts: MAX_RETRIES,
  })
}

async function markXeroOutboxPermanent(job: IntegrationOutboxRow, error: string, client?: Pick<Prisma.TransactionClient, 'integrationOutbox'>): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  await markIntegrationOutboxPermanentFailure({
    client,
    id: job.id,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    lockedAt: job.lockedAt,
    error,
  })
}

async function markXeroOutboxSuccess(job: IntegrationOutboxRow): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  try {
    await markIntegrationOutboxSuccess({
      id: job.id,
      workerId: XERO_ACCOUNTING_WORKER_ID,
      lockedAt: job.lockedAt,
    })
  } catch (error) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_outbox_completion_error',
      tag: 'sync',
      level: 'ERROR',
      description: `Xero outbox job ${job.id} posted but mark-complete failed: ${String(error)}`,
    })
    throw new XeroOutboxCompletionError(`Xero outbox job ${job.id} posted but mark-complete failed: ${String(error)}`)
  }
}

export async function processPendingXeroSync(): Promise<ProcessResult> {
  if (!isXeroAccountingOutboxEnabled()) {
    return processPendingXeroSyncDirect()
  }
  return processPendingXeroSyncViaOutbox()
}

async function processPendingXeroSyncDirect(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  const pending = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      OR: [
        {
          status: 'PENDING',
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lte: new Date() } },
          ],
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleClaimCutoff },
        },
      ],
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_RUN,
  })
  const blockedPaymentEntryIds = await findInvoicePaymentsBlockedByEarlierLiveLogs(db, pending)
  const blockedUpdateEntryIds = await findInvoiceUpdatesBlockedByPendingCreate(db, pending)

  for (const entry of pending) {
    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    })
    if (claim.count === 0) continue

    result.processed++
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      if (blockedPaymentEntryIds.has(entry.id)) {
        await deferPaymentUntilEarlierLogsPost(entry)
        result.skipped++
        continue
      }
      if (blockedUpdateEntryIds.has(entry.id)) {
        await deferUpdateUntilCreatePosts(entry)
        result.skipped++
        continue
      }

      if (entry.externalTransactionId) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: entry.externalTransactionId,
          })
        })
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
        } catch (followUpError) {
          await markSyncLogForFollowUpRetry(entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }
        result.succeeded++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload)

      if (syncResult.success) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              externalTransactionId: syncResult.externalId ?? null,
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: syncResult.externalId ?? null,
          })
        })

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
        } catch (followUpError) {
          await markSyncLogForFollowUpRetry(entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }

        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          await db.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'PENDING',
              errorMessage,
              processingStartedAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
            },
          })
        } else {
          const retryCount = entry.retryCount + 1
          const finalFailure = retryCount >= MAX_RETRIES
          await db.$transaction(async (tx) => {
            await tx.accountingSyncLog.update({
              where: { id: entry.id },
              data: {
                status: finalFailure ? 'FAILED' : 'PENDING',
                retryCount,
                errorMessage,
                processingStartedAt: null,
              },
            })
            if (finalFailure) {
              await updateMirroredEventForSyncLog(tx, {
                syncLogId: entry.id,
                type: entry.type,
                referenceType: entry.referenceType,
                referenceId: entry.referenceId,
                payload,
                status: 'FAILED',
                message: errorMessage,
              })
            }
          })
        }
        result.failed++
      }
    } catch (e) {
      const errorMessage = String(e)
      if (isRateLimitError(errorMessage)) {
        await db.accountingSyncLog.update({
          where: { id: entry.id },
          data: {
            status: 'PENDING',
            errorMessage,
            processingStartedAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
          },
        })
      } else {
        const retryCount = entry.retryCount + 1
        const finalFailure = retryCount >= MAX_RETRIES
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: finalFailure ? 'FAILED' : 'PENDING',
              retryCount,
              errorMessage,
              processingStartedAt: null,
            },
          })
          if (finalFailure) {
            await updateMirroredEventForSyncLog(tx, {
              syncLogId: entry.id,
              type: entry.type,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
              payload,
              status: 'FAILED',
              message: errorMessage,
            })
          }
        })
      }
      result.failed++
    }
  }

  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: XERO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  result.skipped = skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_sync_batch',
      tag: 'sync',
      description: `Xero sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: { ...result, mode: 'direct' },
    })
  }

  return result
}

async function processPendingXeroSyncViaOutbox(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  await ensureXeroOutboxForPendingSyncLogs(MAX_PER_RUN, staleClaimCutoff)
  const jobs = await claimIntegrationOutboxWork({
    connector: XERO_OUTBOX_CONNECTOR,
    operation: XERO_ACCOUNTING_POST_OPERATION,
    limit: MAX_PER_RUN,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    staleLockMs: CLAIM_STALE_MS,
    maxAttempts: MAX_RETRIES,
  })

  const jobWork: Array<{ job: IntegrationOutboxRow; syncLogId: string }> = []
  for (const job of jobs) {
    if (!job.lockedAt) {
      result.failed++
      continue
    }

    try {
      jobWork.push({ job, syncLogId: parseXeroAccountingOutboxPayload(job).accountingSyncLogId })
    } catch (error) {
      await markXeroOutboxPermanent(job, error instanceof Error ? error.message : String(error))
      result.failed++
      continue
    }
  }

  const entries = jobWork.length > 0
    ? await db.accountingSyncLog.findMany({
        where: { id: { in: [...new Set(jobWork.map((work) => work.syncLogId))] } },
      })
    : []
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  const blockedPaymentEntryIds = await findInvoicePaymentsBlockedByEarlierLiveLogs(db, entries)
  const blockedUpdateEntryIds = await findInvoiceUpdatesBlockedByPendingCreate(db, entries)

  for (const { job, syncLogId } of jobWork) {
    const entry = entriesById.get(syncLogId)
    if (!entry) {
      await markXeroOutboxPermanent(job, `Accounting sync log ${syncLogId} was not found`)
      result.failed++
      continue
    }
    if (entry.status === 'SYNCED' && entry.externalTransactionId) {
      await markXeroOutboxSuccess(job)
      result.skipped++
      continue
    }

    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    })
    if (claim.count === 0) {
      if (entry.status === 'SYNCED') {
        await markXeroOutboxSuccess(job)
      } else if (entry.status === 'FAILED' || entry.retryCount >= MAX_RETRIES) {
        await markXeroOutboxPermanent(job, entry.errorMessage ?? `Accounting sync log ${entry.id} is not claimable`)
      } else {
        await markXeroOutboxRetry(job, `Accounting sync log ${entry.id} is not currently claimable`)
      }
      continue
    }

    result.processed++
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      if (blockedPaymentEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'PENDING',
              // Future processingStartedAt is the existing retry gate for
              // PENDING sync rows; here it means "earliest next claim time".
              processingStartedAt: new Date(Date.now() + 60_000),
              errorMessage: 'Deferred until older invoice payment sync logs post',
            },
          })
          await markXeroOutboxRetry(job, 'Deferred until older invoice payment sync logs post', tx)
        })
        result.skipped++
        continue
      }

      if (blockedUpdateEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'PENDING',
              processingStartedAt: new Date(Date.now() + 60_000),
              errorMessage: 'Deferred until the invoice CREATE for this document posts',
            },
          })
          await markXeroOutboxRetry(job, 'Deferred until the invoice CREATE for this document posts', tx)
        })
        result.skipped++
        continue
      }

      if (entry.externalTransactionId) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: entry.externalTransactionId,
          })
        })
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(entry, followUpError, tx)
            if (nextRetry.finalFailure) {
              await markXeroOutboxPermanent(job, nextRetry.errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, nextRetry.errorMessage, tx)
            }
            return nextRetry
          })
          await logFollowUpRetry(entry.id, followUpError)
          if (!retry.errorMessage) throw new Error(`Xero sync entry ${entry.id} follow-up failure could not be recorded`)
          result.failed++
          continue
        }
        await markXeroOutboxSuccess(job)
        result.succeeded++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload)

      if (syncResult.success) {
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              externalTransactionId: syncResult.externalId ?? null,
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: syncResult.externalId ?? null,
          })
        })

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(entry, followUpError, tx)
            if (nextRetry.finalFailure) {
              await markXeroOutboxPermanent(job, nextRetry.errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, nextRetry.errorMessage, tx)
            }
            return nextRetry
          })
          await logFollowUpRetry(entry.id, followUpError)
          if (!retry.errorMessage) throw new Error(`Xero sync entry ${entry.id} follow-up failure could not be recorded`)
          result.failed++
          continue
        }

        await markXeroOutboxSuccess(job)
        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          const retryDelayMs = getRateLimitBackoffMs(entry.retryCount, errorMessage)
          await db.$transaction(async (tx) => {
            await tx.accountingSyncLog.update({
              where: { id: entry.id },
              data: {
                status: 'PENDING',
                errorMessage,
                processingStartedAt: new Date(Date.now() + retryDelayMs),
              },
            })
            await deferOutboxForRateLimit(tx, job, errorMessage, retryDelayMs)
          })
        } else {
          const retryCount = entry.retryCount + 1
          const finalFailure = retryCount >= MAX_RETRIES
          await db.$transaction(async (tx) => {
            await tx.accountingSyncLog.update({
              where: { id: entry.id },
              data: {
                status: finalFailure ? 'FAILED' : 'PENDING',
                retryCount,
                errorMessage,
                processingStartedAt: null,
              },
            })
            if (finalFailure) {
              await updateMirroredEventForSyncLog(tx, {
                syncLogId: entry.id,
                type: entry.type,
                referenceType: entry.referenceType,
                referenceId: entry.referenceId,
                payload,
                status: 'FAILED',
                message: errorMessage,
              })
            }
            if (finalFailure) {
              await markXeroOutboxPermanent(job, errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, errorMessage, tx)
            }
          })
        }
        result.failed++
      }
    } catch (e) {
      if (e instanceof XeroOutboxCompletionError) throw e
      const errorMessage = String(e)
      if (isRateLimitError(errorMessage)) {
        const retryDelayMs = getRateLimitBackoffMs(entry.retryCount, errorMessage)
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'PENDING',
              errorMessage,
              processingStartedAt: new Date(Date.now() + retryDelayMs),
            },
          })
          await deferOutboxForRateLimit(tx, job, errorMessage, retryDelayMs)
        })
      } else {
        const retryCount = entry.retryCount + 1
        const finalFailure = retryCount >= MAX_RETRIES
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: finalFailure ? 'FAILED' : 'PENDING',
              retryCount,
              errorMessage,
              processingStartedAt: null,
            },
          })
          if (finalFailure) {
            await updateMirroredEventForSyncLog(tx, {
              syncLogId: entry.id,
              type: entry.type,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
              payload,
              status: 'FAILED',
              message: errorMessage,
            })
          }
          if (finalFailure) {
            await markXeroOutboxPermanent(job, errorMessage, tx)
          } else {
            await markXeroOutboxRetry(job, errorMessage, tx)
          }
        })
      }
      result.failed++
    }
  }

  // Log skipped entries (exceeded max retries)
  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: XERO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  result.skipped = skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_sync_batch',
      tag: 'sync',
      description: `Xero sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: result,
    })
  }

  return result
}

/** Resolve _postingMode to Xero API status values */
function resolveInvoiceStatus(mode: unknown): string {
  return mode === 'draft' ? 'DRAFT' : 'AUTHORISED'
}
function resolveJournalStatus(mode: unknown): string {
  return mode === 'draft' ? 'DRAFT' : 'POSTED'
}

async function processEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
): Promise<{ success: boolean; externalId?: string; invoiceNumber?: string; error?: string }> {
  const postingMode = payload._postingMode

  switch (type) {
    case 'SALES_INVOICE': {
      const customerId = referenceType === 'SalesOrder'
        ? (await db.salesOrder.findUnique({
            where: { id: referenceId },
            select: { customerId: true },
          }).catch(() => null))?.customerId ?? undefined
        : undefined
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice', payload)
      const invoiceResult = await pushSalesInvoice({
        invoiceNumber: payload.invoiceNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; discountAmount?: number }>,
        shippingAmount: payload.shippingAmount as number | undefined,
        shippingDescription: payload.shippingDescription as string | undefined,
        shippingAccountCode: payload.shippingAccountCode as string | undefined,
        shippingTaxType: payload.shippingTaxType as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        discountTaxType: payload.discountTaxType as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: invoiceIdempotencyKey, customerId })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, error: invoiceResult.error }
    }

    case 'SALES_INVOICE_UPDATE': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for SALES_INVOICE_UPDATE' }
      }
      const customerId = referenceType === 'SalesOrder'
        ? (await db.salesOrder.findUnique({
            where: { id: referenceId },
            select: { customerId: true },
          }).catch(() => null))?.customerId ?? undefined
        : undefined
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice-update', payload)
      const invoiceResult = await updateSalesInvoice(accountingInvoiceId, {
        invoiceNumber: payload.invoiceNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; discountAmount?: number }>,
        shippingAmount: payload.shippingAmount as number | undefined,
        shippingDescription: payload.shippingDescription as string | undefined,
        shippingAccountCode: payload.shippingAccountCode as string | undefined,
        shippingTaxType: payload.shippingTaxType as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        discountTaxType: payload.discountTaxType as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: invoiceIdempotencyKey, customerId })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, error: invoiceResult.error }
    }

    case 'PURCHASE_INVOICE': {
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true, supplier: { select: { email: true } } },
          }).catch(() => null)
        : null
      const billIdempotencyKey = buildXeroIdempotencyKey(entryId, 'bill', payload)
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: billIdempotencyKey, supplierId: supplier?.supplierId, supplierEmail: supplier?.supplier.email ?? undefined })
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
    }

    case 'PURCHASE_INVOICE_UPDATE': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for PURCHASE_INVOICE_UPDATE' }
      }
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true, supplier: { select: { email: true } } },
          }).catch(() => null)
        : null
      const billIdempotencyKey = buildXeroIdempotencyKey(entryId, 'bill-update', payload)
      const billResult = await updatePurchaseBill(accountingInvoiceId, {
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: billIdempotencyKey, supplierId: supplier?.supplierId, supplierEmail: supplier?.supplier.email ?? undefined })
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
    }

    case 'INVOICE_PAYMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for INVOICE_PAYMENT' }
      }
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      try {
        const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
          Invoice: { InvoiceID: accountingInvoiceId },
          Account: { AccountID: account.externalAccountId },
          Date: paymentDate,
          Amount: amount,
        }, { idempotencyKey: buildXeroIdempotencyKey(entryId, 'invoice-payment') })
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
        }
        const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
        return { success: true, externalId: paymentId }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'BILL_ATTACHMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const supplierInvoicePath = payload.supplierInvoicePath as string | undefined
      if (!accountingInvoiceId || !supplierInvoicePath) {
        return { success: false, error: 'Missing accountingInvoiceId or supplierInvoicePath for BILL_ATTACHMENT' }
      }
      const attachEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_attach_pdf' } })
      if (attachEnabled?.value === 'false') {
        return { success: true }
      }
      try {
        const relPath = supplierInvoicePath.replace(/^\/+/, '')
        const pdfPath = resolveStoredInvoiceUploadPath(relPath)
        if (!pdfPath) {
          return { success: false, error: 'Invalid supplier invoice PDF path' }
        }
        const pdfBuffer = await readFile(pdfPath)
        const filename = relPath.split('/').pop() ?? 'supplier-invoice.pdf'
        const uploadRes = await xeroUploadAttachment('Invoices', accountingInvoiceId, filename, pdfBuffer, 'application/pdf')
        if (!uploadRes.ok) {
          return { success: false, error: uploadRes.error ?? 'Failed to attach supplier invoice PDF' }
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'INVOICE_PDF': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const orderId = payload.referenceId as string | undefined
      if (!accountingInvoiceId || !orderId) {
        return { success: false, error: 'Missing accountingInvoiceId or referenceId for INVOICE_PDF' }
      }
      try {
        const { downloadXeroInvoicePdf, saveInvoicePdf } = await import('./invoice-pdf')
        const pdfBuffer = await downloadXeroInvoicePdf(accountingInvoiceId)
        if (!pdfBuffer) return { success: false, error: 'Failed to download Xero invoice PDF' }
        const pdfPath = await saveInvoicePdf(orderId, pdfBuffer)
        await db.salesOrder.update({
          where: { id: orderId },
          data: { invoicePdfPath: pdfPath },
        })
        return { success: true }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'INVOICE_EMAIL': {
      const orderId = payload.referenceId as string | undefined
      if (!orderId) return { success: false, error: 'Missing referenceId for INVOICE_EMAIL' }
      const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
      const emailResult = await sendAccountingInvoiceEmailInternal(orderId)
      return emailResult.success ? { success: true } : { success: false, error: emailResult.error ?? 'Failed to email invoice' }
    }

    case 'WC_INVOICE_NOTE': {
      const orderId = payload.referenceId as string | undefined
      if (!orderId) return { success: false, error: 'Missing referenceId for WC_INVOICE_NOTE' }
      const { pushInvoiceNoteToWc } = await import('@/lib/connectors/woocommerce/sync/invoice-note')
      const wcResult = await pushInvoiceNoteToWc(orderId)
      return wcResult.success ? { success: true } : { success: false, error: wcResult.error ?? 'Failed to notify WooCommerce about invoice' }
    }

    case 'BILL_PAYMENT': {
      // Register a payment in Xero against an existing bill (purchase
      // invoice). The bill must already have an accountingInvoiceId set.
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for BILL_PAYMENT' }
      }
      // Resolve bank account — accept either Xero AccountID (preferred) or a legacy account code.
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      try {
        const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
          Invoice: { InvoiceID: accountingInvoiceId },
          Account: { AccountID: account.externalAccountId },
          Date: paymentDate,
          Amount: amount,
          Reference: (payload.reference as string | undefined) ?? undefined,
        }, { idempotencyKey: buildXeroIdempotencyKey(entryId, 'bill-payment') })
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
        }
        const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
        return { success: true, externalId: paymentId }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'CREDIT_NOTE': {
      const creditCustomerId = referenceType === 'SalesOrderRefund'
        ? (await db.salesOrderRefund.findUnique({
            where: { id: referenceId },
            select: { order: { select: { customerId: true } } },
          }).catch(() => null))?.order.customerId ?? undefined
        : undefined
      return pushCreditNote({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(entryId, 'credit-note'), customerId: creditCustomerId }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))
    }

    case 'COGS_JOURNAL':
    case 'INVENTORY_ADJUSTMENT':
    case 'STOCK_IN_TRANSIT':
    case 'STOCK_RECEIPT':
    case 'COGS_REVERSAL':
    case 'STOCK_ALLOCATION':
    case 'DAILY_BATCH_REVENUE_DEFERRAL':
    case 'DAILY_BATCH_INVENTORY_ALLOC':
    case 'DAILY_BATCH_GROUP_B':
    case 'UNEARNED_REV_REVERSAL':
    case 'REALISED_FX_JOURNAL':
    case 'UNREALISED_FX_JOURNAL':
    case 'MANUFACTURING_JOURNAL':
    case 'MANUFACTURING_RECLASS': {
      const idempotencySource = typeof payload._idempotencyKey === 'string'
        ? payload._idempotencyKey
        : type.startsWith('DAILY_BATCH_')
        ? `${type}:${referenceId}`
        : entryId
      return pushManualJournal({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, resolveJournalStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(idempotencySource, 'manual-journal') }).then(r => ({ success: r.success, externalId: r.journalId, error: r.error }))
    }

    case 'TAX_RATE_SYNC': {
      const { putXeroTaxRate } = await import('./tax-rates')
      const name = payload.name as string | undefined
      const components = payload.components as Array<{ name: string; rate: number; compoundOnPrevious: boolean; accountingTaxType?: string | null }> | undefined
      if (!name || !components || components.length === 0) {
        return { success: false, error: 'TAX_RATE_SYNC payload missing name or components' }
      }
      const idempotencyKey = buildXeroIdempotencyKey(entryId, 'tax-rate', payload)
      const result = await putXeroTaxRate({
        name,
        reportTaxType: payload.reportTaxType as string | null | undefined,
        components,
        status: (payload.status as 'ACTIVE' | 'ARCHIVED' | undefined) ?? 'ACTIVE',
      }, { idempotencyKey })
      return { success: result.success, externalId: result.taxType, error: result.error }
    }

    default:
      return { success: false, error: `Unknown sync type: ${type}` }
  }
}

async function updateBackReference(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  externalId?: string,
  invoiceNumber?: string,
): Promise<void> {
  if (!externalId) return
  // audit-H3: do NOT swallow failures here. The external id is already persisted
  // on the sync row (externalTransactionId) before this runs, and the caller's
  // catch marks the row for retry so the next pass re-applies the back-reference
  // from the stored id. Swallowing left the document permanently orphaned.
  await applyBackReference(db, { type, referenceType, referenceId, externalId, invoiceNumber })
}

export type BackReferenceRepairResult = {
  /** Rows whose document was confirmed still missing its id (i.e. needed repair). */
  checked: number
  /** Rows whose back-reference was successfully re-applied. */
  repaired: number
  /** Rows that errored during probe or repair. */
  failed: number
  /** Ambiguous multi-bill POs skipped to avoid misattributing an external id. */
  skippedAmbiguous: number
}

/**
 * audit-H3 repair sweep. Finds sync rows that posted to the connector (have an
 * externalTransactionId) but whose source document never received the external
 * id — e.g. the process died between marking the row SYNCED and writing the
 * back-reference, or the back-reference retries were exhausted to FAILED. Re-
 * applies the back-reference from the stored id AND re-enqueues the follow-ups
 * (PDF/payment/attachment) that never ran, so no document is permanently
 * orphaned. Safe to run repeatedly (idempotent) from cron or on demand.
 */
export async function repairXeroBackReferences(limit = 200): Promise<BackReferenceRepairResult> {
  const candidates = await db.accountingSyncLog.findMany({
    where: {
      connector: 'xero',
      status: { in: ['SYNCED', 'FAILED'] },
      externalTransactionId: { not: null },
      type: { in: ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE'] },
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, externalTransactionId: true, status: true, payload: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  // audit-H3 (review): a PURCHASE_INVOICE row references the PO, not a specific
  // bill. When a PO has several bills (several such rows), the "latest unlinked
  // bill" heuristic could stamp one bill's Xero id onto another. Detect POs with
  // more than one candidate row and skip them — they need manual attribution
  // rather than a guess that could swap ids.
  const poCandidateCounts = new Map<string, number>()
  for (const row of candidates) {
    if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder') {
      poCandidateCounts.set(row.referenceId, (poCandidateCounts.get(row.referenceId) ?? 0) + 1)
    }
  }

  const result: BackReferenceRepairResult = { checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0 }
  for (const row of candidates) {
    if (!row.externalTransactionId || !syncTypeWritesBackReference(row.type, row.referenceType)) continue
    if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder' && (poCandidateCounts.get(row.referenceId) ?? 0) > 1) {
      result.skippedAmbiguous++
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_backreference_repair_ambiguous',
        tag: 'sync',
        level: 'WARNING',
        description: `Skipped Xero back-reference repair for PO ${row.referenceId}: multiple bills have unwritten external ids and cannot be attributed automatically. Link them manually.`,
        metadata: { syncLogId: row.id, referenceId: row.referenceId },
      })
      continue
    }
    const payload = (row.payload ?? {}) as SyncPayload
    const params = {
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      externalId: row.externalTransactionId,
      invoiceNumber: typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber : undefined,
    }
    let missing: boolean
    try {
      missing = await backReferenceIsMissing(db, params)
    } catch (probeError) {
      console.error('repairXeroBackReferences: probe failed', row.id, probeError)
      result.failed++
      continue
    }
    if (!missing) continue
    result.checked++
    try {
      await applyBackReference(db, params)
      // The follow-ups (PDF, payment, attachment) never ran on the original
      // failed pass — enqueue them now. hasExistingSyncLog makes this idempotent.
      try {
        await enqueueFollowUps(row.id, row.type, row.referenceType, row.referenceId, payload, { externalId: row.externalTransactionId, invoiceNumber: params.invoiceNumber })
      } catch (followUpError) {
        console.error('repairXeroBackReferences: follow-up enqueue failed', row.id, followUpError)
      }
      // A FAILED row whose back-reference is now applied is fully reconciled.
      if (row.status === 'FAILED') {
        await db.accountingSyncLog.update({ where: { id: row.id }, data: { status: 'SYNCED', errorMessage: null } })
      }
      result.repaired++
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_backreference_repaired',
        tag: 'sync',
        level: 'INFO',
        description: `Re-applied missing Xero back-reference for ${row.referenceType} ${row.referenceId} (external id ${row.externalTransactionId}).`,
        metadata: { syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId },
      })
    } catch (repairError) {
      result.failed++
      console.error('repairXeroBackReferences: repair failed', row.id, repairError)
    }
  }
  return result
}

async function enqueueSalesInvoiceFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
): Promise<void> {
  if (referenceType !== 'SalesOrder' || !syncResult.externalId) return

  if (payload._registerPayment) {
    const paymentMap = await getPaymentAccountMap()
    const method = payload._paymentMethod as string || ''
    const currency = payload.currency as string || 'GBP'

    if (!paymentMap || Object.keys(paymentMap).length === 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_payment_skipped',
        tag: 'sync',
        level: 'WARNING',
        description: 'Skipped Xero payment registration: no payment account map configured. Go to Settings → Accounting → Payment Account Mapping to set up bank accounts for each payment method.',
      })
    } else {
      const stored = lookupPaymentAccount(paymentMap, method, currency)
      if (!stored) {
        await logActivity({
          entityType: 'SYSTEM',
          action: 'xero_payment_skipped',
          tag: 'sync',
          level: 'WARNING',
          description: `Skipped Xero payment registration: no bank account mapped for method "${method}" / currency "${currency}". Add a mapping in Settings → Accounting → Payment Account Mapping.`,
        })
      } else {
        let amount = payload._paymentAmount as number | undefined
        if (amount == null && typeof payload._paymentAmount === 'string') {
          amount = Number(payload._paymentAmount)
        }
        if (amount == null) {
          amount = (payload.lines as Array<{ quantity: number; unitAmount: number }>).reduce((s, l) => s + l.quantity * l.unitAmount, 0)
            + ((payload.shippingAmount as number) || 0)
            - ((payload.discountAmount as number) || 0)
        }

        if (amount > 0) {
          await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
            accountingInvoiceId: syncResult.externalId,
            bankAccountId: stored,
            amount,
            paymentDate: (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            currency,
            method,
            sourceEntryId: entryId,
          })
        }
      }
    }
  }

  await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
    sourceEntryId: entryId,
  })
}

async function enqueuePurchaseInvoiceFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) return
  await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    supplierInvoicePath: payload.supplierInvoicePath,
    sourceEntryId: entryId,
  })
}

async function enqueueFollowUps(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
): Promise<void> {
  if (type === 'SALES_INVOICE') {
    await enqueueSalesInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return
  }

  if (type === 'PURCHASE_INVOICE') {
    await enqueuePurchaseInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return
  }

  if (type === 'INVOICE_PDF' && referenceType === 'SalesOrder') {
    const order = await db.salesOrder.findUnique({
      where: { id: referenceId },
      select: {
        customerEmail: true,
        shoppingLinks: { where: { connector: 'woocommerce' }, select: { id: true }, take: 1 },
      },
    })
    if (order?.customerEmail) {
      await enqueueFollowUpSyncLog('INVOICE_EMAIL', referenceType, referenceId, { referenceId, sourceEntryId: entryId })
    }
    if (order?.shoppingLinks.length) {
      await enqueueFollowUpSyncLog('WC_INVOICE_NOTE', referenceType, referenceId, { referenceId, sourceEntryId: entryId })
    }
  }
}
