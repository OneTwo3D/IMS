import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-56b: prove the PRODUCTION dispatcher (handleShoppingWebhook) routes a disabled-plugin WooCommerce delivery
// through handleWcWebhook (which verifies + persists it) instead of short-circuiting with a 423 that would leave
// the order to WooCommerce's finite retry. Other connectors still reject with a retryable 423.
let handleWcCalls = 0

mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => ({ woocommerce: false }) },
})
mock.module('@/lib/connectors/woocommerce/webhooks', {
  namedExports: {
    handleWcWebhook: async () => {
      handleWcCalls += 1
      return Response.json({ accepted: true, deferred: true, reason: 'woocommerce_plugin_disabled' }, { status: 202 })
    },
  },
})

import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

/** An id the union does not contain — see the note on the second test. */
const UNREGISTERED_CONNECTOR = 'not-a-registered-connector' as unknown as ShoppingConnectorId

// Lazily imported (tsx -> CJS: no top-level await); the mocks above are registered before any test body runs.
type Dispatcher = (typeof import('@/lib/shopping'))['handleShoppingWebhook']
async function loadDispatcher(): Promise<Dispatcher> {
  return (await import('@/lib/shopping')).handleShoppingWebhook
}

const req = () => new Request('http://localhost/api/webhooks/shopping/woocommerce/orders', { method: 'POST' })

test('a DISABLED WooCommerce plugin still reaches handleWcWebhook (durable persist), not a dispatcher 423 (o3d-56b)', async () => {
  const handleShoppingWebhook = await loadDispatcher()
  handleWcCalls = 0
  const res = await handleShoppingWebhook('woocommerce', 'orders', req(), '{}')
  assert.equal(res.status, 202, 'the disabled WooCommerce plugin is not rejected at the dispatcher')
  assert.equal(handleWcCalls, 1, 'the delivery reaches handleWcWebhook, which verifies + persists it')
  assert.deepEqual(await res.json(), { accepted: true, deferred: true, reason: 'woocommerce_plugin_disabled' })
})

// o3d-remove-parked-connectors: the subject used to be 'shopify', the second REGISTERED connector.
// It is archived, so this now drives an id the union does not contain — which is what the branch
// itself has become: statically unreachable, kept as the default-deny for whatever is registered
// next. Weaker than a second shipped connector, and recorded as such in
// docs/archive/shopify-connector-removal.md.
test('a connector with no durable-persist path still rejects with a retryable 423 (o3d-56b)', async () => {
  const handleShoppingWebhook = await loadDispatcher()
  const res = await handleShoppingWebhook(UNREGISTERED_CONNECTOR, 'orders', req(), '{}')
  assert.equal(res.status, 423, 'connectors without a durable-persist path keep the retryable 423')
})
