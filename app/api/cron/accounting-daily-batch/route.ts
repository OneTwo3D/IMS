import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
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
      if (await isIntegrationPluginEnabled('xero')) {
        const [batchEnabled, syncEnabled] = await Promise.all([
          db.setting.findUnique({ where: { key: 'xero_daily_batch_enabled' } }),
          db.setting.findUnique({ where: { key: 'xero_sync_enabled' } }),
        ])
        if (batchEnabled?.value !== 'true') return { skipped: true, reason: 'Xero daily batch disabled' }
        if (syncEnabled?.value !== 'true') return { skipped: true, reason: 'Xero sync disabled' }
        const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
        return await runDailyBatchSync() as Record<string, unknown>
      }

      if (await isIntegrationPluginEnabled('quickbooks')) {
        const [batchEnabled, syncEnabled] = await Promise.all([
          db.setting.findUnique({ where: { key: 'quickbooks_daily_batch_enabled' } }),
          db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } }),
        ])
        if (batchEnabled?.value !== 'true') return { skipped: true, reason: 'QuickBooks daily batch disabled' }
        if (syncEnabled?.value !== 'true') return { skipped: true, reason: 'QuickBooks sync disabled' }
        const { runDailyBatchSync } = await import('@/lib/connectors/quickbooks/daily-sync')
        return await runDailyBatchSync() as Record<string, unknown>
      }

      return { skipped: true, reason: 'No accounting plugin enabled' }
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
