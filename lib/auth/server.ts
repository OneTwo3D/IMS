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
  type AuthSession,
} from '@/lib/auth/session-gates'
import type { FreshAuthOptions } from '@/lib/auth/session-state'
import { loginPathForSessionInvalidReason } from '@/lib/auth/session-state'

export type { Permission }
export type { AuthSession } from '@/lib/auth/session-gates'

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
export async function requireFreshAuth(options?: FreshAuthOptions): Promise<AuthSession> {
  const session = await requireAuth()
  return requireFreshAuthSession(session, options)
}

export async function requireFreshAdmin(options?: FreshAuthOptions): Promise<AuthSession> {
  const session = await requireFreshAuth(options)
  return requireRoleSession(session, ['ADMIN'])
}

/**
 * Requires the current user to hold a specific RBAC permission.
 * Use this on mutating server actions so that non-admin roles can be granted
 * (or denied) specific capabilities.
 */
export async function requirePermission(permission: Permission): Promise<AuthSession> {
  const session = await requireAuth()
  if (!hasPermission(session.user.role, permission)) {
    throw new Error(`Forbidden: missing permission ${permission}`)
  }
  return session
}

export async function requireFreshPermission(
  permission: Permission,
  options?: FreshAuthOptions,
): Promise<AuthSession> {
  const session = await requireFreshAuth(options)
  if (!hasPermission(session.user.role, permission)) {
    throw new Error(`Forbidden: missing permission ${permission}`)
  }
  return session
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

export async function requireApiFreshAdmin(options?: FreshAuthOptions): Promise<AuthSession | NextResponse> {
  return requireApiFreshAdminSession(await auth(), options)
}
