import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A daily cron started seconds short of 24 hours after the previous run's stamp and the webhook-primary reconcile skipped, so the
 * order / product / stock reconcile ran on alternate days only. A run within the tolerance of the interval is due.
 */

const settings = new Map<string, string>()
const orderCalls: string[] = []
const productCalls: string[] = []
const stockCalls: unknown[] = []

const fakeDb = {
  $executeRaw: async () => 1,
  $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  setting: {
    findUnique: async (args: { where: { key: string } }) => (settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key) } : null),
    upsert: async (args: { where: { key: string }; update: { value: string } }) => { settings.set(args.where.key, args.update.value); return null },
    deleteMany: async (args: { where: { key: string } }) => { settings.delete(args.where.key); return { count: 1 } },
  },
}

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    isWcOrderWebhookPrimaryActive: async () => true,
    retryHeldWcSalesInvoiceReleases: async () => ({}),
    syncNewWcOrders: async (opts: { mode: string }) => { orderCalls.push(opts.mode); return { synced: 0, skipped: 0, errors: [] } },
    runWcCancellationBackstop: async () => ({ synced: 0, skipped: 0, errors: [] }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: {
    isWcProductWebhookPrimaryActive: async () => true,
    syncAllWcProducts: async (opts: { mode: string }) => { productCalls.push(opts.mode); return {} },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', { namedExports: { processQueuedWcStockSyncJobs: async () => ({ processed: 0 }) } })
mock.module('@/lib/connectors/woocommerce/sync/refund-stock-correction', { namedExports: { queueRefundStockCorrections: async () => ({}) } })
mock.module('@/lib/connectors/woocommerce/sync/stock-sync', {
  namedExports: {
    pushStockToWc: async (args: unknown) => {
      stockCalls.push(args)
      return { synced: 0, skipped: 0, errors: [], chunk: { nextCursor: null, totalCandidates: 0 } }
    },
  },
})

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function reset(ageMs: number) {
  settings.clear()
  orderCalls.length = 0
  productCalls.length = 0
  stockCalls.length = 0
  settings.set('last_wc_order_reconcile_at', ago(ageMs))
  settings.set('wc_sync_product_enabled', 'true')
  settings.set('last_wc_product_reconcile_at', ago(ageMs))
  settings.set('wc_stock_sync_enabled', 'true')
  settings.set('last_wc_stock_daily_reconcile_at', ago(ageMs))
}

test('a run 5 seconds short of 24 hours after the last stamp reconciles orders, products and stock', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset(24 * 3_600_000 - 5_000)
  await runWcReconcile()
  assert.deepEqual(orderCalls, ['reconcile'])
  assert.deepEqual(productCalls, ['reconcile'])
  assert.equal(stockCalls.length, 1)
})

test('a run well inside the day is still skipped', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset(12 * 3_600_000)
  const results = await runWcReconcile()
  assert.deepEqual(orderCalls, [])
  assert.deepEqual(productCalls, [])
  assert.equal(stockCalls.length, 0)
  assert.equal((results.orders as { skipped?: boolean }).skipped, true)
})
