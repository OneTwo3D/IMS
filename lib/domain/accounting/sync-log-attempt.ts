/**
 * o3d-e2mz — the per-attempt fence for AccountingSyncLog.
 *
 * An operator decision recorded against "the current state" of a sync row could not be tied to the
 * attempt it was made about, because nothing on the row identified an attempt:
 *
 *   • status is not an identity — every path returns a row to a status it already held.
 *     `retryFailedXeroSync` drives FAILED -> PENDING -> FAILED; the stale-claim reclaim drives
 *     PROCESSING -> PROCESSING. A compare-and-swap on (id, status) can therefore match a LATER
 *     attempt than the one the operator judged.
 *   • retryCount is not monotonic — `retryFailedXeroSync` resets it to 0.
 *   • processingStartedAt is a timestamp, not a token: it says when a claim was taken, not which.
 *
 * `AccountingSyncLog.attemptRevision` is that identity. The processor bumps it when it claims the
 * row, and compare-and-swaps its writeback on the value it claimed. An operator decision names the
 * revision it was taken about and bumps it too. So whichever of the two lands second LOSES its CAS
 * and finds out — instead of silently overwriting the other:
 *
 *   • worker fails after a settlement landed  -> the failure write no-ops, the settlement stands
 *     (today `applyMainSyncFailureRetry` keys only on (id, retryCount) and would revive a settled
 *     row straight back to PENDING/FAILED);
 *   • worker posts after a NOT-POSTED settlement -> the post write no-ops, and the connector
 *     escalates with the external id instead of quietly stamping SYNCED over the decision;
 *   • settlement arrives after the attempt moved -> refused, naming both revisions.
 *
 * This module holds the fence itself so every caller uses one implementation, and so the refusal
 * reasons are a single vocabulary rather than per-call-site prose.
 */

import type { AccountingSyncStatus, Prisma } from '@/app/generated/prisma/client'

/**
 * The revision a row carries before any fence-aware processor has claimed it. The claim bump makes
 * the FIRST attempt 1, so 0 never identifies a real attempt — it means "nothing that stamps an
 * attempt revision has ever claimed this row". That is true of every row written before this column
 * existed, and of every row belonging to a connector whose processor does not stamp it.
 */
export const UNCLAIMED_ATTEMPT_REVISION = 0

/**
 * A row AT one specific attempt: the id, plus the revision that attempt is (or was) identified by.
 * A worker builds one from its own claim; a read-modify-write builds one from what it read.
 */
export type AttemptRef = {
  id: string
  attemptRevision: number
}

/** The revision a claim taken against `observedAttemptRevision` must write. */
export function nextAttemptRevision(observedAttemptRevision: number): number {
  return observedAttemptRevision + 1
}

/**
 * The `where` a claim must use: the row, at the exact revision that was read. Combined with
 * `attemptRevision: nextAttemptRevision(observed)` in the data, the claim is itself a CAS, so two
 * workers reading the same row can never both believe they hold it.
 */
export function claimAttemptWhere<T extends Record<string, unknown>>(
  base: T,
  observedAttemptRevision: number,
): T & { attemptRevision: number } {
  return { ...base, attemptRevision: observedAttemptRevision }
}

/**
 * Write to a row ONLY while it is still at the attempt revision the caller is acting on. Returns
 * false when the attempt has moved (another claim, or an operator decision) — the caller must then
 * treat its own result as un-recorded and say so, never retry the write unfenced.
 */
export async function updateAtAttemptRevision(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  attempt: AttemptRef,
  data: Prisma.AccountingSyncLogUpdateManyMutationInput,
): Promise<boolean> {
  const updated = await client.accountingSyncLog.updateMany({
    where: { id: attempt.id, attemptRevision: attempt.attemptRevision },
    data,
  })
  return updated.count > 0
}

export type AttemptFenceRefusalReason =
  /** No such row — retention deleted it, or the id is stale. */
  | 'ROW_MISSING'
  /** The row has never been claimed under the fence, so no attempt can be named. */
  | 'UNFENCED_ATTEMPT'
  /** A different attempt is current now than the one the decision was made about. */
  | 'ATTEMPT_MOVED'
  /** Same attempt, different status — the attempt reached an outcome after the decision was formed. */
  | 'STATUS_MOVED'

export type AttemptDecisionOutcome =
  | { ok: true; attemptRevision: number }
  | { ok: false; reason: AttemptFenceRefusalReason; message: string }

// applyFencedAttemptDecision lives in sync-log-attempt-decision.ts: it locks and recomputes the order's invoicing state, which is server code, and this module must
// stay client-safe (the sync dashboard imports its pure parts through sync-row-settlement).
