/**
 * Poll Xero for paid invoices (sales) and bills (purchases).
 * - Sales: manual orders only (WC orders arrive with paidAt already set)
 * - Purchases: all POs — detects when a bill is paid via Xero bank feed
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'

type XeroInvoice = {
  InvoiceID: string
  Status: string
  FullyPaidOnDate?: string
}

type XeroInvoicesResponse = {
  Invoices: XeroInvoice[]
}

export async function pollXeroPayments(): Promise<{ salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; errors: string[] }> {
  const result = { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, errors: [] as string[] }

  // Read last poll timestamp
  const lastPollSetting = await db.setting.findUnique({ where: { key: 'xero_last_payment_poll' } })
  const lastPoll = lastPollSetting?.value || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // --- Sales invoices (manual orders only — no shopping connector link) ---
  try {
    const unpaidManualOrders = await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { not: null },
        paidAt: null,
        shoppingLinks: { none: {} }, // Shopping orders get payment status from their channel
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
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
              description: `Payment detected via Xero for order ${order.orderNumber ?? order.externalOrderNumber}`,
              resolveUser: false,
            })
          }
        }
      }
    }
  } catch (e) {
    result.errors.push(`Sales polling error: ${String(e)}`)
  }

  // --- Sales payment reversals (audit-M-acct #3) ---
  // The forward poll only marks unpaid→paid. If a payment is reversed/deleted in
  // Xero the invoice regresses to AUTHORISED — clear paidAt so IMS stops showing
  // it paid. Status is not auto-reverted (left for the operator); a WARNING flags it.
  try {
    const paidManualOrders = await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { not: null },
        paidAt: { not: null },
        shoppingLinks: { none: {} },
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true },
    })
    if (paidManualOrders.length > 0) {
      const modifiedAfter = new Date(lastPoll).toISOString()
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=Type=="ACCREC"&&Status=="AUTHORISED"&ModifiedAfter=${modifiedAfter}`,
      )
      if (res.ok && res.data?.Invoices) {
        const reversedIds = new Set(res.data.Invoices.map((i) => i.InvoiceID))
        for (const order of detectPaymentReversals(paidManualOrders, reversedIds)) {
          await db.salesOrder.update({ where: { id: order.id }, data: { paidAt: null } })
          result.salesReversed++
          await logActivity({
            entityType: 'SALES_ORDER',
            entityId: order.id,
            action: 'payment_reversal_detected',
            tag: 'sync',
            level: 'WARNING',
            description: `Payment reversed in Xero for order ${order.orderNumber ?? order.externalOrderNumber} — cleared paidAt. Review whether the order status should change.`,
            resolveUser: false,
          })
        }
      }
    }
  } catch (e) {
    result.errors.push(`Sales reversal polling error: ${String(e)}`)
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

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  try {
    const paidBills = await db.purchaseInvoice.findMany({
      where: { accountingInvoiceId: { not: null }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true } } },
    })
    if (paidBills.length > 0) {
      const modifiedAfter = new Date(lastPoll).toISOString()
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=Type=="ACCPAY"&&Status=="AUTHORISED"&ModifiedAfter=${modifiedAfter}`,
      )
      if (res.ok && res.data?.Invoices) {
        const reversedIds = new Set(res.data.Invoices.map((i) => i.InvoiceID))
        for (const bill of detectPaymentReversals(paidBills, reversedIds)) {
          await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
          result.billsReversed++
          await logActivity({
            entityType: 'PURCHASE_ORDER',
            entityId: bill.poId,
            action: 'bill_payment_reversal_detected',
            tag: 'sync',
            level: 'WARNING',
            description: `Bill payment reversed in Xero for PO ${bill.po.reference} — cleared paidAt.`,
            resolveUser: false,
          })
        }
      }
    }
  } catch (e) {
    result.errors.push(`Bills reversal polling error: ${String(e)}`)
  }

  if (result.errors.length === 0) {
    await db.setting.upsert({
      where: { key: 'xero_last_payment_poll' },
      create: { key: 'xero_last_payment_poll', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
  } else {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_cursor_held',
      tag: 'sync',
      level: 'WARNING',
      description: 'Xero payment poll cursor was not advanced because polling returned errors',
      metadata: result,
      resolveUser: false,
    })
  }

  if (result.salesPaid > 0 || result.billsPaid > 0 || result.salesReversed > 0 || result.billsReversed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll',
      tag: 'sync',
      level: 'INFO',
      description: `Payment poll: ${result.salesPaid} sales paid, ${result.billsPaid} bills paid, ${result.salesReversed} sales reversed, ${result.billsReversed} bills reversed`,
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
