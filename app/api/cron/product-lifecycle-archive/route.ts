import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit, type CronRateLimitChecker } from '@/lib/cron-rate-limit'
import { archiveExhaustedEolProducts } from '@/lib/domain/inventory/product-lifecycle-archive'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import {
  appendCronRunId,
  cronRunResponseInit,
  runCronWithLogging,
  type CronRunLogWriter,
} from '@/lib/ops/cron-run'

export const runtime = 'nodejs'

type ProductLifecycleArchiveCronResult = Awaited<ReturnType<typeof archiveExhaustedEolProducts>>
type ProductLifecycleArchiveCronPayload = ProductLifecycleArchiveCronResult & Record<string, unknown>

function productLifecycleArchiveCounts(result: ProductLifecycleArchiveCronResult): Record<string, number> {
  return {
    scanned: result.scanned,
    archived: result.archived,
    skippedWithStock: result.skippedWithStock,
    skippedWithIncoming: result.skippedWithIncoming,
  }
}

function productLifecycleArchiveStatusReason(result: ProductLifecycleArchiveCronResult): string {
  return [
    `Scanned ${result.scanned} EOL product(s)`,
    `archived ${result.archived}`,
    `skipped ${result.skippedWithStock} with stock`,
    `skipped ${result.skippedWithIncoming} with incoming stock`,
  ].join('; ')
}

export async function handleProductLifecycleArchiveCron(
  request: Request,
  options: {
    now?: () => Date
    createRunId?: () => string
    writeLog?: CronRunLogWriter
    getMaintenanceResponse?: typeof getMaintenanceModeResponse
    archiveProducts?: typeof archiveExhaustedEolProducts
    checkCronRateLimit?: CronRateLimitChecker
  } = {},
) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('product-lifecycle-archive', { request, checker: options.checkCronRateLimit })
  if (rateLimitErr) return rateLimitErr

  const getMaintenanceResponse = options.getMaintenanceResponse ?? getMaintenanceModeResponse
  const maintenance = await getMaintenanceResponse('cron')
  if (maintenance) return maintenance

  const now = options.now ?? (() => new Date())
  const archiveProducts = options.archiveProducts ?? archiveExhaustedEolProducts
  const { runId, result } = await runCronWithLogging({
    jobName: 'product-lifecycle-archive',
    now,
    createRunId: options.createRunId,
    writeLog: options.writeLog,
    run: async ({ startedAt }) => {
      const archiveResult = await archiveProducts({ now: new Date(startedAt) })
      return archiveResult as ProductLifecycleArchiveCronPayload
    },
    getOutcome: (result) => ({
      status: 'completed',
      counts: productLifecycleArchiveCounts(result),
      statusReason: productLifecycleArchiveStatusReason(result),
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}

export async function GET(request: Request) {
  return handleProductLifecycleArchiveCron(request)
}
