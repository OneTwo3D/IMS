/**
 * Internal helper for sending accounting invoice emails.
 * Called from:
 *   - app/actions/email.ts (server action, requires auth)
 *   - lib/connectors/xero/sync-processor.ts (internal/cron, no session)
 *
 * This file is NOT 'use server' — it cannot be called directly from the client.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { queueEmail } from '@/lib/email-outbox'
import { getAccountingInvoiceQueueData } from '@/lib/order-email'

export async function sendAccountingInvoiceEmailInternal(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const so = await db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true } })
    if (!so) return { success: false, error: 'Order not found' }
    const queued = await getAccountingInvoiceQueueData(orderId)
    // o3d-alnk / o3d-8td2: this is the INVOICE_EMAIL effect of xero/accounting.post, which
    // multiplexes every AccountingSyncType and is `unsafe-to-replay` partly BECAUSE this
    // enqueue had no uniqueness of any kind — a replayed outbox row simply inserted a second
    // invoice email. `email_outbox_undelivered_reference_uq` now refuses the second row while
    // the first is still undelivered, and that refusal arrives here as `already_queued`.
    const outcome = await queueEmail({
      kind: 'ACCOUNTING_INVOICE',
      to: queued.to,
      subject: queued.subject,
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    })

    await logActivity({
      entityType: 'SALES_ORDER', entityId: orderId, action: 'invoice_email_queued', tag: 'sales', level: 'INFO',
      description: outcome.queued
        ? `Queued invoice ${queued.reference}`
        : `Invoice ${queued.reference} was already queued and undelivered — not duplicated`,
      resolveUser: false,
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
