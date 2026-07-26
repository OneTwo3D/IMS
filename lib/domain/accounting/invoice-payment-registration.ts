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
  /** This receipt alone is larger than the invoice it settles, so the ledger would refuse it. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentRegistrationDecision =
  | { register: true; bankAccountId: string }
  | { register: false; refusal: InvoicePaymentRegistrationRefusal; alreadyRegistered?: number; ledgerTotal?: number }

/** One INVOICE_PAYMENT sync row, reduced to what the decision depends on. */
export type ExistingInvoicePaymentSync = {
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
  /** o3d-sref: retired with its claim taken, so the payment may already be registered. */
  remoteEffectUnverified?: boolean
  /** What was sent, in the document currency. Null when the payload did not record it. */
  amount?: number | null
  /** The local Payment row it was queued for; null on rows queued before that was recorded. */
  paymentId?: string | null
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
  // FAILED and CANCELLED rows hold nothing — the ledger rejected them or never saw them — and the index
  // ignores them too, so they free the slot again.
  //
  // Making the index receipt-scoped, so part payments can each register, is o3d-cjt8: it needs a
  // migration and a look at existing rows, and until then a refusal an operator can read beats an insert
  // that throws.
  // An UNVERIFIED row counts as LIVE (o3d-sref): the claim was taken, so it may already have
  // registered its payment. Excluding it would let a second registration queue for the same receipt
  // and double-pay the invoice — the exact outcome this obstacle check exists to prevent. An
  // unverifiable row is an obstacle, not an absence.
  const live = input.existing.filter(
    // NOTE the parentheses: `&&` binds tighter than `||`, so without them the own-row exclusion below
    // would attach only to the unverified disjunct and stop applying to the ordinary path — which is
    // exactly the bug the "does not count against itself" test caught.
    (r) => ((r.status !== 'FAILED' && r.status !== 'CANCELLED') || r.remoteEffectUnverified === true)
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

  // Nothing is registered, so this receipt stands alone — and if it alone exceeds the invoice, the ledger
  // would reject it. The live case for this is a gross receipt against an imported tax-inclusive invoice,
  // which posts at NET (o3d-cyn): refusing names the numbers, where letting it through produces a Xero
  // rejection an operator has to decode.
  if (input.paymentAmount > input.ledgerTotal + 0.005) {
    return { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered: 0, ledgerTotal: input.ledgerTotal }
  }
  return { register: true, bankAccountId: input.bankAccountId }
}
