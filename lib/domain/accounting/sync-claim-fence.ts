import type { Prisma } from '@/app/generated/prisma/client'
import type { AttemptRef } from '@/lib/domain/accounting/sync-log-attempt'
import { stampingCustodyOnClaim } from '@/lib/domain/accounting/money-attempt-provenance'

/**
 * A CLAIM THIS WORKER IS HOLDING RIGHT NOW — the thing every fence below is built from (o3d-550x).
 *
 * Deliberately an OBJECT WITH AN ACCESSOR rather than a `Date`, and that is the whole of Codex r2
 * medium 2. See {@link heldClaimWhere} for why a bare instant cannot express what the three branches
 * that import this helper each mean by "the claim I hold".
 *
 * The method name is `heldFrom` because that is the name the renewing sibling (o3d-batch-small2 /
 * o3d-xl63) already gives the accessor on its remote-write lease: that lease therefore SATISFIES this
 * interface structurally, with no adapter and no second concept — it is passed where a fixed claim
 * would be passed, and every fence below reads the instant it currently holds.
 */
export type HeldClaim = { heldFrom(): Date }

/**
 * The claim of a worker that never renews: one instant, taken when the row was claimed.
 *
 * For runners that take a claim at the top of a sweep and finish the entry inside it. It is a HOLDER
 * rather than the raw `Date` so that the call sites below do not have to change when a renewing lease
 * is introduced on the same row — the holder is swapped, not the six release sites.
 */
export function claimHeldFrom(instant: Date): HeldClaim {
  return { heldFrom: () => instant }
}

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
 * THE CLAIM INSTANT IS READ AT THE POINT OF USE — NOT CARRIED DOWN FROM THE TOP OF A SWEEP LOOP
 * (Codex r2, medium 2). Three branches import this one definition and they did NOT agree about what
 * a claim instant is:
 *
 *   • o3d-batch-payidx, o3d-batch-invnum and this branch CAPTURE it once, when the row is claimed,
 *     and never move it. For them the instant is a constant for the life of the entry.
 *   • o3d-batch-small2 (o3d-xl63) RENEWS it: `renewClaimForRemoteWrite` writes a fresh
 *     `processingStartedAt` before every remote mutation, so a long post cannot have its claim age
 *     out from under it while the request is on the wire.
 *
 * Those two conventions are not merely different, they are INCOMPATIBLE IN THE SAME PROCESS, and the
 * damage is silent. If a renewal moves the row to T1 and a release still fences on the captured T0,
 * the predicate matches NOTHING — and because these fences fail closed, a release that matches
 * nothing is not an error, it is a deferral that never happened, a backoff that never landed, a
 * failure that never spent a retry. The row simply sits in PROCESSING until it goes stale.
 *
 * THE VERDICT, AND IT IS NOT SYMMETRICAL: renewal is the convention that must survive. It is doing
 * something necessary — keeping a claim alive across a remote call whose duration nobody controls —
 * while "capture once" is only an implementation convenience of runners that happen to be quick.
 * So the fixed-instant branches are the ones that change, and this signature is how they change:
 * a claim is asked for its instant AT THE MOMENT OF THE WRITE, and a runner that never renews
 * expresses itself as {@link claimHeldFrom}, which answers the same instant every time.
 *
 * That is also why this takes `HeldClaim` and not `Date | HeldClaim`. Accepting a bare `Date` would
 * let every existing sibling call site keep compiling and keep failing closed in silence. Rejecting
 * it turns the merge hazard those branches recorded — "audit every consumer that carries a claim
 * instant down from a sweep loop" — from a note somebody has to remember into a compile error at
 * every one of those consumers.
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
export function heldClaimWhere(entryId: string, claim: HeldClaim) {
  return { id: entryId, status: 'PROCESSING' as const, processingStartedAt: claim.heldFrom() }
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
  claim: HeldClaim,
  release: { errorMessage: string; nextAttemptAt: Date },
  /**
   * o3d-e2mz: the ATTEMPT this release belongs to, where the caller minted one.
   *
   * The two fences answer different questions and neither implies the other. The held claim asks
   * "do I still own this row?" and stops a DISPLACED owner writing over its replacement. The attempt
   * revision asks "is this still the attempt I claimed?" and stops the release landing on a row an
   * OPERATOR has decided about — `applyFencedAttemptDecision` bumps the revision, and a decision that
   * leaves the row PROCESSING at the same claim instant is invisible to `heldClaimWhere` alone.
   *
   * Optional because not every caller of this release mints an attempt: the cancelled-order
   * retirement path fences on the claim only. Omitting it releases exactly as before.
   */
  attempt?: AttemptRef,
): Promise<boolean> {
  const released = await client.accountingSyncLog.updateMany({
    // The instant is read HERE, as the statement is built — so a claim that has been renewed since
    // the entry was picked up releases the row it actually holds (Codex r2, medium 2).
    where: {
      ...heldClaimWhere(entryId, claim),
      ...(attempt ? { attemptRevision: attempt.attemptRevision } : {}),
    },
    data: {
      status: 'PENDING',
      errorMessage: release.errorMessage,
      // A future `processingStartedAt` on a PENDING row is the existing retry gate: it is read as
      // "earliest next claim time", not as a claim.
      //
      // o3d-0m56 r10: AND IT KEEPS ATTEMPT-STAMPING CUSTODY, here rather than at the six call sites.
      // Re-gating a row is the same write as claiming it with a future instant, and the database's
      // forfeit trigger nulls `attemptStampingCustodyAt` on any claim-shaped UPDATE that does not
      // re-assert it in the same statement. Every deferral and every backoff is such a write, so
      // without this each one silently forfeits custody — and a row outside custody can never again
      // have its unset `remoteAttemptedAt` read as proof that no remote call left it, which is what
      // lets the planner recycle it. `stampingCustodyOnClaim` returns BOTH fields from ONE instant
      // so the pairing the trigger checks cannot be half-applied; spelling either out here would be
      // a second copy of that rule, and this is the one release every non-terminal path goes through.
      ...stampingCustodyOnClaim(release.nextAttemptAt),
    },
  })
  return released.count > 0
}
