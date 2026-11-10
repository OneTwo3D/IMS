import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessPurchasingAnalytics } from '@/lib/security/purchasing-analytics-access'

export async function requirePurchasingAnalyticsAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessPurchasingAnalytics(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}
