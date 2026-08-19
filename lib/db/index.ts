import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/** How many connections the pool may hold open at once. */
export const DB_POOL_MAX = 20

/**
 * HOW LONG A CALLER MAY WAIT FOR A CONNECTION BEFORE THE POOL GIVES UP (o3d-xl63).
 *
 * Without this, `pool.connect()` waits FOREVER when all `DB_POOL_MAX` connections are checked out:
 * pg-pool pushes the request onto `_pendingQueue` with no timer attached and it is only ever woken by
 * a release. Every statement-level bound we set is therefore a bound on the wrong half of the wait —
 * `SET LOCAL statement_timeout` in the direct-create marker deferral, for instance, is enforced by
 * Postgres and so cannot start counting until the statement has a connection to run on. Under pool
 * exhaustion the deferral could spend the reallocation sweep's entire per-tick wall-clock budget
 * queued for one, which is exactly the budget that bound was added to protect.
 *
 * TEN SECONDS, deliberately ABOVE the 5s `maxWait` the sweep's interactive transactions already carry.
 * A healthy acquisition is sub-millisecond, so anything approaching this is genuine exhaustion and
 * failing fast sheds load instead of queueing behind it; and keeping it above `maxWait` means Prisma's
 * own bound still fires first on the paths that have one, so their behaviour and error text are
 * unchanged. It is the paths with NO bound of their own — the batch `$transaction([...])` form among
 * them, which takes no `maxWait` — that this is here for.
 */
export const DB_POOL_ACQUISITION_TIMEOUT_MS = 10_000

function createPrismaClient() {
  // Config form, NOT `new PrismaPg(pool)` (o3d-4ajo) — the same trap the
  // concurrency tests already guard against, which this runtime path never
  // got. The adapter decides between "this is my pool" and "this is my
  // config" with `instanceof pg.Pool`, so a Pool built from a second copy of
  // `pg` fails that check and the adapter treats the Pool OBJECT as its
  // config. It then hands the Pool's own `options` object to postgres as the
  // startup `options` parameter, pg-protocol calls Buffer.byteLength() on it,
  // and it throws ERR_INVALID_ARG_TYPE from the socket connect callback —
  // uncaught, so the request promise never settles. Letting the adapter build
  // its own pool removes the instanceof branch entirely.
  //
  // This is not hypothetical here: the checkout carries a duplicated
  // node_modules/node_modules tree, which is exactly the second `pg` identity
  // that triggers it.
  const adapter = new PrismaPg(dbPoolConfig())
  return new PrismaClient({ adapter })
}

/**
 * The pool configuration handed to the adapter, exported so it can be asserted against rather than
 * re-described by a test — a duplicated literal is a bound nothing checks is still there.
 */
export function dbPoolConfig() {
  return {
    connectionString: process.env.DATABASE_URL!,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_POOL_ACQUISITION_TIMEOUT_MS,
  }
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
