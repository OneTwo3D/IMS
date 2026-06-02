import { NextResponse } from 'next/server'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { canAccessStockPositionReports } from '@/lib/security/stock-position-policy'

export async function requireStockPositionReportAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessStockPositionReports(session.user.role)) {
    throw new Error('Forbidden: missing stock-position report access')
  }
  return session
}

export function stockPositionApiAccessDenied(session: AuthSession): NextResponse | null {
  return canAccessStockPositionReports(session.user.role)
    ? null
    : NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
