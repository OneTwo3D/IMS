import assert from 'node:assert/strict'
import test from 'node:test'

import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { isEmptyShoppingWebhookBodyAllowed } from '@/lib/shopping'

/**
 * AN ID THIS BUILD DOES NOT REGISTER (o3d-remove-parked-connectors). The default-deny case below
 * used to be proved with 'shopify', a real registered connector; Shopify is archived, so the only
 * way left to reach the default-deny is to hand the helper an id the union does not contain. The
 * cast is the point, not a workaround: what is being locked is that the helper ANSWERS FALSE for an
 * id it does not recognise instead of falling off the end of its switch and returning `undefined`.
 * That is a weaker subject than a second shipped connector, and the note in
 * docs/archive/shopify-connector-removal.md records it as such.
 */
const UNREGISTERED_CONNECTOR = 'not-a-registered-connector' as unknown as ShoppingConnectorId

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

test('an id with no empty-body quirk defaults to not-allowed, explicitly false (czuf4)', async () => {
  const req = new Request('https://ims.example.com/api/webhooks/shopping/other/orders', { method: 'POST' })
  const allowed = await isEmptyShoppingWebhookBodyAllowed(UNREGISTERED_CONNECTOR, req)
  assert.equal(allowed, false)
  // `undefined` is falsy and would pass a bare `assert.equal(allowed, false)` only by coercion —
  // assert the type too, because falling off the switch is exactly the regression this guards.
  assert.equal(typeof allowed, 'boolean')
})
