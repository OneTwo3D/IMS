import { db } from '@/lib/db'
import { isWcOrderWebhookPrimaryActive, retryHeldWcSalesInvoiceReleases, syncNewWcOrders } from './order-import'
import { isWcProductWebhookPrimaryActive, syncAllWcProducts } from './product-sync'
import { processQueuedWcStockSyncJobs } from './stock-sync-jobs'
import { pushStockToWc } from './stock-sync'

const ORDER_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const PRODUCT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const STOCK_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000

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

  // o3d-k26m.6 round 4: THE DRIVER for a sales invoice held back for its number and not released.
  // A failed release leaves the hold PENDING, and the only other thing that would ever retry it is
  // another import of that order — which happens only if WooCommerce touches the order again, and
  // the number arriving was that touch. This runs on the cron's timer instead, so a hold stuck
  // behind a disconnected accounting connector is picked up when the connector comes back rather
  // than never. Unconditional: it is a database sweep of work already owed, not a WooCommerce call.
  results.heldSalesInvoices = await retryHeldWcSalesInvoiceReleases()

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

  const stockEnabled = await db.setting.findUnique({ where: { key: 'wc_stock_sync_enabled' } })
  if (stockEnabled?.value === 'true') {
    const queued = await processQueuedWcStockSyncJobs({ limit: 100 })
    const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_stock_daily_reconcile_at' } })
    const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
    const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= STOCK_RECONCILE_INTERVAL_MS

    if (reconcileDue) {
      const stock = await pushStockToWc({ forceAll: true, source: 'DAILY_RECONCILIATION' })
      const now = new Date().toISOString()
      await db.setting.upsert({
        where: { key: 'last_wc_stock_daily_reconcile_at' },
        create: { key: 'last_wc_stock_daily_reconcile_at', value: now },
        update: { value: now },
      })
      results.stock = {
        queued,
        sync: stock,
        reconciledAt: now,
      }
    } else {
      results.stock = {
        queued,
        skipped: true,
        reason: 'daily_reconciliation_not_due',
        reconciliationDue: false,
        lastReconciledAt: lastReconcile?.value ?? null,
      }
    }
  }

  return results
}
