/**
 * Login throttling for the password (Credentials) provider.
 *
 * Three independent buckets, all fail-closed:
 *  - email + IP   targeted guessing from one source (10 / 15 min)
 *  - account      the same email from ANY source (30 / 15 min); defeats address rotation, and
 *                 is the only effective bucket when no trusted proxy is configured and every
 *                 client resolves to 'unknown'
 *  - IP           password spraying across accounts from one source (50 / 15 min); only when
 *                 the client IP is trustworthy, otherwise it would lock out a whole office
 */
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'

export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_EMAIL_IP_MAX_ATTEMPTS = 10
export const LOGIN_ACCOUNT_MAX_ATTEMPTS = 30
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
    account: `login-acct:${normalized}`,
    ip: `login-ip:${clientIp}`,
  }
}

/** True when the attempt may proceed to the password check. */
export async function loginAttemptAllowed(input: {
  email: string
  clientIp: string
  ipIsTrustworthy: boolean
  limiter?: Limiter
}): Promise<boolean> {
  const limiter: Limiter = input.limiter ?? ((key, max, windowMs) => checkRateLimit(key, max, windowMs, { failClosed: true }))
  const keys = loginThrottleKeys(input.email, input.clientIp)
  const opts = { failClosed: true } as const

  if (!(await limiter(keys.emailIp, LOGIN_EMAIL_IP_MAX_ATTEMPTS, LOGIN_WINDOW_MS, opts)).allowed) return false
  if (!(await limiter(keys.account, LOGIN_ACCOUNT_MAX_ATTEMPTS, LOGIN_WINDOW_MS, opts)).allowed) return false
  if (input.ipIsTrustworthy && input.clientIp !== 'unknown') {
    if (!(await limiter(keys.ip, LOGIN_IP_MAX_ATTEMPTS, LOGIN_WINDOW_MS, opts)).allowed) return false
  }
  return true
}

export async function clearLoginThrottle(email: string, clientIp: string): Promise<void> {
  const keys = loginThrottleKeys(email, clientIp)
  await clearRateLimit(keys.emailIp)
  await clearRateLimit(keys.account)
}
