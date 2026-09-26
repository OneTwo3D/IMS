import type { Prisma } from '@/app/generated/prisma/client'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r24 (Codex round 23, HIGH) — THE REVISION OF THE ACTIVE HAND-POST CLAIM SET
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT r22 GOT WRONG, AND IT IS THE THIRD COSTUME OF ONE DEFECT. r19 found a cap hiding a claim; r20
 * answered with a walk; r21 found the walk's key was rewritable; r22 answered with the row's id — which IS
 * immutable and does close the re-take case. r22 then guarded the sentence "that is every active claim" with
 * a COUNT: the total as of the last page against how many rows had been shown. Round 23's counter-example:
 *
 *   51 active claims. Page one shows 50. Before page two, one operator TAKES a pre-existing refusal and
 *   another RELEASES a claim page one already showed. Page two returns the one remaining original claim, so
 *   the client has shown 51 and the total is 51 — and it prints completeness, while the newly held posting
 *   was never in the walk and goes on suppressing automatic posting. Two releases against one take give
 *   `shown > total`, which fell through to the same sentence.
 *
 * AND THE WINDOW IS WIDER THAN r22 SAID. r22 described "a claim taken mid-walk whose id sorts before the
 * cursor" as a tail the id's time-ordered prefix largely covered. It does not cover it at all: the walk's key
 * is the REFUSAL row's id, and TAKING A CLAIM CREATES NO ROW — it stamps `handPostClaimedAt` on a refusal
 * that may be months old. Every pre-existing refusal claimed mid-walk therefore sorts before the cursor.
 * That is the ordinary case whenever somebody takes a claim while a colleague is paging.
 *
 * SO IDENTITY COMPLETENESS IS NO LONGER INFERRED FROM A SIZE. This module is one counter that only goes UP,
 * bumped by every act that changes which postings are held by hand:
 *
 *   · `claimPostingForHandPosting`   a posting starts being held
 *   · `releasePostingHandPostClaim`  a posting stops being held
 *   · `markPostingHandled`           a posting stops being held (the mark clears the claim, on both exits)
 *
 * STRICTLY INCREASING, NOT NET. The defect being fixed is two changes CANCELLING, so anything that measures a
 * size or a balance reproduces it. A take plus a release is +2, never 0 — which is exactly why the reviewer's
 * scenario is now visible.
 *
 * TRANSACTIONAL, DELIBERATELY. The bump runs in the act's own transaction, under the posting key's advisory
 * lock the act already holds, so an act that rolls back does not move the revision. A PostgreSQL SEQUENCE
 * would have been cheaper and is NOT used for precisely that reason: `nextval` survives a rollback, and a
 * revision that moved for an act that never happened would make every walk in flight report itself
 * incomplete — a false alarm that teaches operators to ignore the one signal this round adds.
 *
 * THE CONTENTION IS IRRELEVANT AND THAT IS ARGUED, NOT ASSUMED. Every take/release/mark serialises on this
 * one row. All three are human acts on an exception queue, a handful a day, and NONE of them is on a posting
 * path: the enqueues READ the claim (`readPostingSuppression`) and never touch this table, so no shipment,
 * invoice or journal waits on it.
 */
export const HAND_POST_CLAIM_REVISION_ID = 'global'

export type HandPostClaimRevisionClient = {
  accountingHandPostClaimRevision?: {
    findUnique(args: { where: { id: string }; select: { revision: true } }): Promise<{ revision: bigint } | null>
    upsert(args: {
      where: { id: string }
      create: { id: string; revision: bigint }
      update: { revision: { increment: number } }
      select: { revision: true }
    }): Promise<{ revision: bigint }>
  }
}

/**
 * o3d-j625 r24 — WHY THE MEMBER ABOVE IS OPTIONAL, AND WHY THAT IS NOT A WAY TO FAIL OPEN.
 *
 * Same shape as r8's suppression read and r18's deferral write: the optionality exists for TEST DOUBLES that
 * implement only the delegates they are about. A real Prisma client always has it, and this type error fires
 * if that ever stops being true — so `'unavailable'` below stays a statement about doubles rather than a
 * route by which production stops recording that the claim set moved.
 */
type AssertTrue<T extends true> = T
export type PrismaClientCanAlwaysReachTheClaimRevision = AssertTrue<
  Prisma.TransactionClient extends {
    accountingHandPostClaimRevision: { findUnique: (args: never) => unknown; upsert: (args: never) => unknown }
  } ? true : false
>

/**
 * The revision as it stands. `0` when the row is missing, which is the same answer the migration's seeded row
 * gives before anything has ever been claimed — so no caller has to distinguish "never claimed" from "not
 * installed", and a walk that begins and ends before the first claim compares 0 with 0 and is complete.
 *
 * Read as a NUMBER: the column is BIGINT so that an overflow raises in the database rather than wrapping, and
 * the value is exact in a double up to 2^53, which at one act per second is 285 million years away. Returned
 * as a number because this crosses a server-action boundary, and a BigInt is not JSON-serialisable — a
 * detail that would otherwise be discovered in production rather than here.
 */
export async function readHandPostClaimRevision(client: HandPostClaimRevisionClient): Promise<number> {
  const table = client.accountingHandPostClaimRevision
  if (!table || typeof table.findUnique !== 'function') return 0
  const row = await table.findUnique({ where: { id: HAND_POST_CLAIM_REVISION_ID }, select: { revision: true } })
  return row ? Number(row.revision) : 0
}

/**
 * Record that the set of held postings CHANGED. Never told what changed or in which direction, because the
 * revision is not about the shape of the set — a walk only needs to know that it moved.
 *
 * Returns `'unavailable'` only for a client that cannot reach the table (a test double; see the type proof
 * above). Callers treat that as "not recorded" rather than as "nothing changed": it is not reachable from
 * production, and the acts that call this are already inside a transaction whose failure rolls them back.
 */
export async function bumpHandPostClaimRevision(
  client: HandPostClaimRevisionClient,
): Promise<{ revision: number } | 'unavailable'> {
  const table = client.accountingHandPostClaimRevision
  if (!table || typeof table.upsert !== 'function') return 'unavailable'
  // `increment`, not a read-then-write: two acts that commit in either order must both be counted, and a
  // read-modify-write would lose one of them — which is the cancelling failure this counter exists to catch,
  // reintroduced one level down.
  const row = await table.upsert({
    where: { id: HAND_POST_CLAIM_REVISION_ID },
    create: { id: HAND_POST_CLAIM_REVISION_ID, revision: BigInt(1) },
    update: { revision: { increment: 1 } },
    select: { revision: true },
  })
  return { revision: Number(row.revision) }
}
