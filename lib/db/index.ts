import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

import { pgConnectionConfig, prismaAdapterSchemaOptions } from './database-url-schema.mjs'

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
 *
 * IT IS A BOUND ON A *PRE-FLIGHT* WAIT, and that is the whole of its scope. A pool is one queue, so
 * this single option also covers the acquisition a connector worker makes AFTER a remote system has
 * accepted a write, purely to record what it did — where failing fast destroys the only local
 * evidence that the write happened and invites a duplicate on the next attempt (o3d-xl63 r2 #2).
 * Those callers do NOT get a second pool or a second bound; they wrap their persist in
 * `persistAfterRemoteWrite` (lib/db/post-remote-persist.ts), which re-drives across this timeout
 * because a caller that never got a connection provably ran nothing.
 */
export const DB_POOL_ACQUISITION_TIMEOUT_MS = 10_000

/**
 * The transaction options a POST-REMOTE persist must use (o3d-xl63 r3 #1).
 *
 * An interactive `$transaction` carries its own start bound — `maxWait`, DEFAULT 2000ms — and it is
 * five times shorter than the pool bound above, so on the default it is Prisma, not the pool, that
 * decides how long a caller waits for a connection. Measured against @prisma/client 7.7.0 with the
 * pool exhausted, `db.$transaction(async tx => ...)` rejects after 2002ms with
 * `PrismaClientKnownRequestError` P2028 "Unable to start a transaction in the given time" and NO
 * `cause` — the pg-pool text never appears at all. Round 2 built its whole detector around that text.
 *
 * Raising `maxWait` above the pool bound puts the decision back where the comment above says it is:
 * the pool times out first, and the failure that surfaces is the honest "timeout exceeded when trying
 * to connect". `persistAfterRemoteWrite` recognises BOTH shapes regardless, because a caller that
 * forgets these options must still be re-driven — but the ones that matter do not have to depend on
 * that. `timeout` bounds the BODY (two small writes) and is generous for the same reason: a body that
 * expired mid-flight is not something we may repeat.
 */
export const POST_REMOTE_PERSIST_TX_OPTIONS = {
  maxWait: DB_POOL_ACQUISITION_TIMEOUT_MS + 1_000,
  timeout: 15_000,
} as const

/**
 * THE ADAPTER PRODUCTION RUNS ON — exported so a test can build the real thing rather than
 * re-describe it (o3d-1izw / o3d-2k5r r8).
 *
 * Config form, NOT `new PrismaPg(pool)` (o3d-4ajo) — the same trap the
 * concurrency tests already guard against, which this runtime path never
 * got. The adapter decides between "this is my pool" and "this is my
 * config" with `instanceof pg.Pool`, so a Pool built from a second copy of
 * `pg` fails that check and the adapter treats the Pool OBJECT as its
 * config. It then hands the Pool's own `options` object to postgres as the
 * startup `options` parameter, pg-protocol calls Buffer.byteLength() on it,
 * and it throws ERR_INVALID_ARG_TYPE from the socket connect callback —
 * uncaught, so the request promise never settles. Letting the adapter build
 * its own pool removes the instanceof branch entirely.
 *
 * This is not hypothetical here: the checkout carries a duplicated
 * node_modules/node_modules tree, which is exactly the second `pg` identity
 * that triggers it.
 *
 * THE SECOND ARGUMENT IS THE HALF THAT WAS MISSING. Without `{ schema }` the adapter reports no
 * `schemaName`, so Prisma's generated queries are unqualified; combined with a pool whose
 * connections carried no `search_path`, a `?schema=` URL left the application resolving tables in
 * the server-default schema while the deploy check and the production preflight — which DO honour
 * that parameter — inspected and passed the named one. See lib/db/database-url-schema.mjs.
 */
export function createDbAdapter(): PrismaPg {
  return new PrismaPg(dbPoolConfig(), prismaAdapterSchemaOptions(process.env.DATABASE_URL))
}

function createPrismaClient() {
  return new PrismaClient({ adapter: createDbAdapter() })
}

/**
 * The pool configuration handed to the adapter, exported so it can be asserted against rather than
 * re-described by a test — a duplicated literal is a bound nothing checks is still there.
 *
 * `options` is the startup `search_path`. It is ALWAYS set on a parseable URL — the URL's own
 * `?schema=` when it has one, and Prisma's own default when it has not, because an adapter with no
 * `schemaName` compiles generated queries against a hardcoded `"public"` rather than against the
 * connection's search path, so "no schema named" is a divergence and not an agreement. It is what
 * makes the RAW statements this application runs — the o3d-1izw push-state gate among them — resolve the
 * same objects the two out-of-process release gates resolve. `PrismaPg`'s `{ schema }` option does
 * not cover them: it qualifies generated queries only.
 *
 * `onConnect` COMES FROM THE SAME PLACE AND IS PART OF THE SAME PIN (o3d-2k5r r22). It is present
 * only when the composed `options` carries a non-ASCII byte — i.e. only when a deployment probe's
 * verdict is being spent — and `pg-pool` awaits it on every NEW PHYSICAL CONNECTION before that
 * connection is handed to anyone, refusing one served by a backend other than the one the verdict
 * was measured on. It is deliberately NOT re-described here: it is composed by
 * `pgConnectionConfig()`, arrives through the spread below, and reaches the pool because
 * `PrismaPg`'s config form passes its config verbatim to `new pg.Pool(...)`.
 */
export function dbPoolConfig(): {
  connectionString: string
  max: number
  connectionTimeoutMillis: number
  options?: string
  onConnect?: (client: { query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<void>
} {
  // THE SPREAD COMES FIRST, AND IT CARRIES THE CONNECTION STRING (o3d-2k5r r10). `pg` parses
  // `connectionString` AFTER the surrounding config and assigns the result over it, so a
  // `connectionString` set here and an `options` set beside it is not a pinned search path at all:
  // an `options=` inside the URL wins. pgConnectionConfig() strips it from the URL and folds it
  // into one effective value, so the two can no longer be different things.
  return {
    ...pgConnectionConfig(process.env.DATABASE_URL),
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_POOL_ACQUISITION_TIMEOUT_MS,
  }
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
