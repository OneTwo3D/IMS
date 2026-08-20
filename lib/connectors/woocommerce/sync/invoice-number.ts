/**
 * Where a WooCommerce order's ACCOUNTING invoice number comes from (o3d-k26m.1).
 *
 * The number is NOT ours to mint. WooCommerce PDF Invoices & Packing Slips assigns it and
 * stores it on the order as `_wcpdf_invoice_number`; that is the number printed on the PDF the
 * customer already holds, and it is the number the outgoing xeroom plugin has pushed to Xero
 * for 14,415 orders since 2021-07-04 (xeroom_invoice_no_active=meta,
 * xeroom_inv_number_meta_key=_wcpdf_invoice_number). If IMS numbers differently at cutover the
 * sequence in Xero breaks against those documents, finance loses "match the Xero invoice to the
 * Woo order by number", and — the part that bites hardest — an accidental double-post stops
 * being detectable, because two documents that disagree on their number do not look like two
 * copies of one invoice.
 *
 * THE VALUE IS USED VERBATIM. No prefix is prepended, deliberately: a prefixed number would
 * disagree with the customer's own PDF and with every historical xeroom document, which is the
 * whole failure this resolves. `woocommerce_inv_prefix` therefore does not participate in the
 * accounting invoice number any more — see docs/connectors/xero.md.
 *
 * WHEN THE META IS ABSENT THIS RETURNS A REFUSAL, and callers must not substitute anything.
 * The meta appears when the PDF plugin first initialises the invoice document, which for this
 * shop happens around the same status transition that IMS imports on — so "not yet numbered" is
 * a real, ordinary state, not a corruption. Inventing a number for it is the exact defect this
 * module exists to prevent: the sales-invoice create is an upsert on InvoiceNumber, so a
 * document posted under an invented number cannot later be corrected to the real one — a second
 * post under the real number creates a SECOND invoice instead of replacing the first.
 */

import type { WcFullOrder, WcMeta } from './types'

/** The meta key WooCommerce PDF Invoices & Packing Slips writes, and the one xeroom reads. */
export const WC_PDF_INVOICE_NUMBER_META_KEY = '_wcpdf_invoice_number'

export type WcInvoiceNumberResolution =
  | { ok: true; invoiceNumber: string; metaKey: string }
  | { ok: false; metaKey: string; reason: string }

function orderLabel(order: Pick<WcFullOrder, 'number' | 'id'>): string {
  const number = typeof order.number === 'string' && order.number.trim() ? order.number.trim() : null
  return number ?? String(order.id)
}

/**
 * Read the PDF-plugin invoice number off a WooCommerce order.
 *
 * Accepts a string or a number, because WooCommerce's REST serialisation of order meta is not
 * consistent about which it hands back for a numeric invoice number. Anything else — an object,
 * an array, a boolean, a blank string, or a zero — is NOT a document number and is refused
 * rather than coerced.
 */
export function resolveWcAccountingInvoiceNumber(
  order: WcFullOrder,
  options?: { metaKey?: string },
): WcInvoiceNumberResolution {
  const metaKey = options?.metaKey?.trim() || WC_PDF_INVOICE_NUMBER_META_KEY
  const label = orderLabel(order)

  const meta: WcMeta | undefined = (order.meta_data ?? []).find((m) => m?.key === metaKey)
  if (!meta || meta.value == null) {
    return {
      ok: false,
      metaKey,
      reason: `WooCommerce order ${label} carries no ${metaKey}; the invoice number is assigned by WooCommerce PDF Invoices and IMS will not invent one.`,
    }
  }

  const raw = meta.value
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      return {
        ok: false,
        metaKey,
        reason: `WooCommerce order ${label} has ${metaKey}=${String(raw)}, which is not a usable invoice number.`,
      }
    }
    return { ok: true, invoiceNumber: String(raw), metaKey }
  }

  if (typeof raw !== 'string') {
    return {
      ok: false,
      metaKey,
      reason: `WooCommerce order ${label} has a non-scalar ${metaKey} (${typeof raw}); refusing to derive an invoice number from it.`,
    }
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      ok: false,
      metaKey,
      reason: `WooCommerce order ${label} has a blank ${metaKey}; the PDF plugin has not numbered this invoice yet.`,
    }
  }
  if (/^0+$/.test(trimmed)) {
    return {
      ok: false,
      metaKey,
      reason: `WooCommerce order ${label} has ${metaKey}=${trimmed}, which is not a usable invoice number.`,
    }
  }

  return { ok: true, invoiceNumber: trimmed, metaKey }
}

/**
 * WHEN A CAPTURED NUMBER MAY STILL BE CORRECTED, AND WHEN IT MUST NOT (o3d-k26m.7).
 *
 * The capture is a backfill: an order can legitimately be imported before WooCommerce PDF Invoices
 * has numbered its invoice, and a later redelivery is the earliest moment IMS can learn the number.
 * That backfill was guarded on `invoiceNumber: null`, which correctly protects a number a posted
 * ledger document already carries — and, in doing so, also froze a number captured BEFORE anything
 * had posted. A storefront correction (the shop renumbers, the plugin's sequence is reset, an
 * invoice is deleted and recreated) could then never reach IMS: every later payload carried the
 * right number and every one of them was ignored, and the order would eventually post under the
 * stale one.
 *
 * The null guard was standing in for the question it could not ask. The real question is not "have
 * we stored a number?" but "HAS ANYTHING BEEN COMMITTED UNDER IT?", and there are exactly two ways
 * something has:
 *
 *   • the order carries an accounting document id — a ledger invoice exists under the stored
 *     number, and the create is update-or-create on that number, so posting the corrected one
 *     creates a SECOND document instead of renaming the first;
 *   • a sales-invoice sync row exists for the order — the number is already inside a queued,
 *     in-flight or completed payload. Correcting the column would not correct that payload, so the
 *     two would disagree about which document the order is, and a PENDING row would post the stale
 *     number anyway. A FAILED row counts too: a failure is not proof that nothing reached the
 *     ledger (a lost response looks exactly like one).
 *
 * With neither, nothing anywhere has committed to the stored number and it is only a note about
 * what WooCommerce said last. Then, and only then, a different number replaces it.
 *
 * A REFUSAL IS REPORTED, NOT SWALLOWED. An order whose storefront number has moved after posting is
 * a real divergence between the customer's PDF and the ledger; it needs a human, and the previous
 * behaviour — drop the payload silently — is why it could go unnoticed indefinitely.
 */
export type StoredInvoiceNumberUpdate =
  /** Nothing stored, nothing committed: record it. The ordinary backfill. */
  | { action: 'capture'; to: string }
  /** Already stored, and identical. */
  | { action: 'unchanged'; stored: string }
  /** Stored, different, and nothing has committed to the stored one. Replace it. */
  | { action: 'correct'; from: string; to: string }
  /** Nothing stored, but a document or a queued post already exists. Write nothing. */
  | { action: 'refuse-capture'; to: string; reason: string }
  /** Stored, different, and something HAS committed to the stored one. Keep it, and say so. */
  | { action: 'refuse-correction'; from: string; to: string; reason: string }

/**
 * WHAT COUNTS AS "SOMETHING HAS COMMITTED TO THIS ORDER'S NUMBER".
 *
 * Two facts, and the same two whether the column is empty or not — which is the point. An empty
 * column is not evidence that nothing has posted; it is the state of every WooCommerce order
 * invoiced BEFORE o3d-k26m.1, because the importer did not persist a number at all back then and
 * the back-reference only fills it in from the posting response. Writing WooCommerce's number into
 * such an order looks like an innocent backfill and is not: the order's ledger document is numbered
 * `INWC-164981`, the column would now say `164981`, and the next SALES_INVOICE_UPDATE — which posts
 * to the document by id but sends the number from the order — would try to RENUMBER a live invoice
 * onto the number xeroom is using. Xero requires ACCREC numbers to be unique, so that either
 * collides or is rejected; both are changes to documents that already exist.
 */
function commitmentToExistingNumber(params: {
  accountingInvoiceId: string | null | undefined
  salesInvoiceSyncRowCount: number
  storedInvoiceNumber: string | null
}): string | null {
  const accountingInvoiceId = params.accountingInvoiceId?.trim() || null
  const under = params.storedInvoiceNumber ? ` under ${params.storedInvoiceNumber}` : ''
  if (accountingInvoiceId) {
    return (
      `a ledger document (${accountingInvoiceId}) is already posted for this order${under}. The sales-invoice `
      + 'create is update-or-create on the invoice number, and the update sends the order\'s number against that '
      + 'document — so taking a different number now would either add a SECOND document or renumber a live one. '
      + 'Reconcile the two by hand.'
    )
  }
  if (params.salesInvoiceSyncRowCount > 0) {
    return (
      `a sales-invoice sync for this order is already queued${under}, carrying its own number in its payload. `
      + 'Changing the order\'s number now would not change that payload, and a failed or in-flight post is not '
      + 'proof that nothing reached the ledger. Cancel that sync row first if the invoice genuinely never posted.'
    )
  }
  return null
}

export function decideStoredInvoiceNumberUpdate(params: {
  /** SalesOrder.invoiceNumber as it stands. */
  storedInvoiceNumber: string | null | undefined
  /** The number the incoming WooCommerce payload carries. */
  incomingInvoiceNumber: string
  /** SalesOrder.accountingInvoiceId — non-null means a ledger document exists for this order. */
  accountingInvoiceId: string | null | undefined
  /** How many SALES_INVOICE / SALES_INVOICE_UPDATE sync rows exist for this order, non-CANCELLED. */
  salesInvoiceSyncRowCount: number
}): StoredInvoiceNumberUpdate {
  const incoming = params.incomingInvoiceNumber.trim()
  const stored = params.storedInvoiceNumber?.trim() || null

  if (stored && stored === incoming) return { action: 'unchanged', stored }

  const committed = commitmentToExistingNumber({
    accountingInvoiceId: params.accountingInvoiceId,
    salesInvoiceSyncRowCount: params.salesInvoiceSyncRowCount,
    storedInvoiceNumber: stored,
  })

  if (!stored) {
    if (committed) return { action: 'refuse-capture', to: incoming, reason: committed }
    return { action: 'capture', to: incoming }
  }
  if (committed) return { action: 'refuse-correction', from: stored, to: incoming, reason: committed }
  return { action: 'correct', from: stored, to: incoming }
}
