/**
 * Push invoice download link as a WooCommerce order note.
 * This is a shopping channel concern — Shopify would have its own equivalent.
 */

import { db } from '@/lib/db'
import { wcPost } from '../api'
import { getInvoiceDownloadUrl } from '@/lib/connectors/xero/invoice-pdf'
import { logActivity } from '@/lib/activity-log'

/**
 * Push an invoice download note to the WC order (customer-visible).
 * Also pushes a Xero invoice link as an admin-only note.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      wcOrderId: true,
      invoiceNumber: true,
      orderNumber: true,
      wcOrderNumber: true,
      xeroInvoiceId: true,
      invoicePdfPath: true,
    },
  })
  if (!so?.wcOrderId) return

  const ref = so.invoiceNumber ?? so.orderNumber ?? so.wcOrderNumber ?? orderId.slice(0, 8)

  // Customer-visible note with download link
  if (so.invoicePdfPath) {
    try {
      const downloadUrl = getInvoiceDownloadUrl(orderId)
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

  // Admin-only note with Xero link
  if (so.xeroInvoiceId) {
    try {
      const xeroUrl = `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${so.xeroInvoiceId}`
      await wcPost(`orders/${so.wcOrderId}/notes`, {
        note: `Xero invoice: <a href="${xeroUrl}">View in Xero</a>`,
        customer_note: false,
      })
    } catch {
      // Non-critical — admin note failure is not logged
    }
  }
}
