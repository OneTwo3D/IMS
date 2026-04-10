/**
 * Process pending XeroSyncLog entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one Xero API call.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { pushSalesInvoice } from './invoices'
import { pushPurchaseBill } from './bills'
import { pushCreditNote } from './credit-notes'
import { pushManualJournal } from './journals'
import { xeroUploadAttachment, xeroPost } from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import type { AccountingSyncType } from '@/app/generated/prisma/client'

const MAX_RETRIES = 5
const MAX_PER_RUN = 50 // Xero rate limit: 60/min — leave headroom

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>

export async function processPendingXeroSync(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }

  const pending = await db.accountingSyncLog.findMany({
    where: {
      status: 'PENDING',
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_RUN,
  })

  for (const entry of pending) {
    result.processed++
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      const syncResult = await processEntry(entry.type, payload)

      if (syncResult.success) {
        await db.accountingSyncLog.update({
          where: { id: entry.id },
          data: {
            status: 'SYNCED',
            xeroTransactionId: syncResult.externalId ?? null,
            syncedAt: new Date(),
            errorMessage: null,
          },
        })

        // Update back-references (e.g. accountingInvoiceId on SalesOrder)
        await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)

        result.succeeded++
      } else {
        const retryCount = entry.retryCount + 1
        await db.accountingSyncLog.update({
          where: { id: entry.id },
          data: {
            status: retryCount >= MAX_RETRIES ? 'FAILED' : 'PENDING',
            retryCount,
            errorMessage: syncResult.error ?? 'Unknown error',
          },
        })
        result.failed++
      }
    } catch (e) {
      const retryCount = entry.retryCount + 1
      await db.accountingSyncLog.update({
        where: { id: entry.id },
        data: {
          status: retryCount >= MAX_RETRIES ? 'FAILED' : 'PENDING',
          retryCount,
          errorMessage: String(e),
        },
      })
      result.failed++
    }
  }

  // Log skipped entries (exceeded max retries)
  const skippedCount = await db.accountingSyncLog.count({
    where: { status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  result.skipped = skippedCount

  if (result.processed > 0) {
    logActivity({
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
  type: AccountingSyncType,
  payload: SyncPayload,
): Promise<{ success: boolean; externalId?: string; invoiceNumber?: string; error?: string }> {
  const postingMode = payload._postingMode

  switch (type) {
    case 'SALES_INVOICE': {
      const invoiceResult = await pushSalesInvoice({
        invoiceNumber: payload.invoiceNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; discountRate?: number }>,
        shippingAmount: payload.shippingAmount as number | undefined,
        shippingDescription: payload.shippingDescription as string | undefined,
        shippingAccountCode: payload.shippingAccountCode as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode))

      // Register payment in Xero if requested (pre-paid WC orders).
      // Payment account map is a connector-agnostic setting — the active
      // accounting connector (Xero here) interprets the stored value as
      // either a Xero UUID (preferred) or a legacy Account Code.
      if (invoiceResult.success && invoiceResult.invoiceId && payload._registerPayment) {
        try {
          const paymentMap = await getPaymentAccountMap()
          const method = payload._paymentMethod as string || ''
          const currency = payload.currency as string || 'GBP'
          const stored = lookupPaymentAccount(paymentMap, method, currency)

          if (stored) {
            // Resolve stored value to a XeroAccount — match either xeroId (new) or code (legacy).
            // Bank accounts in Xero may have NULL codes (e.g. Stripe feeds), so we always post
            // using AccountID, which is guaranteed unique.
            const account = await db.xeroAccount.findFirst({
              where: { OR: [{ xeroId: stored }, { code: stored }] },
              select: { xeroId: true },
            })
            if (account) {
              const paymentDate = (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
              await xeroPost('Payments', {
                Invoice: { InvoiceID: invoiceResult.invoiceId },
                Account: { AccountID: account.xeroId },
                Date: paymentDate,
                Amount: payload.shippingAmount
                  ? (payload.lines as Array<{ quantity: number; unitAmount: number }>).reduce((s, l) => s + l.quantity * l.unitAmount, 0)
                    + (payload.shippingAmount as number)
                    - ((payload.discountAmount as number) || 0)
                  : (payload.lines as Array<{ quantity: number; unitAmount: number }>).reduce((s, l) => s + l.quantity * l.unitAmount, 0)
                    - ((payload.discountAmount as number) || 0),
              })
            }
          }
        } catch (e) {
          // Payment registration failure is non-critical — invoice was already created
          logActivity({
            entityType: 'SYSTEM',
            action: 'xero_payment_registration_failed',
            tag: 'sync',
            level: 'WARNING',
            description: `Failed to register Xero payment: ${String(e)}`,
          })
        }
      }

      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, error: invoiceResult.error }
    }

    case 'PURCHASE_INVOICE': {
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode))
      // Attach supplier invoice PDF if available and setting enabled
      if (billResult.success && billResult.invoiceId && payload.supplierInvoicePath) {
        try {
          const attachEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_attach_pdf' } })
          if (attachEnabled?.value !== 'false') {
            const pdfPath = join(process.cwd(), 'public', payload.supplierInvoicePath as string)
            const pdfBuffer = await readFile(pdfPath)
            const filename = (payload.supplierInvoicePath as string).split('/').pop() ?? 'supplier-invoice.pdf'
            await xeroUploadAttachment('Invoices', billResult.invoiceId, filename, pdfBuffer, 'application/pdf')
          }
        } catch {
          // Attachment failure is non-critical — bill was already created
        }
      }
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
    }

    case 'CREDIT_NOTE':
      return pushCreditNote({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode)).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))

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
      return pushManualJournal({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, resolveJournalStatus(postingMode)).then(r => ({ success: r.success, externalId: r.journalId, error: r.error }))

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

      // Download Xero invoice PDF, save, email, and notify shopping channel
      try {
        const { downloadXeroInvoicePdf, saveInvoicePdf } = await import('./invoice-pdf')
        const pdfBuffer = await downloadXeroInvoicePdf(externalId)
        if (pdfBuffer) {
          const pdfPath = await saveInvoicePdf(referenceId, pdfBuffer)
          await db.salesOrder.update({
            where: { id: referenceId },
            data: { invoicePdfPath: pdfPath },
          })

          // Email the Xero invoice PDF to the customer
          const { sendAccountingInvoiceEmail } = await import('@/app/actions/email')
          await sendAccountingInvoiceEmail(referenceId).catch(() => {})

          // Notify shopping channel (WC pushes order note with download link)
          await notifyShoppingChannel(referenceId, 'invoice_ready')
        }
      } catch {
        // PDF download/email failure is non-critical
      }
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
    }
  } catch {
    // Non-critical — log entry already marked as SYNCED
  }
}

/**
 * Generic shopping channel notification hook.
 * Each connector registers its own handler. Xero never imports from WC directly.
 */
async function notifyShoppingChannel(orderId: string, event: string): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { wcOrderId: true },
  })

  // WooCommerce handler
  if (so?.wcOrderId && event === 'invoice_ready') {
    const { pushInvoiceNoteToWc } = await import('@/lib/connectors/woocommerce/sync/invoice-note')
    await pushInvoiceNoteToWc(orderId).catch(() => {})
  }

  // Future: Shopify handler would go here
}
