import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit, type CronRateLimitChecker } from '@/lib/cron-rate-limit'
import { recomputeProductObservedLeadTimes } from '@/lib/domain/purchasing/product-lead-time'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runCronWithLogging, type CronRunLogWriter } from '@/lib/ops/cron-run'
import { cronRunResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export const runtime = 'nodejs'

export async function handleRecomputeProductLeadTimesCron(
  request: Request,
  options: {
    now?: () => Date
    createRunId?: () => string
    writeLog?: CronRunLogWriter
    getMaintenanceResponse?: typeof getMaintenanceModeResponse
    recompute?: typeof recomputeProductObservedLeadTimes
    checkCronRateLimit?: CronRateLimitChecker
  } = {},
) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('recompute-product-lead-times', { request, checker: options.checkCronRateLimit })
  if (rateLimitErr) return rateLimitErr

  const getMaintenanceResponse = options.getMaintenanceResponse ?? getMaintenanceModeResponse
  const maintenance = await getMaintenanceResponse('cron')
  if (maintenance) return maintenance

  const now = options.now ?? (() => new Date())
  const recompute = options.recompute ?? recomputeProductObservedLeadTimes
  const { runId, result, outcomeClass, responseStatus } = await runCronWithLogging({
    jobName: 'recompute-product-lead-times',
    now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async () => recompute({ now }),
    getOutcome: (r) => ({
      counts: { scanned: r.scanned, updated: r.updated, cleared: r.cleared, failed: r.failed },
      statusReason: `Observed lead time: ${r.updated} updated, ${r.cleared} cleared, ${r.failed} failed (${r.scanned} with PO history)`,
    }),
    outcomeOf: (result) => cronOutcome('recompute-product-lead-times', result),
  })

  return cronRunResponse({ runId, result, outcomeClass, responseStatus })
}

export async function GET(request: Request) {
  return handleRecomputeProductLeadTimesCron(request)
}
