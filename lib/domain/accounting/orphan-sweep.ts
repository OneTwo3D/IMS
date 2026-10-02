import type { Prisma } from '@/app/generated/prisma/client'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'

/**
 * o3d-f709 (Codex round 2 HIGH 1) - THE CROSS-CONNECTOR ORPHAN SWEEP'S CANCELLING UPDATES, and the one
 * place that decides which of them may carry the pre-call proof.
 *
 * `status = PENDING` is NOT proof a row was never claimed. A CLAIMED row can be returned to PENDING after
 * a failed remote call (`applyMainSyncFailureRetry` keeps the attempt revision and writes no id), and a
 * posted row put back to PENDING keeps the id the ledger issued. So `abandonedBeforeRemoteCall: true` is
 * written ONLY over a PENDING row at `attemptRevision` 0 with no external id - the row's own claim
 * evidence, in the SAME predicate as the cancelling UPDATE (a claim mints revision >= 1, so a claim that
 * lands between the two statements moves the row out of the first and into the second). Every other
 * PENDING row is still retired - it is an orphan either way - but UNSTAMPED, i.e. UNKNOWN to
 * `ledgerStanding`: it may have posted, so nothing may read it as proof of absence or free a same-key
 * retry on it.
 *
 * Lives under lib/ (not in the 'use server' action) so it is testable and exports no non-async value
 * from a server-action file.
 */
export async function cancelOrphanedPendingRows(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  scope: Prisma.AccountingSyncLogWhereInput,
  reason: string,
): Promise<number> {
  // audit-46ry: CANCELLED (not FAILED) so these abandoned rows are excluded from FAILED-scanning
  // reconciliation/backfill sweeps and error dashboards.
  const neverClaimed = await tx.accountingSyncLog.updateMany({
    where: {
      AND: [scope, { status: 'PENDING' }, { attemptRevision: UNCLAIMED_ATTEMPT_REVISION }, { externalTransactionId: null }],
    },
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null, abandonedBeforeRemoteCall: true },
  })
  const claimedOrPosted = await tx.accountingSyncLog.updateMany({
    where: { AND: [scope, { status: 'PENDING' }] },
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null },
  })
  return neverClaimed.count + claimedOrPosted.count
}
