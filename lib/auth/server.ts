/**
 * Server-side auth helpers for use in Route Handlers and Server Components.
 */
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import type { Permission } from '@/lib/permissions'

export type { Permission }

export type AuthSession = {
  user: {
    id: string
    email: string
    name: string
    role: string
    supplierId: string | null
    totpEnabled: boolean
    totpVerified: boolean
  }
}

/**
 * Returns the current session or redirects to /login.
 * Use in Server Components and Route Handlers that require authentication.
 */
export async function requireAuth(): Promise<AuthSession> {
  const session = await auth()

  if (!session?.user) {
    redirect('/login')
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
  if (!roles.includes(session.user.role)) {
    throw new Error('Forbidden')
  }
  return session
}

/**
 * Requires the user to be an ADMIN.
 */
export async function requireAdmin(): Promise<AuthSession> {
  return requireRole('ADMIN')
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

/**
 * Returns the current session or null — does not redirect.
 */
export async function getSession(): Promise<AuthSession | null> {
  const session = await auth()
  if (!session?.user) return null
  return session as AuthSession
}
