import assert from 'node:assert/strict'
import test from 'node:test'
import { imsRateToQboExchangeRate } from '../lib/connectors/quickbooks/fx.ts'

/**
 * QBO `ExchangeRate` is "the number of home-currency units it takes to equal
 * one unit of currency specified by CurrencyRef" (Intuit API docs). That's
 * `1 doc-currency = X base`, the same direction as Xero's CurrencyRate, so
 * the helper inverts IMS's `fxRateToBase` (1 base = X foreign) the same way.
 */

test('inverts IMS fxRateToBase into QBO ExchangeRate', () => {
  // 1 GBP = 1.18 EUR ⇒ ExchangeRate = 1 / 1.18 ≈ 0.847458 (6dp).
  assert.equal(imsRateToQboExchangeRate(1.18), 0.847458)
})

test('passes through 1.0 unchanged for same-currency invoices', () => {
  assert.equal(imsRateToQboExchangeRate(1), 1)
})

test('rounds to 6dp to match QBO precision', () => {
  assert.equal(imsRateToQboExchangeRate(3), 0.333333)
})

test('returns undefined for missing/zero/negative/non-finite input', () => {
  assert.equal(imsRateToQboExchangeRate(undefined), undefined)
  assert.equal(imsRateToQboExchangeRate(null), undefined)
  assert.equal(imsRateToQboExchangeRate(0), undefined)
  assert.equal(imsRateToQboExchangeRate(-1), undefined)
  assert.equal(imsRateToQboExchangeRate(NaN), undefined)
})
