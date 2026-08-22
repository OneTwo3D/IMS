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

// ---------------------------------------------------------------------------
// Is this session USABLE at all? (o3d-512h round 4, Codex finding 1)
// ---------------------------------------------------------------------------

/**
 * Codex round 4, finding 1 — THE SAME DEFECT, ONE LAYER DOWN.
 *
 * Round 3 deleted app/actions/allocation.ts's shadowing `requireAuth`, which
 * checked only that a user id existed: no revocation check, no second-factor
 * check. app/actions/supplier-portal.ts's `requireSupplier` was the same
 * function wearing a different name, and round 3 kept it — the audit asked
 * whether the SUPPLIER surface scoped rows correctly (it does) and never asked
 * whether the session reaching it was still a valid one. A supplier whose login
 * had been revoked, whose account had been deactivated, who had been reassigned
 * to a different supplier, or who had a password but had not cleared the TOTP
 * challenge, still got in.
 *
 * The reason three call sites drifted apart is that each one open-coded the same
 * three checks next to its own way of refusing — a redirect, a 401 body, a null.
 * So the CHECKS live here, once, and the call sites keep only their refusal:
 *
 *   * lib/auth/server.ts:requireAuth        -> redirect
 *   * lib/auth/session-gates.ts:requireApiAuthSession -> 401 JSON
 *   * app/actions/supplier-portal.ts:requireSupplier  -> null
 *
 * Adding a fourth kind of denial is now a change to this function, which every
 * gate inherits, instead of a check somebody has to remember to copy.
 *
 * NOTE what this does NOT answer. It is an AUTHENTICATION-VALIDITY question:
 * "is this session still the one we issued, and is it fully established". It
 * says nothing about whether the principal may do the thing — that is the
 * caller's authorization gate, and a supplier session that passes here is still
 * an external principal.
 */
export type SessionAccessDenial =
  | { reason: 'no-session' }
  | { reason: 'session-invalid'; sessionInvalidReason: SessionInvalidReason }
  | { reason: 'second-factor-pending' }

/**
 * The session fields the decision needs. Deliberately loose (optional, nullable)
 * so it can be handed a next-auth session user, a decoded token, or a fixture
 * without a cast — a stricter type here would only be satisfied by casting at
 * the call sites, which is how a missing field becomes an assumed-false one.
 */
export type SessionAccessUser = {
  sessionInvalidReason?: SessionInvalidReason | null
  totpEnabled?: boolean | null
  totpVerified?: boolean | null
}

/** The denial, or null when the session may proceed to its authorization gate. */
export function sessionAccessDenial(
  user: SessionAccessUser | null | undefined,
): SessionAccessDenial | null {
  if (!user) return { reason: 'no-session' }

  // Revoked, deactivated, force-logged-out, or minted before a sessionVersion
  // bump. Reassignment lands here too: app/actions/users.ts bumps sessionVersion
  // whenever role/supplierId/active/email/password changes, so a supplier moved
  // to a different company (or demoted out of SUPPLIER) carries a token whose
  // version no longer matches and is refused on its next request.
  if (user.sessionInvalidReason) {
    return { reason: 'session-invalid', sessionInvalidReason: user.sessionInvalidReason }
  }

  // Password accepted, second factor not yet presented. Such a session is half
  // authenticated and must not reach anything but the challenge itself.
  if (user.totpEnabled && !user.totpVerified) return { reason: 'second-factor-pending' }

  return null
}
