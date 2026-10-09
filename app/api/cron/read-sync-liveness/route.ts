import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { runReadSyncLivenessAlarmLive } from '@/lib/ops/read-sync-liveness-alarm'

export const runtime = 'nodejs'

// Called by cron with Authorization: Bearer $CRON_SECRET. Read-only toward every vendor: it evaluates
// the last-success stamps IMS already holds and alerts admins once per stale feed.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  // Headroom above the hourly cadence, as the WMS watchdog has: a failed run consumes a slot too.
  const rateLimitErr = await enforceCronRateLimit('read-sync-liveness', { request, max: 3 })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: 'read-sync-liveness',
    run: async () => ({ ...(await runReadSyncLivenessAlarmLive()) }),
    getOutcome: (outcome) => ({
      status: outcome.status === 'FAILED' ? 'failed' : 'completed',
      counts: { evaluated: outcome.evaluated, alerted: outcome.alerted.length, deliveryFailures: outcome.deliveryFailures },
      statusReason: outcome.status === 'FAILED' ? outcome.reason ?? 'alert delivery failed' : null,
      // FAILED = a breach exists that no admin was told about: surface it as 500 so scheduler monitoring goes red.
      responseStatus: outcome.status === 'FAILED' ? 500 : 200,
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit({ status: responseStatus ?? 200 }))
}
