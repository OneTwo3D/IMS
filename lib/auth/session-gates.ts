import { NextResponse } from 'next/server'
import {
  evaluateFreshAuth,
  type FreshAuthDecision,
  type FreshAuthOptions,
  type SessionInvalidReason,
} from '@/lib/auth/session-state'

export type AuthSession = {
  user: {
    id: string
    email: string
    name: string
    role: string
    supplierId: string | null
    pictureUrl?: string | null
    totpEnabled: boolean
    totpVerified: boolean
    sessionVersion?: number
    sessionAuthTime?: number
    sessionInvalidReason?: SessionInvalidReason | null
  }
}

export function isAuthSession(value: unknown): value is AuthSession {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'user' in value &&
    (value as { user?: unknown }).user,
  )
}

/**
 * An authorization DENIAL — the caller is authenticated, but not entitled.
 *
 * WHY THIS IS A TYPE AND NOT A MESSAGE. Callers that aggregate several reads (the Integrations
 * page loads ~22 in parallel) have to tell "this dependency is unavailable" apart from "you were
 * never allowed to see this". Degrading the second into the first renders a partial page to a
 * role that was not entitled to any of it; the only honest response to a denial is to fail the
 * whole thing. Message text cannot carry that distinction reliably — a permission name is
 * interpolated into it, and any read is free to reject with an arbitrary string — so the signal
 * is the class, and `code` is its stable structural shadow (see isAuthorizationDenial).
 */
export class PermissionDeniedError extends Error {
  readonly code = 'permission_denied'
  /** The permission that was missing, or null for a role-based denial. */
  readonly permission: string | null

  constructor(message: string, permission: string | null = null) {
    super(message)
    this.name = 'PermissionDeniedError'
    this.permission = permission
  }
}

/**
 * True for every way an authorization gate says NO to an authenticated caller:
 *   * `requirePermission` / `requireFreshPermission` / `requireRole` → PermissionDeniedError
 *   * `requireFreshPermission` / `requireFreshAuth` on a stale session → FreshAuthRequiredError
 *
 * Deliberately NOT a message match. `instanceof` is the primary test; the `code` fallback exists
 * only because a bundler can hand a server component a second copy of this module, and a denial
 * silently reclassified as an outage is precisely the failure this predicate exists to prevent.
 * Authentication failures are not here: those are a redirect, i.e. framework control flow.
 */
export function isAuthorizationDenial(error: unknown): boolean {
  if (error instanceof PermissionDeniedError || error instanceof FreshAuthRequiredError) return true
  const code = (error as { code?: unknown } | null)?.code
  return code === 'permission_denied' || code === 'fresh_auth_required'
}

export function requireRoleSession(session: AuthSession, roles: readonly string[]): AuthSession {
  if (!roles.includes(session.user.role)) {
    throw new PermissionDeniedError('Forbidden')
  }
  return session
}

export function requireApiAuthSession(session: unknown): AuthSession | NextResponse {
  if (!isAuthSession(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.sessionInvalidReason) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  }
  if (session.user.totpEnabled && !session.user.totpVerified) {
    return NextResponse.json({ error: 'Two-factor verification required' }, { status: 401 })
  }
  return session
}

export function requireApiAdminSession(session: unknown): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return authResult
}

export class FreshAuthRequiredError extends Error {
  readonly code = 'fresh_auth_required'
  readonly reason: Exclude<FreshAuthDecision, { valid: true }>['reason']

  constructor(decision: Exclude<FreshAuthDecision, { valid: true }>) {
    super('Re-authentication required')
    this.name = 'FreshAuthRequiredError'
    this.reason = decision.reason
  }
}

export type FreshAuthFailureResult = {
  success: false
  error: string
  code: 'fresh_auth_required'
  reason: FreshAuthRequiredError['reason']
}

export function freshAuthFailureResult(error: unknown): FreshAuthFailureResult | null {
  if (!(error instanceof FreshAuthRequiredError)) return null
  return {
    success: false,
    error: error.message,
    code: error.code,
    reason: error.reason,
  }
}

export function requireFreshAuthSession(
  session: AuthSession,
  options?: FreshAuthOptions,
): AuthSession {
  const decision = evaluateFreshAuth(session.user.sessionAuthTime, options)
  if (!decision.valid) {
    throw new FreshAuthRequiredError(decision)
  }
  return session
}

export function requireApiFreshAuthSession(
  session: unknown,
  options?: FreshAuthOptions,
): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult

  const decision = evaluateFreshAuth(authResult.user.sessionAuthTime, options)
  if (!decision.valid) {
    return NextResponse.json(
      {
        error: 'Fresh authentication required',
        code: 'fresh_auth_required',
        reason: decision.reason,
      },
      { status: 403 },
    )
  }

  return authResult
}

export function requireApiFreshAdminSession(
  session: unknown,
  options?: FreshAuthOptions,
): AuthSession | NextResponse {
  const authResult = requireApiAuthSession(session)
  if (authResult instanceof NextResponse) return authResult
  if (authResult.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const freshResult = requireApiFreshAuthSession(authResult, options)
  if (freshResult instanceof NextResponse) return freshResult
  return authResult
}
