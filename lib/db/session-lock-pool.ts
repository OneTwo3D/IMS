import pg, { Pool, type PoolClient } from 'pg'

import {
  SESSION_LOCK_ACQUISITION_DEADLINE_MS,
  SESSION_LOCK_DATABASE_URL_ENV,
  pgSessionLockConnectionConfig,
  pinClientToMeasuredBackend,
  sessionLockSpaceReestablisher,
} from './database-url-schema.mjs'

/** Re-measure the override's shared lock space, accepting no verdict older than `notBefore`. */
type Reestablish = (notBefore: number) => Promise<void>

/**
 * THE ONE WAY A CONNECTION THAT WILL TAKE A SESSION ADVISORY LOCK IS BUILT (o3d-2k5r r25, Codex
 * HIGH; o3d-a5zz).
 *
 * WHY A FACTORY AND NOT A NOTE ON EACH CALL SITE. There are four holders of a session advisory lock
 * in this repository — `lib/db/pinned-advisory-lock.ts` (which `withMoneyPostLock` and the daily
 * accounting batches run on), `lib/connectors/xero/payment-write-lock.ts`,
 * `lib/domain/wms/dispatch-sweep-lock.ts` and the restore selection-lock holder in
 * `app/api/backup/restore/route.ts` — and each used to build its own `new Pool({
 * ...pgConnectionConfig(url) })`. Four copies of one requirement is four chances to fix three and
 * leave one, and the one left is silent: the lock still returns `true`, and only the second holder
 * finds out. The requirement is therefore a property of THIS function. A fifth holder that writes
 * its own pool is a failure of `tests/db/guarded-pool-routing.test.ts`, not a thing someone has to
 * remember.
 *
 * WHAT IT ADDS OVER `pgConnectionConfig()` is the affinity check, unconditionally — see the block
 * over `pgSessionLockConnectionConfig()` in `database-url-schema.mjs` for why a session lock needs
 * it on an ASCII schema exactly as much as on a non-ASCII one, and for what it does not close.
 *
 * `DATABASE_SESSION_LOCK_URL` is read HERE and nowhere else, so the escape hatch reaches every lock
 * or none.
 */
function sessionLockRoute(purpose: string): { config: Record<string, unknown>; reestablish: Reestablish | null } {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error(`DATABASE_URL is required for ${purpose}`)
  const override = process.env[SESSION_LOCK_DATABASE_URL_ENV]
  return {
    config: pgSessionLockConnectionConfig(
      connectionString,
      override,
      purpose,
    ) as unknown as Record<string, unknown>,
    // `null` unless an override is set, in which case there is one URL and nothing to disagree.
    reestablish: sessionLockSpaceReestablisher(connectionString, override),
  }
}

/**
 * THE OVERRIDE'S LOCK SPACE IS RE-MEASURED FOR THE ACQUISITION, NOT FOR THE PROCESS (o3d-2k5r r27,
 * Codex HIGH).
 *
 * WHAT WAS WRONG. `pgSessionLockConnectionConfig()` measures the override's shared lock space from
 * `onConnect`, i.e. once per PHYSICAL CONNECTION, memoised for the life of the process. A pool
 * connection lives for hours; the verdict then outlived the relationship it measured. A managed
 * failover, a pooler restarted onto a different primary, or a re-pointed DNS record changes nothing
 * about the URL strings and everything about what they reach -- and the old process goes on posting
 * money under a lock it proved something about at boot.
 *
 * WHAT THIS IS. A checkout is an ACQUISITION: `acquirePinnedAdvisoryLockOrNull()`, the Xero
 * payment-write lock, the WMS dispatch sweep and the restore selection lock each take their session
 * lock on the connection they just obtained. So the gate goes around obtaining one. `notBefore` is
 * read BEFORE the connection is opened, so the only verdict it will accept is one measured for this
 * acquisition -- the `onConnect` probe of a brand-new connection counts (and is therefore not paid
 * for twice), a verdict from an earlier acquisition does not.
 *
 * WHAT IT DOES NOT CLAIM. It narrows the window between the measurement and the lock from the
 * process's lifetime to milliseconds. It does not make a session advisory lock a sufficient
 * exclusion for money movement -- see the block over `pgSessionLockConnectionConfig()` and o3d-ic9a.
 *
 * A refusal DISCARDS the connection rather than returning it: a checkout that was refused must not
 * leave a socket behind, and a pool client that is released without `destroy` would be handed
 * straight back out.
 */
export function gateOnFreshLockSpace<C>(
  open: () => Promise<C>,
  reestablish: Reestablish | null,
  discard: (client: C) => void,
): () => Promise<C> {
  if (reestablish === null) return open
  return async () => {
    const notBefore = Date.now()
    const client = await open()
    try {
      await reestablish(notBefore)
    } catch (error) {
      // Best-effort: a teardown that itself fails must not replace the refusal with its own error.
      try { discard(client) } catch { /* the refusal is what the caller has to see */ }
      throw error
    }
    return client
  }
}


/**
 * Destroy a lock client's socket, rather than asking the server's permission to close it.
 *
 * `end()` writes a Terminate and waits for the server to close the socket, which is exactly what a
 * wedged server will not do -- so on expiry the stream goes first and `end()` follows as the
 * ordinary-case tidy-up (`discard` above). The same reasoning, and the same shape, as
 * `destroyClientSocket()` in `database-url-schema.mjs`; it is written here rather than exported
 * from there because this side has a typed `pg.Client` and that side does not.
 */
function destroyClientSocketOf(client: pg.Client): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream
  try { stream?.destroy?.() } catch { /* a socket that cannot be destroyed is already gone */ }
}

/**
 * AN ACQUISITION THAT CANNOT BE FINISHED MUST END, NOT HANG (o3d-2k5r r28, Codex MEDIUM).
 *
 * WHAT WAS WRONG, and it is the shape worth naming: r27 bounded the shared-lock-space PROBE, which
 * is a pair of throwaway connections, and left the connection the probe exists to license unbounded.
 * The inner half of that is fixed in `database-url-schema.mjs` (`withLockClientDeadline()`, which
 * destroys the lock client's own socket from inside `onConnect`). This is the outer half: the parts
 * of an acquisition that happen OUTSIDE the guard -- pg-pool's own connect path before `onConnect`
 * is reached, its wait for a free connection when the pool is full, and the per-acquisition
 * re-measurement `gateOnFreshLockSpace()` performs after the client is in hand.
 *
 * HOW THE SOCKET IS ACTUALLY DESTROYED, since this wrapper does not have the client while the
 * acquisition is still pending. For a lone `pg.Client` it does -- `abandon` closes over it and
 * destroys it on expiry. For a POOL the client does not exist yet, so the destruction comes from
 * the inside: the guard's own deadline fires first on a wedged connection and destroys that
 * socket, which is what makes the pending `connect()` reject. This wrapper is what bounds the
 * cases the guard never sees, and a client that arrives after expiry is DISCARDED rather than
 * leaked -- a pool client released without `destroy` would be handed straight back out.
 *
 * IT ALSO BOUNDS WAITING FOR A FREE CONNECTION, and that is deliberate rather than incidental.
 * These pools carry no `connectionTimeoutMillis`, so pg-pool queues an exhausted checkout with no
 * timer at all and the caller is woken only by a release that may never come -- the same defect
 * `tests/db/pool-acquisition-bound.test.ts` fixed on the data pool (o3d-xl63). A lock pool of
 * `max` 2-4 that has been full for the whole deadline is wedged, and every caller here already
 * treats a failed acquisition as a reason to stop rather than to write.
 *
 * @param open the acquisition, gate and all
 * @param discard how to destroy a client that arrives after the deadline has fired
 * @param purpose what the lock is for, so the refusal names it
 * @param deadlineMs the bound; shortened by tests
 * @param abandon destroys the client's socket on expiry, where the caller has one to destroy
 */
export function boundLockAcquisition<C>(
  open: () => Promise<C>,
  discard: (client: C) => void,
  purpose: string,
  deadlineMs: number = SESSION_LOCK_ACQUISITION_DEADLINE_MS,
  abandon: (() => void) | null = null,
): () => Promise<C> {
  return async () => {
    let expired = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // NOT unref()'d, for the reason the probe's timer is not: an unref'd timer does not hold the
    // event loop open, so an acquisition that stalls with nothing else pending would let the
    // process exit before the deadline it is relying on ever fired. Cleared on every path below.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        try { abandon?.() } catch { /* a socket that cannot be destroyed is already gone */ }
        reject(
          new Error(
            `Acquiring the connection for ${purpose} did not finish within ${deadlineMs}ms, so it was given up on ` +
              'rather than left pending: an acquisition that hangs is a money post, an accounting batch, a WMS ' +
              'dispatch sweep or a restore hanging with it. The lock was NOT taken.',
          ),
        )
      }, deadlineMs)
    })
    // The loser of the race still settles; without handlers a rejected deadline, or a connection
    // that arrives after it fired, would surface as an unhandled rejection.
    deadline.catch(() => undefined)
    const opening = open()
    opening.then(
      (client) => { if (expired) { try { discard(client) } catch { /* the refusal is what the caller sees */ } } },
      () => undefined,
    )
    try {
      return await Promise.race([opening, deadline])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/**
 * A pool whose every physical connection has been shown to reach the backend directly.
 *
 * `max` is small by construction at every call site: these pools hold one connection per in-flight
 * lock and nothing else, so the extra round trip the guard costs is paid a handful of times in a
 * process's life — never per query, and never on a checkout of a connection that is already open.
 */
export function createSessionAdvisoryLockPool(purpose: string, max: number): Pool {
  const { config, reestablish } = sessionLockRoute(purpose)
  const pool = new Pool({ ...config, max })
  const discard = (client: PoolClient) => client.release(true)
  // The deadline is applied whether or not an override is set: the affinity proof runs on EVERY
  // session-lock connection, so every one of them can stall on it.
  const gated = boundLockAcquisition<PoolClient>(
    gateOnFreshLockSpace<PoolClient>(
      pool.connect.bind(pool) as () => Promise<PoolClient>,
      reestablish,
      discard,
    ),
    discard,
    purpose,
  )
  // The CALLBACK form is kept rather than refused: `pool.query()` is implemented on top of it, so
  // refusing it would break an ordinary statement on a lock pool for a shape nothing here uses.
  pool.connect = ((callback?: (error: Error | undefined, client?: PoolClient, release?: () => void) => void) => {
    const acquired = gated()
    if (typeof callback !== 'function') return acquired
    acquired.then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: Error) => callback(error),
    )
    return undefined
  }) as unknown as Pool['connect']
  return pool
}

/**
 * The same guarantee for a lone `pg.Client`, which has no `onConnect` of its own — the restore
 * selection lock holds its lock on one dedicated session rather than out of a pool.
 *
 * `pinClientToMeasuredBackend()` wraps `connect()` so the check runs on whatever `connect()` the
 * caller already calls, and ENDs the client before rethrowing a refusal. It is a no-op only when the
 * config carries no hook, which a session-lock config never does.
 */
export function createSessionAdvisoryLockClient(
  purpose: string,
  extra: Record<string, unknown> = {},
): pg.Client {
  const { config: base, reestablish } = sessionLockRoute(purpose)
  const config = { ...base, ...extra }
  const client = pinClientToMeasuredBackend(new pg.Client(config), config)
  // For a lone client the connect IS the acquisition: it opens the session the lock will be held
  // on. Same gate, same `notBefore`-before-open ordering; the discard ends the client, since there
  // is no pool to hand it back to. Here the deadline HAS the client, so on expiry it destroys that
  // socket itself rather than waiting for the guard to do it from the inside.
  const discard = () => { void Promise.resolve(client.end()).catch(() => undefined) }
  const gated = boundLockAcquisition<pg.Client>(
    gateOnFreshLockSpace<pg.Client>(
      client.connect.bind(client) as unknown as () => Promise<pg.Client>,
      reestablish,
      discard,
    ),
    discard,
    purpose,
    undefined,
    () => destroyClientSocketOf(client),
  )
  client.connect = (async (...args: unknown[]) => {
    // `pinClientToMeasuredBackend()` refuses the callback form for the same reason: the check
    // cannot be run between the callback firing and the caller using the connection.
    if (args.length > 0) throw new Error('connect(callback) is not supported on a session-lock client; use the promise form')
    return gated()
  }) as unknown as typeof client.connect
  return client
}
