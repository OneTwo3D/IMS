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

import { withLedgerCheck } from '@/lib/domain/accounting/hand-post-instruction'
import { toDecimal } from '@/lib/domain/math/decimal'

/** ActivityLog action written when a later delivery of an imported order puts it in store-credit review. */
export const STORE_CREDIT_REVIEW_ACTION = 'wc_store_credit_review_required'

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

/** Why posting is blocked: the order carries credit, or it is held for review because its coupons changed or conflict after import. */
export type StoreCreditBlock = 'CREDIT' | 'REVIEW'

/**
 * Does store credit block posting for this order? REVIEW_REQUIRED (written when a later delivery shows credit,
 * or a conflict about credit, that the stored row does not account for) blocks like credit does. Fails closed on
 * an unreadable credit amount.
 */
export function storeCreditBlock(order: { storeCreditForeign?: unknown; storeCreditAssessment?: unknown }): StoreCreditBlock | null {
  if (order.storeCreditAssessment === 'REVIEW_REQUIRED') return 'REVIEW'
  return orderCarriesStoreCredit(order.storeCreditForeign) ? 'CREDIT' : null
}

/**
 * The reason a store-credit order's sales invoice is withheld. Describes the WITHHOLDING and why, never
 * a ledger fact: whether anything was sent is stated by the caller, who knows its stage.
 */
export function storeCreditInvoiceRefusalReason(block: StoreCreditBlock = 'CREDIT'): string {
  if (block === 'REVIEW') {
    return withLedgerCheck('This order is held for store-credit review: after it was imported, WooCommerce reported store credit, or coupon '
      + 'records that disagree about store credit, which the order as imported does not account for. IMS cannot tell how it '
      + 'was paid, so it does not post a sales invoice, credit note or payment for it. If this order must be invoiced now, '
      + 'first check the ledger for an invoice already raised for it, then raise it by hand with any store credit applied as a payment.')
  }
  // Wrapped in the ledger check like every other operator text that tells someone to raise a document by hand.
  return withLedgerCheck('This order was paid in part with store credit. IMS records store credit as a PAYMENT, not a discount, '
    + 'so the sales invoice would be stated at the full goods value and the credit would have to be applied to '
    + 'it as a payment against the store-credit liability account (813 or 816). That posting is not built yet, '
    + 'so IMS does not post a sales invoice, or register a payment, for an order that carries store credit. '
    + 'If this order must be invoiced now, first check the ledger for an invoice already raised for it, then '
    + 'raise it by hand with the credit applied as a payment.')
}

/** The poster's error: the refusal happens before any request is built, so "nothing was sent" is true. */
export function storeCreditInvoicePosterError(block: StoreCreditBlock = 'CREDIT'): string {
  return `NOTHING WAS SENT. ${storeCreditInvoiceRefusalReason(block)}`
}

/**
 * The credit-note counterpart. A refund of a store-credit order would post a credit note against an
 * invoice IMS has not posted, so it is refused for the same reason and from the same fact. Describes the
 * withholding only; "nothing was sent" holds because the refusal is taken before any request is built.
 */
export function storeCreditCreditNotePosterError(block: StoreCreditBlock = 'CREDIT'): string {
  return withLedgerCheck(`NOTHING WAS SENT. This refund belongs to an order ${block === 'REVIEW' ? 'held for store-credit review' : 'paid in part with store credit'}. IMS does not `
    + 'post a sales invoice for such an order yet (store credit is a payment that has to be applied to the '
    + 'invoice against the 813 or 816 liability account, and that posting is not built), so it does not post '
    + 'a credit note for it either. If the order was invoiced by hand, check the ledger first, then raise '
    + 'the matching credit note by hand.')
}

/**
 * The follow-ups that hang off the invoice (its payment registration, the invoice email, the WooCommerce
 * invoice note). They are refused for the same reason and from the same fact, at the posting boundary, so a
 * revived or manually queued entry cannot reach the remote call. The refusal is taken before any request is
 * built, so "nothing was sent" is true.
 */
export function storeCreditFollowUpPosterError(what: 'payment registration' | 'invoice email' | 'WooCommerce invoice note', block: StoreCreditBlock = 'CREDIT'): string {
  return `NOTHING WAS SENT. This ${what} belongs to an order ${block === 'REVIEW' ? 'held for store-credit review' : 'paid in part with store credit'}. ${storeCreditInvoiceRefusalReason(block)}`
}

/** The importer's entry, written when the invoice is queued: it says what WILL happen, not what has. */
export function storeCreditInvoiceQueuedNotice(orderNumber: string, creditText: string): string {
  return `WooCommerce order ${orderNumber} carries ${creditText} of store credit. `
    + `IMS will refuse the sales invoice queued for it when that invoice comes up for posting. ${storeCreditInvoiceRefusalReason()}`
}

/**
 * The customer-facing INVOICE document (the local invoice PDF, the invoice email in either flavour, the on-the-fly
 * invoice download) is refused for an order that carries store credit or is held for review. The document would
 * have to state the full goods value and show the credit as a payment; the local renderers print
 * `SalesOrder.totalForeign` (what WooCommerce charged AFTER the credit) as the invoice Total, which would send the
 * customer an invoice reduced by the credit. Raised before anything is rendered or queued, so nothing was sent.
 */
export function storeCreditInvoiceDocumentRefusal(block: StoreCreditBlock = 'CREDIT'): string {
  return `NOTHING WAS GENERATED OR SENT. This order ${block === 'REVIEW' ? 'is held for store-credit review' : 'was paid in part with store credit'}, `
    + 'and IMS does not produce an invoice document for such an order yet: it would have to state the full goods value and show the '
    + 'credit as a payment, and that is not built. The order confirmation is unaffected.'
}

/** Throws the refusal when the order must not be given an invoice document; returns otherwise. */
export function assertNoStoreCreditInvoiceDocument(order: { storeCreditForeign?: unknown; storeCreditAssessment?: unknown }): void {
  const block = storeCreditBlock(order)
  if (block) throw new Error(storeCreditInvoiceDocumentRefusal(block))
}
