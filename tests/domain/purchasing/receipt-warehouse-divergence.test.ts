import assert from 'node:assert/strict'
import test from 'node:test'

import { findDivergentReceiptLines } from '@/lib/domain/purchasing/receipt-warehouse-divergence'

test('flags lines received into a warehouse other than the PO destination', () => {
  const divergent = findDivergentReceiptLines({
    destinationWarehouseId: 'wh-main',
    lines: [
      { poLineId: 'l1', warehouseId: 'wh-main' },
      { poLineId: 'l2', warehouseId: 'wh-other' },
    ],
  })
  assert.deepEqual(divergent, [{ poLineId: 'l2', receivedWarehouseId: 'wh-other', destinationWarehouseId: 'wh-main' }])
})

test('no divergence when all lines match the destination', () => {
  assert.deepEqual(findDivergentReceiptLines({
    destinationWarehouseId: 'wh-main',
    lines: [{ poLineId: 'l1', warehouseId: 'wh-main' }],
  }), [])
})

test('no divergence when the PO has no destination set', () => {
  assert.deepEqual(findDivergentReceiptLines({
    destinationWarehouseId: null,
    lines: [{ poLineId: 'l1', warehouseId: 'wh-anywhere' }],
  }), [])
})

test('ignores lines with no warehouse chosen (handled by the required-warehouse guard)', () => {
  assert.deepEqual(findDivergentReceiptLines({
    destinationWarehouseId: 'wh-main',
    lines: [{ poLineId: 'l1', warehouseId: '' }],
  }), [])
})

test('no divergence when destinationWarehouseId is undefined', () => {
  assert.deepEqual(findDivergentReceiptLines({
    destinationWarehouseId: undefined,
    lines: [{ poLineId: 'l1', warehouseId: 'wh-anywhere' }],
  }), [])
})
