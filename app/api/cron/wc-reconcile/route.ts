import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWcReconcile } from '@/lib/connectors/woocommerce/sync/reconcile'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { appendCronRunId, runCronWithLogging } from '@/lib/ops/cron-run'

// Called by cron with Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'wc-reconcile',
    run: async () => {
      if (!(await isIntegrationPluginEnabled('woocommerce'))) {
        return { skipped: true, reason: 'Shopping plugin disabled' }
      }

      const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
      if (enabled?.value !== 'true') {
        return { skipped: true, reason: 'WC sync disabled' }
      }

      return await runWcReconcile() as Record<string, unknown>
    },
  })

  return NextResponse.json(appendCronRunId(result, runId))
}
