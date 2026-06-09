import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { fetchAllFxRatesInternal } from '@/app/actions/currencies'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

export async function GET(request: Request) {
  const err = await verifyCron(request)
  if (err) return err
  const rateLimitErr = await enforceCronRateLimit('fx-rates')
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const { runId, result } = await runCronWithLogging({
    jobName: 'fx-rates',
    run: async () => await fetchAllFxRatesInternal() as Record<string, unknown>,
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
