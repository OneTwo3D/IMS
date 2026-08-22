/**
 * o3d-2sm1 — CAN THIS ROW SAY WHETHER A REVERSAL WAS STAGED AND NEVER SENT?
 *
 * `createSalesOrderRefund` used to do two things in two commits. First
 * `stageRefundAccountingReversals` ran its own transaction, which — on a FULL refund — computes the
 * COGS/unearned/allocation reversals and then UN-STAGES the order: `revenueDeferredDate`,
 * `revenueDeferredBatchRef` and the whole A2 attribution nulled. Only after it returned did a second
 * statement persist `accountingRetrySyncs` and clear `accountingRetryRequired`.
 *
 * A crash, timeout or lost connection between the two left the refund flagged as owing accounting
 * with nothing recorded for a retry to re-queue — and `retrySalesOrderRefundAccounting` read the
 * now-null deferral as "this order never owed a reversal", reported SUCCESS having queued nothing,
 * and let the caller clear the flag. Three reversals dropped, no error anywhere.
 *
 * The two writes are now ONE transaction, so the state cannot be created from here on. This module
 * is for the rows that already exist, and for any writer that is not that transaction.
 *
 * WHY THIS IS A TRI-STATE AND NOT A PREDICATE (Codex r1, CRITICAL).
 *
 * The first version of this asked `allocatedReliefAmount != null && accountingRetrySyncs == null`
 * and answered true/false. Both columns are NULLABLE AND NOT BACKFILLED, and both were introduced
 * AFTER the two-commit window they were being asked about — so on a row written before them, NULL
 * is not evidence of anything, and a boolean has nowhere to put that. It came out as `false`, which
 * every caller read as "nothing was staged, carry on": the genuinely-lost legacy reversal — the
 * exact row the check exists to catch — was waved through, and a legacy row that never staged at
 * all was waved through for the same reason, so the answer was uninformative in BOTH directions.
 *
 * That is the same defect as the one this branch fixed one level down, one layer up:
 * `refundAccountingSyncsJson` wrote a database NULL for an empty list, making "staged nothing" and
 * "the persist never happened" byte-identical. It writes `[]` now — an empty field is not a zero
 * (o3d-clxw) — and the fix here is the same in kind: give the absence somewhere to live.
 *
 * WHAT MAKES THE THREE STATES DISTINGUISHABLE: `SalesOrderRefund.reversalStagingState`, a witness
 * written by the two transactions that actually see the events.
 *
 *   NOT_STAGED  written by the INSERT in `createSalesOrderRefund`, in the transaction that creates
 *               the refund row. It says: this row was born under code that keeps this column, and
 *               as of its birth no staging has committed for it. A staging that then rolls back
 *               leaves this standing, because the marker below rolls back with it.
 *   STAGED      written by `stageRefundAccountingReversals`, in the SAME statement as
 *               `allocatedReliefAmount` and the statement immediately before the un-stage, inside
 *               the staging transaction. Commits with the un-stage or not at all, which is what
 *               makes it proof rather than inference.
 *   NULL        no writer ever spoke for this row: the column did not exist when it was written.
 *               UNDECIDABLE. Not "nothing was staged".
 *
 * DELIBERATELY NOT BACKFILLED, and the migration adds the column with no DEFAULT for exactly this
 * reason. Setting `NOT_STAGED` (or `STAGED`) on the rows that are already there from what they look
 * like today would be the database vouching for events it never witnessed — the same refusal
 * o3d-s36z made, and the same one the `[]` change made when it declined to promote historical
 * NULLs. Legacy rows are legitimately unknown; this module's job is to SAY so, and each caller's
 * job is to decide what to do about it. Neither may report an undecidable row as a confirmed loss,
 * and neither may silently clear it.
 */

/** Written by the INSERT that creates the refund: witnessed birth, no staging committed yet. */
export const REVERSAL_STAGING_NOT_STAGED = 'NOT_STAGED'
/** Written inside the staging transaction, in the statement before the un-stage. */
export const REVERSAL_STAGING_STAGED = 'STAGED'

export type ReversalRecordVerdict =
  /** Staging committed for this refund and no record of what it produced exists. */
  | 'staged-never-recorded'
  /** Either the record is there, or staging demonstrably never committed. Nothing is missing. */
  | 'nothing-lost'
  /** The row predates the witness column. What happened to it cannot be read out of the database. */
  | 'undecidable'

export function reversalRecordVerdict(refund: {
  accountingRetryRequired: boolean
  accountingRetrySyncs: unknown
  reversalStagingState?: unknown
}): ReversalRecordVerdict {
  // The flag is set at creation on every refund that owes accounting and cleared ONLY by a staging
  // whose syncs were recorded (o3d-mrwu). Cleared means the pair of writes completed.
  if (!refund.accountingRetryRequired) return 'nothing-lost'
  // The record IS on the row. Asked BEFORE the witness, so a legacy row that has a recorded list is
  // decided on the evidence it actually carries instead of being swept into 'undecidable' — an
  // empty list included, because `[]` is a written value and says staging ran and staged nothing.
  if (refund.accountingRetrySyncs != null) return 'nothing-lost'
  switch (refund.reversalStagingState) {
    case REVERSAL_STAGING_STAGED:
      return 'staged-never-recorded'
    case REVERSAL_STAGING_NOT_STAGED:
      return 'nothing-lost'
    default:
      return 'undecidable'
  }
}
