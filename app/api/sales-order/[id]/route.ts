import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, groupVatBreakdown, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'
import { formatMoney } from '@/lib/utils'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const so = await db.salesOrder.findUnique({
    where: { id },
    include: {
      shipFromWarehouse: { select: { name: true } },
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
  const { doc } = createPdfDocument({ title: `Order ${so.wcOrderNumber}` })
  const date = so.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const shipAddr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = shipAddr ? [shipAddr.line1, shipAddr.line2, shipAddr.city, shipAddr.postcode, shipAddr.country].filter(Boolean).join('\n') : ''

  await drawHeader(doc, branding, {
    title: 'Sales Order',
    reference: so.wcOrderNumber ?? so.id.slice(0, 8),
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  // Header note from template
  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  if (so.expectedDelivery) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Expected delivery: ${so.expectedDelivery.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, 50, doc.y)
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
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Description', width: 195 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Price (${sym})`, width: 65, align: 'right' },
    { label: 'Discount', width: 50, align: 'right' },
    { label: `Total (${sym})`, width: 65, align: 'right' },
  ]

  const rows = so.lines.map((l, i) => [
    String(i + 1), l.sku ?? '', l.description, String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.discountAmount) > 0 ? `-${Number(l.discountAmount).toFixed(2)}` : '',
    Number(l.totalForeign).toFixed(2),
  ])

  drawTable(doc, columns, rows, branding)

  // Totals
  doc.y += 5
  const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const vW = columns[columns.length - 1].width
  const lW = 80
  const lX = tableRight - vW - lW
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text('Subtotal:', lX, doc.y, { width: lW, align: 'right' })
  doc.text(money(Number(so.subtotalForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  if (Number(so.discountAmount) > 0) {
    doc.text('Discount:', lX, doc.y, { width: lW, align: 'right' })
    doc.text(`-${money(Number(so.discountAmount))}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  if (Number(so.shippingForeign) > 0) {
    doc.text('Shipping:', lX, doc.y, { width: lW, align: 'right' })
    doc.text(money(Number(so.shippingForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  if (Number(so.taxForeign) > 0) {
    const shippingFeeVat = Math.max(0, Number(so.taxForeign) - so.lines.reduce((s, l) => s + Number(l.taxForeign || 0), 0))
    const vatBreakdown = groupVatBreakdown(
      so.lines.map((l) => ({
        taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : (so.taxRatePercent != null ? Number(so.taxRatePercent) : null),
        taxForeign: Number(l.taxForeign || 0),
      })),
      shippingFeeVat > 0 ? [{ label: 'Shipping/Fees', amount: shippingFeeVat }] : undefined,
    )
    if (vatBreakdown.length <= 1) {
      const taxLabel = (so.taxRateName ?? 'Tax') + (so.taxRatePercent != null ? ` (${(Number(so.taxRatePercent) * 100).toFixed(0)}%)` : '') + ':'
      doc.text(taxLabel, lX, doc.y, { width: lW, align: 'right' })
      doc.text(money(Number(so.taxForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
    } else {
      for (const row of vatBreakdown) {
        doc.text(`${row.label}:`, lX, doc.y, { width: lW, align: 'right' })
        doc.text(money(row.amount), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
      }
    }
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', lX, doc.y + 3, { width: lW, align: 'right' })
  doc.text(money(Number(so.totalForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })

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
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Order-${so.wcOrderNumber}.pdf"` },
  })
}
