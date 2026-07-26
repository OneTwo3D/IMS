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
import { logActivity } from '@/lib/activity-log'
import { pushSalesInvoice } from './invoices'
import { pushPurchaseBill } from './bills'
import { pushCreditMemo } from './credit-notes'
import { pushJournalEntry } from './journals'
import { qboPost, qboUploadAttachment, resolveAccountRef, qboPostIdempotent} from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { applyBackReference, backReferenceIsMissing, syncTypeWritesBackReference } from '@/lib/domain/accounting/back-reference'
import type { BackReferenceRepairResult } from '@/lib/connectors/xero/sync-processor'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
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
): Promise<void> {
  if (await hasExistingSyncLog(type, referenceType, referenceId)) return
  await db.accountingSyncLog.create({
    data: {
      connector: QBO_CONNECTOR,
      type,
      status: 'PENDING',
      referenceType,
      referenceId,
      payload: payload as never,
    },
  })
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
        // Persist external ID and SYNCED status BEFORE any follow-up work.
        // If follow-ups fail, the next retry will see externalTransactionId
        // and skip the QBO write (idempotency guard above).
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

        // Follow-up work (back-references, enqueue PDF/email/payment).
        // These are best-effort: if they fail, the external post is already
        // safely recorded and won't be replayed.
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
        } catch (followUpError) {
          await logActivity({
            entityType: 'SYSTEM',
            action: 'quickbooks_followup_error',
            tag: 'sync',
            level: 'WARNING',
            description: `QuickBooks sync entry ${entry.id} posted successfully but follow-up work failed: ${String(followUpError)}`,
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

  try {
    if (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') {
      await db.salesOrder.update({
        where: { id: referenceId },
        data: {
          accountingInvoiceId: externalId,
          invoiceNumber: invoiceNumber ?? undefined,
          invoicedAt: new Date(),
        },
      })
    } else if (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') {
      await db.salesOrderRefund.update({
        where: { id: referenceId },
        data: { accountingCreditNoteId: externalId },
      })
    } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseInvoice') {
      await db.purchaseInvoice.update({
        where: { id: referenceId },
        data: { accountingInvoiceId: externalId },
      })
    } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseOrder') {
      // Entries are queued with referenceType 'PurchaseOrder' — find the
      // latest PurchaseInvoice for this PO and store the external bill ID.
      const invoice = await db.purchaseInvoice.findFirst({
        where: { poId: referenceId, accountingInvoiceId: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (invoice) {
        await db.purchaseInvoice.update({
          where: { id: invoice.id },
          data: { accountingInvoiceId: externalId },
        })
      }
    }
  } catch {
    // Non-critical — log entry already marked as SYNCED
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


/**
 * o3d-0g2n: the QuickBooks counterpart of repairXeroBackReferences. Xero has had this since
 * audit-H3; QuickBooks never did, and the asymmetry was load-bearing.
 *
 * WHY IT MATTERS MORE THAN A MISSING NICETY. o3d-v7sy made the order delete guard check
 * SalesOrder.accountingInvoiceId specifically because it lives on the order row and SURVIVES the
 * retention purge that deletes AccountingSyncLog rows. That only holds if the marker is reliably
 * written. On QuickBooks it is not: updateBackReference runs AFTER the row is marked SYNCED and its
 * failure is swallowed into a WARNING. A transient failure therefore leaves
 *
 *   - a real invoice in QuickBooks,
 *   - a SYNCED row with an externalTransactionId (protective, but only until retention),
 *   - and NO accountingInvoiceId on the order — the retention-proof marker missing.
 *
 * Once retention deletes the log, an otherwise-eligible order can be hard-deleted while its
 * QuickBooks invoice stands: exactly the hole o3d-v7sy set out to close, reached through the
 * connector that lacked the repair path.
 *
 * The probe/apply helpers are connector-agnostic already (lib/domain/accounting/back-reference.ts),
 * which is what makes this a parity fix rather than a new mechanism — Xero routes through them
 * while the QuickBooks writer duplicates the same logic locally. Converging that writer is a
 * separate refactor (o3d-i53u); this only adds the missing sweep.
 *
 * Idempotent: it probes before writing and skips anything already linked, so it is safe to run
 * every cron cycle.
 */
export async function repairQuickBooksBackReferences(limit = 200): Promise<BackReferenceRepairResult> {
  // o3d-0g2n (review): AccountingSyncLog carries no realm provenance, and disconnecting permits
  // reconnecting to a DIFFERENT QuickBooks realm while historical rows survive. Repairing those
  // would write a realm-A transaction id onto a document now operated under realm B — which, if that
  // id happens to exist there, later payment and polling paths would act on an unrelated document.
  //
  // Without a provenance column the cheapest sound guard is the connection's own age: only rows
  // created since the CURRENT token was stored can belong to the current realm. Rows older than it
  // are left alone rather than guessed at. The token row is UPSERTED on refresh and only DELETED on
  // disconnect, so createdAt tracks the connection rather than the last refresh — which is what
  // makes it usable here at all.
  //
  // BE CLEAR ABOUT THE COST: a reconnect to the SAME realm also resets this timestamp, and those
  // older rows then become PERMANENTLY ineligible for repair — not merely deferred. Operators
  // reconnect whenever tokens break, so this is reachable. The trade is deliberate: a missed repair
  // leaves the order blocked by the sync-log checks (visible, recoverable until retention), while a
  // cross-realm id silently links a document to an unrelated remote record and is not recoverable
  // at all. Removing the cost, rather than accepting it, needs real provenance — o3d-s36z.
  //
  // Stamping the rows properly is the real fix, tracked as o3d-s36z.
  const token = await db.accountingToken.findUnique({
    where: { connector: 'quickbooks' },
    select: { createdAt: true },
  })
  if (!token) return { checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0 }

  const candidates = await db.accountingSyncLog.findMany({
    where: {
      connector: 'quickbooks',
      createdAt: { gte: token.createdAt },
      // FAILED is included for the same reason Xero includes it: the remote call happens BEFORE the
      // result is written, so a FAILED row carrying an external id posted successfully and then lost
      // its writeback (o3d-ju8t).
      status: { in: ['SYNCED', 'FAILED'] },
      externalTransactionId: { not: null },
      type: { in: ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE'] },
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, externalTransactionId: true, status: true, payload: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  // A PURCHASE_INVOICE row references the PO, not a specific bill. With several bills on one PO the
  // "latest unlinked bill" heuristic could stamp one bill's id onto another, so those are skipped
  // for manual attribution rather than guessed at — the same rule Xero's sweep applies (audit-H3).
  const poCandidateCounts = new Map<string, number>()
  for (const row of candidates) {
    if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder') {
      poCandidateCounts.set(row.referenceId, (poCandidateCounts.get(row.referenceId) ?? 0) + 1)
    }
  }

  const result: BackReferenceRepairResult = { checked: 0, repaired: 0, failed: 0, skippedAmbiguous: 0 }
  const ambiguousPos = new Set<string>()
  for (const row of candidates) {
    if (!row.externalTransactionId || !syncTypeWritesBackReference(row.type, row.referenceType)) continue
    if (row.type === 'PURCHASE_INVOICE' && row.referenceType === 'PurchaseOrder' && (poCandidateCounts.get(row.referenceId) ?? 0) > 1) {
      result.skippedAmbiguous++
      // Collected, not logged per row. An ambiguous PO is never resolved by this sweep, so it is
      // re-selected on EVERY run — and at a five-minute cron that is 576 identical warnings a day
      // per ambiguity, which buries actionable alerts rather than raising one. One batched warning
      // per run instead; the per-run repetition itself is tracked with the rest of the ambiguity
      // handling in o3d-9kek.
      ambiguousPos.add(row.referenceId)
      continue
    }

    const payload = (row.payload ?? {}) as Record<string, unknown>
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
      console.error('repairQuickBooksBackReferences: probe failed', row.id, probeError)
      result.failed++
      continue
    }
    if (!missing) continue
    result.checked++

    try {
      await applyBackReference(db, params, { markerOnly: true })

      // DELIBERATELY DOES NOT touch status, and does NOT re-enqueue follow-ups.
      //
      // Xero's sweep does both, and mirroring that is what the first two revisions of this function
      // tried. Review showed the pairing is unsafe here, in two independent ways:
      //
      //   - THE RETRY PROMISE WAS UNREACHABLE. Gating "clear FAILED" on the follow-ups succeeding
      //     looked careful, but once applyBackReference has run, backReferenceIsMissing returns
      //     false and the row is skipped by the probe above on every later pass. So a row retained
      //     as FAILED for retry would never be reconsidered — permanently FAILED with its follow-ups
      //     still missing. The gate promised something the control flow could not deliver.
      //
      //   - RE-ENQUEUING A FAILED PAYMENT CAN DOUBLE-PAY. enqueueFollowUps' existence check ignores
      //     FAILED rows, so it creates a NEW row — and processEntry derives the QuickBooks requestid
      //     from that row's id. If an earlier INVOICE_PAYMENT reached FAILED after QuickBooks had
      //     already committed it (response lost, or the local status write failed), the replacement
      //     carries a DIFFERENT request id and QuickBooks accepts a second payment. Per-entry
      //     idempotency does not survive regenerating the entry.
      //
      // So this sweep does one thing: restore the back-reference, which is the retention-proof
      // marker the delete guard depends on (o3d-v7sy) and the entire reason it exists. A FAILED row
      // stays FAILED — visible, still blocking deletion, still retryable by the operator through the
      // normal path. Restoring follow-ups safely needs deterministic idempotency keys that survive
      // row regeneration, tracked as o3d-h2wx.
      result.repaired++
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_backreference_repaired',
        tag: 'sync',
        level: 'INFO',
        description: `Re-applied missing QuickBooks back-reference for ${row.referenceType} ${row.referenceId} (external id ${row.externalTransactionId}).`,
        metadata: { syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId },
      })
    } catch (repairError) {
      result.failed++
      console.error('repairQuickBooksBackReferences: repair failed', row.id, repairError)
    }
  }


  if (ambiguousPos.size > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_backreference_repair_ambiguous',
      tag: 'sync',
      level: 'WARNING',
      description:
        `Skipped QuickBooks back-reference repair for ${ambiguousPos.size} purchase order(s): each has `
        + `multiple bills with unwritten external ids, which cannot be attributed automatically. Link `
        + `them manually. POs: ${[...ambiguousPos].join(', ')}`,
      metadata: { referenceIds: [...ambiguousPos], skippedAmbiguous: result.skippedAmbiguous },
    })
  }

  return result
}
