import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { runAccountingReconciliationReport } from '@/lib/domain/accounting/reconciliation'

export const runtime = 'nodejs'

export async function GET() {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const report = await runAccountingReconciliationReport()
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
