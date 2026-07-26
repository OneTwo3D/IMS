import assert from 'node:assert/strict'
import test from 'node:test'

import { isStageBoundImsWebhook } from '../../e2e/full-chain/harness/quiesce.ts'

/**
 * o3d-f737. Disabling stage's IMS SETTINGS does not stop WooCommerce delivering to it — the webhooks
 * live in Woo, so every order the suite creates still fans a delivery at a stage that cannot accept it.
 * Those failures retry ahead of this run's own deliveries, and Woo DISABLES a hook after enough of
 * them; stage's order.updated hook had already been auto-disabled that way.
 *
 * This predicate decides what gets paused for the run window. Both halves are safety properties: never
 * touch a third party's hook, and never pause the hook this run depends on.
 */

const E2E_HOST = 'ims-e2e.onetwo3d.co.uk'

test('a stage-bound IMS hook is ours to pause', () => {
  assert.equal(
    isStageBoundImsWebhook('https://ims-stage.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', E2E_HOST),
    true,
  )
})

test('this run\'s OWN delivery hook is never paused', () => {
  // Pausing these is self-sabotage: nothing would be delivered and every test would time out on an
  // empty inbox, which is the exact failure this module asserts against on the way in.
  assert.equal(
    isStageBoundImsWebhook('https://ims-e2e.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', E2E_HOST),
    false,
  )
})

test('third-party hooks are never touched, however they are addressed', () => {
  // The module's standing rule: Qoblex/ecartapi hooks belong to someone else's integration.
  for (const url of [
    'https://api.ecartapi.com/api/v2/webhooks/actions/cUVyTGtUVjgxNzc2Nzc5OTM0MDEw',
    'https://qoblex.example.com/hooks/orders',
    'https://ims-stage.onetwo3d.co.uk/api/webhooks/shopping/shopify/orders',
  ]) {
    assert.equal(isStageBoundImsWebhook(url, E2E_HOST), false, url)
  }
})

test('host matching is exact, not substring', () => {
  // "ims-e2e.onetwo3d.co.uk".includes("ims.onetwo3d.co.uk") is false — but a substring test pairs these
  // names the wrong way round for other hosts, sparing a hook that should have been paused.
  assert.equal(
    isStageBoundImsWebhook('https://ims.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/orders', E2E_HOST),
    true,
  )
  assert.equal(
    isStageBoundImsWebhook('https://ims-e2e.onetwo3d.co.uk/api/webhooks/shopping/woocommerce/products', E2E_HOST),
    false,
  )
})

test('an unparseable delivery url is left alone rather than switched off on a guess', () => {
  assert.equal(isStageBoundImsWebhook('not a url/api/webhooks/shopping/woocommerce', E2E_HOST), false)
})
