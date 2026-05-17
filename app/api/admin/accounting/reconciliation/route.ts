import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import { runAccountingReconciliationReport } from '@/lib/domain/accounting/reconciliation'

export const runtime = 'nodejs'

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export async function GET(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const report = await runAccountingReconciliationReport({
    lookbackDays: positiveInteger(request.nextUrl.searchParams.get('lookbackDays')),
  })
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

export async function POST(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const report = await runAccountingReconciliationReport({
    lookbackDays: positiveInteger(body.lookbackDays),
    persist: true,
  })
  await logActivity({
    entityType: 'SYSTEM',
    tag: 'accounting',
    action: 'accounting_reconciliation_persist',
    description: `Persisted accounting reconciliation run ${report.runId} with ${report.summary.total} finding(s)`,
    metadata: {
      runId: report.runId,
      fromDate: report.fromDate,
      toDate: report.toDate,
      summary: report.summary,
    },
  })

  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
