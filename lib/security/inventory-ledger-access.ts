import { NextResponse } from 'next/server'
import { requireAuth, type AuthSession } from '@/lib/auth/server'

const INVENTORY_LEDGER_REPORT_ROLES = new Set(['ADMIN', 'MANAGER', 'FINANCE', 'WAREHOUSE'])

export function canAccessInventoryLedgerReports(role: string): boolean {
  return INVENTORY_LEDGER_REPORT_ROLES.has(role)
}

export async function requireInventoryLedgerReportAccess(): Promise<AuthSession> {
  const session = await requireAuth()
  if (!canAccessInventoryLedgerReports(session.user.role)) {
    throw new Error('Forbidden: missing inventory ledger report access')
  }
  return session
}

export function inventoryLedgerApiAccessDenied(session: AuthSession): NextResponse | null {
  return canAccessInventoryLedgerReports(session.user.role)
    ? null
    : NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
