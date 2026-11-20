import type { Prisma } from '@/app/generated/prisma/client'
import { businessDateYmd } from '@/lib/business-date'

/**
 * THE DATE EACH DOCUMENT CARRIES IN THE LEDGER (Xero), defined once so the VAT report and the posters cannot disagree.
 *
 * Xero's VAT return is built from the document DATE, not from the moment the document was posted. A document posted after London midnight (a queue delay, a hold,
 * the cut-over backlog) still carries the day it was dated with, so a report that periods VAT on the post instant puts a quarter-end document in the wrong quarter.
 *
 *  - SALES INVOICE: the London day the WooCommerce order was created (`date_created_gmt`), stored on `SalesOrder.externalCreatedAt`. The importer builds the invoice
 *    `date` with `salesInvoiceDocumentDay` (lib/connectors/woocommerce/sync/order-import.ts, both the live and the held-order builder).
 *  - PURCHASE BILL: the `invoiceDate` the operator typed, sent verbatim as the bill `date` (app/actions/purchase-orders.ts) and stored as that day's UTC midnight in
 *    `PurchaseInvoice.invoiceDate`, which is inside the same London day in both GMT and BST. The report already windows on it.
 *  - SALES CREDIT NOTE: the London day of `SalesOrderRefund.createdAt`, on the first hand-off AND on every retry (queueRefundAccountingActions in app/actions/sales.ts reads the refund's own creation).
 *  - SUPPLIER CREDIT NOTE: the London day of `SupplierCreditNote.postedAt`: one clock read gives both the date sent and `postedAt` (app/actions/purchase-orders.ts).
 *  - AN UPDATE of a posted sales invoice (order edit, return-exchange) keeps the ORIGINAL document date (`originalSalesInvoiceDay`), so an edit never re-dates the invoice.
 *
 * NOTE ON WHO POSTS: the writer-ownership map gives sales invoices, their updates and sales credit notes to Xeroom in P1 and P2 (IMS shadows them), so these dates describe the
 * documents IMS would send and the ones Xeroom holds; purchase bills and supplier credit notes are Qoblex-native in P1 and IMS in P2.
 */

/** The date (YYYY-MM-DD) sent to the ledger as a sales invoice's Date: the London day of the order's creation instant. */
export function salesInvoiceDocumentDay(orderCreatedAt: Date): string {
  return businessDateYmd(orderCreatedAt)
}

/** The date (YYYY-MM-DD) a sales credit note is sent with: the London day of the refund's creation. */
export function creditNoteDocumentDay(refundCreatedAt: Date): string {
  return businessDateYmd(refundCreatedAt)
}

/** The date (YYYY-MM-DD) a supplier credit note is sent with: the London day it was posted. */
export function supplierCreditNoteDocumentDay(postedAt: Date): string {
  return businessDateYmd(postedAt)
}

/**
 * The London day a posted sales order's invoice is dated, in memory. A storefront order has `externalCreatedAt` (the day the poster used); an order without it was
 * never posted by the importer, so its stored `invoicedAt` (the stamp written when the document was posted or repaired from the posted date) is the only date there is.
 */
export function salesInvoiceDocumentDayOfOrder(order: { externalCreatedAt: Date | null; invoicedAt: Date | null }): string | null {
  if (order.invoicedAt === null) return null
  return businessDateYmd(order.externalCreatedAt ?? order.invoicedAt)
}

/**
 * Prisma `where` for "posted AND dated (the document date above) inside the London-day instant window [gte, lt)". The window is London midnights, so
 * `externalCreatedAt` inside it is exactly "the London day of externalCreatedAt is inside the days". Spread it into the `order` filter; it owns only `OR`.
 */
export function salesInvoiceDocumentDateWhere(window: { gte: Date; lt: Date }): Pick<Prisma.SalesOrderWhereInput, 'OR'> {
  return {
    OR: [
      { invoicedAt: { not: null }, externalCreatedAt: { gte: window.gte, lt: window.lt } },
      { externalCreatedAt: null, invoicedAt: { gte: window.gte, lt: window.lt } },
    ],
  }
}

/**
 * The date an UPDATE of an already-posted sales invoice must carry: the date the invoice already has. In order: the London day of the storefront creation (what the importer sent),
 * else the London day of the stored invoice stamp (the live post writes it from the payload date it sent; a repair does the same), else today (nothing posted yet).
 */
export function originalSalesInvoiceDay(input: { externalCreatedAt: Date | null; invoicedAt: Date | null; now?: Date }): string {
  if (input.externalCreatedAt) return businessDateYmd(input.externalCreatedAt)
  if (input.invoicedAt) return businessDateYmd(input.invoicedAt)
  return businessDateYmd(input.now ?? new Date())
}
