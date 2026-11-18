/**
 * The quotation email: the queue-time facts (recipient, subject) and the send-time body with the quote PDF attached.
 * Queued on the email outbox with kind SALES_QUOTE and referenceType SalesOrder, exactly like the order confirmation; the outbox drain calls
 * `buildSalesQuoteEmail` (via prepareQueuedEmail), so the address, the prices and the document are those of the order AT SEND TIME and
 * nothing is delivered except by the drain, under the installation's SMTP settings and suppression list (a stage copy with no SMTP configured keeps the row queued/failed, it mails nobody).
 *
 * THE SWITCH. `sales_quote_email_enabled` (Settings > Documents), default OFF. It is read when the email is queued (the action refuses) and again at SEND
 * time, so a row queued before the switch was turned off ends FAILED with the reason and nothing is sent.
 */
import { db } from '@/lib/db'
import { EmailKindDisabledError } from '@/lib/email-kind-disabled'
import { renderEmailHtml } from '@/lib/email-template'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatCalendarDate, formatDateTime } from '@/lib/format-datetime'
import { getBranding } from '@/lib/pdf'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { getCurrencyFormat, loadSalesOrderForPdf, renderSalesOrderPdf } from '@/lib/sales-order-pdf'
import {
  SALES_QUOTE_EMAIL_DISABLED_REASON,
  SALES_QUOTE_EMAIL_SETTING_KEY,
  quoteDateToYmd,
} from '@/lib/domain/sales/sales-quote'

/** The switch for emailing quotes to customers. Absent or anything but 'true' is OFF. */
export async function isSalesQuoteEmailEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: SALES_QUOTE_EMAIL_SETTING_KEY }, select: { value: true } })
  return row?.value === 'true'
}

export async function saveSalesQuoteEmailEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? 'true' : 'false'
  await db.setting.upsert({ where: { key: SALES_QUOTE_EMAIL_SETTING_KEY }, create: { key: SALES_QUOTE_EMAIL_SETTING_KEY, value }, update: { value } })
}

export async function getSalesQuoteQueueData(orderId: string): Promise<{ to: string; subject: string; reference: string; isQuote: boolean; status: string }> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, externalOrderNumber: true, customerEmail: true, isQuote: true, status: true },
  })
  if (!so) throw new Error('Order not found')
  if (!so.customerEmail) throw new Error('No customer email address')
  const reference = getSalesOrderReference(so)
  return { to: so.customerEmail, subject: `Quotation ${reference}`, reference, isQuote: so.isQuote, status: so.status }
}

export async function buildSalesQuoteEmail(orderId: string) {
  // Checked at SEND time, so a row queued before the switch was turned off is refused too (the drain settles it FAILED, address kept, nothing sent).
  if (!(await isSalesQuoteEmailEnabled())) throw new EmailKindDisabledError(SALES_QUOTE_EMAIL_DISABLED_REASON)
  const so = await loadSalesOrderForPdf(orderId)
  if (!so) throw new Error('Order not found')
  if (!so.isQuote) throw new Error('This order is no longer a quote; the quotation email is only sent for a quote')
  if (so.status !== 'DRAFT') throw new Error(`This quote is ${so.status}; the quotation email is only sent for a draft quote`)
  if (!so.customerEmail) throw new Error('No customer email address')

  const branding = await getBranding()
  const tz = await getDisplayTimeZone()
  const ref = getSalesOrderReference(so)
  const { money } = await getCurrencyFormat(so.currency)
  const pdf = await renderSalesOrderPdf(so, branding, { variant: 'quote' })
  const validUntil = quoteDateToYmd(so.quoteValidUntil ?? null)
  const longDate = { day: 'numeric', month: 'long', year: 'numeric' } as const
  const subject = `Quotation ${ref}`
  const html = await renderEmailHtml(branding, {
    recipientName: so.customerName ?? 'Customer',
    recipientEmail: so.customerEmail,
    reference: ref,
    date: formatDateTime(so.createdAt, longDate, tz),
    subject,
    bodyLines: [
      `Thank you for your enquiry. Please find our quotation ${ref} attached, for ${money(Number(so.totalForeign))}.`,
      ...(validUntil ? [`The prices in this quotation are valid until ${formatCalendarDate(`${validUntil}T00:00:00.000Z`, longDate)}.`] : []),
      'If you would like to go ahead, or have any questions, please reply to this email.',
    ],
  }, 'quote')
  return { to: so.customerEmail, subject, html, attachments: [{ filename: `Quote-${ref}.pdf`, content: pdf }] }
}
