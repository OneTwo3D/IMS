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

import {
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
  isOperatorAssertedSettlement,
} from '@/lib/domain/accounting/sync-row-settlement'
import { hasPostEvidence, registrationLedgerStanding } from './payment-ledger-hold'

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
  /**
   * HOW this row reached its status (o3d-nf9i r3). NULL / absent = the connector's own writeback,
   * i.e. a real call was made and the ledger answered. 'OPERATOR_ASSERTION' = a human typed the
   * document id into the settlement dialog and IMS verified NOTHING — see the SYNCED branch below,
   * which must not turn that into a SETTLED verdict however well the numbers line up.
   */
  settlementBasis?: string | null
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
  /**
   * NOT paid in IMS, and a payment for it was ATTEMPTED with no record of what the ledger did. The
   * state nobody can speak for: not "settled", not "nothing was sent", and emphatically not UNPAID.
   */
  | 'LEDGER_UNDECIDED'
  /** The ledger recorded MORE than IMS claims was received — it is over-paid there. */
  | 'OVER_SETTLED'
  /**
   * An OPERATOR asserted that the payment posted, and nothing has verified it — least of all the
   * amount. Not a settlement and not a rejection: a claim with a weaker basis than either.
   */
  | 'ASSERTED_UNVERIFIED'

/**
 * WHAT THE VERDICT RESTS ON — the answer's basis, returned alongside the answer (o3d-nf9i r3).
 *
 * `exceptions` settled the principle: a verdict reached by falling back is a materially weaker claim
 * than the same verdict reached from a declaration, and a caller acting on the weak one must be able
 * to NAME which it got. The same applies here, on the money path:
 *
 *   LEDGER_CONFIRMED   the connector made the call and the ledger answered. The amount in the row
 *                      is the amount that was sent, so comparing it against the total means
 *                      something.
 *   OPERATOR_ASSERTION a human said so. No call was made, no document was read, no figure was
 *                      compared — only an id was typed in. The amount in the row is what IMS
 *                      INTENDED to send, which is not evidence of what the ledger recorded.
 *   NONE               no post is EVIDENCED, so there is no post to have a basis. That covers two
 *                      different worlds and deliberately does not choose between them: nothing was
 *                      sent, or something was ATTEMPTED and its outcome was never recorded
 *                      (LEDGER_UNDECIDED). NONE is the absence of a basis, NOT the claim that
 *                      nothing posted — the status is what distinguishes those.
 */
export type SettlementEvidenceBasis = 'LEDGER_CONFIRMED' | 'OPERATOR_ASSERTION' | 'NONE'

export type SettlementVerdict = {
  status: SettlementStatus
  /** True when IMS claims settlement the ledger does not support. The thing worth alerting on. */
  discrepancy: boolean
  /** One line, written for whoever has to fix it. */
  detail: string
  /** What the verdict rests on. Never inferred by the caller — see SettlementEvidenceBasis. */
  basis: SettlementEvidenceBasis
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
    //
    // AND THE ROW IS CLASSIFIED BY THE SAME FUNCTION THE DELETE USES (Codex, PR #626 round 2). This
    // test used to be a hand-written status list, and it read the third answer — an ATTEMPT nobody
    // can speak for — as neither held nor anything else, which here means UNPAID with no discrepancy
    // at all. So the exact row deletePayment refuses to touch, on the grounds that a payment may be
    // standing in a real ledger with nothing local to match it, was displayed as a plainly unpaid
    // order that needs no attention: one module refusing to act, the other saying there is nothing
    // to act on. registrationLedgerStanding is now the only place that question is answered.
    const p = input.payment
    if (p) {
      // THREE ANSWERS, NOT TWO (this branch), EACH CARRYING ITS OWN BASIS (o3d-nf9i r3). The status
      // comes from registrationLedgerStanding — the same classifier the delete refuses on, so the two
      // cannot drift — and the basis comes from how the row reached that standing.
      const standing = registrationLedgerStanding(p)
      const asserted = isOperatorAssertedSettlement(p.settlementBasis)
      if (standing === 'HELD') {
        return {
          status: 'LEDGER_UNMATCHED',
          discrepancy: true,
          detail:
            'This is NOT marked as paid in IMS, but a payment for it was sent to the ledger' +
            (p.externalTransactionId ? ` (payment ${p.externalTransactionId})` : '') +
            (asserted
              ? '. That is an OPERATOR ASSERTION, not something the ledger confirmed — nobody has checked the '
                + 'document or its amount. Verify it in the accounting system, then reverse the payment there or '
                + 'restore the receipt here.'
              : '. The ledger shows it settled while IMS does not — reverse the payment there, or restore it here.'),
          basis: asserted ? 'OPERATOR_ASSERTION' : 'LEDGER_CONFIRMED',
        }
      }
      if (standing === 'UNDECIDED') {
        return {
          status: 'LEDGER_UNDECIDED',
          discrepancy: true,
          // WHAT THIS MUST NOT SAY, in either direction: not "the ledger holds a payment" (none is
          // known to) and not "nothing was sent" (an attempt was made). The ledger is called BEFORE
          // the result is written down, so a FAILED row with no payment reference is a failure
          // recorded in front of a payment that may well exist.
          detail:
            'This is NOT marked as paid in IMS, and a payment for it was ATTEMPTED in the ledger but the ' +
            'outcome was never recorded' +
            (p.errorMessage ? ` (${p.errorMessage})` : '') +
            '. The accounting system is called before the result is written down, so this is not proof ' +
            'that nothing posted — open the invoice there and check whether a payment is on it before ' +
            'recording or registering anything else against it.',
          // NONE is the ABSENCE of a basis, which is exactly the finding: no post is evidenced. It is
          // NOT the claim that nothing posted — the status is what carries that, and it deliberately
          // does not make it.
          basis: 'NONE',
        }
      }
    }
    return { status: 'UNPAID', discrepancy: false, detail: 'Not marked as paid.', basis: 'NONE' }
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
      basis: 'NONE',
    }
  }
  if (!input.documentPosted && !terminal) {
    return {
      status: 'NOT_APPLICABLE',
      discrepancy: false,
      detail:
        'Marked as paid, but this document has not posted to the ledger yet — a payment cannot be ' +
        'attached until it has. The document sync is what to chase, not the payment.',
      basis: 'NONE',
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
      basis: 'NONE',
    }
  }

  const assertedPost = isOperatorAssertedSettlement(p.settlementBasis)

  switch (p.status) {
    case 'SYNCED': {
      if (!p.externalTransactionId) {
        // A success we cannot point at is not a settlement: there is nothing to reconcile against, and
        // claiming otherwise would hide the very disagreement this exists to surface.
        return {
          status: 'AWAITING_LEDGER',
          discrepancy: true,
          detail: 'The payment sync reports success but recorded no ledger payment id, so the settlement cannot be verified.',
          basis: assertedPost ? 'OPERATOR_ASSERTION' : 'LEDGER_CONFIRMED',
        }
      }
      // A MONETARY-ONLY COMPARISON FAILS CLOSED ON AN ASSERTED ROW (o3d-nf9i r3, Codex finding 1).
      //
      // Everything below this point compares `p.amount` against `input.totalForeign` and, when they
      // agree, returns SETTLED with `discrepancy: false` — a clean, green, ledger-confirmed verdict.
      // That comparison is only evidence when a connector actually SENT p.amount and the ledger
      // accepted it. On an operator-asserted row nothing was sent: `p.amount` is what IMS INTENDED
      // to queue, and the external id is a string a human typed after looking at a screen. Xero
      // accepts a payment smaller than the invoice as a PART payment and hands back a perfectly
      // valid payment id, so the asserted id can name a part payment while IMS's two local numbers
      // agree with each other exactly. Matching numbers prove the assertion is SELF-CONSISTENT, not
      // that the ledger holds what IMS thinks it holds.
      //
      // So the comparison is not run at all here, and the verdict states its basis instead of
      // borrowing the confirmed one. It is a DISCREPANCY: IMS is claiming a settlement nothing has
      // checked, which is precisely what this module exists to surface. The remedy is nameable and
      // an operator can perform it — open the document in the accounting system and confirm the
      // amount — which is what the detail says.
      if (assertedPost) {
        return {
          status: 'ASSERTED_UNVERIFIED',
          discrepancy: true,
          basis: 'OPERATOR_ASSERTION',
          detail:
            `An operator recorded this as paid in the ledger (payment ${p.externalTransactionId}) on their own ` +
            `assertion — IMS never made the call, never read the document and never compared the amount. The ` +
            `figure shown here (${typeof p.amount === 'number' ? p.amount : 'unknown'}) is what IMS meant to send, ` +
            `not what the ledger recorded, so a part payment against this invoice would look identical. Open ` +
            `payment ${p.externalTransactionId} in the accounting system and confirm its amount against the ` +
            `document total.`,
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
          basis: 'LEDGER_CONFIRMED',
        }
      }
      // OVER-PAYMENT IS ALSO A DISAGREEMENT, and only the shortfall was being checked (Codex, PR #582
      // round 6). Reachable after a synced receipt is deleted and a SMALLER correction recorded: the
      // ledger keeps the larger payment, the correction is refused as a second live registration, and
      // comparing "ledger 100" against "claimed 40" one way round returned a green Settled over an
      // invoice the ledger has been over-paid on.
      if (typeof total === 'number' && typeof paid === 'number' && total > 0 && paid > total + 0.005) {
        return {
          status: 'OVER_SETTLED',
          discrepancy: true,
          detail:
            `The ledger recorded ${paid} against a settlement of ${total} (payment ` +
            `${p.externalTransactionId}), so it is OVER-paid there — reverse or adjust the payment in the ledger.`,
          basis: 'LEDGER_CONFIRMED',
        }
      }
      return {
        status: 'SETTLED',
        discrepancy: false,
        detail: `Settled in the ledger (payment ${p.externalTransactionId}).`,
        basis: 'LEDGER_CONFIRMED',
      }
    }
    case 'PENDING':
    case 'PROCESSING':
      return {
        status: 'AWAITING_LEDGER',
        discrepancy: false,
        detail: p.retryCount
          ? `Payment queued for the ledger; ${p.retryCount} attempt(s) have failed so far and it is still retrying.`
          : 'Payment queued for the ledger, not yet confirmed.',
        basis: 'NONE',
      }
    case 'FAILED':
      // POST EVIDENCE OUTRANKS STATUS ON THIS SIDE TOO. A FAILED row that NAMES a document is a
      // failure written down in front of a payment that exists, and "the ledger still shows the
      // amount outstanding" over one of those is how an operator is talked into registering a second
      // payment — making the sentence true twice over. Both readings stay a discrepancy, because
      // IMS's own record of the settlement is unresolved either way; only the instruction differs.
      if (hasPostEvidence(p)) {
        return {
          status: 'LEDGER_REJECTED',
          discrepancy: true,
          detail:
            `The payment sync failed AFTER the ledger returned payment ${p.externalTransactionId}, so that ` +
            `payment may well be attached to the invoice there while IMS's record of it is unresolved. Check ` +
            `it in the accounting system before registering another: ${p.errorMessage ?? 'no error recorded'}`,
          // The post evidence is the document id. On a connector row the ledger handed it back; on an
          // asserted row a human typed it, which is a weaker claim and must say so.
          basis: assertedPost ? 'OPERATOR_ASSERTION' : 'LEDGER_CONFIRMED',
        }
      }
      return {
        status: 'LEDGER_REJECTED',
        discrepancy: true,
        detail:
          `The ledger REJECTED this payment, so it still shows the amount outstanding while IMS reports ` +
          `it paid: ${p.errorMessage ?? 'no error recorded'}. The attempt names no payment reference, and ` +
          `the ledger is called before the result is written down — so confirm on the invoice there before ` +
          `registering another payment.`,
        basis: 'NONE',
      }
    case 'CANCELLED':
      return {
        status: 'NOT_SENT',
        discrepancy: true,
        detail:
          'The payment sync was cancelled, so the ledger was never told about this settlement and still ' +
          'shows the amount outstanding.',
        basis: 'NONE',
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
  // THE BASIS AGGREGATES WORST-FIRST, exactly as the status does (o3d-nf9i r3). One asserted leg
  // among several makes the WHOLE settlement unverified: the sum being compared against the document
  // total now contains a number nothing checked, so the comparison cannot be trusted for any of it.
  // Dropping the marker here would have re-laundered the assertion one function further along —
  // the aggregate would have arrived at settlementStatus looking connector-confirmed.
  const syncedBasis = synced.some((r) => isOperatorAssertedSettlement(r.settlementBasis))
    ? OPERATOR_ASSERTION_SETTLEMENT_BASIS
    : null

  const failed = rows.find((r) => r.status === 'FAILED')
  if (failed) {
    return { ...failed, amount: syncedAmount, settlementBasis: failed.settlementBasis ?? syncedBasis }
  }
  const cancelled = rows.find((r) => r.status === 'CANCELLED')
  if (cancelled) {
    return { ...cancelled, amount: syncedAmount, settlementBasis: cancelled.settlementBasis ?? syncedBasis }
  }
  const inFlight = rows.filter((r) => r.status === 'PENDING' || r.status === 'PROCESSING')
  if (inFlight.length > 0) {
    return {
      status: inFlight.some((r) => r.status === 'PROCESSING') ? 'PROCESSING' : 'PENDING',
      externalTransactionId: null,
      errorMessage: inFlight.find((r) => r.errorMessage)?.errorMessage ?? null,
      retryCount: inFlight.reduce((max, r) => Math.max(max, r.retryCount ?? 0), 0),
      amount: syncedAmount,
      settlementBasis: syncedBasis,
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
    settlementBasis: syncedBasis,
  }
}

/**
 * The total the LEDGER's copy of a sales invoice was actually built at, which is what a payment against
 * it has to match.
 *
 * IT IS NOW THE ORDER TOTAL IN EVERY CASE — o3d-cyn landed, and this is the collapse that issue's own
 * note promised. Both invoice-construction paths post at the order's gross total:
 *
 *  • raised IN IMS — `queueSalesInvoiceForOrder` sends the GROSS unit prices (and grosses shipping up)
 *    before flagging them inclusive, so the invoice totals to the order. This was always true, and
 *    keying on `pricesIncludeVat` ALONE understated it: since a hand-recorded receipt is for the gross
 *    the customer paid, the over-pay guard then refused every ordinary VAT receipt it exists to allow
 *    (Codex, PR #582 round 1).
 *  • IMPORTED from WooCommerce — the importer now sends every component EX-TAX with
 *    `lineAmountsIncludeTax: false` on both price conventions, and Xero adds the tax, so this too
 *    totals to the order. Previously it sent Woo's ex-tax amounts flagged tax-INCLUSIVE, Xero read the
 *    net figure as the gross one, and an imported tax-inclusive invoice posted at the NET total — which
 *    is what the subtraction here existed to model.
 *
 * THE RESIDUAL, and it is a real one: invoices IMPORTED AND POSTED BEFORE o3d-cyn are still sitting in
 * the ledger at their net total. A gross receipt against one of those now passes this guard and is
 * refused by XERO instead (amount exceeds the outstanding amount), which surfaces as a failed
 * INVOICE_PAYMENT sync row naming the invoice. That is a visible refusal with a remedy — correct the
 * invoice in Xero, or re-post it, then retry the payment row — rather than the alternative, which would
 * be refusing the ordinary receipt on every correctly-built invoice from here on.
 *
 * The two inputs below are kept and deliberately NOT read. They are what the answer used to depend on,
 * and they are the seam a per-order marker would attach to if the historical invoices are ever
 * distinguished properly (the posted SALES_INVOICE payload's own `lineAmountsIncludeTax` is the exact
 * signal); reading either of them again would re-introduce the defect this collapse removes.
 */
export function ledgerSalesInvoiceTotalForeign(input: {
  totalForeign: number
  taxForeign: number
  pricesIncludeVat: boolean
  /** Did this order arrive from a shop connector (WooCommerce), rather than being raised in IMS? */
  importedFromShop: boolean
}): number {
  return input.totalForeign
}
