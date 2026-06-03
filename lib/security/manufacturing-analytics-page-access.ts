import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessManufacturingAnalytics } from '@/lib/security/manufacturing-analytics-access'

export async function requireManufacturingAnalyticsAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessManufacturingAnalytics(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}
