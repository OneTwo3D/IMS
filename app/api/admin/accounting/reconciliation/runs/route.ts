import { NextRequest, NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
import { listAccountingReconciliationRuns } from '@/lib/domain/accounting/reconciliation'

export const runtime = 'nodejs'

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseBoolean(value: string | null): boolean {
  return value === '1' || value === 'true'
}

export async function GET(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const runs = await listAccountingReconciliationRuns(undefined, {
    limit: positiveInteger(request.nextUrl.searchParams.get('limit')),
    includeFindings: parseBoolean(request.nextUrl.searchParams.get('includeFindings')),
  })
  return NextResponse.json({ runs }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
