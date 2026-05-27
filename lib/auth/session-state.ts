export const SESSION_REVALIDATION_SELECT = {
  id: true,
  totpEnabled: true,
  active: true,
  sessionVersion: true,
  forceLogoutAt: true,
} as const

export type SessionInvalidReason =
  | 'missing-user'
  | 'inactive-user'
  | 'invalid-version'
  | 'session-version-mismatch'
  | 'force-logout'
  | 'missing-auth-time'

export type SessionUserState = {
  id: string
  active: boolean
  sessionVersion: number
  forceLogoutAt: Date | null
}

export type SessionTokenState = {
  sessionVersion?: unknown
  sessionAuthTime?: unknown
}

export type SessionStateDecision =
  | { valid: true }
  | { valid: false; reason: SessionInvalidReason }

export const DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS = 15 * 60
export const MAX_FRESH_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60
export const FRESH_AUTH_FUTURE_TOLERANCE_SECONDS = 60

export type FreshAuthInvalidReason =
  | 'missing-auth-time'
  | 'invalid-auth-time'
  | 'stale-auth'

export type FreshAuthOptions = {
  nowSeconds?: number
  maxAgeSeconds?: number
}

export type FreshAuthDecision =
  | { valid: true; ageSeconds: number; maxAgeSeconds: number }
  | { valid: false; reason: FreshAuthInvalidReason; ageSeconds: number | null; maxAgeSeconds: number }

export function isSessionInvalidReason(value: unknown): value is SessionInvalidReason {
  return value === 'missing-user' ||
    value === 'inactive-user' ||
    value === 'invalid-version' ||
    value === 'session-version-mismatch' ||
    value === 'force-logout' ||
    value === 'missing-auth-time'
}

export function sessionAuthTimeSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

export function freshAuthMaxAgeSeconds(value: unknown = process.env.FRESH_AUTH_MAX_AGE_SECONDS): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return Math.min(value, MAX_FRESH_AUTH_MAX_AGE_SECONDS)
  }
  if (typeof value !== 'string') return DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS
  return Math.min(parsed, MAX_FRESH_AUTH_MAX_AGE_SECONDS)
}

export function evaluateFreshAuth(
  sessionAuthTime: unknown,
  options: FreshAuthOptions = {},
): FreshAuthDecision {
  const maxAgeSeconds = freshAuthMaxAgeSeconds(options.maxAgeSeconds)
  const authTime = sessionAuthTimeSeconds(sessionAuthTime)
  if (authTime === null) {
    return { valid: false, reason: 'missing-auth-time', ageSeconds: null, maxAgeSeconds }
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (authTime > nowSeconds + FRESH_AUTH_FUTURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'invalid-auth-time', ageSeconds: null, maxAgeSeconds }
  }
  const ageSeconds = Math.max(0, nowSeconds - authTime)
  if (ageSeconds > maxAgeSeconds) {
    return { valid: false, reason: 'stale-auth', ageSeconds, maxAgeSeconds }
  }
  return { valid: true, ageSeconds, maxAgeSeconds }
}

export function evaluateSessionState(
  token: SessionTokenState,
  user: SessionUserState | null,
): SessionStateDecision {
  // Denial reason priority is a user-facing contract:
  // missing user -> inactive user -> corrupt stored version -> stale token -> forced logout.
  if (!user) return { valid: false, reason: 'missing-user' }
  if (!user.active) return { valid: false, reason: 'inactive-user' }
  if (!Number.isInteger(user.sessionVersion) || user.sessionVersion < 1) {
    return { valid: false, reason: 'invalid-version' }
  }
  if (token.sessionVersion !== user.sessionVersion) {
    return { valid: false, reason: 'session-version-mismatch' }
  }

  if (user.forceLogoutAt) {
    const authTime = sessionAuthTimeSeconds(token.sessionAuthTime)
    if (!authTime) return { valid: false, reason: 'missing-auth-time' }
    if (authTime <= Math.floor(user.forceLogoutAt.getTime() / 1000)) {
      return { valid: false, reason: 'force-logout' }
    }
  }

  return { valid: true }
}

export type SessionInvalidLoginReason =
  | 'account-deactivated'
  | 'session-expired'
  | 'signed-out'

export function sessionInvalidLoginReason(reason: SessionInvalidReason): SessionInvalidLoginReason {
  switch (reason) {
    case 'inactive-user':
    case 'missing-user':
      return 'account-deactivated'
    case 'force-logout':
    case 'missing-auth-time':
      return 'signed-out'
    case 'invalid-version':
    case 'session-version-mismatch':
      return 'session-expired'
  }
}

export function loginPathForSessionInvalidReason(reason: SessionInvalidReason): string {
  return `/login?reason=${encodeURIComponent(sessionInvalidLoginReason(reason))}`
}

export function sessionInvalidLoginMessage(reason: SessionInvalidLoginReason | null): string | null {
  switch (reason) {
    case 'account-deactivated':
      return 'Your account is no longer active. Contact an administrator if you need access.'
    case 'session-expired':
      return 'Your session expired after an account security change. Sign in again to continue.'
    case 'signed-out':
      return 'You were signed out by an account security change. Sign in again to continue.'
    default:
      return null
  }
}
