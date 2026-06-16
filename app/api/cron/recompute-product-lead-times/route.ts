import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit, type CronRateLimitChecker } from '@/lib/cron-rate-limit'
import { recomputeProductObservedLeadTimes } from '@/lib/domain/purchasing/product-lead-time'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import {
  appendCronRunId,
  cronRunResponseInit,
  runCronWithLogging,
  type CronRunLogWriter,
} from '@/lib/ops/cron-run'

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
  const { runId, result } = await runCronWithLogging({
    jobName: 'recompute-product-lead-times',
    now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async () => recompute({ now }),
    getOutcome: (r) => ({
      status: 'completed',
      counts: { scanned: r.scanned, updated: r.updated, cleared: r.cleared, failed: r.failed },
      statusReason: `Observed lead time: ${r.updated} updated, ${r.cleared} cleared, ${r.failed} failed (${r.scanned} with PO history)`,
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}

export async function GET(request: Request) {
  return handleRecomputeProductLeadTimesCron(request)
}
