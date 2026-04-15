import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runDailyBatchSync } from '@/lib/connectors/xero/daily-sync'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance
  if (!(await isIntegrationPluginEnabled('xero'))) {
    return NextResponse.json({ skipped: true, reason: 'Accounting plugin disabled' })
  }

  const batchEnabled = await db.setting.findUnique({ where: { key: 'xero_daily_batch_enabled' } })
  if (batchEnabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Accounting daily batch disabled' })
  }

  const syncEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (syncEnabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Accounting sync disabled' })
  }

  const result = await runDailyBatchSync()
  return NextResponse.json(result)
}
