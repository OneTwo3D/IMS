/**
 * Push invoice download link as a WooCommerce order note.
 * This is a shopping channel concern — Shopify would have its own equivalent.
 */

import { db } from '@/lib/db'
import { wcPost, wcPut } from '../api'
import { getAccountingSettings } from '@/lib/accounting'
import { logActivity } from '@/lib/activity-log'

/**
 * Push an invoice download note to the WC order (customer-visible).
 * Also pushes an accounting invoice link as an admin-only note.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<{ success: boolean; error?: string }> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      invoiceNumber: true,
      orderNumber: true,
      externalOrderNumber: true,
      accountingInvoiceId: true,
      invoicePdfPath: true,
      shoppingLinks: {
        where: { connector: 'woocommerce' },
        select: { externalOrderId: true, externalOrderNumber: true },
        take: 1,
      },
    },
  })
  if (!so) return { success: true }
  const wcLink = so.shoppingLinks[0]
  if (!wcLink?.externalOrderId) return { success: true }

  const ref = so.invoiceNumber ?? so.orderNumber ?? so.externalOrderNumber ?? orderId.slice(0, 8)
  const wcOrderLabel = wcLink.externalOrderNumber ?? so.externalOrderNumber ?? wcLink.externalOrderId
  let failure: string | null = null

  // Public invoice PDF URLs are intentionally not generated here: signed PDF
  // tokens are bound to the authenticated request session and client IP.
  const downloadUrl: string | null = null

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
      await wcPost(`orders/${wcLink.externalOrderId}/notes`, {
        note: `Your invoice ${ref} is ready. <a href="${downloadUrl}">Download Invoice PDF</a>`,
        customer_note: true,
      })
    } catch (e) {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_invoice_note_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to push invoice note to WC order #${wcOrderLabel}: ${String(e)}`,
      })
      failure = `Failed to push customer invoice note to WooCommerce: ${String(e)}`
    }
  }

  // Admin-only note with accounting invoice link
  if (accountingInvoiceUrl) {
    try {
      await wcPost(`orders/${wcLink.externalOrderId}/notes`, {
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
      await wcPut(`orders/${wcLink.externalOrderId}`, { meta_data: metaData })
    } catch (e) {
      await logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_order_meta_failed', tag: 'sync', level: 'WARNING',
        description: `Failed to store invoice meta on WC order #${wcOrderLabel}: ${String(e)}`,
      })
      if (!failure) {
        failure = `Failed to store invoice metadata on WooCommerce order: ${String(e)}`
      }
    }
  }

  if (failure) return { success: false, error: failure }
  return { success: true }
}
