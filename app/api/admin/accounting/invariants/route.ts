import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { runAccountingInvariantReport } from '@/lib/domain/accounting/invariants'

export const runtime = 'nodejs'

export async function GET() {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const report = await runAccountingInvariantReport()
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
