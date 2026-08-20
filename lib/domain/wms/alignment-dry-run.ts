/**
 * q66in.7.4 — THE DRY RUN AN UNCONFIRMED ALIGNMENT BINDING IS WAITING ON.
 *
 * `confirmMintsoftAlignmentMode` refuses to arm live downward stock corrections unless a completed
 * dry run exists for the binding's warehouse. That job is therefore not history: it is the unmet
 * precondition of an outstanding operator decision, and deleting it silently revokes a confirmation
 * nobody has made yet.
 *
 * WHY THE QUERY LIVES HERE RATHER THAN IN EITHER CALLER. Retention has to protect EXACTLY the row
 * the confirm action would read. An earlier revision approximated it — "every STOCK_SYNC job for a
 * warehouse with an unconfirmed ALIGN_TO_WMS binding" — and called the imprecision "over-retains a
 * little". It does not: a stock sync writes one wms_sync_logs line per checked SKU per run and runs
 * on a schedule, so a single unconfirmed binding pinned EVERY run for that warehouse, and every line
 * of every run, for as long as the operator left the decision open. That is the highest-volume table
 * in this retention pass, exempted without limit by a condition nothing forces anyone to clear.
 *
 * What the confirm action actually reads is ONE row: the newest SUCCEEDED/PARTIAL, finished, dryRun
 * job for that warehouse. Retaining that row — and only that row — keeps the decision available and
 * bounds the exemption at one run per unconfirmed binding.
 *
 * The two callers share this query rather than restating it, because the failure mode of drift is
 * silent in both directions: a retention predicate that is narrower than the confirm predicate
 * deletes the evidence the operator is about to be asked for, and one that is wider re-opens the
 * unbounded exemption.
 */

import type { WmsSyncJobStatus } from '@/app/generated/prisma/client'

export type AlignmentDryRunScope = {
  connector: string
  warehouseId: string
}

/**
 * `findFirst` arguments selecting the dry-run job that would satisfy a confirmation for this scope.
 *
 * `orderBy` is part of the contract, not a detail: the row protected from retention must be the row
 * the confirm action would find, and with several qualifying runs that is decided by the ordering.
 */
export function alignmentDryRunEvidenceQuery(scope: AlignmentDryRunScope) {
  return {
    where: {
      connector: scope.connector,
      type: 'STOCK_SYNC' as const,
      warehouseId: scope.warehouseId,
      status: { in: ['SUCCEEDED', 'PARTIAL'] as WmsSyncJobStatus[] },
      finishedAt: { not: null },
      AND: [{ summary: { path: ['dryRun'], equals: true } }],
    },
    orderBy: [{ finishedAt: 'desc' as const }],
  }
}
