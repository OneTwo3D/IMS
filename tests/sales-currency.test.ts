import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateOrderDiscountBase, normalizeLineDiscountBase, normalizeOrderDiscountBase } from '../lib/sales-currency.ts'

test('line discounts use the line tax rate for VAT-inclusive sales orders', () => {
  const order = {
    fxRateToBase: 1,
    pricesIncludeVat: true,
    taxRatePercent: 0.2,
    shoppingLinks: [],
  }

  assert.equal(normalizeLineDiscountBase(order, 12, 0.2), 10)
  assert.equal(normalizeLineDiscountBase(order, 10, 0), 10)
})

test('line discounts fall back to the order tax rate when the line rate is missing', () => {
  const order = {
    fxRateToBase: 1,
    pricesIncludeVat: true,
    taxRatePercent: 0.2,
    shoppingLinks: [],
  }

  assert.equal(normalizeLineDiscountBase(order, 12), 10)
})

test('order discounts are split by mixed line VAT rates for VAT-inclusive sales orders', () => {
  const order = {
    fxRateToBase: 1,
    pricesIncludeVat: true,
    taxRatePercent: 0.2,
    discountAmount: 22,
    shoppingLinks: [],
  }
  const lines = [
    { totalBase: 100, taxRate: { rate: 0.2 } },
    { totalBase: 100, taxRate: { rate: 0 } },
  ]

  assert.equal(normalizeOrderDiscountBase(order, lines), 20)
  assert.deepEqual(allocateOrderDiscountBase(order, lines), [10, 10])
})

test('order discount allocations preserve rounded total on uneven mixed-rate lines', () => {
  const order = {
    fxRateToBase: 1,
    pricesIncludeVat: true,
    taxRatePercent: 0.2,
    discountAmount: 10,
    shoppingLinks: [],
  }
  const lines = [
    { totalBase: 33.33, taxRate: { rate: 0.2 } },
    { totalBase: 66.67, taxRate: { rate: 0 } },
  ]
  const allocations = allocateOrderDiscountBase(order, lines)

  assert.equal(allocations.reduce((sum, value) => Math.round((sum + value) * 10000) / 10000, 0), normalizeOrderDiscountBase(order, lines))
})

test('WooCommerce discounts are already net for reporting normalization', () => {
  const order = {
    fxRateToBase: 2,
    pricesIncludeVat: true,
    taxRatePercent: 0.2,
    discountAmount: 20,
    shoppingLinks: [{ connector: 'woocommerce' }],
  }

  assert.equal(normalizeOrderDiscountBase(order, [{ totalBase: 100, taxRate: { rate: 0.2 } }]), 10)
  assert.equal(normalizeLineDiscountBase(order, 20, 0.2), 10)
})
