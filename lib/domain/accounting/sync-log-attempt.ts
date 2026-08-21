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

/**
 * Apply an operator decision to ONE attempt of a sync row.
 *
 * `expectedAttemptRevision` / `expectedStatus` are what the operator was looking at when they
 * decided. The decision lands only if both are still current, and it bumps the revision as it
 * lands — which is what makes an in-flight worker's writeback CAS fail rather than silently undo it.
 *
 * On refusal the message states what moved and what the operator can do about it. It prescribes no
 * outcome for the document: this fence knows only that the row moved, never whether anything posted.
 *
 * Runs whatever client it is given — pass a transaction client to commit the decision atomically
 * with whatever else it records (audit rows, order state).
 */
export async function applyFencedAttemptDecision(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: {
    id: string
    expectedAttemptRevision: number
    expectedStatus: AccountingSyncStatus
    /** The decision itself. `attemptRevision` is set by the fence and must not be passed. */
    data: Omit<Prisma.AccountingSyncLogUpdateManyMutationInput, 'attemptRevision'>
    /**
     * ADOPT a row that has never been fence-claimed, instead of refusing it (o3d-nf9i r3).
     *
     * Default false, and that default is the safe one: revision 0 means no attempt has ever been
     * identified, so a compare-and-swap on (id, status) is the exact defect this module exists to
     * remove — every path returns a row to a status it already held, so the decision can land on a
     * LATER attempt than the one that was judged.
     *
     * It is sound in ONE case, and the caller must have established it: NOTHING THAT PARTICIPATES IN
     * THE FENCE CAN EVER CLAIM THIS ROW — a row on a connector that is not the active one, which no
     * processor and no retry path touches. Such a row has exactly one attempt, ever, so there is no
     * later attempt for the decision to land on and status is a sufficient identity for it. Without
     * this door those rows are refused for ever, and the per-row remedy does not exist for the very
     * population it was built for.
     *
     * The adoption is still a CAS — (id, revision 0, expectedStatus) — so a second operator, or a
     * sweep that moves the status first, loses and is told which. It bumps to 1 exactly as a
     * processor's first claim would, so a connector that is later re-activated finds a fenced row
     * rather than an unfenced one.
     */
    adoptUnfencedAttempt?: boolean
  },
): Promise<AttemptDecisionOutcome> {
  if (params.expectedAttemptRevision === UNCLAIMED_ATTEMPT_REVISION && !params.adoptUnfencedAttempt) {
    return {
      ok: false,
      reason: 'UNFENCED_ATTEMPT',
      message: unfencedAttemptMessage(params.id, params.expectedStatus),
    }
  }

  const nextRevision = nextAttemptRevision(params.expectedAttemptRevision)
  const applied = await client.accountingSyncLog.updateMany({
    where: {
      id: params.id,
      attemptRevision: params.expectedAttemptRevision,
      status: params.expectedStatus,
    },
    data: { ...params.data, attemptRevision: nextRevision },
  })
  if (applied.count > 0) return { ok: true, attemptRevision: nextRevision }

  // Lost — read the row purely to say WHAT moved. The CAS above, not this read, decided the
  // outcome, so a further change between the two only makes the explanation slightly stale; it
  // cannot let a decision land on the wrong attempt.
  const current = await client.accountingSyncLog.findUnique({
    where: { id: params.id },
    select: { attemptRevision: true, status: true },
  })
  if (!current) {
    return {
      ok: false,
      reason: 'ROW_MISSING',
      message: `Accounting sync row ${params.id} no longer exists, so the decision was not recorded. `
        + 'Reload the sync log; if the row is gone, nothing on it can be settled.',
    }
  }
  // A row still at 0 after an ADOPTION lost its CAS did not lose it on the revision — the revision
  // is what the adoption expected. Reporting UNFENCED_ATTEMPT there would tell the operator the row
  // can never be settled, when in truth its STATUS moved and their remedy is to reload and look.
  if (current.attemptRevision === UNCLAIMED_ATTEMPT_REVISION && !params.adoptUnfencedAttempt) {
    return { ok: false, reason: 'UNFENCED_ATTEMPT', message: unfencedAttemptMessage(params.id, current.status) }
  }
  if (current.attemptRevision !== params.expectedAttemptRevision) {
    return {
      ok: false,
      reason: 'ATTEMPT_MOVED',
      message: `Accounting sync row ${params.id} has moved on to attempt ${current.attemptRevision}; the decision was `
        + `made about attempt ${params.expectedAttemptRevision}, so it was NOT recorded. Reload the sync log and judge `
        + 'the attempt shown there.',
    }
  }
  return {
    ok: false,
    reason: 'STATUS_MOVED',
    message: `Accounting sync row ${params.id} is now ${current.status}; the decision was made about a `
      + `${params.expectedStatus} row on the same attempt ${params.expectedAttemptRevision}, so it was NOT recorded. `
      + 'Reload the sync log and judge what it shows.',
  }
}

function unfencedAttemptMessage(id: string, status: AccountingSyncStatus | string): string {
  return `Accounting sync row ${id} (${status}) carries no attempt revision, so a decision cannot be tied to the `
    + 'attempt it was made about and was NOT recorded. Rows predating the attempt fence, and rows belonging to a '
    + 'connector whose processor does not stamp one, stay at revision 0 permanently. Reload the sync log: if it '
    + 'still shows no attempt, this row cannot be settled per-attempt.'
}
