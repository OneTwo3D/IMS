/**
 * Push accounting invoice metadata to a WooCommerce order.
 * This is a shopping channel concern — Shopify would have its own equivalent.
 */

import { db } from '@/lib/db'
import { wcPost, wcPut } from '../api'
import { getAccountingSettings } from '@/lib/accounting'
import { logActivity } from '@/lib/activity-log'

/**
 * Push an accounting invoice link as an admin-only note and order meta.
 * IMS PDF links are session/IP-bound, so they are not written to storefront notes.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<{ success: boolean; error?: string }> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      invoiceNumber: true,
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
