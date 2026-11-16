import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summariseFulfilment } from '../lib/domain/sales/fulfilment-summary'
import { packingSlipRefusal, orderPackingSlipAvailable, packingSlipUrl, selectShipmentsForSlip } from '../lib/domain/sales/packing-slip-scope'

test('no summary for statuses that already say it, or with no shipments', () => {
  assert.equal(summariseFulfilment('PROCESSING', ['PENDING']), null)
  assert.equal(summariseFulfilment('SHIPPED', ['SHIPPED']), null)
  assert.equal(summariseFulfilment('ALLOCATED', []), null)
})

test('derives picking, packed and partial dispatch from shipment states', () => {
  assert.equal(summariseFulfilment('ALLOCATED', ['PENDING'])?.label, 'Ready to pick')
  assert.equal(summariseFulfilment('ALLOCATED', ['PENDING', 'PENDING'])?.label, 'Ready to pick (2 parcels)')
  assert.equal(summariseFulfilment('ALLOCATED', ['PICKING', 'PENDING'])?.label, 'Picking (1 of 2 parcels)')
  assert.equal(summariseFulfilment('ALLOCATED', ['PACKED', 'PACKED'])?.label, 'Packed — ready to ship')
  assert.equal(summariseFulfilment('PACKING', ['PACKED', 'PENDING'])?.label, 'Packed 1 of 2 parcels')
  assert.deepEqual(summariseFulfilment('ALLOCATED', ['SHIPPED', 'PACKED', 'PENDING']), { label: 'Partially shipped 1/3', tone: 'partial' })
  assert.equal(summariseFulfilment('ALLOCATED', ['SHIPPED'], 0)?.tone, 'dispatched')
  assert.equal(summariseFulfilment('ALLOCATED', ['SHIPPED'], 0)?.label, 'Dispatched 1/1 parcels')
})

test('packing slip scope helpers', () => {
  assert.equal(packingSlipUrl('o1'), '/api/packing-slip/o1')
  assert.equal(packingSlipUrl('o1', 's 1'), '/api/packing-slip/o1?shipment=s%201')
  assert.equal(orderPackingSlipAvailable('DRAFT'), false)
  assert.equal(orderPackingSlipAvailable('CANCELLED'), false)
  assert.equal(orderPackingSlipAvailable('ALLOCATED'), true)
  const ships = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(selectShipmentsForSlip(ships, undefined), ships)
  assert.deepEqual(selectShipmentsForSlip(ships, 'b'), [{ id: 'b' }])
  assert.equal(selectShipmentsForSlip(ships, 'zzz'), null)
})

test('all parcels shipped but units never shipped is not "Dispatched"', () => {
  assert.deepEqual(summariseFulfilment('ALLOCATED', ['SHIPPED', 'SHIPPED'], 3), { label: 'Partially shipped — 3 still to ship', tone: 'partial' })
  assert.equal(summariseFulfilment('PICKING', ['SHIPPED'], null)?.label, 'All 1 parcels dispatched')
})

test('cancelled orders get no packing slip (route refusal and button rule agree)', () => {
  assert.match(packingSlipRefusal('CANCELLED') ?? '', /cancelled/)
  assert.equal(packingSlipRefusal('ALLOCATED'), null)
  assert.equal(orderPackingSlipAvailable('CANCELLED'), false)
})
