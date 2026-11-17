import { type Pool, type PoolClient } from 'pg'

import { createSessionAdvisoryLockPool } from '@/lib/db/session-lock-pool'

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
import { DISPATCH_SWEEP_LOCK_NAMESPACE, MERGE_CANDIDATE_LOCK_NAMESPACE, ORDER_PUSH_SWEEP_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

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

/**
 * THE LOCK POOL IS BUILT BY `createSessionAdvisoryLockPool()` (o3d-2k5r r23 and r25, Codex HIGH;
 * o3d-a5zz).
 *
 * r23 stopped it being a `new Pool({ connectionString })` — a second, unguarded route into the
 * database inside a process whose Prisma pool is guarded, carrying no `search_path` pin and none of
 * the per-connection backend checks. r25 stopped `pgConnectionConfig()` alone being enough: that
 * config attaches its per-connection check only where the startup options carry a non-ASCII byte,
 * so on an ASCII schema this pool's connections were never shown to reach the backend DIRECTLY —
 * and a session advisory lock behind a transaction pooler excludes nothing (measured: Odyssey
 * 1.5.3-rc1, two clients both told `true` for the same key, neither actually holding it). The
 * affinity proof is now a property of the pool factory rather than of this call site; see
 * `lib/db/session-lock-pool.ts`.
 */
let lockPool: Pool | null = null
function getLockPool(): Pool {
  if (!lockPool) lockPool = createSessionAdvisoryLockPool('the WMS sweep locks', 4)
  return lockPool
}

/** Run `fn` holding the per-connector dispatch lock, or skip if another run holds it. */
export async function withDispatchSweepLockOrSkip<T>(
  connectorId: string,
  fn: () => Promise<T>,
): Promise<T | DispatchLockSkipped> {
  return withSweepLockOrSkip(DISPATCH_SWEEP_LOCK_NAMESPACE, connectorId, '[wms-dispatch-sweep]', fn)
}

/**
 * Run `fn` holding the per-connector ORDER-PUSH sweep lock, or skip if another push sweep holds it. The push sweep creates, holds,
 * releases, cancels and amends warehouse orders and posts notes; two overlapping runs could each act on the same link. Same
 * connection-pinned session lock as the dispatch sweep, in its own namespace so the two sweeps do not exclude each other.
 */
export async function withOrderPushSweepLockOrSkip<T>(
  connectorId: string,
  fn: () => Promise<T>,
): Promise<T | DispatchLockSkipped> {
  return withSweepLockOrSkip(ORDER_PUSH_SWEEP_LOCK_NAMESPACE, connectorId, '[wms-order-push]', fn)
}

/**
 * Run `fn` holding the per-connector MERGE-CANDIDATE lock, or skip if another detection pass holds it. The pass computes the groups, raises
 * a task per group and resolves every open task not among them: two overlapping passes that saw different groups would each resolve the
 * other's task. Skipping is safe (the next sweep runs it again). Its own namespace, so it never excludes a push or status sweep.
 */
export async function withMergeCandidateLockOrSkip<T>(
  connectorId: string,
  fn: () => Promise<T>,
): Promise<T | DispatchLockSkipped> {
  return withSweepLockOrSkip(MERGE_CANDIDATE_LOCK_NAMESPACE, connectorId, '[wms-merge-candidates]', fn)
}

async function withSweepLockOrSkip<T>(
  namespace: number,
  connectorId: string,
  logTag: string,
  fn: () => Promise<T>,
): Promise<T | DispatchLockSkipped> {
  const key = dispatchSweepLockKey(connectorId)
  const client: PoolClient = await getLockPool().connect()
  let held = false
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [namespace, key],
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
          [namespace, key],
        )
        if (!released.rows[0]?.unlocked) {
          // Returning a connection that still holds a session lock would wedge
          // every future sweep for this connector. Destroy it instead.
          console.error(`${logTag} advisory unlock returned false — destroying the connection`)
          client.release(true)
          destroyed = true
        }
      } catch (unlockError) {
        console.error(`${logTag} advisory unlock failed — destroying the connection:`, unlockError)
        client.release(true)
        destroyed = true
      }
    }
    if (!destroyed) client.release()
  }
}
