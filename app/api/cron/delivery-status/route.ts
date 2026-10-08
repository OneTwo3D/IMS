import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { checkDeliveryStatus } from '@/lib/trackship'
import { runSchedulerCoverageGuardSafely } from '@/lib/ops/read-sync-scheduler-guard'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('delivery-status', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  const result = await checkDeliveryStatus()
  // This job is in the installer's bootstrap crontab, so it is scheduled on every installation. It also
  // checks that the read-sync alarm's own jobs are scheduled (never fails this job; see the guard).
  await runSchedulerCoverageGuardSafely()
  return NextResponse.json(result)
}
