/**
 * o3d-i0o6 r5 (Codex round 4, HIGH 3) — WHICH LEDGER HOLDS THE UNEARNED-REVENUE LIABILITY THIS
 * REFUND IS ABOUT TO DEBIT?
 *
 * A refund's `UNEARNED_REV_REVERSAL` journal can carry TWO reversals that have nothing to do with
 * each other:
 *
 *   * the GROUP A1 half — DR Unearned Revenue / CR Sales, taking back a deferral A1 raised;
 *   * the GROUP A2 half — DR Inventory / CR Allocated Inventory, taking back the allocation contra.
 *
 * r3 proved the A2 half against ONE connector and PINNED the whole journal to it. That pin is right
 * for the allocation credit and wrong for everything beside it, because it assumes one journal has
 * one provenance. A1 defers when an order is paid; A2 reclassifies when it is allocated; a
 * connector switch can happen between the two. Then:
 *
 *   A1 defers £100 to Unearned Revenue in XERO. The books are switched to QuickBooks. A2 posts the
 *   allocation contra there, and is proved there. A full unshipped refund debits Unearned Revenue in
 *   QUICKBOOKS — where that liability was never credited — while the XERO liability stands for ever.
 *   Two ledgers wrong, from one pin.
 *
 * So the A1 half gets its OWN provenance, and where the two differ they get their own JOURNALS.
 *
 * WHAT ESTABLISHES A1'S LEDGER. A2 records its journal's id, connector and account on the order
 * (`allocationBatchPasses`). A1 records no such thing — it has only the batch REFERENCE it was
 * staged into (`revenueDeferredBatchRef`, o3d-0qoo), which is the exact `referenceId` of the log
 * `createPendingSyncLog` minted. That row is the ledger's own record of which books the deferral was
 * raised into, so it is what is read here.
 *
 * IT ESTABLISHES THE LEDGER, NOT THE POSTING. Deliberately: this answers "which books hold the
 * liability", which is the question the pin gets wrong. Whether that journal SETTLED is a second
 * question, of the shape {@link proveAllocationDebitPosting} answers for A2, and it is not asked
 * here — a refund routinely fires on the same day as a still-PENDING deferral batch, and refusing
 * those would withhold reversals for a reason this finding is not about. Tracked separately.
 *
 * AND WHERE IT CANNOT BE ESTABLISHED, NOTHING IS GUESSED. No batch reference, no row under it, or
 * rows under it on two different ledgers: each is "the books this liability sits in are not on
 * record", and the caller withholds the reversal and says so — the same answer this branch already
 * gives an `unattributed` A2 debit, for the same reason. The alternative is to post the debit into
 * whichever ledger happens to be active, which is the permissive-default shape this whole issue
 * exists to remove.
 */

export type RevenueDeferralLedgerProof<C extends string = string> =
  /** POSITIVE evidence there is no A1 deferral to reverse: none was ever recorded. */
  | { kind: 'none'; reason: string }
  /** The books the deferral was raised into, from the batch log's own `connector`. */
  | { kind: 'proved'; connector: C; referenceId: string; reason: string }
  /** Not on record. `reason` is written for an operator who has to resolve it by hand. */
  | { kind: 'unestablished'; reason: string }

export type RevenueDeferralLedgerClient = {
  accountingSyncLog: {
    findMany(args: {
      where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL'; referenceType: string; referenceId: string }
      select: { connector: true; status: true }
    }): Promise<Array<{ connector: string | null; status: string }>>
  }
}

export type RevenueDeferralAttribution = {
  /** A1's stage stamp. Only ever used to tell "A1 never ran" from "A1 ran and recorded nothing". */
  revenueDeferredDate: Date | null
  /** The exact `AccountingSyncLog.referenceId` A1 staged this order into (o3d-0qoo). */
  revenueDeferredBatchRef: string | null
  /** Prisma Decimal | number | null — the pounds A1 deferred for this order. */
  unearnedRevenueAmount: { toString(): string } | number | null
}

function deferredAmount(value: RevenueDeferralAttribution['unearnedRevenueAmount']): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(parsed) ? parsed : null
}

export async function proveRevenueDeferralLedger<C extends string = string>(
  client: RevenueDeferralLedgerClient,
  order: RevenueDeferralAttribution,
  /**
   * The connectors this build can actually route a posting to. A ledger outside the list is NOT a
   * pin — pinning to a name nothing can post would refuse the reversal for ever — so it is reported
   * as unestablished, which is the truthful description of a value this build cannot act on.
   */
  routableConnectors: readonly C[],
): Promise<RevenueDeferralLedgerProof<C>> {
  const recorded = deferredAmount(order.unearnedRevenueAmount)
  if (recorded === null || recorded <= 0) {
    if (!order.revenueDeferredDate) {
      return { kind: 'none', reason: 'Group A1 never deferred revenue for this order, so no unearned-revenue liability was raised anywhere' }
    }
    if (recorded === null) {
      return {
        kind: 'unestablished',
        reason: 'the order carries a Group A1 stamp with no recorded deferral amount, so the books holding its unearned-revenue liability are not on record',
      }
    }
    return { kind: 'none', reason: 'Group A1 deferred £0.00 for this order, so there is no unearned-revenue liability to reverse' }
  }
  if (!order.revenueDeferredBatchRef) {
    return {
      kind: 'unestablished',
      reason: `Group A1 deferred £${recorded.toFixed(2)} for this order and recorded no batch reference, so which ledger holds that unearned-revenue liability cannot be established`,
    }
  }
  const rows = await client.accountingSyncLog.findMany({
    where: {
      type: 'DAILY_BATCH_REVENUE_DEFERRAL',
      referenceType: 'DailyBatch',
      referenceId: order.revenueDeferredBatchRef,
    },
    select: { connector: true, status: true },
  })
  if (rows.length === 0) {
    return {
      kind: 'unestablished',
      reason: `the Group A1 batch ${order.revenueDeferredBatchRef} this order's £${recorded.toFixed(2)} deferral was staged into is no longer on record (retention), so which ledger holds that unearned-revenue liability cannot be established`,
    }
  }
  // TWO LEDGERS UNDER ONE REFERENCE IS NOT A TIE TO BREAK. A batch reference names a group and a
  // date, never a connector, so a switch can leave one under each — and picking either would be
  // the guess this function exists to refuse.
  const connectors = [...new Set(rows.map((row) => row.connector))]
  if (connectors.length > 1 || connectors[0] == null) {
    return {
      kind: 'unestablished',
      reason: connectors.length > 1
        ? `the Group A1 batch ${order.revenueDeferredBatchRef} this order's £${recorded.toFixed(2)} deferral was staged into has rows on ${connectors.filter((entry): entry is string => !!entry).join(' and ')}, so which ledger holds that unearned-revenue liability cannot be established`
        : `the Group A1 batch ${order.revenueDeferredBatchRef} this order's £${recorded.toFixed(2)} deferral was staged into names no ledger, so which books hold that unearned-revenue liability cannot be established`,
    }
  }
  const connector = connectors[0]
  const routable = routableConnectors.find((entry) => entry === connector)
  if (!routable) {
    return {
      kind: 'unestablished',
      reason: `Group A1 deferred this order's £${recorded.toFixed(2)} on ${connector}, which this build cannot post to, so the unearned-revenue reversal has nowhere it may be raised`,
    }
  }
  return {
    kind: 'proved',
    connector: routable,
    referenceId: order.revenueDeferredBatchRef,
    reason: `Group A1 deferred £${recorded.toFixed(2)} for this order on ${connector}, under batch ${order.revenueDeferredBatchRef}`,
  }
}
