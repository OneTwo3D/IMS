import assert from 'node:assert/strict'
import test from 'node:test'

import { isStageBoundImsWebhook } from '../../e2e/full-chain/harness/quiesce.ts'

/**
 * o3d-f737. Disabling stage's IMS SETTINGS never stopped WooCommerce delivering to it — the webhooks
 * live in Woo, so every order the suite creates still fanned a delivery at a stage that could not accept
 * it. Those failures retry ahead of this run's own deliveries, and Woo DISABLES a hook after enough of
 * them; stage's order.updated hook had already been auto-disabled that way.
 *
 * This predicate decides what gets paused for the run window, and every case below is a safety
 * property: it must hit stage, and NOTHING else that happens to share the store.
 */

const STAGE_HOST = 'ims-stage.onetwo3d.co.uk'

test('stage\'s own IMS delivery hook is the one paused', () => {
  assert.equal(
    isStageBoundImsWebhook('https://ims-stage.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', STAGE_HOST),
    true,
  )
})

test('PRODUCTION is never paused to tidy a test environment', () => {
  // The lock coordinates exactly two instances, but the Woo store can carry hooks for others. Selecting
  // "any host that is not e2e" would take a live import down to run a test suite — which is what the
  // first version of this did (Codex, round 1).
  assert.equal(
    isStageBoundImsWebhook('https://ims.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', STAGE_HOST),
    false,
  )
})

test('the run\'s OWN delivery hook is never paused', () => {
  // Pausing these is self-sabotage: nothing would be delivered and every test would time out on an
  // empty inbox — the exact failure this module asserts against on the way in.
  assert.equal(
    isStageBoundImsWebhook('https://ims-e2e.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', STAGE_HOST),
    false,
  )
})

test('third-party hooks are never touched, however they are addressed', () => {
  // The module's standing rule: Qoblex/ecartapi hooks belong to someone else's integration.
  for (const url of [
    'https://api.ecartapi.com/api/v2/webhooks/actions/cUVyTGtUVjgxNzc2Nzc5OTM0MDEw',
    'https://qoblex.example.com/hooks/orders',
    // Stage's host but NOT our route — another connector's inbound hook is not ours to switch off.
    'https://ims-stage.onetwo3d.co.uk/api/webhooks/shopping/shopify/orders',
  ]) {
    assert.equal(isStageBoundImsWebhook(url, STAGE_HOST), false, url)
  }
})

test('host matching is exact, not substring', () => {
  // "ims-stage.onetwo3d.co.uk".includes("stage.onetwo3d.co.uk") is TRUE — a substring test would pause
  // a hook belonging to a differently-named instance that merely ends the same way.
  assert.equal(
    isStageBoundImsWebhook('https://ims-stage-2.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', STAGE_HOST),
    false,
  )
  assert.equal(
    isStageBoundImsWebhook('https://ims-stage.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/products', STAGE_HOST),
    true,
  )
})

test('an unparseable delivery url is left alone rather than switched off on a guess', () => {
  assert.equal(isStageBoundImsWebhook('not a url/api/webhooks/shopping/woocommerce', STAGE_HOST), false)
})
