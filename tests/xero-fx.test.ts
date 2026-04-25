import assert from 'node:assert/strict'
import test from 'node:test'
import { imsRateToXeroCurrencyRate } from '../lib/connectors/xero/fx.ts'

test('inverts IMS fxRateToBase into Xero CurrencyRate', () => {
  // Base GBP, document EUR. IMS stores 1 GBP = 1.18 EUR.
  // Xero expects 1 EUR = X GBP → 1 / 1.18 ≈ 0.84745763.
  const got = imsRateToXeroCurrencyRate(1.18)
  assert.equal(got, 0.84745763)
})

test('passes through 1.0 unchanged for same-currency invoices', () => {
  assert.equal(imsRateToXeroCurrencyRate(1), 1)
})

test('rounds to 8 decimal places to match Decimal(18,8)', () => {
  // 1 / 3 = 0.333... → must be 8dp, not full float precision.
  const got = imsRateToXeroCurrencyRate(3)
  assert.equal(got, 0.33333333)
})

test('returns undefined for missing, zero, negative, and non-finite rates', () => {
  assert.equal(imsRateToXeroCurrencyRate(undefined), undefined)
  assert.equal(imsRateToXeroCurrencyRate(null), undefined)
  assert.equal(imsRateToXeroCurrencyRate(0), undefined)
  assert.equal(imsRateToXeroCurrencyRate(-1.5), undefined)
  assert.equal(imsRateToXeroCurrencyRate(NaN), undefined)
  assert.equal(imsRateToXeroCurrencyRate(Infinity), undefined)
})
