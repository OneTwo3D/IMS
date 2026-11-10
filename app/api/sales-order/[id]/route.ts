import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, documentVatRows, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'
import { documentTotalsRows, salesOrderMoneyView } from '@/lib/domain/sales/sales-order-money-view'
import { formatMoney } from '@/lib/utils'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const so = await db.salesOrder.findUnique({
    where: { id },
    include: {
      shipFromWarehouse: { select: { name: true } },
      shoppingLinks: { select: { connector: true } },
      lines: {
        select: {
          description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true, taxForeign: true,
          taxRate: { select: { rate: true } },
        },
      },
    },
  })
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const branding = await getBranding()
  const tpl = await db.documentTemplate.findUnique({
    where: { type: 'sales_order' },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
  })
  const tz = await getDisplayTimeZone()
  const { doc } = createPdfDocument({ title: `Order ${so.externalOrderNumber}` })
  const date = formatDateTime(so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)

  const shipAddr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = shipAddr ? [shipAddr.line1, shipAddr.line2, shipAddr.city, shipAddr.postcode, formatCountryDisplay(shipAddr.country)].filter(Boolean).join('\n') : ''

  await drawHeader(doc, branding, {
    title: 'Sales Order',
    reference: so.externalOrderNumber ?? so.id.slice(0, 8),
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  // Header note from template
  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  if (so.expectedDelivery) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Expected delivery: ${formatDateTime(so.expectedDelivery, { day: 'numeric', month: 'long', year: 'numeric' }, tz)}`, 50, doc.y)
    doc.y += 6
  }
  if (so.shippingService) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Shipping: ${so.shippingService}`, 50, doc.y)
    doc.y += 10
  }

  const currencyRow = await db.currency.findUnique({ where: { code: so.currency } })
  const sym = currencyRow?.symbol ?? (so.currency === 'GBP' ? '£' : so.currency)
  const symPos: 'PREFIX' | 'POSTFIX' = currencyRow?.symbolPosition ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)
  // ONE basis for every figure on the document (lib/domain/sales/sales-order-money-view.ts), labelled, and reconciling with the stored total.
  const view = salesOrderMoneyView({
    pricesIncludeVat: so.pricesIncludeVat,
    shoppingLinks: so.shoppingLinks,
    taxRatePercent: so.taxRatePercent != null ? Number(so.taxRatePercent) : null,
    subtotalForeign: Number(so.subtotalForeign),
    discountAmount: Number(so.discountAmount),
    shippingForeign: Number(so.shippingForeign),
    taxForeign: Number(so.taxForeign),
    totalForeign: Number(so.totalForeign),
    storeCreditForeign: Number(so.storeCreditForeign ?? 0),
    lines: so.lines.map((l) => ({
      qty: Number(l.qty), unitPriceForeign: Number(l.unitPriceForeign), discountAmount: Number(l.discountAmount ?? 0),
      totalForeign: Number(l.totalForeign), taxForeign: Number(l.taxForeign ?? 0),
    })),
  })
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
    String(i + 1), l.sku ?? '', l.description, String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.discountAmount) > 0 ? `-${Number(l.discountAmount).toFixed(2)}` : '',
    view.lines[i].total.toFixed(2),
  ])

  drawTable(doc, columns, rows, branding)

  // Totals
  doc.y += 5
  const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const vW = columns[columns.length - 1].width
  const lW = 80
  const lX = tableRight - vW - lW
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  const totalsRows = documentTotalsRows(view, documentVatRows({
    taxRateName: so.taxRateName,
    taxRatePercent: so.taxRatePercent != null ? Number(so.taxRatePercent) : null,
    taxForeign: Number(so.taxForeign),
    lines: so.lines.map((l) => ({ taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : null, taxForeign: Number(l.taxForeign || 0) })),
  }))
  for (const row of totalsRows) {
    if (row.strong) doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    else doc.font('Helvetica').fontSize(9).fillColor('#666')
    doc.text(`${row.label}:`, lX - 40, doc.y + (row.strong ? 3 : 0), { width: lW + 40, align: 'right' })
    doc.text(money(row.amount), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }

  // Footer note from template
  if (tpl?.footerNote) {
    doc.y += 10
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.footerNote, 50, doc.y, { width: 495 })
  }

  // Terms from template
  if (tpl?.termsText) {
    doc.y += 10
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.font('Helvetica').fontSize(7).fillColor('#888').text(tpl.termsText, 50, doc.y + 2, { width: 495 })
  }

  // Payment terms
  if (tpl?.showPaymentTerms && tpl?.paymentTermsText) {
    doc.y += 8
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Payment terms: ${tpl.paymentTermsText}`, 50, doc.y)
  }

  if (so.notes) {
    doc.y += 15
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('NOTES', 50, doc.y)
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(so.notes, 50, doc.y + 2, { width: 495 })
  }

  drawFooter(doc, 'Thank you for your order.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Order-${so.externalOrderNumber}.pdf"` },
  })
}
