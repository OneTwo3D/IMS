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
import { xeroUploadAttachment } from './api'
import type { XeroSyncType } from '@/app/generated/prisma/client'

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

  const pending = await db.xeroSyncLog.findMany({
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
        await db.xeroSyncLog.update({
          where: { id: entry.id },
          data: {
            status: 'SYNCED',
            xeroTransactionId: syncResult.externalId ?? null,
            syncedAt: new Date(),
            errorMessage: null,
          },
        })

        // Update back-references (e.g. xeroInvoiceId on SalesOrder)
        await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId)

        result.succeeded++
      } else {
        const retryCount = entry.retryCount + 1
        await db.xeroSyncLog.update({
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
      await db.xeroSyncLog.update({
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
  const skippedCount = await db.xeroSyncLog.count({
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

async function processEntry(
  type: XeroSyncType,
  payload: SyncPayload,
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  switch (type) {
    case 'SALES_INVOICE':
      return pushSalesInvoice({
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
      }).then(r => ({ success: r.success, externalId: r.invoiceId, error: r.error }))

    case 'PURCHASE_INVOICE': {
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      })
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
      }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))

    case 'COGS_JOURNAL':
    case 'INVENTORY_ADJUSTMENT':
    case 'STOCK_IN_TRANSIT':
    case 'STOCK_RECEIPT':
    case 'COGS_REVERSAL':
      return pushManualJournal({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }).then(r => ({ success: r.success, externalId: r.journalId, error: r.error }))

    default:
      return { success: false, error: `Unknown sync type: ${type}` }
  }
}

async function updateBackReference(
  type: XeroSyncType,
  referenceType: string,
  referenceId: string,
  externalId?: string,
): Promise<void> {
  if (!externalId) return

  try {
    if (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') {
      await db.salesOrder.update({
        where: { id: referenceId },
        data: { xeroInvoiceId: externalId },
      })
    } else if (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') {
      await db.salesOrderRefund.update({
        where: { id: referenceId },
        data: { xeroCreditNoteId: externalId },
      })
    } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseInvoice') {
      await db.purchaseInvoice.update({
        where: { id: referenceId },
        data: { xeroInvoiceId: externalId },
      })
    }
  } catch {
    // Non-critical — log entry already marked as SYNCED
  }
}
