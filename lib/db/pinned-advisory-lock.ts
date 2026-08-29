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
/**
 * The pinned connection, its idle-error listener and the `lost` flag — everything both acquire
 * functions need BEFORE either of them knows whether it holds anything.
 *
 * The listener is attached before the first query for the reason the original comment gave:
 * pg-pool removes its own idle-error listener from a checked-out client, and this client then sits
 * idle for the whole critical section — so a server restart or socket failure would emit an
 * 'error' with no listener, which takes the process down. It also means the lock is GONE:
 * PostgreSQL frees a session lock the moment its connection dies.
 */
type PinnedConnection = {
  client: PoolClient
  readonly lost: boolean
  detach: () => void
}

async function openPinnedConnection(label: string): Promise<PinnedConnection> {
  const client: PoolClient = await getLockPool().connect()
  let lost = false
  const onError = (error: Error) => {
    lost = true
    console.error(`[advisory-lock] pinned connection for ${label} failed — the lock is no longer held:`, error)
  }
  client.on('error', onError)
  return {
    client,
    get lost() { return lost },
    detach: () => client.removeListener('error', onError),
  }
}

/** The handle handed back once the lock is genuinely held. Shared by both acquire functions. */
function heldPinnedLock(
  connection: PinnedConnection,
  label: string,
  params: string,
  args: number[],
): PinnedAdvisoryLock {
  const { client } = connection
  return {
    get lost() { return connection.lost },
    assertHeld(context?: string) {
      if (connection.lost) {
        throw new AdvisoryLockLostError(
          `Advisory lock ${label} was lost (its connection failed)${context ? ` before ${context}` : ''} — `
          + 'another job may already be running, so this one must stop rather than write.',
        )
      }
    },
    async release() {
      let destroyed = false
      if (connection.lost) {
        // The session is gone; there is nothing to unlock and the connection
        // must not go back to the pool.
        connection.detach()
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
      connection.detach()
      if (!destroyed) client.release()
    },
  }
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
  const connection = await openPinnedConnection(label)
  let acquired = false
  try {
    const rows = await connection.client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${params}) AS locked`,
      args,
    )
    acquired = Boolean(rows.rows[0]?.locked)
  } catch (error) {
    connection.detach()
    connection.client.release(true)
    throw error
  }
  if (!acquired) {
    connection.detach()
    connection.client.release()
    return null
  }

  return heldPinnedLock(connection, label, params, args)
}

/** A bounded wait for the lock expired — nobody else's fault, and NOT the same as "not held". */
export class AdvisoryLockWaitTimeoutError extends Error {}

/** PostgreSQL `lock_not_available`: the error `lock_timeout` raises while waiting. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * Take `key`, WAITING for whoever holds it, and give up after `timeoutMs` rather than forever
 * (Codex r21 HIGH).
 *
 * THE TRY FORM IS THE WRONG PRIMITIVE FOR A RECONCILIATION. `acquirePinnedAdvisoryLockOrNull`
 * answers contention by SKIPPING the run, which is right where the work is a retryable poll of a
 * queue — the row comes back round. It is wrong where the run is the only thing that will ever
 * apply a state that has ALREADY been committed: skipping there leaves the committed state and the
 * artefact permanently disagreeing, which is precisely the defect the caller was trying to close.
 * Such a caller has to queue behind the holder, and the holder is a few local statements long.
 *
 * BOUNDED, THOUGH. `pg_advisory_lock` on its own waits for as long as the holder lives, and a
 * request handler that can block forever on a wedged peer is its own outage. `lock_timeout` bounds
 * it in the server, where the wait actually happens, and raises `lock_not_available` — reported
 * here as its own error type so a caller can tell "I waited and gave up" (the crontab may now be
 * behind; say so) from "the database refused me" (an operational fault).
 *
 * The connection is DESTROYED on a failed wait rather than returned: it is carrying a non-default
 * `lock_timeout`, and these acquisitions are rare enough that reusing it buys nothing.
 */
export async function acquirePinnedAdvisoryLockWaiting(
  key: number,
  options: { timeoutMs: number; namespace?: number },
): Promise<PinnedAdvisoryLock> {
  const { label, args, params } = advisoryLockCall(key, options.namespace)
  // `SET` takes no bind parameters, so this value is INTERPOLATED. It is coerced to a positive
  // integer here rather than trusted: nothing that reaches this line may be caller text.
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs))
  const connection = await openPinnedConnection(label)
  try {
    await connection.client.query(`SET lock_timeout = ${timeoutMs}`)
    await connection.client.query(`SELECT pg_advisory_lock(${params})`, args)
    // Back to the default BEFORE the caller's work runs, so the timeout bounds the wait for this
    // lock and nothing else this connection is later asked to do.
    await connection.client.query('RESET lock_timeout')
  } catch (error) {
    connection.detach()
    connection.client.release(true)
    if ((error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE) {
      throw new AdvisoryLockWaitTimeoutError(
        `Timed out after ${timeoutMs}ms waiting for advisory lock ${label}.`,
      )
    }
    throw error
  }
  return heldPinnedLock(connection, label, params, args)
}
