import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { processPendingWcWebhookEvents } from '@/lib/jobs/woocommerce/process-shopping-webhook-events'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'shopping-webhook-inbox',
    run: async () => {
      if (!(await isIntegrationPluginEnabled('woocommerce'))) {
        return { skipped: true, reason: 'WooCommerce plugin disabled' }
      }

      const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
      if (enabled?.value !== 'true') {
        return { skipped: true, reason: 'WC sync disabled' }
      }

      return await processPendingWcWebhookEvents() as Record<string, unknown>
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
