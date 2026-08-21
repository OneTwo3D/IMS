import type { Prisma } from '@/app/generated/prisma/client'

/**
 * "I STILL OWN THIS ROW" — the where-fence every RELEASE of an AccountingSyncLog claim must carry
 * (o3d-550x).
 *
 * A claim is `{ status: PROCESSING, processingStartedAt: <the instant I stamped> }`, and the stale
 * cutoff the claim predicate uses lets a NEW worker re-take a row whose claim has aged out. Nothing
 * stops the OLD worker: a timeout cannot reach into a request already on the wire, so it comes back
 * later and writes. The `{ id, retryCount }` guard those writers carried does not stop it either —
 * A RE-CLAIM DOES NOT ADVANCE retryCount (the claim write sets status and the claim instant only),
 * so the displaced owner's predicate still matches and its update lands: the replacement's PROCESSING
 * claim is erased and the row drops back to PENDING/FAILED WHILE THE REPLACEMENT'S REQUEST IS STILL
 * ON THE WIRE. The row then looks idle, is re-claimed a third time, and a second document posts for
 * the same reference.
 *
 * Matching on the claim INSTANT rather than on `status: 'PROCESSING'` alone is the point: the
 * replacement's row is PROCESSING too. Only the worker that stamped that exact timestamp owns it.
 *
 * THE CLAIM INSTANT IS CAPTURED ONCE AND NEVER MOVED. Every caller stamps `claimedAt` at the moment
 * it takes the row and carries that same value to every release. A writer that RENEWED the claim by
 * moving `processingStartedAt` forward mid-work would invalidate every `claimedAt` its own callers
 * still hold, and because this fence fails closed the result is silent refusal of legitimate work
 * rather than a visible error. If a renewing lease is ever wanted it needs a separate token column,
 * not this one.
 *
 * WHY IT LIVES HERE AND NOT IN A CONNECTOR. Two modules release these claims — the Xero sync
 * processor and the cancelled-order invoice retirement — and a second, hand-spelt copy of the
 * predicate is a second DEFINITION OF OWNERSHIP that can silently drift from this one (Codex r1,
 * medium 1). One function, imported by both, so "who owns this row" has exactly one answer.
 *
 * WHAT THIS FENCE IS DELIBERATELY NOT PUT ON: the write that RECORDS A POSTED DOCUMENT. A displaced
 * owner that really posted must still be able to record its external id, or the document becomes
 * untracked — evidence of a post must never be conditional on winning a race. That write is
 * protected differently, by its own precondition: the row must not already name a DIFFERENT document.
 */
export function heldClaimWhere(entryId: string, claimedAt: Date) {
  return { id: entryId, status: 'PROCESSING' as const, processingStartedAt: claimedAt }
}

/**
 * THE ONE NON-TERMINAL RELEASE of an AccountingSyncLog claim (o3d-550x, Codex r1 medium 2).
 *
 * Deferrals (payment ordering, invoice UPDATE-before-CREATE) and rate-limit backoff all do the
 * identical thing: hand the row back to PENDING with a future `processingStartedAt` acting as the
 * earliest-next-claim gate, and say why. Six copies of that statement were spelt out inline across
 * the two runners, each carrying its own `where`. Six copies is six chances for one of them to be
 * written without the fence — and the structural test that was supposed to catch that could be
 * satisfied by a single `heldClaimWhere` mention anywhere in the runner.
 *
 * So the statement is ONE function and the fence is part of it, not part of the call site. There is
 * no way to reach this write without the claim predicate, and a behavioural test of THIS covers
 * every deferral and every backoff in both runners at once.
 *
 * Returns whether the release landed. `false` means a displaced owner tried to give back a claim it
 * no longer holds — the correct outcome is that nothing happened, and the caller may say so.
 *
 * NOT for terminal transitions. FAILED/CANCELLED/SYNCED each carry extra preconditions of their own
 * (the retryCount compare-and-set, `externalTransactionId: null`, the different-document refusal) and
 * must keep them.
 */
export async function releaseClaimForRetry(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entryId: string,
  claimedAt: Date,
  release: { errorMessage: string; nextAttemptAt: Date },
): Promise<boolean> {
  const released = await client.accountingSyncLog.updateMany({
    where: heldClaimWhere(entryId, claimedAt),
    data: {
      status: 'PENDING',
      errorMessage: release.errorMessage,
      // A future `processingStartedAt` on a PENDING row is the existing retry gate: it is read as
      // "earliest next claim time", not as a claim.
      processingStartedAt: release.nextAttemptAt,
    },
  })
  return released.count > 0
}
