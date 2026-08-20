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
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function hasPostEvidence(row: PaymentRegistrationRow): boolean {
  return trimmed(row.externalTransactionId).length > 0
}

/**
 * Split the registrations that NAME this payment into the ones that can simply be retired and the
 * ones the ledger holds.
 *
 * The caller is responsible for having filtered to rows whose payload names this payment id — a row
 * that names no payment is nobody's to retract, and matching by amount instead is what used to
 * retract an imported order's own registration (Codex, PR #582 round 2).
 */
export function splitPaymentRegistrations(rows: readonly PaymentRegistrationRow[]): PaymentRegistrationSplit {
  const retirable: PaymentRegistrationRow[] = []
  const ledgerHold: PaymentRegistrationRow[] = []
  for (const row of rows) {
    const held = (LEDGER_HELD_REGISTRATION_STATUSES as readonly string[]).includes(row.status)
    if (hasPostEvidence(row)) {
      ledgerHold.push(row)
    } else if (row.status === 'PENDING') {
      retirable.push(row)
    } else if (held) {
      ledgerHold.push(row)
    }
    // Anything else — FAILED or CANCELLED with no document id — holds nothing in the ledger and
    // needs no action: settlementStatus already reads it as genuinely unpaid on both sides.
  }
  return { retirable, ledgerHold }
}

// ---------------------------------------------------------------------------
// The refusal deletePayment now returns
// ---------------------------------------------------------------------------

export type PaymentDeleteRefusalCode =
  /** The ledger holds a payment for this receipt; reverse it there first. */
  | 'ledger_holds_payment'
  /** A worker claimed the queued registration while the delete was running. */
  | 'registration_in_flight'

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
