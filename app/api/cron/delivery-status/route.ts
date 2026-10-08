import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { checkDeliveryStatus } from '@/lib/trackship'
import { startSchedulerCoverageGuard } from '@/lib/ops/read-sync-scheduler-guard'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('delivery-status', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  // This job is in the installer's bootstrap crontab, so it is scheduled on every installation. It also
  // checks that the read-sync alarm's own jobs are scheduled. The guard STARTS FIRST, in the background, so
  // a stalled delivery poll cannot prevent it, and it is NEVER AWAITED here: it has its own error isolation,
  // ceiling and re-entrancy guard, its timers are unref'd, and its outcome is visible through its
  // notifications and logs. The delivery-status response cannot be delayed or changed by it.
  try {
    void startSchedulerCoverageGuard().catch(() => undefined)
  } catch (error) {
    console.error('[read-sync-liveness] scheduler coverage guard could not start:', error)
  }
  const result = await checkDeliveryStatus()
  return NextResponse.json(result)
}
