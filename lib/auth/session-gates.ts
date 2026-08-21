import { NextResponse } from 'next/server'
import type { Permission } from '@/lib/permissions'
import {
  evaluateFreshAuth,
  sessionAccessDenial,
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
  /**
   * The permission that was missing, or NULL for a role-based denial (o3d-m3gy).
   *
   * TYPED, AND STILL NULLABLE. The sibling branch declared this as the `Permission` union, which is
   * the better type for the case it had — a caller comparing against a permission name gets a
   * compile error on a typo instead of a silent never-match. But the union has no member for
   * `requireRoleSession`, which denies on the ROLE with no permission in view, and dropping that case
   * to make the type tidy would leave a whole class of denial unable to describe itself. So both:
   * the union where there is a permission, `null` where the denial was not about one.
   */
  readonly permission: Permission | null

  /**
   * Brand carried by every authorization denial, checked by `isAuthorizationDenial` (o3d-m3gy).
   *
   * `instanceof` alone is not reliable if this module is evaluated twice in one process — separate
   * server/client graphs, or a bundler duplicating the chunk — and a silently-false
   * `isAuthorizationDenial` degrades a 403 into an unhandled 500: the access-denied state is never
   * rendered and the error boundary offers "Go to Login" / "Try Again" to a principal for whom
   * retrying can only fail again. `code` covers the same hazard for an error that crossed a boundary
   * which stripped the prototype but kept own enumerable properties; the brand covers the duplicate
   * evaluation. They are not the same failure and both are checked.
   */
  readonly __authorizationDenial = true as const

  constructor(message: string, permission: Permission | null = null) {
    super(message)
    this.name = 'PermissionDeniedError'
    this.permission = permission
  }
}

/**
 * WHAT A CALLER MAY ASSUME ABOUT AN ERROR `isAuthorizationDenial` ADMITTED (o3d-m3gy).
 *
 * Deliberately a structural shape with OPTIONAL fields rather than
 * `PermissionDeniedError | FreshAuthRequiredError`, and that is the honest type rather than the
 * flattering one. Two of the four ways in are duck-typed — the `code` string and the brand — and an
 * object that arrived by either is not, at runtime, an instance of anything: its prototype was
 * stripped crossing a boundary, or it came from a second copy of this module. Narrowing such a value
 * to the class union would type `.permission` as `Permission | null` while it is `undefined`, and a
 * caller that then rendered "you are missing permission X" would be reading a field that does not
 * exist. Optional fields make the caller handle that, which is the actual situation.
 *
 * Both classes are assignable to this, so `instanceof` still narrows further wherever a caller wants
 * the strong type and is willing to test for it.
 */
export type AuthorizationDenial = {
  readonly name?: string
  readonly message?: string
  /** Present on a real instance, absent on a structural copy. */
  readonly code?: 'permission_denied' | 'fresh_auth_required'
  /** The missing permission; `null` for a ROLE denial; absent on a structural copy or a fresh-auth denial. */
  readonly permission?: Permission | null
  /** Why re-authentication is required; only on a fresh-auth denial. */
  readonly reason?: FreshAuthRequiredError['reason']
  readonly __authorizationDenial?: true
}

/**
 * True for EVERY way an authorization gate says NO to an authenticated caller. ONE definition
 * (o3d-m3gy): `lib/auth/authorization-denial.ts` re-exports this rather than declaring a second, and
 * two predicates answering one question differently is how a denial stops being recognised as one.
 *
 * The four admissible signals, and each is here because the others do not cover it:
 *
 *   PermissionDeniedError instance   `requirePermission` / `requireFreshPermission` / `requireRole`.
 *   FreshAuthRequiredError instance  `requireFreshPermission` / `requireFreshAuth` on a stale session.
 *                                    A re-auth demand IS a refusal of this request and must render as
 *                                    one; leaving it out sends a stale session into the generic error
 *                                    boundary.
 *   `__authorizationDenial === true` the brand survives DUPLICATE MODULE EVALUATION, where both
 *                                    `instanceof` tests are false against a genuine denial object
 *                                    built by the other copy of this module.
 *   `code === 'permission_denied'`   the code string survives a boundary that keeps own enumerable
 *   `code === 'fresh_auth_required'` properties and drops the prototype — including the brand's
 *                                    class field, if the copy was made by anything other than a
 *                                    plain spread.
 *
 * Deliberately NOT a message match: a permission name is interpolated into the message and any read
 * is free to reject with an arbitrary string.
 *
 * Authentication failures are NOT here: those are a `redirect('/login')`, i.e. framework control
 * flow, and must keep propagating so the redirect happens. `notFound()` likewise.
 *
 * THE COST OF A FALSE NEGATIVE IS WHY ALL FOUR ARE CHECKED: an unrecognised denial is not a denial
 * that renders slightly worse, it is an unhandled error — a 500 where a 403 was owed, offering
 * "Try Again" to a principal for whom retrying can only fail again, and telling nobody that the
 * refusal was deliberate.
 */
export function isAuthorizationDenial(error: unknown): error is AuthorizationDenial {
  if (error instanceof PermissionDeniedError || error instanceof FreshAuthRequiredError) return true
  if (typeof error !== 'object' || error === null) return false
  if ((error as { __authorizationDenial?: unknown }).__authorizationDenial === true) return true
  const code = (error as { code?: unknown }).code
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
  // Same decision as requireAuth and as the supplier portal's requireSupplier —
  // see sessionAccessDenial. Only the refusal differs: a JSON 401.
  const denial = sessionAccessDenial(session.user)
  if (denial) {
    switch (denial.reason) {
      case 'no-session':
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      case 'session-invalid':
        return NextResponse.json({ error: 'Session expired' }, { status: 401 })
      case 'second-factor-pending':
        return NextResponse.json({ error: 'Two-factor verification required' }, { status: 401 })
    }
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
  /** The same brand `PermissionDeniedError` carries, for the same reason — see there (o3d-m3gy). */
  readonly __authorizationDenial = true as const
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
