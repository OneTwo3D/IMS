import { NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { runInventoryInvariantReport } from '@/lib/domain/inventory/invariants'

export const runtime = 'nodejs'

export async function GET() {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const report = await runInventoryInvariantReport()
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
