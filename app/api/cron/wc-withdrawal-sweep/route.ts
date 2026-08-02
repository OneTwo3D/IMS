import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { sweepWithdrawalSuppressions } from '@/lib/connectors/woocommerce/sync/withdrawal'

// Called by cron with Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('wc-withdrawal-sweep', { request, max: CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Same kill switches as wc-reconcile. This job calls the WooCommerce API and
  // can import orders, so a stale crontab must not keep it running while
  // synchronisation is deliberately paused.
  if (!(await isIntegrationPluginEnabled('woocommerce'))) {
    return NextResponse.json({ skipped: true, reason: 'Shopping plugin disabled' })
  }
  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'WC sync disabled' })
  }

  const result = await sweepWithdrawalSuppressions()
  return NextResponse.json(result)
}
