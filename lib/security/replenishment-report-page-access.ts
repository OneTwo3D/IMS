import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessReplenishmentReports } from '@/lib/security/replenishment-report-access'

export async function requireReplenishmentReportAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessReplenishmentReports(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}
