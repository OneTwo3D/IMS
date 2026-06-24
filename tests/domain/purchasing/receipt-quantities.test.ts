import assert from 'node:assert/strict'
import test from 'node:test'

import { sumReceiptQtyByPoLine } from '@/lib/domain/purchasing/receipt-quantities'

test('sums receipt qty per PO line across warehouse rows (mgyk)', () => {
  const byLine = sumReceiptQtyByPoLine([
    { poLineId: 'a', qtyReceived: 6 },
    { poLineId: 'a', qtyReceived: 8 }, // same line, different warehouse row
    { poLineId: 'b', qtyReceived: 3 },
  ])
  // The split line sums to 14 — the caller compares this against outstanding, so two
  // rows of 6+8 against outstanding 10 is now correctly rejected.
  assert.equal(byLine.get('a')?.toNumber(), 14)
  assert.equal(byLine.get('b')?.toNumber(), 3)
  assert.equal(byLine.size, 2)
})

test('sums decimals exactly — 0.1 + 0.2 is 0.3, not 0.30000000000000004 (mgyk)', () => {
  const byLine = sumReceiptQtyByPoLine([
    { poLineId: 'a', qtyReceived: 0.1 },
    { poLineId: 'a', qtyReceived: 0.2 },
  ])
  // A legitimate decimal split must not be falsely rejected against an outstanding of 0.3.
  assert.equal(byLine.get('a')?.toString(), '0.3')
  assert.equal(byLine.get('a')?.greaterThan(0.3), false)
})

test('returns an empty map for no lines', () => {
  assert.equal(sumReceiptQtyByPoLine([]).size, 0)
})

test('a single row per line passes through unchanged', () => {
  const byLine = sumReceiptQtyByPoLine([
    { poLineId: 'x', qtyReceived: 5 },
    { poLineId: 'y', qtyReceived: 2 },
  ])
  assert.equal(byLine.get('x')?.toNumber(), 5)
  assert.equal(byLine.get('y')?.toNumber(), 2)
})
