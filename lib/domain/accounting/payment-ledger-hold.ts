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
 * The statuses settlementStatus reads as "the ledger holds a payment for this document"
 * (lib/domain/accounting/settlement-status.ts, the `heldByLedger` test). Kept in step with it
 * DELIBERATELY: the whole point of the refusal is that these are the rows whose disappearance would
 * silence a real discrepancy.
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

export function hasPostEvidence(row: PaymentRegistrationRow): boolean {
  return trimmed(row.externalTransactionId).length > 0
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
    const held = (LEDGER_HELD_REGISTRATION_STATUSES as readonly string[]).includes(row.status)
    if (hasPostEvidence(row)) {
      ledgerHold.push(row)
    } else if (row.status === 'PENDING') {
      retirable.push(row)
    } else if (held) {
      ledgerHold.push(row)
    } else if ((UNDECIDED_REGISTRATION_STATUSES as readonly string[]).includes(row.status)) {
      undecided.push(row)
    }
    // Anything else — in practice CANCELLED with no document id — genuinely holds nothing: that
    // status is only ever written where "nothing was sent" has already been established, so
    // settlementStatus correctly reads it as unpaid on both sides.
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
 * AND IT MUST NOT BE A DEAD END. The row is undecidable from IMS, but it is not undecidable: a
 * retry from Sync → Xero re-posts it, and a registration that posts carries a document id back —
 * at which point this receipt falls under the ordinary ledger-hold refusal, which HAS a verified
 * remedy. So the instruction is "look, then retry", in that order, because the looking is what
 * decides whether the retry duplicates a payment.
 *
 * WHY IMS DOES NOT LOOK ITSELF. It cannot. The row names no payment, so the only question the
 * ledger could be asked is about the INVOICE — and an invoice showing no payment is exactly what a
 * removed payment and a never-posted one BOTH look like (o3d-clxw). Asking would produce a
 * confident answer with no evidence under it, which is worse than refusing.
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
      + '• If a payment IS there, the attempt landed. Reverse it there, then delete this receipt.\n'
      + '• If there is NO payment, retry the registration under Sync → Xero. Once it posts, IMS knows '
      + 'the payment reference and can check the reversal for you.\n\n'
      + `IMS cannot settle this itself: the failed entry (${entries}) names no payment to look up, and an `
      + 'invoice showing nothing looks the same whether the payment was removed or never arrived.',
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
  /** A registration was attempted and failed without naming a document, so there is nothing to check. */
  | 'attempt_undecided'
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
    + 'reversed. Nothing was changed. IMS will not delete a receipt on an unchecked claim. Check the '
    + 'invoice in the accounting system, and retry the registration under Sync → Xero so it records a '
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
