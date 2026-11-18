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
 *  - device       OWASP "device cookie". After a successful sign-in a signed, HttpOnly cookie bound to the
 *                 account is set. A request carrying a valid cookie for the account skips the per-account
 *                 cooldown, so an attacker who keeps the account in cooldown by failing from elsewhere cannot
 *                 lock the real user out. The cookie has its own failure counter and cooldown (keyed by its
 *                 random id), so a stolen cookie cannot be used to brute-force: once it is cooling down the
 *                 request is treated as cookie-less and meets the account cooldown instead.
 *  - in flight    one password check per account (per device id for a cookie request) at a time (a short DB
 *                 claim). Concurrent requests cannot all read the same counter and then verify in parallel;
 *                 the extra ones are told to retry in a second. The claim is released when the check ends
 *                 and expires on its own if the process dies.
 *  - IP           only FAILED attempts are counted per source IP. Past LOGIN_IP_FREE_FAILURES an attempt from
 *                 that IP is slowed (a bounded fixed delay). There is no per-IP lane or claim and no refusal
 *                 on account of the count, so one sender can never monopolise sign-ins for everyone behind
 *                 the same NAT (or for the shared 'unknown' bucket). Unresolved ('unknown') and untrusted
 *                 addresses are one shared bucket, so they get a much higher threshold.
 *
 * State lives in the existing one_time_tokens table (no migration), so it is shared by every process.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
export const LOGIN_DEVICE_COOKIE_NAME = 'ims_login_device'
export const LOGIN_DEVICE_COOKIE_MAX_AGE_SEC = 180 * 24 * 60 * 60
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

/** Device cookie value: `<userId>.<issuedAtSec>.<deviceId>.<hmac>`. */
export type DeviceCookie = { userId: string; issuedAtSec: number; deviceId: string }

function deviceMac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`login-device:${payload}`, 'utf8').digest('base64url')
}

export function signDeviceCookie(userId: string, secret: string, nowMs: number = Date.now()): string {
  const payload = `${userId}.${Math.floor(nowMs / 1000)}.${randomBytes(12).toString('base64url')}`
  return `${payload}.${deviceMac(payload, secret)}`
}

/** The cookie's contents when it is genuine, unexpired and bound to `userId`; otherwise null. */
export function verifyDeviceCookie(
  value: string | null | undefined,
  userId: string,
  secret: string,
  nowMs: number = Date.now(),
): DeviceCookie | null {
  if (!value || !secret || value.length > 400) return null
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const [cookieUserId, issuedRaw, deviceId, mac] = parts
  const expected = deviceMac(`${cookieUserId}.${issuedRaw}.${deviceId}`, secret)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const issuedAtSec = Number(issuedRaw)
  if (!deviceId || !Number.isFinite(issuedAtSec) || cookieUserId !== userId) return null
  const ageMs = nowMs - issuedAtSec * 1000
  if (ageMs < -60_000 || ageMs > LOGIN_DEVICE_COOKIE_MAX_AGE_SEC * 1000) return null
  return { userId: cookieUserId, issuedAtSec, deviceId }
}

/** Pull one cookie out of a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export type LoginAttempt =
  | { allowed: true; finish(outcome: 'success' | 'failure'): Promise<void> }
  | { allowed: false; retryAfterSec: number; reason: 'cooldown' | 'busy' }

/**
 * Call before the password check. When allowed, the caller MUST call finish() exactly once in a finally block
 * (success clears the counters, failure charges the account or device and the source IP, either releases the claim).
 * `device` is a verified device cookie for this account (see verifyDeviceCookie), or null.
 */
export async function beginLoginAttempt(input: {
  email: string
  clientIp: string
  ipIsTrustworthy: boolean
  device?: DeviceCookie | null
  store?: LoginStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<LoginAttempt> {
  const store = input.store ?? dbLoginStore
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const keys = loginThrottleKeys(input.email, input.clientIp)
  const busy = { allowed: false, retryAfterSec: Math.ceil(LOGIN_BUSY_RETRY_MS / 1000), reason: 'busy' } as const

  const deviceId = input.device ? input.device.deviceId.slice(0, KEY_MAX) : null
  const deviceFailuresKey = deviceId ? `login_fail:dev:${deviceId}` : null
  const deviceInFlightKey = deviceId ? `login_busy:dev:${deviceId}` : null

  // A cookie that is itself cooling down (failures with it) is treated as no cookie at all.
  let useDevice = false
  if (deviceFailuresKey) {
    const dev = await readFailures(store, deviceFailuresKey)
    useDevice = dev.lastMs + loginCooldownMs(dev.count) - now() <= 0
  }
  const claimKey = useDevice && deviceInFlightKey ? deviceInFlightKey : keys.accountInFlight

  // One password check at a time: per account, or per device for a cookie request.
  if (!(await store.claim(claimKey, LOGIN_CLAIM_TTL_MS))) return busy
  const release = () => store.release(claimKey)

  try {
    if (!useDevice) {
      // Account cooldown, enforced before any password work.
      const acct = await readFailures(store, keys.accountFailures)
      const waitMs = acct.lastMs + loginCooldownMs(acct.count) - now()
      if (waitMs > 0) {
        await release()
        return { allowed: false, retryAfterSec: Math.ceil(waitMs / 1000), reason: 'cooldown' }
      }
    }

    // Source IP: failed attempts only; a bounded delay, never a refusal or an exclusive lane.
    const ipFreeFailures = input.ipIsTrustworthy && input.clientIp !== 'unknown'
      ? LOGIN_IP_FREE_FAILURES
      : LOGIN_IP_FREE_FAILURES_SHARED
    const ip = await readFailures(store, keys.ipFailures)
    if (ip.count > ipFreeFailures) await sleep(LOGIN_IP_DELAY_MS)
  } catch (error) {
    await release().catch(() => undefined)
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
          if (deviceFailuresKey) await store.del(deviceFailuresKey)
        } else {
          // A cookie request is charged to its device only, so a stolen cookie cannot raise the account cooldown.
          if (useDevice && deviceFailuresKey) await bumpFailures(store, deviceFailuresKey, now())
          else await bumpFailures(store, keys.accountFailures, now())
          await bumpFailures(store, keys.ipFailures, now())
        }
      } finally {
        await release()
      }
    },
  }
}
