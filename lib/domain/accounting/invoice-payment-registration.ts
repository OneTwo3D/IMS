/**
 * Should a manually-recorded sales receipt be registered against the ledger invoice? (o3d-lgo.15)
 *
 * An IMPORTED paid order registers its payment through the SALES_INVOICE follow-up (`_registerPayment`
 * in order-import). A receipt entered in IMS had no such path at all: the Payment row was created, the
 * order went green, and the ledger was never told — so it went on showing the invoice fully outstanding,
 * for ever. addPayment now queues an INVOICE_PAYMENT on the same principle as markBillPaid: an operator
 * recording a payment against a posted document is an instruction to settle it in the ledger too.
 *
 * The decision is GUARDED and lives here, pure, because every refusal is a judgement about money in a
 * system IMS cannot undo — a second payment registered in the ledger has to be reversed there by hand.
 * Refusing leaves the receipt recorded and the settlement verdict visibly unsettled, which is the safe
 * end: someone can act on a warning, but nobody goes looking for a payment they were never told about.
 */

import {
  classifyLedgerSettlement,
  type LedgerSettlementRecord,
} from './ledger-settlement-evidence'

export type InvoicePaymentRegistrationRefusal =
  /** Nothing is expected to post: the connector is off. Not a fault, and not worth a warning. */
  | 'SYNC_DISABLED'
  /** The invoice has not reached the ledger, so a payment has nothing to attach to. */
  | 'DOCUMENT_NOT_POSTED'
  /** The receipt is in a different currency from the order it settles. */
  | 'CURRENCY_MISMATCH'
  /** No bank account is mapped for this payment method/currency. */
  | 'NO_BANK_ACCOUNT'
  /** A registration for this order is already live in the ledger — only one at a time can be tracked. */
  | 'LEDGER_HAS_LIVE_PAYMENT'
  /**
   * An earlier attempt for this order is FAILED or CANCELLED and cannot be shown to be absent from
   * the ledger, so a second receipt could settle the same invoice twice (o3d-0m56).
   */
  | 'UNRESOLVED_PAYMENT_ATTEMPT'
  /** This receipt alone is larger than the invoice it settles, so the ledger would refuse it. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentRegistrationDecision =
  | { register: true; bankAccountId: string }
  | {
      register: false
      refusal: InvoicePaymentRegistrationRefusal
      alreadyRegistered?: number
      ledgerTotal?: number
      /** Why an unresolved attempt could not be cleared, for the operator warning. */
      detail?: string
    }

/** One INVOICE_PAYMENT sync row, reduced to what the decision depends on. */
export type ExistingInvoicePaymentSync = {
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
  /** What was sent, in the document currency. Null when the payload did not record it. */
  amount?: number | null
  /** The date that attempt sent, `YYYY-MM-DD`. Null when the payload did not pin one. */
  paymentDate?: string | null
  /** The local Payment row it was queued for; null on rows queued before that was recorded. */
  paymentId?: string | null
  /**
   * False when the stored body was missing a field the connector requires, which PROVES the attempt
   * was rejected before any HTTP call. Undefined means unknown, which reads as "it could have".
   */
  couldHaveReachedLedger?: boolean
}

/**
 * Attempts whose outcome is not established: FAILED or CANCELLED, not this receipt's own row, and
 * structurally complete enough that the connector would have made the call.
 *
 * Exported because the caller needs to know whether to ASK the ledger at all — the probe is a
 * network read and must not run on every receipt, only on the ones with a history.
 */
export function unresolvedInvoicePaymentAttempts(
  existing: ExistingInvoicePaymentSync[],
  paymentId: string,
): ExistingInvoicePaymentSync[] {
  return existing.filter((r) =>
    (r.status === 'FAILED' || r.status === 'CANCELLED')
    && (r.paymentId == null || r.paymentId !== paymentId)
    && r.couldHaveReachedLedger !== false)
}

export function decideInvoicePaymentRegistration(input: {
  syncEnabled: boolean
  /** The ledger's id for the invoice, or null if it has not posted. */
  accountingInvoiceId: string | null
  orderCurrency: string
  paymentCurrency: string
  paymentAmount: number
  /** The local Payment row being registered — its own sync row must not count against it. */
  paymentId: string
  /** The bank account mapped for this method/currency, or null when none is. */
  bankAccountId: string | null
  /** Every INVOICE_PAYMENT sync row already on this order. */
  existing: ExistingInvoicePaymentSync[]
  /**
   * What the ledger holds against this invoice, or null when it could not be established (o3d-0m56).
   *
   * Only consulted when an unresolved earlier attempt exists, and null then means REFUSE: an
   * unanswered question about money that may already be in the ledger is not permission to send
   * more. Callers with no unresolved attempts may pass null freely.
   */
  ledgerSettlements: LedgerSettlementRecord[] | null
  /** What the ledger's copy of the invoice was built at (see ledgerSalesInvoiceTotalForeign). */
  ledgerTotal: number
}): InvoicePaymentRegistrationDecision {
  if (!input.syncEnabled) return { register: false, refusal: 'SYNC_DISABLED' }
  if (!input.accountingInvoiceId) return { register: false, refusal: 'DOCUMENT_NOT_POSTED' }
  if (input.orderCurrency !== input.paymentCurrency) return { register: false, refusal: 'CURRENCY_MISMATCH' }
  if (!input.bankAccountId) return { register: false, refusal: 'NO_BANK_ACCOUNT' }

  // ONE LIVE REGISTRATION PER ORDER, and that is the database's rule, not a policy invented here:
  // accounting_sync_logs_followup_live_unique is a UNIQUE index on (connector, type, referenceType,
  // referenceId) for live INVOICE_PAYMENT rows. Queueing a second one does not merely double-pay — it
  // violates the constraint, and the caller's catch would turn a receipt the operator believed recorded
  // into an error log nobody reads (Codex, PR #582 round 2).
  //
  // It also covers what this guard was written for: an imported order's receipt is registered by the
  // SALES_INVOICE follow-up WITHOUT ever creating a local Payment row, so IMS's own payment rows do not
  // bound what the ledger has been told. Refusing on the ledger's own live row does.
  //
  // FAILED and CANCELLED rows do not hold the LIVE SLOT — the index ignores them, so a second row can
  // be written beside one. That is a statement about the index, and it was read here as a statement
  // about the ledger, which it is not: an attempt whose call committed but whose response was lost is
  // FAILED, and deleting a receipt CANCELS a row that may already have settled. They are handled below
  // on their own terms (o3d-0m56) rather than dropped here.
  //
  // Making the index receipt-scoped, so part payments can each register, is o3d-cjt8: it needs a
  // migration and a look at existing rows, and until then a refusal an operator can read beats an insert
  // that throws.
  const live = input.existing.filter(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED'
    // Our OWN row, if this ever runs twice for one receipt: the idempotency key already makes the second
    // queue a no-op, so treating it as an obstacle would refuse the retry for its own success.
    && (r.paymentId == null || r.paymentId !== input.paymentId),
  )
  if (live.length > 0) {
    const known = live.filter((r) => typeof r.amount === 'number')
    return {
      register: false,
      refusal: 'LEDGER_HAS_LIVE_PAYMENT',
      // Absent when a row records no amount: unknown must not read as zero in the operator's message.
      alreadyRegistered: known.length === live.length
        ? known.reduce((sum, r) => sum + (r.amount as number), 0)
        : undefined,
      ledgerTotal: input.ledgerTotal,
    }
  }

  // THE OTHER WAY BACK TO THE LEDGER (o3d-0m56, Codex review). o3d-h2wx and the manual-retry guard both
  // protect the RETRY of a failed payment row. Neither is involved here: recording another receipt
  // beside a FAILED attempt queues a brand-new row under a NEW idempotency token, which posts a second
  // payment against the same invoice without touching either guard — and it is the likelier operator
  // action, because a failed payment looks like nothing happened.
  //
  // So an unresolved attempt has to be settled the same way the retry settles it: by asking the ledger
  // whether the attempt's own payment is there. Anything short of a positive "it is not" refuses. The
  // cost is a receipt that has to be registered by hand while an old failed row sits unresolved; the
  // alternative is an invoice paid twice with nothing in IMS to show for it.
  const unresolved = unresolvedInvoicePaymentAttempts(input.existing, input.paymentId)
  if (unresolved.length > 0) {
    if (input.ledgerSettlements === null) {
      return {
        register: false,
        refusal: 'UNRESOLVED_PAYMENT_ATTEMPT',
        ledgerTotal: input.ledgerTotal,
        detail: 'the accounting connector could not be asked what it already holds',
      }
    }
    for (const attempt of unresolved) {
      const verdict = classifyLedgerSettlement(
        { amount: attempt.amount ?? null, date: attempt.paymentDate ?? null },
        { ok: true, records: input.ledgerSettlements },
      )
      if (verdict.outcome === 'clear') continue
      return {
        register: false,
        refusal: 'UNRESOLVED_PAYMENT_ATTEMPT',
        ledgerTotal: input.ledgerTotal,
        detail: verdict.outcome === 'present'
          ? `the ledger already holds ${verdict.detail}, which matches an earlier ${attempt.status} attempt`
          : verdict.reason,
      }
    }
  }

  // Nothing is registered, so this receipt stands alone — and if it alone exceeds the invoice, the ledger
  // would reject it. The live case for this is a gross receipt against an imported tax-inclusive invoice,
  // which posts at NET (o3d-cyn): refusing names the numbers, where letting it through produces a Xero
  // rejection an operator has to decode.
  if (input.paymentAmount > input.ledgerTotal + 0.005) {
    return { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered: 0, ledgerTotal: input.ledgerTotal }
  }
  return { register: true, bankAccountId: input.bankAccountId }
}
