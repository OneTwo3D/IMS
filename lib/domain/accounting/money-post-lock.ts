/**
 * o3d-0m56 round 4, Codex CRITICAL #2 — serialize the LEDGER READ AND THE POST, not just the
 * writes around them.
 *
 * THE RACE THE FENCE DID NOT CLOSE. `authoriseMoneyPost` reads the ledger and then the caller
 * posts. Those are two statements with a network round trip between them, and nothing serialized
 * them against a competing row for the same document: two rows could each take that reading, each
 * see no settlement, and each post. `accounting_sync_logs_followup_live_unique` does not help —
 * it does not cover BILL_PAYMENT at all, and for the types it does cover it still permits a
 * FAILED row alongside a live one.
 *
 * WHY NOT `lockFollowUpScope`. That is `pg_advisory_xact_lock`, so it lives and dies with a
 * transaction, and no transaction may be held open across an HTTP call to Xero — Prisma's
 * interactive transactions time out in seconds, and a pooled connection parked on a remote round
 * trip is how a connection pool dies. It serializes the rows being CREATED and REVIVED. This
 * serializes the rows being SENT, and the two deliberately occupy different lock domains so that
 * an enqueue transaction never waits behind a payment's HTTP calls (see advisory-locks.ts).
 *
 * Built on `acquirePinnedAdvisoryLockOrNull` rather than on its own pool, because a session
 * advisory lock belongs to the connection that took it and every hazard that follows from that —
 * an unlock landing on a different pooled socket, an idle connection whose 'error' event has no
 * listener, a connection that died while the lock was assumed held — is already solved there.
 * The `lost` flag matters more here than anywhere else it is used: if the pinned connection dies
 * between the ledger read and the post, PostgreSQL has already freed the lock and another worker
 * may be posting to this document RIGHT NOW, so the post must not go out on a reading taken under
 * an exclusion that no longer exists. That is what `assertHeld` is for, and it is why `run`
 * receives the lock instead of a bare callback.
 *
 * REFUSES RATHER THAN WAITS. A caller that cannot get the lock does not queue behind the holder:
 * the holder is posting to this very document right now, and waiting only arrives at a ledger
 * read that will refuse. Refusing immediately returns the row to the normal retry path, where it
 * re-probes once the holder's payment is readable. It also means no transaction anywhere blocks
 * on this lock, so a holder that needs a pooled connection cannot deadlock against a queue of
 * waiters. A crashed holder releases automatically — PostgreSQL drops session advisory locks when
 * the connection closes — which is why this is a lock and not a lease row with an expiry to tune.
 *
 * SCOPE, and its residual: the same (connector, type, referenceType, referenceId) tuple the rest
 * of this design uses, so the population the lock serializes is exactly the population
 * `authoriseMoneyPost` judges as contenders. Two rows in DIFFERENT scopes naming the same external
 * document are serialized by neither — they are not contenders either, and closing that needs the
 * sibling query keyed on the document rather than the scope (tracked separately).
 */

import { ACCOUNTING_MONEY_POST_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockOrNull } from '@/lib/db/pinned-advisory-lock'
import { followUpScopeLockId, type FollowUpScope } from './followup-scope-lock'

/**
 * What `run` may ask the lock while it holds it.
 *
 * `assertHeld` is a check-then-act, and no check-then-act can be made atomic against a remote
 * call: the connection can die AFTER the assertion and DURING the POST (Codex round 5, finding
 * 2). `lost` is the other half — read it once the call has returned to find out whether the
 * exclusion survived the call, which is a question that can only be answered afterwards.
 */
export type HeldMoneyPostLock = {
  assertHeld: (context?: string) => void
  /** True once the pinned connection has failed — from that instant the lock is NOT held. */
  readonly lost: boolean
}

export type MoneyPostLockOutcome<T> = { locked: true; result: T } | { locked: false }

export type MoneyPostLock = <T>(
  scope: FollowUpScope,
  run: (lock: HeldMoneyPostLock) => Promise<T>,
) => Promise<MoneyPostLockOutcome<T>>

/**
 * Run `run` holding this document's money-post lock, or report that another worker holds it.
 *
 * Everything that decides whether money may move — the attempt stamp, the sibling read, the
 * ledger probe — and the post itself must be INSIDE `run`. Anything left outside is back in the
 * window this exists to close.
 */
export const withMoneyPostLock: MoneyPostLock = async (scope, run) => {
  const lock = await acquirePinnedAdvisoryLockOrNull(
    followUpScopeLockId(scope),
    ACCOUNTING_MONEY_POST_LOCK_NAMESPACE,
  )
  if (!lock) return { locked: false }
  try {
    return { locked: true, result: await run(lock) }
  } finally {
    await lock.release()
  }
}
