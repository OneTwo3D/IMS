/**
 * o3d-0m56 — serialize every writer that can put a money-moving row into one accounting scope.
 *
 * THE RACE. The manual retry reads a scope's siblings, decides the history is unambiguous, and
 * then resets the chosen row to PENDING. Those are two statements. Between them another writer
 * can queue a row for the same document under a FRESH token — the receipt-registration path does
 * exactly that — and that row can reach FAILED before the reset lands. FAILED rows are outside
 * `accounting_sync_logs_followup_live_unique`, so nothing objects, and the retry proceeds on a
 * snapshot that never showed the second token. Both can then post.
 *
 * No read-then-write closes that on its own: PostgreSQL has no predicate locks, so
 * `SELECT ... FOR UPDATE` locks the rows that exist and says nothing about the row about to be
 * inserted. The only thing that serializes an insert against a decision is a lock BOTH sides
 * take, which is what this is.
 *
 * SCOPE, precisely: keyed on (connector, type, referenceType, referenceId) — the same tuple the
 * partial unique index uses, the same one the retry plans against, and the same one the settlement
 * action's mirror-ownership read filters on. Two different documents never contend.
 *
 * WHICH TYPES PAY FOR IT (widened by o3d-11rf). Two kinds of writer need this scope serialised:
 *
 *  1. MONEY-MOVING types (o3d-0m56, above) — two live rows for one document are two payments.
 *  2. MIRRORED types (o3d-11rf) — every attempt at one document shares ONE logical accounting-event
 *     mirror, and `settleAccountingSyncRow` decides whether to VOID that mirror by READING the
 *     row's siblings. That read cannot be serialised against a sibling INSERT by any row lock, for
 *     the reason given above, so the settlement and the enqueue have to take this.
 *
 * WHAT THIS LOCK DOES NOT DO, stated because a reader took it for more (o3d-11rf r2, Codex HIGH).
 * It ORDERS the settlement and the enqueue. It does not make both orders correct, and only one of
 * them was: enqueue-then-settlement is safe because the settlement's sibling read now sees the live
 * row, while settlement-then-enqueue commits the shared event VOID and the enqueue that follows
 * collides with it. That half is closed on the ENQUEUE side, by
 * `reviveMirroredEventForNewAttempt`, on a basis recorded at void time. Serialisation is what makes
 * that revive well-defined — it is the reason the enqueue is looking at a settled decision rather
 * than at a half-made one — and it is not by itself the answer.
 *
 * The two sets are DISJOINT — no mirrored type is money-moving — so before o3d-11rf this lock was
 * taken for exactly no mirrored type. "Settlement takes the same lock the enqueue takes" would have
 * serialised nothing at all; widening the gate is what makes taking it mean something. Ordinary
 * queue traffic that is neither (PDFs, emails, attachments, storefront notes) still pays nothing.
 *
 * RESIDUAL, recorded rather than implied (o3d-rznn). Widening the gate makes the lock MEANINGFUL
 * for a type only where every writer in the scope takes it. The daily-batch enqueue
 * (`createPendingSyncLog` in both connectors' daily-sync.ts) creates a DAILY_BATCH_* row and its
 * mirror without taking this, because its transaction client is typed without `$executeRaw`. So for
 * `referenceType='DailyBatch'` the lock is currently taken by settlement alone. That is not a
 * regression — it is the pre-o3d-11rf state for those types, and the daily sync holds its own pinned
 * per-connector batch lock — but it is not yet serialisation, and o3d-rznn is where it is tracked.
 *
 * DERIVED, NOT RESTATED. The mirrored set is read from `isMirrorableAccountingSyncType` rather than
 * copied here, because a mirrored type added there and forgotten here would be a document whose
 * settlement and enqueue silently stop serialising — the o3d-11rf defect, reintroduced for one
 * type. followup-scope-lock.test.ts asserts the coverage over the exported list.
 *
 * LOCK ORDER. Enqueue writers take the sales-order/purchase row lock first and this second; the
 * retry takes ONLY this one, and one scope per transaction. There is therefore no pair of
 * transactions that can take two of these in opposite orders, so this cannot deadlock against
 * the accounting enqueue path.
 *
 * The residual, stated because it is a real if narrow one: a writer that updates an
 * AccountingSyncLog row for this scope BEFORE taking this lock could deadlock against a retry
 * that holds the lock and is updating the same row. Every writer here takes the lock first, so
 * the ordering is currently uniform — and if one ever does not, PostgreSQL aborts one side with a
 * deadlock error, which the retry surfaces as a failed action rather than resolving into a wrong
 * outcome. Adding a money-row writer means taking this lock before touching those rows.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { isMirrorableAccountingSyncType } from './mirrored-sync-types'
import { isMoneyMovingSyncType } from './followup-retry-guard'

export type FollowUpScope = {
  connector: string
  type: string
  referenceType: string
  referenceId: string
}

/**
 * Stable signed-int32 hash of a scope, for the second `pg_advisory_xact_lock` parameter.
 *
 * A collision costs two unrelated documents a little serialization and never costs correctness —
 * the lock is only ever used to make one scope's writers wait for each other.
 */
export function followUpScopeLockId(scope: FollowUpScope): number {
  const value = [scope.connector, scope.type, scope.referenceType, scope.referenceId].join(' ')
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * Does this type's scope need serialising at all? See the two groups in the module doc block.
 *
 * Exported so the coverage over the mirrored set can be asserted directly, and so a reader asking
 * "is my new type locked?" has one function to answer it rather than two sets to intersect.
 */
export function followUpScopeLockApplies(type: string): boolean {
  return isMoneyMovingSyncType(type) || isMirrorableAccountingSyncType(type)
}

/**
 * Take the scope lock for the rest of `tx`, if this type needs it.
 *
 * Held to COMMIT (`_xact_`), never released early: the point is that the decision and the write
 * that follows it are one indivisible step to every other writer.
 */
export async function lockFollowUpScope(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  scope: FollowUpScope,
): Promise<void> {
  if (!followUpScopeLockApplies(scope.type)) return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE}, ${followUpScopeLockId(scope)})`
}
