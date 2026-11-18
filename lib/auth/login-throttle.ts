/**
 * Login throttling for the password (Credentials) provider.
 *
 * Design rule: an unauthenticated caller must never be able to stop a legitimate user signing in.
 *  - email + IP   hard cap (10 / 15 min), only when the source IP is known: it can only ever block the
 *                 attacker's own address. Skipped for 'unknown' (every client would share one bucket).
 *  - IP           password-spraying cap (50 / 15 min), only when the IP is trustworthy and known.
 *  - account      SOFT: failed verifications only are counted per account (any source). Past the cap a
 *                 failing attempt is answered after a delay (backoff) - it is never refused outright, and a
 *                 correct password still signs in at full speed. A successful login clears it.
 */
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'

export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_EMAIL_IP_MAX_ATTEMPTS = 10
export const LOGIN_ACCOUNT_MAX_FAILURES = 30
export const LOGIN_FAILURE_BACKOFF_MS = 2000
export const LOGIN_IP_MAX_ATTEMPTS = 50

type Limiter = (
  key: string,
  max: number,
  windowMs: number,
  options: { failClosed: true },
) => Promise<{ allowed: boolean }>

export function loginThrottleKeys(email: string, clientIp: string) {
  const normalized = email.toLowerCase()
  return {
    emailIp: `login:${normalized}:${clientIp}`,
    accountFailures: `login-acct-fail:${normalized}`,
    ip: `login-ip:${clientIp}`,
  }
}

/** True when the attempt may proceed to the password check. Never charges the per-account bucket. */
export async function loginAttemptAllowed(input: {
  email: string
  clientIp: string
  ipIsTrustworthy: boolean
  limiter?: Limiter
}): Promise<boolean> {
  const limiter: Limiter = input.limiter ?? ((key, max, windowMs) => checkRateLimit(key, max, windowMs, { failClosed: true }))
  const keys = loginThrottleKeys(input.email, input.clientIp)
  const opts = { failClosed: true } as const

  if (input.clientIp === 'unknown') return true
  if (!(await limiter(keys.emailIp, LOGIN_EMAIL_IP_MAX_ATTEMPTS, LOGIN_WINDOW_MS, opts)).allowed) return false
  if (input.ipIsTrustworthy) {
    if (!(await limiter(keys.ip, LOGIN_IP_MAX_ATTEMPTS, LOGIN_WINDOW_MS, opts)).allowed) return false
  }
  return true
}

/**
 * Call after a FAILED verification. Counts the failure against the account and, past the cap, delays the
 * (failing) response so that guessing slows down without ever locking the real user out.
 * Returns the delay applied in ms.
 */
export async function recordLoginFailure(input: {
  email: string
  limiter?: Limiter
  sleep?: (ms: number) => Promise<void>
}): Promise<number> {
  const limiter: Limiter = input.limiter ?? ((key, max, windowMs) => checkRateLimit(key, max, windowMs, { failClosed: true }))
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const keys = loginThrottleKeys(input.email, 'unknown')
  const result = await limiter(keys.accountFailures, LOGIN_ACCOUNT_MAX_FAILURES, LOGIN_WINDOW_MS, { failClosed: true })
  if (result.allowed) return 0
  await sleep(LOGIN_FAILURE_BACKOFF_MS)
  return LOGIN_FAILURE_BACKOFF_MS
}

export async function clearLoginThrottle(email: string, clientIp: string): Promise<void> {
  const keys = loginThrottleKeys(email, clientIp)
  await clearRateLimit(keys.emailIp)
  await clearRateLimit(keys.accountFailures)
}
