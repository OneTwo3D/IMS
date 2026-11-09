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
import { loadInvoiceDocumentFile, loadInvoicePdf } from '@/lib/invoice-pdf'

export async function loadCurrentInvoicePdf(orderId: string): Promise<Buffer | null> {
  const current = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null },
    select: { sha256: true },
    orderBy: { fetchedAt: 'desc' },
  })
  if (!current) return loadInvoicePdf(orderId)

  const bytes = await loadInvoiceDocumentFile(orderId, current.sha256)
  if (bytes && createHash('sha256').update(bytes).digest('hex') === current.sha256) return bytes

  // The current version's file is missing or does not match its hash. Serve nothing, and make the document due for a re-fetch.
  await db.invoiceDocumentFetchState.updateMany({
    where: { orderId, kind: 'INVOICE', refundId: null, status: { not: 'NEEDS_ATTENTION' } },
    data: { nextAttemptAt: new Date(0) },
  }).catch(() => { /* the integrity scan finds it too */ })
  return null
}
