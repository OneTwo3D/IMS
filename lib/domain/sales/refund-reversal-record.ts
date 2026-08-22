/**
 * o3d-2sm1 — THE RECORD THAT SAYS "A REVERSAL WAS STAGED AND NEVER SENT".
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
 * The two writes are now ONE transaction, so the state cannot be created from here on. This
 * predicate is for the rows that already exist, and for any writer that is not that transaction.
 *
 * WHAT IT ASKS, and why it takes two columns rather than the missing date:
 *
 *   allocatedReliefAmount   written UNCONDITIONALLY by `stageRefundAccountingReversals`, inside the
 *                           same transaction as the un-stage and in the statement immediately
 *                           before it (o3d-o97 r3). Non-null is therefore proof that THIS refund's
 *                           staging COMMITTED — which the order's cleared deferral is not: an order
 *                           that was never revenue-deferred at all has the same null date, and a
 *                           refund on one can be flagged for retry by a failed credit-note enqueue.
 *                           Reading the date alone would refuse every one of those.
 *   accountingRetrySyncs    NULL is proof the second write did NOT happen — but only since the
 *                           empty list began being stored as `[]` rather than `DbNull`
 *                           (`refundAccountingSyncsJson`). Before that, "staged nothing" and "never
 *                           recorded" were the same NULL, which is the o3d-clxw shape: an empty
 *                           field is not a zero, and no reader can tell a written value from an
 *                           absent one.
 *
 * DELIBERATELY NOT BACKFILLED, and the caller must treat a false as "no evidence" rather than as
 * "nothing was owed". A refund staged before `allocatedReliefAmount` existed, or before the empty
 * list became a written value, answers false here whatever happened to it; writing those columns
 * from what the rows look like today would be the database vouching for events it never witnessed.
 * Such rows keep exactly the behaviour they had before this predicate existed.
 */
export function reversalStagedButNeverRecorded(refund: {
  accountingRetryRequired: boolean
  accountingRetrySyncs: unknown
  allocatedReliefAmount?: unknown
}): boolean {
  return refund.accountingRetryRequired
    && refund.allocatedReliefAmount != null
    && refund.accountingRetrySyncs == null
}
