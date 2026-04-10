/**
 * Push invoice download link as a WooCommerce order note.
 * This is a shopping channel concern — Shopify would have its own equivalent.
 */

import { db } from '@/lib/db'
import { wcPost, wcPut } from '../api'
import { getInvoiceDownloadUrl } from '@/lib/invoice-pdf'
import { getAccountingSettings } from '@/lib/accounting'
import { logActivity } from '@/lib/activity-log'

/**
 * Push an invoice download note to the WC order (customer-visible).
 * Also pushes an accounting invoice link as an admin-only note.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      wcOrderId: true,
      invoiceNumber: true,
      orderNumber: true,
      wcOrderNumber: true,
      accountingInvoiceId: true,
      invoicePdfPath: true,
    },
  })
  if (!so?.wcOrderId) return

  const ref = so.invoiceNumber ?? so.orderNumber ?? so.wcOrderNumber ?? orderId.slice(0, 8)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')

  // Build absolute download URL
  const downloadUrl = so.invoicePdfPath ? `${appUrl}${getInvoiceDownloadUrl(orderId)}` : null

  // Build accounting invoice URL
  let accountingInvoiceUrl: string | null = null
  if (so.accountingInvoiceId) {
    try {
      const settings = await getAccountingSettings()
      accountingInvoiceUrl = settings.invoiceUrlTemplate.replace('{id}', so.accountingInvoiceId)
    } catch {
      // Non-critical
    }
  }

  // Customer-visible note with download link
  if (downloadUrl) {
    try {
      await wcPost(`orders/${so.wcOrderId}/notes`, {
        note: `Your invoice ${ref} is ready. <a href="${downloadUrl}">Download Invoice PDF</a>`,
        customer_note: true,
      })
    } catch (e) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_invoice_note_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to push invoice note to WC order #${so.wcOrderId}: ${String(e)}`,
      })
    }
  }

  // Admin-only note with accounting invoice link
  if (accountingInvoiceUrl) {
    try {
      await wcPost(`orders/${so.wcOrderId}/notes`, {
        note: `Accounting invoice: <a href="${accountingInvoiceUrl}">View Invoice</a>`,
        customer_note: false,
      })
    } catch {
      // Non-critical — admin note failure is not logged
    }
  }

  // Store meta on WC order for button rendering by mu-plugin
  const metaData: { key: string; value: string }[] = []
  if (downloadUrl) metaData.push({ key: '_invoice_pdf_url', value: downloadUrl })
  if (accountingInvoiceUrl) metaData.push({ key: '_accounting_invoice_url', value: accountingInvoiceUrl })

  if (metaData.length > 0) {
    try {
      await wcPut(`orders/${so.wcOrderId}`, { meta_data: metaData })
    } catch (e) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_order_meta_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to store invoice meta on WC order #${so.wcOrderId}: ${String(e)}`,
      })
    }
  }
}
