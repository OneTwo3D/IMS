import type { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
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
 *  - AN UPDATE of a posted sales invoice (order edit, return-exchange) keeps the ORIGINAL document date (`originalSalesInvoiceDay`: the posted row's payload date first), so an edit never re-dates the invoice, and is REFUSED when no date is readable.
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

/**
 * The credit note's OWN document day, read from the refund row: the London day of its creation, on the first hand-off AND on every retry (a retry rebuilds the credit note and
 * must not re-date it to the retry day). Null when the refund row cannot be read; the caller then has only the clock.
 */
export async function readCreditNoteDocumentDay(client: Pick<typeof db, 'salesOrderRefund'>, refundId: string): Promise<string | null> {
  const refund = await client.salesOrderRefund.findUnique({ where: { id: refundId }, select: { createdAt: true } })
  return refund ? creditNoteDocumentDay(refund.createdAt) : null
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
 * The date a sales invoice document is sent with, decided in one place: a FIRST post is dated today; an UPDATE of an already-posted invoice (the order has an accounting
 * invoice id) keeps the date the invoice already has. For an update, in order:
 *   1. the date in the payload of the SALES_INVOICE row that posted it (`postedPayloadDate`, read by readPostedSalesInvoiceDate): the date the ledger was actually sent;
 *   2. the London day of the storefront creation (what the importer sent);
 *   3. the London day of the stored invoice stamp (written from the payload date by the live post and the repair path).
 * When none of them is readable the answer is NULL: the update is REFUSED. Never today, because today is exactly the wrong date (it would re-date the invoice into the
 * period of the edit), and a legacy `invoicedAt` that holds the post instant can be a day off the payload date, which is why the payload is read first.
 */
export function originalSalesInvoiceDay(input: {
  accountingInvoiceId: string | null | undefined
  postedPayloadDate?: Date | null
  externalCreatedAt: Date | null
  invoicedAt: Date | null
  now?: Date
}): string | null {
  if (!input.accountingInvoiceId) return businessDateYmd(input.now ?? new Date())
  if (input.postedPayloadDate) return businessDateYmd(input.postedPayloadDate)
  if (input.externalCreatedAt) return businessDateYmd(input.externalCreatedAt)
  if (input.invoicedAt) return businessDateYmd(input.invoicedAt)
  return null
}

/**
 * What an update does about its date: `use` a readable one; with none readable, `refuse` when the update would be SENT (never today's date), or `shadow-unknown` when the
 * producer hold only records it (nothing is delivered, so refusing would block an edit that sends nothing): recorded with today's date, flagged as unknown.
 */
export function originalDayDecision(documentDay: string | null, wouldBeShadowed: boolean): 'use' | 'refuse' | 'shadow-unknown' {
  if (documentDay !== null) return 'use'
  return wouldBeShadowed ? 'shadow-unknown' : 'refuse'
}
