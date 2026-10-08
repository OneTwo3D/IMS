import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { checkDeliveryStatus } from '@/lib/trackship'
import { raceWithDeadline } from '@/lib/ops/bounded-wait'
import { SCHEDULER_GUARD_ROUTE_DEADLINE_MS, startSchedulerCoverageGuard } from '@/lib/ops/read-sync-scheduler-guard'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('delivery-status', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  // This job is in the installer's bootstrap crontab, so it is scheduled on every installation. It also
  // checks that the read-sync alarm's own jobs are scheduled. The guard STARTS FIRST, in the background,
  // so a stalled delivery poll cannot prevent it; it never rejects, has its own hard ceiling, and is not
  // re-entered by an overlapping invocation. This response waits for it only up to a short deadline
  // AFTER the core work, so the guard can never delay or fail the delivery-status answer.
  const guard = startSchedulerCoverageGuard()
  const result = await checkDeliveryStatus()
  await raceWithDeadline(guard, SCHEDULER_GUARD_ROUTE_DEADLINE_MS, null)
  return NextResponse.json(result)
}
