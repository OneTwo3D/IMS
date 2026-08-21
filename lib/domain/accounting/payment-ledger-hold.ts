/**
 * o3d-1vuv — WHEN THE LEDGER ALREADY HOLDS A PAYMENT, DELETING THE LOCAL RECEIPT IS NOT A DELETE.
 *
 * WHAT IT DID BEFORE. deletePayment succeeded whatever state the INVOICE_PAYMENT registration was
 * in. It removed the Payment row, cleared paidAt, and — when the registration was PROCESSING or
 * SYNCED — wrote a WARNING (`payment_external_reversal_required`) asking somebody to go and reverse
 * the payment in the accounting connector by hand. The ledger kept the payment attached to the
 * invoice; IMS kept nothing but a log line nobody is subscribed to.
 *
 * PR #582 made that state VISIBLE rather than silent: settlementStatus returns LEDGER_UNMATCHED
 * ("PAID IN LEDGER ONLY") for exactly it. Visible is not resolved. A wrong figure in a real ledger
 * is worse than a refusal, so the delete now REFUSES while the ledger holds the payment — and the
 * refusal comes with a remedy the operator can actually perform, which is the other half of that
 * rule and the half that was missing.
 *
 * THE REMEDY IS VERIFIED, NOT ASSERTED. The issue's option 2 was "IMS reverses it for them"; its
 * option 1 was "block the delete". This is neither on its own: the operator reverses the payment in
 * the accounting system — where the authority over that ledger lives, and where they may need to
 * pick a date, a batch or an unallocation — and IMS then ASKS XERO whether the payment is really
 * gone before it lets the local receipt go. So no local state is destroyed on the strength of an
 * assertion IMS could have checked and did not. See reverseLedgerPayment in app/actions/sales.ts.
 *
 * WHY NOT SIMPLY CANCEL THE SYNC ROW ON THE OPERATOR'S WORD. Because settlementStatus reads
 * PENDING/PROCESSING/SYNCED as "held by the ledger" and CANCELLED as holding nothing. Cancelling the
 * row on an unverified claim would turn LEDGER_UNMATCHED into a plain, undiscrepant UNPAID — it
 * would DELETE THE ALARM rather than the cause, and a mistaken claim would never be contradicted by
 * anything. That is the one outcome an operator action must never be able to produce.
 *
 * Pure functions only, so the classification and the refusal vocabulary are unit-testable without a
 * database or a Xero tenant.
 */

/** The sync type that registers a locally-recorded sales receipt against the ledger invoice. */
export const PAYMENT_REGISTRATION_TYPE = 'INVOICE_PAYMENT'

/**
 * The statuses that mean "the ledger holds a payment for this document".
 *
 * settlementStatus (lib/domain/accounting/settlement-status.ts) used to carry its own copy of this
 * list and the two drifted, which is how an undecided attempt came to be displayed as a plainly
 * unpaid order. It now reads `registrationLedgerStanding` below, so there is one list and one
 * classifier: these are the rows whose disappearance would silence a real discrepancy, and the
 * module that refuses the delete and the module that raises the alarm agree on which they are.
 */
export const LEDGER_HELD_REGISTRATION_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

/**
 * The statuses a queued registration can still be retired from without asking anyone.
 *
 * PENDING ONLY, and only with no document id: nothing has been sent, so cancelling it takes nothing
 * away from the ledger. deletePayment has always done this and continues to; the change is that it
 * now happens INSIDE the same transaction as the delete and is compare-and-swapped, so a worker that
 * claims the row in the window aborts the delete instead of stranding a posted payment.
 */
export const RETIRABLE_REGISTRATION_STATUSES = ['PENDING'] as const

/**
 * The statuses that mean IMS ATTEMPTED to register the payment and does not know what the ledger did
 * with it (o3d-clxw's `REGISTRATION_UNDECIDED`, reached from the other side).
 *
 * FAILED, with no document id. The sync processor makes its remote call BEFORE it writes down the
 * result, so everything between the request leaving and the row being updated — a timeout, a dropped
 * response, a killed worker, a rejection Xero recorded anyway — is written down as a FAILURE IN
 * FRONT OF A PAYMENT THAT EXISTS. The row says the attempt did not succeed; it does not say the
 * ledger was never told. Reading it as "nothing posted" is exactly the reading o3d-ju8t, o3d-sref and
 * o3d-clxw each removed from a different call site, and it was still here.
 *
 * A row in this state is DECIDABLE ONLY LATER, never from here: retried, it either posts and carries
 * a document id (verifiable) or lands in a state that is. So the delete withholds, and says so.
 *
 * CANCELLED is deliberately NOT in this set. It is the one status IMS only ever writes where "nothing
 * was sent" is an assertion something already checked — a PENDING row retired pre-call, or a
 * registration a verified reversal retired — so it holds nothing and blocks nothing.
 */
export const UNDECIDED_REGISTRATION_STATUSES = ['FAILED'] as const

/**
 * Every status a registration must be READ in for the split below to see it.
 *
 * Lives here so the database query and the classification cannot drift: a status the query omits is
 * a status the splitter can never classify, and the failure mode of that drift is silent and
 * one-directional — the row is simply absent, which reads as "there is no registration", which is
 * the permissive answer. That is precisely how FAILED rows with no document id went unexamined.
 */
export const READABLE_REGISTRATION_STATUSES = [
  ...LEDGER_HELD_REGISTRATION_STATUSES,
  ...UNDECIDED_REGISTRATION_STATUSES,
] as const

/** Xero's own value for a payment that has been removed. There is no VOIDED payment in Xero. */
export const XERO_DELETED_PAYMENT_STATUS = 'DELETED'

export type PaymentRegistrationRow = {
  id: string
  connector: string
  status: string
  externalTransactionId: string | null
}

export type PaymentRegistrationSplit = {
  /** PENDING, nothing sent, nothing to take back — deletePayment retires these itself. */
  retirable: PaymentRegistrationRow[]
  /**
   * Rows the ledger holds, or that carry evidence of a document that exists. A FAILED row with a
   * document id counts: the remote call happens BEFORE the result is written down (o3d-ju8t), so a
   * failure can sit in front of a real payment in the ledger, and post evidence outranks status.
   */
  ledgerHold: PaymentRegistrationRow[]
  /**
   * Rows that were ATTEMPTED and whose effect on the ledger is unknown — FAILED with no document id.
   * Not `ledgerHold`, because nothing establishes that the ledger holds anything, and emphatically
   * not nothing, because nothing establishes that it does not. See
   * UNDECIDED_REGISTRATION_STATUSES; they are refused separately so the operator is told what is
   * actually unknown rather than shown a document id that does not exist.
   */
  undecided: PaymentRegistrationRow[]
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function hasPostEvidence(row: { externalTransactionId?: string | null }): boolean {
  return trimmed(row.externalTransactionId).length > 0
}

/**
 * What ONE registration row says about the ledger, in the only three answers there are.
 *
 * THE SINGLE CLASSIFIER, and it is single on purpose. Two readers ask this question — the delete
 * (splitPaymentRegistrations, below) and the settlement verdict (settlement-status.ts) — and they
 * used to answer it separately: the delete gained a third bucket while the verdict kept the old
 * two, so the very row the delete refuses to act on ("an attempt nobody can speak for") was
 * displayed by the verdict as a plain, undiscrepant UNPAID. One module refused to touch it while
 * the other said there was nothing to see. Both now read this function, so they cannot drift again.
 */
export type RegistrationLedgerStanding =
  /** The ledger holds a payment for this document, or names one that may already exist. */
  | 'HELD'
  /** An attempt was made and NOBODY CAN SAY what the ledger did with it. */
  | 'UNDECIDED'
  /** Nothing was sent, or what was sent has been established — by evidence — to be gone. */
  | 'NOTHING'

export function registrationLedgerStanding(row: { status: string; externalTransactionId?: string | null }): RegistrationLedgerStanding {
  // CANCELLED IS ASKED FIRST, AHEAD OF POST EVIDENCE, and this is the one place that precedence is
  // inverted. Everywhere else a document id outranks a status, because a status is what IMS wrote
  // down and a document id is what the ledger gave back. CANCELLED is the exception because it is
  // never written from an outcome: it is written where "nothing stands there" has ALREADY been
  // established — a PENDING row retired before any call, or a registration retired after Xero was
  // asked and answered DELETED. A cancelled row that still names a payment is the complete account
  // of a payment that existed and was undone (see buildVerifiedReversalData), and reading that id as
  // a live hold would alarm for ever over the reversal that fixed it.
  if (row.status === 'CANCELLED') return 'NOTHING'
  // POST EVIDENCE OUTRANKS STATUS. The processor calls the ledger BEFORE it writes the result down,
  // so a FAILED row naming a document is a failure recorded in front of a payment that exists.
  if (hasPostEvidence(row)) return 'HELD'
  if ((LEDGER_HELD_REGISTRATION_STATUSES as readonly string[]).includes(row.status)) return 'HELD'
  if ((UNDECIDED_REGISTRATION_STATUSES as readonly string[]).includes(row.status)) return 'UNDECIDED'
  return 'NOTHING'
}

/**
 * Split the registrations that NAME this payment into the ones that can simply be retired, the ones
 * the ledger holds, and the ones nobody can currently speak for.
 *
 * The caller is responsible for having filtered to rows whose payload names this payment id — a row
 * that names no payment is nobody's to retract, and matching by amount instead is what used to
 * retract an imported order's own registration (Codex, PR #582 round 2).
 *
 * THREE BUCKETS, NOT TWO, and the third is the correction. The two-bucket version had to answer
 * "does the ledger hold a payment?" with a yes or a no, and had no way to say "an attempt was made
 * and nobody knows" — so it said NO, and the delete went through. See
 * UNDECIDED_REGISTRATION_STATUSES.
 */
export function splitPaymentRegistrations(rows: readonly PaymentRegistrationRow[]): PaymentRegistrationSplit {
  const retirable: PaymentRegistrationRow[] = []
  const ledgerHold: PaymentRegistrationRow[] = []
  const undecided: PaymentRegistrationRow[] = []
  for (const row of rows) {
    const standing = registrationLedgerStanding(row)
    if (standing === 'HELD') {
      // The ONE held row that can simply be retired: PENDING with nothing sent. It is `HELD` for the
      // verdict — a queued payment is on its way to the ledger and IMS must not look settled-free —
      // but for the DELETE it takes nothing away, because nothing has left yet. The compare-and-swap
      // in deletePayment is what makes that safe: a worker claiming it in the window aborts.
      if (row.status === 'PENDING' && !hasPostEvidence(row)) retirable.push(row)
      else ledgerHold.push(row)
    } else if (standing === 'UNDECIDED') {
      undecided.push(row)
    }
    // NOTHING falls through to no bucket at all: in practice a CANCELLED row, which is only ever
    // written where "nothing stands there" has already been established.
  }
  return { retirable, ledgerHold, undecided }
}

// ---------------------------------------------------------------------------
// The refusal deletePayment now returns
// ---------------------------------------------------------------------------

export type PaymentDeleteRefusalCode =
  /** The ledger holds a payment for this receipt; reverse it there first. */
  | 'ledger_holds_payment'
  /** A worker claimed the queued registration while the delete was running. */
  | 'registration_in_flight'
  /** A registration was ATTEMPTED and failed without naming a document. Nobody can say what posted. */
  | 'registration_attempt_undecided'

export type PaymentDeleteRefusal = { code: PaymentDeleteRefusalCode; message: string }

export function describeLedgerHoldRefusal(
  hold: readonly PaymentRegistrationRow[],
  orderReference: string,
): PaymentDeleteRefusal {
  const posted = hold.filter(hasPostEvidence)
  const ids = posted.map((row) => trimmed(row.externalTransactionId)).join(', ')
  return {
    code: 'ledger_holds_payment',
    message:
      `This receipt has already been registered against the invoice for ${orderReference} in the `
      + 'accounting system, so deleting it here would leave the ledger showing the invoice settled while '
      + `IMS shows it unpaid${ids ? ` (payment ${ids})` : ''}. Nothing was deleted.\n\n`
      + 'Reverse the payment in the accounting system first, then use "Reverse in ledger and delete" on '
      + 'this receipt — IMS will check with the accounting system that the payment really is gone before '
      + 'it removes anything here.'
      + (posted.length === hold.length
        ? ''
        : '\n\nOne of these registrations is still in flight and has no document id yet, so there is '
          + 'nothing to check for it. Wait for it to finish before reversing.'),
  }
}

/**
 * The refusal for an ATTEMPTED registration whose outcome nobody knows.
 *
 * WHAT IT MUST NOT SAY. Not "a payment exists" — none is known to. Not "the sync failed, try again"
 * — that is the reading that deleted the receipt. It has to state the actual epistemic position,
 * because the operator is the only party who can resolve it and they can only do that if they are
 * told what is missing: an attempt was made, the result was not recorded, and the row names no
 * document to ask about.
 *
 * AND IT MUST NOT BE A DEAD END — IN EITHER BRANCH. The operator looks at the invoice, and what
 * they find splits the world in two. Round 1 gave a real remedy to one half and, on inspection,
 * sent the other half back to this same refusal (Codex round 2, finding 3): "if a payment IS there,
 * reverse it and delete this receipt" walked the operator into the identical refusal, because
 * reversing a payment in Xero changes nothing about a FAILED row that names no document. A refusal
 * whose remedy returns you to the refusal is a wall with a door painted on it.
 *
 * SO BOTH BRANCHES NOW END SOMEWHERE:
 *
 *   • NO PAYMENT ON THE INVOICE → retry the registration under Sync → Xero. It posts, it carries a
 *     document id back, and the receipt falls under the ordinary ledger-hold refusal, which has a
 *     verified remedy behind it.
 *   • A PAYMENT IS THERE → the operator can supply the one fact IMS is missing: WHICH payment. They
 *     reverse it in the accounting system and hand IMS its reference, and IMS then asks Xero about
 *     that exact payment — is it on THIS invoice, is it for THIS amount, is it really gone — before
 *     anything local is removed. The assertion is only ever "ask about this one"; the answer still
 *     comes from the ledger. That is the same shape as the refund-park recovery in this branch, and
 *     the opposite of taking the operator's word for the outcome.
 *
 * WHY IMS STILL DOES NOT LOOK UNPROMPTED. The row names no payment, so the only question IMS could
 * ask by itself is about the INVOICE — and an invoice showing no payment is exactly what a removed
 * payment and a never-posted one BOTH look like (o3d-clxw). Asking that would produce a confident
 * answer with no evidence under it. Asking about a payment reference a human read off the invoice is
 * a different question with a real answer, which is why the reference has to come from them.
 */
export function describeAttemptUndecidedRefusal(
  undecided: readonly PaymentRegistrationRow[],
  orderReference: string,
): PaymentDeleteRefusal {
  const entries = undecided.map((row) => row.id).join(', ')
  return {
    code: 'registration_attempt_undecided',
    message:
      `IMS tried to register this receipt against the invoice for ${orderReference} in the accounting `
      + 'system and the attempt was recorded as FAILED, without a payment reference. A failure is not '
      + 'proof that nothing was posted: the accounting system is called BEFORE the result is written '
      + 'down, so a timeout or a lost response is recorded as a failure even when the payment went '
      + 'through. Nothing was deleted.\n\n'
      + `Open the invoice for ${orderReference} in the accounting system and look at the payments on it.\n`
      + '• If a payment IS there, the attempt landed. Reverse it there, then copy its payment '
      + 'reference and use "Check that payment and delete" below — IMS will ask the accounting system '
      + 'about that exact payment, check it belongs to this invoice and matches this receipt, and '
      + 'confirm it really is gone before removing anything here.\n'
      + '• If there is NO payment, retry the registration under Sync → Xero. Once it posts, IMS knows '
      + 'the payment reference and can check the reversal for you.\n\n'
      + `IMS cannot settle this on its own: the failed entry (${entries}) names no payment to look up, `
      + 'and an invoice showing nothing looks the same whether the payment was removed or never '
      + 'arrived — which is why the reference has to come from you, and why IMS still checks it.',
  }
}

export const REGISTRATION_IN_FLIGHT_REFUSAL: PaymentDeleteRefusal = {
  code: 'registration_in_flight',
  message:
    'A worker claimed this receipt\'s queued payment registration while the deletion was being made, so '
    + 'nothing was deleted. It may now be posting to the accounting system. Reload the order and look '
    + 'again once the sync has finished — if it did post, reverse it in the accounting system first.',
}

// ---------------------------------------------------------------------------
// The verified reversal
// ---------------------------------------------------------------------------

export type LedgerReversalRefusalCode =
  /** Nothing in the ledger holds this receipt; the ordinary delete applies. */
  | 'no_ledger_hold'
  /** The receipt is gone already. */
  | 'payment_missing'
  /** A registration is in flight with no document id, so there is nothing to check yet. */
  | 'unverifiable_in_flight'
  /** A registration was attempted and failed without naming a document, and no reference was given. */
  | 'attempt_undecided'
  /** More than one attempt is undecided, so one reference cannot account for them. */
  | 'attempt_undecided_ambiguous'
  /** The operator named a payment, but IMS has no ledger invoice to check it belongs to. */
  | 'asserted_payment_unattributable'
  /** The named payment is not the one on this invoice. */
  | 'asserted_payment_not_on_invoice'
  /** The named payment is on this invoice but not for this receipt's amount. */
  | 'asserted_payment_amount_mismatch'
  /** The connector is not one this check knows how to ask. */
  | 'connector_not_supported'
  /** The accounting system could not be asked. Nothing changed. */
  | 'ledger_lookup_failed'
  /** The accounting system says the payment is still there. */
  | 'ledger_still_holds_payment'
  /** The rows moved between the check and the write. */
  | 'hold_moved'

export type LedgerReversalRefusal = { code: LedgerReversalRefusalCode; message: string }

/**
 * The connectors this verification understands.
 *
 * QuickBooks is out of scope by owner instruction, and refusing it is not a regression: a QuickBooks
 * receipt cannot be deleted past its registration today either, and letting it through UNVERIFIED
 * would be strictly worse than refusing — it would destroy the local receipt on nobody's evidence.
 */
export const VERIFIABLE_REVERSAL_CONNECTORS = ['xero'] as const

export function refuseUnverifiableConnector(connector: string): LedgerReversalRefusal {
  return {
    code: 'connector_not_supported',
    message:
      `IMS can only confirm a reversal with Xero, and this payment was registered through ${connector}. `
      + 'Nothing was changed. Reverse the payment in that system and resolve the sync row there rather '
      + 'than deleting the receipt here on an unchecked claim.',
  }
}

export const UNVERIFIABLE_IN_FLIGHT_REFUSAL: LedgerReversalRefusal = {
  code: 'unverifiable_in_flight',
  message:
    'This receipt\'s payment registration is still in flight and carries no document id, so there is '
    + 'nothing for IMS to look up in the accounting system and no way to tell whether a payment exists '
    + 'there. Nothing was changed. Wait for the sync to finish, then reverse it.',
}

/**
 * The reversal's version of the same refusal, and it exists so the reversal cannot become the way
 * AROUND the delete's.
 *
 * "I have reversed it — check and delete" is a promise that IMS checked. Against a FAILED entry with
 * no document id there is nothing to check, so honouring the click would delete the receipt on the
 * operator's unverified word — the one outcome o3d-1vuv was built to make impossible, reached
 * through the remedy instead of the fault.
 */
export const UNDECIDED_ATTEMPT_REVERSAL_REFUSAL: LedgerReversalRefusal = {
  code: 'attempt_undecided',
  message:
    'This receipt has a payment registration that was attempted and recorded as FAILED, and it names no '
    + 'payment reference — so there is nothing for IMS to look up and no way to confirm anything was '
    + 'reversed. Nothing was changed. IMS will not delete a receipt on an unchecked claim.\n\n'
    + 'Open the invoice in the accounting system. If a payment IS on it, reverse it there and enter its '
    + 'payment reference here — IMS will ask about that exact payment and check it before deleting '
    + 'anything. If there is NO payment, retry the registration under Sync → Xero so it records a '
    + 'payment reference IMS can then verify against.',
}

export const NO_LEDGER_HOLD_REFUSAL: LedgerReversalRefusal = {
  code: 'no_ledger_hold',
  message:
    'The accounting system does not hold a payment for this receipt, so there is nothing to reverse. '
    + 'Delete the receipt in the ordinary way.',
}

export function refuseLedgerLookupFailure(externalId: string, error: string | undefined): LedgerReversalRefusal {
  return {
    code: 'ledger_lookup_failed',
    message:
      `The accounting system could not be asked about payment ${externalId}, so nothing was changed and `
      + `the receipt is exactly as it was${error ? ` (${error})` : ''}. IMS will not delete a receipt the `
      + 'ledger may still hold on the strength of an unchecked claim — try again once the connection is '
      + 'working.',
  }
}

export function refuseLedgerStillHolds(externalId: string, status: string): LedgerReversalRefusal {
  return {
    code: 'ledger_still_holds_payment',
    message:
      `The accounting system still has payment ${externalId} (status ${status}), so it is NOT reversed `
      + 'and nothing was changed. Delete or reverse that payment there first — until it is gone, deleting '
      + 'the receipt here would leave the invoice settled in the ledger and unpaid in IMS.',
  }
}

// ---------------------------------------------------------------------------
// THE UNDECIDED ATTEMPT'S OWN REMEDY: the operator names the payment, IMS asks about it
//
// WHAT IS ASSERTED AND WHAT IS VERIFIED, because the difference is the whole design. The operator
// asserts ONE thing — "the payment my attempt created is this one" — and nothing follows from
// saying it. IMS asks Xero about that payment and then requires THREE facts from the answer before
// a receipt is removed: it is attached to THIS invoice, it is for THIS receipt's amount, and it is
// DELETED. A reference that fails any of them is refused by name, so a mistyped or mis-copied id
// cannot become a delete. Compare `recoverRefundSyncPark`: the operator says which order to ask
// about, WooCommerce says who owns the refund.
//
// WHY THE INVOICE CHECK IS NOT OPTIONAL. Without it "any deleted payment in the tenant" would do,
// and Xero tenants are full of deleted payments. With it, the reference has to name a payment that
// really did sit on the invoice this receipt was recorded against — which is the fact the FAILED row
// failed to write down, obtained from the only party that has it.
// ---------------------------------------------------------------------------

/** One reference can only speak for one attempt. */
export const UNDECIDED_ATTEMPTS_AMBIGUOUS_REFUSAL: LedgerReversalRefusal = {
  code: 'attempt_undecided_ambiguous',
  message:
    'This receipt has MORE THAN ONE payment registration that was attempted and failed without naming a '
    + 'payment reference, so a single reference cannot account for them and IMS cannot tell which '
    + 'attempt it belongs to. Nothing was changed. Retry the registrations under Sync → Xero so each '
    + 'one records what it did, then come back to this receipt.',
}

export function refuseAssertedPaymentUnattributable(orderReference: string): LedgerReversalRefusal {
  return {
    code: 'asserted_payment_unattributable',
    message:
      `IMS has no accounting invoice recorded for ${orderReference}, so it cannot check that the payment `
      + 'you named belongs to this order rather than to some other document in the accounting system. '
      + 'Nothing was changed. Post the invoice to the accounting system first, or resolve the failed '
      + 'registration under Sync → Xero.',
  }
}

export function refuseAssertedPaymentNotOnInvoice(
  externalId: string,
  orderReference: string,
  foundInvoiceId: string | null,
): LedgerReversalRefusal {
  return {
    code: 'asserted_payment_not_on_invoice',
    message:
      `The accounting system says payment ${externalId} is not on the invoice for ${orderReference}`
      + `${foundInvoiceId ? ` — it belongs to invoice ${foundInvoiceId}` : ' and names no invoice at all'}`
      + '. Nothing was changed, and nothing was deleted. Check the reference against the payment shown on '
      + `the invoice for ${orderReference}: a payment on another document says nothing about this one.`,
  }
}

export function refuseAssertedPaymentAmountMismatch(
  externalId: string,
  ledgerAmount: number,
  receiptAmount: number,
): LedgerReversalRefusal {
  return {
    code: 'asserted_payment_amount_mismatch',
    message:
      `Payment ${externalId} is for ${ledgerAmount} and this receipt is for ${receiptAmount}, so it is not `
      + 'the payment this receipt was registered as. Nothing was changed. That invoice may carry more than '
      + 'one payment — check which one the failed registration created before reversing anything else.',
  }
}

/**
 * What an ASSERTED-and-verified reversal writes onto the undecided row.
 *
 * The document id is ADDED here, not preserved: this is the one path that can decide a row the
 * processor left undecided, and the whole value of deciding it is that the row stops saying "an
 * attempt, outcome unknown" and starts saying "attempt PAY-9, reversed, confirmed gone". The note
 * records that the reference came from an operator and that Xero was asked, so the row never reads
 * as though IMS discovered the id by itself.
 */
export function buildAssertedReversalData(externalId: string, note: string) {
  return { status: 'CANCELLED' as const, externalTransactionId: trimmed(externalId), errorMessage: note }
}

export function assertedReversalNote(externalId: string, invoiceId: string, now: Date): string {
  return `Retired: an operator identified this failed attempt as payment ${trimmed(externalId)}, and IMS `
    + `confirmed with the accounting system that it was on invoice ${invoiceId} and was DELETED there at `
    + `${now.toISOString()} before deleting the local receipt.`
}

/**
 * The reference as it can be sent to the ledger, or null.
 *
 * Empty and whitespace-only are the same thing as not supplying one — an empty box must land on the
 * "there is nothing to check" refusal rather than on a lookup for the empty string, which Xero would
 * answer with the WHOLE payment collection.
 */
export function normalizeAssertedPaymentReference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim()
  if (!cleaned || cleaned.length > 100) return null
  return cleaned
}

/** Xero identifiers are GUIDs; case is not part of the identity. */
export function sameLedgerIdentifier(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = trimmed(a).toLowerCase()
  const right = trimmed(b).toLowerCase()
  return left.length > 0 && left === right
}

export const HOLD_MOVED_REFUSAL: LedgerReversalRefusal = {
  code: 'hold_moved',
  message:
    'This receipt\'s payment registrations changed while the reversal was being recorded — one was '
    + 'claimed, retried or resolved — so nothing was changed. Reload the order and look again.',
}

/**
 * Whether the accounting system's own answer means the payment is gone.
 *
 * Xero has no VOIDED payment: a removed payment reads DELETED. Anything else — AUTHORISED most of
 * all — means it is still attached to the invoice, and is refused BY NAME so the operator is told
 * what the ledger actually said rather than that "it did not work".
 */
export function isReversedInLedger(status: string | null | undefined): boolean {
  return trimmed(status).toUpperCase() === XERO_DELETED_PAYMENT_STATUS
}

/**
 * What a verified-reversed registration row becomes.
 *
 * CANCELLED, because the ledger genuinely holds nothing now — settlementStatus may correctly stop
 * reporting LEDGER_UNMATCHED, and it is only sound to let it because Xero was ASKED.
 *
 * externalTransactionId is DELIBERATELY ABSENT from the patch — not cleared. It is the only pointer
 * IMS has at what was posted, and a row reading "CANCELLED, document PAY-123, reversed by X on Y" is
 * a complete account of a payment that existed and was undone. Clearing it would erase the evidence
 * that the reversal was ever necessary.
 */
export function buildVerifiedReversalData(note: string) {
  return { status: 'CANCELLED' as const, errorMessage: note }
}

export function ledgerReversalNote(externalIds: readonly string[], now: Date): string {
  const ids = externalIds.filter((id) => trimmed(id)).join(', ')
  return `Retired: the operator reversed this payment in the accounting system and IMS confirmed it `
    + `${ids ? `(${ids}) ` : ''}was DELETED there at ${now.toISOString()} before deleting the local receipt.`
}
