/**
 * Poll Xero for paid invoices (sales) and bills (purchases).
 * - Sales forward pass (unpaid→paid): manual orders only. WC orders take payment
 *   status from their channel and arrive with paidAt already set, so there is
 *   nothing for the forward pass to detect (see the shoppingLinks:{none:{}} filter).
 * - Sales reversal pass (paid→reversed): ALL sales orders incl. WC-linked (6oyu.6).
 *   A reversed payment / chargeback must clear paidAt + unwind revenue regardless of
 *   channel; the WC refund webhook stays authoritative via a per-order dedup guard.
 * - Purchases: all POs — detects when a bill is paid via Xero bank feed
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'
import { handleDetectedReversal, type DetectedReversalOrder } from '@/lib/domain/accounting/reversal-handling'

type XeroInvoice = {
  InvoiceID: string
  Status: string
  FullyPaidOnDate?: string
}

type XeroInvoicesResponse = {
  Invoices: XeroInvoice[]
}

// audit-M-acct #3: an invoice IMS marked paid is "reversed" if it's no longer
// PAID in Xero. After a payment is removed it returns to AUTHORISED; a voided
// invoice becomes VOIDED. Both signal IMS should clear paidAt, so collect both.
async function fetchReversedInvoiceIds(type: 'ACCREC' | 'ACCPAY', lastPoll: string): Promise<{ all: Set<string>; voided: Set<string> }> {
  const modifiedAfter = new Date(lastPoll).toISOString()
  const all = new Set<string>()
  const voided = new Set<string>()
  for (const status of ['AUTHORISED', 'VOIDED'] as const) {
    // The `where` clause must be a SINGLE url-encoded param — leaving `&&` raw makes
    // the `&` split it into separate query params, so Xero drops the Status filter and
    // returns every ACCREC invoice (which made the VOIDED set match AUTHORISED invoices
    // and wrongly suppressed chargebacks — scjz.71).
    const where = encodeURIComponent(`Type=="${type}"&&Status=="${status}"`)
    const res = await xeroGet<XeroInvoicesResponse>(
      `Invoices?where=${where}&ModifiedAfter=${modifiedAfter}`,
    )
    if (res.ok && res.data?.Invoices) {
      for (const invoice of res.data.Invoices) {
        all.add(invoice.InvoiceID)
        if (status === 'VOIDED') voided.add(invoice.InvoiceID)
      }
    }
  }
  return { all, voided }
}

// A detected payment reversal / chargeback needs a human to reconcile (dispute the
// chargeback, revert fulfilment, chase re-payment). Broadcast a warning to active
// admins — status is never auto-reverted, so the alert is the only prompt to review a
// shipped-but-reversed order. Fires even when a recent WC refund covered the revenue
// side (wcHandled), since that refund may only partially explain a full payment removal.
async function notifyReversalAdmins(order: DetectedReversalOrder, wcHandled: boolean): Promise<void> {
  const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
  const message = wcHandled
    ? `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). A WooCommerce refund in this window already reversed revenue (no duplicate credit note raised) and paidAt was cleared — verify the refund fully covers the reversal and whether the order status should revert.`
    : `Payment for order ${ref} is no longer present in Xero (status: ${order.status}). paidAt was cleared and revenue unwound where applicable — review whether the order status should revert.`
  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  await Promise.all(
    admins.map((admin) =>
      notify({
        userId: admin.id,
        type: 'warning',
        title: 'Payment reversal detected',
        message,
        actionUrl: `/sales/${order.id}`,
      }),
    ),
  )
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
        refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
        shoppingLinks: { none: {} }, // Shopping orders get payment status from their channel
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
    })

    if (unpaidManualOrders.length > 0) {
      // Query Xero for recently paid sales invoices.
      //
      // The `where` clause must be a SINGLE url-encoded param — see fetchReversedInvoiceIds.
      // Left raw, the `&&` splits the query string: Xero receives only where=Type=="ACCREC",
      // silently drops Status, and returns EVERY ACCREC invoice whatever its status. paidIds
      // below is built from that response, so unpaid invoices land in it and the orders they
      // belong to get stamped paid — with paidDate falling back to now(), because an unpaid
      // invoice has no FullyPaidOnDate. That is money marked collected that never arrived.
      //
      // scjz.71 fixed exactly this in fetchReversedInvoiceIds and left both forward passes
      // untouched; the comment there described the bug that was still live here.
      const modifiedAfter = new Date(lastPoll).toISOString()
      const where = encodeURIComponent('Type=="ACCREC"&&Status=="PAID"')
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=${where}&ModifiedAfter=${modifiedAfter}`,
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

  // --- Sales payment reversals (audit-M-acct #3, WC-inclusion 6oyu.6) ---
  // The forward poll only marks unpaid→paid. If an invoice IMS thinks is paid is
  // no longer PAID in Xero — payment reversed/deleted (back to AUTHORISED), an
  // amendment that voided the payment (AUTHORISED), or the invoice VOIDED — clear
  // paidAt so IMS stops showing it paid. Status is NOT auto-reverted (an order may
  // already be picking/shipped); a WARNING + admin notification carrying the current
  // status flags it.
  // 6oyu.6: WooCommerce-linked orders (the bulk of volume) are now INCLUDED — a
  // reversed payment / chargeback on a WC order must clear paidAt and unwind revenue
  // too. The WC refund webhook stays authoritative: handleDetectedReversal's
  // hasWooCommerceRefund dedup guard defers to any existing WC-side refund so the
  // poller never double-reverses an order the refund path already handled.
  // NOTE: must run AFTER the forward pass above so a pay-then-reverse within one
  // window nets to the correct (unpaid) final state.
  try {
    const paidOrders = await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { not: null },
        paidAt: { not: null },
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true, revenueDeferredDate: true },
    })
    if (paidOrders.length > 0) {
      const reversedIds = await fetchReversedInvoiceIds('ACCREC', lastPoll)
      const windowStart = new Date(lastPoll)
      for (const order of detectPaymentReversals(paidOrders, reversedIds.all)) {
        // A VOIDED invoice has already had its AR/revenue reversed by Xero, so a
        // separate credit note would double-reverse — only auto-chargeback an
        // AUTHORISED payment removal where the invoice is still live (Codex P2).
        const invoiceVoided = order.accountingInvoiceId != null && reversedIds.voided.has(order.accountingInvoiceId)
        const { outcome, error } = await handleDetectedReversal(order, { invoiceVoided }, {
          // Dedup (window-scoped): a WC-side refund (SalesOrderRefund carrying the WC
          // externalRefundId) recorded within THIS poll window means the WC refund
          // webhook already owns the revenue reversal — skip the redundant chargeback
          // and log quietly. Window-scoped so a HISTORIC partial refund never
          // permanently suppresses a genuine later reversal, and a no-op for manual
          // orders (which never have an externalRefundId), leaving that path unchanged.
          wasHandledByRecentWcRefund: async (orderId) => {
            const wcRefund = await db.salesOrderRefund.findFirst({
              where: { orderId, externalRefundId: { not: null }, createdAt: { gte: windowStart } },
              select: { id: true },
            })
            return wcRefund != null
          },
          // scjz.71: a reversed payment on a revenue-POSTED order is a chargeback —
          // raise a revenue-only credit note that reverses recognised revenue against
          // AR (COGS kept as a loss, no restock). raiseChargebackForReversedOrder is
          // idempotent (one chargeback per order) and refuses orders with any prior
          // refund — the authoritative guard against a double credit note even if the
          // window check races a WC refund. Dynamic import breaks the lib→action cycle.
          raiseChargeback: async (orderId) => {
            const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
            return raiseChargebackForReversedOrder(orderId, { internalBypassToken: INTERNAL_ACTION_BYPASS })
          },
          // paidAt is reconciled unconditionally on a genuine regression (payment is
          // gone in Xero; the WC refund path does NOT clear paidAt), but ONLY after any
          // required chargeback succeeded — a failed chargeback holds paidAt so the
          // order stays in the next poll's paidOrders window and the reversal is
          // re-attempted (Codex P1) rather than left unpaid-and-unreversed.
          clearPaidAt: async (orderId) => {
            await db.salesOrder.update({ where: { id: orderId }, data: { paidAt: null } })
          },
          notifyNeedsAttention: (o, { wcHandled }) => notifyReversalAdmins(o, wcHandled),
          logReversalDetected: (o, { wcHandled }) => logActivity({
            entityType: 'SALES_ORDER',
            entityId: o.id,
            action: 'payment_reversal_detected',
            tag: 'sync',
            level: 'WARNING',
            description: wcHandled
              ? `Payment reversed in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — a WooCommerce refund in this window already reversed revenue (no duplicate credit note raised); cleared paidAt. Verify the WC refund fully covers the reversal and whether the order status should revert.`
              : `Payment no longer present in Xero for order ${o.orderNumber ?? o.externalOrderNumber} (status: ${o.status}) — cleared paidAt. Review whether the order status should revert.`,
            resolveUser: false,
          }),
        })
        if (outcome === 'reversed') {
          result.salesReversed++
        } else if (outcome === 'chargeback-failed') {
          result.errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${error}`)
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
      // Single url-encoded `where`, for the reason spelled out in the ACCREC pass above:
      // a raw `&&` drops the Status filter and every unpaid bill gets marked paid.
      const modifiedAfter = new Date(lastPoll).toISOString()
      const where = encodeURIComponent('Type=="ACCPAY"&&Status=="PAID"')
      const res = await xeroGet<XeroInvoicesResponse>(
        `Invoices?where=${where}&ModifiedAfter=${modifiedAfter}`,
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
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
    })
    if (paidBills.length > 0) {
      const reversedIds = await fetchReversedInvoiceIds('ACCPAY', lastPoll)
      for (const bill of detectPaymentReversals(paidBills, reversedIds.all)) {
        await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
        result.billsReversed++
        await logActivity({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_detected',
          tag: 'sync',
          level: 'WARNING',
          description: `Bill payment no longer present in Xero for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`,
          resolveUser: false,
        })
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
