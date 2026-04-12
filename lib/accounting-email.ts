/**
 * Internal helper for sending accounting invoice emails.
 * Called from:
 *   - app/actions/email.ts (server action, requires auth)
 *   - lib/connectors/xero/sync-processor.ts (internal/cron, no session)
 *
 * This file is NOT 'use server' — it cannot be called directly from the client.
 */

import { db } from '@/lib/db'
import { sendEmail } from '@/lib/mailer'
import { renderEmailHtml, type EmailTemplateType } from '@/lib/email-template'
import { getBranding } from '@/lib/pdf'
import { formatMoney, type SymbolPos } from '@/lib/utils'
import { logActivity } from '@/lib/activity-log'

async function getCurrencyFormat(code: string): Promise<{ sym: string; symPos: SymbolPos; money: (n: number) => string }> {
  const row = await db.currency.findUnique({ where: { code } })
  const sym = row?.symbol ?? (code === 'GBP' ? '£' : code)
  const symPos: SymbolPos = row?.symbolPosition ?? 'PREFIX'
  return { sym, symPos, money: (n: number) => formatMoney(n, sym, symPos) }
}

export async function sendAccountingInvoiceEmailInternal(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        customerName: true,
        customerEmail: true,
        orderNumber: true,
        wcOrderNumber: true,
        invoiceNumber: true,
        currency: true,
        totalForeign: true,
        paidAt: true,
        invoicePdfPath: true,
      },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!so.customerEmail) return { success: false, error: 'No customer email address' }
    if (!so.invoicePdfPath) return { success: false, error: 'No invoice PDF available' }

    const { loadInvoicePdf } = await import('@/lib/invoice-pdf')
    const pdfBuffer = await loadInvoicePdf(orderId)
    if (!pdfBuffer) return { success: false, error: 'Invoice PDF file not found on disk' }

    const branding = await getBranding()
    const ref = so.invoiceNumber ?? so.orderNumber ?? so.wcOrderNumber ?? orderId.slice(0, 8)
    const { money } = await getCurrencyFormat(so.currency)

    const html = await renderEmailHtml(branding, {
      recipientName: so.customerName ?? 'Customer',
      recipientEmail: so.customerEmail,
      reference: ref,
      date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      subject: `Invoice ${ref}`,
      bodyLines: [
        `Please find attached your invoice ${ref} for ${money(Number(so.totalForeign))}.`,
        so.paidAt ? 'This invoice has been paid. Thank you.' : 'Payment is due within 30 days of the invoice date.',
        'If you have any questions regarding this invoice, please don\'t hesitate to contact us.',
      ],
    }, 'invoice')

    const result = await sendEmail({
      to: so.customerEmail,
      subject: `Invoice ${ref}`,
      html,
      attachments: [{ filename: `Invoice-${ref}.pdf`, content: pdfBuffer }],
    })

    if (result.success) {
      logActivity({
        entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_emailed', tag: 'sales', level: 'INFO',
        description: `Emailed invoice ${ref} to ${so.customerEmail}`,
      })
    }

    return result
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
