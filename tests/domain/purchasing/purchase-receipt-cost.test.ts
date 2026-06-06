import assert from 'node:assert/strict'
import test from 'node:test'

import { assertFinitePurchaseReceiptUnitCost } from '@/lib/domain/purchasing/purchase-receipt-cost'

test('assertFinitePurchaseReceiptUnitCost accepts finite non-negative costs', () => {
  assert.doesNotThrow(() => assertFinitePurchaseReceiptUnitCost(0))
  assert.doesNotThrow(() => assertFinitePurchaseReceiptUnitCost(12.345678))
})

test('assertFinitePurchaseReceiptUnitCost rejects invalid receipt costs before stock writes', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01]) {
    assert.throws(
      () => assertFinitePurchaseReceiptUnitCost(value),
      /unitCostBase must be finite and zero or greater/,
    )
  }
})
