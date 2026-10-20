import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { runWritersCheckRecord } from '@/lib/ops/writers-check-record'

export const runtime = 'nodejs'

// Called by cron with Authorization: Bearer $CRON_SECRET. Read-only toward every vendor: it evaluates the environment and
// IMS's own database and keeps the report in the activity log.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('writers-check', { request, max: 3 })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: 'writers-check',
    run: async () => ({ ...(await runWritersCheckRecord()) }),
    getOutcome: (outcome) => ({
      status: outcome.status === 'FAILED' ? 'failed' : 'completed',
      counts: { findings: outcome.findings, exitCode: outcome.exitCode },
      statusReason: outcome.status === 'FAILED' ? outcome.reason ?? 'the check did not come back ok' : null,
      // Anything but ok is a red run, so scheduler monitoring sees a double claim or a blind check.
      responseStatus: outcome.status === 'FAILED' ? 500 : 200,
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit({ status: responseStatus ?? 200 }))
}
