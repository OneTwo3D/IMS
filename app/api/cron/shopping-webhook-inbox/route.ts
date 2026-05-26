import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getShopifySettings } from '@/lib/connectors/shopify/settings'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { processPendingShopifyWebhookEvents } from '@/lib/jobs/shopify/process-shopping-webhook-events'
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
      const connectorResults: Record<string, unknown> = {}
      if (!(await isIntegrationPluginEnabled('woocommerce'))) {
        connectorResults.woocommerce = {
          skipped: true,
          reason: 'woocommerce_plugin_disabled',
          gates: { pluginEnabled: false, syncEnabled: null },
        }
      } else {
        const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
        if (enabled?.value !== 'true') {
          connectorResults.woocommerce = {
            skipped: true,
            reason: 'wc_sync_disabled',
            gates: { pluginEnabled: true, syncEnabled: false },
          }
        } else {
          connectorResults.woocommerce = await processPendingWcWebhookEvents()
        }
      }

      if (!(await isIntegrationPluginEnabled('shopify'))) {
        connectorResults.shopify = {
          skipped: true,
          reason: 'shopify_plugin_disabled',
          gates: { pluginEnabled: false, syncEnabled: null },
        }
      } else {
        const settings = await getShopifySettings()
        if (settings.shopify_sync_enabled !== 'true') {
          connectorResults.shopify = {
            skipped: true,
            reason: 'shopify_sync_disabled',
            gates: { pluginEnabled: true, syncEnabled: false },
          }
        } else {
          connectorResults.shopify = await processPendingShopifyWebhookEvents()
        }
      }

      return { connectors: connectorResults } as Record<string, unknown>
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
