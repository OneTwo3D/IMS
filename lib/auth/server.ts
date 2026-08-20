/**
 * Server-side auth helpers for use in Route Handlers and Server Components.
 */
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { hasPermission } from '@/lib/permissions'
import type { Permission } from '@/lib/permissions'
import {
  requireApiAdminSession,
  requireApiAuthSession,
  requireApiFreshAdminSession,
  requireFreshAuthSession,
  requireRoleSession,
  PermissionDeniedError,
  type AuthSession,
} from '@/lib/auth/session-gates'
import { loginPathForSessionInvalidReason } from '@/lib/auth/session-state'
import { isAuthorizationDenial } from '@/lib/auth/session-gates'

export type { Permission }
export type { AuthSession } from '@/lib/auth/session-gates'
// o3d-m3gy: ONE denial type and ONE predicate, re-exported here so callers that reach for them
// through `@/lib/auth/server` — as the whole app does — do not have to know which module declares
// them. `@/lib/auth/authorization-denial` re-exports the same symbols for the same reason.
export {
  FreshAuthRequiredError,
  freshAuthFailureResult,
  PermissionDeniedError,
  isAuthorizationDenial,
  type AuthorizationDenial,
} from '@/lib/auth/session-gates'

/**
 * Returns the current session or redirects to /login.
 * Use in Server Components and Route Handlers that require authentication.
 */
export async function requireAuth(): Promise<AuthSession> {
  const session = await auth()

  if (!session?.user) {
    redirect('/login')
  }

  if (session.user.sessionInvalidReason) {
    redirect(loginPathForSessionInvalidReason(session.user.sessionInvalidReason))
  }

  // If 2FA is enabled but not verified in this session, send to TOTP challenge
  if (session.user.totpEnabled && !session.user.totpVerified) {
    redirect('/2fa')
  }

  return session as AuthSession
}

/**
 * Requires the user to have one of the specified roles.
 * Returns the session if authorized, otherwise throws / returns JSON 403.
 */
export async function requireRole(...roles: string[]): Promise<AuthSession> {
  const session = await requireAuth()
  return requireRoleSession(session, roles)
}

/**
 * Requires the user to be an ADMIN.
 */
export async function requireAdmin(): Promise<AuthSession> {
  return requireRole('ADMIN')
}

/**
 * Requires a recently authenticated session for high-risk mutations.
 * Re-signing in refreshes sessionAuthTime; stale sessions fail closed.
 */
export async function requireFreshAuth(): Promise<AuthSession> {
  const session = await requireAuth()
  return requireFreshAuthSession(session)
}

export async function requireFreshAdmin(): Promise<AuthSession> {
  const session = await requireAuth()
  requireRoleSession(session, ['ADMIN'])
  return requireFreshAuthSession(session)
}

/**
 * Requires the current user to hold a specific RBAC permission.
 * Use this on mutating server actions so that non-admin roles can be granted
 * (or denied) specific capabilities.
 */
export async function requirePermission(permission: Permission): Promise<AuthSession> {
  const session = await requireAuth()
  if (!hasPermission(session.user.role, permission)) {
    // Typed, not a bare Error: callers that aggregate several reads must be able to tell a denial
    // from an unavailable dependency without matching on this message. See isAuthorizationDenial.
    //
    // o3d-m3gy: the message is spelt out here rather than derived by the constructor, which is how
    // the sibling `AuthorizationDenialError(permission)` did it. It is byte-identical to what that
    // produced, so nothing matching on 'Forbidden: missing permission …' changes — and the survivor's
    // constructor has to take a message because a ROLE denial has no permission to derive one from.
    throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
  }
  return session
}

/**
 * Requires an INTERNAL principal (o3d-512h round 3).
 *
 * `requireAuth` answers "is someone signed in". It cannot answer "is this one of
 * ours", and SUPPLIER — a third party we issue a login to so it can quote its own
 * RFQs — is signed in. Every `'use server'` export gated on requireAuth alone was
 * therefore a supplier-reachable endpoint: app/actions/purchase-orders.ts:
 * getPurchaseOrder handed a supplier session any purchase order by id, including
 * other suppliers' prices, and getPurchaseOrders enumerated the lot.
 *
 * This is the boundary those reads needed. It is deliberately NOT a per-endpoint
 * permission: picking one of those for each of ~70 endpoints would have been ~70
 * guesses, several of which would lock out an internal role that legitimately
 * reads the data (WAREHOUSE holds no 'analytics', FINANCE no 'stock_control').
 * `internal` is held by every internal role and by no supplier, so it removes the
 * external principal and costs no internal role anything — the narrowest change
 * that actually closes the hole. Tightening individual endpoints further is a
 * separate, per-endpoint argument.
 *
 * On the supplier's own surface this helper is the WRONG control and is
 * deliberately absent: there, holding 'supplier_portal.*' is not sufficient
 * either, because every supplier holds it. Those actions must scope to the
 * session's own supplierId (see lib/security/supplier-portal-boundary.ts).
 */
export async function requireInternalUser(): Promise<AuthSession> {
  return requirePermission('internal')
}

/**
 * Page-boundary authorization (o3d-512h).
 *
 * A page is the entrance a principal reaches by typing the URL, so it needs a
 * gate of its own: the sidebar hiding a link is not a boundary, and the
 * (dashboard) layout only establishes AUTHENTICATION. This resolves the gate
 * into a value so the page can render an explicit access-denied state instead
 * of throwing into app/(dashboard)/error.tsx, which answers a stable role
 * denial with "Go to Login" / "Try Again".
 *
 * Only an authorization denial is converted. Everything else keeps
 * propagating — notably the NEXT_REDIRECT that requireAuth throws for an
 * unauthenticated or 2FA-pending session, which MUST NOT be swallowed here or
 * an anonymous visitor would be shown "access denied" instead of the login
 * page.
 *
 * NOTE: this is a page-level control only. It does not protect the Server
 * Actions the page calls — each of those is a separately addressable endpoint
 * and needs its own guard.
 */
export type PageAuthorization =
  | { authorized: true; session: AuthSession }
  | { authorized: false; permission: Permission }

export async function authorizePage(permission: Permission): Promise<PageAuthorization> {
  try {
    const session = await requirePermission(permission)
    return { authorized: true, session }
  } catch (error) {
    if (isAuthorizationDenial(error)) return { authorized: false, permission }
    throw error
  }
}

export async function requireFreshPermission(
  permission: Permission,
): Promise<AuthSession> {
  const session = await requireAuth()
  if (!hasPermission(session.user.role, permission)) {
    throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
  }
  return requireFreshAuthSession(session)
}

/**
 * Returns the current session or null — does not redirect.
 */
export async function getSession(): Promise<AuthSession | null> {
  const session = await auth()
  if (!session?.user) return null
  if (session.user.sessionInvalidReason) return null
  return session as AuthSession
}

export async function requireApiAuth(): Promise<AuthSession | NextResponse> {
  return requireApiAuthSession(await auth())
}

export async function requireApiAdmin(): Promise<AuthSession | NextResponse> {
  return requireApiAdminSession(await auth())
}

export async function requireApiFreshAdmin(): Promise<AuthSession | NextResponse> {
  return requireApiFreshAdminSession(await auth())
}
