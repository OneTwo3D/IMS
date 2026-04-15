import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runWcReconcile } from '@/lib/connectors/woocommerce/sync/reconcile'

// Called by cron: curl http://localhost:3000/api/cron/wc-reconcile
export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'WC sync disabled' })
  }

  return NextResponse.json(await runWcReconcile())
}
