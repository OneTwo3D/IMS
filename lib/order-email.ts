import { db } from '@/lib/db'
import { renderEmailHtml } from '@/lib/email-template'
import { loadInvoicePdf } from '@/lib/invoice-pdf'
import { formatCountryDisplay } from '@/lib/countries'
import {
  createPdfDocument,
  drawFooter,
  drawHeader,
  drawTable,
  getBranding,
  pdfToBuffer,
  type PdfTableColumn,
} from '@/lib/pdf'
import { formatMoney, type SymbolPos } from '@/lib/utils'
import { formatDateTime } from '@/lib/format-datetime'
import { getDisplayTimeZone } from '@/lib/display-timezone'

type EmailAttachment = { filename: string; content: Buffer; contentType?: string }
type PreparedEmail = { to: string; subject: string; html: string; attachments?: EmailAttachment[] }
type QueueEmailData = { to: string; subject: string; reference: string }

type SoForPdf = {
  id: string
  externalOrderNumber: string | null
  orderNumber?: string | null
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
  discountAmount: unknown
  invoiceNumber: string | null
  invoicedAt: Date | null
  paidAt: Date | null
  expectedDelivery: Date | null
  notes: string | null
  createdAt: Date
  invoicePdfPath?: string | null
  lines: {
    description: string
    sku: string | null
    qty: unknown
    unitPriceForeign: unknown
    discountAmount: unknown
    totalForeign: unknown
    taxForeign?: unknown
  }[]
}

async function getCurrencyFormat(code: string): Promise<{ sym: string; symPos: SymbolPos; money: (n: number) => string }> {
  const row = await db.currency.findUnique({ where: { code } })
  const sym = row?.symbol ?? (code === 'GBP' ? '£' : code)
  const symPos: SymbolPos = row?.symbolPosition ?? 'PREFIX'
  return { sym, symPos, money: (n: number) => formatMoney(n, sym, symPos) }
}

async function getTemplate(type: string) {
  return db.documentTemplate.findUnique({
    where: { type },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
  })
}

async function getSalesOrderEmailOrder(orderId: string): Promise<SoForPdf | null> {
  return db.salesOrder.findUnique({
    where: { id: orderId },
    include: {
      lines: {
        select: {
          description: true,
          sku: true,
          qty: true,
          unitPriceForeign: true,
          discountAmount: true,
          totalForeign: true,
          taxForeign: true,
        },
      },
    },
  })
}

async function generateSalesOrderPdf(so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  const tpl = await getTemplate('sales_order')
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

  const { sym, symPos } = await getCurrencyFormat(so.currency)
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Description', width: 195, wrap: true },
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
  drawTotals(doc, so, sym, symPos, columns)

  if (tpl?.footerNote) {
    doc.y += 10
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.footerNote, 50, doc.y, { width: 495 })
  }
  if (tpl?.termsText) {
    doc.y += 10
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.font('Helvetica').fontSize(7).fillColor('#888').text(tpl.termsText, 50, doc.y + 2, { width: 495 })
  }
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
  const tz = await getDisplayTimeZone()
  const invNum = so.invoiceNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Invoice ${invNum}` })
  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, formatCountryDisplay(billAddr.country)].filter(Boolean).join('\n') : ''
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

  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  const { sym, symPos } = await getCurrencyFormat(so.currency)
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 230, wrap: true },
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
    Number(l.taxForeign ?? 0).toFixed(2),
    Number(l.totalForeign).toFixed(2),
  ])
  drawTable(doc, columns, rows, branding)
  drawTotals(doc, so, sym, symPos, columns)

  if (so.currency !== 'GBP') {
    const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
    const vW = columns[columns.length - 1].width
    const lW = 80
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`(GBP equivalent: ${formatMoney(Number(so.totalBase), '£', 'PREFIX')})`, tableRight - vW - lW, doc.y + 3, { width: lW + vW, align: 'right' })
  }

  if (tpl?.footerNote) {
    doc.y += 10
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.footerNote, 50, doc.y, { width: 495 })
  }
  if (tpl?.termsText) {
    doc.y += 10
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.font('Helvetica').fontSize(7).fillColor('#888').text(tpl.termsText, 50, doc.y + 2, { width: 495 })
  }
  if (tpl?.showPaymentTerms && tpl?.paymentTermsText) {
    doc.y += 8
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Payment terms: ${tpl.paymentTermsText}`, 50, doc.y)
  }

  drawFooter(doc, 'Thank you for your business.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}

function drawTotals(doc: PDFKit.PDFDocument, so: SoForPdf, sym: string, symPos: SymbolPos, columns: PdfTableColumn[]) {
  const money = (n: number) => formatMoney(n, sym, symPos)
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
    const taxLabel = (so.taxRateName ?? 'Tax') + (so.taxRatePercent != null ? ` (${(Number(so.taxRatePercent) * 100).toFixed(0)}%)` : '') + ':'
    doc.text(taxLabel, lX, doc.y, { width: lW, align: 'right' })
    doc.text(money(Number(so.taxForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', lX, doc.y + 3, { width: lW, align: 'right' })
  doc.text(money(Number(so.totalForeign)), tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
}

async function buildSalesOrderConfirmationEmail(orderId: string): Promise<PreparedEmail> {
  const so = await getSalesOrderEmailOrder(orderId)
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')

  const branding = await getBranding()
  const ref = so.externalOrderNumber ?? so.id.slice(0, 8)
  const { money } = await getCurrencyFormat(so.currency)
  const pdfBuffer = await generateSalesOrderPdf(so, branding)
  const tz = await getDisplayTimeZone()
  const date = formatDateTime(so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date,
    subject: `Order Confirmation ${ref}`,
    bodyLines: [
      `Thank you for your order ${ref}.`,
      `Please find your order confirmation attached for ${money(Number(so.totalForeign))}.`,
      'If you have any questions, please don\'t hesitate to contact us.',
    ],
  }, 'sales_order')

  return {
    to: so.customerEmail,
    subject: `Order Confirmation ${ref}`,
    html,
    attachments: [{ filename: `Order-${ref}.pdf`, content: pdfBuffer }],
  }
}

async function buildInvoiceEmail(orderId: string, options?: { accountingPdf?: boolean }): Promise<PreparedEmail> {
  const so = await getSalesOrderEmailOrder(orderId)
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')

  const branding = await getBranding()
  const ref = so.invoiceNumber ?? so.orderNumber ?? so.externalOrderNumber ?? orderId.slice(0, 8)
  const { money } = await getCurrencyFormat(so.currency)
  const pdfBuffer = options?.accountingPdf
    ? await loadInvoicePdf(orderId)
    : await generateInvoicePdf(so, branding)
  if (!pdfBuffer) {
    throw new Error(options?.accountingPdf ? 'Invoice PDF file not found on disk' : 'Failed to generate invoice PDF')
  }

  const tz = await getDisplayTimeZone()
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date: formatDateTime(so.invoicedAt ?? so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    subject: `Invoice ${ref}`,
    bodyLines: [
      `Please find attached your invoice ${ref} for ${money(Number(so.totalForeign))}.`,
      so.paidAt ? 'This invoice has been paid. Thank you.' : 'Payment is due within 30 days of the invoice date.',
      'If you have any questions regarding this invoice, please don\'t hesitate to contact us.',
    ],
  }, 'invoice')

  return {
    to: so.customerEmail,
    subject: `Invoice ${ref}`,
    html,
    attachments: [{ filename: `Invoice-${ref}.pdf`, content: pdfBuffer }],
  }
}

export async function getSalesOrderConfirmationQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, externalOrderNumber: true, customerEmail: true },
  })
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')
  const ref = so.externalOrderNumber ?? so.id.slice(0, 8)
  return { to: so.customerEmail, subject: `Order Confirmation ${ref}`, reference: ref }
}

export async function getInvoiceQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, invoiceNumber: true, customerEmail: true },
  })
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')
  if (!so.invoiceNumber) throw new Error('No invoice generated yet')
  return { to: so.customerEmail, subject: `Invoice ${so.invoiceNumber}`, reference: so.invoiceNumber }
}

export async function getAccountingInvoiceQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, externalOrderNumber: true, invoiceNumber: true, customerEmail: true, invoicePdfPath: true },
  })
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')
  if (!so.invoicePdfPath) throw new Error('No invoice PDF available')
  const ref = so.invoiceNumber ?? so.orderNumber ?? so.externalOrderNumber ?? orderId.slice(0, 8)
  return { to: so.customerEmail, subject: `Invoice ${ref}`, reference: ref }
}

export async function prepareQueuedEmail(kind: string, referenceType: string | null, referenceId: string | null): Promise<PreparedEmail | null> {
  if (referenceType !== 'SalesOrder' || !referenceId) return null
  if (kind === 'SALES_ORDER_CONFIRMATION') return buildSalesOrderConfirmationEmail(referenceId)
  if (kind === 'INVOICE') return buildInvoiceEmail(referenceId)
  if (kind === 'ACCOUNTING_INVOICE') return buildInvoiceEmail(referenceId, { accountingPdf: true })
  return null
}
