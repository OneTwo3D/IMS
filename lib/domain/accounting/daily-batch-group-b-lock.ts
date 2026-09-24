/**
 * o3d-c08y round 2 (Codex HIGH) — GROUP B MUST NOT COMPUTE FROM A SNAPSHOT IT READ BEFORE IT TOOK
 * THE LOCK.
 *
 * THE DEFECT, measured on a scratch database before this module existed (probe `.c08y2probe/race.ts`,
 * network trapped, own database `ims_scratch_c08y2p`): both daily batches loaded the whole shipment
 * window — including `shipment_lines.costLayerSnapshot` and `cogsBatchAmount` — and only THEN locked
 * the cost layers those snapshots reference. A landed-cost revaluation holding those layer locks
 * parked the batch at
 *
 *     SELECT id FROM "cost_layers" WHERE id IN ($1) FOR UPDATE      <- observed in pg_stat_activity
 *
 * committed a NEGATIVE layer, snapshot and `cogsBatchAmount`, and the batch then resumed from its
 * stale positive copy: it posted `DAILY_BATCH_GROUP_B` with COGS £4.00, stamped `shipmentJournalDate`,
 * wrote `allocatedReliefAmount` 4.00 and a `DISPATCH` subledger row of 4.00, and set
 * `cogsBatchAmount` BACK to 4.00 over the revaluation's -6.00. `FOR UPDATE` re-reads the row it
 * locks, but Group B selects only `id`, so nothing it later computes with was refreshed. The
 * o3d-sidy negative-basis refusal never fired — it was handed the stale snapshot — and the recalc had
 * already subtracted the whole -10.00 delta from its own COGS journal as "shipment-owned". The
 * ledger, the COGS subledger, the cost layer and the shipment's own snapshot all disagreed, silently:
 * the exact class of divergence o3d-c08y exists to remove.
 *
 * THE SHAPE OF THE FIX: PROBE -> LOCK -> READ, which is the ordering Group A2 already uses
 * (`lockOrderAllocations` hands back "the record each one holds AS OF THE LOCK", o3d-0i5y r10). The
 * batch first reads ONLY the candidate ids, locks every cost layer any of their data references, and
 * then reads the data for real, under those locks. A revaluation is then serialized either way round:
 *
 *  - it committed BEFORE the lock  -> the real read sees the negative snapshot, and the o3d-sidy
 *    per-order refusal fires (nothing stamped, named in `result.errors` and in an ERROR activity
 *    entry, retried next run once the basis is corrected);
 *  - it starts AFTER the lock      -> it blocks on `cost_layers` until the batch commits, then sees a
 *    JOURNALED shipment and the o3d-c08y refusal fires.
 *
 * WHY RE-READING IS ENOUGH, rather than serializing the whole revaluation against the batch: the set
 * of cost layers a snapshot REFERENCES is stable under revaluation. `updateSnapshotsForCostLayerChange`
 * rewrites `unitCostBase` on entries that already name the layer; it never adds or removes an entry.
 * So the ids collected by the probe are still the right ids to lock a statement later, and the only
 * way a layer could escape the lock is a shipment or allocation row appearing after the probe — which
 * cannot happen for this window, because the real read is restricted to the probed shipment ids.
 * `assertGroupBSnapshotsWereLocked` asserts that closure on the data actually loaded instead of
 * leaving it as an argument in a comment.
 *
 * LOCK ORDER. `cost_layers` is taken first here and first in the revaluation (`tx.costLayer.update`
 * precedes its snapshot and allocation writes), so this does not introduce a cycle; the lock is taken
 * in one statement ordered by id so two batches cannot take the same rows in opposite orders.
 */

import { Prisma } from '@/app/generated/prisma/client'

import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'

type TxClient = Prisma.TransactionClient

/**
 * Group B's selection, in ONE place because the probe and the real read must agree on it exactly.
 * A shipment that stopped qualifying between the two — journaled by something else, unshipped, or
 * whose order was fully refunded — is dropped by the real read for free, which is the "revalidate
 * shipment status after acquiring the locks" half of the fix.
 */
export const DAILY_BATCH_GROUP_B_SHIPMENT_WHERE = {
  status: 'SHIPPED',
  shipmentJournalDate: null,
  order: {
    refundStatus: { not: 'FULL' },
    revenueDeferredDate: { not: null },
    inventoryAllocatedDate: { not: null },
  },
} as const satisfies Prisma.ShipmentWhereInput

/**
 * Raised when the loaded data references a cost layer the lock did not cover.
 *
 * It fails the WHOLE WINDOW rather than one order, because it means the lock set itself was wrong and
 * no order's figures in this run can be trusted; the Group B catch turns it into a named
 * `result.errors` entry, nothing is stamped, and the next run's probe sees whatever appeared and locks
 * it — so it cannot loop. It should be unreachable: the layer ids an entry names are stable under
 * revaluation, the real read is restricted to the probed shipments, and the daily-batch advisory lock
 * is shared with refund creation, so the four sources cannot grow underneath a run. It is here because
 * "should be unreachable" is exactly the kind of claim this issue exists to stop trusting.
 */
export class UnlockedCostLayerError extends Error {
  override readonly name = 'UnlockedCostLayerError'
  readonly costLayerIds: string[]

  constructor(where: string, costLayerIds: string[]) {
    super(
      `Group B: ${where} references cost layer(s) ${costLayerIds.join(', ')} that this batch did not lock, so a `
      + 'concurrent landed-cost revaluation could still change them under it. Refusing the window rather than '
      + 'computing COGS from a value that may already be stale (o3d-c08y).',
    )
    this.costLayerIds = costLayerIds
  }
}

function collectCostLayerIds(rows: Array<{ costLayerSnapshot: unknown }>, into: Set<string>): void {
  for (const row of rows) {
    for (const entry of parseCostLayerSnapshot(row.costLayerSnapshot)) into.add(entry.costLayerId)
  }
}

/**
 * Lock every cost layer the Group B window could compute from, and hand back exactly which ids were
 * locked so the caller can prove its later reads stayed inside that set.
 *
 * The id set is gathered from all four snapshot-bearing sources the batch reads for these orders —
 * the candidate shipments' own lines (handed in as the probe rows), the orders' allocations, the
 * orders' ALREADY-journaled shipment lines and their refund lines — because all four feed the values
 * Group B posts (the last two through `allocationAvailability` in the legacy consumption path).
 *
 * The candidates' snapshots come from the PROBE read, i.e. from before the lock. That is sound for the
 * ID SET and only for the id set: which layers an entry names is stable under revaluation, while the
 * `unitCostBase` it carries is exactly what is not. Nothing here returns those pre-lock values to the
 * caller — the caller re-reads them under the lock.
 */
export async function lockCostLayersForGroupBWindow(
  tx: TxClient,
  input: {
    /** The probe rows: the candidate shipments, with their line snapshots and nothing else. */
    candidates: Array<{ id: string; orderId: string; lines: Array<{ costLayerSnapshot: unknown }> }>
  },
): Promise<Set<string>> {
  const costLayerIds = new Set<string>()
  const orderIds = Array.from(new Set(input.candidates.map((candidate) => candidate.orderId)))
  for (const candidate of input.candidates) collectCostLayerIds(candidate.lines, costLayerIds)

  if (orderIds.length > 0) {
    // The SAME where-shapes Group B uses for these three reads, so the ids locked here and the rows
    // checked afterwards are the same population by construction.
    const [allocations, priorShipmentLines, refundLines] = await Promise.all([
      tx.orderAllocation.findMany({ where: { orderId: { in: orderIds } }, select: { costLayerSnapshot: true } }),
      tx.shipmentLine.findMany({
        where: { shipment: { orderId: { in: orderIds }, shipmentJournalDate: { not: null } } },
        select: { costLayerSnapshot: true },
      }),
      tx.salesOrderRefundLine.findMany({ where: { refund: { orderId: { in: orderIds } } }, select: { costLayerSnapshot: true } }),
    ])
    collectCostLayerIds(allocations, costLayerIds)
    collectCostLayerIds(priorShipmentLines, costLayerIds)
    collectCostLayerIds(refundLines, costLayerIds)
  }

  const ids = [...costLayerIds]
  if (ids.length > 0) {
    // ORDER BY id: one canonical order for this lock set, so two batches (or a batch and a sweep)
    // cannot take the same rows in opposite orders and deadlock.
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
    )
  }
  return costLayerIds
}

/**
 * THE CLOSURE CHECK: nothing Group B is about to compute from references a cost layer outside the
 * locked set. Throws `UnlockedCostLayerError`, which the Group B catch turns into a named
 * `result.errors` entry — the window is skipped and retried, never posted from an unlocked value.
 */
export function assertGroupBSnapshotsWereLocked(
  lockedCostLayerIds: ReadonlySet<string>,
  sources: Array<{ what: string; rows: Array<{ costLayerSnapshot: unknown }> }>,
): void {
  for (const source of sources) {
    const escaped = new Set<string>()
    const seen = new Set<string>()
    collectCostLayerIds(source.rows, seen)
    for (const id of seen) if (!lockedCostLayerIds.has(id)) escaped.add(id)
    if (escaped.size > 0) throw new UnlockedCostLayerError(source.what, [...escaped].sort())
  }
}
