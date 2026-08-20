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
  assessCursorLag,
  CURSOR_OVERLAP_MS,
  drainInvoicesModifiedSince,
  idsWhere,
  LAG_STALL_POLLS,
  MAX_CHUNKS_PER_POLL,
  MAX_PAGES,
  PAGE_SIZE,
  resumableDrainState,
  type CursorLagState,
  type PersistedDrainState,
  type XeroInvoice,
  type XeroInvoicesResponse,
} from './invoice-delta'

/** The poll cursor: the exclusive upper bound of everything already processed. */
const CURSOR_KEY = 'xero_last_payment_poll'

/**
 * o3d-pzu0 — the in-progress drain, so a resumed poll CONTINUES it instead of rediscovering it.
 *
 * Saved beside the cursor value it was written against. The cursor stays the sole authority on what
 * has been processed; this row is only a hint about how to get through the rest of the window
 * cheaply, and it is thrown away the instant it disagrees with the cursor (another writer, a hand
 * edit, a restored backup). Discarding costs one expensive poll; trusting a stale one would move
 * the cursor over invoices nobody read.
 */
const DRAIN_STATE_KEY = 'xero_payment_poll_drain'

/** o3d-pzu0 — the previous poll's cursor lag, so a drain that never catches up can be recognised. */
const LAG_STATE_KEY = 'xero_payment_poll_lag'

function readJsonSetting<T>(value: string | null | undefined): T | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
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

type PollResult = {
  salesPaid: number
  billsPaid: number
  salesReversed: number
  billsReversed: number
  errors: string[]
  skipped?: string
  /**
   * o3d-pzu0 — how many Xero requests this poll actually spent. Previously invisible, which made
   * the quota question unanswerable: the drain's cost was a number nobody could read off a run.
   */
  xeroRequests?: number
  /** o3d-pzu0 — how far behind `now` the cursor was left. ~0 on a healthy poll. */
  cursorLagMs?: number
  /** o3d-pzu0 — window still to drain, in ms. Absent when nothing is being drained. */
  drainRemainingMs?: number
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
    return { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, errors: [], skipped: 'backlog reconcile held the payment-write lock' }
  }
  return outcome
}

async function pollXeroPaymentsLocked(): Promise<PollResult> {
  const result: PollResult = { salesPaid: 0, billsPaid: 0, salesReversed: 0, billsReversed: 0, errors: [] as string[] }

  // Read last poll timestamp. Parsed defensively: the cursor is a free-text Setting, and an
  // unparseable one (hand-edited, truncated) would otherwise reach toISOString() and throw
  // RangeError straight out of here — the cron route does not wrap this call, so that is a 500
  // rather than a recorded error. Falling back to the same 24h default as a missing cursor keeps a
  // corrupt value degrading instead of breaking.
  const lastPollSetting = await db.setting.findUnique({ where: { key: CURSOR_KEY } })
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
  // o3d-pzu0: the cursor VALUE as written, tracked so the drain state can be tied to it. String
  // equality, not date equality — this is about "is this the same row I saved beside", and a
  // reformatted or hand-edited value should invalidate the hint rather than silently match.
  let cursorValue = lastPollSetting?.value ?? null

  // o3d-pzu0 — resume an in-progress drain rather than rediscovering it.
  //
  // Every resumed poll used to repeat the unbounded whole-window walk first (up to MAX_PAGES+1 =
  // 21 requests) purely to learn again that the window is oversized, and then re-bisect the chunk
  // width from scratch. That is ~21 of the ~109 requests a maximal drain poll spends, paid 96
  // times a day at the 15-minute cadence, against a tenant allowance the code itself puts at
  // 1,000/day — so the rediscovery alone could exhaust the quota, and once it does nothing drains
  // at all.
  //
  // The saved state is only honoured while it matches the cursor it was written against. That
  // check is what keeps the cursor the single authority: a state row that disagrees is discarded,
  // and the poll pays the full rediscovery rather than trusting it.
  const drainStateRow = await db.setting.findUnique({ where: { key: DRAIN_STATE_KEY } })
  const savedDrain = readJsonSetting<PersistedDrainState>(drainStateRow?.value)
  const resumable = resumableDrainState(savedDrain, cursorValue)
  if (savedDrain && !resumable) {
    console.warn(
      `[xero] discarding a saved drain state written against cursor ${JSON.stringify(savedDrain.cursor)}; ` +
      `the cursor now reads ${JSON.stringify(cursorValue)}. This poll re-establishes the window from scratch.`,
    )
  }

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

      const value = through.toISOString()
      await db.setting.upsert({
        where: { key: CURSOR_KEY },
        create: { key: CURSOR_KEY, value },
        update: { value },
      })
      cursorValue = value
      return 'continue'
    },
    // Real HTTP attempts, not fetcher invocations: xeroGet retries a 429 internally, so one
    // invocation can be several tenant API calls (o3d-8f9 r3).
    xeroHttpAttemptCount,
    resumable
      ? { windowEnd: resumable.windowEnd, watermark: resumable.watermark, spanMs: resumable.spanMs }
      : null,
  )

  if (!drain.ok) result.errors.push(`Xero invoice fetch failed: ${drain.error}`)

  // o3d-pzu0: persist (or clear) the continuation — INCLUDING after an error. An error holds the
  // cursor, which means the window and the watermark are both still correct; throwing the state
  // away there would make the very next poll pay the 21-request rediscovery to be told the same
  // thing it was just told for one request.
  const drainRemainingMs = drain.continuation
    ? Math.max(0, Date.parse(drain.continuation.windowEnd) - Date.parse(drain.continuation.watermark))
    : undefined
  if (drain.continuation) {
    const value = JSON.stringify({
      cursor: cursorValue,
      ...drain.continuation,
      polls: (resumable?.polls ?? 0) + 1,
      startedAt: resumable?.startedAt ?? pollStartedAt.toISOString(),
    } satisfies PersistedDrainState)
    await db.setting.upsert({
      where: { key: DRAIN_STATE_KEY },
      create: { key: DRAIN_STATE_KEY, value },
      update: { value },
    })
  } else if (drainStateRow) {
    // The window is finished (or was read whole). A leftover row would make the next poll resume a
    // drain that no longer exists.
    await db.setting.deleteMany({ where: { key: DRAIN_STATE_KEY } })
  }

  // o3d-pzu0 — CURSOR LAG, and whether it is actually shrinking.
  //
  // A drain that runs every 15 minutes, checkpoints every chunk and never catches up is
  // indistinguishable from a healthy one in every signal this poller emitted: it reports chunks
  // processed and a WARNING that says "the remainder resumes on the next poll", forever. What was
  // missing is the second derivative — whether the backlog is getting smaller.
  const cursorLagMs = Math.max(0, pollStartedAt.getTime() - checkpoint.getTime())
  const previousLag = readJsonSetting<CursorLagState>(
    (await db.setting.findUnique({ where: { key: LAG_STATE_KEY } }))?.value,
  )
  const lagVerdict = assessCursorLag(previousLag, cursorLagMs)
  const lagValue = JSON.stringify({
    lagMs: cursorLagMs,
    at: pollStartedAt.toISOString(),
    stalledPolls: lagVerdict.stalledPolls,
  } satisfies CursorLagState)
  await db.setting.upsert({
    where: { key: LAG_STATE_KEY },
    create: { key: LAG_STATE_KEY, value: lagValue },
    update: { value: lagValue },
  })

  result.xeroRequests = drain.requests
  result.cursorLagMs = cursorLagMs
  if (drainRemainingMs !== undefined) result.drainRemainingMs = drainRemainingMs

  if (lagVerdict.escalate) {
    const previousMinutes = previousLag ? Math.round(previousLag.lagMs / 60_000) : null
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_payment_poll_lag_not_converging',
      tag: 'sync',
      // ERROR, not WARNING. The draining WARNING below is the "this is working, give it time"
      // signal; this one contradicts it, and an operator who has learned to ignore the first must
      // not have to notice that the wording changed.
      level: 'ERROR',
      description:
        `Xero payment detection is falling behind and NOT catching up: the cursor is ` +
        `${Math.round(cursorLagMs / 60_000)} minutes behind` +
        (previousMinutes === null ? '' : ` (was ${previousMinutes} at the previous poll)`) +
        `, and ${lagVerdict.stalledPolls} consecutive polls have failed to remove a full minute of it. ` +
        `This poll spent ${drain.requests} Xero request(s) and processed ${drain.chunks} chunk(s)` +
        (drainRemainingMs === undefined
          ? ''
          : `, leaving ${Math.round(drainRemainingMs / 60_000)} minutes of the window still to drain`) +
        `. Sustained ingress is at or above what a bounded drain can carry ` +
        `(${MAX_CHUNKS_PER_POLL} chunks x ${MAX_PAGES * PAGE_SIZE} rows per run), so payments are ` +
        `being detected late and will stay late until the backlog source is dealt with (o3d-pzu0).`,
      metadata: {
        cursorLagMs,
        previousCursorLagMs: previousLag?.lagMs ?? null,
        stalledPolls: lagVerdict.stalledPolls,
        stallThreshold: LAG_STALL_POLLS,
        xeroRequests: drain.requests,
        chunks: drain.chunks,
        drainRemainingMs: drainRemainingMs ?? null,
        drainPolls: resumable ? resumable.polls + 1 : 1,
        drainStartedAt: resumable?.startedAt ?? null,
      },
      resolveUser: false,
    })
  }

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
