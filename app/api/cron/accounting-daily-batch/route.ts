import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { resolveScheduledDailyBatchSweep } from '@/lib/domain/accounting/daily-batch-sweep-schedule'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-daily-batch', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'accounting-daily-batch',
    run: async () => {
      // o3d-i0o6 r6: which sweep runs — and the skip reasons — come from the SHARED definition, not
      // from an if-chain only this file can see. The sweeps themselves have to answer the same
      // question (`resolveScheduledDailyBatchSweep`) to tell "another ledger's missing journal that
      // its own sweep will rebuild" from "one nobody is coming for", and two spellings of it would
      // let them silence pounds this route had stopped scheduling.
      const schedule = await resolveScheduledDailyBatchSweep()
      if (schedule.connector === null) return { skipped: true, reason: schedule.reason }
      if (schedule.connector === 'xero') {
        const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
        return await runDailyBatchSync() as Record<string, unknown>
      }
      const { runDailyBatchSync } = await import('@/lib/connectors/quickbooks/daily-sync')
      return await runDailyBatchSync() as Record<string, unknown>
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
