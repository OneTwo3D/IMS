/**
 * Poll Xero for paid invoices (sales) and bills (purchases).
 * - Sales: manual orders only (WC orders arrive with paidAt already set)
 * - Purchases: all POs — detects when a bill is paid via Xero bank feed
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'

type XeroInvoice = {
  InvoiceID: string
  Status: string
  FullyPaidOnDate?: string
}

type XeroInvoicesResponse = {
  Invoices: XeroInvoice[]
}

export async function pollXeroPayments(): Promise<{ salesPaid: number; billsPaid: number; errors: string[] }> {
  const result = { salesPaid: 0, billsPaid: 0, errors: [] as string[] }

  // Read last poll timestamp
  const lastPollSetting = await db.setting.findUnique({ where: { key: 'xero_last_payment_poll' } })
  const lastPoll = lastPollSetting?.value || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // --- Sales invoices (manual orders only — no wcOrderId) ---
  try {
    const unpaidManualOrders = await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { not: null },
        paidAt: null,
        wcOrderId: null, // Only manual orders — WC orders already have paidAt
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, wcOrderNumber: true, status: true },
    })

    if (unpaidManualOrders.length > 0) {
      // Query Xero for recently paid sales invoices
      const modifiedAfter = new Date(lastPoll).toISOString()
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=Type=="ACCREC"&&Status=="PAID"&ModifiedAfter=${modifiedAfter}`,
      )

      if (res.ok && res.data?.Invoices) {
        const paidIds = new Set(res.data.Invoices.map(i => i.InvoiceID))

        for (const order of unpaidManualOrders) {
          if (order.accountingInvoiceId && paidIds.has(order.accountingInvoiceId)) {
            const paidInvoice = res.data.Invoices.find(i => i.InvoiceID === order.accountingInvoiceId)
            const paidDate = paidInvoice?.FullyPaidOnDate ? new Date(paidInvoice.FullyPaidOnDate) : new Date()

            // Update paidAt and advance status if still PENDING_PAYMENT
            const updateData: Record<string, unknown> = { paidAt: paidDate }
            if (order.status === 'PENDING_PAYMENT') {
              updateData.status = 'PROCESSING'
            }

            await db.salesOrder.update({ where: { id: order.id }, data: updateData })

            // Auto-allocate if status was just advanced
            if (order.status === 'PENDING_PAYMENT') {
              try {
                const { autoAllocateOrder } = await import('@/app/actions/allocation')
                await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
              } catch { /* Non-critical */ }
            }

            result.salesPaid++
            await logActivity({
              entityType: 'SALES_ORDER',
              entityId: order.id,
              action: 'payment_detected',
              tag: 'sync',
              level: 'INFO',
              description: `Payment detected via Xero for order ${order.orderNumber ?? order.wcOrderNumber}`,
              resolveUser: false,
            })
          }
        }
      }
    }
  } catch (e) {
    result.errors.push(`Sales polling error: ${String(e)}`)
  }

  // --- Purchase bills (all POs) ---
  try {
    const unpaidBills = await db.purchaseInvoice.findMany({
      where: {
        accountingInvoiceId: { not: null },
        paidAt: null,
      },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true } } },
    })

    if (unpaidBills.length > 0) {
      const modifiedAfter = new Date(lastPoll).toISOString()
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=Type=="ACCPAY"&&Status=="PAID"&ModifiedAfter=${modifiedAfter}`,
      )

      if (res.ok && res.data?.Invoices) {
        const paidIds = new Set(res.data.Invoices.map(i => i.InvoiceID))

        for (const bill of unpaidBills) {
          if (bill.accountingInvoiceId && paidIds.has(bill.accountingInvoiceId)) {
            const paidInvoice = res.data.Invoices.find(i => i.InvoiceID === bill.accountingInvoiceId)
            const paidDate = paidInvoice?.FullyPaidOnDate ? new Date(paidInvoice.FullyPaidOnDate) : new Date()

            await db.purchaseInvoice.update({
              where: { id: bill.id },
              data: { paidAt: paidDate },
            })

            result.billsPaid++
            await logActivity({
              entityType: 'PURCHASE_ORDER',
              entityId: bill.poId,
              action: 'bill_payment_detected',
              tag: 'sync',
              level: 'INFO',
              description: `Bill payment detected via Xero for PO ${bill.po.reference}`,
              resolveUser: false,
            })
          }
        }
      }
    }
  } catch (e) {
    result.errors.push(`Bills polling error: ${String(e)}`)
  }

  // Update last poll timestamp
  await db.setting.upsert({
    where: { key: 'xero_last_payment_poll' },
    create: { key: 'xero_last_payment_poll', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })

  if (result.salesPaid > 0 || result.billsPaid > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll',
      tag: 'sync',
      level: 'INFO',
      description: `Payment poll: ${result.salesPaid} sales, ${result.billsPaid} bills detected`,
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
