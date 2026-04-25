import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWcReconcile } from '@/lib/connectors/woocommerce/sync/reconcile'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

// Called by cron with Authorization: Bearer $CRON_SECRET.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  if (!(await isIntegrationPluginEnabled('woocommerce'))) {
    return NextResponse.json({ skipped: true, reason: 'Shopping plugin disabled' })
  }

  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'WC sync disabled' })
  }

  return NextResponse.json(await runWcReconcile())
}
