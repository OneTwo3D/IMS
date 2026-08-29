/**
 * o3d-2k5r — what to tell the operator after `reopenShipmentForRepackAction`'s re-allocation.
 *
 * Pure and separate from the action because it is a decision, not plumbing, and because the
 * version that lived inline got it backwards on the commonest path.
 *
 * o3d-2k5r r3: the recovery now commits the reopen, the netting and the backstop resolution as ONE
 * transaction, so the third case below is no longer reachable from that action — it aborts and
 * rolls the reopen back instead of reporting a two-thirds state. The branch stays because this is a
 * total function over its own input type and a caller that does not roll back would otherwise fall
 * through to silence, which is the failure this module exists to prevent.
 *
 * What matters is which of three genuinely different outcomes happened:
 *
 *  - REFUSED — another committed shipment blocked the rebuild. Nothing was re-allocated and no
 *    backstop row was consumed; the operator has a concrete next action.
 *  - COMMITTED but not successful — the BACKORDER path, and the one that was being mis-reported.
 *    `runAllocation` COMMITTED: the refunded units' reservation WAS released and
 *    `onReconciledInTx` (which runs immediately before that commit) HAS resolved the durable
 *    refund-reservation-release backstop rows. `success` is false only because some remaining
 *    demand could not be re-reserved. Telling the operator to "run allocation again" here points
 *    them at a retry whose durable driver has already been consumed, and calls the one thing that
 *    DID happen — the netting — the thing that did not.
 *  - Neither — a pre-transaction bail or a rolled-back transaction. Reservations really are stale
 *    and re-running allocation really is the remedy.
 */
export type RepackReallocationOutcome = {
  refused?: boolean
  success: boolean
  /** True ONLY when the allocation transaction actually committed (autoAllocateOrder sets this). */
  committed?: boolean
  error?: string
  unallocatedQty?: number
  /**
   * o3d-2k5r r3: true when the action RESUMED an already-reopened draft rather than reverting a
   * committed shipment on this run. "Shipment reopened, but…" is simply false there, and an
   * operator reading it looks for a revert that did not happen.
   */
  resumed?: boolean
}

/** The operator-facing warning, or null when the recovery completed with nothing to say. */
export function describeRepackReallocation(
  orderRef: string,
  realloc: RepackReallocationOutcome,
): string | null {
  const opened = realloc.resumed ? 'The shipment was already a draft' : 'Shipment reopened'
  if (realloc.refused) {
    // o3d-2k5r r5: "or dispatch it" was WRONG and it was the same defect as the control that
    // rendered here — a remedy named by a surface that the predicate does not honour.
    // `refuseIfCommittedShipmentsExist` matches every status that is not PENDING, SHIPPED included,
    // and a dispatched shipment cannot be reopened afterwards. Dispatching the sibling does not
    // release the reservation; it closes the only door that would have.
    return `${opened}, but stock could not be re-allocated because order ${orderRef} still has `
      + 'another committed (picking or packed) shipment. REOPEN that one too — every shipment on the order '
      + 'has to be back to a draft before the refunded units’ reservation can be released, and dispatching '
      + 'it instead makes that impossible, because a dispatched shipment cannot be reopened — IMS will then '
      + 'refuse to reopen anything on this order at all (o3d-2k5r r6), and the release has to be reconciled '
      + 'by hand. Once nothing committed is left, "Finish repack recovery" on the draft completes it.'
  }
  if (realloc.success) return null
  if (realloc.committed) {
    return `${opened} and the refunded units’ reservation was released, but order ${orderRef} `
      + 'could not be fully re-allocated'
      + `${realloc.error ? ` (${realloc.error})` : ''}`
      + `${realloc.unallocatedQty ? ` — ${realloc.unallocatedQty} unit(s) are on backorder` : ''}. `
      + 'Rebuild the shipment for what is allocated, or wait for stock — the refund reconciliation itself '
      + 'is done, so re-running allocation will not change it.'
  }
  return `${opened}, but re-allocating order ${orderRef} did not complete`
    + `${realloc.error ? ` (${realloc.error})` : ''}. The refunded units may still be reserved; `
    + 'run allocation on this order again before rebuilding the shipment.'
}
