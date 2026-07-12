/**
 * Refund-reversal-aware deferred-revenue true-up (cogs-audit scjz.68).
 *
 * The Group-B daily batch recognizes deferred revenue as shipments dispatch and,
 * on the final shipment of a fully-shipped terminal order, trues up the remainder
 * so rounding drift never strands pence in deferral (scjz.41). PARTIALLY_REFUNDED
 * orders were excluded from that true-up because:
 *
 *  1. A refund of an order's UNSHIPPED lines posts an UNEARNED_REV_REVERSAL that
 *     debits the unearned-revenue account — clearing part of the deferral OUTSIDE
 *     the shipment-recognition running total. `remainingDeferred` only subtracts
 *     prior shipment recognition, so truing up the raw remainder would recognize
 *     (and over-debit unearned revenue for) value the refund already reversed.
 *  2. The refund workflow can set PARTIALLY_REFUNDED from pre-shipment states, so
 *     the status alone does not mean the order is done shipping.
 *
 * These pure helpers make the true-up safe for partially-refunded orders:
 *  - `sumPostedUnearnedReversal` feeds a reversal-aware `remainingDeferred`.
 *  - `isFullyShippedNetOfRefunds` gates the true-up to orders that have actually
 *    shipped every line net of refunds.
 *  - `batchContainsFinalUnjournaledShipment` blocks a premature true-up when the
 *    daily-batch limit split the order's shipments across runs.
 *
 * They are deliberately DB-free so the (live-GL) decision logic is unit-tested in
 * isolation; the daily-sync / preview call sites only assemble their inputs.
 */

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Total unearned-revenue-account debit across an order's posted (PENDING /
 * PROCESSING / SYNCED) UNEARNED_REV_REVERSAL syncs.
 *
 * Only the debit to `unearnedRevenueAccount` counts: the same reversal payload may
 * also carry an allocation-reversal line that debits the INVENTORY account, which
 * is not deferred revenue and must not be subtracted from the deferral. Mirrors
 * refund-service's `extractPayloadAmount` / `priorUnearnedReversed` (the amount
 * the credit note actually took out of unearned revenue).
 */
export function sumPostedUnearnedReversal(
  reversalSyncs: Array<{ payload: unknown }>,
  unearnedRevenueAccount: string,
): number {
  let total = 0
  for (const sync of reversalSyncs) {
    const lines = (sync.payload as { lines?: Array<{ accountCode?: string; debit?: number }> } | null)?.lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (line.accountCode === unearnedRevenueAccount) {
        total += Number(line.debit ?? 0)
      }
    }
  }
  return round2(total)
}

/**
 * Whether a PARTIALLY_REFUNDED order has, for every shippable line, shipped the
 * full ordered quantity once units refunded WHILE UNSHIPPED are credited — i.e.
 * it is "fully shipped net of refunds" and so the remaining deferred revenue is
 * safe to true up.
 *
 * `coveredQty` is in sales-line units and must combine, per line, the dispatched
 * (status SHIPPED) shipment coverage accumulated across the order's whole shipment
 * history AND the allocation-source (unshipped) refund coverage. Combining the
 * underlying component quantities BEFORE taking line coverage (min-of-sums) is the
 * caller's job; doing so is exact for kits, whereas summing two separate coverages
 * would under-count and needlessly strand them in deferral.
 *
 * Returns false when there are no shippable lines: nothing anchors the true-up, so
 * the conservative choice is to leave the order deferred rather than recognize.
 */
export function isFullyShippedNetOfRefunds(
  lines: Array<{ orderedQty: number; coveredQty: number }>,
  epsilon = 1e-6,
): boolean {
  let hasShippableLine = false
  for (const line of lines) {
    if (line.orderedQty <= 0) continue
    hasShippableLine = true
    if (line.coveredQty < line.orderedQty - epsilon) {
      return false
    }
  }
  return hasShippableLine
}

/**
 * Whether this daily-batch run contains the order's final still-unjournaled
 * shipment. When `XERO_DAILY_BATCH_LIMIT` puts only some of an order's unjournaled
 * shipments in the current run, truing up the full remainder on this slice's last
 * shipment would pre-empt the revenue of shipments that journal in a later run, so
 * the true-up must wait until every unjournaled shipment is in the same batch.
 *
 * Callers pass the order's DISPATCHED (status SHIPPED) shipments only — those are
 * the ones Group B will journal. A still-undispatched shipment is handled by the
 * eligibility coverage check (its line is not yet covered), not here, so it must
 * not be counted as a blocking unjournaled shipment or a never-dispatched row
 * would strand the true-up permanently.
 */
export function batchContainsFinalUnjournaledShipment(
  dispatchedOrderShipments: Array<{ id: string; shipmentJournalDate: Date | string | null }>,
  shipmentIdsInThisBatch: ReadonlySet<string>,
): boolean {
  const unjournaled = dispatchedOrderShipments.filter((shipment) => !shipment.shipmentJournalDate)
  if (unjournaled.length === 0) return false
  return unjournaled.every((shipment) => shipmentIdsInThisBatch.has(shipment.id))
}
