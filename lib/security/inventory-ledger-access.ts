import { NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { requireAuth, type AuthSession } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'

export function canAccessInventoryLedgerReports(role: string): boolean {
  return hasPermission(role, 'analytics.inventory_ledger')
}

export async function requireInventoryLedgerReportAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessInventoryLedgerReports(session.user.role)) {
    redirect('/dashboard')
  }
  return session
}

export function inventoryLedgerApiAccessDenied(session: AuthSession): NextResponse | null {
  return canAccessInventoryLedgerReports(session.user.role)
    ? null
    : NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
