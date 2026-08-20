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
