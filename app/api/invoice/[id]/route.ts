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

  // Totals — aligned with the last table column
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

  if (so.currency !== 'GBP') {
    doc.font('Helvetica').fontSize(8).fillColor('#888')
    doc.text(`(GBP equivalent: £${Number(so.totalGbp).toFixed(2)})`, lX, doc.y + 3, { width: lW + vW, align: 'right' })
  }

  const tpl = await db.documentTemplate.findUnique({ where: { type: 'invoice' }, select: { customFooter: true } })
  drawFooter(doc, 'Thank you for your business.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Invoice-${invNum}.pdf"` },
  })
}
