// ---------------------------------------------------------------------------
// Detected-payment-reversal handling (onetwo3d-ims-6oyu.6)
//
// The Xero payment poller's reversal pass now includes WooCommerce-linked paid
// orders (the bulk of volume), not just manual orders — a reversed payment /
// chargeback on a WC order must clear paidAt and unwind recognised revenue too.
//
// Dedup contract: the WooCommerce refund webhook stays AUTHORITATIVE for the
// REVENUE reversal of WC orders. The poller must never raise a SECOND credit note
// for a reversal the WC refund path already handled. Two layers protect this:
//   (1) raiseChargebackForReversedOrder is itself idempotent and refuses any order
//       that already has a WC-side refund or a prior chargeback — the authoritative
//       guard against a double credit note.
//   (2) This handler adds an explicit, WINDOW-SCOPED guard
//       (wasHandledByRecentWcRefund): when a WC refund landed in the current poll
//       window it skips the redundant chargeback attempt and logs quietly instead
//       of alarming finance. It is window-scoped so a HISTORIC partial refund can
//       never permanently suppress a genuine later reversal (that case flows to
//       manual review with a paidAt clear + alert).
//
// paidAt reconciliation is UNCONDITIONAL on a genuine Xero regression: the payment
// is gone in Xero regardless of channel, and the WC refund path does not clear
// paidAt itself. Only a FAILED chargeback holds paidAt (so it is re-attempted).
//
// This module is the pure, dependency-injected decision+execution unit so the
// policy is unit-testable without a database or Xero. The poller supplies
// db/Xero-backed closures.
// ---------------------------------------------------------------------------

export type DetectedReversalOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  accountingInvoiceId: string | null
  revenueDeferredDate: Date | null
}

export type ReversalEffects = {
  /**
   * True when a WooCommerce-side refund (a SalesOrderRefund carrying a non-null
   * externalRefundId) was recorded within the current poll window — i.e. the
   * revenue reversal is already owned by the authoritative WC refund path. Scoped
   * to the window so a historic refund does not suppress a fresh genuine reversal.
   */
  wasHandledByRecentWcRefund: (orderId: string) => Promise<boolean>
  /**
   * Raise the revenue-unwind chargeback credit note. Idempotent per order and
   * refuses orders with any prior refund: a benign re-run returns { raised: false }
   * with no error; a still-pending/failed reversal returns an `error` so paidAt is
   * held and the reversal is re-attempted on the next poll.
   */
  raiseChargeback: (orderId: string) => Promise<{ raised?: boolean; error?: string }>
  clearPaidAt: (orderId: string) => Promise<void>
  // Alert + audit ALWAYS fire on a completed reversal (status is never auto-reverted).
  // `wcHandled` carries whether a recent WC refund may already cover the revenue side,
  // so the message can add context — but the alert is never suppressed, since a WC
  // refund can only PARTIALLY explain a full payment removal and that still needs review.
  notifyNeedsAttention: (order: DetectedReversalOrder, ctx: { wcHandled: boolean }) => Promise<void>
  logReversalDetected: (order: DetectedReversalOrder, ctx: { wcHandled: boolean }) => Promise<void>
}

export type ReversalOutcome = 'reversed' | 'chargeback-failed'

/**
 * Handle a single detected payment reversal for a paid sales order.
 *
 *  1. Determine whether a recent WC refund already owns the revenue reversal.
 *  2. Raise the chargeback credit note only when revenue was recognised, the
 *     invoice is still live (a VOIDED invoice already had AR/revenue reversed by
 *     Xero), and no recent WC refund covers it. A failed chargeback HOLDS paidAt.
 *  3. Clear paidAt unconditionally (payment is gone in Xero) once no chargeback is
 *     owed or the chargeback succeeded.
 *  4. Alert + audit ALWAYS fire (status is never auto-reverted). A WC-handled
 *     reversal is alerted too — the refund may only partially cover a full payment
 *     removal — with WC context so finance can distinguish it.
 */
export async function handleDetectedReversal(
  order: DetectedReversalOrder,
  opts: { invoiceVoided: boolean },
  effects: ReversalEffects,
): Promise<{ outcome: ReversalOutcome; wcHandled: boolean; error?: string }> {
  const wcHandled = await effects.wasHandledByRecentWcRefund(order.id)

  // Revenue unwind — skipped when a recent WC refund already reversed revenue (no
  // double credit note), the invoice is VOIDED, or no revenue was recognised.
  if (order.revenueDeferredDate && !opts.invoiceVoided && !wcHandled) {
    let error: string | undefined
    try {
      const chargeback = await effects.raiseChargeback(order.id)
      if (chargeback.error) error = chargeback.error
    } catch (chargebackError) {
      error = String(chargebackError)
    }
    // Hold paidAt on a failed chargeback so the reversal is re-attempted and the
    // order is not silently shown unpaid-and-unreversed.
    if (error) return { outcome: 'chargeback-failed', wcHandled, error }
  }

  // Payment is genuinely gone in Xero → reconcile paidAt regardless of channel.
  await effects.clearPaidAt(order.id)

  // Always surface for manual review — a WC-handled reversal is flagged too (it may
  // only partially explain the removal), just with WC context.
  await effects.notifyNeedsAttention(order, { wcHandled })
  await effects.logReversalDetected(order, { wcHandled })
  return { outcome: 'reversed', wcHandled }
}
