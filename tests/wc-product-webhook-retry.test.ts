import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-i0y: a product webhook whose import fails used to log a WARNING but still return HTTP 200, so the
// webhook inbox marked the event terminally PROCESSED and never retried it — and because the shared
// last_wc_product_sync_at cursor only advances on success (a later successful webhook moves it past the
// failed product), the poll path couldn't recover it either; only the slow reconcile did.
//
// The handler now returns a retryable 5xx for a TRANSIENT failure, a 200 ack for a PERMANENT (deterministic)
// conflict, and — crucially — returns BEFORE the best-effort stock correction so a retry can't replay the
// forced stock write.

type SyncResult = { success: boolean; error?: string }
const syncResult = { current: { success: true } as SyncResult }
const upsertCalls: unknown[] = []
const stockEnqueueCalls: unknown[] = []

mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: { syncWcProductToIms: async () => syncResult.current },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {} },
})
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async (...args: unknown[]) => { stockEnqueueCalls.push(args) },
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
  assert.equal(upsertCalls.length, 1, 'the last_wc_product_sync_at cursor is advanced on success')
})

test('a transient failure returns 500 BEFORE the stock correction, so a retry cannot replay it (o3d-i0y)', async () => {
  syncResult.current = { success: false, error: 'db connection reset' }
  stockEnqueueCalls.length = 0
  const response = await processProduct({ ...basePayload, stock_quantity: 7 })
  assert.equal(response.status, 500)
  assert.equal(stockEnqueueCalls.length, 0, 'the forced stock write is not run on a transient product failure')
})
