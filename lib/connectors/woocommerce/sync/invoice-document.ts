/**
 * The `order.invoice-document` WRITER: tell the storefront that this order has a customer invoice to download.
 *
 * The invoice bytes never go to the storefront. They are kept by IMS (lib/domain/invoice-documents) and the customer's My Account
 * download button asks IMS for them through the helper plugin. This writer only sets the order meta that makes the helper plugin show the
 * button: `_ims_invoice_pdf_available` = `yes` (absolute, so a repeat changes nothing).
 *
 * OFF BY DEFAULT. Nothing is written unless the setting `wc_invoice_document_enabled` is `true`. The write also meets every existing
 * WooCommerce gate: the producer-side hold (wcPut's egress barrier, and the claim boundary of the drain), the writer-side cut-off, and the
 * attempt fence of the outbox job that drives it; called outside that fence it refuses to write.
 *
 * WHAT IT WRITES ONLY WHEN IT IS TRUE. The flag is written only if the customer could actually be served the document: the same reader
 * the customer download route uses (`loadCurrentInvoicePdf`) must return the bytes. A withdrawn, voided-on-a-live-order, order-changed,
 * number-shared or missing/altered document answers `no-servable-document` and nothing is written.
 *
 * THE MARKER. After the storefront accepts the write, `InvoiceStorePublication.flagDocumentId` / `flagWrittenAt` record it. A repeat for
 * the same document is `already-published` and sends nothing.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getSettingValue } from '@/lib/settings-store'
import { loadCurrentInvoicePdf } from '@/lib/domain/invoice-documents/current-document'
import { wcPut } from '../api'
import { assertWcAttemptMayWrite, isInsideWcAttemptFence } from '../attempt-fence'

export const WC_INVOICE_DOCUMENT_ENABLED_SETTING = 'wc_invoice_document_enabled'
export const WC_INVOICE_DOCUMENT_META_KEY = '_ims_invoice_pdf_available'
/** The marker value for an invoice IMS posted itself: it has no document row, only the flat file. */
export const LEGACY_FLAG_DOCUMENT_ID = 'legacy'

/** Is the invoice-document writer switched on? Only an explicit `true`; unset, empty or anything else is OFF. */
export async function isInvoiceDocumentPublishingEnabled(): Promise<boolean> {
  return (await getSettingValue(WC_INVOICE_DOCUMENT_ENABLED_SETTING)) === 'true'
}

export type PublishInvoiceDocumentFlagOutcome =
  | { kind: 'written'; documentId: string }
  | { kind: 'already-published'; documentId: string }
  /** The writer is switched off (or the storefront connector has no link for this order). Nothing was sent. */
  | { kind: 'disabled' }
  | { kind: 'not-applicable' }
  /** IMS holds no document it would serve to the customer right now. Nothing was sent. */
  | { kind: 'no-servable-document' }
  /** Nothing reached the storefront, or it did not accept the write. The caller retries. */
  | { kind: 'failed'; error: string; held: boolean }

/** The id of the order's current document, or the legacy marker when only the flat file of an IMS-posted invoice exists. */
async function currentFlagDocumentId(orderId: string): Promise<string> {
  const current = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null },
    orderBy: { fetchedAt: 'desc' },
    select: { id: true },
  })
  return current?.id ?? LEGACY_FLAG_DOCUMENT_ID
}

export async function publishInvoiceDocumentFlagToWc(orderId: string): Promise<PublishInvoiceDocumentFlagOutcome> {
  if (!(await isInvoiceDocumentPublishingEnabled())) return { kind: 'disabled' }

  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      invoiceStorePublication: { select: { flagDocumentId: true, flagWrittenAt: true } },
      shoppingLinks: { where: { connector: 'woocommerce' }, select: { externalOrderId: true }, take: 1 },
    },
  })
  const externalOrderId = order?.shoppingLinks[0]?.externalOrderId
  if (!order || !externalOrderId) return { kind: 'not-applicable' }

  // Only what the customer could actually be served.
  if ((await loadCurrentInvoicePdf(orderId)) === null) return { kind: 'no-servable-document' }

  const documentId = await currentFlagDocumentId(orderId)
  const marker = order.invoiceStorePublication
  if (marker?.flagWrittenAt && marker.flagDocumentId === documentId) return { kind: 'already-published', documentId }

  // NEVER OUTSIDE A GUARDED ATTEMPT: the cut-off, claim ownership and deadline are checked only inside the outbox job's fence, so a direct
  // call (a follow-up, a script) must not write.
  if (!isInsideWcAttemptFence()) return { kind: 'failed', held: false, error: 'The invoice flag is written only by its guarded outbox job, never directly.' }
  // The attempt fence: deadline, row ownership, cut-off: deadline, row ownership, cut-off, and that IMS still wants the write.
  await assertWcAttemptMayWrite()
  const result = await wcPut(`orders/${externalOrderId}`, { meta_data: [{ key: WC_INVOICE_DOCUMENT_META_KEY, value: 'yes' }] })
  if (result.held) return { kind: 'failed', held: true, error: `The invoice flag was not written to the WooCommerce order: ${result.error}` }
  if (result.error) return { kind: 'failed', held: false, error: `The invoice flag was not accepted by the WooCommerce order: ${result.error}` }

  const data = { flagDocumentId: documentId, flagWrittenAt: new Date() }
  try {
    await db.invoiceStorePublication.upsert({ where: { orderId }, create: { orderId, ...data }, update: data })
  } catch (error) {
    // The flag IS on the storefront. A repeat is harmless (absolute PUT), so log and report it as written.
    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_document_marker_failed', tag: 'sync', level: 'WARNING',
      description: `The invoice download flag was written to the storefront order but IMS could not record that it did (${error instanceof Error ? error.message : String(error)}); it will be written again, which changes nothing.`,
      resolveUser: false,
    }).catch(() => {})
  }
  return { kind: 'written', documentId }
}
