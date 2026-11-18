/**
 * The sales order document and the sales QUOTE document: ONE renderer. The order download (app/api/sales-order/[id]), the order confirmation email
 * attachment (lib/order-email.ts) and the quote download / quote email all draw through this, so the three cannot drift. A quote is the same
 * document with a QUOTE heading, the date the prices are valid until, its own template (type `quote`) and no payment terms.
 * Money goes through the one shared helper (lib/pdf-order-money.ts), so the figures reconcile on every variant.
 */
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'
import {
  createPdfDocument,
  drawFooter,
  drawHeader,
  drawTable,
  pdfToBuffer,
  type Branding,
  type PdfTableColumn,
} from '@/lib/pdf'
import { drawTotalsRows, orderDocumentMoney } from '@/lib/pdf-order-money'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { formatMoney, type SymbolPos } from '@/lib/utils'
import { formatCalendarDate, formatDateTime } from '@/lib/format-datetime'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { DEFAULT_QUOTE_TEMPLATE, QUOTE_DOCUMENT_TITLE, quoteDateToYmd, quoteValidityLine } from '@/lib/domain/sales/sales-quote'

export type SalesOrderPdfSource = {
  id: string
  externalOrderNumber: string | null
  orderNumber?: string | null
  pricesIncludeVat?: boolean | null
  shoppingLinks?: { connector: string }[] | null
  currency: string
  customerName: string | null
  customerEmail: string | null
  billingAddress: unknown
  shippingAddress: unknown
  subtotalForeign: unknown
  shippingForeign: unknown
  shippingService: string | null
  taxForeign: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  totalForeign: unknown
  totalBase: unknown
  taxBase: unknown
  discountAmount: unknown
  /** Store credit, GROSS: a payment. Shown beside the Total on an order document, never on an invoice. */
  storeCreditForeign?: unknown
  storeCreditAssessment?: unknown
  invoiceNumber: string | null
  invoicedAt: Date | null
  paidAt: Date | null
  expectedDelivery: Date | null
  notes: string | null
  createdAt: Date
  invoicePdfPath?: string | null
  /** Set for a quotation: the last day the prices stand (the DATE column). */
  quoteValidUntil?: Date | null
  lines: {
    description: string
    sku: string | null
    qty: unknown
    unitPriceForeign: unknown
    discountAmount: unknown
    totalForeign: unknown
    taxForeign?: unknown
    taxRate?: { rate: unknown } | null
  }[]
}

export const SALES_ORDER_PDF_LINE_SELECT = {
  description: true,
  sku: true,
  qty: true,
  unitPriceForeign: true,
  discountAmount: true,
  totalForeign: true,
  taxForeign: true,
  taxRate: { select: { rate: true, reverseCharge: true } },
} as const

export async function loadSalesOrderForPdf(orderId: string): Promise<(SalesOrderPdfSource & { isQuote: boolean; status: string }) | null> {
  return db.salesOrder.findUnique({
    where: { id: orderId },
    include: {
      shoppingLinks: { select: { connector: true } },
      lines: { select: SALES_ORDER_PDF_LINE_SELECT },
    },
  })
}

export async function getCurrencyFormat(code: string): Promise<{ sym: string; symPos: SymbolPos; money: (n: number) => string }> {
  const row = await db.currency.findUnique({ where: { code } })
  const sym = row?.symbol ?? (code === 'GBP' ? '£' : code)
  const symPos: SymbolPos = row?.symbolPosition ?? 'PREFIX'
  return { sym, symPos, money: (n: number) => formatMoney(n, sym, symPos) }
}

type TemplateFields = { headerNote: string | null; footerNote: string | null; termsText: string | null; customFooter: string | null; showPaymentTerms: boolean; paymentTermsText: string | null }

/** The saved template of the type, or (quote only) the built-in default when none has been saved yet. */
export async function loadDocumentTemplate(type: 'sales_order' | 'quote'): Promise<TemplateFields | null> {
  const row = await db.documentTemplate.findUnique({
    where: { type },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
  })
  if (row || type !== 'quote') return row
  return {
    headerNote: DEFAULT_QUOTE_TEMPLATE.headerNote || null,
    footerNote: DEFAULT_QUOTE_TEMPLATE.footerNote,
    termsText: DEFAULT_QUOTE_TEMPLATE.termsText || null,
    customFooter: DEFAULT_QUOTE_TEMPLATE.customFooter || null,
    showPaymentTerms: DEFAULT_QUOTE_TEMPLATE.showPaymentTerms,
    paymentTermsText: DEFAULT_QUOTE_TEMPLATE.paymentTermsText || null,
  }
}

export async function renderSalesOrderPdf(
  so: SalesOrderPdfSource,
  branding: Branding,
  options: { variant?: 'order' | 'quote' } = {},
): Promise<Buffer> {
  const quote = options.variant === 'quote'
  const tpl = await loadDocumentTemplate(quote ? 'quote' : 'sales_order')
  const tz = await getDisplayTimeZone()
  const orderRef = getSalesOrderReference(so)
  const { doc } = createPdfDocument({ title: quote ? `${QUOTE_DOCUMENT_TITLE} ${orderRef}` : `Order ${orderRef}` })
  const longDate = { day: 'numeric', month: 'long', year: 'numeric' } as const
  const date = formatDateTime(so.createdAt, longDate, tz)
  const shipAddr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = shipAddr ? [shipAddr.line1, shipAddr.line2, shipAddr.city, shipAddr.postcode, formatCountryDisplay(shipAddr.country)].filter(Boolean).join('\n') : ''

  await drawHeader(doc, branding, {
    title: quote ? QUOTE_DOCUMENT_TITLE : 'Sales Order',
    reference: orderRef,
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  if (quote) {
    // The DATE column's calendar day, printed as that day whatever the display time zone.
    const validity = quoteValidityLine(quoteDateToYmd(so.quoteValidUntil ?? null), (ymd) => formatCalendarDate(`${ymd}T00:00:00.000Z`, longDate))
    if (validity) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(validity, 50, doc.y)
      doc.fillColor('#000')
      doc.y += 8
    }
  }

  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  if (so.expectedDelivery) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Expected delivery: ${formatDateTime(so.expectedDelivery, longDate, tz)}`, 50, doc.y)
    doc.y += 6
  }
  if (so.shippingService) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Shipping: ${so.shippingService}`, 50, doc.y)
    doc.y += 10
  }

  const { sym, symPos } = await getCurrencyFormat(so.currency)
  const { view, totalsRows } = orderDocumentMoney(so)
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Description', width: 195, wrap: true },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Price ${view.basisLabel} (${sym})`, width: 65, align: 'right' },
    { label: 'Discount', width: 50, align: 'right' },
    { label: `Total ${view.basisLabel} (${sym})`, width: 65, align: 'right' },
  ]
  const rows = so.lines.map((l, i) => [
    String(i + 1),
    l.sku ?? '',
    l.description,
    String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.discountAmount) > 0 ? `-${Number(l.discountAmount).toFixed(2)}` : '',
    view.lines[i].total.toFixed(2),
  ])
  drawTable(doc, columns, rows, branding)
  drawTotalsRows(doc, totalsRows, (v) => formatMoney(v, sym, symPos), columns)

  if (tpl?.footerNote) {
    doc.y += 10
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.footerNote, 50, doc.y, { width: 495 })
  }
  if (tpl?.termsText) {
    doc.y += 10
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.font('Helvetica').fontSize(7).fillColor('#888').text(tpl.termsText, 50, doc.y + 2, { width: 495 })
  }
  // A quote states no payment terms: nothing is owed on an offer.
  if (!quote && tpl?.showPaymentTerms && tpl?.paymentTermsText) {
    doc.y += 8
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Payment terms: ${tpl.paymentTermsText}`, 50, doc.y)
  }
  if (so.notes) {
    doc.y += 15
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('NOTES', 50, doc.y)
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(so.notes, 50, doc.y + 2, { width: 495 })
  }

  drawFooter(doc, quote ? 'Thank you for your enquiry.' : 'Thank you for your order.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}
