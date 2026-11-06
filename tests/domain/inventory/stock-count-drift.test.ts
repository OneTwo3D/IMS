import assert from 'node:assert/strict'
import test from 'node:test'

import { describeStockCountDrift, detectStockCountDrift, type StockCountLineForDrift } from '@/lib/domain/inventory/stock-count'

const line = (over: Partial<StockCountLineForDrift> & Pick<StockCountLineForDrift, 'productId'>): StockCountLineForDrift => ({
  lineId: `l-${over.productId}`,
  sku: `SKU-${over.productId}`,
  countedQty: 8,
  reconciledQty: 10,
  ...over,
})

test('detectStockCountDrift: on-hand equal to the stamp is not drift', () => {
  assert.deepEqual(detectStockCountDrift([line({ productId: 'a' })], new Map([['a', 10]])), [])
})

test('detectStockCountDrift: moved on-hand is drift, with earlier, current, counted and revised variance', () => {
  const out = detectStockCountDrift([line({ productId: 'a' })], new Map([['a', 7]]))
  assert.deepEqual(out, [{ lineId: 'l-a', productId: 'a', sku: 'SKU-a', earlierOnHand: 10, currentOnHand: 7, countedQty: 8, revisedVariance: 1 }])
})

test('detectStockCountDrift: a line that was never reconciled is drift, not "unchanged"', () => {
  const out = detectStockCountDrift([line({ productId: 'a', reconciledQty: null })], new Map([['a', 10]]))
  assert.equal(out.length, 1)
  assert.equal(out[0]!.earlierOnHand, null)
  assert.equal(out[0]!.revisedVariance, -2)
})

test('detectStockCountDrift: a product with no stock level reads as 0 on hand', () => {
  assert.deepEqual(detectStockCountDrift([line({ productId: 'a', reconciledQty: 0, countedQty: 0 })], new Map()), [])
  assert.equal(detectStockCountDrift([line({ productId: 'a', reconciledQty: 5 })], new Map()).length, 1)
})

test('detectStockCountDrift: compares at the 6dp scale, so a sub-6dp float wobble is not drift but a real 1e-6 move is', () => {
  assert.deepEqual(detectStockCountDrift([line({ productId: 'a', reconciledQty: 0.1 + 0.2 })], new Map([['a', 0.3]])), [])
  assert.equal(detectStockCountDrift([line({ productId: 'a', reconciledQty: 10 })], new Map([['a', 10.000001]])).length, 1)
})

test('detectStockCountDrift: only the drifted lines are returned', () => {
  const out = detectStockCountDrift(
    [line({ productId: 'a' }), line({ productId: 'b' }), line({ productId: 'c', reconciledQty: null })],
    new Map([['a', 10], ['b', 11], ['c', 10]]),
  )
  assert.deepEqual(out.map((d) => d.productId), ['b', 'c'])
})

test('describeStockCountDrift: names every product with the figures, and says nothing was posted', () => {
  const text = describeStockCountDrift(detectStockCountDrift(
    [line({ productId: 'a' }), line({ productId: 'c', reconciledQty: null })],
    new Map([['a', 7], ['c', 10]]),
  ))
  assert.match(text, /Nothing was posted/)
  assert.match(text, /SKU-a: was 10, now 7, counted 8, revised variance 1/)
  assert.match(text, /SKU-c: not reconciled/)
  assert.match(text, /Counts are preserved/)
})
