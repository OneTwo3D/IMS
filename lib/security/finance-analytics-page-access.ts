import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessFinanceAnalytics } from '@/lib/security/finance-analytics-access'

export async function requireFinanceAnalyticsAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessFinanceAnalytics(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}
