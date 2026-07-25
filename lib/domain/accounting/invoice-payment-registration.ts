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
  /** An existing payment sync records no amount, so "how much does the ledger already hold" is unknown. */
  | 'UNKNOWN_REGISTERED_AMOUNT'
  /** Registering this too would send the ledger more than the invoice it settles. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentRegistrationDecision =
  | { register: true; bankAccountId: string }
  | { register: false; refusal: InvoicePaymentRegistrationRefusal; alreadyRegistered?: number; ledgerTotal?: number }

/** One INVOICE_PAYMENT sync row, reduced to what the decision depends on. */
export type ExistingInvoicePaymentSync = {
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
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

  // WHAT THE LEDGER ALREADY HOLDS. An imported order's receipt was registered by the SALES_INVOICE
  // follow-up without ever creating a local Payment row, so IMS's own payment rows do NOT bound what the
  // ledger has been told — only the ledger's own sync rows do. Without this, an operator recording "the"
  // payment on an imported order would register it a SECOND time.
  //
  // FAILED and CANCELLED rows hold nothing: the ledger rejected or never saw them, so the invoice is
  // still outstanding by their amount and that capacity is free again.
  const live = input.existing.filter(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED'
    // Our OWN row, if this ever runs twice for one receipt: the idempotency key already makes the second
    // queue a no-op, so counting it as capacity used would refuse the retry with a false over-pay.
    && (r.paymentId == null || r.paymentId !== input.paymentId),
  )

  // FAIL CLOSED on an unreadable amount: "how much has the ledger been told" IS the guard, and a row we
  // cannot read makes the answer unknown, not zero.
  if (live.some((r) => typeof r.amount !== 'number')) {
    return { register: false, refusal: 'UNKNOWN_REGISTERED_AMOUNT' }
  }
  const alreadyRegistered = live.reduce((sum, r) => sum + (r.amount as number), 0)
  if (alreadyRegistered + input.paymentAmount > input.ledgerTotal + 0.005) {
    return { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered, ledgerTotal: input.ledgerTotal }
  }
  return { register: true, bankAccountId: input.bankAccountId }
}
