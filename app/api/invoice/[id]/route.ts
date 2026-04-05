import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const so = await db.salesOrder.findUnique({
    where: { id },
    include: { lines: { select: { description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true, taxForeign: true } } },
  })
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const branding = await getBranding()
  const invNum = so.invoiceNumber ?? so.wcOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Invoice ${invNum}` })

  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, billAddr.country].filter(Boolean).join(', ') : ''
  const date = (so.invoicedAt ?? so.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  drawHeader(doc, branding, {
    title: 'Invoice',
    reference: invNum,
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  if (so.paidAt) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#16a34a')
      .text('PAID', 50, doc.y)
    doc.fillColor('#000')
    doc.y += 8
  }

  const sym = so.currency === 'GBP' ? '£' : so.currency
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 230 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Price (${sym})`, width: 65, align: 'right' },
    { label: `Tax (${sym})`, width: 55, align: 'right' },
    { label: `Total (${sym})`, width: 75, align: 'right' },
  ]

  const rows = so.lines.map((l, i) => [
    String(i + 1),
    l.description + (l.sku ? ` (${l.sku})` : ''),
    String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.taxForeign).toFixed(2),
    Number(l.totalForeign).toFixed(2),
  ])

  drawTable(doc, columns, rows, branding)

  doc.y += 5
  const rX = 395
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text('Subtotal:', rX, doc.y, { width: 60, align: 'right' })
  doc.text(`${Number(so.subtotalForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  if (Number(so.discountAmount) > 0) {
    doc.text('Discount:', rX, doc.y, { width: 60, align: 'right' })
    doc.text(`-${Number(so.discountAmount).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  if (Number(so.shippingForeign) > 0) {
    doc.text('Shipping:', rX, doc.y, { width: 60, align: 'right' })
    doc.text(`${Number(so.shippingForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  if (Number(so.taxForeign) > 0) {
    const taxLabel = (so.taxRateName ?? 'Tax') + (so.taxRatePercent != null ? ` (${(Number(so.taxRatePercent) * 100).toFixed(0)}%)` : '') + ':'
    doc.text(taxLabel, rX - 20, doc.y, { width: 80, align: 'right' })
    doc.text(`${Number(so.taxForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', rX, doc.y + 3, { width: 60, align: 'right' })
  doc.text(`${Number(so.totalForeign).toFixed(2)}${sym}`, rX + 65, doc.y - doc.currentLineHeight(), { width: 50, align: 'right' })

  if (so.currency !== 'GBP') {
    doc.font('Helvetica').fontSize(8).fillColor('#888')
    doc.text(`(GBP equivalent: £${Number(so.totalGbp).toFixed(2)})`, rX, doc.y + 3, { width: 115, align: 'right' })
  }

  drawFooter(doc, 'Thank you for your business.', branding)
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Invoice-${invNum}.pdf"` },
  })
}
