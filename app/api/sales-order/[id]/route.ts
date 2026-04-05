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

  // Totals
  doc.y += 5
  const rX = 395
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text(`Subtotal:`, rX, doc.y, { width: 60, align: 'right' })
  doc.text(`${Number(so.subtotalForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  if (Number(so.discountAmount) > 0) {
    doc.text(`Discount:`, rX, doc.y, { width: 60, align: 'right' })
    doc.text(`-${Number(so.discountAmount).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  if (Number(so.shippingForeign) > 0) {
    doc.text(`Shipping:`, rX, doc.y, { width: 60, align: 'right' })
    doc.text(`${Number(so.shippingForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  if (Number(so.taxForeign) > 0) {
    const taxLabel = (so.taxRateName ?? 'Tax') + (so.taxRatePercent != null ? ` (${(Number(so.taxRatePercent) * 100).toFixed(0)}%)` : '') + ':'
    doc.text(taxLabel, rX - 20, doc.y, { width: 80, align: 'right' })
    doc.text(`${Number(so.taxForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text(`Total:`, rX, doc.y + 3, { width: 60, align: 'right' })
  doc.text(`${Number(so.totalForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })

  if (so.notes) {
    doc.y += 15
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('NOTES', 50, doc.y)
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(so.notes, 50, doc.y + 2, { width: 495 })
  }

  drawFooter(doc, 'Thank you for your order.', branding)
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Order-${so.wcOrderNumber}.pdf"` },
  })
}
