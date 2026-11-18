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
  /** The Mintsoft warehouse and connection the binding points at NOW. */
  externalWarehouseId: string
  connectionId: string
  /** When the binding was last re-pointed; the evidence must have started after it. */
  pairingChangedAt: Date
  /** Clock for the age limit; tests pass a fixed one. */
  now?: Date
}

/**
 * A dry run is evidence for a week. Stock moves on, so a dry run reviewed long ago says nothing about
 * what live corrections would write off today; an operator who waited longer runs a fresh one.
 */
export const ALIGNMENT_DRY_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Whether a binding save leaves the alignment confirmation intact. The confirmation was given for one
 * pairing AND one set of write-off thresholds: changing either re-arms the confirmation, so live
 * corrections stay off until it is typed again. `null` and "no thresholds" compare equal.
 */
export function alignmentConfirmationSurvivesSave(input: {
  wasAlignToWms: boolean
  willBeAlignToWms: boolean
  pointsAtSameTarget: boolean
  previousThresholds: unknown
  nextThresholds: unknown
}): boolean {
  if (!input.wasAlignToWms || !input.willBeAlignToWms || !input.pointsAtSameTarget) return false
  return stableJson(input.previousThresholds) === stableJson(input.nextThresholds)
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
      // Newer than the age limit: older evidence no longer counts.
      finishedAt: { not: null, gt: new Date((scope.now ?? new Date()).getTime() - ALIGNMENT_DRY_RUN_MAX_AGE_MS) },
      // Evidence belongs to ONE pairing: it must have started after the binding was last re-pointed
      // and must record the external warehouse and connection the binding points at now. Runs
      // recorded before the connection was stamped carry no connectionId and so never match.
      startedAt: { gt: scope.pairingChangedAt },
      AND: [
        { summary: { path: ['dryRun'], equals: true } },
        { summary: { path: ['externalWarehouseId'], equals: scope.externalWarehouseId } },
        { summary: { path: ['connectionId'], equals: scope.connectionId } },
      ],
    },
    orderBy: [{ finishedAt: 'desc' as const }],
  }
}
