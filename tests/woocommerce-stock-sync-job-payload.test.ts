import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWcStockSyncOutboxPayload,
  parseWcStockSyncPayload,
} from '@/lib/connectors/woocommerce/sync/stock-sync-job-payload'

test('WooCommerce stock outbox payload preserves existing forced jobs', () => {
  const payload = buildWcStockSyncOutboxPayload(
    'product-1',
    'IMS_CHANGE',
    { force: false, webhookQty: null },
    {
      productId: 'product-1',
      reason: 'WC_WEBHOOK',
      force: true,
      webhookQty: 4,
    },
  )

  assert.deepEqual(payload, {
    productId: 'product-1',
    reason: 'IMS_CHANGE',
    force: true,
    webhookQty: null,
  })
})

test('WooCommerce stock outbox payload validates queued payload shape', () => {
  const built = buildWcStockSyncOutboxPayload('product-1', 'WC_WEBHOOK', { force: true, webhookQty: 8 })
  const parsed = parseWcStockSyncPayload({
    id: 'job-1',
    payloadJson: built,
  })

  assert.deepEqual(built, {
    productId: 'product-1',
    reason: 'WC_WEBHOOK',
    force: true,
    webhookQty: 8,
  })
  assert.deepEqual(parsed, built)
  assert.throws(
    () => parseWcStockSyncPayload({ id: 'job-2', payloadJson: { productId: 'product-1', reason: 'BAD' } }),
    /job-2 is invalid: reason/,
  )
})
