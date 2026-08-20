/**
 * Process pending XeroSyncLog entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one Xero API call.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { pushSalesInvoice, updateSalesInvoice } from './invoices'
import { pushPurchaseBill, updatePurchaseBill } from './bills'
import { allocatePurchaseCreditNote, pushCreditNote, pushPurchaseCreditNote } from './credit-notes'
import { pushManualJournal } from './journals'
import { getGrantedScopes } from './auth'
import { blockingScopeFor, scopeBlockedError } from './scopes'
import {
  carryAccountingOriginRecord,
  readAccountingPayloadConnectionStamp,
  type AccountingConnectionStamp,
} from '@/lib/connectors/accounting-connection-provenance'
import { withAccountingPostingIntent } from '@/lib/connectors/accounting-posting-intent'
import { xeroUploadAttachment, xeroPost } from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { decideInvoiceNumberPost } from '@/lib/domain/accounting/invoice-number-ownership'
import { lookupXeroInvoiceNumberClaim } from './invoice-number-claim'
import { applyBackReference, followUpObligationClaim, releaseFollowUpObligation } from '@/lib/domain/accounting/back-reference'
import { stampSyncedAtFromDatabaseClock } from './synced-at-clock'
import {
  DEFAULT_BACK_REFERENCE_SWEEP_LIMIT,
  createBackReferenceSweepCursorStore,
  repairAccountingBackReferences,
  type BackReferenceRepairResult,
} from '@/lib/domain/accounting/back-reference-sweep'
import { planFollowUpEnqueue, readFollowUpIdempotencyKey } from '@/lib/domain/accounting/followup-idempotency'
import {
  buildCompactedFollowUpLossActivity,
  isCompactedFollowUpEvidence,
} from '@/lib/domain/accounting/compacted-followup-loss'
import { logFollowUpRevival, resolveLostFollowUpRevival } from '@/lib/domain/accounting/followup-revival'
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

/**
 * The warning about a retention tombstone's unrebuildable follow-ups could not be written down.
 *
 * Thrown, not swallowed, so both short-circuit sites route it into their EXISTING follow-up-failure
 * handling: the row goes back to PENDING (or FAILED at MAX_RETRIES) still carrying
 * `backReferenceFollowUpsPendingAt`, so the obligation stays owed and the next pass — this
 * processor's own retry, or the repair sweep — gets another chance to announce it.
 */
class CompactedFollowUpLossUnrecorded extends Error {}

/**
 * o3d-nepa r3 — SAY SO WHEN A RETRY SETTLES A ROW WHOSE FOLLOW-UPS CANNOT BE REBUILT.
 *
 * The short-circuit below is reached when a sync row already carries an external id: the document
 * posted, so the retry must NOT re-post it, and the row goes straight to SYNCED. That branch then
 * calls `enqueueFollowUps` with the row's payload and releases the follow-up obligation.
 *
 * On a RETENTION TOMBSTONE the payload is `{}`. The enqueue does not fail on it — it takes no
 * branch, enqueues nothing and returns normally — so the release ran on the strength of work that
 * never happened, and `backReferenceFollowUpsPendingAt`, the last record that a payment or
 * attachment was still owed, was cleared. A bulk "Retry all" over old failures therefore lost them
 * silently. The repair sweep had announced exactly this loss since o3d-9kek r4; the processors had
 * not, and the processors are the path an operator actually triggers.
 *
 * So the loss is announced, from the SAME shared message the sweep uses, and the obligation is
 * released only once the announcement is on record. A no-op for every row that is not a tombstone.
 *
 * r4 finding 1: it runs AFTER `enqueueFollowUps`, not before. Throwing from here is how the release
 * is withheld, and putting it first made that throw withhold the ENQUEUE as well — including the
 * follow-ups that survive compaction and would have gone out fine. The gate is on the release only.
 */
async function announceCompactedFollowUpLoss(entry: {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  backReferenceEvidenceCompactedAt: Date | null
}): Promise<void> {
  if (!isCompactedFollowUpEvidence(entry)) return
  // logActivityPersisted, NOT logActivity: the release below is conditional on having warned, and
  // logActivity swallows its own write failures and resolves regardless — which is the same
  // "reported success, did nothing" shape as the empty enqueue this exists to catch.
  const persisted = await logActivityPersisted(buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: XERO_CONNECTOR,
    row: entry,
    phase: 'processor-short-circuit',
  }))
  if (persisted) return
  throw new CompactedFollowUpLossUnrecorded(
    `Xero sync entry ${entry.id} outlived the retention period and was compacted, so its follow-ups cannot be rebuilt — `
    + 'and the warning about that could not be written. The row keeps its follow-up obligation so the loss is announced '
    + 'by a later pass instead of disappearing with it.',
  )
}

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>
type FollowUpSyncType = 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'PURCHASE_CREDIT_NOTE_ALLOCATION'
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

/**
 * Xero rejects an Idempotency-Key longer than this with HTTP 400 — the document never
 * reaches the ledger.
 */
const XERO_IDEMPOTENCY_KEY_MAX_LENGTH = 128

export function buildXeroIdempotencyKey(entryId: string, operation: string, payload?: SyncPayload): string {
  if (typeof payload?._idempotencyKey === 'string' && payload._idempotencyKey.trim()) {
    const digest = createHash('sha256').update(payload._idempotencyKey).digest('hex')
    return `ims-${operation}-${digest}`
  }

  // Bound the key HERE rather than trusting every caller to pass something short.
  //
  // Not hypothetical: the manual-journal branch passes a composite
  // `purchase-receipt:<cuid>:<receipt-ref>:<sha256>` as entryId and omits `payload`, so it
  // skipped the hash above and built a 156-char key. Xero 400'd every one, meaning
  // STOCK_RECEIPT journals NEVER posted. Because the 400 body was discarded (api.ts), it
  // surfaced only as "HTTP 400" and got written off as a demo-tenant quirk
  // (e2e/xero.spec.ts:134 fixme).
  //
  // Hashing is deterministic — the same entryId still yields the same key, so idempotency
  // is preserved; only over-long keys change shape.
  const key = `ims-${operation}-${entryId}`
  if (key.length <= XERO_IDEMPOTENCY_KEY_MAX_LENGTH) return key
  return `ims-${operation}-${createHash('sha256').update(entryId).digest('hex')}`
}

/**
 * o3d-h2wx: the source a money-moving follow-up's Idempotency-Key is built from. Prefers
 * the stable follow-up token when this row carries one, so the key survives the row being
 * regenerated; otherwise the entry id, exactly as before.
 *
 * Deliberately does NOT consult the generic `payload._idempotencyKey`. These branches have
 * always ignored it, and starting to read it would change the key of every manual-receipt
 * payment already in flight at deploy time — creating the double-post window this closes.
 */
function followUpIdempotencySource(entryId: string, payload: SyncPayload): string {
  return readFollowUpIdempotencyKey(payload) ?? entryId
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
  /**
   * o3d-cvj9 r3: the revision stamp Xero put on the document as it applied THIS write, out of the
   * response to that write. Supplied only where a write actually landed in this attempt — the
   * short-circuit for a sync log that already carries an external id makes no connector call, so it
   * supplies nothing and can never take a document id off the row that holds it.
   */
  externalRevisionAt?: Date | null
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
    ...(params.externalRevisionAt !== undefined ? { externalRevisionAt: params.externalRevisionAt } : {}),
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

/**
 * audit-om4e: apply a MAIN-sync failure (processEntry failed, not a follow-up)
 * to the sync-log row with the same optimistic-concurrency guard as
 * markSyncLogForFollowUpRetry. Two workers handling the same row (stale-claim
 * reclaim, or duplicate outbox jobs) must not both advance retryCount from a
 * stale value and double-write the failure transition / mirrored event. The
 * compound where makes the update a no-op for the loser; on a lost race we
 * re-read so the caller's outbox permanent/retry decision reflects reality and
 * we skip the mirrored-event write the winner already did.
 */
export async function applyMainSyncFailureRetry(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'accountingEvent' | 'accountingEventLog'>,
  entry: { id: string; retryCount: number; type: AccountingSyncType; referenceType: string; referenceId: string },
  errorMessage: string,
  payload: SyncPayload,
): Promise<{ finalFailure: boolean }> {
  const retryCount = entry.retryCount + 1
  const computedFinal = retryCount >= MAX_RETRIES
  const updated = await tx.accountingSyncLog.updateMany({
    where: { id: entry.id, retryCount: entry.retryCount },
    data: {
      status: computedFinal ? 'FAILED' : 'PENDING',
      retryCount,
      errorMessage,
      processingStartedAt: null,
    },
  })
  if (updated.count > 0) {
    if (computedFinal) {
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
    return { finalFailure: computedFinal }
  }
  // Lost the race: another worker already advanced this row (and wrote the
  // mirrored event if it became terminal). Report the persisted state.
  const current = await tx.accountingSyncLog.findUnique({
    where: { id: entry.id },
    select: { retryCount: true, status: true },
  })
  return {
    finalFailure: current
      ? current.status === 'FAILED' || current.retryCount >= MAX_RETRIES
      : computedFinal,
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

/**
 * True for a Postgres unique-constraint violation surfaced by Prisma (P2002) —
 * used so a concurrent follow-up enqueue that loses the race against the
 * accounting_sync_logs_followup_live_unique index (audit-42co) is swallowed as an
 * idempotent no-op rather than thrown.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/**
 * Where a follow-up's ORIGIN RECORD comes from. Never from "what is connected now" (Codex r3 finding 1).
 *
 * A follow-up is always work about a document some earlier post created, so the only honest statement
 * about which organisation its ids belong to is the one the row that made that post already carries.
 * Naming the two cases in the type is the point: a caller cannot reach the enqueue without saying which
 * of them it is in, and there is no third option that means "look it up".
 */
type FollowUpOriginEvidence =
  /**
   * The stored payload of the row whose post issued the ids in this follow-up. Its record is carried
   * VERBATIM — including its absence, which then refuses.
   */
  | { from: 'postedRow'; payload: unknown }
  /** Nothing in hand observed the origin. The row is created carrying no record, and cannot post. */
  | { from: 'unobserved' }

async function enqueueFollowUpSyncLog(
  type: FollowUpSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  origin: FollowUpOriginEvidence,
  /** Bounds the re-plan below, so a pathological race cannot recurse forever. */
  attempt = 0,
): Promise<void> {
  // o3d-19gy: the origin record is settled HERE, before anything reads or plans against it, so a
  // follow-up payload carries the connection whose post issued the external id it is built from.
  //
  // IT IS INHERITED, NEVER MINTED (Codex r2 finding 1, then r3 finding 1). Round 1 claimed "re-stamping
  // on a revival is deliberate", and that was the defect: a revived row is pinned to the idempotency
  // token its EARLIER attempt was spent under, and rewriting its origin to the current tenant made a
  // payment first attempted against organisation A look, to the post-time guard, like ordinary
  // organisation-B work. Round 2 fixed the REVIVAL path in `planFollowUpEnqueue`, and left the CREATE
  // path still reading `activeAccountingIdProvenance()` — the same forgery one step out, because a
  // creating repair had not witnessed the post either, and the guard would later compare B against B.
  //
  // So there is no read of the live connection on this path at all. A caller that took the post hands
  // over that row's payload and its record travels; a caller that did not hands over nothing and the row
  // is born with no record, which `accountingPayloadConnectionVerdict` refuses rather than assumes.
  payload = carryAccountingOriginRecord(
    payload,
    origin.from === 'postedRow' ? origin.payload : undefined,
  ) as SyncPayload
  // Fast-path check; the partial unique index (audit-42co) is the atomic backstop
  // for the check-then-create race between concurrent sync runs.
  const liveRowExists = await hasExistingSyncLog(type, referenceType, referenceId)
  // o3d-h2wx: a FAILED row is REUSED rather than replaced. Xero's Idempotency-Key is
  // derived from the entry id, so creating a replacement row would post the retry under a
  // key Xero has never seen — and if the failed attempt had actually committed, a SECOND
  // payment lands on the invoice.
  const failedLogs = liveRowExists ? [] : await db.accountingSyncLog.findMany({
    where: { connector: XERO_CONNECTOR, type, referenceType, referenceId, status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })
  const failedRows = failedLogs.map((row) => ({
    id: row.id,
    payload: row.payload,
    // Exactly what followUpIdempotencySource would have produced for this row, so pinning it
    // reproduces a byte-identical Idempotency-Key even after the row itself is gone.
    effectiveToken: followUpIdempotencySource(row.id, (row.payload ?? {}) as SyncPayload),
  }))
  const plan = planFollowUpEnqueue({
    connector: XERO_CONNECTOR,
    type,
    referenceType,
    referenceId,
    payload,
    liveRowExists,
    failedRows,
  })
  if (plan.action === 'skip') return
  if (plan.action === 'refuse') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: `Refused to re-enqueue Xero ${type} for ${referenceType} ${referenceId}: ${plan.reason}`,
      metadata: { type, referenceType, referenceId, failedRowIds: failedRows.map((row) => row.id) },
    })
    return
  }
  try {
    const outcome = await db.$transaction(async (tx) => {
      if (plan.action === 'reuse') {
        // Fenced on status: if another run revived the same row first — or retention
        // deleted it between the read and here (o3d-nepa) — this updates nothing rather
        // than resetting a claim it does not own.
        const revived = await tx.accountingSyncLog.updateMany({
          where: { id: plan.syncLogId, status: 'FAILED' },
          data: {
            status: 'PENDING',
            payload: plan.payload as never,
            retryCount: 0,
            errorMessage: null,
            processingStartedAt: null,
          },
        })
        if (revived.count === 0) return 'cas-lost' as const
        await scheduleXeroAccountingOutbox(tx, {
          accountingSyncLogId: plan.syncLogId,
          // Explicit 0 rather than resetAttempts: a PROCESSING outbox row honours only an
          // explicit `attempts` (outbox.ts) and ignores resetAttempts, so the revived entry
          // would keep a spent attempt budget and never be claimed (Codex review, r1 #6).
          attempts: 0,
        })
        return 'done' as const
      }
      const log = await tx.accountingSyncLog.create({
        data: {
          connector: XERO_CONNECTOR,
          type,
          status: 'PENDING',
          referenceType,
          referenceId,
          payload: plan.payload as never,
        },
      })
      await scheduleXeroAccountingOutbox(tx, {
        accountingSyncLogId: log.id,
      })
      return 'done' as const
    })
    if (outcome === 'cas-lost' && plan.action === 'reuse') {
      await resolveLostFollowUpRevival({
        connector: XERO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.syncLogId,
        attempt,
        // plan.payload carries the PINNED token, and withFollowUpIdempotencyKey never
          // overwrites one — so a row created by the re-plan posts under the same remote
          // key as the row that vanished. That is what makes losing the row survivable.
          // The plan's payload already holds the origin this enqueue resolved (carried from the row
          // it reuses, or inherited on a create), so the re-plan inherits from itself rather than
          // asking again — asking again is what "look it up" would reintroduce.
          retry: () => enqueueFollowUpSyncLog(
            type, referenceType, referenceId, plan.payload,
            { from: 'postedRow', payload: plan.payload }, attempt + 1,
          ),
      })
      return
    }
    if (plan.action === 'reuse') await logFollowUpRevival(XERO_CONNECTOR, type, referenceType, referenceId, plan)
  } catch (error) {
    // A concurrent run took the live slot and the partial unique index
    // (accounting_sync_logs_followup_live_unique) rejected ours. This used to return as an
    // idempotent no-op, which silently accepted a winner posting under a DIFFERENT token
    // while ours may already have committed (Codex review, r7 #1). It now goes through the
    // same resolver as a lost compare-and-set, which only accepts a live row carrying our
    // token.
    if (isUniqueConstraintViolation(error)) {
      await resolveLostFollowUpRevival({
        connector: XERO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(
          type, referenceType, referenceId, plan.payload,
          { from: 'postedRow', payload: plan.payload }, attempt + 1,
        ),
      })
      return
    }
    throw error
  }
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
  return `${createType}\x00${referenceType}\x00${referenceId}`
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
    const claimedAt = new Date()
    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
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
              // Claimed IN this transaction, so the row can never be SYNCED-with-an-id and silent
              // about the follow-ups it still owes (r10 finding 1).
              ...followUpObligationClaim(),
            },
          })
          // The registration's completion time is stamped by the DATABASE, in this transaction and
          // strictly after the POST returned (o3d-clxw round 4). The payment poller fences its
          // reversal verdict on this value against a `clock_timestamp()` it reads from the same
          // database, so no application host's clock can order — or misorder — a supplier payment.
          await stampSyncedAtFromDatabaseClock(tx, entry.id)
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            // o3d-cvj9 r3: no connector call was made on this path — the log already carried the
            // document id from an earlier successful post — so there is no revision stamp to record
            // and none is invented. `externalRevisionAt` is left UNDEFINED rather than null, so a
            // stamp an earlier write of this row established is not wiped by a replay that wrote
            // nothing. o3d-cvj9 r7: and the ABSENCE of the field is what `resolveDocumentRevisionOrder`
            // decides this path on, in the rule it asks FIRST — an attempt that called nothing changed
            // nothing about the document and so takes no claim on it. (r3/r4 credited the create
            // fallback with carrying this path safely. It did not: the fallback matches on the
            // HOLDER's type, so for the ordinary create-then-revise shape it answered "the create
            // precedes" and handed a replay that wrote nothing the claim anyway — Codex r6, HIGH.)
            // A replay that DOES call the connector records the stamp of the write it made, and is
            // then ordered by that stamp like any other write.
            externalId: entry.externalTransactionId,
          })
        })
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          // AFTER the enqueue, and that ORDER IS THE FIX (o3d-nepa r4, Codex finding 1).
          //
          // r3 put the announcement first and then threw when it could not be written, so a failed
          // ACTIVITY-LOG WRITE stopped the enqueue from being called at all — and r3's own reason for
          // still calling it on a tombstone is that SOME follow-ups are rebuilt from columns that
          // survive compaction (an INVOICE_PDF is enqueued from `externalTransactionId` and
          // `referenceId` alone). Those are real, recoverable work, and refusing to settle the row is
          // no reason to withhold them: the retry will just meet the same unwritable log next pass.
          //
          // What the announcement gates is the RELEASE, which is the property r3 was actually
          // defending — the obligation marker must never be discharged on the strength of an enqueue
          // that silently did nothing. That still holds exactly: a throw here skips the release, the
          // catch below returns the row to PENDING still carrying `backReferenceFollowUpsPendingAt`,
          // and the next pass announces. Re-running the enqueue on that pass is a no-op — it is
          // idempotent through `hasExistingSyncLog` and the partial unique index (audit-42co).
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          // NOT released: the follow-ups did not run. The row goes back to PENDING (or FAILED at
          // MAX_RETRIES) still carrying the obligation, so whichever gets there first — this
          // processor's own retry or the repair sweep — knows the work is outstanding.
          await markSyncLogForFollowUpRetry(entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }
        result.succeeded++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimedAt)

      if (syncResult.skipped) {
        // processEntry already terminalised this row (e.g. its order was cancelled — o3d-5rs). Nothing
        // was posted, so do NOT mark it SYNCED/POSTED; it is a resolved no-op.
        result.skipped++
        continue
      }
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
              // Same transaction as the external id itself (r10 finding 1): the two facts that make
              // the crash-after-post state recoverable become durable together or not at all.
              ...followUpObligationClaim(),
            },
          })
          // The registration's completion time is stamped by the DATABASE, in this transaction and
          // strictly after the POST returned (o3d-clxw round 4). The payment poller fences its
          // reversal verdict on this value against a `clock_timestamp()` it reads from the same
          // database, so no application host's clock can order — or misorder — a supplier payment.
          await stampSyncedAtFromDatabaseClock(tx, entry.id)
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: syncResult.externalId ?? null,
            externalRevisionAt: syncResult.externalRevisionAt ?? null,
          })
        })

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
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
          await db.$transaction(async (tx) => {
            await applyMainSyncFailureRetry(tx, entry, errorMessage, payload)
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
        await db.$transaction(async (tx) => {
          await applyMainSyncFailureRetry(tx, entry, errorMessage, payload)
        })
      }
      result.failed++
    }
  }

  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: XERO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order
  // invoice retirements, o3d-5rs) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

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

    const claimedAt = new Date()
    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
      },
    })
    if (claim.count === 0) {
      // The claim failed because the row is no longer PENDING/claimable. `entry` is a snapshot, so
      // re-read the live status: it may have been retired (CANCELLED — e.g. its order was cancelled,
      // o3d-5rs) or posted (SYNCED) since. CANCELLED is an INTENTIONAL no-op, not a failure — completing
      // the outbox job as success stops the retry churn / false PERMANENT_FAILED alerts a cancelled sync
      // would otherwise raise.
      const fresh = await db.accountingSyncLog.findUnique({
        where: { id: entry.id },
        select: { status: true },
      })
      const liveStatus = fresh?.status ?? entry.status
      if (liveStatus === 'SYNCED' || liveStatus === 'CANCELLED') {
        await markXeroOutboxSuccess(job)
      } else if (liveStatus === 'FAILED' || entry.retryCount >= MAX_RETRIES) {
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
              // r10 finding 1. The outbox path is the one MOST rows take, and it is also the one
              // that skips a SYNCED row outright next run — so a crash here left nothing to notice.
              ...followUpObligationClaim(),
            },
          })
          // The registration's completion time is stamped by the DATABASE, in this transaction and
          // strictly after the POST returned (o3d-clxw round 4). The payment poller fences its
          // reversal verdict on this value against a `clock_timestamp()` it reads from the same
          // database, so no application host's clock can order — or misorder — a supplier payment.
          await stampSyncedAtFromDatabaseClock(tx, entry.id)
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            // o3d-cvj9 r3: no connector call was made on this path — the log already carried the
            // document id from an earlier successful post — so there is no revision stamp to record
            // and none is invented. `externalRevisionAt` is left UNDEFINED rather than null, so a
            // stamp an earlier write of this row established is not wiped by a replay that wrote
            // nothing. o3d-cvj9 r7: and the ABSENCE of the field is what `resolveDocumentRevisionOrder`
            // decides this path on, in the rule it asks FIRST — an attempt that called nothing changed
            // nothing about the document and so takes no claim on it. (r3/r4 credited the create
            // fallback with carrying this path safely. It did not: the fallback matches on the
            // HOLDER's type, so for the ordinary create-then-revise shape it answered "the create
            // precedes" and handed a replay that wrote nothing the claim anyway — Codex r6, HIGH.)
            // A replay that DOES call the connector records the stamp of the write it made, and is
            // then ordered by that stamp like any other write.
            externalId: entry.externalTransactionId,
          })
        })
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          // AFTER the enqueue, and that ORDER IS THE FIX (o3d-nepa r4, Codex finding 1).
          //
          // r3 put the announcement first and then threw when it could not be written, so a failed
          // ACTIVITY-LOG WRITE stopped the enqueue from being called at all — and r3's own reason for
          // still calling it on a tombstone is that SOME follow-ups are rebuilt from columns that
          // survive compaction (an INVOICE_PDF is enqueued from `externalTransactionId` and
          // `referenceId` alone). Those are real, recoverable work, and refusing to settle the row is
          // no reason to withhold them: the retry will just meet the same unwritable log next pass.
          //
          // What the announcement gates is the RELEASE, which is the property r3 was actually
          // defending — the obligation marker must never be discharged on the strength of an enqueue
          // that silently did nothing. That still holds exactly: a throw here skips the release, the
          // catch below returns the row to PENDING still carrying `backReferenceFollowUpsPendingAt`,
          // and the next pass announces. Re-running the enqueue on that pass is a no-op — it is
          // idempotent through `hasExistingSyncLog` and the partial unique index (audit-42co).
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
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

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimedAt)

      if (syncResult.skipped) {
        // processEntry already terminalised this row (e.g. its order was cancelled — o3d-5rs). Complete
        // the outbox job as a successful no-op; nothing was posted, so do NOT mark it SYNCED/POSTED.
        await markXeroOutboxSuccess(job)
        result.skipped++
        continue
      }
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
              // THE LINE r10 finding 1 NAMED. This is where most successfully posted rows go.
              ...followUpObligationClaim(),
            },
          })
          // The registration's completion time is stamped by the DATABASE, in this transaction and
          // strictly after the POST returned (o3d-clxw round 4). The payment poller fences its
          // reversal verdict on this value against a `clock_timestamp()` it reads from the same
          // database, so no application host's clock can order — or misorder — a supplier payment.
          await stampSyncedAtFromDatabaseClock(tx, entry.id)
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: syncResult.externalId ?? null,
            externalRevisionAt: syncResult.externalRevisionAt ?? null,
          })
        })

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
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
          await db.$transaction(async (tx) => {
            const { finalFailure } = await applyMainSyncFailureRetry(tx, entry, errorMessage, payload)
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
        await db.$transaction(async (tx) => {
          const { finalFailure } = await applyMainSyncFailureRetry(tx, entry, errorMessage, payload)
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
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order
  // invoice retirements, o3d-5rs) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

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

type EntryResult = {
  success: boolean
  externalId?: string
  invoiceNumber?: string
  /** o3d-cvj9 r3: the external system's revision stamp for the document this write just changed. */
  externalRevisionAt?: Date | null
  error?: string
  skipped?: boolean
}

/**
 * Post-time backstop for the cancel-time sweep (o3d-5rs), shared by SALES_INVOICE and its UPDATE. A row
 * can be enqueued (Woo import) or re-queued (rate-limit/defer/failure) AFTER the order was cancelled and
 * its then-pending rows swept, so re-read the order status right before posting:
 *  - CANCELLED  → retire THIS claimed row (claim-fenced) and skip; no revenue for a cancelled sale.
 *  - unreadable / missing → FAIL CLOSED (return a retryable failure, do NOT post): a transient read
 *    outage must not become permission to post.
 *  - live → return the customerId and let the caller post.
 * A residual remains: cancellation can still commit AFTER this read but before the external Xero call
 * (a lock-less TOCTOU shared with the daily-batch's own select-then-post window); closing it fully needs
 * a posting-intent/lock protocol between cancellation and posting (tracked separately).
 */
async function guardCancelledSalesOrderInvoice(
  entryId: string,
  referenceType: string,
  referenceId: string,
  claimedAt: Date,
): Promise<{ post: true; customerId?: string } | { post: false; result: EntryResult }> {
  if (referenceType !== 'SalesOrder') return { post: true }
  let so: { customerId: string | null; status: string } | null
  try {
    so = await db.salesOrder.findUnique({ where: { id: referenceId }, select: { customerId: true, status: true } })
  } catch (error) {
    return { post: false, result: { success: false, error: `Could not read sales order ${referenceId} status before posting: ${String(error)}` } }
  }
  if (!so) {
    return { post: false, result: { success: false, error: `Sales order ${referenceId} not found before posting an invoice` } }
  }
  if (so.status === 'CANCELLED') {
    // Claim-fenced: only retire if this exact claim still owns the row (retire returns false otherwise).
    // Either way nothing was posted, so skip — a lost fence means another worker owns/posted it.
    await db.$transaction((tx) => retireSalesInvoiceForCancelledOrder(tx, entryId, referenceId, claimedAt))
    return { post: false, result: { success: true, skipped: true } }
  }
  return { post: true, customerId: so.customerId ?? undefined }
}

/**
 * THE OWNERSHIP FENCE ON THE SALES-INVOICE CREATE (o3d-k26m.5).
 *
 * `POST /Invoices` is update-or-create on InvoiceNumber. Since o3d-k26m.1 the number is
 * WooCommerce's own `_wcpdf_invoice_number` — which the outgoing xeroom plugin is posting to this
 * same live organisation today — so a create for an order xeroom has already invoiced does not
 * duplicate: it silently REPLACES that invoice. This asks the ledger who holds the number and
 * lets the post through only when the answer is "nobody" or "a document we own". The rule itself
 * is `decideInvoiceNumberPost`; this is its wiring, and it is the last thing between the payload
 * and an irreversible write.
 *
 * APPLIED TO EVERY CREATE, not only to storefront-supplied numbers. The hazard is the VERB, not
 * the number's provenance: an IMS-minted number that collides with anything already in the ledger
 * overwrites it just as quietly. It costs one GET per invoice create, which is real against a
 * 1,000-call rolling daily budget and is bought deliberately — the alternative currency is
 * destroyed documents.
 *
 * NOT applied to SALES_INVOICE_UPDATE: that posts to `Invoices/{InvoiceID}`, an id IMS recorded
 * from the create's own response, so it is already addressing a document we own by identity.
 *
 * FAILS CLOSED on an unreadable order and on an unreachable ledger, the same way
 * guardCancelledSalesOrderInvoice does — a transient read outage must not become permission to
 * post.
 *
 * A REFUSAL IS RETURNED AS AN ORDINARY FAILURE, so the row runs the normal retry ladder and settles
 * as FAILED with the reason on it. That is not wasted budget: the fence re-asks the ledger each
 * time, so the operator's remedy — linking the right document to the order, or voiding the wrong
 * one — is picked up automatically by the next retry instead of needing a re-queue. The ladder is
 * bounded (MAX_RETRIES), so a refusal nobody acts on costs a handful of reads and then stops.
 */
async function guardSalesInvoiceNumberOwnership(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
): Promise<{ post: true } | { post: false; result: EntryResult }> {
  const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber : null

  let ownedInvoiceId: string | null = null
  let orderLabel = `${referenceType} ${referenceId}`
  if (referenceType === 'SalesOrder') {
    try {
      const so = await db.salesOrder.findUnique({
        where: { id: referenceId },
        select: { accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true },
      })
      // A missing order is NOT "unowned". It means the thing we are invoicing cannot be read, and
      // the fence's whole job is to refuse to guess.
      if (!so) {
        return {
          post: false,
          result: { success: false, error: `Sales order ${referenceId} not found before posting an invoice` },
        }
      }
      ownedInvoiceId = so.accountingInvoiceId
      orderLabel = `order ${so.orderNumber ?? so.externalOrderNumber ?? referenceId}`
    } catch (error) {
      return {
        post: false,
        result: { success: false, error: `Could not read sales order ${referenceId} before the invoice-number ownership check: ${String(error)}` },
      }
    }
  }

  // Message material for a refusal, never a licence to post (o3d-k26m.5, Codex round 3). A read
  // failure here still refuses: it is the same unhealthy-database signal that would stop the
  // POST's own outcome from being recorded.
  let attemptedInvoiceNumber: string | null = null
  try {
    const entry = await db.accountingSyncLog.findUnique({
      where: { id: entryId },
      select: { attemptedInvoiceNumber: true },
    })
    attemptedInvoiceNumber = entry?.attemptedInvoiceNumber ?? null
  } catch (error) {
    return {
      post: false,
      result: { success: false, error: `Could not read the invoice-number attempt on sync row ${entryId}: ${String(error)}` },
    }
  }

  const lookup = await lookupXeroInvoiceNumberClaim(invoiceNumber ?? '')
  const decision = decideInvoiceNumberPost({ invoiceNumber, lookup, ownedInvoiceId, attemptedInvoiceNumber, orderLabel })

  if (!decision.post) {
    await logActivity({
      entityType: referenceType === 'SalesOrder' ? 'SALES_ORDER' : 'SYSTEM',
      entityId: referenceType === 'SalesOrder' ? referenceId : undefined,
      action: 'sales_invoice_number_not_ours',
      tag: 'accounting',
      level: 'WARNING',
      description: decision.reason,
      metadata: {
        connector: XERO_CONNECTOR,
        syncLogId: entryId,
        invoiceNumber,
        refusalCode: decision.code,
        retryable: decision.retryable,
      },
      resolveUser: false,
    }).catch(() => {})
    return { post: false, result: { success: false, error: decision.reason } }
  }

  if (decision.recordAttempt && invoiceNumber) {
    // BEFORE the post, never after — and a failure to write it REFUSES the post. Not because the
    // record licenses anything (it does not: see invoice-number-ownership.ts), but because a
    // create whose local record cannot be written is a create whose OUTCOME cannot be written
    // either. A database that will not take this row will not take the InvoiceID the response
    // carries, and that is exactly the lost-response state the fence can no longer heal.
    try {
      await db.accountingSyncLog.update({
        where: { id: entryId },
        data: { attemptedInvoiceNumber: invoiceNumber, attemptedInvoiceNumberAt: new Date() },
      })
    } catch (error) {
      return {
        post: false,
        result: { success: false, error: `Could not record the invoice-number attempt for ${invoiceNumber} on sync row ${entryId} before posting: ${String(error)}` },
      }
    }
  }

  return { post: true }
}

/**
 * o3d-19gy / o3d-s36z / o3d-gfh: every remote call this entry makes is attributed to this entry's row.
 *
 * WHERE THE PERMISSION IS ACTUALLY GRANTED. Not here. This establishes the INTENT — which row is being
 * posted — and the verdict is reached inside `performRequest`, against the tenant id that will be
 * written into the outgoing `Xero-Tenant-Id` header, immediately before the request leaves. The earlier
 * revision decided it here, from its own read of the `AccountingToken` row, and the request then made a
 * second, independent selection of the tenant when it built its headers; a permission taken at T1 and
 * spent at T2 is not a permission, and that gap is what Codex r1 finding 3 names.
 *
 * The wrap covers the whole entry rather than just its write, because a handler's contact and item
 * lookups CACHE ids from the responses they get: reading organisation C's chart of accounts on behalf of
 * a row raised against B is the same error one step earlier.
 */
async function processEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  claimedAt: Date,
): Promise<EntryResult> {
  return withAccountingPostingIntent(
    { connector: XERO_CONNECTOR, payload, type, referenceType, referenceId },
    () => processClaimedEntry(entryId, type, referenceType, referenceId, payload, claimedAt),
  )
}

async function processClaimedEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  claimedAt: Date,
): Promise<EntryResult> {
  const postingMode = payload._postingMode

  // THE CONNECTION CHECK USED TO BE HERE, and removing it is the fix rather than a regression.
  //
  // It compared the row's origin stamp against a tenant read from the `AccountingToken` row; the
  // request then resolved the tenant AGAIN, from `getAccessToken()`, when it built its headers. Two
  // independent selections of one thing, and the gap between them is measured in whatever the handler
  // does plus, on a rate-limited entry, tens of seconds asleep on a Retry-After. Keeping it as a
  // "harmless early no" was tempting and is the same mistake one notch quieter: it would still be a
  // second reading of a value that can disagree with the one the request uses, and a refusal produced
  // from a stale read is as wrong as a permission produced from one. `small2`: A PERMISSION IS
  // EVALUATED IN EXACTLY ONE PLACE, IMMEDIATELY BEFORE THE ACT IT AUTHORISES.
  //
  // It is now evaluated in `performRequest`, against the `auth.tenantId` that is going into this
  // request's own `Xero-Tenant-Id` header, and it reaches the row the same way it always did — as the
  // response's `error`, which each arm returns as an ordinary entry failure, so a queue holding one
  // previous-tenant row still does not stop the rows behind it.

  // A MISSING SCOPE IS A CONFIGURATION FAULT, NOT AN API ERROR (o3d-g2i). Adding a scope to the
  // authorization URL only affects future consents, so a connection made before it keeps 401ing
  // AuthorizationUnsuccessful on exactly the calls that scope covers — while every other sync looks
  // healthy. That is how payment registration shipped broken: invoices and bills posted, were marked
  // paid locally, and were never settled in Xero. Refusing here means the row fails with something an
  // operator can act on ("reconnect to grant accounting.payments") rather than a bare 401 that could be
  // any of a dozen causes, and it means nothing is SENT on a call we know cannot succeed.
  //
  // Fails OPEN when the grant was never recorded — see getGrantedScopes.
  const blockingScope = blockingScopeFor(type, await getGrantedScopes())
  if (blockingScope) return { success: false, error: scopeBlockedError(type, blockingScope) }

  switch (type) {
    case 'SALES_INVOICE': {
      const guard = await guardCancelledSalesOrderInvoice(entryId, referenceType, referenceId, claimedAt)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
      // o3d-k26m.5: the number must be ours to post under. Refusing is recoverable; overwriting a
      // live invoice is not. Runs AFTER the cancelled-order backstop (no point asking the ledger
      // about an order that must not be invoiced at all) and BEFORE anything is sent.
      const numberFence = await guardSalesInvoiceNumberOwnership(entryId, referenceType, referenceId, payload)
      if (!numberFence.post) return numberFence.result
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
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, externalRevisionAt: invoiceResult.externalRevisionAt, error: invoiceResult.error }
    }

    case 'SALES_INVOICE_UPDATE': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for SALES_INVOICE_UPDATE' }
      }
      // Same cancelled-order backstop as the create: don't modify an external receivable for an order
      // that has since been cancelled (retire the update instead), and fail closed on an unreadable order.
      const guard = await guardCancelledSalesOrderInvoice(entryId, referenceType, referenceId, claimedAt)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
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
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, externalRevisionAt: invoiceResult.externalRevisionAt, error: invoiceResult.error }
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
      return { success: billResult.success, externalId: billResult.invoiceId, externalRevisionAt: billResult.externalRevisionAt, error: billResult.error }
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
      return { success: billResult.success, externalId: billResult.invoiceId, externalRevisionAt: billResult.externalRevisionAt, error: billResult.error }
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
        }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'invoice-payment') })
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
        }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'bill-payment') })
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

    case 'PURCHASE_CREDIT_NOTE': {
      // audit-g5u2: supplier credit note (ACCPAYCREDIT) — e.g. crediting a
      // duplicate freight bill. The payload carries the supplier contact + the
      // expense-account lines (built by recordSupplierFreightCreditNote, g5u2.3).
      return pushPurchaseCreditNote({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(entryId, 'purchase-credit-note'), supplierId: payload.supplierId as string | undefined }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))
    }

    case 'PURCHASE_CREDIT_NOTE_ALLOCATION': {
      // audit-v08m: follow-up that applies a posted ACCPAYCREDIT to the freight
      // bill it offsets, so the bill stops showing as outstanding in Xero's AP
      // aging. Enqueued by enqueuePurchaseCreditNoteFollowUps once the credit note
      // itself has posted (and only when the bill already has an external id).
      const creditNoteId = payload.creditNoteId as string | undefined
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const amount = payload.amount as number | undefined
      const allocationDate = (payload.date as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!creditNoteId || !accountingInvoiceId || amount == null) {
        return { success: false, error: 'Missing creditNoteId, accountingInvoiceId, or amount for PURCHASE_CREDIT_NOTE_ALLOCATION' }
      }
      const result = await allocatePurchaseCreditNote(
        { creditNoteId, invoiceId: accountingInvoiceId, amount, date: allocationDate },
        { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'purchase-credit-note-allocation') },
      )
      // No externalId to back-reference — the allocation is a sub-resource of the
      // credit note, not a standalone document.
      return { success: result.success, error: result.error }
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
    case 'DAILY_BATCH_INVENTORY_RECONCILIATION':
    case 'DAILY_BATCH_COGS_RECONCILIATION':
    case 'DAILY_BATCH_TRANSIT_RECONCILIATION':
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
  const applied = await applyBackReference(db, { connector: XERO_CONNECTOR, type, referenceType, referenceId, externalId, invoiceNumber })
  // o3d-9kek: a legacy PurchaseOrder-keyed row that cannot be attributed to one bill is
  // refused rather than written onto the newest unlinked bill. Surface it — silence here
  // is what let a wrong id look like a successful write.
  if (applied.outcome === 'ambiguous') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_backreference_ambiguous',
      tag: 'sync',
      level: 'WARNING',
      description: `Did not write the Xero back-reference for PO ${referenceId}: its bill cannot be identified `
        + `(${applied.attribution.reason}). Link the bill manually — the external id is on the sync row.`,
      metadata: { referenceType, referenceId, externalId, reason: applied.attribution.reason },
    })
  }
  // o3d-9kek finding 3: the resolved bill gained an external id between the resolve and the
  // compare-and-swap, so nothing was written and nothing was overwritten. Not an error — the
  // repair sweep re-resolves it from the state that actually won.
  if (applied.outcome === 'contended') {
    console.warn(`xero: back-reference for PO ${referenceId} lost the race for bill ${applied.purchaseInvoiceId}; the repair sweep will re-resolve it.`)
  }
}

export type { BackReferenceRepairResult }

/**
 * audit-H3 repair sweep, Xero binding. The implementation is connector-agnostic
 * (lib/domain/accounting/back-reference-sweep) — o3d-9kek fixed its starvation and its
 * page-local PO ambiguity check there, once, so a second connector cannot inherit the
 * old shape by copying this one.
 */
export async function repairXeroBackReferences(limit = DEFAULT_BACK_REFERENCE_SWEEP_LIMIT): Promise<BackReferenceRepairResult> {
  return repairAccountingBackReferences({
    db,
    connector: XERO_CONNECTOR,
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    // Resume behind the rows the last run could not settle (r3 finding 4).
    cursorStore: createBackReferenceSweepCursorStore(db, XERO_CONNECTOR),
    // logActivityPersisted, NOT logActivity: the sweep defers an ambiguous row for 24 hours on
    // the strength of having warned about it, and logActivity cannot tell it whether the warning
    // was written (o3d-9kek r2 finding 3).
    logActivity: logActivityPersisted,
    enqueueFollowUps: (entryId, type, referenceType, referenceId, payload, syncResult) =>
      enqueueFollowUps(entryId, type, referenceType, referenceId, payload as SyncPayload, syncResult),
  }, { limit })
}

export type CreditNoteAllocationReenqueueResult = {
  /** Posted credit notes whose bill now has an id but had no allocation row. */
  checked: number
  /** Allocation follow-ups enqueued by this sweep. */
  enqueued: number
  /** Candidates that errored while enqueuing. */
  failed: number
}

export type CreditNoteAllocationCandidate = {
  id: string
  accountingCreditNoteId: string | null
  amountForeign: unknown
  purchaseInvoice: { accountingInvoiceId: string | null } | null
}

/**
 * audit-w77e: pure selection — from POSTED credit notes that have both a posted
 * credit and a bill with an external id, keep those that have NO allocation row
 * yet (the never-enqueued gap). Credit notes that already have a row of any
 * status are owned by the normal retry/repair path and are skipped here. Returns
 * the resolved enqueue inputs so the DB-bound caller is a thin loop. Defensive
 * re-check of the ids guards against a candidate row that lost them.
 */
export function selectCreditNotesNeedingAllocation(
  candidates: CreditNoteAllocationCandidate[],
  refIdsWithAllocation: Set<string>,
): Array<{ supplierCreditNoteId: string; creditNoteId: string; accountingInvoiceId: string; amount: number }> {
  const out: Array<{ supplierCreditNoteId: string; creditNoteId: string; accountingInvoiceId: string; amount: number }> = []
  for (const cn of candidates) {
    if (refIdsWithAllocation.has(cn.id)) continue
    const creditNoteId = cn.accountingCreditNoteId
    const accountingInvoiceId = cn.purchaseInvoice?.accountingInvoiceId
    if (!creditNoteId || !accountingInvoiceId) continue
    // Codex review: don't enqueue a useless allocation row for a non-positive /
    // non-finite amount (the allocation would resolve to a no-op anyway).
    const amount = Number(cn.amountForeign)
    if (!Number.isFinite(amount) || amount <= 0) continue
    out.push({ supplierCreditNoteId: cn.id, creditNoteId, accountingInvoiceId, amount })
  }
  return out
}

/** A `PURCHASE_CREDIT_NOTE` sync row, narrowed to the two columns provenance is resolved from. */
export type CreditNotePostRow = {
  /**
   * The document this row's post RETURNED. This — not the row's status, and not its recency — is what
   * makes a row the issuing post of a particular credit note.
   */
  externalTransactionId: string | null
  /** The stored payload, verbatim. What gets inherited, stamp or no stamp. */
  payload: unknown
}

/** What the rows in hand can say about which organisation issued one specific credit note. */
export type IssuingPostOrigin =
  /** One row named this exact document. Its payload travels verbatim — including carrying no stamp. */
  | { outcome: 'inherited'; payload: unknown }
  /** No row in hand names this document id. Nothing observed the post; record nothing. */
  | { outcome: 'no-issuing-row' }
  /** Two rows claim to have posted this document id against DIFFERENT organisations. Record nothing. */
  | { outcome: 'conflicting-origins'; recorded: string[] }

/**
 * WHICH POST ISSUED THIS CREDIT NOTE? (Codex r4 finding 1, HIGH.)
 *
 * Round 3 stopped the sweep minting an origin from "whatever is connected when the cron fires" and made
 * it INHERIT from the post that issued the id it is carrying. The lookup it shipped, though, matched only
 * (connector, type, referenceType, `referenceId`), filtered to SYNCED, and took the NEWEST row — it never
 * looked at `externalTransactionId` at all. A supplier credit note that was posted, voided and posted
 * again has TWO rows under one `referenceId` naming two different documents, and
 * `SupplierCreditNote.accountingCreditNoteId` holds whichever of them the last back-reference write left
 * there. Taking the newest row therefore inherits from a post that issued a DIFFERENT document — an origin
 * the row being created did not come from, which is the same class of defect as inventing one, and would
 * be believed by the post-time guard exactly as readily.
 *
 * So the pair is the identity: a row is the issuing post only if it names the SAME reference AND carries
 * the SAME `externalTransactionId` as the credit id being allocated.
 *
 * AND STATUS IS NOT A PROXY FOR "HAS POSTED". `status: 'SYNCED'` was too narrow in the other direction.
 * This branch already establishes both halves of that: a row that posted successfully and then failed its
 * FOLLOW-UPS is sent back to PENDING or, at MAX_RETRIES, to FAILED, *keeping* the external id
 * (`markSyncLogForFollowUpRetry`); and a row retired to CANCELLED by the orphan sweep keeps it too — which
 * is precisely why `order-delete-guard` matches on "carries an external id, whatever the status". A row
 * that names a document posted that document. The id is the evidence; the status is where the row ended up
 * afterwards. So no status filter is applied here at all.
 *
 * WHEN SEVERAL ROWS NAME THE SAME DOCUMENT. They are all describing the same post of the same document, so
 * the one that RECORDED an organisation is preferred over one that recorded nothing (a retention-compacted
 * `payload: {}`, or a pre-stamping row). That is not choosing the convenient answer: the rows do not
 * disagree, one of them simply says less. If two of them do genuinely disagree — two readable stamps naming
 * DIFFERENT organisations for one document id — nothing here can say which is right, so this reports
 * `conflicting-origins` and the caller records nothing, exactly as it does for no row at all. "I cannot
 * tell" must not resolve to "take the newest", which is the habit this whole finding is about.
 */
export function selectIssuingPostOriginRecord(rows: CreditNotePostRow[], creditNoteId: string): IssuingPostOrigin {
  const wanted = creditNoteId.trim()
  if (wanted === '') return { outcome: 'no-issuing-row' }
  const issuing = rows.filter((row) => (row.externalTransactionId ?? '').trim() === wanted)
  if (issuing.length === 0) return { outcome: 'no-issuing-row' }

  // Distinct organisations actually NAMED by rows that issued this document. More than one is a
  // contradiction no rule here is entitled to settle.
  const named = new Set<string>()
  // Prefer the row that recorded the most about the post: a comparable stamp, then the observed
  // "raised while disconnected", then silence, then an unreadable payload. Every rank below 0 still
  // refuses at post time — the preference only decides which true statement the operator is shown.
  const rank = (payload: unknown): number => {
    const stamp = readAccountingPayloadConnectionStamp(payload)
    if (stamp.state === 'stamped') {
      named.add(stamp.provenance)
      return 0
    }
    return stamp.state === 'raised-disconnected' ? 1 : stamp.state === 'absent' ? 2 : 3
  }
  const ranked = issuing
    .map((row) => ({ payload: row.payload, rank: rank(row.payload) }))
    .sort((a, b) => a.rank - b.rank)
  if (named.size > 1) return { outcome: 'conflicting-origins', recorded: [...named].sort() }
  return { outcome: 'inherited', payload: ranked[0].payload }
}

/** Which of the ways an origin can be unavailable this row hit — one clause, so the log names the case. */
function describeMissingCreditNoteOrigin(
  origin: IssuingPostOrigin,
  inherited: AccountingConnectionStamp | null,
  creditNoteId: string,
): string {
  if (origin.outcome === 'no-issuing-row') {
    return `no surviving sync row records a post of credit note ${creditNoteId} (retention removed it, or the `
      + 'credit was posted before this instance recorded which organisation it was posting to)'
  }
  if (origin.outcome === 'conflicting-origins') {
    return `two sync rows both claim to have posted credit note ${creditNoteId}, against DIFFERENT accounting `
      + `organisations (${origin.recorded.join(' and ')}), and nothing here can say which of them issued it`
  }
  if (inherited?.state === 'raised-disconnected') {
    return `the sync row that posted credit note ${creditNoteId} records that it was raised while this instance `
      + 'had no accounting connection at all, so nothing vouches for the id even there'
  }
  if (inherited?.state === 'unreadable') {
    return `the sync row that posted credit note ${creditNoteId} has an origin record that cannot be read `
      + `(${inherited.detail})`
  }
  return `the sync row that posted credit note ${creditNoteId} survives but records no organisation itself — it `
    + 'was queued before origins were recorded, or retention compacted its payload away'
}

/**
 * WHAT AN OPERATOR ACTUALLY DOES WITH A ROW WHOSE ORIGIN CANNOT BE ESTABLISHED (Codex r4 finding 2).
 *
 * The previous text ended "re-queue the allocation from the credit note itself if it is still owed", which
 * is not a remedy an operator can perform: re-queueing rebuilds the identical payload out of the identical
 * two local columns, so it refuses identically — and this sweep skips any credit note that already has an
 * allocation row of any status, so it would not even be re-created. A refusal that names a step which
 * cannot work is worse than one that names none, because the operator spends the attempt before finding
 * out. So the remedy named here is the one that exists: do the allocation where the documents are, in the
 * ledger, by the one party who can see which organisation they live in.
 */
function creditNoteAllocationOriginRemedy(item: { creditNoteId: string; accountingInvoiceId: string }): string {
  return 'WHAT TO DO: allocate it in the accounting system by hand — open credit note '
    + `${item.creditNoteId} in the organisation that issued it and apply it to bill ${item.accountingInvoiceId}. `
    + 'That is exactly the effect this row would have had, decided by someone who can see which organisation '
    + 'the two documents live in, which nothing in this instance can. Do NOT retry or re-queue the row: it '
    + 'rebuilds the same payload from the same two local columns (SupplierCreditNote.accountingCreditNoteId '
    + 'and PurchaseInvoice.accountingInvoiceId), which is exactly the evidence that is missing — and the '
    + 'origin must not be back-filled, because writing a marker for a post nobody witnessed is the defect '
    + 'this guard exists to stop. (The refusal on the sync row itself says "cancel and re-queue from the '
    + 'source document". For an allocation that is not a remedy, for the reason just given.) The row is '
    + 'inert meanwhile: it sends nothing, and once its retries are spent it sits FAILED in the sync log '
    + 'carrying the refusal, as a record rather than as outstanding work. Nothing else depends on it, and no '
    + 'second one will be created.'
}

/**
 * audit-w77e: backstop for the audit-v08m gap. postSupplierCreditNote only
 * enqueues the PURCHASE_CREDIT_NOTE_ALLOCATION follow-up when the offset bill
 * already has an external (Xero) id. If the bill's PURCHASE_INVOICE sync hadn't
 * drained yet when the credit posted, the credit nets at the supplier level but
 * the bill is never auto-allocated. This sweep finds POSTED supplier credit notes
 * that now have BOTH a posted credit (accountingCreditNoteId) and a linked bill
 * with an external id, but no PURCHASE_CREDIT_NOTE_ALLOCATION row of any status,
 * and enqueues one. Idempotent: skips any credit note that already has an
 * allocation row (the normal retry/repair path owns those), and the allocation
 * itself re-reads RemainingCredit/AmountDue. Safe to run repeatedly from cron.
 *
 * Note (Codex review): `status = POSTED` is IMS-posted; if the connector is in
 * draft posting mode the Xero credit is DRAFT and can't be allocated yet — the
 * allocation no-ops/retries until it's authorised. This matches the live v08m
 * enqueue path; freight credits are posted authorised in practice.
 *
 * WHERE THIS SWEEP'S ORIGIN RECORD COMES FROM (Codex r3 finding 1, CRITICAL). This is the purest form of
 * the defect that finding names: a cron that witnessed nothing, building a payload out of external ids
 * that were written to local columns at some unknown earlier time, and — until this round — stamping
 * whichever organisation happens to be connected when the cron fires onto it. That is not weak evidence,
 * it is manufactured evidence: the post-time guard would then compare the current tenant against the
 * current tenant and could not fail, on exactly the rows nobody watched being made.
 *
 * So the sweep inherits instead. `creditNoteId` is `SupplierCreditNote.accountingCreditNoteId`, which was
 * written by one specific PURCHASE_CREDIT_NOTE sync row's successful post; THAT row is found by the pair
 * (`referenceId`, `externalTransactionId` = the credit id being carried) and its own origin record is
 * carried onto the allocation verbatim. The pair is the point (Codex r4 finding 1): round 3 matched the
 * reference alone and took the newest SYNCED row, which for a credit posted twice inherits from the post
 * of a DIFFERENT document — an origin the row never came from, which is inventing one by another route.
 * Status is not part of the identity either, because a posted row can be sent back to PENDING/FAILED by a
 * follow-up failure, or retired to CANCELLED, while keeping the id it posted. See
 * `selectIssuingPostOriginRecord`.
 *
 * If no row names that exact document — retention removed it, or the credit predates origin records — or
 * if two rows name it against DIFFERENT organisations, the allocation is created carrying NO record and
 * refuses at post time. That is bounded, one-per-credit-note, since the sweep skips any credit note that
 * already has an allocation row of any status; it is reported as a WARNING rather than left for an
 * operator to discover from a refusal; and the warning carries a remedy that can actually be performed —
 * allocate the credit in the ledger by hand, because re-queueing rebuilds the same evidence-free payload
 * (`creditNoteAllocationOriginRemedy`, Codex r4 finding 2).
 *
 * AND WHAT THAT RECORD DOES NOT COVER, stated rather than implied. It vouches for `creditNoteId`. The
 * bill id (`accountingInvoiceId`) came from a DIFFERENT post — the whole reason this gap exists is that
 * the bill synced after the credit — and no column records that post's tenant, so nothing here can
 * compare the two. If they ever disagreed, the allocation would be addressed to the credit's
 * organisation carrying a foreign bill id, and Xero would reject it: a visible failure, not a silent
 * one. Closing that residual needs a provenance column beside `PurchaseInvoice.accountingInvoiceId`,
 * the same shape `Product.accountingItemProvenance` already has; it is not closed here.
 */
export async function reenqueueMissingCreditNoteAllocations(limit = 200): Promise<CreditNoteAllocationReenqueueResult> {
  const result: CreditNoteAllocationReenqueueResult = { checked: 0, enqueued: 0, failed: 0 }
  const candidates = await db.supplierCreditNote.findMany({
    where: {
      status: 'POSTED',
      accountingCreditNoteId: { not: null },
      purchaseInvoiceId: { not: null },
      purchaseInvoice: { is: { accountingInvoiceId: { not: null } } },
    },
    select: {
      id: true,
      accountingCreditNoteId: true,
      amountForeign: true,
      purchaseInvoice: { select: { accountingInvoiceId: true } },
    },
    orderBy: { postedAt: 'asc' },
    take: limit,
  })
  if (candidates.length === 0) return result

  // A credit note that already has an allocation row (live OR terminal) is owned
  // by the normal retry/repair path — this sweep only fills the never-enqueued gap.
  const existing = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
      referenceType: 'SupplierCreditNote',
      referenceId: { in: candidates.map((c) => c.id) },
    },
    select: { referenceId: true },
  })
  const hasAllocation = new Set(existing.map((e) => e.referenceId))
  const toEnqueue = selectCreditNotesNeedingAllocation(candidates, hasAllocation)
  if (toEnqueue.length === 0) return result

  // The rows whose posts ISSUED these credit ids, so the organisation one of them recorded can be carried
  // onto the allocation rather than a fresh read of the token row being invented for it.
  //
  // BOTH HALVES OF THE PAIR ARE FETCHED, AND THE PAIRING IS DONE IN MEMORY (Codex r4 finding 1). The two
  // `in` clauses narrow the scan but do NOT pair anything: a row for credit note A carrying credit note
  // B's document id satisfies both of them, and that cross-match is the whole defect — the id has to be
  // compared against the id THIS allocation is carrying, per candidate. `selectIssuingPostOriginRecord`
  // does that. No status filter: a row that names a document posted that document, whatever status it
  // ended up in (see the header there).
  const creditNotePosts = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'PURCHASE_CREDIT_NOTE',
      referenceType: 'SupplierCreditNote',
      referenceId: { in: toEnqueue.map((item) => item.supplierCreditNoteId) },
      externalTransactionId: { in: toEnqueue.map((item) => item.creditNoteId) },
    },
    // Only for a stable read; the choice among several issuing rows is made by rank, not by order.
    orderBy: [{ syncedAt: 'desc' }, { createdAt: 'desc' }],
    select: { referenceId: true, externalTransactionId: true, payload: true },
  })
  const postsByCreditNote = new Map<string, CreditNotePostRow[]>()
  for (const row of creditNotePosts) {
    const bucket = postsByCreditNote.get(row.referenceId)
    if (bucket) bucket.push(row)
    else postsByCreditNote.set(row.referenceId, [row])
  }

  for (const item of toEnqueue) {
    result.checked++
    try {
      const origin = selectIssuingPostOriginRecord(
        postsByCreditNote.get(item.supplierCreditNoteId) ?? [],
        item.creditNoteId,
      )
      // What the inherited record will MEAN at post time, read from the value actually being carried
      // rather than assumed from the fact that something was found. An issuing row that survives but
      // records nothing itself hands on nothing, and that row refuses too — so it gets the same warning
      // and the same remedy as finding no row at all, with a description that says which it was.
      const inherited = origin.outcome === 'inherited' ? readAccountingPayloadConnectionStamp(origin.payload) : null
      const inheritedProvenance = inherited?.state === 'stamped' ? inherited.provenance : null
      await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', 'SupplierCreditNote', item.supplierCreditNoteId, {
        creditNoteId: item.creditNoteId,
        accountingInvoiceId: item.accountingInvoiceId,
        amount: item.amount,
        sourceEntryId: 'reenqueue-sweep',
      }, origin.outcome === 'inherited'
        ? { from: 'postedRow', payload: origin.payload }
        : { from: 'unobserved' })
      result.enqueued++
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_credit_note_allocation_reenqueued',
        tag: 'sync',
        level: inheritedProvenance ? 'INFO' : 'WARNING',
        description: inheritedProvenance
          ? `Enqueued a missing supplier-credit-note allocation for ${item.supplierCreditNoteId} (bill synced after the `
            + `credit posted), carrying the accounting organisation recorded by the sync row that posted credit note `
            + `${item.creditNoteId} — ${inheritedProvenance}.`
          : `Enqueued a missing supplier-credit-note allocation for ${item.supplierCreditNoteId}, but `
            + `${describeMissingCreditNoteOrigin(origin, inherited, item.creditNoteId)}, so the allocation carries no `
            + 'usable record of which accounting organisation issued the credit and WILL be refused at post time '
            + 'rather than sent to whichever organisation happens to be connected. '
            + creditNoteAllocationOriginRemedy(item),
        metadata: {
          supplierCreditNoteId: item.supplierCreditNoteId,
          creditNoteId: item.creditNoteId,
          accountingInvoiceId: item.accountingInvoiceId,
          originRecordInherited: inheritedProvenance !== null,
          originOutcome: origin.outcome,
          originRecordState: inherited?.state ?? null,
          ...(origin.outcome === 'conflicting-origins' ? { conflictingOrigins: origin.recorded } : {}),
        },
      })
    } catch (error) {
      result.failed++
      console.error('reenqueueMissingCreditNoteAllocations: enqueue failed', item.supplierCreditNoteId, error)
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
          }, { from: 'postedRow', payload })
        }
      }
    }
  }

  await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
    sourceEntryId: entryId,
  }, { from: 'postedRow', payload })
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
  }, { from: 'postedRow', payload })
}

async function enqueuePurchaseCreditNoteFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  // audit-v08m: after the ACCPAYCREDIT posts, allocate it to the bill it offsets.
  // Needs both the credit's new external id and the bill's external id. The bill
  // id is threaded onto the payload at enqueue time (postSupplierCreditNote); if
  // the bill hasn't synced to Xero yet there's nothing to allocate against, so we
  // skip — the credit still posts and nets at the supplier level.
  if (referenceType !== 'SupplierCreditNote' || !syncResult.externalId) return
  const allocateToInvoiceId = payload.allocateToInvoiceId as string | undefined
  const allocateAmount = payload.allocateAmount as number | undefined
  if (!allocateToInvoiceId || allocateAmount == null || allocateAmount <= 0) return
  await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType, referenceId, {
    creditNoteId: syncResult.externalId,
    accountingInvoiceId: allocateToInvoiceId,
    amount: allocateAmount,
    // Resolved HERE rather than left undefined for processEntry to fill from the wall
    // clock. An unset date made the allocation body differ on every execution, so a
    // retry of a pinned request was no longer the same request (Codex review, r2 #3).
    date: (payload.date as string | undefined)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    sourceEntryId: entryId,
  }, { from: 'postedRow', payload })
}

/**
 * Fan a posted row out into the follow-up work it owes.
 *
 * `payload` IS THE ORIGIN EVIDENCE, not just the source of fields (Codex r3 finding 1). It is the stored
 * payload of the row that posted — whether this call comes from the processor moments after the post, or
 * from the back-reference sweep days later for a row whose process died before its follow-ups ran — and
 * the record it carries is the only thing that knows which organisation the external ids being handed on
 * belong to. Every `enqueueFollowUpSyncLog` below therefore passes `{ from: 'postedRow', payload }`, and
 * none of them reads the live connection.
 *
 * A row whose payload recorded nothing hands nothing on, and the follow-up refuses at post time instead
 * of being addressed to whoever is connected. That is the same answer the parent row itself would now
 * get, which is the property that makes the chain sound: a follow-up can never be MORE permitted than
 * the post it descends from.
 */
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

  if (type === 'PURCHASE_CREDIT_NOTE') {
    await enqueuePurchaseCreditNoteFollowUps(entryId, referenceType, referenceId, payload, syncResult)
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
      await enqueueFollowUpSyncLog(
        'INVOICE_EMAIL', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', payload },
      )
    }
    if (order?.shoppingLinks.length) {
      await enqueueFollowUpSyncLog(
        'WC_INVOICE_NOTE', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', payload },
      )
    }
  }
}
