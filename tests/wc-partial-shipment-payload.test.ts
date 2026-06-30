import assert from 'node:assert/strict'
import test from 'node:test'
import * as partialShipmentNs from '../lib/connectors/woocommerce/sync/partial-shipment.ts'

const partialShipment = 'default' in partialShipmentNs
  ? partialShipmentNs.default as typeof import('../lib/connectors/woocommerce/sync/partial-shipment.ts')
  : partialShipmentNs

const { buildPartialShipmentBody } = partialShipment

// buildPartialShipmentBody is the WMS-neutral wire contract IMS posts to the
// onetwoInventory Helper plugin's oti/v1 partial-shipment route. Pin the shape
// (snake_case field names) and the SKU/qty normalisation.

test('buildPartialShipmentBody emits the snake_case wire shape the PHP handler expects', () => {
  const body = JSON.parse(buildPartialShipmentBody({
    part: 1,
    totalParts: 3,
    trackingNumber: 'TN-A',
    shipmentNum: 'MS-100',
    items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }],
  }))
  assert.deepEqual(body, {
    part: 1,
    total_parts: 3,
    tracking_number: 'TN-A',
    shipment_num: 'MS-100',
    items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }],
  })
})

test('buildPartialShipmentBody defaults tracking/shipment to empty strings and truncates qty/part', () => {
  const body = JSON.parse(buildPartialShipmentBody({
    part: 2.9,
    totalParts: 3.1,
    items: [{ sku: 'A', qty: 2.7 }],
  }))
  assert.equal(body.tracking_number, '')
  assert.equal(body.shipment_num, '')
  assert.equal(body.part, 2)
  assert.equal(body.total_parts, 3)
  assert.equal(body.items[0].qty, 2)
})

test('buildPartialShipmentBody drops blank SKUs and non-positive quantities', () => {
  const body = JSON.parse(buildPartialShipmentBody({
    part: 1,
    totalParts: 2,
    items: [
      { sku: ' A ', qty: 1 },
      { sku: '', qty: 5 },
      { sku: 'B', qty: 0 },
      { sku: 'C', qty: -3 },
      { sku: 'D', qty: 0.5 }, // floors to 0 → dropped (not silently passed to PHP)
    ],
  }))
  assert.deepEqual(body.items, [{ sku: 'A', qty: 1 }])
})
