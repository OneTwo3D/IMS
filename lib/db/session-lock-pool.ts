import pg, { Pool, type PoolClient } from 'pg'

import {
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
 * A pool whose every physical connection has been shown to reach the backend directly.
 *
 * `max` is small by construction at every call site: these pools hold one connection per in-flight
 * lock and nothing else, so the extra round trip the guard costs is paid a handful of times in a
 * process's life — never per query, and never on a checkout of a connection that is already open.
 */
export function createSessionAdvisoryLockPool(purpose: string, max: number): Pool {
  const { config, reestablish } = sessionLockRoute(purpose)
  const pool = new Pool({ ...config, max })
  if (reestablish === null) return pool
  const gated = gateOnFreshLockSpace<PoolClient>(
    pool.connect.bind(pool) as () => Promise<PoolClient>,
    reestablish,
    (client) => client.release(true),
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
  if (reestablish === null) return client
  // For a lone client the connect IS the acquisition: it opens the session the lock will be held
  // on. Same gate, same `notBefore`-before-open ordering; the discard ends the client, since there
  // is no pool to hand it back to.
  const gated = gateOnFreshLockSpace<pg.Client>(
    client.connect.bind(client) as unknown as () => Promise<pg.Client>,
    reestablish,
    () => { void Promise.resolve(client.end()).catch(() => undefined) },
  )
  client.connect = (async (...args: unknown[]) => {
    // `pinClientToMeasuredBackend()` refuses the callback form for the same reason: the check
    // cannot be run between the callback firing and the caller using the connection.
    if (args.length > 0) throw new Error('connect(callback) is not supported on a session-lock client; use the promise form')
    return gated()
  }) as unknown as typeof client.connect
  return client
}
