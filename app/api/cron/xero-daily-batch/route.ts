import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runDailyBatchSync } from '@/lib/connectors/xero/daily-sync'

// Called by cron daily: curl http://localhost:3000/api/cron/xero-daily-batch
export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Check if daily batch is enabled
  const enabled = await db.setting.findUnique({ where: { key: 'xero_daily_batch_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Xero daily batch disabled' })
  }

  // Check Xero connection
  const xeroEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
  if (xeroEnabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
  }

  const result = await runDailyBatchSync()
  return NextResponse.json(result)
}
