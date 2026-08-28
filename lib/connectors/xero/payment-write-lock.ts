import { type Pool, type PoolClient } from 'pg'

import { createSessionAdvisoryLockPool } from '@/lib/db/session-lock-pool'

/**
 * Serializes the two jobs that write `paidAt` from Xero — the 15-minute payment poll and the daily
 * backlog reconcile — so neither can act on a Xero read the other has already invalidated (o3d-2s8,
 * Codex review of #496).
 *
 * The race it closes: reconcile reads an invoice PAID; Xero reverses it; the poll fetches that
 * reversal but, finding `paidAt` still null, its reversal pass does nothing and advances its cursor;
 * reconcile then writes `paidAt` on the now-reversed invoice, permanently. Holding this lock across
 * each job's whole read→write means they cannot interleave.
 *
 * CONNECTION-PINNED, unlike a Prisma $executeRaw pair. A PostgreSQL session advisory lock lives on
 * the connection that took it; the app's Prisma client runs each statement on an arbitrary pooled
 * connection, so acquiring and releasing through it can hit DIFFERENT sockets — the release then
 * silently no-ops and the lock leaks until that connection resets, wedging every future poll. So this
 * checks out ONE dedicated client and does acquire → run → release all on it, and verifies the
 * release actually happened (Codex review of #496, round 3).
 */
export { PAYMENT_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { PAYMENT_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'

export type LockSkipped = { lockSkipped: true }
export const LOCK_SKIPPED: LockSkipped = { lockSkipped: true }

// A tiny dedicated pool, separate from Prisma's, used ONLY to hold advisory locks on a stable
// connection. Advisory locks are database-global, so the lock a connection here holds is visible to
// every other session — it does not need to be the connection the writes happen on, only a stable
// one held for the lock's lifetime. Lazily created; a handful of connections is plenty for two
// low-frequency jobs.
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
  if (!lockPool) lockPool = createSessionAdvisoryLockPool('the payment-write lock', 4)
  return lockPool
}

/**
 * Run `fn` holding the payment-write lock. If another payment-writing job holds it, DO NOT wait —
 * return LOCK_SKIPPED so the caller can defer to its next cycle. Acquire, run and release all happen
 * on ONE pinned connection, which is then returned to the pool.
 */
export async function withPaymentWriteLockOrSkip<T>(fn: () => Promise<T>): Promise<T | LockSkipped> {
  const client: PoolClient = await getLockPool().connect()
  let held = false
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [PAYMENT_WRITE_LOCK_KEY],
    )
    if (!acquired.rows[0]?.locked) return LOCK_SKIPPED
    held = true
    return await fn()
  } finally {
    // The connection MUST always go back — and if we cannot cleanly release the lock, it must be
    // DESTROYED, not returned to the pool still holding a session-level advisory lock (that would
    // wedge every future poll indefinitely). A thrown unlock must not skip the release either, so the
    // release lives in its own path guarded by `destroyed` (Codex review #496 round 6).
    let destroyed = false
    if (held) {
      try {
        const released = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1) AS unlocked',
          [PAYMENT_WRITE_LOCK_KEY],
        )
        if (!released.rows[0]?.unlocked) {
          console.error('[payment-write-lock] advisory unlock returned false — destroying the connection to force release')
          client.release(true)
          destroyed = true
        }
      } catch (e) {
        console.error('[payment-write-lock] advisory unlock threw — destroying the connection to force release', e)
        client.release(true) // destroying the physical connection makes PostgreSQL drop its session locks
        destroyed = true
      }
    }
    if (!destroyed) client.release()
  }
}

export function isLockSkipped(v: unknown): v is LockSkipped {
  return typeof v === 'object' && v !== null && (v as LockSkipped).lockSkipped === true
}
