import assert from 'node:assert/strict'
import test from 'node:test'
import * as efNs from '../lib/fulfillment/external-fulfillment.ts'

const { shouldPushStorefrontCompletion } = 'default' in efNs
  ? (efNs.default as typeof import('../lib/fulfillment/external-fulfillment.ts'))
  : efNs

// G5: a WMS dispatch that fully ships the order must push the storefront status to
// completed so the storefront fires its customer despatch email (AST emails on the
// →completed transition). Idempotent — safe even while the WMS also pushes completed
// today; correct once IMS becomes the sole integration.

test('pushes storefront completion for a WMS dispatch that just brought the order to SHIPPED', () => {
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'SHIPPED'), true)
  assert.equal(shouldPushStorefrontCompletion('shiphero', 'SHIPPED', 'SHIPPED'), true)
})

test('does NOT push for COMPLETED/DELIVERED (no WC status mapping → would silently no-op)', () => {
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'COMPLETED'), false)
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'DELIVERED'), false)
})

test('does NOT push for a storefront-sourced update (storefront is already the source of truth)', () => {
  assert.equal(shouldPushStorefrontCompletion('woocommerce', 'SHIPPED', 'SHIPPED'), false)
})

test('does NOT push for a non-SHIPPED target (PICKING/PACKED)', () => {
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'PACKED', 'SHIPPED'), false)
})

test('does NOT push when the order is not yet fully shipped (partial dispatch)', () => {
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'ALLOCATED'), false)
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'PROCESSING'), false)
})
