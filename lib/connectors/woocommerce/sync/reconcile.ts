import { db } from '@/lib/db'
import { isWcOrderWebhookPrimaryActive, syncNewWcOrders } from './order-import'
import { isWcProductWebhookPrimaryActive, syncAllWcProducts } from './product-sync'
import { processQueuedWcStockSyncJobs } from './stock-sync-jobs'

const ORDER_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const PRODUCT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function runWcReconcile(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {}

  const webhookPrimaryActive = await isWcOrderWebhookPrimaryActive()
  if (!webhookPrimaryActive) {
    results.orders = await syncNewWcOrders({ mode: 'poll' })
  } else {
    const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_order_reconcile_at' } })
    const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
    const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= ORDER_RECONCILE_INTERVAL_MS

    results.orders = reconcileDue
      ? await syncNewWcOrders({ mode: 'reconcile' })
      : {
          skipped: true,
          reason: 'webhook_primary_active',
          reconciliationDue: false,
          lastReconciledAt: lastReconcile?.value ?? null,
        }
  }

  const productEnabled = await db.setting.findUnique({ where: { key: 'wc_sync_product_enabled' } })
  if (productEnabled?.value === 'true') {
    const direction = await db.setting.findUnique({ where: { key: 'wc_sync_product_direction' } })
    if (!direction?.value || direction.value === 'from_wc' || direction.value === 'both') {
      const productWebhookPrimaryActive = await isWcProductWebhookPrimaryActive()
      if (!productWebhookPrimaryActive) {
        results.products = await syncAllWcProducts({ mode: 'poll' })
      } else {
        const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_product_reconcile_at' } })
        const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
        const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= PRODUCT_RECONCILE_INTERVAL_MS

        results.products = reconcileDue
          ? await syncAllWcProducts({ mode: 'reconcile' })
          : {
              skipped: true,
              reason: 'webhook_primary_active',
              reconciliationDue: false,
              lastReconciledAt: lastReconcile?.value ?? null,
            }
      }
    }
  }

  // Event-driven stock sync remains primary. Reconciliation only drains retries.
  results.stockQueue = await processQueuedWcStockSyncJobs({ limit: 25 })

  return results
}
