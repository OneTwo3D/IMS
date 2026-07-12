import assert from 'node:assert/strict'
import test from 'node:test'

import { isEmptyShoppingWebhookBodyAllowed } from '@/lib/shopping'

/**
 * czuf4: the per-connector "is an empty webhook body acceptable?" rule is connector-owned
 * and dispatched generically, so the shopping webhook route no longer hardcodes any
 * connector's quirks. This locks that contract: WooCommerce's ping / signed-action quirk
 * is allowed; a signed real WC webhook is not; other connectors default to not-allowed.
 */

function wcRequest(headers: Record<string, string>): Request {
  return new Request('https://ims.example.com/api/webhooks/shopping/woocommerce/orders', {
    method: 'POST',
    headers,
  })
}

test('WooCommerce: unsigned empty-body ping is allowed (czuf4)', async () => {
  assert.equal(await isEmptyShoppingWebhookBodyAllowed('woocommerce', wcRequest({})), true)
})

test('WooCommerce: signed action.* hook may have an empty body (czuf4)', async () => {
  const req = wcRequest({ 'x-wc-webhook-signature': 'sig', 'x-wc-webhook-topic': 'action.woocommerce_x' })
  assert.equal(await isEmptyShoppingWebhookBodyAllowed('woocommerce', req), true)
})

test('WooCommerce: a signed real webhook must NOT have an empty body (czuf4)', async () => {
  const req = wcRequest({ 'x-wc-webhook-signature': 'sig', 'x-wc-webhook-topic': 'order.updated' })
  assert.equal(await isEmptyShoppingWebhookBodyAllowed('woocommerce', req), false)
})

test('Shopify (and connectors without an empty-body quirk) default to not-allowed (czuf4)', async () => {
  const req = new Request('https://ims.example.com/api/webhooks/shopping/shopify/orders', { method: 'POST' })
  assert.equal(await isEmptyShoppingWebhookBodyAllowed('shopify', req), false)
})
