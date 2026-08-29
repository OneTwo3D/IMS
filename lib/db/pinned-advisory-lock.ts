import { type Pool, type PoolClient } from 'pg'

import { createSessionAdvisoryLockPool } from './session-lock-pool'

/**
 * A SESSION-level advisory lock, held on one pinned connection (o3d-4ajo).
 *
 * `pg_try_advisory_lock(k)` lives on the connection that took it. Taking it
 * through Prisma and releasing it through Prisma is not symmetric: the app's
 * client runs each statement on an arbitrary pooled connection, so the unlock
 * can land on a DIFFERENT socket, return false, and leave the original
 * connection holding the lock until it happens to reset. Nobody notices,
 * because the unlock's boolean result is normally discarded — and the next run
 * of that job just reports "already running" forever.
 *
 * That is not theoretical for the daily accounting batches: they share the
 * ACCOUNTING WRITE / PAYMENT WRITE domains with refund creation and the Xero
 * payment jobs (see lib/db/advisory-locks.ts), so a leaked batch lock does not
 * merely stall a batch — it stalls refunds, or suppresses payment writes.
 *
 * `lib/connectors/xero/payment-write-lock.ts` solved this first for its own
 * lock; this is the same shape, callable by any job.
 */

/**
 * THE LOCK POOL IS BUILT BY `createSessionAdvisoryLockPool()`, NOT FROM `DATABASE_URL` AND NOT FROM
 * `pgConnectionConfig()` EITHER (o3d-2k5r r23 and r25, Codex HIGH; o3d-a5zz).
 *
 * r23 closed the first half: a `new Pool({ connectionString })` is a second, unguarded route to the
 * database inside a process whose Prisma pool is guarded — no `search_path` pin, so its raw
 * statements resolve through the server-default schema rather than the one the application writes
 * to, and none of the per-connection backend checks, so on a deployment whose schema needs a
 * non-ASCII startup option it can be served by a backend the deployment probe never measured. An
 * exclusion taken somewhere other than where the work happens is not an exclusion.
 *
 * r25 closes the half that `pgConnectionConfig()` alone left open, and it is the half this file is
 * about. That config attaches its per-connection check only for a NON-ASCII startup option, so on an
 * ASCII schema — every ordinary deployment — the connection this lock lives on was never shown to
 * reach the backend directly. Behind a transaction pooler it does not: measured against Odyssey
 * 1.5.3-rc1, two clients each got `true` from the same `pg_try_advisory_lock` and the first's own
 * `pg_locks` showed nothing. `lost` cannot see that — it reports a DEAD connection, not a live one
 * whose backend was swapped. `createSessionAdvisoryLockPool()` makes the affinity proof a property
 * of the pool every lock holder builds; see `lib/db/session-lock-pool.ts`.
 *
 * Small on purpose: these are a handful of low-frequency, long-lived jobs, which is why the extra
 * round trip per new physical connection costs nothing that matters here.
 */
let lockPool: Pool | null = null
function getLockPool(): Pool {
  if (!lockPool) lockPool = createSessionAdvisoryLockPool('advisory locks', 4)
  return lockPool
}

export class AdvisoryLockLostError extends Error {}

/**
 * How one lock is addressed in SQL: the single-bigint form, or the two-int form.
 *
 * Pulled out and exported because ARGUMENT ORDER is the whole of it and it is invisible at the
 * call site — `pg_try_advisory_lock(ns, key)` takes the namespace FIRST, and a version that
 * passed them the other way round would take a real lock on a pair that means something else,
 * silently, with no error anywhere. Pure, so that can be pinned without a database.
 */
export function advisoryLockCall(key: number, namespace?: number): {
  label: string
  args: number[]
  params: string
} {
  return namespace === undefined
    ? { label: `${key}`, args: [key], params: '$1' }
    : { label: `${namespace}/${key}`, args: [namespace, key], params: '$1, $2' }
}

export type PinnedAdvisoryLock = {
  /** Release, verify the release, and return the connection (or destroy it). */
  release: () => Promise<void>
  /** True once the pinned connection has failed — the lock is NOT held any more. */
  readonly lost: boolean
  /**
   * Throw if the lock has been lost. Call at each write phase: PostgreSQL frees
   * a session lock the instant its connection dies, so from that moment another
   * batch (or a refund) can start while this one is still running. Stopping is
   * the only safe response — the exclusion this job assumed is gone.
   */
  assertHeld: (context?: string) => void
}

/**
 * Take `key` on a dedicated connection, or return null if someone else holds it.
 * The caller MUST call `release()` in a finally.
 *
 * `namespace` switches to the TWO-INT form, `pg_try_advisory_lock(ns, key)`,
 * which occupies a different keyspace from the single-bigint form and so cannot
 * collide with it (o3d-0m56 round 4 — the money-post lock is keyed on a scope
 * hash within its own namespace). Everything else — the pinned connection, the
 * idle-error listener, the `lost` flag and the verified release — is identical,
 * and is the reason this is extended rather than copied.
 */
export async function acquirePinnedAdvisoryLockOrNull(
  key: number,
  namespace?: number,
): Promise<PinnedAdvisoryLock | null> {
  const { label, args, params } = advisoryLockCall(key, namespace)
  const client: PoolClient = await getLockPool().connect()
  // BEFORE anything else. pg-pool removes its own idle-error listener from a
  // checked-out client, and this client then sits idle for the whole batch — so
  // a server restart or socket failure would emit an 'error' with no listener,
  // which takes the process down. It also means the lock is GONE: Postgres frees
  // a session lock the moment its connection dies.
  let lost = false
  const onError = (error: Error) => {
    lost = true
    console.error(`[advisory-lock] pinned connection for ${label} failed — the lock is no longer held:`, error)
  }
  client.on('error', onError)
  let acquired = false
  try {
    const rows = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${params}) AS locked`,
      args,
    )
    acquired = Boolean(rows.rows[0]?.locked)
  } catch (error) {
    client.removeListener('error', onError)
    client.release(true)
    throw error
  }
  if (!acquired) {
    client.removeListener('error', onError)
    client.release()
    return null
  }

  return {
    get lost() { return lost },
    assertHeld(context?: string) {
      if (lost) {
        throw new AdvisoryLockLostError(
          `Advisory lock ${label} was lost (its connection failed)${context ? ` before ${context}` : ''} — `
          + 'another job may already be running, so this one must stop rather than write.',
        )
      }
    },
    async release() {
      let destroyed = false
      if (lost) {
        // The session is gone; there is nothing to unlock and the connection
        // must not go back to the pool.
        client.removeListener('error', onError)
        client.release(true)
        return
      }
      try {
        const released = await client.query<{ unlocked: boolean }>(
          `SELECT pg_advisory_unlock(${params}) AS unlocked`,
          args,
        )
        if (!released.rows[0]?.unlocked) {
          // Returning a connection that still holds a session lock would wedge
          // every job in this domain — including refunds. Destroy it instead:
          // a closed connection releases its locks unconditionally.
          console.error(`[advisory-lock] unlock of ${label} returned false — destroying the connection`)
          client.release(true)
          destroyed = true
        }
      } catch (error) {
        console.error(`[advisory-lock] unlock of ${label} failed — destroying the connection:`, error)
        client.release(true)
        destroyed = true
      }
      client.removeListener('error', onError)
      if (!destroyed) client.release()
    },
  }
}
