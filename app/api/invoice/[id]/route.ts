import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'
import { loadInvoicePdf } from '@/lib/invoice-pdf'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, groupVatBreakdown, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'
import { formatMoney } from '@/lib/utils'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'

function safeInvoiceFilenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  return safe.length > 0 ? safe : 'invoice'
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const so = await db.salesOrder.findUnique({
    where: { id },
    include: {
      lines: {
        select: {
          description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true, taxForeign: true,
          taxRate: { select: { rate: true } },
        },
      },
    },
  })
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Authenticated singular route; public signed downloads live in sibling /api/invoices/[id].
  // Serve connector-downloaded PDF if available.
  if (so.invoicePdfPath) {
    const pdfBuffer = await loadInvoicePdf(so.id)
    if (pdfBuffer) {
      const invNum = so.invoiceNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Invoice-${safeInvoiceFilenamePart(invNum)}.pdf"` },
      })
    }
  }

  const branding = await getBranding()
  const tpl = await db.documentTemplate.findUnique({
    where: { type: 'invoice' },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
  })
  const invNum = so.invoiceNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Invoice ${invNum}` })

  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, formatCountryDisplay(billAddr.country)].filter(Boolean).join('\n') : ''
  const tz = await getDisplayTimeZone()
  const date = formatDateTime(so.invoicedAt ?? so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)

  await drawHeader(doc, branding, {
    title: 'Invoice',
    reference: invNum,
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })

  if (so.paidAt) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#16a34a').text('PAID', 50, doc.y)
    doc.fillColor('#000')
    doc.y += 8
  }

  // Header note from template
  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  const currencyRow = await db.currency.findUnique({ where: { code: so.currency } })
  const sym = currencyRow?.symbol ?? (so.currency === 'GBP' ? '£' : so.currency)
  const symPos: 'PREFIX' | 'POSTFIX' = currencyRow?.symbolPosition ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 230 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Price (${sym})`, width: 65, align: 'right' },
    { label: `Tax (${sym})`, width: 55, align: 'right' },
    { label: `Total (${sym})`, width: 75, align: 'right' },
  ]

  const rows = so.lines.map((l, i) => [
    String(i + 1), l.description + (l.sku ? ` (${l.sku})` : ''), String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2), Number(l.taxForeign).toFixed(2), Number(l.totalForeign).toFixed(2),
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
    // Build per-rate VAT breakdown. Shipping/fees VAT is tracked on the
    // order, not on lines, so fold it into the default bucket via `extra`.
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

  if (so.currency !== 'GBP') {
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`(GBP equivalent: ${formatMoney(Number(so.totalBase), '£', 'PREFIX')})`, lX, doc.y + 3, { width: lW + vW, align: 'right' })
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

  drawFooter(doc, 'Thank you for your business.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Invoice-${safeInvoiceFilenamePart(invNum)}.pdf"` },
  })
}
