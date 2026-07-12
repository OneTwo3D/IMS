/**
 * QuickBooks Online payment detection polling.
 * Polls QBO for recently paid invoices and bills, updating IMS records.
 * Mirrors lib/connectors/xero/payment-poller.ts.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { qboQuery } from './api'
import { getSettingValue } from '@/lib/settings-store'

const LAST_POLL_KEY = 'quickbooks_last_payment_poll'

type QboInvoice = {
  Id: string
  Balance: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboBill = {
  Id: string
  Balance: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboQueryResponse<T> = {
  QueryResponse: Record<string, T[] | undefined>
}

/**
 * Poll QuickBooks for paid invoices and bills.
 * Updates paidAt on matching IMS records and advances order status.
 */
export async function pollQuickBooksPayments(): Promise<{ salesPaid: number; billsPaid: number; errors: string[] }> {
  const errors: string[] = []
  let salesPaid = 0
  let billsPaid = 0
  let allQueriesSucceeded = true

  const lastPoll = await getSettingValue(LAST_POLL_KEY)
  const since = lastPoll || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  // --- Sales invoices (customer payments) ---
  const unpaidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
      shoppingLinks: { none: {} }, // manual orders only; shopping orders get channel payment status
    },
    select: { id: true, accountingInvoiceId: true, status: true },
  })

  if (unpaidOrders.length > 0) {
    // Query QBO for invoices with zero balance (fully paid)
    const res = await qboQuery<QboQueryResponse<QboInvoice>>(
      'Invoice',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks invoices: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidInvoices = res.data?.QueryResponse?.Invoice ?? []
      const paidInvoiceIds = new Set(paidInvoices.map((i) => i.Id))

      for (const order of unpaidOrders) {
        if (!order.accountingInvoiceId || !paidInvoiceIds.has(order.accountingInvoiceId)) continue

        try {
          const updateData: Record<string, unknown> = { paidAt: new Date() }
          // Advance status from PENDING_PAYMENT to PROCESSING
          if (order.status === 'PENDING_PAYMENT') {
            updateData.status = 'PROCESSING'
          }
          await db.salesOrder.update({
            where: { id: order.id },
            data: updateData,
          })

          // Trigger auto-allocation if status advanced
          if (order.status === 'PENDING_PAYMENT') {
            try {
              const { autoAllocateOrder } = await import('@/app/actions/allocation')
              await autoAllocateOrder(order.id)
            } catch {
              // Non-critical — allocation can be done manually
            }
          }

          salesPaid++
        } catch (e) {
          errors.push(`Sales order ${order.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Purchase bills (vendor payments) ---
  const unpaidBills = await db.purchaseInvoice.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
    },
    select: { id: true, accountingInvoiceId: true },
  })

  if (unpaidBills.length > 0) {
    const res = await qboQuery<QboQueryResponse<QboBill>>(
      'Bill',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks bills: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidBills = res.data?.QueryResponse?.Bill ?? []
      const paidBillIds = new Set(paidBills.map((b) => b.Id))

      for (const bill of unpaidBills) {
        if (!bill.accountingInvoiceId || !paidBillIds.has(bill.accountingInvoiceId)) continue

        try {
          await db.purchaseInvoice.update({
            where: { id: bill.id },
            data: { paidAt: new Date() },
          })
          billsPaid++
        } catch (e) {
          errors.push(`Purchase invoice ${bill.id}: ${String(e)}`)
        }
      }
    }
  }

  // Only advance the poll watermark if all QBO queries succeeded.
  // If a query failed, keep the previous checkpoint so the next run
  // replays the missed window instead of permanently skipping payments.
  if (allQueriesSucceeded) {
    await db.setting.upsert({
      where: { key: LAST_POLL_KEY },
      create: { key: LAST_POLL_KEY, value: now },
      update: { value: now },
    })
  }

  if (salesPaid > 0 || billsPaid > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_payment_poll',
      tag: 'sync',
      description: `QuickBooks payment poll: ${salesPaid} sales payment(s), ${billsPaid} bill payment(s) detected`,
      metadata: { salesPaid, billsPaid },
    })
  }

  return { salesPaid, billsPaid, errors }
}
