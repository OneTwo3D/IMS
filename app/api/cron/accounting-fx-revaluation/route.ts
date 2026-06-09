import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runArApFxRevaluation } from '@/lib/accounting-fx-revaluation'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-fx-revaluation', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const url = new URL(request.url)
  const valuationDate = url.searchParams.get('date') ?? undefined
  const result = await runArApFxRevaluation({ valuationDate })
  return NextResponse.json(result, { status: result.success ? 200 : 400 })
}
