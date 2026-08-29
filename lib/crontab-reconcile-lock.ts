import { CRONTAB_RECONCILE_LOCK_KEY } from '@/lib/db/advisory-locks'
import {
  acquirePinnedAdvisoryLockWaiting,
  AdvisoryLockWaitTimeoutError,
} from '@/lib/db/pinned-advisory-lock'

/**
 * ONE CRONTAB RECONCILIATION AT A TIME, ACROSS PROCESSES (Codex r21 HIGH).
 *
 * WHAT WENT WRONG WITHOUT IT. `reconcileCrontab` snapshots the `cron_*` settings, then separately
 * reads and rewrites the OS crontab. Six server actions call it, every one of them AFTER its own
 * commit. Two overlapping saves therefore interleaved like this:
 *
 *   A (Backup screen)          B (Scheduled Jobs screen)
 *   commit: backups OFF
 *   snapshot -> OFF
 *                              commit: backups ON
 *                              snapshot -> ON
 *                              write crontab: line INSTALLED
 *   write crontab: line REMOVED     <- from a snapshot taken before B committed
 *
 * Both actions return `saved`. The database, the route and the page all say backups are enabled,
 * and no scheduled invocation exists — the exact end state the previous round's post-commit fix
 * removed by one route and this reaches by another. Nothing detects it, because a crontab carries
 * no version to compare against, and the inverse interleaving leaves a line nothing will honour.
 *
 * WHY THE LOCK MUST COVER THE SNAPSHOT. Serializing only the crontab write is not enough: A would
 * still hold a reading taken before B committed, still write last, and still win. The lock is held
 * across snapshot -> read crontab -> write crontab, which makes the reconciliation a
 * read-modify-write of one shared artefact and gives the two orders the same answer:
 *
 *   • B waits for A. A's write is stale, B then re-reads the committed state and writes ON. Correct.
 *   • A waits for B. B writes ON, A then re-reads — and reads B's committed ON, not its own stale
 *     snapshot — and writes ON. Correct, because the snapshot is inside the lock.
 *
 * That second line is the whole reason the snapshot is in here rather than at the call sites.
 *
 * WHY IT WAITS INSTEAD OF SKIPPING. `acquirePinnedAdvisoryLockOrNull` — the primitive the daily
 * batches and the money post use — answers contention by not running. That is right for a poll that
 * comes back round, and wrong here: the state is already committed and this is the only thing that
 * will ever apply it, so a skip is the disagreement itself. The wait is bounded (see below) because
 * an unbounded one inside a server action is its own outage.
 *
 * WHY A SESSION ADVISORY LOCK IS ACCEPTABLE HERE, given o3d-ic9a. A session lock dies with its
 * connection, so a mid-run connection failure can let a second reconciliation start. That is a
 * genuine caveat and it is a DIFFERENT RISK CLASS from the money-post lock it is shared with: what
 * escapes here is a redundant rewrite of a file that is derived, idempotent and re-derivable — the
 * next save, or Settings -> System -> Scheduler -> Save & Apply, produces the correct crontab from
 * the committed rows. Nothing irreversible has left the building, no money has moved, and no
 * external system has been told anything. We do not pretend the window is closed either: `lost` is
 * READ immediately before the crontab write, so a reconciliation whose connection died reports
 * "the scheduler is behind" — a sentence every caller already knows how to show — rather than
 * writing under an exclusion it no longer has. It is read rather than asserted-and-thrown because
 * every caller's contract is an outcome, not an exception.
 *
 * NOT A SECOND LOCKING MECHANISM. Everything about holding a session lock safely — the pinned
 * connection, the idle-error listener, the `lost` flag, the verified release — already exists in
 * lib/db/pinned-advisory-lock.ts and is reused; the only thing added there is the bounded WAIT,
 * next to the try form, on the same pool.
 */

/**
 * How long a queued reconciliation waits before giving up.
 *
 * Sized from the critical section it queues behind, not picked round: the holder runs two
 * `execFile` calls with a 5s timeout each (`crontab -l`, `crontab -`) plus a handful of local
 * queries, so a legitimate queue clears in well under this and a wait that expires means the
 * holder is wedged rather than busy.
 */
export const CRONTAB_RECONCILE_LOCK_WAIT_MS = 20_000

/**
 * What the reconciliation may ask the lock while it holds it.
 *
 * A structural subset of `PinnedAdvisoryLock`, so the real handle satisfies it: `lost` is the only
 * question this critical section has, and it is asked once, just before the write.
 */
export type HeldCrontabReconcileLock = {
  /** True once the pinned connection has failed — from that instant the exclusion is GONE. */
  readonly lost: boolean
}

export type CrontabReconcileLockOutcome<T> =
  | { locked: true; result: T }
  | { locked: false; error: string }

/**
 * Run `run` holding the crontab reconciliation lock.
 *
 * A failure to take the lock is RETURNED, not thrown: every caller of the reconciliation is a
 * post-commit step whose contract is an outcome, and "the crontab may now be behind" is one of the
 * outcomes it already renders. A throw from `run` itself propagates untouched — a framework signal
 * raised inside the critical section must not be turned into a scheduler warning.
 */
export async function withCrontabReconcileLock<T>(
  run: (lock: HeldCrontabReconcileLock) => Promise<T>,
): Promise<CrontabReconcileLockOutcome<T>> {
  let lock
  try {
    lock = await acquirePinnedAdvisoryLockWaiting(CRONTAB_RECONCILE_LOCK_KEY, {
      timeoutMs: CRONTAB_RECONCILE_LOCK_WAIT_MS,
    })
  } catch (error) {
    if (error instanceof AdvisoryLockWaitTimeoutError) {
      return {
        locked: false,
        error: 'Another crontab reconciliation is still running, so this one was not applied. '
          + 'Re-apply from Settings -> System -> Scheduler once it has finished.',
      }
    }
    return {
      locked: false,
      error: `Could not serialize the crontab reconciliation: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    return { locked: true, result: await run(lock) }
  } finally {
    await lock.release()
  }
}
