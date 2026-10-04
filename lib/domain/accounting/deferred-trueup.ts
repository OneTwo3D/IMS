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

import {
  UNPROVEN_CANCELLED_WHERE,
  WORK_SLOT_OCCUPIED_WHERE,
  ledgerStanding,
  workSlotStanding,
  type LedgerStandingRow,
} from '@/lib/domain/accounting/ledger-standing'
import type { Prisma } from '@/app/generated/prisma/client'

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

// ---------------------------------------------------------------------------
// o3d-3la07 (M5/M6, D3) - WHAT THE UNEARNED-REVENUE NETTING RESTS ON, REPORT-ONLY.
//
// `sumPostedUnearnedReversal` nets the debit of an order's PENDING / PROCESSING / SYNCED
// UNEARNED_REV_REVERSAL rows out of the deferral the true-up recognises. Two of the rows that decision
// rests on are not ledger facts:
//
//   * a SYNCED row an OPERATOR settled as posted (ASSERTED_POSTED) is COUNTED, on its queued payload;
//   * a CANCELLED row that may have reached the ledger (ASSERTED_NOT_POSTED, or a claimed attempt
//     cancelled with no proof) is NOT counted, though the reversal may exist.
//
// Batch 1 changes NO ARITHMETIC (D3: the hold-out design belongs to P2-7). This module's job is that
// the run SAYS it: one warning per order, naming the rows. `UNEARNED_REVERSAL_NETTING_WHERE` is the
// read width (the counted set plus the unproven cancelled rows) and `countedUnearnedReversalRows` is
// the counted set, derived from the module's own work-slot predicate so the netting is byte-for-byte
// what it was.
// ---------------------------------------------------------------------------

/** The rows to LOAD: the counted set (work-slot statuses) and the CANCELLED rows that may have posted. */
export const UNEARNED_REVERSAL_NETTING_WHERE: Prisma.AccountingSyncLogWhereInput = {
  OR: [WORK_SLOT_OCCUPIED_WHERE, UNPROVEN_CANCELLED_WHERE],
}

export type UnearnedReversalSyncRow = LedgerStandingRow & {
  id: string
  referenceType: string
  referenceId: string
  payload: unknown
}

/** The rows the netting COUNTS: exactly the PENDING / PROCESSING / SYNCED set it always summed. */
export function countedUnearnedReversalRows<T extends LedgerStandingRow>(rows: T[]): T[] {
  return rows.filter((row) => workSlotStanding(row).slot === 'OCCUPIED')
}

export type UnearnedReversalStandingReport = {
  /** Counted in the netting although an operator typed the document id (their figure is queued intent). */
  assertedCounted: string[]
  /** NOT counted although they may have reached the ledger (asserted NOT_POSTED / unproven CANCELLED). */
  mayHavePostedNotCounted: string[]
}

/** The rows an order's netting rests on that are not ledger facts. Empty when there are none. */
export function unearnedReversalStandingReport(rows: UnearnedReversalSyncRow[]): UnearnedReversalStandingReport {
  const counted = new Set(countedUnearnedReversalRows(rows).map((row) => row.id))
  const assertedCounted: string[] = []
  const mayHavePostedNotCounted: string[] = []
  for (const row of rows) {
    const standing = ledgerStanding(row)
    if (counted.has(row.id)) {
      if (standing === 'ASSERTED_POSTED') assertedCounted.push(row.id)
    } else if (standing !== 'PROVEN_NOT_POSTED') {
      mayHavePostedNotCounted.push(row.id)
    }
  }
  return { assertedCounted, mayHavePostedNotCounted }
}

/** The operator-facing sentence for one order, or null when its netting rests on ledger facts alone. */
export function describeUnearnedReversalReport(
  orderRef: string,
  report: UnearnedReversalStandingReport,
): string | null {
  if (report.assertedCounted.length === 0 && report.mayHavePostedNotCounted.length === 0) return null
  const parts: string[] = []
  if (report.assertedCounted.length > 0) {
    parts.push(`sync log(s) ${report.assertedCounted.join(', ')} were settled as posted by an OPERATOR and are COUNTED as unearned revenue already reversed on their queued figure, which was not verified against the ledger`)
  }
  if (report.mayHavePostedNotCounted.length > 0) {
    parts.push(`sync log(s) ${report.mayHavePostedNotCounted.join(', ')} are cancelled but may have reached the ledger and are NOT counted, so the true-up may recognise revenue a reversal already took out`)
  }
  return `Order ${orderRef}: the deferred-revenue true-up netted UNEARNED_REV_REVERSAL rows it cannot vouch for - ${parts.join('; ')}. The arithmetic is unchanged (report only); check the unearned revenue account for this order.`
}
