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
 *               the refund row, and by NOTHING ELSE — the migration ships no trigger that could mint
 *               it, deliberately (see below).
 *               It says: this row was born under code that keeps this column, and as of its birth no
 *               staging has committed for it. That is only credible from a writer that also keeps
 *               the column at staging time, which is why the claim is the application's to make and
 *               not the database's. A staging that then rolls back leaves this standing, because the
 *               marker below rolls back with it.
 *   STAGED      written by `stageRefundAccountingReversals`, in the SAME statement as
 *               `allocatedReliefAmount` and the statement immediately before the un-stage, inside
 *               the staging transaction. Commits with the un-stage or not at all, which is what
 *               makes it proof rather than inference.
 *   NULL        no writer ever spoke for this row: the column did not exist when it was written.
 *               UNDECIDABLE. Not "nothing was staged".
 *
 * WHICH WRITERS THIS COLUMN CAN SPEAK FOR, AND WHICH IT CANNOT. Migrations are applied before the
 * build that knows about them is serving, so for the length of every release an OLD binary is
 * writing refunds into the new schema, omitting the column it has never heard of. Rows it mints land
 * NULL — and they are minted by exactly the code that still has the two-commit bug.
 *
 * THE COLUMN IS WRITTEN BY THIS APPLICATION AND BY NOTHING ELSE. Three successive rounds of this
 * work tried to close that window with database triggers — an INSERT mint, an UPDATE mint, then a
 * BEFORE UPDATE trigger refusing the predecessor's clearing statement — and each was right about the
 * hole and wrong about where the rule could live. A trigger can only witness what the writer in
 * front of it actually does, and the predecessor across this window writes nothing to this table
 * while staging; a refusal needs an escape for a legitimate manual settle, and that escape was
 * reachable from restore SQL; and the migration outlives a rollback, so the rows such a guard would
 * falsely accuse are not bounded by the window either. Every attempt was the same problem in new
 * clothes: a witness trying to make a guarantee that spans a DEPLOY WINDOW. That is a deployment
 * change, not a schema one, and it is filed as o3d-2sm1.1 rather than approximated here.
 *
 * SO NULL MEANS ONE OF TWO THINGS, AND THE MODULE CLAIMS NO MORE: the row predates the column, or it
 * was written by a binary that does not set it. Both are undecidable and both are treated
 * identically — refused by the retry, named by the invariant. What NULL never means is "nothing was
 * staged".
 *
 * THE RESIDUAL, EXACTLY. The retry that refuses and the invariant that names both live in THIS
 * binary. Across the release window the PREDECESSOR is serving, and its retry does not refuse
 * anything: it reads the nulled deferral as "nothing was owed", reports success, and its caller
 * writes `accountingRetryRequired: false` with a NULL sync list. That flag is the accounting
 * invariant's only bound. So a predecessor's own retry can still clear the flag on an undecidable
 * row, and once it has, the row is outside the bound and UNRECOVERABLE — not by this module, not by
 * the invariant, not by any later sweep. That is a real limitation of deploying a fix, not a claim
 * this branch can make good on; see the migration and o3d-2sm1.1.
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
  // The flag is set at creation on every refund that owes accounting, and o3d-2sm1 r6 made what
  // clears it STRICTLY STRONGER than it was: the staging transaction no longer clears it, so the one
  // writer that does is the caller's `clearRefundAccountingRetryState`, which runs only after
  // `queueRefundAccountingActions` has returned with every sync it queued committed. Cleared
  // therefore means staged, recorded AND queued — not merely staged and recorded. Nothing here had
  // to change; the premise this line rests on only got harder to satisfy.
  //
  // The converse is where the cost lands, and it is stated where it is created (see the staging
  // block in refund-service.ts): a crash between the last queue commit and that clear leaves the
  // flag SET on a refund that owes nothing. Such a row reaches the next line with a recorded
  // `accountingRetrySyncs`, so it answers `nothing-lost` — a stale flag is never dressed up as a
  // lost reversal.
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
