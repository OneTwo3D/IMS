import assert from 'node:assert/strict'
import test from 'node:test'
import * as trackingSyncNs from '../lib/connectors/woocommerce/sync/tracking-sync.ts'

const trackingSync = 'default' in trackingSyncNs
  ? trackingSyncNs.default as typeof import('../lib/connectors/woocommerce/sync/tracking-sync.ts')
  : trackingSyncNs

const { toWcTrackingItem, dedupeTrackingRows } = trackingSync

// These two builders are the storefront half of q66in.1.2: once dispatch ingestion
// (q66in.1.1) advances a storefront order to SHIPPED, pushOrderDeliveryMetadata ->
// pushImsTrackingToWc writes the order's tracking into WooCommerce's AST-format
// `_wc_shipment_tracking_items` meta, which is what makes WooCommerce email the
// customer their tracking. These tests pin that mapping so dispatch tracking keeps
// reaching the customer in the shape WC expects.

test('toWcTrackingItem maps a dispatch tracking row to the AST _wc_shipment_tracking_items shape', () => {
  assert.deepEqual(
    toWcTrackingItem({ trackingNumber: 'TN1', carrier: 'DPD', shippedAt: new Date('2026-06-30T10:00:00.000Z') }),
    {
      tracking_provider: 'DPD',
      custom_tracking_provider: 'DPD',
      tracking_number: 'TN1',
      date_shipped: String(Math.floor(new Date('2026-06-30T10:00:00.000Z').getTime() / 1000)),
    },
  )
})

test('toWcTrackingItem falls back to a Custom provider when the carrier is unknown', () => {
  const item = toWcTrackingItem({ trackingNumber: 'TN2', carrier: '', shippedAt: new Date('2026-06-30T10:00:00.000Z') })
  assert.equal(item.tracking_provider, 'Custom')
  assert.equal(item.custom_tracking_provider, undefined)
  assert.equal(item.tracking_number, 'TN2')
})

test('dedupeTrackingRows collapses duplicate number|carrier rows and drops empty tracking numbers', () => {
  const shippedAt = new Date('2026-06-30T10:00:00.000Z')
  assert.deepEqual(
    dedupeTrackingRows([
      { trackingNumber: 'TN1', carrier: 'DPD', shippedAt },
      { trackingNumber: ' tn1 ', carrier: 'dpd', shippedAt },
      { trackingNumber: '', carrier: 'DPD', shippedAt },
      { trackingNumber: 'TN2', carrier: 'Royal Mail', shippedAt },
    ]),
    [
      { trackingNumber: 'TN1', carrier: 'DPD', shippedAt },
      { trackingNumber: 'TN2', carrier: 'Royal Mail', shippedAt },
    ],
  )
})
