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
 * partial unique index uses, and the same one the retry plans against. Two different documents
 * never contend. Taken ONLY for money-moving types, so the ordinary queue traffic (invoices,
 * journals, PDFs, emails) is untouched and pays nothing for it.
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
 * Take the scope lock for the rest of `tx`, if this type needs it.
 *
 * Held to COMMIT (`_xact_`), never released early: the point is that the decision and the write
 * that follows it are one indivisible step to every other writer.
 */
export async function lockFollowUpScope(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  scope: FollowUpScope,
): Promise<void> {
  if (!isMoneyMovingSyncType(scope.type)) return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE}, ${followUpScopeLockId(scope)})`
}
