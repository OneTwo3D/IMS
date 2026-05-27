import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin, requireApiFreshAdmin } from '@/lib/auth/server'
import { runAccountingEventBackfill } from '@/lib/domain/accounting/accounting-event-backfill'

export const runtime = 'nodejs'

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseDryRun(value: unknown): boolean {
  return value === false || value === 'false' ? false : true
}

export async function GET(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const report = await runAccountingEventBackfill({
    dryRun: true,
    lookbackDays: positiveInteger(request.nextUrl.searchParams.get('lookbackDays')),
    limit: positiveInteger(request.nextUrl.searchParams.get('limit')),
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
  const dryRun = parseDryRun(body.dryRun)
  if (!dryRun && body.confirm !== 'BACKFILL_ACCOUNTING_EVENTS') {
    return NextResponse.json(
      { error: 'Set confirm to BACKFILL_ACCOUNTING_EVENTS to run the accounting event backfill.' },
      { status: 400 },
    )
  }
  if (!dryRun) {
    const freshSession = await requireApiFreshAdmin()
    if (freshSession instanceof NextResponse) return freshSession
  }

  const lookbackDays = positiveInteger(body.lookbackDays)
  const limit = positiveInteger(body.limit)
  const report = await runAccountingEventBackfill({
    dryRun,
    lookbackDays,
    limit,
  })
  if (!dryRun) {
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'accounting',
      action: 'accounting_event_backfill',
      description: `Backfilled ${report.summary.created} accounting event(s) from legacy sync logs`,
      metadata: {
        lookbackDays,
        limit,
        created: report.summary.created,
        skipped: report.summary.skipped,
        candidateSummary: report.candidateSummary,
      },
    })
  }
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
