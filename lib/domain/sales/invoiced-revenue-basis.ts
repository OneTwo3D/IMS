/**
 * THE ONE DEFINITION OF "INVOICED" FOR EVERY SALES-VALUE AND RECEIVABLES REPORT.
 *
 * An order counts when ALL of these hold:
 *   - it is not CANCELLED and not DRAFT (paid or not, shipped or not);
 *   - it carries an invoice: either an IMS-posted accounting invoice (`accountingInvoiceId`
 *     set) or a Xeroom-era invoice number (`invoiceNumber` set on an order linked to WooCommerce,
 *     where IMS reads it from `_wcpdf_invoice_number`, the number Xeroom pushes to Xero). An
 *     `invoiceNumber` on any other order is IMS-minted, is not proof of an invoice, and does not count.
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
import { EXTERNAL_INVOICE_NUMBER_CONNECTORS, invoiceNumberIsExternallySupplied } from '@/lib/domain/accounting/sales-invoice-number'

/** Statuses an order may be in and still be invoiced sales. */
export const INVOICED_BASIS_EXCLUDED_STATUSES = ['CANCELLED', 'DRAFT'] as const satisfies readonly SalesOrderStatus[]

/**
 * Prisma `where` fragment for `SalesOrder`. Spread it, or put it in an `AND`, because it owns
 * the `status` and `OR` keys. For a relation filter use `{ order: INVOICED_ORDER_WHERE }`.
 *
 * ARCHIVED ORDERS COUNT. The retention job soft-archives old completed and delivered orders (`archived`
 * = true) and touches nothing else: their invoices, payments and credits stand. Archiving only hides an
 * order from operational lists, so no financial query built on this fragment (every revenue and receivables
 * report and CSV) filters on `archived`, and one must not be added. Operational lists keep their own filter.
 *
 * WHICH `invoiceNumber` COUNTS. Only a number that came from OUTSIDE IMS: the WooCommerce import
 * writes `_wcpdf_invoice_number` (the number Xeroom pushes to Xero) and, by the guard in
 * `generateInvoiceNumber`, IMS never mints a number for an order linked to such a connector
 * (`EXTERNAL_INVOICE_NUMBER_CONNECTORS`). So a number on an order linked to that connector is the
 * Xeroom number, and a number on any other order is IMS-minted, which says nothing about whether
 * the invoice was posted (a refused or failed post leaves it behind). Those count only once
 * `accountingInvoiceId` is set. No new column is needed: the order's channel is the provenance.
 */
export const INVOICED_ORDER_WHERE: Prisma.SalesOrderWhereInput = {
  status: { notIn: [...INVOICED_BASIS_EXCLUDED_STATUSES] },
  OR: [
    { accountingInvoiceId: { not: null } },
    {
      invoiceNumber: { not: null },
      shoppingLinks: { some: { connector: { in: [...EXTERNAL_INVOICE_NUMBER_CONNECTORS] } } },
    },
  ],
}

/**
 * In-memory twin of `INVOICED_ORDER_WHERE`, for code that already holds the rows (select
 * `shoppingLinks: { select: { connector: true } }`). The import never stores a blank invoice
 * number, so null and empty are the same thing in practice.
 */
export function isInvoicedOrder(order: {
  status: string
  accountingInvoiceId?: string | null
  invoiceNumber?: string | null
  shoppingLinks?: ReadonlyArray<{ connector: string }>
}): boolean {
  if ((INVOICED_BASIS_EXCLUDED_STATUSES as readonly string[]).includes(order.status)) return false
  if (order.accountingInvoiceId) return true
  return Boolean(order.invoiceNumber) && invoiceNumberIsExternallySupplied((order.shoppingLinks ?? []).map((l) => l.connector))
}

/**
 * THE ONE PERIOD DATE FOR INVOICED-REVENUE REPORTS THAT ARE BOUNDED BY INVOICE DATE.
 *
 * In order: `invoicedAt`; else `paidAt`; else the order date (`createdAt`).
 *  - Xeroom-era orders carry an invoice number but no `invoicedAt`, and IMS does not store the
 *    WooCommerce PDF invoice date (`_wcpdf_invoice_date` is never imported; the import stores only
 *    the order's own created, modified and paid instants).
 *  - Xeroom issues the invoice as the order moves to processing/paid, so the Woo paid instant
 *    (stored as `paidAt`, from `date_paid_gmt`) is the nearest real date for a paid order.
 *  - An unpaid order with no invoice date falls back to the order date, which is only an
 *    APPROXIMATION: `invoicedPeriodDateIsApproximate` says so, and reports flag those rows.
 * This is a REPORTING date only: nothing writes `invoicedAt` for these orders, because it is the
 * tax point the VAT report reads. Reports bounded by order date (dashboard, Sales Stats products,
 * Sales Analytics, Customer Mix) already use `createdAt` and are unaffected.
 */
export function invoicedPeriodDate(order: { invoicedAt?: Date | null; paidAt?: Date | null; createdAt: Date }): Date {
  return order.invoicedAt ?? order.paidAt ?? order.createdAt
}

/** True when the period date is the order date because neither an invoice date nor a paid date exists. */
export function invoicedPeriodDateIsApproximate(order: { invoicedAt?: Date | null; paidAt?: Date | null }): boolean {
  return order.invoicedAt == null && order.paidAt == null
}

/**
 * Prisma `where` for "invoiced AND dated inside the window" using `invoicedPeriodDate`: `invoicedAt`
 * is in the window; or there is none and `paidAt` is; or there is neither and `createdAt` is. Safe
 * to spread: the result owns only `AND`, so put other conditions beside it, and put other `AND`
 * entries through it, not over it.
 */
export function invoicedInPeriodWhere(window: { gte?: Date; lt?: Date; lte?: Date }): Prisma.SalesOrderWhereInput {
  return {
    AND: [
      INVOICED_ORDER_WHERE,
      {
        OR: [
          { invoicedAt: window },
          { invoicedAt: null, paidAt: window },
          { invoicedAt: null, paidAt: null, createdAt: window },
        ],
      },
    ],
  }
}

/** The one-sentence definition, for help text and report subtitles. */
export const INVOICED_BASIS_SENTENCE =
  'Invoiced revenue counts every order that has an invoice (an IMS-posted Xero invoice, or, during the parallel phase, the invoice number Xeroom generated for a WooCommerce order), paid or not, excluding cancelled and draft orders.'
