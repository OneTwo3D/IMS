import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const so = await db.salesOrder.findUnique({
    where: { id },
    include: {
      shipFromWarehouse: { select: { name: true } },
      lines: { select: { description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true } },
    },
  })
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const branding = await getBranding()
  const { doc } = createPdfDocument({ title: `Order ${so.wcOrderNumber}` })
  const date = so.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const shipAddr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = shipAddr ? [shipAddr.line1, shipAddr.line2, shipAddr.city, shipAddr.postcode, shipAddr.country].filter(Boolean).join(', ') : ''

  drawHeader(doc, branding, {
    title: 'Sales Order',
    reference: so.wcOrderNumber ?? so.id.slice(0, 8),
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  if (so.expectedDelivery) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Expected delivery: ${so.expectedDelivery.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, 50, doc.y)
    doc.y += 6
  }
  if (so.shippingService) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Shipping: ${so.shippingService}`, 50, doc.y)
    doc.y += 10
  }

  const sym = so.currency === 'GBP' ? '£' : so.currency
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
    String(i + 1),
    l.sku ?? '',
    l.description,
    String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.discountAmount) > 0 ? `-${Number(l.discountAmount).toFixed(2)}` : '',
    Number(l.totalForeign).toFixed(2),
  ])

  drawTable(doc, columns, rows, branding)

  // Totals — aligned with last table column
  doc.y += 5
  const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const vW = columns[columns.length - 1].width
  const lW = 80
  const lX = tableRight - vW - lW
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text('Subtotal:', lX, doc.y, { width: lW, align: 'right' })
  doc.text(`${Number(so.subtotalForeign).toFixed(2)}${sym}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  if (Number(so.discountAmount) > 0) {
    doc.text('Discount:', lX, doc.y, { width: lW, align: 'right' })
    doc.text(`-${Number(so.discountAmount).toFixed(2)}${sym}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  if (Number(so.shippingForeign) > 0) {
    doc.text('Shipping:', lX, doc.y, { width: lW, align: 'right' })
    doc.text(`${Number(so.shippingForeign).toFixed(2)}${sym}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  if (Number(so.taxForeign) > 0) {
    const taxLabel = (so.taxRateName ?? 'Tax') + (so.taxRatePercent != null ? ` (${(Number(so.taxRatePercent) * 100).toFixed(0)}%)` : '') + ':'
    doc.text(taxLabel, lX, doc.y, { width: lW, align: 'right' })
    doc.text(`${Number(so.taxForeign).toFixed(2)}${sym}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', lX, doc.y + 3, { width: lW, align: 'right' })
  doc.text(`${Number(so.totalForeign).toFixed(2)}${sym}`, tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })

  if (so.notes) {
    doc.y += 15
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('NOTES', 50, doc.y)
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(so.notes, 50, doc.y + 2, { width: 495 })
  }

  const tpl = await db.documentTemplate.findUnique({ where: { type: 'sales_order' }, select: { customFooter: true } })
  drawFooter(doc, 'Thank you for your order.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Order-${so.wcOrderNumber}.pdf"` },
  })
}
