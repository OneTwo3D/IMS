/**
 * AN ORDER THAT CARRIES STORE CREDIT DOES NOT GET A SALES INVOICE POSTED YET.
 *
 * Store credit is a PAYMENT. The importer therefore keeps it out of the discount (so the invoice states
 * the FULL goods value) and records it on `SalesOrder.storeCreditForeign`. Posting that invoice then
 * needs a second half that does not exist in IMS yet: the credit has to be applied to the invoice as a
 * payment against the right liability account (813 Customer Credits for credit IMS's owner issued,
 * 816 Gift Card Sales for a gift card someone paid for, chosen from Smart Coupons' order linkage), and
 * the customer's own payment must be registered for `order total` rather than the invoice total. Without
 * it the document would be larger than the order total and a payment for the order total would
 * PART-settle it for ever.
 *
 * Until that is built, FAIL CLOSED: the poster refuses a sales invoice (create or update) for any order
 * with store credit, before any request is built, so nothing is sent. The refusal is an ordinary sync
 * failure, so the row is visible on /sync with the reason on it.
 *
 * ONE SOURCE FOR THE WORDS. The poster's error, the import's ERROR activity entry and the operator docs
 * all use `storeCreditInvoiceRefusalReason`, so the text cannot drift between them.
 */

import { toDecimal } from '@/lib/domain/math/decimal'

/** ActivityLog action written by the importer when it queues the invoice for a store-credit order. */
export const STORE_CREDIT_INVOICE_WITHHELD_ACTION = 'wc_store_credit_invoice_withheld'

/**
 * Is there store credit on this order? Fails CLOSED on a value that is not a number: an unreadable
 * amount is not "no credit". Absent / null counts as none (the column is NOT NULL DEFAULT 0, so that
 * only happens for a row shape that predates it).
 */
export function orderCarriesStoreCredit(storeCreditForeign: unknown): boolean {
  if (storeCreditForeign === null || storeCreditForeign === undefined) return false
  try {
    const amount = toDecimal(storeCreditForeign as string | number)
    return !amount.isFinite() || amount.gt(0)
  } catch {
    return true
  }
}

/**
 * The reason a store-credit order's sales invoice is withheld. Describes the WITHHOLDING and why, never
 * a ledger fact: whether anything was sent is stated by the caller, who knows its stage.
 */
export function storeCreditInvoiceRefusalReason(): string {
  return 'This order was paid in part with store credit. IMS records store credit as a PAYMENT, not a discount, '
    + 'so the sales invoice would be stated at the full goods value and the credit would have to be applied to '
    + 'it as a payment against the store-credit liability account (813 or 816). That posting is not built yet, '
    + 'so IMS does not post a sales invoice, or register a payment, for an order that carries store credit. '
    + 'If this order must be invoiced now, first check the ledger for an invoice already raised for it, then '
    + 'raise it by hand with the credit applied as a payment.'
}

/** The poster's error: the refusal happens before any request is built, so "nothing was sent" is true. */
export function storeCreditInvoicePosterError(): string {
  return `NOTHING WAS SENT. ${storeCreditInvoiceRefusalReason()}`
}

/** The importer's entry, written when the invoice is queued: it says what WILL happen, not what has. */
export function storeCreditInvoiceQueuedNotice(orderNumber: string, creditText: string): string {
  return `WooCommerce order ${orderNumber} carries ${creditText} of store credit. `
    + `The sales invoice queued for it will be refused when IMS tries to post it. ${storeCreditInvoiceRefusalReason()}`
}
