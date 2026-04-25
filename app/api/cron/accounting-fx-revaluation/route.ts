import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runArApFxRevaluation } from '@/lib/accounting-fx-revaluation'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const url = new URL(request.url)
  const valuationDate = url.searchParams.get('date') ?? undefined
  const result = await runArApFxRevaluation({ valuationDate })
  return NextResponse.json(result, { status: result.success ? 200 : 400 })
}
