// ---------------------------------------------------------------------------
// o3d-peh1 — A REFUSAL THAT ITS CALLERS CANNOT SEE IS A NO-OP THAT REPORTS SUCCESS.
//
// `enqueueFollowUpSyncLog` has three ways of declining to enqueue a follow-up, and every one of them
// is a deliberate, correct refusal: an ambiguous idempotency-token history, a ledger that will not
// say the attempt is absent, and a live sibling holding the scope under a token that is not ours.
// Each wrote a WARNING to the activity log and then RETURNED NORMALLY, and `Promise<void>` gave the
// caller nothing to read. So every caller — the connector's own post path, the credit-note
// re-enqueue sweep, and above all `repairXeroBackReferences` — treated the refusal as "the follow-ups
// are enqueued".
//
// The worst of those is the back-reference sweep, because it does not merely continue: it SETTLES.
// It marks the parent row SYNCED, clears `backReferenceFollowUpsPendingAt` — the last record that
// anything was owed — and logs `xero_backreference_followups_recovered`, while the money-moving child
// (an INVOICE_PAYMENT, a PURCHASE_CREDIT_NOTE_ALLOCATION) is still FAILED and was never re-enqueued.
// A payment is lost, and the log says it was recovered.
//
// THE OUTCOME IS A UNION, NOT A BOOLEAN BESIDE A LIST. `{ enqueued: boolean; refusals: [] }` can be
// constructed inconsistently — enqueued true with refusals in it, or false with none — and the first
// caller to read the wrong half of it reintroduces the defect in a new place. Here the refusals exist
// only on the arm that has them, and the only constructor that can build that arm demands at least
// one, so "there is a refusal" and "this was not enqueued" are the same fact.
//
// A REFUSAL CARRIES ITS OPERATOR MESSAGE. Not a code the caller re-renders into prose of its own:
// two hand-written descriptions of the same refusal drift, and the sweep is further from the
// evidence than the enqueue is. The enqueue writes the sentence once, logs it, and hands the same
// sentence to whoever has to act on it.
// ---------------------------------------------------------------------------

/**
 * Why a follow-up enqueue declined. These are the machine keys that already appear in the
 * `*_followup_enqueue_refused` activity metadata, so an operator reading the log and a caller
 * branching on the outcome are naming the same thing.
 */
export type FollowUpEnqueueRefusalReason =
  /** `planFollowUpEnqueue` refused: several FAILED rows for this scope under DIFFERENT tokens. */
  | 'plan_refused'
  /** o3d-0m56: the ledger would not confirm the attempt is absent, so re-posting could duplicate it. */
  | 'ledger_not_clear'
  /** A live row owns the scope under a different idempotency token, or the enqueue race was lost. */
  | 'slot_lost'

export type FollowUpEnqueueRefusal = {
  type: string
  referenceType: string
  referenceId: string
  reason: FollowUpEnqueueRefusalReason
  /**
   * The operator-facing sentence, ending in a remedy that can actually be performed. Written by the
   * enqueue, logged by the enqueue, and re-used verbatim by whichever caller has to report it.
   */
  message: string
  /** The FAILED row a revival would have reused, where the refusal was about a specific row. */
  syncLogId?: string
}

/**
 * Did the enqueue leave this row's follow-ups OWED?
 *
 * `enqueued: true` means every follow-up this row owes is now queued, or was already queued by a
 * live row, or the row owes none. It is the ONLY value a caller may settle on.
 */
export type FollowUpEnqueueOutcome =
  | { readonly enqueued: true }
  | { readonly enqueued: false; readonly refusals: readonly FollowUpEnqueueRefusal[] }

export const FOLLOW_UPS_ENQUEUED: FollowUpEnqueueOutcome = { enqueued: true }

/**
 * Build a refused outcome. Throws on an empty list rather than quietly producing a refused outcome
 * with nothing in it — an unexplained refusal is the same silence this type exists to remove, and a
 * caller cannot report what it was not told.
 */
export function refusedFollowUpEnqueue(...refusals: FollowUpEnqueueRefusal[]): FollowUpEnqueueOutcome {
  if (refusals.length === 0) throw new Error('refusedFollowUpEnqueue requires at least one refusal')
  return { enqueued: false, refusals }
}

/** The refusals an outcome carries; empty for an enqueued one. */
export function followUpEnqueueRefusals(outcome: FollowUpEnqueueOutcome): readonly FollowUpEnqueueRefusal[] {
  return outcome.enqueued ? [] : outcome.refusals
}

/**
 * Fold the fan-out of one posted row (an invoice owes a payment AND a PDF; a PDF owes an email AND a
 * store note) into one outcome.
 *
 * REFUSALS ACCUMULATE AND NOTHING SWALLOWS THEM. A refused payment beside an enqueued PDF is refused
 * overall, because the caller's question is "may I settle this row?" and the answer is no while any
 * part of the work is still owed.
 */
export function combineFollowUpEnqueueOutcomes(
  ...outcomes: FollowUpEnqueueOutcome[]
): FollowUpEnqueueOutcome {
  const refusals = outcomes.flatMap(followUpEnqueueRefusals)
  return refusals.length === 0 ? FOLLOW_UPS_ENQUEUED : { enqueued: false, refusals }
}

/** One line naming every refusal, for an activity-log description or a thrown error. */
export function describeFollowUpEnqueueRefusals(outcome: FollowUpEnqueueOutcome): string {
  return followUpEnqueueRefusals(outcome)
    .map((refusal) => `${refusal.type} for ${refusal.referenceType} ${refusal.referenceId} (${refusal.reason}): ${refusal.message}`)
    .join(' | ')
}
