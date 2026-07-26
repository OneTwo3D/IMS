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
  /** The local Payment row it was queued for; null on rows the order's own invoice follow-up queued. */
  paymentId?: string | null
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
  /** NOT paid in IMS, yet the ledger holds a payment for it. The disagreement pointing the other way. */
  | 'LEDGER_UNMATCHED'

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
    // THE DISAGREEMENT POINTING THE OTHER WAY. Deleting a receipt whose registration already reached the
    // ledger succeeds locally — the payment is still attached to the invoice there, and paidAt clears
    // here. Returning a flat UNPAID without looking at the payment row hid exactly the case this exists
    // to surface, just mirrored (Codex, PR #582 round 1). A FAILED or CANCELLED row holds nothing in the
    // ledger, so it is genuinely unpaid on both sides.
    const p = input.payment
    const heldByLedger = p && (p.status === 'SYNCED' || p.status === 'PROCESSING' || p.status === 'PENDING')
    if (heldByLedger) {
      return {
        status: 'LEDGER_UNMATCHED',
        discrepancy: true,
        detail:
          'This is NOT marked as paid in IMS, but a payment for it was sent to the ledger' +
          (p.externalTransactionId ? ` (payment ${p.externalTransactionId})` : '') +
          '. The ledger shows it settled while IMS does not — reverse the payment there, or restore it here.',
      }
    }
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

/**
 * Reduce EVERY payment sync row for one document to the single row a verdict is derived from.
 *
 * A bill carries one payment, so the bill side passes one row. A sales order can carry several — part
 * payments, a manual receipt on top of an imported one — each its own sync row with its own fate.
 * Taking only the latest would print a green "Settled" over an earlier payment the ledger rejected.
 *
 * PRECEDENCE IS WORST-FIRST, because the question is "does the ledger support what IMS claims?" and one
 * unposted payment is enough for the answer to be no. That can over-report: a FAILED row later re-queued
 * as a second SYNCED row still reads as rejected. Over-reporting is the safe direction here — the detail
 * names the error, and a spurious "chase this" costs a look, while a spurious "Settled" costs a
 * reconciliation nobody knows to do.
 */
/**
 * Drop the payment sync rows that are HISTORY, so a corrected receipt does not alarm for ever.
 *
 * Two ways a terminal row outlives what it describes, both introduced by doing the right thing
 * elsewhere (Codex, PR #582 round 4):
 *
 *  1. The RECEIPT IT BELONGED TO WAS DELETED. deletePayment retires a queued registration to CANCELLED
 *     rather than deleting it — that is what keeps a worker from posting a payment whose only record we
 *     erased — and leaves FAILED rows alone. Record a receipt, delete it, record a corrected one that
 *     posts cleanly, and the aggregate's worst-first rule would still read the dead row and report
 *     NOT_SENT over a perfectly settled invoice.
 *
 *  2. A LATER ATTEMPT SUCCEEDED. A failure that a success followed has been overtaken; a failure AFTER
 *     the last success has not, and must still be reported.
 *
 * `rows` must be NEWEST FIRST — that ordering is what "later" means here.
 */
export function effectivePaymentSyncRows(
  rows: PaymentSyncRow[],
  opts: { livePaymentIds?: ReadonlySet<string> } = {},
): PaymentSyncRow[] {
  const isTerminal = (r: PaymentSyncRow) => r.status === 'FAILED' || r.status === 'CANCELLED'
  // Rows the SALES_INVOICE follow-up queued carry no payment id — they belong to the order itself, not
  // to any local receipt, so "was its receipt deleted" cannot be asked of them and they stay.
  const belongsToDeletedReceipt = (r: PaymentSyncRow) =>
    opts.livePaymentIds != null && r.paymentId != null && !opts.livePaymentIds.has(r.paymentId)

  const newestSuccessIdx = rows.findIndex((r) => r.status === 'SYNCED')
  return rows.filter((r, i) => {
    if (!isTerminal(r)) return true
    if (belongsToDeletedReceipt(r)) return false
    // Newest-first, so a higher index is OLDER: a terminal row older than the newest success is history.
    return !(newestSuccessIdx !== -1 && i > newestSuccessIdx)
  })
}

export function aggregatePaymentSyncRows(rows: PaymentSyncRow[]): PaymentSyncRow | null {
  if (rows.length === 0) return null

  const synced = rows.filter((r) => r.status === 'SYNCED')
  // A SYNCED row whose payload carries no amount makes the SUM unknowable, not zero — and a wrong sum
  // is what decides full settlement from part settlement. Unknown propagates as null, which
  // settlementStatus reads as "cannot compare" rather than as a shortfall.
  const amountUnknown = synced.some((r) => typeof r.amount !== 'number')
  const syncedAmount = amountUnknown ? null : synced.reduce((sum, r) => sum + (r.amount as number), 0)

  const failed = rows.find((r) => r.status === 'FAILED')
  if (failed) {
    return { ...failed, amount: syncedAmount }
  }
  const cancelled = rows.find((r) => r.status === 'CANCELLED')
  if (cancelled) {
    return { ...cancelled, amount: syncedAmount }
  }
  const inFlight = rows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING')
  if (inFlight.length > 0) {
    return {
      status: inFlight.some((r) => r.status === 'PROCESSING') ? 'PROCESSING' : 'PENDING',
      externalTransactionId: null,
      errorMessage: inFlight.find((r) => r.errorMessage)?.errorMessage ?? null,
      retryCount: inFlight.reduce((max, r) => Math.max(max, r.retryCount ?? 0), 0),
      amount: syncedAmount,
    }
  }

  // All SYNCED. One id that cannot be pointed at makes the WHOLE settlement unverifiable, so the missing
  // id wins over the ids we do have — settlementStatus turns a SYNCED row with no id into exactly that.
  const missingId = synced.some((r) => !r.externalTransactionId)
  return {
    status: 'SYNCED',
    externalTransactionId: missingId ? null : synced.map((r) => r.externalTransactionId).join(', '),
    errorMessage: null,
    retryCount: synced.reduce((max, r) => Math.max(max, r.retryCount ?? 0), 0),
    amount: syncedAmount,
  }
}

/**
 * The total the LEDGER's copy of a sales invoice was actually built at, which is what a payment against
 * it has to match — not necessarily the order total IMS shows.
 *
 * They differ in ONE case: a tax-inclusive order IMPORTED FROM A SHOP. WC REST line amounts are always
 * net, and order-import sends them flagged tax-inclusive, so Xero reads the net figure as the gross one
 * and the invoice posts at the NET total. That is o3d-cyn, an invoice-construction defect with its own
 * issue. A payment that matches the invoice IMS really posted is not a SETTLEMENT discrepancy, and
 * reporting it as one would send an operator to the payment when the invoice is what is wrong — the same
 * reasoning as the documentPosted branch above: name the fault people can act on.
 *
 * A tax-inclusive order raised IN IMS is NOT affected: queueSalesInvoiceSync sends the GROSS unit prices
 * (and grosses shipping up) before flagging them inclusive, so that invoice posts at the order total.
 * Keying on pricesIncludeVat ALONE understated it — and since a hand-recorded receipt is for the gross
 * the customer paid, the over-pay guard then refused every ordinary VAT receipt it exists to allow
 * (Codex, PR #582 round 1).
 *
 * When o3d-cyn lands, imported tax-inclusive invoices post at gross too and this collapses to
 * `totalForeign`.
 */
export function ledgerSalesInvoiceTotalForeign(input: {
  totalForeign: number
  taxForeign: number
  pricesIncludeVat: boolean
  /** Did this order arrive from a shop connector (WooCommerce), rather than being raised in IMS? */
  importedFromShop: boolean
}): number {
  return input.pricesIncludeVat && input.importedFromShop
    ? input.totalForeign - input.taxForeign
    : input.totalForeign
}
