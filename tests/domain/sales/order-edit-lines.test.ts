import assert from 'node:assert/strict'
import test from 'node:test'
import { matchContinuedOrderLines } from '@/lib/domain/sales/order-edit-lines'

const saved = [
  { id: 'L1', productId: 'A' },
  { id: 'L2', productId: 'B' },
  { id: 'L3', productId: 'B' },
  { id: 'L4', productId: null },
]

test('a line naming its saved line continues it, whatever the order of the edit', () => {
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'B', orderLineId: 'L3' }, { productId: 'A', orderLineId: 'L1' }]), ['L3', 'L1'])
})

test('a line without an id continues the first unclaimed saved line of the same product; a product the order never had is new', () => {
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'B' }, { productId: 'B' }, { productId: 'B' }, { productId: 'C' }]), ['L2', 'L3', null, null])
})

test('an explicit id is claimed first, so an id-less line of the same product cannot take it', () => {
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'B' }, { productId: 'B', orderLineId: 'L2' }]), ['L3', 'L2'])
})

test('a named line of another product, another order, or one already claimed is NOT continued (never a mis-match)', () => {
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'B', orderLineId: 'L1' }]), [null], 'wrong product')
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'A', orderLineId: 'other-order-line' }]), [null], 'not this order')
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: 'A', orderLineId: 'L1' }, { productId: 'A', orderLineId: 'L1' }]), ['L1', null], 'claimed twice')
})

test('a saved line without a product is never continued', () => {
  assert.deepEqual(matchContinuedOrderLines(saved, [{ productId: '', orderLineId: 'L4' }]), [null])
})
