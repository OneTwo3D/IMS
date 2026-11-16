/**
 * The purchase order email: the queue-time facts (recipient, subject) and the send-time body with the PO PDF attached.
 * Queued on the email outbox with kind PURCHASE_ORDER and referenceType PurchaseOrder; the outbox drain calls
 * `buildPurchaseOrderEmail`, so the address and the document are those of the order AT SEND TIME.
 */
import { db } from '@/lib/db'
import { renderEmailHtml } from '@/lib/email-template'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'
import { formatMoney } from '@/lib/utils'
import { getBranding } from '@/lib/pdf'
import { loadPurchaseOrderDocument, loadPurchaseOrderTemplate, renderPurchaseOrderPdf } from '@/lib/purchase-order-pdf'

export const PURCHASE_ORDER_EMAIL_KIND = 'PURCHASE_ORDER'
export const PURCHASE_ORDER_EMAIL_REFERENCE_TYPE = 'PurchaseOrder'

/** An order that is not (or no longer) a live order with the supplier is not mailed. */
const UNSENDABLE_STATUSES = new Set(['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'CANCELLED'])

export async function getPurchaseOrderQueueData(id: string): Promise<{ reference: string; status: string; supplierEmail: string | null; subject: string }> {
  const po = await db.purchaseOrder.findUnique({ where: { id }, select: { reference: true, status: true, supplier: { select: { email: true } } } })
  if (!po) throw new Error('PO not found')
  return { reference: po.reference, status: po.status, supplierEmail: po.supplier.email, subject: `Purchase Order ${po.reference}` }
}

export async function buildPurchaseOrderEmail(id: string) {
  const [po, status] = await Promise.all([loadPurchaseOrderDocument(id), db.purchaseOrder.findUnique({ where: { id }, select: { status: true } })])
  if (!po || !status) throw new Error('PO not found')
  if (UNSENDABLE_STATUSES.has(status.status)) throw new Error(`PO ${po.reference} is ${status.status}; the purchase order email is only sent for a confirmed order`)
  const to = po.supplier.email?.trim()
  if (!to) throw new Error('No supplier email address')

  const [branding, tpl, tz] = await Promise.all([getBranding(), loadPurchaseOrderTemplate(), getDisplayTimeZone()])
  const pdf = await renderPurchaseOrderPdf(po, branding, tpl, { timeZone: tz })
  const subject = `Purchase Order ${po.reference}`
  const html = await renderEmailHtml(branding, {
    recipientName: po.supplier.contactName || po.supplier.name,
    recipientEmail: to,
    reference: po.reference,
    date: formatDateTime(po.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    subject,
    bodyLines: [
      `Please find attached our purchase order ${po.reference} for ${formatMoney(po.totals.total, po.currencySymbol, po.currencySymbolPosition)}.`,
      'Please confirm receipt and your expected delivery date at your earliest convenience, and quote the PO reference on all delivery notes and invoices.',
    ],
  }, 'purchase_order')
  return { to, subject, html, attachments: [{ filename: `PO-${po.reference}.pdf`, content: pdf }] }
}
