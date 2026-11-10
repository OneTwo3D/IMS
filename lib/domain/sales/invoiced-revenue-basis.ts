/**
 * THE ONE DEFINITION OF "INVOICED" FOR EVERY SALES-VALUE AND RECEIVABLES REPORT.
 *
 * An order counts when ALL of these hold:
 *   - it is not CANCELLED and not DRAFT (paid or not, shipped or not);
 *   - it carries an invoice: either an IMS-posted accounting invoice (`accountingInvoiceId`
 *     set) or a Xeroom-era invoice number (`invoiceNumber` set, which IMS reads from
 *     WooCommerce `_wcpdf_invoice_number`, the number Xeroom pushes to Xero).
 *
 * Why both: during the parallel phase Xeroom raises the Xero invoices and IMS only mirrors
 * their numbers, so `accountingInvoiceId` is empty and `invoiceNumber` is the evidence. After
 * the switchover IMS posts the invoices itself, `accountingInvoiceId` is set, and the same rule
 * keeps working with no change. Nothing here writes either column.
 *
 * Consumers: dashboard, Sales Statistics, Sales Analytics (and Customer Mix and Margin), AR
 * Aging, the currency summary, product profitability, and every CSV export of those.
 *
 * DELIBERATELY NOT USING THIS: the Xero daily batch (it asks whether an order is PAID and has
 * an IMS-posted invoice, because it decides what IMS itself must post) and the VAT report
 * (a tax-point report keyed on the invoice date).
 *
 * Keep this file import-light: it is read by server actions and report producers alike.
 */

import type { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'

/** Statuses an order may be in and still be invoiced sales. */
export const INVOICED_BASIS_EXCLUDED_STATUSES = ['CANCELLED', 'DRAFT'] as const satisfies readonly SalesOrderStatus[]

/**
 * Prisma `where` fragment for `SalesOrder`. Spread it, or put it in an `AND`, because it owns
 * the `status` and `OR` keys. For a relation filter use `{ order: { AND: [INVOICED_ORDER_WHERE] } }`.
 */
export const INVOICED_ORDER_WHERE: Prisma.SalesOrderWhereInput = {
  status: { notIn: [...INVOICED_BASIS_EXCLUDED_STATUSES] },
  OR: [
    { accountingInvoiceId: { not: null } },
    { invoiceNumber: { not: null } },
  ],
}

/**
 * In-memory twin of `INVOICED_ORDER_WHERE`, for code that already holds the rows. The import
 * never stores a blank invoice number, so null and empty are the same thing in practice.
 */
export function isInvoicedOrder(order: {
  status: string
  accountingInvoiceId?: string | null
  invoiceNumber?: string | null
}): boolean {
  if ((INVOICED_BASIS_EXCLUDED_STATUSES as readonly string[]).includes(order.status)) return false
  return Boolean(order.accountingInvoiceId) || Boolean(order.invoiceNumber)
}

/** The one-sentence definition, for help text and report subtitles. */
export const INVOICED_BASIS_SENTENCE =
  'Invoiced revenue counts every order that has an invoice (an IMS-posted Xero invoice, or the Xeroom invoice number during the parallel phase), paid or not, excluding cancelled and draft orders.'
