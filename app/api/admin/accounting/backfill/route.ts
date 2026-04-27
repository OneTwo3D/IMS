import { NextRequest, NextResponse } from 'next/server'

import { requireApiAdmin } from '@/lib/auth/server'
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

  const report = await runAccountingEventBackfill({
    dryRun,
    lookbackDays: positiveInteger(body.lookbackDays),
    limit: positiveInteger(body.limit),
  })
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
