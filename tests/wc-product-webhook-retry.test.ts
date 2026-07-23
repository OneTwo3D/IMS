import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-i0y: a product webhook whose import fails used to log a WARNING but still return HTTP 200, so the
// webhook inbox marked the event terminally PROCESSED and never retried it — and because the shared
// last_wc_product_sync_at cursor only advances on success (a later successful webhook moves it past the
// failed product), the poll path couldn't recover it either; only the slow reconcile did. The handler
// must now return a retryable 5xx on failure (assertSuccessfulResponse treats >= 500 as retryable).

const syncResult = { current: { success: true, error: undefined as string | undefined } }
const upsertCalls: unknown[] = []

mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: {
    syncWcProductToIms: async () => syncResult.current,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {} },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { upsert: async (args: unknown) => { upsertCalls.push(args) } },
      product: { findFirst: async () => null },
    },
  },
})

// A minimal syncable product payload with NO stock_quantity, so only the product-import path runs.
const productPayload = { id: 42, sku: 'SKU-42', type: 'simple', name: 'Widget', status: 'publish' }

// handleProductWebhook is private; drive it through the exported entry point with resource 'products'.
async function processProduct(payload: unknown) {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({ resource: 'products', topic: 'product.updated', payload })
}

test('a product import FAILURE returns a retryable 500 so the inbox retries (o3d-i0y)', async () => {
  syncResult.current = { success: false, error: 'db connection reset' }
  const response = await processProduct(productPayload)
  assert.equal(response.status, 500, 'failure is a retryable 5xx, not a 200 ack')
  const body = await response.json()
  assert.equal(body.ok, false)
})

test('a successful product import returns 200 and advances the shared cursor (o3d-i0y)', async () => {
  syncResult.current = { success: true, error: undefined }
  upsertCalls.length = 0
  const response = await processProduct(productPayload)
  assert.equal(response.status, 200, 'success acks 200')
  assert.equal(upsertCalls.length, 1, 'the last_wc_product_sync_at cursor is advanced on success')
})
