import assert from 'node:assert/strict'
import test from 'node:test'

import { inclusivePricesWithoutOrderRate } from '@/lib/domain/sales/sales-order-vat-basis'

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
