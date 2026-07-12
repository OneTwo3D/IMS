/**
 * QuickBooks Online payment detection polling.
 * Polls QBO for recently paid invoices and bills, updating IMS records.
 * Mirrors lib/connectors/xero/payment-poller.ts.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'
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

type QboEntityId = { Id: string }

/**
 * Split the QBO transactions that regressed out of the fully-paid state into the
 * full reversed set and the subset that was VOIDED. Mirrors the Xero poller's
 * {all, voided} contract (audit-M-acct #3 / scjz.71):
 *  - balanceDueEntities: invoices/bills whose Balance returned to > 0 (the payment
 *    was deleted/un-applied but the document is still live) — eligible for a
 *    revenue chargeback on the sales side.
 *  - voidedEntities: invoices/bills QBO zeroed out (TotalAmt = 0). QBO has already
 *    reversed their AR/revenue, so paidAt is cleared but NO chargeback is raised
 *    (a separate credit note would double-reverse).
 * Pure set union so it can be unit-tested without the QBO API.
 */
export function classifyQboReversals(
  balanceDueEntities: QboEntityId[],
  voidedEntities: QboEntityId[],
): { all: Set<string>; voided: Set<string> } {
  const all = new Set<string>()
  const voided = new Set<string>()
  for (const e of balanceDueEntities) all.add(e.Id)
  for (const e of voidedEntities) {
    all.add(e.Id)
    voided.add(e.Id)
  }
  return { all, voided }
}

// QBO equivalent of Xero's fetchReversedInvoiceIds. An IMS-paid document (Balance
// was 0) is "reversed" if, modified since the last poll, its QBO transaction now
// has Balance > 0 (payment removed) or TotalAmt = 0 (voided/zeroed). Returns null
// if either query failed so the caller can hold the poll watermark and retry.
async function fetchReversedEntityIds(
  entity: 'Invoice' | 'Bill',
  since: string,
): Promise<{ all: Set<string>; voided: Set<string> } | null> {
  const [balanceRes, voidedRes] = await Promise.all([
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `Balance > '0' AND MetaData.LastUpdatedTime > '${since}'`),
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `TotalAmt = '0' AND MetaData.LastUpdatedTime > '${since}'`),
  ])
  if (!balanceRes.ok || !voidedRes.ok) return null
  const balanceDue = balanceRes.data?.QueryResponse?.[entity] ?? []
  const voided = voidedRes.data?.QueryResponse?.[entity] ?? []
  return classifyQboReversals(balanceDue, voided)
}

/**
 * Poll QuickBooks for paid invoices and bills.
 * Updates paidAt on matching IMS records and advances order status.
 */
export async function pollQuickBooksPayments(): Promise<{ salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; errors: string[] }> {
  const errors: string[] = []
  let salesPaid = 0
  let billsPaid = 0
  let salesReversed = 0
  let billsReversed = 0
  let allQueriesSucceeded = true

  const lastPoll = await getSettingValue(LAST_POLL_KEY)
  const since = lastPoll || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  // --- Sales invoices (customer payments) ---
  const unpaidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
      refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
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

  // --- Sales payment reversals (audit-M-acct #3 / scjz.70/.71) ---
  // Forward poll only marks unpaid→paid. If an invoice IMS thinks is paid no longer
  // has a zero balance in QBO — payment deleted/un-applied (Balance > 0) or the
  // invoice voided (TotalAmt = 0) — clear paidAt so IMS stops showing it paid.
  // Status is NOT auto-reverted (the order may already be picking/shipped); a
  // WARNING carrying the current status flags it. Must run AFTER the forward pass
  // so a pay-then-reverse within one window nets to the correct (unpaid) state.
  const paidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: { not: null },
      shoppingLinks: { none: {} },
    },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
    },
  })

  if (paidOrders.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Invoice', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks invoices for payment reversals')
    } else {
      for (const order of detectPaymentReversals(paidOrders, reversedIds.all)) {
        // scjz.71: a reversed payment on a revenue-POSTED order (revenue recognised +
        // invoiced) is a chargeback — raise a revenue-only credit note that reverses
        // recognised revenue against AR. Idempotent (one chargeback per order).
        // A VOIDED invoice has already had its AR/revenue reversed by QBO, so a
        // separate credit note would double-reverse — only auto-chargeback an
        // un-applied payment where the invoice is still live.
        // CRITICAL: clear paidAt ONLY after the chargeback is recorded — otherwise a
        // failed chargeback would drop the order out of the next poll's paidOrders
        // (paidAt: not null) and the recognised revenue would never be reversed.
        const invoiceVoided = order.accountingInvoiceId != null && reversedIds.voided.has(order.accountingInvoiceId)
        let chargebackFailed = false
        if (order.revenueDeferredDate && !invoiceVoided) {
          try {
            const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
            const chargeback = await raiseChargebackForReversedOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
            if (chargeback.error) {
              chargebackFailed = true
              errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${chargeback.error}`)
            }
          } catch (chargebackError) {
            chargebackFailed = true
            errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${String(chargebackError)}`)
          }
        }
        // Leave paidAt set on a failed chargeback so the reversal is re-attempted and
        // the order is not silently shown unpaid-and-unreversed. Also hold the poll
        // watermark: unlike Xero (whose cursor gate is errors.length===0), the QBO
        // cursor advances on allQueriesSucceeded, so without this the window moves past
        // the reversed invoice and the LastUpdatedTime>since reversal query never
        // re-returns it — the chargeback would never actually retry.
        if (chargebackFailed) {
          allQueriesSucceeded = false
          continue
        }
        await db.salesOrder.update({ where: { id: order.id }, data: { paidAt: null } })
        salesReversed++
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt. Review whether the order status should revert.`,
          resolveUser: false,
        })
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

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  // A bill IMS thinks paid whose QBO transaction regressed (Balance > 0, payment
  // un-applied; or TotalAmt = 0, voided) gets paidAt cleared with a WARNING. No
  // chargeback equivalent on the purchase side.
  const paidBills = await db.purchaseInvoice.findMany({
    where: { accountingInvoiceId: { not: null }, paidAt: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
  })

  if (paidBills.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Bill', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks bills for payment reversals')
    } else {
      for (const bill of detectPaymentReversals(paidBills, reversedIds.all)) {
        await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
        billsReversed++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Bill payment no longer present in QuickBooks for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`,
          resolveUser: false,
        })
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

  if (salesPaid > 0 || billsPaid > 0 || salesReversed > 0 || billsReversed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_payment_poll',
      tag: 'sync',
      description: `QuickBooks payment poll: ${salesPaid} sales paid, ${billsPaid} bills paid, ${salesReversed} sales reversed, ${billsReversed} bills reversed`,
      metadata: { salesPaid, billsPaid, salesReversed, billsReversed },
    })
  }

  return { salesPaid, billsPaid, salesReversed, billsReversed, errors }
}
