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
 * retry that finds it skips the note (and, with no marker, the order's notes are read first and a note already carrying this invoice's link is adopted, which covers a lost response); a retry that finds it skips the note and goes on to the meta (an absolute PUT, harmless to repeat). Before this marker a meta PUT that
 * failed or was held made the whole call fail, and the queue retried it by posting the note AGAIN.
 */

import { db } from '@/lib/db'
import { wcFetch, wcPost, wcPut } from '../api'
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
  let reconciledNoteId: string | null = null
  if (!noteAlreadyWritten) {
    // A LOST RESPONSE leaves no marker although the storefront may have kept the note. Before posting, read ALL of the order's notes and
    // look for one whose link is EXACTLY this invoice's. If one is there, adopt it as the marker instead of posting a second. If the notes
    // cannot be read to a verified end, post nothing: a blind post is how a duplicate is made, and an incomplete read is retried.
    // The link must be invoice-specific (contain this invoice's ledger id), or a template without {id} would make every invoice's note
    // look like every other's; with such a template nothing can be told apart, so nothing is posted.
    if (!accountingInvoiceUrl.includes(so.accountingInvoiceId!)) {
      return { success: false, error: 'The invoice URL template has no {id}, so this invoice\'s note cannot be told from another\'s and none was added. Fix the template.' }
    }
    const notes = await readAllOrderNotes(wcLink.externalOrderId)
    if (!notes.ok) {
      return { success: false, error: `Could not read all of the WooCommerce order's notes to check whether the invoice note is already there, so none was added: ${notes.error}` }
    }
    const found = notes.notes.find((n) => n.customer_note !== true && typeof n.note === 'string' && noteLinkTargets(n.note).includes(accountingInvoiceUrl))
    if (found && (typeof found.id === 'number' || typeof found.id === 'string')) {
      reconciledNoteId = String(found.id)
      await recordNoteWritten(orderId, so.accountingInvoiceId!, found.id)
    }
  }
  if (!noteAlreadyWritten && reconciledNoteId === null) {
    try {
      const noteResult = await wcPost(`/orders/${wcLink.externalOrderId}/notes`, {
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
    const metaResult = await wcPut(`/orders/${wcLink.externalOrderId}`, { meta_data: [{ key: '_accounting_invoice_url', value: accountingInvoiceUrl }] })
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

type OrderNote = { id?: unknown; note?: unknown; customer_note?: unknown }
const NOTES_PER_PAGE = 100
const NOTES_MAX_PAGES = 20

/** The exact link targets (href values, entity-decoded) of a note's HTML. Compared whole, never as a substring. */
export function noteLinkTargets(html: string): string[] {
  return [...html.matchAll(/href=(["'])(.*?)\1/gi)].map((m) => m[2]!.replace(/&amp;/g, '&').replace(/&#0?38;/g, '&'))
}

/** Every page of the order's notes, to a VERIFIED end: the store must state its page count, and every page up to it must read. Anything else is not ok. */
async function readAllOrderNotes(externalOrderId: string): Promise<{ ok: true; notes: OrderNote[] } | { ok: false; error: string }> {
  const notes: OrderNote[] = []
  let totalPages = 1
  for (let page = 1; page <= totalPages; page++) {
    if (page > NOTES_MAX_PAGES) return { ok: false, error: `more than ${NOTES_MAX_PAGES} pages of notes` }
    const result = await wcFetch(`/orders/${externalOrderId}/notes`, { per_page: String(NOTES_PER_PAGE), page: String(page) })
    if (result.error || !Array.isArray(result.data)) return { ok: false, error: result.error ?? 'unexpected answer' }
    if (typeof result.totalPages !== 'number' || result.totalPages < 0) return { ok: false, error: 'the store did not say how many pages of notes there are' }
    totalPages = Math.max(result.totalPages, 1)
    notes.push(...(result.data as OrderNote[]))
  }
  return { ok: true, notes }
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
