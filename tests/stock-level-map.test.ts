import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStockLevelMap,
  filterStockLevelRowsForScope,
  isEmptyStockLevelMapScope,
  normalizeStockLevelMapScope,
  type StockLevelMapRow,
} from '../lib/domain/inventory/stock-level-map.ts'

const rows: StockLevelMapRow[] = [
  { productId: 'product-1', warehouseId: 'warehouse-1', quantity: 10, reservedQty: 2, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
  { productId: 'product-1', warehouseId: 'warehouse-2', quantity: '5.5', reservedQty: '1.25', updatedAt: new Date('2026-01-02T00:00:00.000Z') },
  { productId: 'product-2', warehouseId: 'warehouse-1', quantity: 3, reservedQty: 0, updatedAt: new Date('2026-01-03T00:00:00.000Z') },
  { productId: 'product-3', warehouseId: 'warehouse-1', quantity: '0.3', reservedQty: '0.2', updatedAt: new Date('2026-01-04T00:00:00.000Z') },
]

test('buildStockLevelMap preserves the legacy product and warehouse map shape', () => {
  assert.deepEqual(buildStockLevelMap(rows), {
    'product-1': {
      'warehouse-1': { total: 10, available: 8 },
      'warehouse-2': { total: 5.5, available: 4.25 },
    },
    'product-2': {
      'warehouse-1': { total: 3, available: 3 },
    },
    'product-3': {
      'warehouse-1': { total: 0.3, available: 0.1 },
    },
  })
})

test('scoped stock-level rows produce the same subset as the full map', () => {
  const full = buildStockLevelMap(rows)
  const scoped = buildStockLevelMap(filterStockLevelRowsForScope(rows, {
    productIds: ['product-1'],
    warehouseIds: ['warehouse-2'],
  }))

  assert.deepEqual(scoped, {
    'product-1': {
      'warehouse-2': full['product-1']['warehouse-2'],
    },
  })
})

test('stock-level scope supports updated-since and pagination', () => {
  const scopedRows = filterStockLevelRowsForScope(rows, {
    updatedSince: new Date('2026-01-02T00:00:00.000Z'),
    skip: 1,
    take: 1,
  })

  assert.deepEqual(scopedRows.map((row) => `${row.productId}:${row.warehouseId}`), [
    'product-2:warehouse-1',
  ])
})

test('stock-level scope normalizes duplicate ids and empty scopes', () => {
  assert.deepEqual(normalizeStockLevelMapScope({
    productIds: ['product-1', 'product-1', ''],
    warehouseIds: ['warehouse-1', 'warehouse-1'],
    skip: -2,
    take: 2.8,
  }), {
    productIds: ['product-1'],
    warehouseIds: ['warehouse-1'],
    updatedSince: undefined,
    skip: undefined,
    take: 2,
  })
  assert.equal(isEmptyStockLevelMapScope({ productIds: [] }), true)
  assert.equal(isEmptyStockLevelMapScope({ take: 0 }), true)
})
