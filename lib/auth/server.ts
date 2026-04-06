/**
 * Server-side auth helpers for use in Route Handlers and Server Components.
 */
import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'

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
 * Returns the current session or null — does not redirect.
 */
export async function getSession(): Promise<AuthSession | null> {
  const session = await auth()
  if (!session?.user) return null
  return session as AuthSession
}
