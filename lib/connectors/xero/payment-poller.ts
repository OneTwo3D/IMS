/**
 * Poll Xero for paid invoices (sales) and bills (purchases).
 * - Sales forward pass (unpaid→paid): manual orders only. WC orders take payment
 *   status from their channel and arrive with paidAt already set, so there is
 *   nothing for the forward pass to detect (see the shoppingLinks:{none:{}} filter).
 * - Sales reversal pass (paid→reversed): ALL sales orders incl. WC-linked (6oyu.6).
 *   A reversed payment / chargeback must clear paidAt + unwind revenue regardless of
 *   channel; the WC refund webhook stays authoritative via a per-order dedup guard.
 * - Purchases: all POs — detects when a bill is paid via Xero bank feed
 *
 * All four passes read ONE delta GET (o3d-5gm). Two things forced that rewrite:
 *
 *  1. The delta was never real. Every pass sent `ModifiedAfter=<cursor>` as a query param, which
 *     the Accounting API does not have — its modified-since filter is the If-Modified-Since HEADER.
 *     Xero ignores unknown query params rather than rejecting them, so the cursor was computed,
 *     threaded and thrown away, and every pass asked for the whole collection.
 *  2. Which then hit the page cap. With no `page` param Xero stops at 100 rows, so "every ACCREC
 *     invoice ever marked PAID" arrived as an arbitrary 100-row slice of history. On a tenant with
 *     more than 100 paid invoices the forward pass could simply fail to see a payment.
 *
 * So this is a correctness fix that happens to be ~6x cheaper: 6 calls/run (~576/day against a
 * 1,000/day cap) became 1 (~96/day).
 */

import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'
import { handleDetectedReversal, type DetectedReversalOrder } from '@/lib/domain/accounting/reversal-handling'
import { withPaymentWriteLockOrSkip, isLockSkipped } from './payment-write-lock'

import {
  CURSOR_OVERLAP_MS,
  fetchInvoicesModifiedSince,
  idsWhere,
  type XeroInvoicesResponse,
} from './invoice-delta'

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

type PollResult = { salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; errors: string[]; skipped?: string }

/**
 * Serialized with the daily backlog reconcile (o3d-2s8): both write paidAt from a Xero read, so they
 * must not interleave, or one could act on a state the other has already invalidated. If the reconcile
 * holds the write lock, this poll cycle skips and retries in 15 minutes — a skipped cycle is harmless
 * (the next one catches up), whereas a concurrent write is not.
 */
export async function pollXeroPayments(): Promise<PollResult> {
  const outcome = await withPaymentWriteLockOrSkip(() => pollXeroPaymentsLocked())
  if (isLockSkipped(outcome)) {
    return { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, errors: [], skipped: 'backlog reconcile held the payment-write lock' }
  }
  return outcome
}

async function pollXeroPaymentsLocked(): Promise<PollResult> {
  const result = { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, errors: [] as string[] }

  // Read last poll timestamp. Parsed defensively: the cursor is a free-text Setting, and an
  // unparseable one (hand-edited, truncated) would otherwise reach toISOString() and throw
  // RangeError straight out of here — the cron route does not wrap this call, so that is a 500
  // rather than a recorded error. Falling back to the same 24h default as a missing cursor keeps a
  // corrupt value degrading instead of breaking.
  const lastPollSetting = await db.setting.findUnique({ where: { key: 'xero_last_payment_poll' } })
  const defaultLastPoll = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const parsedLastPoll = lastPollSetting?.value ? new Date(lastPollSetting.value) : defaultLastPoll
  const lastPollDate = Number.isFinite(parsedLastPoll.getTime()) ? parsedLastPoll : defaultLastPoll
  if (lastPollDate !== parsedLastPoll) {
    console.warn(
      `[xero] xero_last_payment_poll is not a readable date (${JSON.stringify(lastPollSetting?.value)}); ` +
      `falling back to the last 24h.`,
    )
  }
  const lastPoll = lastPollDate.toISOString()

  // Stamped BEFORE the fetch, not after the passes: anything modified while this poll is running
  // must fall inside the NEXT window, not be skipped by a cursor set to the time we happened to
  // finish. Paired with CURSOR_OVERLAP_MS below.
  const pollStartedAt = new Date()
  const since = new Date(lastPollDate.getTime() - CURSOR_OVERLAP_MS)

  // --- One delta fetch for all four passes ---
  const fetched = await fetchInvoicesModifiedSince(since, (path, opts) =>
    xeroGet<XeroInvoicesResponse>(path, opts),
  )
  if (!fetched.ok) {
    result.errors.push(`Xero invoice fetch failed: ${fetched.error}`)
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_cursor_held',
      tag: 'sync',
      level: 'WARNING',
      description: `Xero payment poll fetched no invoices: ${fetched.error}`,
      metadata: result,
      resolveUser: false,
    })
    return result
  }

  const changed = fetched.invoices
  const paidSalesIds = idsWhere(changed, 'ACCREC', ['PAID'])
  const reversedSalesIds = idsWhere(changed, 'ACCREC', ['AUTHORISED', 'VOIDED'])
  const voidedSalesIds = idsWhere(changed, 'ACCREC', ['VOIDED'])
  const paidBillIds = idsWhere(changed, 'ACCPAY', ['PAID'])
  const reversedBillIds = idsWhere(changed, 'ACCPAY', ['AUTHORISED', 'VOIDED'])
  const invoiceById = new Map(changed.map((i) => [i.InvoiceID, i]))

  // --- Sales invoices (manual orders only — no shopping connector link) ---
  try {
    // Bounded by the delta rather than by history. This used to load EVERY unpaid order with an
    // invoice id and intersect client-side; now Xero has already told us which invoices moved.
    const unpaidManualOrders = paidSalesIds.size === 0 ? [] : await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { in: [...paidSalesIds] },
        paidAt: null,
        refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
        shoppingLinks: { none: {} }, // Shopping orders get payment status from their channel
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
    })

    for (const order of unpaidManualOrders) {
      const paidInvoice = order.accountingInvoiceId ? invoiceById.get(order.accountingInvoiceId) : undefined
      const paidDate = paidInvoice?.FullyPaidOnDate ? new Date(paidInvoice.FullyPaidOnDate) : new Date()

      // TWO independent guarded writes, not one, so a concurrent lifecycle move can neither drop the
      // payment nor be overwritten (o3d-2s8, Codex review of #496).
      //
      // 1) Record the payment. Guarded on the SAME invariants the candidate query used (still unpaid,
      //    not fully refunded), re-checked at WRITE time — a full refund committing after selection
      //    must not be revived, and this captures the payment regardless of any status change, so a
      //    concurrent PENDING_PAYMENT→ON_HOLD/PROCESSING cannot make us silently lose a real payment.
      const paid = await db.salesOrder.updateMany({
        where: { id: order.id, paidAt: null, refundStatus: { not: 'FULL' } },
        data: { paidAt: paidDate },
      })
      if (paid.count === 0) continue // already paid, or fully refunded since selection — nothing to do

      // 2) Advance the lifecycle ONLY if it is still waiting for payment, as an atomic conditional
      //    transition. Allocation follows only when that transition actually happened, so a
      //    concurrent cancel/hold/advance is never overwritten and a held/cancelled order is untouched.
      const advanced = await db.salesOrder.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT' },
        data: { status: 'PROCESSING' },
      })
      if (advanced.count === 1) {
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
  // NOTE: still ordered after the forward pass, but the hazard that note describes is now gone at
  // the source: both passes read ONE snapshot, in which a pay-then-reverse invoice holds exactly
  // one current status (AUTHORISED) and so cannot appear in the paid set at all.
  try {
    // Bounded by the delta: ask only about orders whose invoice actually regressed. The old query
    // loaded every order ever paid on every run to intersect client-side.
    const paidOrders = reversedSalesIds.size === 0 ? [] : await db.salesOrder.findMany({
      where: {
        accountingInvoiceId: { in: [...reversedSalesIds] },
        paidAt: { not: null },
      },
      select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true, revenueDeferredDate: true },
    })
    if (paidOrders.length > 0) {
      const windowStart = new Date(lastPoll)
      for (const order of detectPaymentReversals(paidOrders, reversedSalesIds)) {
        // A VOIDED invoice has already had its AR/revenue reversed by Xero, so a
        // separate credit note would double-reverse — only auto-chargeback an
        // AUTHORISED payment removal where the invoice is still live (Codex P2).
        const invoiceVoided = order.accountingInvoiceId != null && voidedSalesIds.has(order.accountingInvoiceId)
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
    const unpaidBills = paidBillIds.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: {
        accountingInvoiceId: { in: [...paidBillIds] },
        paidAt: null,
      },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true } } },
    })

    for (const bill of unpaidBills) {
      const paidInvoice = bill.accountingInvoiceId ? invoiceById.get(bill.accountingInvoiceId) : undefined
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
  } catch (e) {
    result.errors.push(`Bills polling error: ${String(e)}`)
  }

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  try {
    const paidBills = reversedBillIds.size === 0 ? [] : await db.purchaseInvoice.findMany({
      where: { accountingInvoiceId: { in: [...reversedBillIds] }, paidAt: { not: null } },
      select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
    })
    if (paidBills.length > 0) {
      for (const bill of detectPaymentReversals(paidBills, reversedBillIds)) {
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
    // pollStartedAt, NOT now(): the passes above take real time, and anything Xero changed while
    // they ran must land in the next window instead of falling into the gap. CURSOR_OVERLAP_MS
    // then re-reads the boundary anyway, so the cost of being slightly early is one no-op.
    await db.setting.upsert({
      where: { key: 'xero_last_payment_poll' },
      create: { key: 'xero_last_payment_poll', value: pollStartedAt.toISOString() },
      update: { value: pollStartedAt.toISOString() },
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
