'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { sendEmail } from '@/lib/mailer'
import { renderEmailHtml, type EmailTemplateType } from '@/lib/email-template'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// Send sales order email with PDF attachment
// ---------------------------------------------------------------------------

export async function sendSalesOrderEmail(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' }
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      include: {
        shipFromWarehouse: { select: { name: true } },
        lines: { select: { description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true } },
      },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!so.customerEmail) return { success: false, error: 'No customer email address' }

    const branding = await getBranding()
    const ref = so.wcOrderNumber ?? so.id.slice(0, 8)
    const sym = so.currency === 'GBP' ? '£' : so.currency

    // Generate PDF
    const pdfBuffer = await generateSalesOrderPdf(so, branding)

    // Generate email HTML
    const date = so.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const html = await renderEmailHtml(branding, {
      recipientName: so.customerName ?? 'Customer',
      recipientEmail: so.customerEmail,
      reference: ref,
      date,
      subject: `Order Confirmation ${ref}`,
      bodyLines: [
        `Thank you for your order ${ref}.`,
        `Please find your order confirmation attached for ${sym}${Number(so.totalForeign).toFixed(2)}.`,
        'If you have any questions, please don\'t hesitate to contact us.',
      ],
    }, 'sales_order')

    const result = await sendEmail({
      to: so.customerEmail,
      subject: `Order Confirmation ${ref}`,
      html,
      attachments: [{ filename: `Order-${ref}.pdf`, content: pdfBuffer }],
    })

    if (result.success) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'emailed', tag: 'sales', level: 'INFO',
        description: `Emailed order confirmation ${ref} to ${so.customerEmail}`,
      })
    }

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Send invoice email with PDF attachment
// ---------------------------------------------------------------------------

export async function sendInvoiceEmail(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' }
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      include: {
        lines: { select: { description: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true, taxForeign: true } },
      },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!so.customerEmail) return { success: false, error: 'No customer email address' }
    if (!so.invoiceNumber) return { success: false, error: 'No invoice generated yet' }

    const branding = await getBranding()
    const sym = so.currency === 'GBP' ? '£' : so.currency

    // Generate PDF
    const pdfBuffer = await generateInvoicePdf(so, branding)

    // Generate email HTML
    const date = (so.invoicedAt ?? so.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const html = await renderEmailHtml(branding, {
      recipientName: so.customerName ?? 'Customer',
      recipientEmail: so.customerEmail,
      reference: so.invoiceNumber,
      date,
      subject: `Invoice ${so.invoiceNumber}`,
      bodyLines: [
        `Please find attached your invoice ${so.invoiceNumber} for ${sym}${Number(so.totalForeign).toFixed(2)}.`,
        so.paidAt ? 'This invoice has been marked as paid. Thank you.' : 'Payment is due within 30 days of the invoice date.',
        'If you have any questions regarding this invoice, please don\'t hesitate to contact us.',
      ],
    }, 'invoice')

    const result = await sendEmail({
      to: so.customerEmail,
      subject: `Invoice ${so.invoiceNumber}`,
      html,
      attachments: [{ filename: `Invoice-${so.invoiceNumber}.pdf`, content: pdfBuffer }],
    })

    if (result.success) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_emailed', tag: 'sales', level: 'INFO',
        description: `Emailed invoice ${so.invoiceNumber} to ${so.customerEmail}`,
      })
    }

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// PDF generation helpers (shared with route handlers)
// ---------------------------------------------------------------------------

type SoForPdf = {
  id: string
  wcOrderNumber: string | null
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
  totalGbp: unknown
  discountAmount: unknown
  invoiceNumber: string | null
  invoicedAt: Date | null
  paidAt: Date | null
  expectedDelivery: Date | null
  notes: string | null
  createdAt: Date
  lines: { description: string; sku: string | null; qty: unknown; unitPriceForeign: unknown; discountAmount: unknown; totalForeign: unknown; taxForeign?: unknown }[]
}

async function getTemplate(type: string) {
  return db.documentTemplate.findUnique({
    where: { type },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
  })
}

async function generateSalesOrderPdf(so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  const tpl = await getTemplate('sales_order')
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
    String(i + 1), l.sku ?? '', l.description, String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    Number(l.discountAmount) > 0 ? `-${Number(l.discountAmount).toFixed(2)}` : '',
    Number(l.totalForeign).toFixed(2),
  ])
  drawTable(doc, columns, rows, branding)

  drawTotals(doc, so, sym, columns)

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
  return pdfToBuffer(doc)
}

async function generateInvoicePdf(so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  const tpl = await getTemplate('invoice')
  const invNum = so.invoiceNumber ?? so.wcOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Invoice ${invNum}` })
  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, billAddr.country].filter(Boolean).join('\n') : ''
  const date = (so.invoicedAt ?? so.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

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
    String(i + 1), l.description + (l.sku ? ` (${l.sku})` : ''), String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2), Number(l.taxForeign ?? 0).toFixed(2), Number(l.totalForeign).toFixed(2),
  ])
  drawTable(doc, columns, rows, branding)

  drawTotals(doc, so, sym, columns)

  if (so.currency !== 'GBP') {
    const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
    const vW = columns[columns.length - 1].width
    const lW = 80
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`(GBP equivalent: £${Number(so.totalGbp).toFixed(2)})`, tableRight - vW - lW, doc.y + 3, { width: lW + vW, align: 'right' })
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
  return pdfToBuffer(doc)
}

function drawTotals(doc: PDFKit.PDFDocument, so: SoForPdf, sym: string, columns: PdfTableColumn[]) {
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
}
