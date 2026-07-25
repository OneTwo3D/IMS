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
 * How long a lease survives WITHOUT renewal. Kept short so a crashed holder
 * unblocks others quickly; a live holder keeps it alive by heartbeat, so this
 * is not a ceiling on how long the protected work may take.
 *
 * A fixed TTL alone would be unsound: CONNECTOR_FETCH_TIMEOUT_MS is
 * env-configurable and can exceed any constant we pick, and a stalled process
 * can too. The lease would then expire mid-flight, another caller would take
 * it, and the overlap this lock exists to prevent would be back — silently.
 * Hence renewal plus the fence below.
 */
const LEASE_TTL_MS = 30_000

/** Renew comfortably inside the TTL so one slow round trip can't lose it. */
const RENEW_INTERVAL_MS = 10_000

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

/**
 * Extend our lease. Returns false if we no longer own it — which means it
 * expired and someone else took it, and anything we are still doing is now
 * unprotected.
 */
async function renew(token: string): Promise<boolean> {
  const renewed = await db.setting.updateMany({
    where: { key: LOCK_KEY, value: { endsWith: `|${token}` } },
    data: { value: `${expiryIso(Date.now())}|${token}` },
  })
  return renewed.count === 1
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
  fn: (ctx: { assertHeld: () => Promise<void> }) => Promise<T>,
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

  let lost = false
  const heartbeat = setInterval(() => {
    void renew(token).then((ok) => { if (!ok) lost = true }, () => { /* transient; try again next tick */ })
  }, RENEW_INTERVAL_MS)
  // Don't hold the event loop open on the heartbeat alone.
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  /**
   * Fence. Call immediately before any irreversible protected action (the
   * /api/Auth request, the mode commit). Renewal alone is not enough: if we
   * lost the lease we must NOT proceed, because another holder may already be
   * doing the thing we were serialising against.
   */
  const assertHeld = async () => {
    if (!lost && await renew(token)) return
    lost = true
    throw new MintsoftAuthLockTimeout(
      `Lost the Mintsoft auth lease during "${label}" (it expired and was taken by ` +
      'another process). Refusing to continue: another authentication or mode ' +
      'transition may now be in progress.',
    )
  }

  try {
    return await fn({ assertHeld })
  } finally {
    clearInterval(heartbeat)
    await release(token).catch(() => {
      // A failed release is survivable — the lease expires on its own — and
      // must never mask the error from fn().
    })
  }
}

let acquireCounter = 0
