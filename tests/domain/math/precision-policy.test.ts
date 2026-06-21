import assert from 'node:assert/strict'
import test from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import {
  DOCUMENT_BASE_PRECISION,
  GL_BASE_PRECISION,
  GL_JOURNAL_TOLERANCE,
  GL_LINE_TOLERANCE,
  INVENTORY_COST_PRECISION,
  roundToGlPrecision,
  roundToGlPrecisionNumber,
} from '@/lib/domain/math/precision-policy'

test('canonical precision constants match the documented subledger policy', () => {
  assert.equal(INVENTORY_COST_PRECISION, 6)
  assert.equal(DOCUMENT_BASE_PRECISION, 4)
  assert.equal(GL_BASE_PRECISION, 2)
})

test('roundToGlPrecisionNumber rounds to 2dp HALF_UP for both signs (away from zero on ties)', () => {
  assert.equal(roundToGlPrecisionNumber(0.005), 0.01)
  assert.equal(roundToGlPrecisionNumber(0.004), 0)
  assert.equal(roundToGlPrecisionNumber(2.675), 2.68)
  assert.equal(roundToGlPrecisionNumber(100.123456), 100.12)
  // Negative ties must round AWAY from zero (HALF_UP), not toward +Infinity the
  // way Math.round would (-1.005 -> -1.00). This matters for reversal/credit GL
  // postings (cogs-audit scjz.60a).
  assert.equal(roundToGlPrecisionNumber(-1.005), -1.01)
  assert.equal(roundToGlPrecisionNumber(-0.004), -0)
})

test('roundToGlPrecisionNumber is bit-identical to the Decimal roundToGlPrecision path', () => {
  for (const v of [100.123456, 0.005, 0.004, 2.675, 99.999, 0, -1.005, -2.675, -0.005]) {
    assert.equal(roundToGlPrecisionNumber(v), roundToGlPrecision(v).toNumber(), `value ${v}`)
  }
})

test('roundToGlPrecisionNumber rejects non-finite input', () => {
  assert.throws(() => roundToGlPrecisionNumber(Number.NaN), TypeError)
  assert.throws(() => roundToGlPrecisionNumber(Number.POSITIVE_INFINITY), TypeError)
})

test('roundToGlPrecision rounds a Decimal to the GL precision', () => {
  assert.equal(roundToGlPrecision(toDecimal('100.126')).toString(), '100.13')
  assert.equal(roundToGlPrecision(toDecimal('100.124')).toString(), '100.12')
})

test('reconciliation tolerances are ordered line <= journal and positive', () => {
  assert.ok(GL_LINE_TOLERANCE > 0)
  assert.ok(GL_JOURNAL_TOLERANCE >= GL_LINE_TOLERANCE)
})
