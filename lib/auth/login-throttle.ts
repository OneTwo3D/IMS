/**
 * Login throttling for the password (Credentials) provider.
 *
 * Design rule: bound brute force WITHOUT letting anyone deny a legitimate user. Nothing here is a lockout:
 * every refusal says "try again in N seconds", the wait is short and capped (15 min), and a correct
 * password after the wait always signs in and clears the account's counter.
 *
 *  - account      per-account failed-attempt counter. Past LOGIN_FREE_FAILURES, each attempt must wait out an
 *                 exponentially growing cooldown (1 s, 2 s, 4 s ... capped at 15 min) measured from the last
 *                 failure. It is enforced BEFORE the password check (refuse early, no bcrypt work), so an
 *                 attacker is held to roughly one guess per cooldown; the owner waits the same cooldown.
 *                 Applies to every client, including 'unknown' IPs, so it is the control that still bounds
 *                 guessing when no trusted proxy is configured.
 *  - in flight    one password check per account at a time (a short DB claim). Concurrent requests cannot
 *                 all read the same counter and then verify in parallel; the extra ones are told to retry in
 *                 a second. The claim is released when the check ends and expires on its own if the process dies.
 *  - IP           only FAILED attempts are counted per source IP. Past LOGIN_IP_FREE_FAILURES an attempt from
 *                 that IP is slowed (a fixed delay) and serialised (one in flight per IP). It is never refused
 *                 on account of the count, so an attacker sharing a public IP with a user cannot stop that
 *                 user's correct password; it only costs them a bounded wait. Unresolved ('unknown') and
 *                 untrusted addresses are one shared bucket, so they get a much higher threshold.
 *
 * State lives in the existing one_time_tokens table (no migration), so it is shared by every process.
 */
import { CredentialsSignin } from 'next-auth'
import { db } from '@/lib/db'

export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_FREE_FAILURES = 5
export const LOGIN_COOLDOWN_BASE_MS = 1000
export const LOGIN_COOLDOWN_MAX_MS = 15 * 60_000
export const LOGIN_CLAIM_TTL_MS = 30_000
export const LOGIN_BUSY_RETRY_MS = 1000
export const LOGIN_IP_FREE_FAILURES = 20
export const LOGIN_IP_FREE_FAILURES_SHARED = 200
export const LOGIN_IP_DELAY_MS = 2000
const KEY_MAX = 200

/** Thrown from authorize() so the sign-in form can say how long to wait (code `login_wait_<seconds>`). */
export class LoginThrottledError extends CredentialsSignin {
  retryAfterSec: number
  constructor(retryAfterSec: number) {
    super()
    this.retryAfterSec = retryAfterSec
    this.code = `login_wait_${retryAfterSec}`
  }
}

export type LoginStore = {
  /** Unique-key insert. False when a live claim already exists. */
  claim(key: string, ttlMs: number): Promise<boolean>
  release(key: string): Promise<void>
  get(key: string): Promise<{ value: string; expiresAtMs: number } | null>
  set(key: string, value: string, expiresAtMs: number): Promise<void>
  del(key: string): Promise<void>
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

export const dbLoginStore: LoginStore = {
  async claim(key, ttlMs) {
    await db.oneTimeToken.deleteMany({ where: { key, expiresAt: { lt: new Date() } } })
    try {
      await db.oneTimeToken.create({ data: { key, value: '1', expiresAt: new Date(Date.now() + ttlMs) } })
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  },
  async release(key) {
    await db.oneTimeToken.deleteMany({ where: { key } })
  },
  async get(key) {
    const row = await db.oneTimeToken.findUnique({ where: { key } })
    if (!row || row.expiresAt.getTime() <= Date.now()) return null
    return { value: row.value, expiresAtMs: row.expiresAt.getTime() }
  },
  async set(key, value, expiresAtMs) {
    const expiresAt = new Date(expiresAtMs)
    await db.oneTimeToken.upsert({ where: { key }, create: { key, value, expiresAt }, update: { value, expiresAt } })
  },
  async del(key) {
    await db.oneTimeToken.deleteMany({ where: { key } })
  },
}

export function loginThrottleKeys(email: string, clientIp: string) {
  const normalized = email.toLowerCase().slice(0, KEY_MAX)
  const ip = clientIp.slice(0, KEY_MAX)
  return {
    accountFailures: `login_fail:acct:${normalized}`,
    accountInFlight: `login_busy:acct:${normalized}`,
    ipFailures: `login_fail:ip:${ip}`,
    ipInFlight: `login_busy:ip:${ip}`,
  }
}

/** Cooldown after `failures` failed checks: nothing for the first LOGIN_FREE_FAILURES, then 1 s doubling, capped. */
export function loginCooldownMs(failures: number): number {
  if (failures < LOGIN_FREE_FAILURES) return 0
  const exponent = Math.min(failures - LOGIN_FREE_FAILURES, 30)
  return Math.min(LOGIN_COOLDOWN_BASE_MS * 2 ** exponent, LOGIN_COOLDOWN_MAX_MS)
}

type FailureState = { count: number; lastMs: number }

function parseState(raw: string | undefined): FailureState {
  const [count, lastMs] = (raw ?? '').split('|').map(Number)
  return Number.isFinite(count) && Number.isFinite(lastMs) ? { count, lastMs } : { count: 0, lastMs: 0 }
}

async function readFailures(store: LoginStore, key: string): Promise<FailureState> {
  return parseState((await store.get(key))?.value)
}

async function bumpFailures(store: LoginStore, key: string, nowMs: number): Promise<void> {
  const current = await readFailures(store, key)
  // The counter ages out LOGIN_WINDOW_MS after the last failure, so the cooldown is the longest the owner ever waits.
  await store.set(key, `${current.count + 1}|${nowMs}`, nowMs + Math.max(LOGIN_WINDOW_MS, LOGIN_COOLDOWN_MAX_MS))
}

export type LoginAttempt =
  | { allowed: true; finish(outcome: 'success' | 'failure'): Promise<void> }
  | { allowed: false; retryAfterSec: number; reason: 'cooldown' | 'busy' }

/**
 * Call before the password check. When allowed, the caller MUST call finish() exactly once in a finally block
 * (success clears the account counter, failure charges the account and the source IP, either releases the claims).
 */
export async function beginLoginAttempt(input: {
  email: string
  clientIp: string
  ipIsTrustworthy: boolean
  store?: LoginStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<LoginAttempt> {
  const store = input.store ?? dbLoginStore
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const keys = loginThrottleKeys(input.email, input.clientIp)
  const busy = { allowed: false, retryAfterSec: Math.ceil(LOGIN_BUSY_RETRY_MS / 1000), reason: 'busy' } as const

  // One password check per account at a time.
  if (!(await store.claim(keys.accountInFlight, LOGIN_CLAIM_TTL_MS))) return busy
  let ipClaimed = false
  const releaseAll = async () => {
    await store.release(keys.accountInFlight)
    if (ipClaimed) await store.release(keys.ipInFlight)
  }

  try {
    // Account cooldown, enforced before any password work.
    const acct = await readFailures(store, keys.accountFailures)
    const waitMs = acct.lastMs + loginCooldownMs(acct.count) - now()
    if (waitMs > 0) {
      await releaseAll()
      return { allowed: false, retryAfterSec: Math.ceil(waitMs / 1000), reason: 'cooldown' }
    }

    // Source IP: failed attempts only; a delay and a single lane, never a refusal on the count.
    const ipFreeFailures = input.ipIsTrustworthy && input.clientIp !== 'unknown'
      ? LOGIN_IP_FREE_FAILURES
      : LOGIN_IP_FREE_FAILURES_SHARED
    const ip = await readFailures(store, keys.ipFailures)
    if (ip.count > ipFreeFailures) {
      if (!(await store.claim(keys.ipInFlight, LOGIN_CLAIM_TTL_MS))) {
        await releaseAll()
        return busy
      }
      ipClaimed = true
      await sleep(LOGIN_IP_DELAY_MS)
    }
  } catch (error) {
    await releaseAll().catch(() => undefined)
    throw error
  }

  let finished = false
  return {
    allowed: true,
    async finish(outcome) {
      if (finished) return
      finished = true
      try {
        if (outcome === 'success') {
          await store.del(keys.accountFailures)
        } else {
          await bumpFailures(store, keys.accountFailures, now())
          await bumpFailures(store, keys.ipFailures, now())
        }
      } finally {
        await releaseAll()
      }
    },
  }
}
