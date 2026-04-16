import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  if (await isIntegrationPluginEnabled('xero')) {
    const [batchEnabled, syncEnabled] = await Promise.all([
      db.setting.findUnique({ where: { key: 'xero_daily_batch_enabled' } }),
      db.setting.findUnique({ where: { key: 'xero_sync_enabled' } }),
    ])
    if (batchEnabled?.value !== 'true') return NextResponse.json({ skipped: true, reason: 'Xero daily batch disabled' })
    if (syncEnabled?.value !== 'true') return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
    const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
    const result = await runDailyBatchSync()
    return NextResponse.json(result)
  }

  if (await isIntegrationPluginEnabled('quickbooks')) {
    const [batchEnabled, syncEnabled] = await Promise.all([
      db.setting.findUnique({ where: { key: 'quickbooks_daily_batch_enabled' } }),
      db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } }),
    ])
    if (batchEnabled?.value !== 'true') return NextResponse.json({ skipped: true, reason: 'QuickBooks daily batch disabled' })
    if (syncEnabled?.value !== 'true') return NextResponse.json({ skipped: true, reason: 'QuickBooks sync disabled' })
    const { runDailyBatchSync } = await import('@/lib/connectors/quickbooks/daily-sync')
    const result = await runDailyBatchSync()
    return NextResponse.json(result)
  }

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled' })
}
