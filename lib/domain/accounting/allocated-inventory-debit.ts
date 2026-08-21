/**
 * o3d-o97 r4 — IS THERE A GROUP A2 DEBIT STANDING AGAINST THIS ORDER?
 *
 * Group A2 posts DR Allocated Inventory / CR Inventory for a day's newly-allocated orders and
 * stamps each member with `inventoryAllocatedDate`, the pounds it contributed
 * (`allocationBatchAmount`) and — since this branch — the journal it was staged into
 * (`allocationBatchSyncLogId`).
 *
 * TWO un-stage sites clear all of that on an order that is NOT being refunded:
 * `resetAllocationAccountingIfStaged` (an allocation edit, a release, an order cancellation) and
 * `releaseOverallocations` (the rebalancer). Clearing it does two separate harms, and the second is
 * only possible because of the first:
 *
 *   1. IT DESTROYS THE ONLY RECORD OF A POSTED DEBIT. `allocationBatchAmount` is what a later
 *      refund's open-balance arithmetic subtracts relief from, what `recreateMissingDailyBatchLogs`
 *      rebuilds a lost A2 journal from, and what the hard-delete guard reads to know a journal
 *      stands against the order. Nulled, the pounds are still in the ledger and nothing in IMS
 *      knows they are owed.
 *   2. IT LETS A2 POST THE SAME ORDER AGAIN. Group A2 selects on `inventoryAllocatedDate: null`, so
 *      the next run re-values the order at its new pins and raises a SECOND debit. Only the second
 *      one has a record, so the refund residue can only ever relieve the latest posting and the
 *      first is stranded for ever.
 *
 * The fix is not to refuse the un-stage — cancelling an order and editing its allocations have to
 * keep working, and both go through these paths — but to stop the un-stage from being a DELETION OF
 * EVIDENCE. Where the debit stands, the stamp and its attribution are KEPT: A2 will not re-post an
 * order it can still see a stamp on, the refund's open balance still finds the amount, and the
 * delete guard still sees the journal. Only the per-allocation pins, which the caller is about to
 * replace, are cleared.
 *
 * What is deliberately NOT attempted here is REVERSING the debit when the order's allocations shrink
 * or the order is cancelled outright. There is no credit note to carry that reversal and it needs a
 * sync type of its own; keeping the record is what makes that repair possible later instead of
 * impossible.
 *
 * o3d-o97 r5 — AND A *STATUS* IS NEVER THE POSITIVE EVIDENCE. r4 built the gate above and then let
 * one status through it: a journal recorded CANCELLED counted as proof that nothing was debited, so
 * the stamp, the amount and the attribution were destroyed on sight. CANCELLED does not mean that.
 * It means SOMEBODY OR SOMETHING ABANDONED THE ROW, and three separate writers reach it without any
 * of them knowing whether pounds moved:
 *
 *   * the cross-connector orphan sweep (`app/actions/accounting-sync.ts`), whose own comment records
 *     that an UNSCOPED run once cancelled the rows of the connector that had just become ACTIVE;
 *   * `cancelPendingSalesInvoiceSyncForOrder`, which retires rows when an order is cancelled;
 *   * an operator, from the accounting-sync screen.
 *
 * And a claimed row is cancelled without proof either way, because the processors POST BEFORE they
 * persist SYNCED and the external id — the same reasoning o3d-ju8t used to establish that a FAILED
 * row does not prove nothing posted. CANCELLED is that same class of fact, not its opposite.
 *
 * WORKED. A2 debits £40 for this order under journal J and J reaches Xero. J is later marked
 * CANCELLED — by any of the three above. An allocation edit then runs the un-stage:
 *
 *   r4    CANCELLED reads as "nothing was debited", so the stamp, the £40 and the attribution are
 *         nulled. Group A2 selects on `inventoryAllocatedDate: null`, so the next run re-values the
 *         order at its new pins — say £52 — and raises a SECOND debit under a new journal. Allocated
 *         Inventory now holds £92 and IMS has a record of £52. The eventual full refund reverses the
 *         £52 it can see; the original £40 stands for ever, and NOTHING ANYWHERE POINTS AT IT,
 *         because the evidence was deleted by the very write that made the second debit possible.
 *   r5    the debit STANDS. The stamp and the £40 are kept, so A2 never re-posts and the refund's
 *         open balance still finds the £40. Either way exactly £40 is on record and reversible.
 *
 * o3d-o97 r6 — AND THE OTHER READER OF THAT SAME STATUS NOW AGREES. r5 justified the paragraph above
 * partly by saying that if J genuinely never reached a ledger `recreateMissingDailyBatchLogs`
 * re-raises it, "a CANCELLED log does not count as live there". That was true and it was the defect:
 * the recreate sweep read CANCELLED as proof the journal MUST be posted again, which is the same
 * unsound inference as r4's, pointed the other way — and it is the one that writes to the ledger, so
 * where r4 stranded pounds this DOUBLED them. The sweep no longer reads the status at all. It asks
 * for positive evidence that no remote call was made (`abandonedBeforeRemoteCall`, written only by
 * the orphan sweep, which cancels PENDING — pre-call — rows only) and otherwise refuses and reports.
 *
 * So the healing path this file used to point at is narrower and honest: a cancelled A2 journal is
 * re-raised only where its canceller RECORDED that nothing was sent. Everywhere else the debit
 * stands, exactly as below, and a human decides — which is what both readers now say about the same
 * fact instead of two opposite things.
 *
 * TWO facts still clear the stamp, and both are records A2 WROTE ABOUT ITSELF rather than statuses
 * some later sweep imposed: no stamp at all, and a recorded debit of exactly zero.
 */

/** Minimal client: the journal probe is a primary-key read. */
export type AllocatedInventoryDebitClient = {
  accountingSyncLog: {
    findUnique(args: { where: { id: string }; select: { status: true } }): Promise<{ status: string } | null>
  }
}

export type StagedAllocationDebit = {
  /** True when pounds may still be sitting in Allocated Inventory for this order. */
  standing: boolean
  /** Why, in words an operator can act on — recorded on the activity log by the un-stage sites. */
  reason: string
}

export type StagedAllocationDebitInput = {
  inventoryAllocatedDate: Date | null
  /** Prisma Decimal | number | null — compared against zero only, never used in arithmetic. */
  allocationBatchAmount: { toString(): string } | number | null
  allocationBatchSyncLogId: string | null
}

function recordedAmount(value: StagedAllocationDebitInput['allocationBatchAmount']): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Answers "may pounds still be sitting in Allocated Inventory for this order?" — and answers it the
 * way the rest of o3d-o97 answers this family of questions: only POSITIVE EVIDENCE clears the debit.
 *
 *   no stamp             A2 never staged the order. Nothing was debited. Not standing.
 *   recorded ZERO        A2 staged it and valued it at nothing. A KNOWN debit of zero, which is not
 *                        the same fact as an unknown one. Not standing.
 *   anything else        standing — and o3d-o97 r5 means ANYTHING, because no status the journal row
 *                        can be carrying is evidence about pounds. That covers SYNCED (it posted),
 *                        PENDING/PROCESSING (it is going to post — clearing the stamp now would let
 *                        A2 raise a second debit while the first is still in the outbox), FAILED
 *                        (o3d-ju8t: a FAILED row does not prove nothing was posted), CANCELLED (r5:
 *                        an abandonment written by a sweep or an operator, which says nothing about
 *                        what the row did before it was abandoned — see the header), a journal row
 *                        retention has since deleted, and an order stamped before the attribution
 *                        columns existed, where the recorded amount is the only evidence there is
 *                        and nothing can retroactively prove the batch it belonged to never posted.
 *
 * The journal is still READ, and its status still appears in the reason an operator sees — a
 * standing debit under a CANCELLED journal is a different thing to repair than one under a SYNCED
 * journal. What r5 removes is the status DECIDING anything.
 */
export async function resolveStagedAllocationDebit(
  client: AllocatedInventoryDebitClient,
  order: StagedAllocationDebitInput,
): Promise<StagedAllocationDebit> {
  if (!order.inventoryAllocatedDate) {
    return { standing: false, reason: 'Group A2 never staged this order, so nothing was debited to Allocated Inventory' }
  }
  const amount = recordedAmount(order.allocationBatchAmount)
  if (amount !== null && amount <= 0) {
    return { standing: false, reason: 'Group A2 staged this order and recorded a debit of £0.00, so there is nothing in Allocated Inventory to strand' }
  }
  const amountLabel = amount === null ? 'an unrecorded amount' : `£${amount.toFixed(2)}`
  if (!order.allocationBatchSyncLogId) {
    return {
      standing: true,
      reason: `Group A2 staged this order for ${amountLabel} and named no journal, so whether that debit reached a ledger cannot be established`,
    }
  }
  const journal = await client.accountingSyncLog.findUnique({
    where: { id: order.allocationBatchSyncLogId },
    select: { status: true },
  })
  if (!journal) {
    return {
      standing: true,
      reason: `the Group A2 journal carrying this order's ${amountLabel} debit is no longer on record (retention), so whether it reached a ledger cannot be established`,
    }
  }
  if (journal.status === 'CANCELLED') {
    // o3d-o97 r5: NOT a clearance. A cancelled row is an abandoned row, and abandonment is written
    // by sweeps and operators that cannot see whether the remote call had already landed. Keeping
    // the record costs nothing — A2 will not re-post an order it can still see a stamp on — while
    // clearing it destroys the only evidence of the debit AND lets A2 raise a second one.
    //
    // o3d-o97 r6: the recreate sweep no longer re-raises this journal off the back of the status
    // either (it demands `abandonedBeforeRemoteCall` and otherwise refuses and reports), so the
    // stamp standing here is the state a human resolves, not a state a sweep resolves behind them.
    return {
      standing: true,
      reason: `the Group A2 journal carrying this order's ${amountLabel} debit is recorded CANCELLED, which says the row was abandoned and not that the ledger was never reached, so that debit cannot be treated as un-posted`,
    }
  }
  return {
    standing: true,
    reason: `Group A2 debited Allocated Inventory ${amountLabel} for this order under journal ${order.allocationBatchSyncLogId} (${journal.status})`,
  }
}
