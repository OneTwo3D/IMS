import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildShipheroDeepLink,
  humanizeShipheroStatus,
  mapShipheroOrderStatus,
  pickShipheroOrderNode,
  readShipheroTracking,
} from '../lib/connectors/shiphero/api/orders.ts'

const TEMPLATE = 'https://app.shiphero.com/dashboard/orders/details/{id}'

test('humanizeShipheroStatus title-cases snake_case and normalises the cancel spelling', () => {
  assert.equal(humanizeShipheroStatus('partially_fulfilled'), 'Partially Fulfilled')
  assert.equal(humanizeShipheroStatus('fulfilled'), 'Fulfilled')
  assert.equal(humanizeShipheroStatus('canceled'), 'Canceled')
  assert.equal(humanizeShipheroStatus('cancelled'), 'Canceled') // British spelling
  assert.equal(humanizeShipheroStatus(''), 'Unknown')
  assert.equal(humanizeShipheroStatus(null), 'Unknown')
})

test('buildShipheroDeepLink substitutes/encodes {id}; null without the placeholder', () => {
  assert.equal(buildShipheroDeepLink(TEMPLATE, '42'), 'https://app.shiphero.com/dashboard/orders/details/42')
  assert.equal(buildShipheroDeepLink(TEMPLATE, 'a b'), 'https://app.shiphero.com/dashboard/orders/details/a%20b')
  assert.equal(buildShipheroDeepLink('https://x/orders/none', '42'), null)
  assert.match(buildShipheroDeepLink('', '42') ?? '', /42$/) // empty → default (carries {id})
})

test('readShipheroTracking maps shipment fields and skips empty rows', () => {
  assert.deepEqual(
    readShipheroTracking([{ tracking_number: '1Z999', shipping_carrier: 'UPS', created_date: '2026-06-26' }]),
    [{ trackingNumber: '1Z999', carrier: 'UPS', despatchedAt: '2026-06-26' }],
  )
  assert.deepEqual(readShipheroTracking([{}]), []) // nothing useful → dropped
  assert.deepEqual(readShipheroTracking([{ carrier: 'DPD' }]), [{ trackingNumber: null, carrier: 'DPD', despatchedAt: null }])
})

test('pickShipheroOrderNode prefers the exact order_number, else the first', () => {
  const nodes = [{ order_number: 'SO-9', id: '1' }, { order_number: 'SO-1', id: '2' }]
  assert.equal((pickShipheroOrderNode(nodes, 'SO-1') as { id: string }).id, '2')
  assert.equal((pickShipheroOrderNode(nodes, 'SO-MISSING') as { id: string }).id, '1') // fallback to first
  assert.equal(pickShipheroOrderNode([], 'SO-1'), null)
})

test('mapShipheroOrderStatus builds the chip status, split derived from shipments', () => {
  const node = {
    id: 'sh-100',
    legacy_id: 100,
    order_number: 'SO-1',
    fulfillment_status: 'partially_fulfilled',
    shipments: {
      edges: [
        { node: { tracking_number: '1Z1', shipping_carrier: 'UPS', created_date: '2026-06-25' } },
        { node: { tracking_number: '1Z2', shipping_carrier: 'UPS', created_date: '2026-06-26' } },
      ],
    },
  }
  const status = mapShipheroOrderStatus(node, TEMPLATE, 'SO-1')
  assert.ok(status)
  assert.equal(status.externalOrderId, 'sh-100')
  assert.equal(status.externalOrderNumber, 'SO-1')
  assert.equal(status.status, 'partially_fulfilled')
  assert.equal(status.statusLabel, 'Partially Fulfilled')
  assert.equal(status.isSplit, true) // 2 shipments
  assert.equal(status.partCount, 2)
  assert.equal(status.isMerged, false)
  assert.equal(status.deepLinkUrl, 'https://app.shiphero.com/dashboard/orders/details/sh-100')
  assert.equal(status.tracking.length, 2)
})

test('mapShipheroOrderStatus returns null for a node with no id, single shipment → not split', () => {
  assert.equal(mapShipheroOrderStatus({ order_number: 'SO-1' }, TEMPLATE, 'SO-1'), null)
  const single = mapShipheroOrderStatus({ id: 'x', fulfillment_status: 'fulfilled', shipments: { edges: [{ node: { tracking_number: 'T' } }] } }, TEMPLATE, 'SO-2')
  assert.equal(single?.isSplit, false)
  assert.equal(single?.partCount, 1)
  assert.equal(single?.externalOrderNumber, 'SO-2') // falls back to the reference
})
