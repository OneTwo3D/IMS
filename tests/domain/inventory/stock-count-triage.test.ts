import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_SMALL_VARIANCE,
  classifyVariance,
  filterByTab,
  isBulkAcceptable,
  isZeroVariance,
  parseSmallVarianceThreshold,
  parseVarianceSort,
  parseVarianceTab,
  sortTriaged,
  tabCounts,
  triageLine,
  type TriageLineInput,
} from '@/lib/domain/inventory/stock-count-triage'

const line = (sku: string, expectedQty: number, countedQty: number | null, unitCost: number | null = null): TriageLineInput =>
  ({ id: `l-${sku}`, sku, expectedQty, countedQty, unitCost })

test('classifyVariance: the default threshold treats nothing as small', () => {
  assert.equal(classifyVariance(10, 10, NO_SMALL_VARIANCE), 'NONE')
  assert.equal(classifyVariance(9, 10, NO_SMALL_VARIANCE), 'REVIEW')
  assert.equal(classifyVariance(9.9999, 10, NO_SMALL_VARIANCE), 'REVIEW')
  assert.equal(classifyVariance(null, 10, NO_SMALL_VARIANCE), 'UNCOUNTED')
})

test('classifyVariance: an absolute quantity threshold, both directions, boundary inclusive', () => {
  const t = { qty: 2, pct: 0 }
  assert.equal(classifyVariance(8, 10, t), 'SMALL')
  assert.equal(classifyVariance(12, 10, t), 'SMALL')
  assert.equal(classifyVariance(7, 10, t), 'REVIEW')
  assert.equal(classifyVariance(10, 10, t), 'NONE', 'zero is never small')
})

test('classifyVariance: a percentage threshold is of on-hand; nothing on hand has no percentage', () => {
  const t = { qty: 0, pct: 10 }
  assert.equal(classifyVariance(91, 100, t), 'SMALL')
  assert.equal(classifyVariance(89, 100, t), 'REVIEW')
  assert.equal(classifyVariance(1, 0, t), 'REVIEW')
  assert.equal(classifyVariance(0, 0, t), 'NONE')
})

test('classifyVariance: with both criteria set a line must meet both', () => {
  const t = { qty: 5, pct: 10 }
  assert.equal(classifyVariance(96, 100, t), 'SMALL')
  assert.equal(classifyVariance(94, 100, t), 'REVIEW', 'inside 10% but over 5 units')
  assert.equal(classifyVariance(2, 4, t), 'REVIEW', 'inside 5 units but 50%')
})

test('isZeroVariance: exact at 6dp, no float wobble', () => {
  assert.equal(isZeroVariance(0.1 + 0.2, 0.3), true)
  assert.equal(isZeroVariance(10, 10.000001), false)
})

test('tabs: each line lands in exactly one tab, uncounted lines only under All lines', () => {
  const t = { qty: 1, pct: 0 }
  const lines = [line('A', 10, 10), line('B', 10, 9), line('C', 10, 5), line('D', 10, null), line('E', 4, 4)].map((l) => triageLine(l, t))
  assert.deepEqual(tabCounts(lines), { ALL: 5, NONE: 2, SMALL: 1, REVIEW: 1 })
  assert.deepEqual(filterByTab(lines, 'NONE').map((l) => l.line.sku), ['A', 'E'])
  assert.deepEqual(filterByTab(lines, 'SMALL').map((l) => l.line.sku), ['B'])
  assert.deepEqual(filterByTab(lines, 'REVIEW').map((l) => l.line.sku), ['C'])
  assert.equal(filterByTab(lines, 'ALL').length, 5)
})

test('sort: default keeps the given order; quantity sorts by absolute variance, largest first, uncounted last', () => {
  const lines = [line('A', 10, 9), line('B', 10, 15), line('C', 10, null), line('D', 10, 10), line('E', 10, 2)].map((l) => triageLine(l, NO_SMALL_VARIANCE))
  assert.deepEqual(sortTriaged(lines, 'DEFAULT').map((l) => l.line.sku), ['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual(sortTriaged(lines, 'QTY').map((l) => l.line.sku), ['E', 'B', 'A', 'D', 'C'])
})

test('sort: value sorts by absolute value; lines with no cost follow the costed ones, by quantity', () => {
  const lines = [
    line('A', 10, 9, 100), // -1 x 100 = -100
    line('B', 10, 20, 1), // +10 x 1 = 10
    line('C', 10, 0, null), // -10, no cost
    line('D', 10, 12, 20), // +2 x 20 = 40
    line('E', 10, 10, 50), // 0
  ].map((l) => triageLine(l, NO_SMALL_VARIANCE))
  assert.deepEqual(sortTriaged(lines, 'VALUE').map((l) => l.line.sku), ['A', 'D', 'B', 'E', 'C'])
  assert.equal(lines[0]!.varianceValue, -100)
  assert.equal(lines[2]!.varianceValue, null)
})

test('sort: ties break on SKU so the order is stable', () => {
  const lines = [line('B', 10, 8), line('A', 10, 12)].map((l) => triageLine(l, NO_SMALL_VARIANCE))
  assert.deepEqual(sortTriaged(lines, 'QTY').map((l) => l.line.sku), ['A', 'B'])
})

test('URL parsing: unknown values fall back to the view as it was', () => {
  assert.equal(parseVarianceTab('none'), 'NONE')
  assert.equal(parseVarianceTab('review'), 'REVIEW')
  assert.equal(parseVarianceTab('bogus'), 'ALL')
  assert.equal(parseVarianceTab(undefined), 'ALL')
  assert.equal(parseVarianceSort('qty'), 'QTY')
  assert.equal(parseVarianceSort('value'), 'VALUE')
  assert.equal(parseVarianceSort('x'), 'DEFAULT')
})

test('parseSmallVarianceThreshold: blank is not set; negatives, NaN and oversize are refused', () => {
  assert.deepEqual(parseSmallVarianceThreshold({ qty: '', pct: null }), { ok: true, value: { qty: 0, pct: 0 } })
  assert.deepEqual(parseSmallVarianceThreshold({ qty: '2.5', pct: 10 }), { ok: true, value: { qty: 2.5, pct: 10 } })
  assert.equal(parseSmallVarianceThreshold({ qty: -1, pct: 0 }).ok, false)
  assert.equal(parseSmallVarianceThreshold({ qty: 'abc', pct: 0 }).ok, false)
  assert.equal(parseSmallVarianceThreshold({ qty: 0, pct: 101 }).ok, false)
})

test('isBulkAcceptable: no-variance mode takes only exact zero; small mode takes only small', () => {
  const t = { qty: 2, pct: 0 }
  assert.equal(isBulkAcceptable('NO_VARIANCE', 10, 10, t), true)
  assert.equal(isBulkAcceptable('NO_VARIANCE', 9, 10, t), false)
  assert.equal(isBulkAcceptable('NO_VARIANCE', null, 10, t), false)
  assert.equal(isBulkAcceptable('SMALL_VARIANCE', 9, 10, t), true)
  assert.equal(isBulkAcceptable('SMALL_VARIANCE', 10, 10, t), false)
  assert.equal(isBulkAcceptable('SMALL_VARIANCE', 5, 10, t), false)
  assert.equal(isBulkAcceptable('SMALL_VARIANCE', 9, 10, NO_SMALL_VARIANCE), false)
})

test('triageLine: variance at 4dp and value at pence, exact (no float drift), negative rounds away from zero', () => {
  const t = triageLine(line('A', 10, 10.3, 0.1), NO_SMALL_VARIANCE)
  assert.equal(t.variance, 0.3)
  assert.equal(t.varianceValue, 0.03)
  assert.equal(triageLine(line('B', 1, 0, 1.005), NO_SMALL_VARIANCE).varianceValue, -1.01)
  assert.equal(triageLine(line('C', 0.1 + 0.2, 0.3, 5), NO_SMALL_VARIANCE).varianceClass, 'NONE')
})
