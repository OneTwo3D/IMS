import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-i0y: a product webhook whose import fails used to log a WARNING but still return HTTP 200, so the
// webhook inbox marked the event terminally PROCESSED and never retried it — and because the shared
// last_wc_product_sync_at cursor was moved by any later successful webhook (past the failed product), the
// poll path couldn't recover it either; only the slow reconcile did. (That cursor is now sweep-owned.)
//
// The handler now returns a retryable 5xx for a TRANSIENT failure, a 200 ack for a PERMANENT (deterministic)
// conflict, and — crucially — returns BEFORE the best-effort stock correction so a retry can't replay the
// forced stock write.

type SyncResult = { success: boolean; error?: string }
const syncResult = { current: { success: true } as SyncResult }
const upsertCalls: unknown[] = []
const stockEnqueueCalls: unknown[] = []
const stockEnqueue = { error: null as Error | null }

mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: { syncWcProductToIms: async () => syncResult.current },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {} },
})
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async (...args: unknown[]) => { stockEnqueueCalls.push(args); if (stockEnqueue.error) throw stockEnqueue.error },
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        // o3d-wgl6: the handler reads the bound store URL to decide whether the delivery
        // describes THIS store. These tests are about retry classification, so every delivery
        // below names the store that is bound.
        findUnique: async ({ where }: { where: { key: string } }) =>
          where.key === 'wc_url' ? { key: 'wc_url', value: 'https://shop.example.com' } : null,
        upsert: async (args: unknown) => { upsertCalls.push(args) },
      },
      // Any stock-path lookup finds a product, so the stock correction WOULD run if reached.
      product: { findFirst: async () => ({ id: 'prod-1', sku: 'SKU-42' }) },
    },
  },
})

async function processProduct(payload: unknown) {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'products',
    topic: 'product.updated',
    payload,
    originAttestation: 'store:shop.example.com',
  })
}

const basePayload = { id: 42, sku: 'SKU-42', type: 'simple', name: 'Widget', status: 'publish' }

test('a product import failure returns a retryable 500 and does not advance the cursor (o3d-i0y)', async () => {
  syncResult.current = { success: false, error: 'db connection reset' }
  upsertCalls.length = 0
  const response = await processProduct(basePayload)
  assert.equal(response.status, 500, 'failure is a retryable 5xx, not a 200 ack')
  assert.equal(upsertCalls.length, 0, 'the sync cursor is not advanced on failure')
})

test('a successful product import returns 200 and advances the shared cursor (o3d-i0y)', async () => {
  syncResult.current = { success: true }
  upsertCalls.length = 0
  const response = await processProduct(basePayload)
  assert.equal(response.status, 200)
  assert.equal(upsertCalls.length, 1, 'the webhook processed stamp is written on success')
  assert.equal(
    (upsertCalls[0] as { where: { key: string } }).where.key,
    'wc_product_webhook_last_processed_at',
    'and it is the webhook\'s own key, never the sweep-owned last_wc_product_sync_at',
  )
})

test('a transient failure returns 500 BEFORE the stock correction, so a retry cannot replay it (o3d-i0y)', async () => {
  syncResult.current = { success: false, error: 'db connection reset' }
  stockEnqueueCalls.length = 0
  const response = await processProduct({ ...basePayload, stock_quantity: 7 })
  assert.equal(response.status, 500)
  assert.equal(stockEnqueueCalls.length, 0, 'the forced stock write is not run on a transient product failure')
})

test('a stock correction that THROWS after a good import is a retryable 500, not a 200 ack: the store keeps the quantity it sent', async () => {
  syncResult.current = { success: true }
  stockEnqueue.error = new Error('queue down')
  try {
    const response = await processProduct({ ...basePayload, stock_quantity: 7 })
    assert.equal(response.status, 500)
  } finally {
    stockEnqueue.error = null
  }
  assert.equal((await processProduct({ ...basePayload, stock_quantity: 7 })).status, 200)
})
