/**
 * Push accounting invoice metadata to a WooCommerce order.
 * This is a shopping channel concern — Shopify would have its own equivalent.
 */

import { db } from '@/lib/db'
import { wcPost, wcPut } from '../api'
import { getAccountingSettings } from '@/lib/accounting'
import { logActivity } from '@/lib/activity-log'
import { getPublicAppUrl } from '@/lib/public-app-url'

/**
 * Push invoice metadata for WooCommerce order screens.
 * Customer PDF downloads use the WooCommerce helper plugin as the customer
 * authorization boundary, then the plugin calls IMS server-to-server.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<{ success: boolean; error?: string }> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      invoiceNumber: true,
      invoicePdfPath: true,
      orderNumber: true,
      externalOrderNumber: true,
      accountingInvoiceId: true,
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

  const wcOrderLabel = wcLink.externalOrderNumber ?? so.externalOrderNumber ?? wcLink.externalOrderId
  let failure: string | null = null
  const publicAppUrl = await getPublicAppUrl()

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
  if (accountingInvoiceUrl) metaData.push({ key: '_accounting_invoice_url', value: accountingInvoiceUrl })
  if (so.invoicePdfPath) {
    if (publicAppUrl) {
      metaData.push(
        { key: '_ims_invoice_pdf_available', value: 'yes' },
        { key: '_ims_invoice_pdf_endpoint', value: `${publicAppUrl}/api/shopping/woocommerce/invoice-pdf` },
      )
    } else {
      const message = `Cannot expose customer invoice PDF for WC order #${wcOrderLabel}: public_app_url is not configured`
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'wc_invoice_pdf_customer_link_skipped',
        tag: 'sync',
        level: 'WARNING',
        description: message,
      })
      if (!failure) failure = message
    }
  }

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
