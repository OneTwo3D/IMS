import assert from 'node:assert/strict'
import test from 'node:test'

import { computeStockCountPostings, makeStockCountReference, type StockCountLineForPost } from '@/lib/domain/inventory/stock-count'

const line = (over: Partial<StockCountLineForPost> & Pick<StockCountLineForPost, 'productId'>): StockCountLineForPost => ({
  lineId: `l-${over.productId}`,
  sku: `SKU-${over.productId}`,
  expectedQty: 0,
  countedQty: null,
  ...over,
})

test('computeStockCountPostings: skips never-counted lines', () => {
  const out = computeStockCountPostings([line({ productId: 'a', expectedQty: 10, countedQty: null })], new Map([['a', 10]]))
  assert.equal(out.length, 0)
})

test('computeStockCountPostings: variance vs snapshot, adjustment vs live book (no drift)', () => {
  const out = computeStockCountPostings(
    [line({ productId: 'a', expectedQty: 10, countedQty: 8 })],
    new Map([['a', 10]]),
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].reportedVariance, -2) // counted - expected snapshot
  assert.equal(out[0].currentBook, 10)
  assert.equal(out[0].adjustmentQty, -2) // counted - live book
})

test('computeStockCountPostings: snapshot-staleness — adjustment targets LIVE book so on-hand ends at counted', () => {
  // Snapshot book was 10; 3 shipped since, so live book is 7. Physical count is 8.
  const out = computeStockCountPostings(
    [line({ productId: 'a', expectedQty: 10, countedQty: 8 })],
    new Map([['a', 7]]),
  )
  assert.equal(out[0].reportedVariance, -2) // count vs snapshot (informational)
  assert.equal(out[0].currentBook, 7)
  assert.equal(out[0].adjustmentQty, 1) // 8 - 7 => +1 brings live book to exactly 8
})

test('computeStockCountPostings: counted == live book => zero adjustment', () => {
  const out = computeStockCountPostings([line({ productId: 'a', expectedQty: 5, countedQty: 5 })], new Map([['a', 5]]))
  assert.equal(out[0].adjustmentQty, 0)
})

test('computeStockCountPostings: missing live book treated as 0', () => {
  const out = computeStockCountPostings([line({ productId: 'a', expectedQty: 0, countedQty: 3 })], new Map())
  assert.equal(out[0].currentBook, 0)
  assert.equal(out[0].adjustmentQty, 3)
})

test('computeStockCountPostings: 6dp rounding on adjustment, 4dp on reported variance', () => {
  const out = computeStockCountPostings(
    [line({ productId: 'a', expectedQty: 1.11111111, countedQty: 2.22222222 })],
    new Map([['a', 1.11111111]]),
  )
  assert.equal(out[0].adjustmentQty, 1.111111) // 6dp
  assert.equal(out[0].reportedVariance, 1.1111) // 4dp
})

test('makeStockCountReference formats SC-YYYYMMDD-XXXX', () => {
  assert.equal(makeStockCountReference(new Date('2026-06-24T10:00:00Z'), 'ab12cd'), 'SC-20260624-AB12')
})
