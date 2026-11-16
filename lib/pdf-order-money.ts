/**
 * The money block of a printed sales order / invoice, in ONE place: the sales-order PDF, the invoice PDF and the two email attachments
 * (lib/order-email.ts) all read it, so they cannot drift apart (the email copies once printed the stored net shipping beside gross
 * lines and a Total that did not add up). Every figure follows the order's single basis (lib/domain/sales/sales-order-money-view.ts)
 * and reconciles with the stored total.
 */
import { documentVatRows } from '@/lib/pdf'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { documentTotalsRows, salesOrderMoneyView, type SalesOrderMoneyView, type TotalsRow } from '@/lib/domain/sales/sales-order-money-view'

type NumLike = unknown // a Prisma Decimal, a number or a numeric string
const n = (v: NumLike | null | undefined): number => Number(v ?? 0)

export type OrderDocumentMoneyInput = {
  pricesIncludeVat?: boolean | null
  shoppingLinks?: ReadonlyArray<{ connector: string }> | null
  taxRateName: string | null
  taxRatePercent: NumLike | null
  subtotalForeign: NumLike
  discountAmount: NumLike
  shippingForeign: NumLike
  taxForeign: NumLike
  totalForeign: NumLike
  storeCreditForeign?: NumLike | null
  lines: ReadonlyArray<{
    qty: NumLike
    unitPriceForeign: NumLike
    discountAmount?: NumLike | null
    totalForeign: NumLike
    taxForeign?: NumLike | null
    taxRate?: { rate: NumLike | null } | null
  }>
}

export function orderDocumentMoney(so: OrderDocumentMoneyInput): { view: SalesOrderMoneyView; totalsRows: TotalsRow[] } {
  const taxRatePercent = so.taxRatePercent != null ? n(so.taxRatePercent) : null
  const view = salesOrderMoneyView({
    pricesIncludeVat: so.pricesIncludeVat,
    shoppingLinks: so.shoppingLinks,
    taxRatePercent,
    subtotalForeign: n(so.subtotalForeign),
    discountAmount: n(so.discountAmount),
    shippingForeign: n(so.shippingForeign),
    taxForeign: n(so.taxForeign),
    totalForeign: n(so.totalForeign),
    storeCreditForeign: n(so.storeCreditForeign),
    lines: so.lines.map((l) => ({
      qty: n(l.qty),
      unitPriceForeign: n(l.unitPriceForeign),
      discountAmount: n(l.discountAmount),
      totalForeign: n(l.totalForeign),
      taxForeign: n(l.taxForeign),
    })),
  })
  const totalsRows = documentTotalsRows(view, documentVatRows({
    taxRateName: so.taxRateName,
    taxRatePercent,
    taxForeign: n(so.taxForeign),
    lines: so.lines.map((l) => ({ taxRatePercent: l.taxRate?.rate != null ? n(l.taxRate.rate) : null, taxForeign: n(l.taxForeign) })),
  }))
  return { view, totalsRows }
}

/** Draw the totals rows right-aligned under a table whose last column is the amount column. */
export function drawTotalsRows(
  doc: PDFKit.PDFDocument,
  rows: ReadonlyArray<TotalsRow>,
  money: (n: number) => string,
  columns: ReadonlyArray<{ width: number }>,
): void {
  doc.y += 5
  const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const vW = columns[columns.length - 1].width
  const lW = 80
  const lX = tableRight - vW - lW
  for (const row of rows) {
    if (row.strong) doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    else doc.font('Helvetica').fontSize(9).fillColor('#666')
    doc.text(`${row.label}:`, lX - 40, doc.y + (row.strong ? 3 : 0), { width: lW + 40, align: 'right' })
    doc.text(money(row.amount), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
}

/**
 * What an IMS-rendered invoice calls itself. A document with no invoice number is not a VAT invoice: it is titled "Pro-forma Invoice"
 * and carries the order number as its reference (never the database id). The order number is shown beside a real invoice number.
 */
export function invoiceDocumentIdentity(so: {
  id: string
  invoiceNumber: string | null
  orderNumber?: string | null
  externalOrderNumber?: string | null
}): { title: 'Invoice' | 'Pro-forma Invoice'; reference: string; orderReference: string | null } {
  const orderRef = getSalesOrderReference(so)
  const hasNumber = !!so.invoiceNumber?.trim()
  const reference = hasNumber ? (so.invoiceNumber as string) : orderRef
  return {
    title: hasNumber ? 'Invoice' : 'Pro-forma Invoice',
    reference,
    orderReference: reference === orderRef ? null : orderRef,
  }
}
