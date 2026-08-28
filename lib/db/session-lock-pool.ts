import pg, { Pool } from 'pg'

import {
  SESSION_LOCK_DATABASE_URL_ENV,
  pgSessionLockConnectionConfig,
  pinClientToMeasuredBackend,
} from './database-url-schema.mjs'

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
function sessionLockConfig(purpose: string): Record<string, unknown> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error(`DATABASE_URL is required for ${purpose}`)
  return pgSessionLockConnectionConfig(
    connectionString,
    process.env[SESSION_LOCK_DATABASE_URL_ENV],
    purpose,
  ) as unknown as Record<string, unknown>
}

/**
 * A pool whose every physical connection has been shown to reach the backend directly.
 *
 * `max` is small by construction at every call site: these pools hold one connection per in-flight
 * lock and nothing else, so the extra round trip the guard costs is paid a handful of times in a
 * process's life — never per query, and never on a checkout of a connection that is already open.
 */
export function createSessionAdvisoryLockPool(purpose: string, max: number): Pool {
  return new Pool({ ...sessionLockConfig(purpose), max })
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
  const config = { ...sessionLockConfig(purpose), ...extra }
  return pinClientToMeasuredBackend(new pg.Client(config), config)
}
