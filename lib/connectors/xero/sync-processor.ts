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
const CLAIM_STALE_MS = 15 * 60 * 1000

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>

export async function processPendingXeroSync(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  const pending = await db.accountingSyncLog.findMany({
    where: {
      OR: [
        { status: 'PENDING' },
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
    const claim = await db.accountingSyncLog.updateMany({
      where: {
        id: entry.id,
        retryCount: { lt: MAX_RETRIES },
        OR: [
          { status: 'PENDING' },
          {
            status: 'PROCESSING',
            processingStartedAt: { lt: staleClaimCutoff },
          },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    })
    if (claim.count === 0) continue

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
            processingStartedAt: null,
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
            processingStartedAt: null,
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
          processingStartedAt: null,
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
        shippingTaxType: payload.shippingTaxType as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        discountTaxType: payload.discountTaxType as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
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

          if (!paymentMap || Object.keys(paymentMap).length === 0) {
            logActivity({
              entityType: 'SYSTEM',
              action: 'xero_payment_skipped',
              tag: 'sync',
              level: 'WARNING',
              description: `Skipped Xero payment registration: no payment account map configured. Go to Settings → Accounting → Payment Account Mapping to set up bank accounts for each payment method.`,
            })
          } else {
            const stored = lookupPaymentAccount(paymentMap, method, currency)

            if (!stored) {
              logActivity({
                entityType: 'SYSTEM',
                action: 'xero_payment_skipped',
                tag: 'sync',
                level: 'WARNING',
                description: `Skipped Xero payment registration: no bank account mapped for method "${method}" / currency "${currency}". Add a mapping in Settings → Accounting → Payment Account Mapping.`,
              })
            } else {
              // Resolve stored value to a XeroAccount — match either xeroId (new) or code (legacy).
              // Bank accounts in Xero may have NULL codes (e.g. Stripe feeds), so we always post
              // using AccountID, which is guaranteed unique.
              const account = await db.xeroAccount.findFirst({
                where: { OR: [{ xeroId: stored }, { code: stored }] },
                select: { xeroId: true },
              })
              if (!account) {
                logActivity({
                  entityType: 'SYSTEM',
                  action: 'xero_payment_skipped',
                  tag: 'sync',
                  level: 'WARNING',
                  description: `Skipped Xero payment registration: bank account "${stored}" not found in synced Xero chart of accounts. Re-sync accounts from Settings → Accounting → Xero.`,
                })
              } else {
                // Use Xero's computed invoice total (includes tax, discounts, rounding).
                // Fall back to manual calculation only if total is missing.
                let amount = invoiceResult.total
                if (amount == null) {
                  amount = (payload.lines as Array<{ quantity: number; unitAmount: number }>).reduce((s, l) => s + l.quantity * l.unitAmount, 0)
                    + ((payload.shippingAmount as number) || 0)
                    - ((payload.discountAmount as number) || 0)
                }

                if (amount > 0) {
                  const paymentDate = (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
                  await xeroPost('Payments', {
                    Invoice: { InvoiceID: invoiceResult.invoiceId },
                    Account: { AccountID: account.xeroId },
                    Date: paymentDate,
                    Amount: amount,
                  })
                }
              }
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
            // supplierInvoicePath is `/uploads/invoices/<filename>` — files live at
            // `{cwd}/uploads/invoices/<filename>` (not under `public/`).
            const relPath = (payload.supplierInvoicePath as string).replace(/^\/+/, '')
            const pdfPath = join(/* turbopackIgnore: true */ process.cwd(), relPath)
            const pdfBuffer = await readFile(pdfPath)
            const filename = relPath.split('/').pop() ?? 'supplier-invoice.pdf'
            const uploadRes = await xeroUploadAttachment('Invoices', billResult.invoiceId, filename, pdfBuffer, 'application/pdf')
            if (!uploadRes.ok) {
              logActivity({
                entityType: 'SYSTEM',
                action: 'xero_attachment_failed',
                tag: 'sync',
                level: 'WARNING',
                description: `Failed to attach supplier invoice PDF to Xero bill ${billResult.invoiceId}: ${uploadRes.error ?? 'unknown error'}`,
              })
            }
          }
        } catch (e) {
          // Attachment failure is non-critical — bill was already created
          logActivity({
            entityType: 'SYSTEM',
            action: 'xero_attachment_failed',
            tag: 'sync',
            level: 'WARNING',
            description: `Failed to attach supplier invoice PDF to Xero bill ${billResult.invoiceId}: ${String(e)}`,
          })
        }
      }
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
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
      const account = await db.xeroAccount.findFirst({
        where: { OR: [{ xeroId: bankAccountId }, { code: bankAccountId }] },
        select: { xeroId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      try {
        const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
          Invoice: { InvoiceID: accountingInvoiceId },
          Account: { AccountID: account.xeroId },
          Date: paymentDate,
          Amount: amount,
          Reference: (payload.reference as string | undefined) ?? undefined,
        })
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
        }
        const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
        return { success: true, externalId: paymentId }
      } catch (e) {
        return { success: false, error: String(e) }
      }
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

          // Email the Xero invoice PDF to the customer (internal call, no auth needed)
          const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
          await sendAccountingInvoiceEmailInternal(referenceId).catch(() => {})

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
