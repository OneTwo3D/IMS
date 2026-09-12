import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ACME_WMS_ID } from './helpers/fictitious-wms-connector.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'

/**
 * A SECOND REGISTERED CONNECTOR, because the predicate's claim is about REGISTRY MEMBERSHIP
 * (o3d-remove-shiphero round 10). `shouldPushStorefrontCompletion` reads `isWmsConnectorId(source)`,
 * and with one shipped connector every assertion below passes identically against a hardcoded
 * `source === 'mintsoft'` — so nothing could tell the two apart. The branch DELETED the
 * `'shiphero'` case that used to make that distinction and replaced it with a comment asserting the
 * property in prose. A registered id the shipped build does not know restores the distinction.
 */
mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    ...realTypes,
    WMS_CONNECTOR_IDS: ['mintsoft', ACME_WMS_ID],
    isWmsConnectorId: (value: string | null | undefined) => value === 'mintsoft' || value === ACME_WMS_ID,
  },
})

/**
 * Loaded lazily, not statically: `mock.module` only reaches a module that has not been evaluated
 * yet, and top-level `await import` is not available here (the test transform emits CJS).
 */
async function loadPredicate() {
  const efNs = await import('../lib/fulfillment/external-fulfillment.ts')
  const mod = 'default' in efNs
    ? (efNs.default as typeof import('../lib/fulfillment/external-fulfillment.ts'))
    : efNs
  // `source` is widened to `string` because `tsc` sees the SHIPPED source union, and `acme-wms` is
  // deliberately not in it — this build does not ship that connector. The widened id list exists
  // only at runtime, under the `mock.module` above; the same allowance every seam file makes.
  return mod.shouldPushStorefrontCompletion as (
    source: string,
    targetShipmentStatus: Parameters<typeof mod.shouldPushStorefrontCompletion>[1],
    orderStatus: string,
  ) => boolean
}

// G5: a WMS dispatch that fully ships the order must push the storefront status to
// completed so the storefront fires its customer despatch email (AST emails on the
// →completed transition). Idempotent — safe even while the WMS also pushes completed
// today; correct once IMS becomes the sole integration.

test('pushes storefront completion for a WMS dispatch that just brought the order to SHIPPED', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'SHIPPED'), true)
})

test('and for a SECOND registered WMS connector — the predicate reads the registry, not one id', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  // The case that distinguishes `isWmsConnectorId(source)` from `source === 'mintsoft'`. Without it
  // the whole file passes on a one-armed predicate, which is the exact defect the seam suites exist
  // to catch — and this is the one place this branch removed such coverage instead of moving it.
  assert.equal(shouldPushStorefrontCompletion(ACME_WMS_ID, 'SHIPPED', 'SHIPPED'), true)
  // The negative that keeps it honest: an id that is NOT registered is still not a WMS source.
  assert.equal(shouldPushStorefrontCompletion('no-such-wms', 'SHIPPED', 'SHIPPED'), false)
})

test('does NOT push for COMPLETED/DELIVERED (no WC status mapping → would silently no-op)', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'COMPLETED'), false)
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'DELIVERED'), false)
})

test('does NOT push for a storefront-sourced update (storefront is already the source of truth)', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  assert.equal(shouldPushStorefrontCompletion('woocommerce', 'SHIPPED', 'SHIPPED'), false)
})

test('does NOT push for a non-SHIPPED target (PICKING/PACKED)', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'PACKED', 'SHIPPED'), false)
})

test('does NOT push when the order is not yet fully shipped (partial dispatch)', async () => {
  const shouldPushStorefrontCompletion = await loadPredicate()
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'ALLOCATED'), false)
  assert.equal(shouldPushStorefrontCompletion('mintsoft', 'SHIPPED', 'PROCESSING'), false)
})
