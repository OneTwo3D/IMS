import { NextResponse } from 'next/server'

import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIVE_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { processPendingWcWebhookEvents } from '@/lib/jobs/woocommerce/process-shopping-webhook-events'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'

type ConnectorTickResult = Record<string, unknown>

function normalizeCronError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runConnectorTick(input: {
  connector: 'woocommerce'
  pluginDisabledReason: string
  syncDisabledReason: string
  getSyncEnabled: () => Promise<boolean>
  processPendingEvents: () => Promise<ConnectorTickResult>
}): Promise<ConnectorTickResult> {
  try {
    if (!(await isIntegrationPluginEnabled(input.connector))) {
      return {
        skipped: true,
        reason: input.pluginDisabledReason,
        gates: { pluginEnabled: false, syncEnabled: null },
      }
    }

    if (!(await input.getSyncEnabled())) {
      return {
        skipped: true,
        reason: input.syncDisabledReason,
        gates: { pluginEnabled: true, syncEnabled: false },
      }
    }

    return await input.processPendingEvents()
  } catch (error) {
    console.warn('[shopping-webhook-inbox] connector tick failed', {
      connector: input.connector,
      error: normalizeCronError(error),
    })
    return {
      attempted: 0,
      processed: 0,
      failed: 1,
      deadLettered: 0,
      skipped: 0,
      error: normalizeCronError(error),
    }
  }
}

/**
 * Drain the durable storefront-completion jobs (o3d-zvec.15): the retry path for a WooCommerce completion
 * that failed (or never ran) after the order shipped. Gated on the plugin being enabled and NOT on
 * `wc_sync_enabled` — the status push has never been gated by that setting, and an order must not stay
 * `processing` in the storefront because inbound sync is switched off. Never throws.
 */
async function drainOrderCompletions(): Promise<ConnectorTickResult> {
  try {
    if (!(await isIntegrationPluginEnabled('woocommerce'))) {
      return { skipped: true, reason: 'woocommerce_plugin_disabled' }
    }
    const { processShoppingOrderCompletions } = await import('@/lib/shopping')
    return { ...(await processShoppingOrderCompletions()) }
  } catch (error) {
    console.warn('[shopping-webhook-inbox] order-completion drain failed', { error: normalizeCronError(error) })
    return { skipped: false, error: normalizeCronError(error) }
  }
}

async function getWcSyncEnabled(): Promise<boolean> {
  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  return enabled?.value === 'true'
}

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('shopping-webhook-inbox', { request, max: CRON_RATE_LIMIT_FIVE_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr

  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result } = await runCronWithLogging({
    jobName: 'shopping-webhook-inbox',
    run: async () => {
      // ONE CONNECTOR TICK TODAY (o3d-remove-parked-connectors). Shopify was the second element of
      // this Promise.all and is archived. The per-connector tick helper, its two gate reasons and the
      // `connectors` envelope are deliberately kept: they are what a second storefront adds an
      // element to, and the response shape operators and the cron log already read stays stable.
      const [woocommerce] = await Promise.all([
        runConnectorTick({
          connector: 'woocommerce',
          pluginDisabledReason: 'woocommerce_plugin_disabled',
          syncDisabledReason: 'wc_sync_disabled',
          getSyncEnabled: getWcSyncEnabled,
          processPendingEvents: processPendingWcWebhookEvents,
        }),
      ])

      const orderCompletions = await drainOrderCompletions()

      return { connectors: { woocommerce: { ...woocommerce, orderCompletions } } } as Record<string, unknown>
    },
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit())
}
