import { Pool, type PoolClient } from 'pg'

/**
 * o3d-bjc.9: serialize the WMS dispatch sweep per connector.
 *
 * The sweep was always re-entrant-ish by accident — it re-reads its cursors each
 * run — but the unresolved-record streak made overlap consequential: each run
 * increments a link's consecutive-unresolved count once, so five runs
 * overlapping on ONE transient incident reach the quarantine cap in a single
 * real event and park the link until an operator replays it. The cap is meant
 * to mean "five passes apart", not "five callers at once".
 *
 * Skips rather than waits: the sweep runs on a short cadence, so a run that
 * cannot get the lock has nothing useful to add — the holder is doing that work
 * right now, and queueing would just stack cron invocations on a slow pass.
 *
 * CONNECTION-PINNED for the same reason the payment-write lock is: a PostgreSQL
 * session advisory lock lives on the connection that took it, and Prisma runs
 * each statement on an arbitrary pooled connection — so acquiring and releasing
 * through it can hit different sockets, the release silently no-ops, and the
 * lock leaks until that connection resets.
 */

export type DispatchLockSkipped = { lockSkipped: true }
export const DISPATCH_LOCK_SKIPPED: DispatchLockSkipped = { lockSkipped: true }

/** Namespace for pg_try_advisory_lock(key1, key2) — distinct from other locks. */
export { DISPATCH_SWEEP_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { DISPATCH_SWEEP_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

/**
 * Stable 32-bit key for a connector id. A hash rather than a registry so a new
 * connector cannot silently collide with an existing one by forgetting to add
 * itself — and signed, because pg advisory-lock keys are int4.
 */
export function dispatchSweepLockKey(connectorId: string): number {
  let hash = 0
  for (let i = 0; i < connectorId.length; i += 1) {
    hash = Math.imul(hash, 31) + connectorId.charCodeAt(i)
    hash |= 0
  }
  return hash
}

let lockPool: Pool | null = null
function getLockPool(): Pool {
  if (!lockPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is required for the dispatch-sweep lock')
    lockPool = new Pool({ connectionString, max: 2 })
  }
  return lockPool
}

/** Run `fn` holding the per-connector dispatch lock, or skip if another run holds it. */
export async function withDispatchSweepLockOrSkip<T>(
  connectorId: string,
  fn: () => Promise<T>,
): Promise<T | DispatchLockSkipped> {
  const key = dispatchSweepLockKey(connectorId)
  const client: PoolClient = await getLockPool().connect()
  let held = false
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [DISPATCH_SWEEP_LOCK_NAMESPACE, key],
    )
    if (!acquired.rows[0]?.locked) return DISPATCH_LOCK_SKIPPED
    held = true
    return await fn()
  } finally {
    let destroyed = false
    if (held) {
      try {
        const released = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [DISPATCH_SWEEP_LOCK_NAMESPACE, key],
        )
        if (!released.rows[0]?.unlocked) {
          // Returning a connection that still holds a session lock would wedge
          // every future sweep for this connector. Destroy it instead.
          console.error('[wms-dispatch-sweep] advisory unlock returned false — destroying the connection')
          client.release(true)
          destroyed = true
        }
      } catch (unlockError) {
        console.error('[wms-dispatch-sweep] advisory unlock failed — destroying the connection:', unlockError)
        client.release(true)
        destroyed = true
      }
    }
    if (!destroyed) client.release()
  }
}
