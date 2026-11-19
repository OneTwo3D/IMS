import { db } from '@/lib/db'
import { EmailRecipientErasedError } from '@/lib/domain/erasure/email-recipient'
import { assertNoStoreCreditInvoiceDocument } from '@/lib/domain/accounting/store-credit-invoice-refusal'
import { renderEmailHtml } from '@/lib/email-template'
import { loadCurrentInvoicePdf } from '@/lib/domain/invoice-documents/current-document'
import { isInvoiceDocumentPublishingEnabled } from '@/lib/domain/invoice-documents/publishing-switch'
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
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { orderDocumentMoney, drawTotalsRows, invoiceDocumentIdentity, invoiceLineVatDetail } from '@/lib/pdf-order-money'
import { getBaseCurrencyDisplay } from '@/lib/base-currency'
import { formatDateTime } from '@/lib/format-datetime'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { getTrackingUrl } from '@/lib/tracking'
import { getCurrencyFormat, renderSalesOrderPdf, SALES_ORDER_PDF_LINE_SELECT, type SalesOrderPdfSource } from '@/lib/sales-order-pdf'
import { EmailKindDisabledError } from '@/lib/email-kind-disabled'
import { isStorefrontCustomerEmailEnabled } from '@/lib/domain/storefront-customer-email/switch'
import {
  STOREFRONT_CONFIRMATION_KIND,
  STOREFRONT_CUSTOMER_EMAIL_DISABLED_REASON,
  STOREFRONT_DELIVERED_KIND,
  shipmentIdOfPartialKind,
} from '@/lib/domain/storefront-customer-email/constants'
import { buildSalesQuoteEmail } from '@/lib/sales-quote-email'
import { buildPurchaseOrderEmail, PURCHASE_ORDER_EMAIL_KIND, PURCHASE_ORDER_EMAIL_REFERENCE_TYPE } from '@/lib/purchase-order-email'

type EmailAttachment = { filename: string; content: Buffer; contentType?: string }
export type SendGuardOutcome<T> = { refused: string; unknown?: undefined } | { unknown: string; refused?: undefined } | { refused?: undefined; unknown?: undefined; value: T }
/**
 * Optional hook on a prepared email: the drain runs its send INSIDE this, so a kind switched off by a setting can be re-checked at the delivery
 * boundary and held against a concurrent switch-off. A refusal means nothing was sent.
 */
type SendGuard = <T>(send: (signal: AbortSignal) => Promise<T>) => Promise<SendGuardOutcome<T>>
export type PreparedEmail = { to: string; subject: string; html: string; attachments?: EmailAttachment[]; sendGuard?: SendGuard; sendDeadlineMs?: number; singleSend?: boolean }
type QueueEmailData = { to: string; subject: string; reference: string }

type SoForPdf = SalesOrderPdfSource

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
      shoppingLinks: { select: { connector: true } },
      lines: { select: SALES_ORDER_PDF_LINE_SELECT },
    },
  })
}

async function generateSalesOrderPdf(so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  return renderSalesOrderPdf(so, branding, { variant: 'order' })
}

async function generateInvoicePdf(so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  const tpl = await getTemplate('invoice')
  const tz = await getDisplayTimeZone()
  const identity = invoiceDocumentIdentity(so)
  const invNum = identity.reference
  const { doc } = createPdfDocument({ title: `${identity.title} ${invNum}` })
  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, formatCountryDisplay(billAddr.country)].filter(Boolean).join('\n') : ''
  const date = formatDateTime(so.invoicedAt ?? so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)

  await drawHeader(doc, branding, {
    title: identity.title,
    reference: invNum,
    ...(identity.orderReference ? { secondaryReference: { label: 'Order', value: identity.orderReference } } : {}),
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
  const { view, totalsRows } = orderDocumentMoney(so)
  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 190, wrap: true },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Price ${view.basisLabel} (${sym})`, width: 65, align: 'right' },
    { label: 'VAT rate', width: 40, align: 'right' },
    { label: `${view.vatIsAdditional ? 'VAT' : 'incl. VAT'} (${sym})`, width: 55, align: 'right' },
    { label: `Total ${view.basisLabel} (${sym})`, width: 75, align: 'right' },
  ]
  const vatDetail = invoiceLineVatDetail(so.lines)
  const rows = so.lines.map((l, i) => [
    String(i + 1),
    l.description + (l.sku ? ` (${l.sku})` : ''),
    String(Number(l.qty)),
    Number(l.unitPriceForeign).toFixed(2),
    vatDetail.rateCells[i],
    Number(l.taxForeign ?? 0).toFixed(2),
    view.lines[i].total.toFixed(2),
  ])
  drawTable(doc, columns, rows, branding)
  // A wrapped description column can leave the table ending near the page bottom;
  // keep the totals block together rather than splitting it across the page break.
  if (doc.y + 90 > 780) doc.addPage()
  drawTotalsRows(doc, totalsRows, (v) => formatMoney(v, sym, symPos), columns)
  if (vatDetail.reverseChargeNote) doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(vatDetail.reverseChargeNote, 50, doc.y + 6, { width: 495 })

  const base = await getBaseCurrencyDisplay()
  if (so.currency !== base.code) {
    const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
    const vW = columns[columns.length - 1].width
    const lW = 80
    const baseMoney = (n: number) => formatMoney(n, base.symbol, base.symbolPosition)
    // Total + VAT in the base currency on one line, e.g. "(GBP equivalent £80.73, 20% VAT £13.46)".
    const equivParts = [`${base.code} equivalent ${baseMoney(Number(so.totalBase))}`]
    if (Number(so.taxForeign) > 0) {
      const vatPct = so.taxRatePercent != null ? `${(Number(so.taxRatePercent) * 100).toFixed(0)}% ` : ''
      equivParts.push(`${vatPct}VAT ${baseMoney(Number(so.taxBase))}`)
    }
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`(${equivParts.join(', ')})`, tableRight - vW - lW, doc.y + 3, { width: lW + vW, align: 'right' })
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

async function buildSalesOrderConfirmationEmail(orderId: string): Promise<PreparedEmail> {
  const so = await getSalesOrderEmailOrder(orderId)
  if (!so) throw new Error('Order not found')
  // At send time too: a confirmation queued before the order was a quote is not sent for the quote.
  if ((so as { isQuote?: boolean }).isQuote) throw new Error('This is a quote, not an order: no order confirmation is sent for a quote')
  if (!so.customerEmail) throw new Error('No customer email address')

  const branding = await getBranding()
  const ref = getSalesOrderReference(so)
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

/**
 * The PDF the `INVOICE` e-mail (the manual and the queued customer invoice mail, ownership row `customer-email.invoice`) attaches.
 *
 * SWITCH OFF (`wc_invoice_document_enabled`, the default): exactly what it always was, the invoice IMS renders itself.
 * SWITCH ON: the ONE customer invoice, the ledger's own PDF IMS stored (the same file the My Account button serves, through the same reader
 * and its refusals), so the customer is never mailed a different rendering of the number. If IMS holds a stored document for the order that it
 * will not serve right now (withdrawn, changed since, number shared, file missing or altered), the mail is NOT sent with a rendering of its own: it
 * fails and stays queued for the next attempt, after the recheck has had its chance. An order with no stored document and no flat file
 * (IMS has not fetched it yet) keeps the rendering it always had.
 */
async function invoiceEmailPdf(orderId: string, so: SoForPdf, branding: Awaited<ReturnType<typeof getBranding>>): Promise<Buffer> {
  if (await isInvoiceDocumentPublishingEnabled()) {
    const stored = await loadCurrentInvoicePdf(orderId)
    if (stored) return stored
    const held = await db.salesOrderInvoiceDocument.findFirst({ where: { orderId, kind: 'INVOICE', refundId: null, supersededAt: null }, select: { id: true } })
    if (held) {
      throw new Error('The stored invoice document is not available to send right now (withdrawn, changed, shared or its file is not intact); the invoice e-mail waits rather than attaching a different rendering of the invoice')
    }
  }
  return generateInvoicePdf(so, branding)
}

async function buildInvoiceEmail(orderId: string, options?: { accountingPdf?: boolean }): Promise<PreparedEmail> {
  const so = await getSalesOrderEmailOrder(orderId)
  if (!so) throw new Error('Order not found')
  // At the OUTBOX preparation step too, so a row queued before the order was held, or retried later, is refused as well.
  assertNoStoreCreditInvoiceDocument(so)
  if (!so.customerEmail) throw new Error('No customer email address')

  const branding = await getBranding()
  const ref = so.invoiceNumber ?? so.orderNumber ?? so.externalOrderNumber ?? orderId.slice(0, 8)
  const { money } = await getCurrencyFormat(so.currency)
  const pdfBuffer = options?.accountingPdf
    ? await loadCurrentInvoicePdf(orderId)
    : await invoiceEmailPdf(orderId, so, branding)
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

async function buildDispatchEmail(orderId: string): Promise<PreparedEmail> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      customerName: true,
      customerEmail: true,
      shippedAt: true,
      trackingNumber: true,
      shippingService: true,
      createdAt: true,
      lines: { select: { description: true, sku: true, qty: true } },
      shipments: {
        where: { status: 'SHIPPED' },
        select: { trackingNumber: true, shippingService: true },
      },
      _count: { select: { shoppingLinks: true } },
    },
  })
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')
  // Re-check at send time: an order that is (or became) storefront-linked is mailed only while IMS sends the storefront customer e-mails (the
  // switch, read now); otherwise the storefront sends its own dispatch email and this stays silent rather than double-emailing the customer.
  const storefront = so._count.shoppingLinks > 0
  if (storefront && !(await isStorefrontCustomerEmailEnabled())) throw new EmailKindDisabledError(STOREFRONT_CUSTOMER_EMAIL_DISABLED_REASON)

  const branding = await getBranding()
  const ref = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const tz = await getDisplayTimeZone()
  const date = formatDateTime(so.shippedAt ?? new Date(), { day: 'numeric', month: 'long', year: 'numeric' }, tz)

  // Shipment-level tracking first; fall back to the order-level fields set by
  // reconcileOrderAfterShipment for legacy/manual flows.
  const trackingEntries = so.shipments
    .filter((s) => s.trackingNumber)
    .map((s) => ({ trackingNumber: s.trackingNumber!, carrier: s.shippingService ?? so.shippingService }))
  if (trackingEntries.length === 0 && so.trackingNumber) {
    trackingEntries.push({ trackingNumber: so.trackingNumber, carrier: so.shippingService })
  }

  const itemLines = so.lines.map((l) => `${Number(l.qty)} × ${l.description}${l.sku ? ` (${l.sku})` : ''}`)
  const trackingLines = trackingEntries.map((t) =>
    t.carrier ? `${t.carrier} — tracking number ${t.trackingNumber}` : `Tracking number ${t.trackingNumber}`)

  // getTrackingUrl returns null when the carrier is blank; a tracking number
  // is still useful, so fall back to the same universal tracker it uses for
  // unknown carriers.
  const firstTracked = trackingEntries[0]
  const trackingUrl = firstTracked
    ? getTrackingUrl(firstTracked.carrier, firstTracked.trackingNumber)
      ?? `https://t.17track.net/en#nums=${encodeURIComponent(firstTracked.trackingNumber)}`
    : null

  const subject = `Your order ${ref} has been dispatched`
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date,
    subject,
    bodyLines: [
      `Good news — your order ${ref} has been dispatched.`,
      ...(itemLines.length > 0 ? ['Items in this order:', ...itemLines] : []),
      ...trackingLines,
      ...(trackingUrl ? ['You can follow your delivery using the tracking link below.'] : []),
      'If you have any questions about your delivery, please don\'t hesitate to contact us.',
    ],
    ...(trackingUrl ? { ctaLabel: 'Track your delivery', ctaUrl: trackingUrl } : {}),
    hideAttachmentNote: true,
  })

  return { to: so.customerEmail, subject, html, ...(storefront ? STOREFRONT_SINGLE_SEND : {}) }
}

/** A storefront customer e-mail is a SINGLE SEND: a send that may have been accepted but whose outcome is unknown is terminal and never retried (the customer would get it twice). */
export const STOREFRONT_EMAIL_SEND_DEADLINE_MS = 60_000
const STOREFRONT_SINGLE_SEND = { singleSend: true, sendDeadlineMs: STOREFRONT_EMAIL_SEND_DEADLINE_MS } as const

async function assertStorefrontEmailOn(): Promise<void> {
  // Checked at SEND time, so a row queued before the switch was turned off is refused too (the drain settles it FAILED, address kept, nothing sent).
  if (!(await isStorefrontCustomerEmailEnabled())) throw new EmailKindDisabledError(STOREFRONT_CUSTOMER_EMAIL_DISABLED_REASON)
}

async function buildStorefrontConfirmationEmail(orderId: string): Promise<PreparedEmail> {
  await assertStorefrontEmailOn()
  const so = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true, _count: { select: { shoppingLinks: true } } } })
  if (!so) throw new Error('Order not found')
  if (so._count.shoppingLinks === 0) throw new Error('Order is not a storefront order; the storefront confirmation is not sent')
  if (so.status === 'CANCELLED') throw new Error('Order is cancelled; no confirmation is sent')
  return { ...(await buildSalesOrderConfirmationEmail(orderId)), ...STOREFRONT_SINGLE_SEND }
}

async function loadStorefrontShipmentOrder(orderId: string) {
  return db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, externalOrderNumber: true, customerName: true, customerEmail: true, status: true, shippedAt: true,
      trackingNumber: true, shippingService: true,
      _count: { select: { shoppingLinks: true } },
    },
  })
}

function trackingBlock(entries: { trackingNumber: string; carrier: string | null }[]): { lines: string[]; cta: { ctaLabel: string; ctaUrl: string } | null } {
  const lines = entries.map((t) => (t.carrier ? `${t.carrier} — tracking number ${t.trackingNumber}` : `Tracking number ${t.trackingNumber}`))
  const first = entries[0]
  const url = first ? getTrackingUrl(first.carrier, first.trackingNumber) ?? `https://t.17track.net/en#nums=${encodeURIComponent(first.trackingNumber)}` : null
  return { lines, cta: url ? { ctaLabel: 'Track your delivery', ctaUrl: url } : null }
}

async function buildStorefrontPartialShipmentEmail(orderId: string, shipmentId: string): Promise<PreparedEmail> {
  await assertStorefrontEmailOn()
  const so = await loadStorefrontShipmentOrder(orderId)
  if (!so) throw new Error('Order not found')
  if (so._count.shoppingLinks === 0) throw new Error('Order is not a storefront order; the partial-shipment e-mail is not sent')
  if (!so.customerEmail) throw new Error('No customer email address')
  const shipment = await db.shipment.findUnique({
    where: { id: shipmentId },
    select: { orderId: true, status: true, trackingNumber: true, shippingService: true, shippedAt: true, lines: { select: { qty: true, line: { select: { description: true, sku: true } } } } },
  })
  if (!shipment || shipment.orderId !== orderId) throw new Error('Shipment not found on this order')
  if (shipment.status !== 'SHIPPED') throw new Error('Shipment has not been despatched; no partial-shipment e-mail is sent')

  const branding = await getBranding()
  const ref = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const tz = await getDisplayTimeZone()
  const entries = shipment.trackingNumber ? [{ trackingNumber: shipment.trackingNumber, carrier: shipment.shippingService ?? so.shippingService }] : []
  const { lines: trackingLines, cta } = trackingBlock(entries)
  const itemLines = shipment.lines.map((l) => `${Number(l.qty)} × ${l.line.description}${l.line.sku ? ` (${l.line.sku})` : ''}`)
  const subject = `Part of your order ${ref} has been dispatched`
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date: formatDateTime(shipment.shippedAt ?? new Date(), { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    subject,
    bodyLines: [
      `Part of your order ${ref} has been dispatched. The rest will follow in a separate delivery.`,
      ...(itemLines.length > 0 ? ['In this delivery:', ...itemLines] : []),
      ...trackingLines,
      'If you have any questions about your delivery, please don\'t hesitate to contact us.',
    ],
    ...(cta ?? {}),
    hideAttachmentNote: true,
  })
  return { to: so.customerEmail, subject, html, ...STOREFRONT_SINGLE_SEND }
}

async function buildStorefrontDeliveredEmail(orderId: string): Promise<PreparedEmail> {
  await assertStorefrontEmailOn()
  const so = await loadStorefrontShipmentOrder(orderId)
  if (!so) throw new Error('Order not found')
  if (so._count.shoppingLinks === 0) throw new Error('Order is not a storefront order; the delivered e-mail is not sent')
  if (!so.customerEmail) throw new Error('No customer email address')
  if (so.status !== 'DELIVERED') throw new Error(`Order is ${so.status}, not delivered; no delivered e-mail is sent`)
  const branding = await getBranding()
  const ref = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const tz = await getDisplayTimeZone()
  const subject = `Your order ${ref} has been delivered`
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date: formatDateTime(new Date(), { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    subject,
    bodyLines: [
      `Your order ${ref} has been delivered.`,
      'If anything is not as it should be, please reply to this email and we will put it right.',
    ],
    hideAttachmentNote: true,
  })
  return { to: so.customerEmail, subject, html, ...STOREFRONT_SINGLE_SEND }
}

export async function getSalesOrderConfirmationQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, externalOrderNumber: true, customerEmail: true, isQuote: true },
  })
  if (!so) throw new Error('Order not found')
  if (so.isQuote) throw new Error('This is a quote, not an order: use Send quote. No order confirmation is sent for a quote.')
  if (!so.customerEmail) throw new Error('No customer email address')
  const ref = getSalesOrderReference(so)
  return { to: so.customerEmail, subject: `Order Confirmation ${ref}`, reference: ref }
}

export async function getInvoiceQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, invoiceNumber: true, customerEmail: true, storeCreditForeign: true, storeCreditAssessment: true },
  })
  if (!so) throw new Error('Order not found')
  assertNoStoreCreditInvoiceDocument(so)
  if (!so.customerEmail) throw new Error('No customer email address')
  if (!so.invoiceNumber) throw new Error('No invoice generated yet')
  return { to: so.customerEmail, subject: `Invoice ${so.invoiceNumber}`, reference: so.invoiceNumber }
}

export async function getAccountingInvoiceQueueData(orderId: string): Promise<QueueEmailData> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, externalOrderNumber: true, invoiceNumber: true, customerEmail: true, invoicePdfPath: true, storeCreditForeign: true, storeCreditAssessment: true },
  })
  if (!so) throw new Error('Order not found')
  assertNoStoreCreditInvoiceDocument(so)
  if (!so.customerEmail) throw new Error('No customer email address')
  if (!so.invoicePdfPath) throw new Error('No invoice PDF available')
  const ref = so.invoiceNumber ?? so.orderNumber ?? so.externalOrderNumber ?? orderId.slice(0, 8)
  return { to: so.customerEmail, subject: `Invoice ${ref}`, reference: ref }
}

export async function prepareQueuedEmail(kind: string, referenceType: string | null, referenceId: string | null): Promise<PreparedEmail | null> {
  if (referenceType === PURCHASE_ORDER_EMAIL_REFERENCE_TYPE && kind === PURCHASE_ORDER_EMAIL_KIND && referenceId) return buildPurchaseOrderEmail(referenceId)
  if (referenceType !== 'SalesOrder' || !referenceId) return null
  // ERASURE GATE, before the kind is even looked at: a kind this function does not prepare returns null and the drain
  // then sends to the STORED address, so the refusal cannot live inside the per-kind builders.
  const subject = await db.salesOrder.findUnique({
    where: { id: referenceId },
    select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } },
  })
  if (subject?.erasedAt || subject?.customer?.gdprAnonymisedAt) throw new EmailRecipientErasedError('The order\'s personal data was erased')
  if (kind === 'SALES_ORDER_CONFIRMATION') return buildSalesOrderConfirmationEmail(referenceId)
  if (kind === 'INVOICE') return buildInvoiceEmail(referenceId)
  if (kind === 'ACCOUNTING_INVOICE') return buildInvoiceEmail(referenceId, { accountingPdf: true })
  if (kind === 'SHIPMENT_DISPATCHED') return buildDispatchEmail(referenceId)
  if (kind === STOREFRONT_CONFIRMATION_KIND) return buildStorefrontConfirmationEmail(referenceId)
  if (kind === STOREFRONT_DELIVERED_KIND) return buildStorefrontDeliveredEmail(referenceId)
  const partialShipmentId = shipmentIdOfPartialKind(kind)
  if (partialShipmentId !== null) return buildStorefrontPartialShipmentEmail(referenceId, partialShipmentId)
  if (kind === 'SALES_QUOTE') return buildSalesQuoteEmail(referenceId) // SALES_QUOTE_EMAIL_KIND, spelled out so the document census sees the kind
  return null
}
