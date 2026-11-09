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
import { otherOrdersHoldingInvoiceNumber } from './number-uniqueness'
import { ORDER_EVIDENCE_SELECT, orderEvidenceFingerprint } from './order-fingerprint'
import { loadInvoiceDocumentFile, loadInvoicePdf } from '@/lib/invoice-pdf'

async function markDue(orderId: string): Promise<void> {
  await db.invoiceDocumentFetchState.updateMany({
    where: { orderId, kind: 'INVOICE', refundId: null, status: { not: 'NEEDS_ATTENTION' } },
    data: { nextAttemptAt: new Date(0) },
  }).catch(() => { /* the integrity scan finds it too */ })
}

export type InvoiceUnavailableReason = 'withdrawn' | 'number-shared' | 'order-changed'

/**
 * Why the order's current invoice document is NOT shown to the customer although IMS holds it, or null when it is available: the ledger
 * withdrew it (voided on a live order, or an ownership conflict), or another order now carries the same invoice number. For the staff label.
 */
export async function currentInvoiceUnavailableReason(orderId: string): Promise<InvoiceUnavailableReason | null> {
  const current = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null },
    select: { withdrawnAt: true, documentNumber: true, evidenceKey: true, order: { select: ORDER_EVIDENCE_SELECT } },
    orderBy: { fetchedAt: 'desc' },
  })
  if (!current) return null
  if (current.withdrawnAt) return 'withdrawn'
  if (current.evidenceKey && current.evidenceKey !== orderEvidenceFingerprint(current.order, null)) return 'order-changed'
  return (await otherOrdersHoldingInvoiceNumber(db, orderId, current.documentNumber)) > 0 ? 'number-shared' : null
}

/** Kept for the staff routes' label: true when the document is held back from the customer for either reason. */
export async function currentInvoiceIsWithdrawn(orderId: string): Promise<boolean> {
  return (await currentInvoiceUnavailableReason(orderId)) !== null
}

async function flagNumberCollision(orderId: string): Promise<void> {
  await db.invoiceDocumentFetchState.updateMany({
    where: { orderId, kind: 'INVOICE', refundId: null, status: { not: 'NEEDS_ATTENTION' } },
    data: { status: 'NEEDS_ATTENTION', lastError: 'another IMS order carries this invoice number, so the stored document can no longer be tied to this order' },
  }).catch(() => { /* the next read flags it again */ })
}

/**
 * `includeWithdrawn` is for the staff routes only: a document the ledger voided on a live order is kept, and staff can still open it
 * (labelled); no customer-facing reader asks for it.
 */
export async function loadCurrentInvoicePdf(orderId: string, options: { includeWithdrawn?: boolean } = {}): Promise<Buffer | null> {
  const current = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null },
    select: { sha256: true, documentNumber: true, withdrawnAt: true, evidenceKey: true, order: { select: ORDER_EVIDENCE_SELECT } },
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

  // THE ORDER MUST STILL BE WHAT THE DOCUMENT WAS JUDGED AGAINST: customer, currency, gross total (incl. store credit), cancelled or not and
  // the order numbers. A change after storage means the document may no longer be this order's; it is not served to the customer, the
  // document is made due for a re-fetch (which re-judges it and refreshes the fingerprint), and staff can still open it.
  // A row with no fingerprint predates the column and cannot be checked.
  if (current.evidenceKey && current.evidenceKey !== orderEvidenceFingerprint(current.order, null)) {
    await markDue(orderId)
    if (!options.includeWithdrawn) return null
  }

  // NOR MAY ANOTHER ORDER HOLD THAT NUMBER NOW: the storefront's number is not unique in IMS, so a collision arriving after the document was
  // stored means it can no longer be tied to this order. Refused for the customer (staff can still open it, labelled) and flagged for a person.
  if ((await otherOrdersHoldingInvoiceNumber(db, orderId, current.documentNumber)) > 0) {
    await flagNumberCollision(orderId)
    if (!options.includeWithdrawn) return null
  }

  const bytes = await loadInvoiceDocumentFile(orderId, current.sha256)
  if (bytes && createHash('sha256').update(bytes).digest('hex') === current.sha256) return bytes

  // The current version's file is missing or does not match its hash. Serve nothing, and make the document due for a re-fetch.
  await markDue(orderId)
  return null
}
