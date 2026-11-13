import { runScheduledInvariantCheck } from '@/lib/cron/invariant-check'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runCronWithLogging } from '@/lib/ops/cron-run'
import { cronRunResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('invariant-check', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, outcomeClass } = await runCronWithLogging({
    jobName: 'invariant-check',
    run: async ({ runId }) => await runScheduledInvariantCheck({ createRunId: () => runId }) as unknown as Record<string, unknown>,
    outcomeOf: (result) => cronOutcome('invariant-check', result),
  })

  // Any status but completed is a failure of the check, whatever the result carries.
  return cronRunResponse({ runId, result, outcomeClass: result.status === 'completed' ? outcomeClass : 'failed' })
}
