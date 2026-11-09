/**
 * The ONE way a customer-facing invoice PDF is read: resolve the order's CURRENT document row and stream its immutable, hash-named
 * file. The database decides which version is current (promotion is a single fenced transaction), and the file for a version never
 * changes, so there is no moment at which an older fetch's bytes can be served over a newer one.
 *
 * Integrity: the bytes are hashed on the way out and must equal the row's SHA-256; a missing or altered file is NOT served, and the
 * document is marked due for a re-fetch (the sweep's recheck picks it up and rewrites the file).
 *
 * An order with no document row falls back to the legacy flat file written by the accounting connector's own PDF step (an invoice IMS
 * posted itself). Once a document row exists, the flat file is never read for that order.
 */

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { xeroInvoiceNumberIdentity } from '@/lib/domain/accounting/invoice-number-ownership'
import { loadInvoiceDocumentFile, loadInvoicePdf } from '@/lib/invoice-pdf'

async function markDue(orderId: string): Promise<void> {
  await db.invoiceDocumentFetchState.updateMany({
    where: { orderId, kind: 'INVOICE', refundId: null, status: { not: 'NEEDS_ATTENTION' } },
    data: { nextAttemptAt: new Date(0) },
  }).catch(() => { /* the integrity scan finds it too */ })
}

/** Is the order's current invoice document one the ledger has withdrawn (voided on a live order)? For the staff label. */
export async function currentInvoiceIsWithdrawn(orderId: string): Promise<boolean> {
  const current = await db.salesOrderInvoiceDocument.findFirst({ where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null }, select: { withdrawnAt: true }, orderBy: { fetchedAt: 'desc' } })
  return current?.withdrawnAt != null
}

/**
 * `includeWithdrawn` is for the staff routes only: a document the ledger voided on a live order is kept, and staff can still open it
 * (labelled); no customer-facing reader asks for it.
 */
export async function loadCurrentInvoicePdf(orderId: string, options: { includeWithdrawn?: boolean } = {}): Promise<Buffer | null> {
  const current = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null },
    select: { sha256: true, documentNumber: true, withdrawnAt: true, order: { select: { invoiceNumber: true } } },
    orderBy: { fetchedAt: 'desc' },
  })
  if (!current) return loadInvoicePdf(orderId)

  // WITHDRAWN: the ledger voided it on an order that is still live. Kept, never served to the customer.
  if (current.withdrawnAt && !options.includeWithdrawn) return null
  // THE NUMBER MUST STILL BE THE ORDER'S: the importer can correct an order's invoice number, and a document fetched under the old one is
  // not this order's invoice any more. Not served, and made due so the sweep fetches the one under the corrected number.
  if (xeroInvoiceNumberIdentity(current.order.invoiceNumber ?? '') !== xeroInvoiceNumberIdentity(current.documentNumber)) {
    await markDue(orderId)
    return null
  }

  const bytes = await loadInvoiceDocumentFile(orderId, current.sha256)
  if (bytes && createHash('sha256').update(bytes).digest('hex') === current.sha256) return bytes

  // The current version's file is missing or does not match its hash. Serve nothing, and make the document due for a re-fetch.
  await markDue(orderId)
  return null
}
