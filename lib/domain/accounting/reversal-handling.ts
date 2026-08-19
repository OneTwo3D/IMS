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
// paidAt itself. Only a TRANSIENTLY failed chargeback holds paidAt (so it is
// re-attempted); a refusal polling cannot clear — the posted-VAT fence declining to
// unwind an invoice at a rate the order never charged — reconciles paidAt and alerts
// on the first failure instead, since re-attempting it forever would show the order
// paid after Xero proved otherwise (o3d-w00 / Codex r8 #3).
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
   *
   * o3d-w00 (Codex r8 #3): `manualResolutionRequired` marks an error that POLLING CANNOT CLEAR — the
   * posted-VAT fence refusing to unwind the invoice at a rate the order never charged, which stands
   * until an admin changes the tax configuration. Holding paidAt for that is not a retry cursor, it is
   * IMS showing an order paid after Xero has proved the payment is gone, indefinitely and silently.
   */
  raiseChargeback: (orderId: string) => Promise<{ raised?: boolean; error?: string; manualResolutionRequired?: boolean }>
  clearPaidAt: (orderId: string) => Promise<void>
  // Alert + audit ALWAYS fire on a completed reversal (status is never auto-reverted).
  // `wcHandled` carries whether a recent WC refund may already cover the revenue side,
  // so the message can add context — but the alert is never suppressed, since a WC
  // refund can only PARTIALLY explain a full payment removal and that still needs review.
  // `chargebackManualReason` carries the non-transient refusal, so the alert and the audit entry say
  // that the revenue unwind is OUTSTANDING and why, rather than reading as a clean reversal.
  notifyNeedsAttention: (order: DetectedReversalOrder, ctx: ReversalContext) => Promise<void>
  logReversalDetected: (order: DetectedReversalOrder, ctx: ReversalContext) => Promise<void>
}

export type ReversalContext = {
  wcHandled: boolean
  chargebackManualReason?: string
  /**
   * o3d-w00 (Codex r9 #4): whether paidAt was ACTUALLY cleared before this alert/audit entry was
   * written. The notification fires even when the clear failed — it is the only thing that makes a
   * permanent refusal visible — so the message must not claim a reconciliation that did not happen.
   */
  paidAtCleared: boolean
}

export type ReversalOutcome =
  | 'reversed'
  | 'chargeback-failed'
  | 'chargeback-manual'
  /**
   * The reversal DECISION was made and everything that could be attempted was, but at least one of
   * the three closing effects (clear paidAt, alert, audit) failed. Never counted as reversed, always
   * reported, so the poll's cursor gate does not advance over it.
   */
  | 'reversal-incomplete'

/**
 * Handle a single detected payment reversal for a paid sales order.
 *
 *  1. Determine whether a recent WC refund already owns the revenue reversal.
 *  2. Raise the chargeback credit note only when revenue was recognised, the
 *     invoice is still live (a VOIDED invoice already had AR/revenue reversed by
 *     Xero), no recent WC refund covers it, and the ledger is not still holding a
 *     payment against the invoice. A TRANSIENTLY failed chargeback HOLDS paidAt;
 *     one refused for a reason polling cannot clear does not.
 *  3. Clear paidAt unconditionally (payment is gone in Xero) once no chargeback is
 *     owed, the chargeback succeeded, or it was refused non-transiently.
 *  4. Alert + audit ALWAYS fire (status is never auto-reverted). A WC-handled
 *     reversal is alerted too — the refund may only partially cover a full payment
 *     removal — with WC context so finance can distinguish it. Steps 3 and 4 are
 *     attempted INDEPENDENTLY (Codex r9 #4): one failing never suppresses the others,
 *     and any failure returns `reversal-incomplete` rather than a clean outcome.
 */
export async function handleDetectedReversal(
  order: DetectedReversalOrder,
  opts: {
    invoiceVoided: boolean
    /**
     * The reversal was established by the PAYMENT'S IDENTITY — the payment IMS registered is gone from
     * the invoice — while the ledger still holds a payment against it, or did not state what it holds
     * (o3d-clxw round 2).
     *
     * paidAt is still cleared: the payment IMS recorded really has gone. The CHARGEBACK is not raised,
     * because it reverses the WHOLE recognised revenue against AR, and doing that to an invoice the
     * ledger is still holding money for unwinds more than was reversed. That is round 1's rule
     * unchanged — no automatic credit note against a payment the ledger is still holding — reaching
     * the one case round 1 could not see, and the alert says the decision is a human's.
     */
    ledgerStillHoldsPayment?: boolean
  },
  effects: ReversalEffects,
): Promise<{ outcome: ReversalOutcome; wcHandled: boolean; error?: string }> {
  const wcHandled = await effects.wasHandledByRecentWcRefund(order.id)

  let chargebackManualReason: string | undefined
  // Revenue unwind — skipped when a recent WC refund already reversed revenue (no
  // double credit note), the invoice is VOIDED, or no revenue was recognised.
  if (order.revenueDeferredDate && !opts.invoiceVoided && !wcHandled && !opts.ledgerStillHoldsPayment) {
    let error: string | undefined
    let manualResolutionRequired = false
    try {
      const chargeback = await effects.raiseChargeback(order.id)
      if (chargeback.error) {
        error = chargeback.error
        manualResolutionRequired = chargeback.manualResolutionRequired === true
      }
    } catch (chargebackError) {
      error = String(chargebackError)
    }
    // o3d-w00 (Codex r8 #3): a refusal the next poll CANNOT clear is not a retry cursor.
    //
    // Holding paidAt is the right answer to a TRANSIENT failure — a Xero outage, a shipment the daily
    // batch has not journaled yet — because the next poll re-attempts and completes it. It is the wrong
    // answer to a refusal that stands until a human changes the tax configuration: the payment IS gone
    // in Xero, and every poll would re-fail, leaving IMS presenting and processing the order as PAID
    // indefinitely, with no alert and no audit entry (both of which sit after this return). So payment
    // truth is reconciled immediately and finance is told on the FIRST failure, carrying the reason —
    // the revenue unwind is then outstanding and visible, rather than invisible and unpaid-and-paid at
    // the same time.
    if (error && manualResolutionRequired) {
      chargebackManualReason = error
    } else if (error) {
      // Hold paidAt on a failed chargeback so the reversal is re-attempted and the
      // order is not silently shown unpaid-and-unreversed.
      return { outcome: 'chargeback-failed', wcHandled, error }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // o3d-w00 (Codex r9 #4): THE THREE CLOSING EFFECTS ARE INDEPENDENT, AND ONE FAILING MUST NOT TAKE
  // THE OTHERS WITH IT.
  //
  // r8 #3 made a PERMANENT chargeback refusal reconcile paidAt, alert and audit on the first failure,
  // precisely because holding paidAt forever would leave the outstanding revenue unwind invisible.
  // But the three ran as one unbroken await chain: a failure in the first — a lost connection on the
  // paidAt update, an alert that cannot be delivered — threw straight out of this function, past the
  // notification and the audit entry. The part that goes missing is then the alert that was the whole
  // point of the branch, and the poller's surrounding catch abandons every remaining order in the
  // pass as well.
  //
  // So each effect is attempted on its own and its failure recorded rather than thrown. paidAt is
  // still cleared FIRST (the message says what happened, in the order it happened), but whether it
  // succeeded is carried into the context so the alert and the audit entry cannot claim a
  // reconciliation that did not occur. Any failure makes the outcome `reversal-incomplete`: not
  // counted as reversed, always reported. A failed paidAt clear is self-healing — the order still has
  // paidAt set, so the next poll re-detects it and re-runs the whole decision.
  // -----------------------------------------------------------------------------------------------
  const failures: string[] = []
  let paidAtCleared = true
  try {
    // Payment is genuinely gone in Xero → reconcile paidAt regardless of channel.
    await effects.clearPaidAt(order.id)
  } catch (clearError) {
    paidAtCleared = false
    failures.push(`clearing paidAt failed: ${String(clearError)}`)
  }

  const ctx: ReversalContext = { wcHandled, chargebackManualReason, paidAtCleared }
  // Always surface for manual review — a WC-handled reversal is flagged too (it may
  // only partially explain the removal), just with WC context.
  try {
    await effects.notifyNeedsAttention(order, ctx)
  } catch (notifyError) {
    failures.push(`notifying admins failed: ${String(notifyError)}`)
  }
  try {
    await effects.logReversalDetected(order, ctx)
  } catch (logError) {
    failures.push(`recording the audit entry failed: ${String(logError)}`)
  }

  if (failures.length > 0) {
    return {
      outcome: 'reversal-incomplete',
      wcHandled,
      error: [chargebackManualReason, ...failures].filter(Boolean).join(' '),
    }
  }
  return chargebackManualReason
    ? { outcome: 'chargeback-manual', wcHandled, error: chargebackManualReason }
    : { outcome: 'reversed', wcHandled }
}
