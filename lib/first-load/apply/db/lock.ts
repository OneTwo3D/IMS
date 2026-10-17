/**
 * THE STEP LOCK: a session advisory lock per step, on a pinned connection.
 *
 * `pg_try_advisory_lock(FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE, n)` where n is the 1-based position of the step in the runner's load order. A transaction-scoped
 * lock cannot span a step (the importers commit row by row), so the lock lives on its own connection for the whole step and is verified on release.
 * The TRY form is deliberate: a second runner is told it is not alone and stops; it does not queue behind a load that may take minutes.
 *
 * ORDER. A runner holds at most one step lock at a time and takes them in load order, because the core runs the steps one after another and each
 * `withStepLock` returns (and releases) before the next starts. Two runners therefore never hold two locks each in opposite orders, and cannot deadlock.
 */
import { FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { db } from '@/lib/db'
import { AdvisoryLockLostError, acquirePinnedAdvisoryLockOrNull, type PinnedAdvisoryLock } from '@/lib/db/pinned-advisory-lock'
import { APPLY_STEP_IDS, type ApplyStepId } from '../constants'
import { StepLockError } from '../orchestrate'

/** The lock number of a step: its 1-based position in APPLY_STEP_IDS. */
export function stepLockNumber(step: ApplyStepId): number {
  return APPLY_STEP_IDS.indexOf(step) + 1
}

/** The lock this process holds for the step now running (one at a time, by construction). */
let current: { step: ApplyStepId; lock: PinnedAdvisoryLock } | null = null

/**
 * Called before EVERY bounded importer call: the step lock must still be ours. Two proofs, because a dead connection is only noticed by the
 * pinned client when the socket error arrives: the client's own flag, and the server's view (`pg_locks`: the lock is granted to the backend we
 * took it on). Anything else throws StepLockError('lost') and no further rows are written.
 *
 * RESIDUAL, stated plainly: this is a check BEFORE a call, not a fence inside the importer's own transactions. A call already in flight when the
 * lock is lost runs to its end (at most one bounded call: IMPORT_CALL_MAX_ROWS rows, or a whole products file).
 */
export async function assertStepLockLive(step: ApplyStepId): Promise<void> {
  if (current === null || current.step !== step) throw new StepLockError('lost')
  const { lock } = current
  try {
    lock.assertHeld(`an importer call of the ${step} step`)
  } catch {
    throw new StepLockError('lost')
  }
  if (lock.backendPid === null) throw new StepLockError('lost')
  let rows: Array<{ n: bigint }>
  try {
    rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = ${FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE}::oid AND objid = ${stepLockNumber(step)}::oid AND objsubid = 2 AND granted AND pid = ${lock.backendPid}`
  } catch {
    throw new StepLockError('unavailable')
  }
  if (Number(rows[0]?.n ?? 0) !== 1) throw new StepLockError('lost')
}

export async function withStepLock<T>(step: ApplyStepId, body: () => Promise<T>): Promise<T> {
  let lock
  try {
    lock = await acquirePinnedAdvisoryLockOrNull(stepLockNumber(step), FIRST_LOAD_APPLY_STEP_LOCK_NAMESPACE)
  } catch {
    throw new StepLockError('unavailable')
  }
  if (lock === null) throw new StepLockError('busy')
  current = { step, lock }
  try {
    lock.assertHeld(`the ${step} step`)
    const result = await body()
    // The exclusion is only as good as its connection: if it failed during the step, another runner may have started, and this step must not report success.
    lock.assertHeld(`finishing the ${step} step`)
    return result
  } catch (error) {
    if (error instanceof AdvisoryLockLostError) throw new StepLockError('lost')
    throw error
  } finally {
    current = null
    await lock.release()
  }
}
