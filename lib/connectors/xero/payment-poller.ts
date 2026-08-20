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
 *
 * That one GET reads a window that can be too big to page through. It is no longer refused outright:
 * an oversized window is DRAINED in bounded chunks with the cursor checkpointed per chunk (o3d-zdh),
 * so a bulk edit in Xero costs a few extra polls instead of stalling payment detection until someone
 * notices. See drainInvoicesModifiedSince for the boundary rules that keep chunking lossless.
 */

import { xeroHttpAttemptCount } from '@/lib/connectors/xero/api'
import { db } from '@/lib/db'
import { xeroGet } from './api'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { detectPaymentReversals } from '@/lib/domain/accounting/payment-reversal'
import { handleDetectedReversal, type DetectedReversalOrder } from '@/lib/domain/accounting/reversal-handling'
import { withPaymentWriteLockOrSkip, isLockSkipped } from './payment-write-lock'

import {
  advanceCheckpoint,
  CURSOR_OVERLAP_MS,
  drainInvoicesModifiedSince,
  idsWhere,
  parseLedgerAmount,
  partitionPaymentReversals,
  type PaymentReversalReading,
  type XeroInvoice,
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

/**
 * WHY A WITHHELD REVERSAL IS LOUD (o3d-clxw).
 *
 * A withheld reversal is a real disagreement: Xero says this document is not fully paid and IMS says
 * it is paid. What must NOT follow from that is the automatic reconciliation — clearing paidAt
 * re-arms Mark Paid over a supplier payment that has already been made, and on the sales side raises
 * a chargeback credit note against a payment the ledger is still holding. So the write is withheld
 * and the disagreement is reported instead, naming the amounts, for a human to settle.
 *
 * Only documents IMS currently holds as PAID are reported: the rest are ordinary unpaid invoices
 * sitting at AUTHORISED, which is what almost every AUTHORISED invoice in the window is.
 */
function withheldReason(invoice: XeroInvoice): 'part-payment' | 'amount-not-stated' {
  return parseLedgerAmount(invoice.AmountPaid) === null ? 'amount-not-stated' : 'part-payment'
}

function ledgerAmountText(value: unknown): string {
  const parsed = parseLedgerAmount(value)
  return parsed === null ? 'an amount Xero did not state' : parsed.toFixed(2)
}

async function reportWithheldBillReversals(reading: PaymentReversalReading, result: PollResult): Promise<void> {
  const withheld = new Map([...reading.partPaid, ...reading.unverifiable].map((i) => [i.InvoiceID, i]))
  if (withheld.size === 0) return

  const bills = await db.purchaseInvoice.findMany({
    where: { accountingInvoiceId: { in: [...withheld.keys()] }, paidAt: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true } } },
  })
  for (const bill of bills) {
    const invoice = bill.accountingInvoiceId ? withheld.get(bill.accountingInvoiceId) : undefined
    if (!invoice) continue
    const reason = withheldReason(invoice)
    result.billReversalsWithheld++
    await logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: bill.poId,
      action: 'bill_payment_reversal_withheld',
      tag: 'sync',
      level: 'WARNING',
      description: reason === 'part-payment'
        ? `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the ledger `
          + `still holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
          + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
          + `paidAt was left set: clearing it would re-arm Mark Paid over a supplier payment that has `
          + `already been made, and pressing it again would pay the supplier twice. Settle the balance in `
          + `Xero, or correct the bill total in IMS.`
        : `Bill for PO ${bill.po.reference} is ${invoice.Status} in Xero (not fully paid), but the invoice `
          + `payload did not state how much has been paid, so IMS cannot tell a part payment from a `
          + `removed one. paidAt was left set rather than guessed — clearing it would re-arm Mark Paid and `
          + `risk a second supplier payment. Check the bill in Xero and reconcile it by hand.`,
      metadata: {
        reason,
        accountingInvoiceId: invoice.InvoiceID,
        xeroStatus: invoice.Status,
        amountPaid: parseLedgerAmount(invoice.AmountPaid),
        amountDue: parseLedgerAmount(invoice.AmountDue),
      },
      resolveUser: false,
    })
  }
}

async function reportWithheldSalesReversals(reading: PaymentReversalReading, result: PollResult): Promise<void> {
  const withheld = new Map([...reading.partPaid, ...reading.unverifiable].map((i) => [i.InvoiceID, i]))
  if (withheld.size === 0) return

  const orders = await db.salesOrder.findMany({
    where: { accountingInvoiceId: { in: [...withheld.keys()] }, paidAt: { not: null } },
    select: { id: true, accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true, status: true },
  })
  for (const order of orders) {
    const invoice = order.accountingInvoiceId ? withheld.get(order.accountingInvoiceId) : undefined
    if (!invoice) continue
    const reason = withheldReason(invoice)
    const ref = order.orderNumber ?? order.externalOrderNumber ?? order.id
    result.salesReversalsWithheld++
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: order.id,
      action: 'payment_reversal_withheld',
      tag: 'sync',
      level: 'WARNING',
      description: reason === 'part-payment'
        ? `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the ledger still `
          + `holds a payment of ${ledgerAmountText(invoice.AmountPaid)} against it with `
          + `${ledgerAmountText(invoice.AmountDue)} still due. That is a PART payment, NOT a reversal, so `
          + `paidAt was left set and NO chargeback credit note was raised — unwinding revenue against a `
          + `payment the ledger is still holding would be wrong. Settle the balance in Xero, or correct `
          + `the order total in IMS.`
        : `Invoice for order ${ref} is ${invoice.Status} in Xero (not fully paid), but the invoice payload `
          + `did not state how much has been paid, so IMS cannot tell a part payment from a removed one. `
          + `paidAt was left set and NO chargeback credit note was raised. Check the invoice in Xero and `
          + `reconcile it by hand.`,
      metadata: {
        reason,
        accountingInvoiceId: invoice.InvoiceID,
        xeroStatus: invoice.Status,
        orderStatus: order.status,
        amountPaid: parseLedgerAmount(invoice.AmountPaid),
        amountDue: parseLedgerAmount(invoice.AmountDue),
      },
      resolveUser: false,
    })
  }
}

type PollResult = {
  salesPaid: number
  billsPaid: number
  salesReversed: number
  billsReversed: number
  /**
   * Invoices that are no longer PAID in Xero but still carry a payment (or whose payment the payload
   * did not state), so the reversal was WITHHELD and paidAt left alone (o3d-clxw). Counted separately
   * from `reversed` because they are the opposite outcome: nothing was reconciled, and a human has
   * something to look at.
   */
  salesReversalsWithheld: number
  billReversalsWithheld: number
  errors: string[]
  skipped?: string
}

/**
 * The four passes, run over ONE slice of the delta.
 *
 * Lifted out of the poll body because an oversized window is no longer read whole: it is drained in
 * bounded chunks, each one processed and checkpointed before the next is read (o3d-zdh). Every pass
 * is idempotent, which is what makes both the chunk overlap and CURSOR_OVERLAP_MS free — the forward
 * passes only consider paidAt:null and the reversal passes only paidAt:not-null, so re-seeing an
 * invoice already reconciled does nothing.
 *
 * Errors are pushed onto `result` rather than thrown: the caller reads that to decide whether this
 * chunk may be checkpointed.
 */
async function processDeltaChunk(changed: XeroInvoice[], result: PollResult, windowStart: Date): Promise<void> {
  const paidSalesIds = idsWhere(changed, 'ACCREC', ['PAID'])
  // NOT `idsWhere(..., ['AUTHORISED', 'VOIDED'])` any more (o3d-clxw). AUTHORISED means "approved and
  // not fully paid", which a bill carrying a real PART payment satisfies — reading it as a removal
  // cleared paidAt over money that had already left the bank. partitionPaymentReversals asks the
  // payload what the ledger HOLDS, and withholds the verdict when it cannot tell.
  const salesReversal = partitionPaymentReversals(changed, 'ACCREC')
  const reversedSalesIds = salesReversal.reversed
  const voidedSalesIds = idsWhere(changed, 'ACCREC', ['VOIDED'])
  const paidBillIds = idsWhere(changed, 'ACCPAY', ['PAID'])
  const billReversal = partitionPaymentReversals(changed, 'ACCPAY')
  const reversedBillIds = billReversal.reversed
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
      //    transition. The refund invariant is re-checked HERE too, not just on the payment write: a
      //    full refund can commit between the two writes (leaving status PENDING_PAYMENT), and
      //    advancing + allocating a fully-refunded order violates the invariant. Allocation follows
      //    only when the transition took, so a concurrent cancel/hold/refund is never overwritten.
      const advanced = await db.salesOrder.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT', paidAt: { not: null }, refundStatus: { not: 'FULL' } },
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

  // Reported in its own pass so a reporting failure cannot lose a reversal that DID reconcile, and a
  // reversal pass that threw still leaves the withheld ones described.
  try {
    await reportWithheldSalesReversals(salesReversal, result)
  } catch (e) {
    result.errors.push(`Sales withheld-reversal reporting error: ${String(e)}`)
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

  try {
    await reportWithheldBillReversals(billReversal, result)
  } catch (e) {
    result.errors.push(`Bills withheld-reversal reporting error: ${String(e)}`)
  }
}

/**
 * Serialized with the daily backlog reconcile (o3d-2s8): both write paidAt from a Xero read, so they
 * must not interleave, or one could act on a state the other has already invalidated. If the reconcile
 * holds the write lock, this poll cycle skips and retries in 15 minutes — a skipped cycle is harmless
 * (the next one catches up), whereas a concurrent write is not.
 */
export async function pollXeroPayments(): Promise<PollResult> {
  const outcome = await withPaymentWriteLockOrSkip(() => pollXeroPaymentsLocked())
  if (isLockSkipped(outcome)) {
    return {
      salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0,
      salesReversalsWithheld: 0, billReversalsWithheld: 0,
      errors: [], skipped: 'backlog reconcile held the payment-write lock',
    }
  }
  return outcome
}

async function pollXeroPaymentsLocked(): Promise<PollResult> {
  const result = {
    salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0,
    salesReversalsWithheld: 0, billReversalsWithheld: 0,
    errors: [] as string[],
  }

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
  // Stamped BEFORE the fetch, not after the passes: anything modified while this poll is running
  // must fall inside the NEXT window, not be skipped by a cursor set to the time we happened to
  // finish. Paired with CURSOR_OVERLAP_MS below.
  const pollStartedAt = new Date()
  const since = new Date(lastPollDate.getTime() - CURSOR_OVERLAP_MS)

  // --- One delta read for all four passes, drained in bounded chunks if it is oversized ---
  //
  // The cursor moves per CHUNK, not per poll (o3d-zdh). A normal poll is still one unbounded request
  // and one chunk ending at pollStartedAt — identical to before. An oversized window is carved up
  // instead of refused, and each piece is checkpointed as soon as its passes complete, so a failure
  // partway through costs one chunk rather than the whole backlog and the next poll resumes from
  // where this one stopped instead of re-asking the same impossible question.
  //
  // `through` is the cursor value, NOT pollStartedAt: it is the exclusive upper bound of the slice
  // actually processed. Writing anything later would step over invoices this poll never read.
  //
  // AND NEVER EARLIER THAN THE CURSOR WE STARTED FROM (o3d-8f9 r3). The read floor is deliberately
  // CURSOR_OVERLAP_MS behind the persisted cursor so a record landing during the previous poll is
  // re-read; that overlap is a QUERY floor, not a checkpoint. If the overlap itself holds more than
  // one chunk — a couple of dense bulk-edit seconds is enough — the first chunk's `through` lands
  // BEFORE lastPollDate, and persisting it moves the cursor BACKWARD. The next poll then subtracts
  // the overlap from the regressed value and reproduces the same chunking, so it cycles: Codex
  // measured it settling at -44s, -49s, -55s, each poll spending 163-200 requests replaying overlap
  // and never reaching either the original checkpoint or newer work. Payment reconciliation stops
  // dead while burning the tenant's daily Xero allowance.
  //
  // Clamping to a monotonic maximum keeps the overlap doing its job (the records ARE re-read and
  // re-processed, idempotently) while making the checkpoint one-way.
  let checkpoint = lastPollDate
  const drain = await drainInvoicesModifiedSince(
    since,
    pollStartedAt,
    (path, opts) => xeroGet<XeroInvoicesResponse>(path, opts),  // budget-reconciled inside the drain
    async ({ invoices, through }) => {
      const errorsBefore = result.errors.length
      await processDeltaChunk(invoices, result, lastPollDate)
      // A pass that errored may have left work undone inside this chunk, so the chunk is not
      // checkpointed and the drain stops here — the same "hold the cursor on error" rule as before,
      // now applied per chunk instead of per poll.
      if (result.errors.length > errorsBefore) return 'stop'

      // A chunk inside the re-read overlap advances nothing: its work is done and recorded, but the
      // cursor stays where it was. Only a chunk that reaches past the old cursor moves it.
      const advanced = advanceCheckpoint(checkpoint, through)
      if (!advanced) return 'continue'
      checkpoint = advanced

      await db.setting.upsert({
        where: { key: 'xero_last_payment_poll' },
        create: { key: 'xero_last_payment_poll', value: through.toISOString() },
        update: { value: through.toISOString() },
      })
      return 'continue'
    },
    // Real HTTP attempts, not fetcher invocations: xeroGet retries a 429 internally, so one
    // invocation can be several tenant API calls (o3d-8f9 r3).
    xeroHttpAttemptCount,
  )

  if (!drain.ok) result.errors.push(`Xero invoice fetch failed: ${drain.error}`)

  if (result.errors.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_cursor_held',
      tag: 'sync',
      level: 'WARNING',
      description:
        `Xero payment poll stopped with errors after ${drain.chunks} chunk(s); the cursor is held at ` +
        `the last chunk that completed. ${result.errors.join(' | ')}`,
      metadata: result,
      resolveUser: false,
    })
  } else if (drain.ok && !drain.complete) {
    // Not an error: the backlog is being drained, progress is checkpointed, and the next scheduled
    // poll continues it. Logged as a WARNING anyway because an operator should know a bulk change
    // in Xero is taking several polls to work through.
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_backlog_draining',
      tag: 'sync',
      level: 'WARNING',
      description:
        `Xero payment poll processed ${drain.chunks} bounded chunk(s) of an oversized delta and ` +
        `checkpointed each; the remainder resumes on the next poll.`,
      metadata: result,
      resolveUser: false,
    })
  }

  const withheld = result.salesReversalsWithheld + result.billReversalsWithheld
  if (result.salesPaid > 0 || result.billsPaid > 0 || result.salesReversed > 0 || result.billsReversed > 0 || withheld > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll',
      tag: 'sync',
      level: 'INFO',
      description:
        `Payment poll: ${result.salesPaid} sales paid, ${result.billsPaid} bills paid, ` +
        `${result.salesReversed} sales reversed, ${result.billsReversed} bills reversed` +
        (withheld > 0
          ? `, ${withheld} reversal(s) WITHHELD because the ledger still holds a payment (or did not say) — ` +
            `see the per-document warnings`
          : ''),
      metadata: result,
      resolveUser: false,
    })
  }

  return result
}
