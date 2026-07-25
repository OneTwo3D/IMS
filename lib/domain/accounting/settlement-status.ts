/**
 * Is a locally-paid invoice or bill actually SETTLED in the ledger? (o3d-lgo.15)
 *
 * markBillPaid marks a bill paid in IMS and merely QUEUES the BILL_PAYMENT. Everything after that can
 * fail — a missing scope, a stale bank-account mapping, any Xero error — and when it does, Xero never
 * settles the bill and never posts its native realised FX, while IMS goes on reporting the bill as paid.
 * The two systems disagree and nothing says so. Manual sales receipts are looser still: addPayment
 * records the payment locally without queueing an INVOICE_PAYMENT at all.
 *
 * The durable dependency already exists — it is the accounting_sync_logs row — but nothing READS it back
 * to qualify the local state. That is what this does: derive, from the payment sync row, whether the
 * ledger has confirmed the settlement, and say so in words an operator can act on.
 *
 * DELIBERATELY A DERIVATION, NOT A SECOND STORED FLAG. A stored "confirmed" boolean would be one more
 * thing to keep in step with the sync log, and the two would eventually disagree — which is precisely
 * the class of bug being fixed here.
 */

/** The payment sync row for one invoice/bill, reduced to what the verdict depends on. */
export type PaymentSyncRow = {
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
  externalTransactionId?: string | null
  errorMessage?: string | null
  retryCount?: number
  /** What was actually sent to the ledger, in the document's currency. */
  amount?: number | null
}

export type SettlementStatus =
  /** Not paid in IMS either — nothing to reconcile. */
  | 'UNPAID'
  /** Paid in IMS, and the ledger has confirmed the payment IN FULL. The only fully-settled state. */
  | 'SETTLED'
  /** The ledger confirmed a payment, but for LESS than the document total — a balance remains. */
  | 'PARTIALLY_SETTLED'
  /** Paid in IMS, payment queued, ledger has not confirmed yet. Normal, briefly. */
  | 'AWAITING_LEDGER'
  /** Paid in IMS, and the payment FAILED to post. The ledger still shows it outstanding. */
  | 'LEDGER_REJECTED'
  /** Paid in IMS and no payment was ever queued — the ledger will never learn about it. */
  | 'NOT_SENT'
  /** Paid in IMS while the accounting connector is off. Not a fault; nothing is expected to post. */
  | 'NOT_APPLICABLE'

export type SettlementVerdict = {
  status: SettlementStatus
  /** True when IMS claims settlement the ledger does not support. The thing worth alerting on. */
  discrepancy: boolean
  /** One line, written for whoever has to fix it. */
  detail: string
}

export function settlementStatus(input: {
  /** Has the document been marked paid in IMS? */
  paidLocally: boolean
  /** Is an accounting connector enabled and syncing? When it is not, nothing is expected to post. */
  syncEnabled: boolean
  /**
   * Has the DOCUMENT itself reached the ledger (it has an external id)? A payment cannot be attached to
   * an invoice the ledger has never seen, so an unposted document is not a settlement fault — it is an
   * earlier one, and reporting it as a missing payment would send someone looking in the wrong place.
   */
  documentPosted: boolean
  /** The latest payment sync row for this document, if any was ever queued. */
  payment: PaymentSyncRow | null
  /** The document total in its own currency, to tell a full settlement from a part payment. */
  totalForeign?: number | null
}): SettlementVerdict {
  if (!input.paidLocally) {
    return { status: 'UNPAID', discrepancy: false, detail: 'Not marked as paid.' }
  }

  // A payment that already FAILED or was CANCELLED is a fact, and turning sync off does not unmake it.
  // Evaluating the flag first meant an operator disabling an unhealthy connector turned a known
  // outstanding ledger balance into a green badge (Codex, PR #570 round 2).
  const terminal = input.payment && (input.payment.status === 'FAILED' || input.payment.status === 'CANCELLED')

  if (!input.syncEnabled && !terminal) {
    return {
      status: 'NOT_APPLICABLE',
      discrepancy: false,
      detail: 'Marked as paid. Accounting sync is off, so no payment is expected in the ledger.',
    }
  }
  if (!input.documentPosted && !terminal) {
    return {
      status: 'NOT_APPLICABLE',
      discrepancy: false,
      detail:
        'Marked as paid, but this document has not posted to the ledger yet — a payment cannot be ' +
        'attached until it has. The document sync is what to chase, not the payment.',
    }
  }

  const p = input.payment
  if (!p) {
    return {
      status: 'NOT_SENT',
      discrepancy: true,
      detail:
        'Marked as paid in IMS, but NO payment was ever queued for the ledger — it will never learn ' +
        'about this settlement on its own. The ledger still shows the full amount outstanding.',
    }
  }

  switch (p.status) {
    case 'SYNCED': {
      if (!p.externalTransactionId) {
        // A success we cannot point at is not a settlement: there is nothing to reconcile against, and
        // claiming otherwise would hide the very disagreement this exists to surface.
        return {
          status: 'AWAITING_LEDGER',
          discrepancy: true,
          detail: 'The payment sync reports success but recorded no ledger payment id, so the settlement cannot be verified.',
        }
      }
      // PART PAYMENT IS NOT SETTLEMENT. markBillPaid accepts an explicit amountForeign and queues only
      // that, so a GBP1 payment against a GBP1,000 bill posted a SYNCED row with an id — and a green
      // "Paid" badge over the GBP999 the ledger still shows outstanding (Codex, PR #570 round 2).
      const total = input.totalForeign
      const paid = p.amount
      if (typeof total === 'number' && typeof paid === 'number' && total > 0 && paid + 0.005 < total) {
        return {
          status: 'PARTIALLY_SETTLED',
          discrepancy: true,
          detail:
            `The ledger recorded a PART payment of ${paid} against a total of ${total} (payment ` +
            `${p.externalTransactionId}), so a balance is still outstanding there while IMS shows this ` +
            `as paid in full.`,
        }
      }
      return { status: 'SETTLED', discrepancy: false, detail: `Settled in the ledger (payment ${p.externalTransactionId}).` }
    }
    case 'PENDING':
    case 'PROCESSING':
      return {
        status: 'AWAITING_LEDGER',
        discrepancy: false,
        detail: p.retryCount
          ? `Payment queued for the ledger; ${p.retryCount} attempt(s) have failed so far and it is still retrying.`
          : 'Payment queued for the ledger, not yet confirmed.',
      }
    case 'FAILED':
      return {
        status: 'LEDGER_REJECTED',
        discrepancy: true,
        detail:
          `The ledger REJECTED this payment, so it still shows the amount outstanding while IMS reports ` +
          `it paid: ${p.errorMessage ?? 'no error recorded'}`,
      }
    case 'CANCELLED':
      return {
        status: 'NOT_SENT',
        discrepancy: true,
        detail:
          'The payment sync was cancelled, so the ledger was never told about this settlement and still ' +
          'shows the amount outstanding.',
      }
  }
}

/** The states worth surfacing as a problem rather than as progress. */
export function isSettlementDiscrepancy(v: SettlementVerdict): boolean {
  return v.discrepancy
}
