'use server'

import { auth } from '@/lib/auth'
import { requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { queueEmail } from '@/lib/email-outbox'
import {
  getInvoiceQueueData,
  getSalesOrderConfirmationQueueData,
} from '@/lib/order-email'

export async function sendSalesOrderEmail(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' }

    const queued = await getSalesOrderConfirmationQueueData(orderId)
    await queueEmail({
      kind: 'SALES_ORDER_CONFIRMATION',
      to: queued.to,
      subject: queued.subject,
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'email_queued',
      tag: 'sales',
      level: 'INFO',
      description: `Queued order confirmation ${queued.reference}`,
      userId: session.user.id,
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function sendInvoiceEmail(orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' }

    const queued = await getInvoiceQueueData(orderId)
    await queueEmail({
      kind: 'INVOICE',
      to: queued.to,
      subject: queued.subject,
      html: 'queued',
      referenceType: 'SalesOrder',
      referenceId: orderId,
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'invoice_email_queued',
      tag: 'sales',
      level: 'INFO',
      description: `Queued invoice ${queued.reference}`,
      userId: session.user.id,
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function sendAccountingInvoiceEmail(orderId: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sales.process')
  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  return sendAccountingInvoiceEmailInternal(orderId)
}
