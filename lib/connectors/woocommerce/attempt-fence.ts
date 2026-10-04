/**
 * THE FENCE AROUND ONE ORDER-COMPLETION ATTEMPT (o3d-zvec.15, round 3).
 *
 * A worker holds no database lock while it talks to WooCommerce. `parkStaleWcOrderCompletionClaims` treats a
 * PROCESSING row whose lock is older than the drain lease as a DEAD worker and hands it to an operator, whose
 * Replay starts a second attempt. That is only safe if a worker older than the lease cannot still be alive and
 * about to write. So the WORKER is fenced, instead of the park modelling "maybe it is slow":
 *
 *   1. DEADLINE. Every attempt runs inside `runWithWcAttemptFence`, whose signal fires after
 *      `WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS`. `wcFetch` / `wcPost` / `wcPut` (api.ts) fold the ambient signal
 *      into their per-request signal, so the tracking push, the status GET and the status PUT are ALL aborted at
 *      the deadline — no request outlives it, in flight or not yet started.
 *   2. LEASE >> DEADLINE, BY CONSTRUCTION: the drain lease is 10 minutes and the deadline 2 minutes, asserted in
 *      tests/wc-completion-attempt-fence.test.ts. A claim older than the lease therefore means the worker is
 *      dead or has been aborted, which is what makes park + Replay safe.
 *   3. PRE-WRITE CHECK. Immediately before the status PUT the connector calls `assertWcAttemptMayWrite`, which
 *      refuses if the deadline has passed OR the worker no longer owns its outbox row (a quick read of the row
 *      against the lock token the claim took). The second condition catches a park + Replay that happened
 *      while this worker was paused inside a request, before the deadline had fired.
 *
 * What it does not do: an HTTP request already ON THE WIRE when the deadline fires may still be executed by
 * WooCommerce. It can land at most one deadline after the attempt started, which is far inside the lease, so
 * it cannot overlap a Replay. The residual GET-then-PUT race with an operator edit is the accepted one.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Overall ceiling for ONE attempt (tracking + status GET + status PUT). Far below the 10 minute drain lease. */
export const WC_ORDER_COMPLETION_ATTEMPT_DEADLINE_MS = 120_000

export type WcAttemptFence = {
  signal: AbortSignal
  /** True while this worker still owns its outbox row (status PROCESSING under its own lock token). */
  stillOwned: () => Promise<boolean>
  /**
   * OPTIONAL (o3d-6ldlj): true while IMS still wants this write. A cancel or hold is an IMS decision an operator
   * can reverse (a hold released, say) while the attempt is inside a WooCommerce request, so the cancel/hold
   * runner re-reads the IMS order immediately before the PUT as well as at the start of the attempt. Absent for
   * the completion job, whose rule is the WooCommerce reading alone.
   */
  stillWanted?: () => Promise<boolean>
}

const storage = new AsyncLocalStorage<WcAttemptFence>()

export function runWithWcAttemptFence<T>(fence: WcAttemptFence, fn: () => Promise<T>): Promise<T> {
  return storage.run(fence, fn)
}

/** The ambient attempt signal, if a completion attempt is running. */
export function currentWcAttemptSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal
}

/**
 * Throws unless the running attempt may still write. A no-op outside a completion attempt (every other
 * caller of the status push is unaffected).
 */
export async function assertWcAttemptMayWrite(): Promise<void> {
  const fence = storage.getStore()
  if (!fence) return
  if (fence.signal.aborted) {
    throw new Error('the attempt deadline passed before the status write, so it was not sent')
  }
  if (!(await fence.stillOwned())) {
    throw new Error('this worker no longer owns the completion job (it was parked or replayed), so the status write was not sent')
  }
  if (fence.stillWanted && !(await fence.stillWanted())) {
    throw new Error('the IMS order is no longer in the status being pushed, so the status write was not sent')
  }
  // The ownership read takes time of its own.
  if (fence.signal.aborted) {
    throw new Error('the attempt deadline passed before the status write, so it was not sent')
  }
}
