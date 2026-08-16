/**
 * Process pending QuickBooks sync entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one QBO API call.
 * Mirrors lib/connectors/xero/sync-processor.ts.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { activeAccountingIdProvenance, accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { pushSalesInvoice } from './invoices'
import { pushPurchaseBill } from './bills'
import { pushCreditMemo } from './credit-notes'
import { pushJournalEntry } from './journals'
import { qboPost, qboUploadAttachment, resolveAccountRef, qboPostIdempotent} from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { planFollowUpEnqueue, readFollowUpIdempotencyKey } from '@/lib/domain/accounting/followup-idempotency'
import { logFollowUpRevival, resolveLostFollowUpRevival } from '@/lib/domain/accounting/followup-revival'
import { isUniqueConstraintViolation } from '@/lib/db/prisma-unique-violation'
import { applyBackReference } from '@/lib/domain/accounting/back-reference'
import {
  DEFAULT_BACK_REFERENCE_SWEEP_LIMIT,
  createBackReferenceSweepCursorStore,
  repairAccountingBackReferences,
  type BackReferenceRepairResult,
} from '@/lib/domain/accounting/back-reference-sweep'
import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import { resolveStoredInvoiceUploadPath } from '@/lib/upload-storage'

const MAX_RETRIES = 5
const MAX_PER_RUN = 100 // QBO rate limit: 500/min — can handle more than Xero
const CLAIM_STALE_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_BASE_MS = 10_000
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000
const QBO_CONNECTOR = 'quickbooks'

/**
 * A stored contact id, but ONLY if its provenance matches the active QuickBooks company (o3d-6nd).
 * These payment/follow-up paths read the cached id via a join rather than through
 * contacts.getStoredContactId, so they need the same guard applied here or a former realm's id leaks
 * through. Returns null when there is no id or its provenance does not match — callers already treat a
 * missing id as a clean, retryable failure.
 */
export async function customerContactIdIfCurrent(
  contact: { accountingContactId: string | null; accountingContactProvenance: string | null } | null | undefined,
): Promise<string | null> {
  if (!contact?.accountingContactId) return null
  const active = await activeAccountingIdProvenance(QBO_CONNECTOR)
  return accountingIdProvenanceMatches(contact.accountingContactProvenance, active) ? contact.accountingContactId : null
}

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>

/**
 * Intuit documents a 50-CHARACTER MAXIMUM for a non-batch `requestid`, and error 2130 for an invalid
 * format. A full SHA-256 hex digest is 64, so the value this has always sent was over-length
 * (o3d-nmar) — and invoices, bills and credit notes have used this same builder via
 * qboPostIdempotent all along, not just the payment path o3d-b3gw adds.
 *
 * 32 hex characters = 128 bits, which is far beyond what idempotency needs: the id only has to be
 * unique among documents this system posts, and a 128-bit digest collision is not a scenario worth
 * defending against. It leaves 18 characters of headroom under the documented limit.
 *
 * ON CHANGING AN IDEMPOTENCY KEY, deliberately. One of these was true before, and we could not tell
 * which without asking Intuit:
 *
 *   (a) Intuit tolerated over-length ids, and dedup worked. Then this change alters the key, and a
 *       request that SUCCEEDED at Intuit but whose response we lost would, if retried across the
 *       deploy, post a second time. That window is narrow: we only retry when we did not record
 *       success, and the retry has to straddle the deploy.
 *   (b) Intuit ignored the parameter when over-length. Then NO post has ever been idempotent, and
 *       there is no dedup to lose — this makes it work for the first time.
 *   (c) Intuit rejected it with 2130. Then idempotent posting was failing outright and would be
 *       loudly visible.
 *
 * Under (b) or (c) this is a strict improvement with nothing to regress. Under (a) it trades a
 * narrow one-deploy window for actually satisfying the documented contract. Staying over-length is
 * not the safe option — it is the one where we keep believing in protection we may not have.
 */
export const QBO_REQUEST_ID_MAX_LENGTH = 50
const QBO_REQUEST_ID_HEX_CHARS = 32

export function buildQboRequestId(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, QBO_REQUEST_ID_HEX_CHARS)
}

function getIdempotencySource(
  entryId: string,
  type: AccountingSyncType,
  referenceId: string,
  payload: SyncPayload,
): string {
  // o3d-h2wx: a follow-up stamped with the stable token derives from THAT, so regenerating
  // its row cannot rotate the Request-Id. Ordered above `_idempotencyKey` — which is the
  // generic queue's, set by callers this module does not own — because only the follow-up
  // token is guaranteed to be identical across a re-enqueue.
  const followUpKey = readFollowUpIdempotencyKey(payload)
  if (followUpKey) return followUpKey
  if (typeof payload._idempotencyKey === 'string') return payload._idempotencyKey
  return type.startsWith('DAILY_BATCH_') ? `${type}:${referenceId}` : entryId
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
    connector: QBO_CONNECTOR,
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

async function hasExistingSyncLog(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  const count = await db.accountingSyncLog.count({
    where: {
      connector: QBO_CONNECTOR,
      type,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
  })
  return count > 0
}

async function enqueueFollowUpSyncLog(
  type: 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE',
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  /** Bounds the re-plan below, so a pathological race cannot recurse forever. */
  attempt = 0,
): Promise<void> {
  const liveRowExists = await hasExistingSyncLog(type, referenceType, referenceId)
  // o3d-h2wx: a FAILED row is REUSED rather than replaced. The QuickBooks Request-Id is
  // derived from the entry id, so a replacement row posts the retry under a request id
  // Intuit has never seen — and if the failed attempt had actually committed, a SECOND
  // payment lands on the invoice.
  const failedLogs = liveRowExists ? [] : await db.accountingSyncLog.findMany({
    where: { connector: QBO_CONNECTOR, type, referenceType, referenceId, status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })
  const failedRows = failedLogs.map((row) => ({
    id: row.id,
    payload: row.payload,
    // Exactly what getIdempotencySource would have produced for this row, so pinning it
    // reproduces a byte-identical Request-Id even after the row itself is gone. Note this
    // consults the generic `_idempotencyKey`, which QuickBooks has always honoured — unlike
    // Xero, whose payment branches never did.
    effectiveToken: getIdempotencySource(row.id, type, referenceId, (row.payload ?? {}) as SyncPayload),
  }))
  const plan = planFollowUpEnqueue({
    connector: QBO_CONNECTOR,
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
      action: 'quickbooks_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: `Refused to re-enqueue QuickBooks ${type} for ${referenceType} ${referenceId}: ${plan.reason}`,
      metadata: { type, referenceType, referenceId, failedRowIds: failedRows.map((row) => row.id) },
    })
    return
  }
  try {
    if (plan.action === 'reuse') {
      // Fenced on status: if another run revived the same row first — or retention deleted
      // it between the read and here (o3d-nepa) — this updates nothing rather than
      // resetting a claim it does not own.
      const revived = await db.accountingSyncLog.updateMany({
        where: { id: plan.syncLogId, status: 'FAILED' },
        data: {
          status: 'PENDING',
          payload: plan.payload as never,
          retryCount: 0,
          errorMessage: null,
          processingStartedAt: null,
        },
      })
      if (revived.count === 0) {
        await resolveLostFollowUpRevival({
          connector: QBO_CONNECTOR,
          type,
          referenceType,
          referenceId,
          payload: plan.payload,
          syncLogId: plan.syncLogId,
          attempt,
          // plan.payload carries the PINNED token, and withFollowUpIdempotencyKey never
          // overwrites one — so a row created by the re-plan posts under the same remote
          // key as the row that vanished. That is what makes losing the row survivable.
          retry: () => enqueueFollowUpSyncLog(type, referenceType, referenceId, plan.payload, attempt + 1),
        })
        return
      }
      await logFollowUpRevival(QBO_CONNECTOR, type, referenceType, referenceId, plan)
      return
    }
    await db.accountingSyncLog.create({
      data: {
        connector: QBO_CONNECTOR,
        type,
        status: 'PENDING',
        referenceType,
        referenceId,
        payload: plan.payload as never,
      },
    })
  } catch (error) {
    // A concurrent run took the live slot and the partial unique index
    // (accounting_sync_logs_followup_live_unique) rejected ours. This used to return as an
    // idempotent no-op, which silently accepted a winner posting under a DIFFERENT token
    // while ours may already have committed (Codex review, r7 #1). It now goes through the
    // same resolver as a lost compare-and-set, which only accepts a live row carrying our
    // token.
    if (isUniqueConstraintViolation(error)) {
      await resolveLostFollowUpRevival({
        connector: QBO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(type, referenceType, referenceId, plan.payload, attempt + 1),
      })
      return
    }
    throw error
  }
}

export async function processPendingQuickBooksSync(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  const pending = await db.accountingSyncLog.findMany({
    where: {
      connector: QBO_CONNECTOR,
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

  for (const entry of pending) {
    const claimedAt = new Date()
    const claim = await db.accountingSyncLog.updateMany({
      where: {
        id: entry.id,
        connector: QBO_CONNECTOR,
        retryCount: { lt: MAX_RETRIES },
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
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
      },
    })
    if (claim.count === 0) continue

    result.processed++
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      // Idempotency guard: if a previous run already posted to QBO but failed
      // during follow-up work, don't re-post. Skip straight to follow-ups.
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
        await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
        await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
        result.succeeded++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimedAt)

      if (syncResult.skipped) {
        // processEntry already terminalised this row (its order was cancelled — o3d-5rs/o3d-ejg).
        // Nothing was posted, so do NOT mark it SYNCED/POSTED; it is a resolved no-op.
        result.skipped++
        continue
      }
      if (syncResult.success) {
        // o3d-9kek r3 finding 1: stamp the row with the connection that ISSUED this external id.
        // External ids are tenant-owned — QuickBooks realm ids are integers that repeat across
        // companies — so a repair sweep running under a different realm must be able to see that
        // this row is not its business. Resolved per entry rather than once per run: a token can
        // be replaced mid-run, and a row must record the connection it actually posted to.
        const provenance = await activeAccountingIdProvenance(QBO_CONNECTOR)
        // Persist external ID and SYNCED status BEFORE any follow-up work.
        // If follow-ups fail, the next retry will see externalTransactionId
        // and skip the QBO write (idempotency guard above).
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              externalTransactionId: syncResult.externalId ?? null,
              provenance,
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

        // Follow-up work (back-references, enqueue PDF/email/payment).
        // These are best-effort: if they fail, the external post is already
        // safely recorded and won't be replayed.
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
        } catch (followUpError) {
          // ERROR, not WARNING: the external post is committed and this entry is about to be
          // marked succeeded, so nothing will drive these follow-ups again. A payment or PDF
          // that never got enqueued is silently missing until someone notices, and at WARNING
          // nobody does (Codex review, r6).
          await logActivity({
            entityType: 'SYSTEM',
            action: 'quickbooks_followup_error',
            tag: 'sync',
            level: 'ERROR',
            description: `QuickBooks sync entry ${entry.id} posted successfully but its follow-up work was NOT `
              + `enqueued: ${String(followUpError)}. The document is in QuickBooks; its payment, PDF or email `
              + 'follow-ups need to be re-driven manually.',
            metadata: { syncLogId: entry.id, type: entry.type, referenceType: entry.referenceType, referenceId: entry.referenceId },
          })
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
    where: { connector: QBO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order invoice
  // retirements, o3d-5rs/o3d-ejg) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_sync_batch',
      tag: 'sync',
      description: `QuickBooks sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: result,
    })
  }

  return result
}

async function processEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  claimedAt: Date,
): Promise<{ success: boolean; externalId?: string; invoiceNumber?: string; error?: string; skipped?: boolean }> {
  const requestId = buildQboRequestId(getIdempotencySource(entryId, type, referenceId, payload))

  switch (type) {
    case 'SALES_INVOICE': {
      // Cancelled-order backstop, parity with the Xero processor (o3d-5rs / o3d-ejg): re-read the order
      // status before posting. A SALES_INVOICE queued at import can be cancelled before it drains (cancel
      // is only allowed pre-dispatch, so no revenue) — never post an invoice for a cancelled sale. Fail
      // CLOSED on an unreadable/missing order; retire THIS claimed row (claim-fenced) if cancelled.
      // Residual (same as the Xero backstop): cancellation can still commit AFTER this read but before
      // the irreversible QBO POST (a lock-less TOCTOU). Fully closing it needs a posting-intent/lock
      // protocol coordinating cancellation with posting — tracked cross-connector as o3d-7o0.
      let customerId: string | undefined
      if (referenceType === 'SalesOrder') {
        let so: { customerId: string | null; status: string } | null
        try {
          so = await db.salesOrder.findUnique({ where: { id: referenceId }, select: { customerId: true, status: true } })
        } catch (error) {
          return { success: false, error: `Could not read sales order ${referenceId} status before posting: ${String(error)}` }
        }
        if (!so) {
          return { success: false, error: `Sales order ${referenceId} not found before posting an invoice` }
        }
        if (so.status === 'CANCELLED') {
          await db.$transaction((tx) => retireSalesInvoiceForCancelledOrder(tx, entryId, referenceId, claimedAt))
          return { success: true, skipped: true }
        }
        customerId = so.customerId ?? undefined
      }
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
      }, undefined, { customerId, requestId })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, error: invoiceResult.error }
    }

    case 'PURCHASE_INVOICE': {
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true },
          }).catch(() => null)
        : null
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, undefined, { supplierId: supplier?.supplierId, requestId })
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
    }

    case 'SALES_INVOICE_UPDATE':
    case 'PURCHASE_INVOICE_UPDATE':
      return { success: false, error: `${type} is not supported by the QuickBooks sync processor yet` }

    case 'CREDIT_NOTE': {
      const creditCustomerId = referenceType === 'SalesOrderRefund'
        ? (await db.salesOrderRefund.findUnique({
            where: { id: referenceId },
            select: { order: { select: { customerId: true } } },
          }).catch(() => null))?.order.customerId ?? undefined
        : undefined
      const creditResult = await pushCreditMemo({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, undefined, { customerId: creditCustomerId, requestId })
      return { success: creditResult.success, externalId: creditResult.creditNoteId, error: creditResult.error }
    }

    case 'INVOICE_PAYMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for INVOICE_PAYMENT' }
      }
      // Resolve customer ref: prefer payload, fall back to order's customer.
      // RESIDUAL (o3d-gfh): payload.customerRef is a naked id stamped at ENQUEUE time and is NOT
      // provenance-checked here — the payment row carries no provenance to check it against. A payment
      // queued under realm A and processed after a disconnect+reconnect to realm B would send A's id (and
      // the equally tenant-owned accountingInvoiceId/bankAccountId) to B. The fallback DB read below IS
      // guarded (o3d-6nd); closing the payload path needs the queued row stamped with its connection and
      // the whole payment context validated at execution, tracked in o3d-gfh.
      let customerRefId = payload.customerRef as string | undefined
      if (!customerRefId && referenceType === 'SalesOrder') {
        const order = await db.salesOrder.findUnique({
          where: { id: referenceId },
          select: { customer: { select: { accountingContactId: true, accountingContactProvenance: true } } },
        })
        // Provenance-guarded (o3d-6nd): a contact id issued by a former realm must not be sent to the
        // active company. A mismatch reads as "no id" and surfaces the existing missing-reference error,
        // so the payment fails cleanly and retries rather than posting against the wrong company.
        customerRefId = (await customerContactIdIfCurrent(order?.customer)) ?? undefined
      }
      if (!customerRefId) {
        return { success: false, error: 'Missing customer reference for INVOICE_PAYMENT — customer has no QuickBooks contact ID' }
      }
      const accountRef = await resolveAccountRef(bankAccountId)
      if (!accountRef) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced QuickBooks chart of accounts` }
      }
      try {
        // o3d-b3gw: idempotent, like every other document this connector posts. Without a
        // stable Request-Id, a payment that QuickBooks COMMITS but whose response is lost — or
        // whose local "mark SYNCED" write then fails — is retried and creates a SECOND payment
        // against the same invoice. That over-settles it and needs a manual reversal.
        const paymentRes = await qboPostIdempotent<{ Payment: { Id: string } }>('payment', {
          CustomerRef: { value: customerRefId },
          TotalAmt: amount,
          TxnDate: paymentDate,
          DepositToAccountRef: accountRef,
          Line: [{
            Amount: amount,
            LinkedTxn: [{ TxnId: accountingInvoiceId, TxnType: 'Invoice' }],
          }],
        }, requestId)
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post QuickBooks payment' }
        }
        return { success: true, externalId: paymentRes.data?.Payment?.Id }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'BILL_PAYMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for BILL_PAYMENT' }
      }
      // Resolve vendor ref: prefer payload, fall back to PO's supplier.
      // Same residual as INVOICE_PAYMENT above — payload.vendorRef is unchecked; see o3d-gfh.
      let vendorRefId = payload.vendorRef as string | undefined
      if (!vendorRefId && referenceType === 'PurchaseInvoice') {
        const invoice = await db.purchaseInvoice.findUnique({
          where: { id: referenceId },
          select: { po: { select: { supplier: { select: { accountingContactId: true, accountingContactProvenance: true } } } } },
        })
        // Provenance-guarded (o3d-6nd) — see INVOICE_PAYMENT above.
        vendorRefId = (await customerContactIdIfCurrent(invoice?.po?.supplier)) ?? undefined
      }
      if (!vendorRefId) {
        return { success: false, error: 'Missing vendor reference for BILL_PAYMENT — supplier has no QuickBooks contact ID' }
      }
      const accountRef = await resolveAccountRef(bankAccountId)
      if (!accountRef) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced QuickBooks chart of accounts` }
      }
      try {
        // o3d-b3gw: same reasoning as the customer payment above — a lost response must not
        // become a second bill payment.
        const paymentRes = await qboPostIdempotent<{ BillPayment: { Id: string } }>('billpayment', {
          VendorRef: { value: vendorRefId },
          TotalAmt: amount,
          TxnDate: paymentDate,
          PayType: 'Check',
          CheckPayment: { BankAccountRef: accountRef },
          Line: [{
            Amount: amount,
            LinkedTxn: [{ TxnId: accountingInvoiceId, TxnType: 'Bill' }],
          }],
        }, requestId)
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post QuickBooks bill payment' }
        }
        return { success: true, externalId: paymentRes.data?.BillPayment?.Id }
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
      const attachEnabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_attach_pdf' } })
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
        const uploadRes = await qboUploadAttachment('Bill', accountingInvoiceId, filename, pdfBuffer, 'application/pdf')
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
        const { downloadQuickBooksInvoicePdf, saveInvoicePdf } = await import('./invoice-pdf')
        const pdfBuffer = await downloadQuickBooksInvoicePdf(accountingInvoiceId)
        if (!pdfBuffer) return { success: false, error: 'Failed to download QuickBooks invoice PDF' }
        const pdfSavePath = await saveInvoicePdf(orderId, pdfBuffer)
        await db.salesOrder.update({
          where: { id: orderId },
          data: { invoicePdfPath: pdfSavePath },
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
      const journalResult = await pushJournalEntry({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, undefined, { requestId })
      return { success: journalResult.success, externalId: journalResult.journalId, error: journalResult.error }
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
  // o3d-9kek r3 finding 1: bill ids are REALM-owned. QuickBooks realm ids are integers that repeat
  // across companies, so the id is stored with the connection that issued it and uniqueness is
  // enforced over the pair. With no connected realm there is no namespace to write into — refuse,
  // and let the repair sweep link it once a connection exists.
  const provenance = await activeAccountingIdProvenance(QBO_CONNECTOR)
  if (!provenance) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_backreference_no_realm',
      tag: 'sync',
      level: 'WARNING',
      description: `Did not write the QuickBooks back-reference for ${referenceType} ${referenceId}: no connected QuickBooks company to `
        + `attribute external id ${externalId} to. The id is on the sync row and the repair sweep links it once a company is connected.`,
      metadata: { type, referenceType, referenceId, externalId },
    })
    return
  }

  try {
    // EVERY type goes through the shared writer, exactly as Xero's does. Hand-rolled per-type
    // updates here were how the two connectors drifted: the bill-keyed branch wrote
    // accountingInvoiceId with a bare `update`, which since o3d-9kek r3 finding 1 would have
    // stored the id WITHOUT the realm that issued it — landing it in the '' sentinel namespace,
    // where a genuinely different company's bill can collide with it. The namespace and the id
    // must be written together, and there is exactly one place that does that.
    const applied = await applyBackReference(db, { connector: QBO_CONNECTOR, provenance, type, referenceType, referenceId, externalId, invoiceNumber })
    // o3d-9kek: a legacy PurchaseOrder-keyed row names the ORDER, not the bill. It used to write
    // the external id onto "the newest bill with no id yet" — which stamps the wrong bill the
    // moment a PO has two, and a wrong id is worse than a missing one because it looks correct
    // (later payments and bill updates then post against the wrong QuickBooks document). The
    // shared resolver decides from the whole population for that PO and refuses to guess.
    if (applied.outcome === 'ambiguous') {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_backreference_ambiguous',
        tag: 'sync',
        level: 'WARNING',
        description: `Did not write the QuickBooks back-reference for PO ${referenceId}: its bill cannot be identified `
          + `(${applied.attribution.reason}). Link the bill manually — the external id is on the sync row, and the repair `
          + 'sweep re-checks it daily in case the ambiguity clears on its own.',
        metadata: { referenceType, referenceId, externalId, reason: applied.attribution.reason },
      })
    }
    // o3d-9kek finding 3: the resolved bill gained an external id between the resolve and
    // the compare-and-swap, so nothing was written and nothing was overwritten. Not an
    // error — the repair sweep re-resolves it from the state that actually won.
    if (applied.outcome === 'contended') {
      console.warn(`quickbooks: back-reference for PO ${referenceId} lost the race for bill ${applied.purchaseInvoiceId}; the repair sweep will re-resolve it.`)
    }
  } catch (error) {
    // Pre-existing: QuickBooks swallows back-reference failures here (Xero does not — it
    // propagates so the caller retries). Still not changed, because de-swallowing alters QBO's
    // retry semantics for every type at once. What IS changed is the SILENCE: since o3d-9kek made
    // the bill's external id unique, a real attribution conflict — two local bills pointing at one
    // QuickBooks document — arrives here as an exception, and an invisible one is
    // indistinguishable from success.
    //
    // Swallowing is only defensible because the row is left in an EXPLICITLY RETRYABLE state and
    // something actually retries it: the row keeps its externalTransactionId with
    // backReferenceCheckedAt NULL, which is exactly the repair sweep's candidate shape, and
    // repairQuickBooksBackReferences now runs from the QuickBooks cron and the manual sync
    // (o3d-9kek r3 finding 2). Until this branch that sentence was false — the message below
    // promised a sweep that existed for Xero only.
    console.error(`quickbooks: back-reference write failed for ${referenceType} ${referenceId}`, error)
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_backreference_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `Could not write the QuickBooks back-reference for ${referenceType} ${referenceId}: ${String(error)}. `
        + 'The external id is on the sync row; the back-reference repair sweep will retry it.',
      metadata: { type, referenceType, referenceId, externalId },
    })
  }
}

async function enqueueSalesInvoiceFollowUps(
  _entryId: string,
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
        action: 'quickbooks_payment_skipped',
        tag: 'sync',
        level: 'WARNING',
        description: 'Skipped QuickBooks payment registration: no payment account map configured.',
      })
    } else {
      const stored = lookupPaymentAccount(paymentMap, method, currency)
      if (!stored) {
        await logActivity({
          entityType: 'SYSTEM',
          action: 'quickbooks_payment_skipped',
          tag: 'sync',
          level: 'WARNING',
          description: `Skipped QuickBooks payment registration: no bank account mapped for method "${method}" / currency "${currency}".`,
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
          // Resolve QBO customer ID for the payment request
          let customerRef: string | undefined
          if (referenceType === 'SalesOrder') {
            const order = await db.salesOrder.findUnique({
              where: { id: referenceId },
              select: { customer: { select: { accountingContactId: true, accountingContactProvenance: true } } },
            })
            // Provenance-guarded (o3d-6nd): only enqueue an id that belongs to the active company, so a
            // follow-up queued now cannot carry a former realm's id.
            customerRef = (await customerContactIdIfCurrent(order?.customer)) ?? undefined
          }

          await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
            accountingInvoiceId: syncResult.externalId,
            bankAccountId: stored,
            amount,
            paymentDate: (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            currency,
            method,
            customerRef,
          })
        }
      }
    }
  }

  await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
  })
}

async function enqueuePurchaseInvoiceFollowUps(
  _entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  // Entries can arrive with referenceType 'PurchaseInvoice' or 'PurchaseOrder'
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) return
  await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    supplierInvoicePath: payload.supplierInvoicePath,
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
      await enqueueFollowUpSyncLog('INVOICE_EMAIL', referenceType, referenceId, { referenceId })
    }
    // b8i6.6: the post-invoice note follow-up is WooCommerce-only BY DESIGN.
    // It is already connector-aware — only enqueued when the order has a
    // WooCommerce link (query above filters connector:'woocommerce'), so a
    // Shopify-only order never gets a no-op note. Shopify has no order-note /
    // invoice-link capability to push to yet; adding one needs a Shopify
    // implementation + live validation before a SHOPPING_INVOICE_NOTE could be
    // generalised here.
    if (order?.shoppingLinks.length) {
      await enqueueFollowUpSyncLog('WC_INVOICE_NOTE', referenceType, referenceId, { referenceId })
    }
  }
}

export type { BackReferenceRepairResult }

/**
 * audit-H3 repair sweep, QuickBooks binding (o3d-9kek r3 finding 2).
 *
 * WHY THIS EXISTS NOW. updateBackReference above swallows its write failures — including the
 * load-bearing P2002 from the bill's unique index — and both it and the PO-ambiguity path told the
 * operator "the back-reference repair sweep will retry it". No such sweep ran for QuickBooks:
 * repairAccountingBackReferences was bound for Xero only, and the QuickBooks cron merely processed
 * pending rows. So those rows stayed permanently unlinked even after the ambiguity cleared, and the
 * message an operator read was false. Telling someone a retry will happen when nothing retries is
 * worse than saying nothing.
 *
 * The implementation is connector-agnostic on purpose — same starvation fix, same namespace
 * scoping, same refusal to guess which bill a PO-keyed row belongs to — so the two connectors
 * cannot drift on this the way they just did.
 */
export async function repairQuickBooksBackReferences(limit = DEFAULT_BACK_REFERENCE_SWEEP_LIMIT): Promise<BackReferenceRepairResult> {
  return repairAccountingBackReferences({
    db,
    connector: QBO_CONNECTOR,
    connectorLabel: 'QuickBooks',
    activityActionPrefix: 'quickbooks',
    // The realm whose external ids this run may attribute (r3 finding 1). NULL — no connected
    // company — makes the sweep do nothing, which is correct: a QuickBooks bill id is an integer
    // that means something different in every realm.
    provenance: await activeAccountingIdProvenance(QBO_CONNECTOR),
    // Resume behind the rows the last run could not settle (r3 finding 4).
    cursorStore: createBackReferenceSweepCursorStore(db, QBO_CONNECTOR),
    // logActivityPersisted, NOT logActivity: the sweep defers an ambiguous row for 24 hours on the
    // strength of having warned about it, and logActivity swallows its own write failures, so
    // awaiting it cannot establish that anybody was told (o3d-9kek r2 finding 3).
    logActivity: logActivityPersisted,
    enqueueFollowUps: (entryId, type, referenceType, referenceId, payload, syncResult) =>
      enqueueFollowUps(entryId, type, referenceType, referenceId, payload as SyncPayload, syncResult),
  }, { limit })
}
