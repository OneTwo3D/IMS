import assert from 'node:assert/strict'
import test from 'node:test'
import { imsRateToXeroCurrencyRate } from '../lib/connectors/xero/fx.ts'

test('inverts IMS fxRateToBase into Xero CurrencyRate', () => {
  // Base GBP, document EUR. IMS stores 1 GBP = 1.18 EUR.
  // Xero expects 1 EUR = X GBP → 1 / 1.18 ≈ 0.847458 (6dp).
  const got = imsRateToXeroCurrencyRate(1.18)
  assert.equal(got, 0.847458)
})

test('passes through 1.0 unchanged for same-currency invoices', () => {
  assert.equal(imsRateToXeroCurrencyRate(1), 1)
})

test('rounds to 6 decimal places to match Xero Decimal(18,6) schema', () => {
  // 1 / 3 = 0.333... → must be 6dp, not full float precision.
  const got = imsRateToXeroCurrencyRate(3)
  assert.equal(got, 0.333333)
})

test('handles JPY-scale rates (very small inverted rate) without underflow', () => {
  // Base GBP, doc JPY. 1 GBP ≈ 190 JPY → 1/190 ≈ 0.005263 (6dp).
  // Make sure the rate doesn't get rounded to 0 or to a wrong order of magnitude.
  const got = imsRateToXeroCurrencyRate(190)
  assert.equal(got, 0.005263)
})

test('returns undefined for missing, zero, negative, and non-finite rates', () => {
  assert.equal(imsRateToXeroCurrencyRate(undefined), undefined)
  assert.equal(imsRateToXeroCurrencyRate(null), undefined)
  assert.equal(imsRateToXeroCurrencyRate(0), undefined)
  assert.equal(imsRateToXeroCurrencyRate(-1.5), undefined)
  assert.equal(imsRateToXeroCurrencyRate(NaN), undefined)
  assert.equal(imsRateToXeroCurrencyRate(Infinity), undefined)
})
