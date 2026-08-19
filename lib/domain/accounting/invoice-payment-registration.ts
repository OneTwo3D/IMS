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
  /**
   * A live registration exists whose AMOUNT cannot be read, so the remaining capacity on the invoice
   * cannot be computed. Refusing is the only sound answer: unknown must not read as zero (o3d-cjt8).
   */
  | 'LEDGER_AMOUNT_UNKNOWN'
  /** This receipt does not fit in what is left of the invoice after what the ledger already holds. */
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
  /**
   * The LEDGER DOCUMENT this row settles (o3d-hbgo). A row that names a different invoice paid an
   * invoice this order no longer has — deleted and re-posted — so it says nothing about how much of
   * the CURRENT invoice is outstanding. Null on rows queued before the payload recorded it, which
   * has to read as "possibly this one": for money, unknown is not the same as irrelevant.
   */
  accountingInvoiceId?: string | null
}

/** Sub-penny slack, so an exact settlement is not refused by float noise. */
const CAPACITY_EPSILON = 0.005

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

  // CAPACITY, NOT OCCUPANCY (o3d-cjt8). This used to refuse whenever ANY live INVOICE_PAYMENT row
  // existed, because accounting_sync_logs_followup_live_unique permitted exactly one live row per ORDER
  // — so a second receipt did not merely risk double-paying, it violated the constraint. That key named
  // the wrong thing: a Xero Payment is per RECEIPT against a DOCUMENT, not per order, and an order can
  // legitimately receive a deposit and a balance. The index is now scoped to
  // (…, accountingInvoiceId, paymentId), so the database no longer stands in the way — and it no longer
  // stands in the way of an OVERPAYMENT either, because "the parts must not exceed the whole" is
  // arithmetic and no unique index can express it. That arithmetic is done here.
  //
  // FAILED and CANCELLED rows hold nothing — the ledger rejected them or never saw them — so they free
  // the capacity again, exactly as the index's live-status predicate does.
  const live = input.existing.filter(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED'
    // Our OWN row, if this ever runs twice for one receipt: the idempotency key already makes the second
    // queue a no-op, so treating it as an obstacle would refuse the retry for its own success.
    && (r.paymentId == null || r.paymentId !== input.paymentId)
    // o3d-hbgo, read side: a row that settled a DIFFERENT ledger document paid an invoice this order no
    // longer has (deleted and re-posted). It consumes none of the current invoice's capacity, and
    // counting it would strand every payment on the replacement — silently, and for ever. A row that
    // names NO document stays counted: unknown has to read as "possibly this one".
    && (r.accountingInvoiceId == null || r.accountingInvoiceId === input.accountingInvoiceId),
  )

  // An unreadable amount cannot be arithmetic. Treating it as zero would let this receipt through on the
  // assumption that the ledger holds nothing, which is precisely what is not known.
  if (live.some((r) => typeof r.amount !== 'number')) {
    return { register: false, refusal: 'LEDGER_AMOUNT_UNKNOWN', ledgerTotal: input.ledgerTotal }
  }

  const alreadyRegistered = live.reduce((sum, r) => sum + (r.amount as number), 0)
  // What is LEFT of the invoice. With no live rows this is the whole invoice, which is exactly the
  // single-receipt rule this replaced — so the case that rule was written for still refuses, and now
  // the part-payment case does too. Refusing here names the numbers, where letting it through produces
  // a Xero rejection an operator has to decode.
  //
  // The case originally in view — a gross receipt against an imported tax-inclusive invoice, which
  // posted at NET — is gone since o3d-cyn: both construction paths now post at the order's gross. What
  // is left is every OTHER way a receipt can exceed its document (a credited or part-refunded invoice, a
  // mistyped amount), the invoices imported and posted before that fix, and now the deposit-plus-balance
  // case the receipt-scoped index deliberately admits.
  if (input.paymentAmount > input.ledgerTotal - alreadyRegistered + CAPACITY_EPSILON) {
    return { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered, ledgerTotal: input.ledgerTotal }
  }
  return { register: true, bankAccountId: input.bankAccountId }
}

/**
 * WHICH LOCAL RECEIPTS ARE STILL WAITING TO BE REGISTERED (o3d-ekn8).
 *
 * `decideInvoicePaymentRegistration` refuses a receipt recorded BEFORE its invoice posts with
 * DOCUMENT_NOT_POSTED — correctly, since a payment cannot attach to a document the ledger has never
 * seen. The defect was that nothing re-visited it once the SALES_INVOICE finally landed: the receipt
 * stayed recorded, the ledger stayed unsettled, and only the red settlement verdict said so.
 *
 * That is an ORDERING problem, not a uniqueness one — no key was wrong, a moment was missed. So the fix
 * is not a key change but a re-drive at the moment the refusal stops applying (the CREATE posting and
 * writing back accountingInvoiceId), running the SAME guarded decision rather than a second, laxer copy
 * of it.
 *
 * This picks the receipts to re-drive, and is deliberately timid, because the caller's re-drive path
 * does NOT go through planFollowUpEnqueue and so cannot pin a remote idempotency token:
 *
 *  - A receipt with ANY sync row of its own is left alone. A live row is already on its way; a FAILED
 *    row may have committed remotely before failing (o3d-ju8t), and re-driving it would post under a
 *    token the ledger has never seen — the o3d-h2wx double-payment. Those belong to the retry path,
 *    which is built to pin the token, and to the operator, who can see them.
 *  - An UNATTRIBUTED live row (paymentId null) suppresses EVERY receipt on the order. That is the
 *    imported-order shape: the SALES_INVOICE follow-up registers the receipt with no local Payment row
 *    at all, so it cannot be matched to one, and for money "which receipt is this?" unanswered has to
 *    read as "possibly that one".
 *
 * Refunds are the caller's business to exclude: they settle a credit note, not this invoice.
 */
export function selectReceiptsAwaitingRegistration<T extends { id: string }>(input: {
  receipts: T[]
  existing: ExistingInvoicePaymentSync[]
}): T[] {
  const unattributedLive = input.existing.some(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED' && r.paymentId == null,
  )
  if (unattributedLive) return []
  const spokenFor = new Set(
    input.existing.map((r) => r.paymentId).filter((id): id is string => typeof id === 'string'),
  )
  return input.receipts.filter((receipt) => !spokenFor.has(receipt.id))
}
