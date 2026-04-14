import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { syncNewWcOrders } from '@/lib/connectors/woocommerce/sync/order-import'
import { syncAllWcProducts } from '@/lib/connectors/woocommerce/sync/product-sync'
import { processQueuedWcStockSyncJobs } from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'

// Called by cron: curl http://localhost:3000/api/cron/wc-sync
export async function GET(request: Request) {
  const cronErr = verifyCron(request)
  if (cronErr) return cronErr
  // Check if sync is enabled
  const enabled = await db.setting.findUnique({ where: { key: 'wc_sync_enabled' } })
  if (enabled?.value !== 'true') {
    return NextResponse.json({ skipped: true, reason: 'WC sync disabled' })
  }

  const results: Record<string, unknown> = {}

  // Order sync (always if enabled)
  results.orders = await syncNewWcOrders()

  // Product sync (if enabled)
  const productEnabled = await db.setting.findUnique({ where: { key: 'wc_sync_product_enabled' } })
  if (productEnabled?.value === 'true') {
    const direction = await db.setting.findUnique({ where: { key: 'wc_sync_product_direction' } })
    if (!direction?.value || direction.value === 'from_wc' || direction.value === 'both') {
      results.products = await syncAllWcProducts()
    }
  }

  // Immediate stock updates are event-driven now. This cron only drains any
  // failed or delayed retries left in the durable queue.
  results.stockQueue = await processQueuedWcStockSyncJobs({ limit: 25 })

  return NextResponse.json(results)
}
