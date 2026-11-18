import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessOverviewAnalytics } from '@/lib/security/overview-analytics-access'

export async function requireOverviewAnalyticsAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessOverviewAnalytics(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}
