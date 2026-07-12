import assert from 'node:assert/strict'
import test from 'node:test'
import { extractShipheroConnectionNodes } from '../lib/connectors/shiphero/api/client.ts'
import {
  extractShipheroStockLines,
  normalizeShipheroStockLine,
} from '../lib/connectors/shiphero/api/normalizers.ts'
import {
  computeStockDiscrepancies,
  consolidateStockLines,
  hasStockThresholdBreach,
  isBindingDue,
  parseStockThresholds,
  sanitizeStockThresholds,
} from '../lib/domain/wms/stock-sync-helpers.ts'

test('normalizeShipheroStockLine reads sku + on_hand defensively', () => {
  assert.deepEqual(normalizeShipheroStockLine({ sku: 'A', on_hand: 10, available: 8 }), { sku: 'A', quantity: 10, raw: { sku: 'A', on_hand: 10, available: 8 } })
  assert.deepEqual(normalizeShipheroStockLine({ SKU: 'B', quantity_on_hand: '5' })?.quantity, 5) // string coerced, alt keys
  assert.equal(normalizeShipheroStockLine({ on_hand: 3 }), null) // no sku
  assert.equal(normalizeShipheroStockLine({ sku: 'C' }), null) // no quantity
  assert.equal(normalizeShipheroStockLine(null), null)
})

test('extractShipheroConnectionNodes unwraps Relay connections, edges, and plain arrays', () => {
  const connection = { data: { edges: [{ node: { sku: 'A', on_hand: 1 } }, { node: { sku: 'B', on_hand: 2 } }] } }
  assert.deepEqual(extractShipheroConnectionNodes(connection), [{ sku: 'A', on_hand: 1 }, { sku: 'B', on_hand: 2 }])
  assert.deepEqual(extractShipheroConnectionNodes({ edges: [{ node: { sku: 'X', on_hand: 9 } }] }), [{ sku: 'X', on_hand: 9 }])
  assert.deepEqual(extractShipheroConnectionNodes([{ sku: 'Z', on_hand: 4 }]), [{ sku: 'Z', on_hand: 4 }])
  assert.deepEqual(extractShipheroConnectionNodes(null), [])
})

test('extractShipheroStockLines maps a connection end-to-end', () => {
  const data = { data: { edges: [{ node: { sku: 'A', on_hand: 10 } }, { node: { foo: 'bar' } }] } }
  assert.deepEqual(extractShipheroStockLines(extractShipheroConnectionNodes(data)), [{ sku: 'A', quantity: 10, raw: { sku: 'A', on_hand: 10 } }])
})

test('consolidateStockLines sums by SKU and sorts', () => {
  const lines = consolidateStockLines([
    { sku: 'B', quantity: 2, raw: null },
    { sku: 'A', quantity: 3, raw: null },
    { sku: 'B', quantity: 5, raw: null },
  ])
  assert.deepEqual(lines.map((l) => [l.sku, l.quantity]), [['A', 3], ['B', 7]])
})

test('computeStockDiscrepancies finds unmapped / mismatch / missing-in-WMS, skips matches', () => {
  const findings = computeStockDiscrepancies({
    wmsLines: [
      { sku: 'A', quantity: 10, raw: null }, // matches IMS → no finding
      { sku: 'B', quantity: 7, raw: null }, // IMS has 5 → QTY_MISMATCH
      { sku: 'NEW', quantity: 4, raw: null }, // no IMS product → UNMAPPED_SKU
    ],
    productBySku: new Map([['A', { id: 'pA' }], ['B', { id: 'pB' }]]),
    imsQtyByProductId: new Map([['pA', 10], ['pB', 5], ['pC', 9]]), // pC absent from WMS → MISSING_IN_WMS
    imsSkusByProductId: new Map([['pC', 'C']]),
  })
  const byCat = Object.fromEntries(findings.map((f) => [f.category, f]))
  assert.equal(findings.length, 3)
  assert.equal(byCat.QTY_MISMATCH.delta, 2)
  assert.equal(byCat.UNMAPPED_SKU.sku, 'NEW')
  assert.equal(byCat.MISSING_IN_WMS.sku, 'C')
  assert.equal(byCat.MISSING_IN_WMS.imsQty, 9)
})

test('hasStockThresholdBreach honours absolute and percent thresholds', () => {
  assert.equal(hasStockThresholdBreach(100, 105, { absoluteDelta: 5, percentDelta: null }), true)
  assert.equal(hasStockThresholdBreach(100, 104, { absoluteDelta: 5, percentDelta: null }), false)
  assert.equal(hasStockThresholdBreach(100, 115, { absoluteDelta: null, percentDelta: 10 }), true) // 15/115 = 13% ≥ 10%
  assert.equal(hasStockThresholdBreach(100, 105, { absoluteDelta: null, percentDelta: 10 }), false) // 5/105 = 4.8% < 10%
  assert.equal(hasStockThresholdBreach(100, 100, { absoluteDelta: 1, percentDelta: 1 }), false)
})

test('isBindingDue + threshold parsing/sanitising', () => {
  const now = new Date('2026-06-26T01:00:00.000Z')
  assert.equal(isBindingDue(null, 60, now), true) // never synced
  assert.equal(isBindingDue(new Date('2026-06-26T00:30:00.000Z'), 60, now), false) // 30m < 60m
  assert.equal(isBindingDue(new Date('2026-06-26T00:00:00.000Z'), 60, now), true) // 60m elapsed

  assert.deepEqual(parseStockThresholds({ absoluteDelta: 5, percentDelta: '10' }), { absoluteDelta: 5, percentDelta: 10 })
  assert.deepEqual(sanitizeStockThresholds({ absoluteDelta: -3, percentDelta: null }), { absoluteDelta: 0, percentDelta: null }) // negative clamps to 0
  assert.deepEqual(sanitizeStockThresholds({ absoluteDelta: 5 }), { absoluteDelta: 5, percentDelta: null })
  assert.equal(sanitizeStockThresholds({}), null)
  assert.equal(sanitizeStockThresholds(null), null)
})
