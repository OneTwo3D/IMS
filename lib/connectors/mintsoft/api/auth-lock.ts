import { db } from '@/lib/db'

/**
 * A durable, cross-process mutex around Mintsoft authentication (o3d-092/o3d-8u7).
 *
 * WHY THIS EXISTS
 *
 * `POST /api/Auth` mints a NEW tenant API key and invalidates the previous one.
 * Switching a connection to fixed-key mode therefore races every credentials
 * refresh: if a refresh is already in flight when the switch commits, the login
 * lands afterwards and invalidates the fixed key that was just verified —
 * taking this connector and the two integrations sharing the tenant key
 * offline. No local check can undo that, because the rotation happens at
 * Mintsoft the instant the request arrives. The only fix is to stop the two
 * from overlapping at all.
 *
 * WHY A LEASE AND NOT pg_advisory_lock
 *
 * The lock must be held ACROSS the HTTP round trip — that is the whole point,
 * since the hazard is the request itself. `pg_advisory_xact_lock` would mean
 * holding a pooled DB connection open for the duration of an external call, and
 * a session-level `pg_advisory_lock` is unsafe under Prisma's connection pool
 * (acquire and release can land on different connections). So we use a row in
 * `Setting` as a lease with an expiry: atomic to take via a conditional
 * `updateMany`, safe to hold across I/O, and self-healing if a process dies —
 * a crashed holder's lease simply expires.
 */

const LOCK_KEY = 'mintsoft_auth_lock'

/**
 * How long a holder may keep the lease. Must exceed the worst-case
 * /api/Auth round trip plus the token persist, or a slow login would have its
 * lease stolen and reintroduce the very overlap this prevents. It also bounds
 * how long a crashed holder can block others.
 */
const LEASE_TTL_MS = 60_000

/** How long a caller waits for a busy lease before giving up. */
const DEFAULT_WAIT_MS = 30_000
const POLL_INTERVAL_MS = 250

export class MintsoftAuthLockTimeout extends Error {}

function nowIso(): string {
  return new Date().toISOString()
}

function expiryIso(fromMs: number): string {
  return new Date(fromMs + LEASE_TTL_MS).toISOString()
}

/**
 * Try once to take the lease. Returns the token that proves ownership, or null
 * if someone else holds an unexpired lease.
 *
 * The value stored is `<expiryIso>|<token>`. Expiry first so the lexicographic
 * string comparison in the WHERE clause is a chronological one — ISO-8601 UTC
 * sorts correctly as text, which is what lets this be a single atomic
 * compare-and-set rather than a read-then-write.
 */
async function tryAcquire(token: string): Promise<string | null> {
  const now = Date.now()
  const value = `${expiryIso(now)}|${token}`

  // Ensure the row exists so the conditional update below has something to
  // match. createMany + skipDuplicates is a no-op when another process already
  // created it, so this cannot clobber a live lease.
  await db.setting.createMany({
    data: [{ key: LOCK_KEY, value: `${new Date(0).toISOString()}|` }],
    skipDuplicates: true,
  })

  // Atomic compare-and-set: take it only if the current lease has expired.
  // Postgres evaluates this as a single statement, so two racing processes
  // cannot both see an expired lease and both win.
  const claimed = await db.setting.updateMany({
    where: { key: LOCK_KEY, value: { lt: nowIso() } },
    data: { value },
  })

  return claimed.count === 1 ? token : null
}

async function release(token: string): Promise<void> {
  // Only the owner may release: a holder whose lease already expired (and was
  // taken by someone else) must not delete the new owner's lease.
  await db.setting.updateMany({
    where: { key: LOCK_KEY, value: { endsWith: `|${token}` } },
    data: { value: `${new Date(0).toISOString()}|` },
  })
}

/**
 * Run `fn` holding the Mintsoft auth lease.
 *
 * Every `/api/Auth` call AND every auth-mode transition must go through this,
 * or the serialization is only as good as its least careful caller. A
 * transition that waits here is waiting for in-flight logins to drain; a login
 * that waits here is waiting for a transition to commit, after which it re-reads
 * the mode and declines to run at all.
 */
export async function withMintsoftAuthLock<T>(
  label: string,
  fn: () => Promise<T>,
  options?: { waitMs?: number },
): Promise<T> {
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS
  const deadline = Date.now() + waitMs
  // Distinct per attempt so `release` can verify ownership. No Math.random():
  // a counter plus the high-resolution clock is enough to distinguish holders,
  // and randomness here would not add safety.
  const token = `${process.pid}-${Date.now()}-${(acquireCounter += 1)}`

  let held: string | null = null
  for (;;) {
    held = await tryAcquire(token)
    if (held) break
    if (Date.now() >= deadline) {
      throw new MintsoftAuthLockTimeout(
        `Timed out after ${waitMs}ms waiting for the Mintsoft auth lock (${label}). ` +
        'Another process is authenticating or switching authentication mode.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  try {
    return await fn()
  } finally {
    await release(token).catch(() => {
      // A failed release is survivable — the lease expires on its own — and
      // must never mask the error from fn().
    })
  }
}

let acquireCounter = 0
