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
 *   journal CANCELLED    the journal was abandoned before it reached a ledger (the cross-connector
 *                        orphan sweep), so nothing was debited anywhere. Not standing.
 *   anything else        standing. That covers SYNCED (it posted), PENDING/PROCESSING (it is going
 *                        to post — clearing the stamp now would let A2 raise a second debit while
 *                        the first is still in the outbox), FAILED (o3d-ju8t: a FAILED row does not
 *                        prove nothing was posted), a journal row retention has since deleted, and
 *                        an order stamped before the attribution columns existed, where the recorded
 *                        amount is the only evidence there is and nothing can retroactively prove
 *                        the batch it belonged to never posted.
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
    return {
      standing: false,
      reason: `the Group A2 journal carrying this order's ${amountLabel} debit was CANCELLED, so nothing was debited to Allocated Inventory`,
    }
  }
  return {
    standing: true,
    reason: `Group A2 debited Allocated Inventory ${amountLabel} for this order under journal ${order.allocationBatchSyncLogId} (${journal.status})`,
  }
}
