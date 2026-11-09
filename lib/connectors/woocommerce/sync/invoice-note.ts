/**
 * Push the accounting invoice NOTE (and its link meta) to a WooCommerce order.
 * This is a shopping channel concern — a second storefront has its own equivalent.
 *
 * This writer is the `order.invoice-note` operation: an admin-only note naming the ledger invoice IMS itself posted, and the
 * `_accounting_invoice_url` meta. It no longer writes the customer download flag: that is the `order.invoice-document` operation, a
 * separate writer with its own switch and its own marker (invoice-document.ts).
 *
 * A note is APPENDED by the storefront, so a repeat adds a second one. The note is therefore written at most once per ledger invoice id:
 * the marker (`InvoiceStorePublication.noteInvoiceId` / `noteWrittenAt`) is saved as soon as the storefront has accepted the note, and a
 * retry that finds it skips the note and goes on to the meta (an absolute PUT, harmless to repeat). Before this marker a meta PUT that
 * failed or was held made the whole call fail, and the queue retried it by posting the note AGAIN.
 */

import { db } from '@/lib/db'
import { wcPost, wcPut } from '../api'
import { getAccountingSettings } from '@/lib/accounting'
import { logActivity } from '@/lib/activity-log'

/**
 * Push the invoice note and link meta for WooCommerce order screens.
 * Customer PDF downloads use the WooCommerce helper plugin as the customer authorization boundary, then the plugin calls IMS
 * server-to-server; the flag that shows the download button is written by publishInvoiceDocumentFlagToWc, not here.
 */
export async function pushInvoiceNoteToWc(orderId: string): Promise<{ success: boolean; error?: string }> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      orderNumber: true,
      externalOrderNumber: true,
      accountingInvoiceId: true,
      invoiceStorePublication: { select: { noteInvoiceId: true, noteWrittenAt: true } },
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
  if (!accountingInvoiceUrl) return { success: true }

  // Admin-only note with accounting invoice link, at most once per ledger invoice id.
  const marker = so.invoiceStorePublication
  const noteAlreadyWritten = !!marker?.noteWrittenAt && marker.noteInvoiceId === so.accountingInvoiceId
  if (!noteAlreadyWritten) {
    try {
      const noteResult = await wcPost(`orders/${wcLink.externalOrderId}/notes`, {
        note: `Accounting invoice: <a href="${accountingInvoiceUrl}">View Invoice</a>`,
        customer_note: false,
      })
      // Only a HELD write is turned into a failure here: it did not reach WooCommerce, and reporting
      // success would let the caller mark the notification done and lose it. (Other returned errors keep
      // their existing, non-critical handling.)
      if (noteResult.held) {
        failure = `Failed to add the invoice note to the WooCommerce order: ${noteResult.error}`
      } else if (!noteResult.error) {
        await recordNoteWritten(orderId, so.accountingInvoiceId!, (noteResult.data as { id?: unknown } | null)?.id)
      }
    } catch {
      // Non-critical — admin note failure is not logged
    }
  }

  // Link meta on the WC order for the order screen. Absolute, so a repeat is harmless.
  try {
    const metaResult = await wcPut(`orders/${wcLink.externalOrderId}`, { meta_data: [{ key: '_accounting_invoice_url', value: accountingInvoiceUrl }] })
    if (metaResult.held && !failure) failure = `Failed to store invoice metadata on WooCommerce order: ${metaResult.error}`
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_order_meta_failed', tag: 'sync', level: 'WARNING',
      description: `Failed to store invoice meta on WC order #${wcOrderLabel}: ${String(e)}`,
    })
    if (!failure) {
      failure = `Failed to store invoice metadata on WooCommerce order: ${String(e)}`
    }
  }

  if (failure) return { success: false, error: failure }
  return { success: true }
}

/**
 * Remember that the note for this ledger invoice id is on the storefront order. If the marker cannot be saved the note IS there, so this
 * logs and carries on: failing the call would make the queue retry and post a second note, the very defect the marker exists to stop.
 */
async function recordNoteWritten(orderId: string, accountingInvoiceId: string, storeNoteId: unknown): Promise<void> {
  const noteStoreId = typeof storeNoteId === 'number' || typeof storeNoteId === 'string' ? String(storeNoteId) : null
  const data = { noteInvoiceId: accountingInvoiceId, noteWrittenAt: new Date(), noteStoreId }
  try {
    await db.invoiceStorePublication.upsert({ where: { orderId }, create: { orderId, ...data }, update: data })
  } catch (error) {
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_note_marker_failed', tag: 'sync', level: 'WARNING',
      description: `The invoice note was written to the storefront order but IMS could not record that it did (${error instanceof Error ? error.message : String(error)}); a retry may add a second note.`,
      resolveUser: false,
    }).catch(() => {})
  }
}
