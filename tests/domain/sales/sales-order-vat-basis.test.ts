import assert from 'node:assert/strict'
import test from 'node:test'

import { inclusivePricesWithoutOrderRate, storedAmountsIncludeVat } from '@/lib/domain/sales/sales-order-vat-basis'

// [mutation: drop the pricesIncludeVat clause, or read a 0 / null / undefined header rate as "has a rate"]
test('inclusive prices, no default rate, a line carrying VAT is the contradictory combination', () => {
  for (const orderRate of [0, null, undefined]) {
    assert.equal(inclusivePricesWithoutOrderRate({ pricesIncludeVat: true, orderRate, anyLineCarriesVat: true }), true, String(orderRate))
  }
})

test('every other combination is fine', () => {
  assert.equal(inclusivePricesWithoutOrderRate({ pricesIncludeVat: true, orderRate: 0.2, anyLineCarriesVat: true }), false, 'a default rate chosen')
  assert.equal(inclusivePricesWithoutOrderRate({ pricesIncludeVat: true, orderRate: 0, anyLineCarriesVat: false }), false, 'no line carries VAT: gross = net')
  assert.equal(inclusivePricesWithoutOrderRate({ pricesIncludeVat: false, orderRate: 0, anyLineCarriesVat: true }), false, 'exclusive prices are net whatever the header says')
})

// [mutation: follow the flag for a WooCommerce order, or ignore the flag for a manual one]
test('the stored-amount basis: a WooCommerce-linked order is net whatever its display flag says; any other order follows its flag', () => {
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: true, shoppingLinks: [{ connector: 'woocommerce' }] }), false)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: false, shoppingLinks: [{ connector: 'woocommerce' }] }), false)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: true, shoppingLinks: [] }), true)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: true }), true)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: true, shoppingLinks: null }), true)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: false, shoppingLinks: [] }), false)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: null }), false)
  assert.equal(storedAmountsIncludeVat({ pricesIncludeVat: true, shoppingLinks: [{ connector: 'other' }] }), true, 'only WooCommerce stores net under a gross flag')
})
