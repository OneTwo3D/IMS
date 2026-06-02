import { NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

export function canAccessInventoryCostingReports(role: string): boolean {
  return hasPermission(role, 'analytics.inventory_costing')
}

export async function requireInventoryCostingReportAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessInventoryCostingReports(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}

export function inventoryCostingApiAccessDenied(session: AuthSession): NextResponse | null {
  return canAccessInventoryCostingReports(session.user.role)
    ? null
    : NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
