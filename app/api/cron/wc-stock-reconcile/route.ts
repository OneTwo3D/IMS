import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { pushStockToWc } from '@/lib/connectors/woocommerce/sync/stock-sync'
import { processQueuedWcStockSyncJobs } from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'

export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr

  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'WC sync disabled' })
  }

  const queued = await processQueuedWcStockSyncJobs({ limit: 100 })
  const stock = await pushStockToWc({ forceAll: true, source: 'DAILY_RECONCILIATION' })

  const now = new Date().toISOString()
  await db.setting.upsert({
    where: { key: 'last_wc_stock_daily_reconcile_at' },
    create: { key: 'last_wc_stock_daily_reconcile_at', value: now },
    update: { value: now },
  })

  return NextResponse.json({ queued, stock })
}
