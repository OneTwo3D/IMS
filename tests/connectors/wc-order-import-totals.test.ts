import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeWcOrderForeignTotals,
  parseWcMoney,
} from '@/lib/connectors/woocommerce/sync/order-import'

// scjz.62: WooCommerce money is parsed via Decimal and accumulated with addMoney
// (no parseFloat + native `+`), so the foreign AR-control / FX-revaluation amounts
// don't accrue float drift across many tax/line rows before the /fxRate boundary.

test('parseWcMoney parses WC money strings exactly and defaults invalid/empty to 0', () => {
  assert.equal(parseWcMoney('12.34').toFixed(2), '12.34')
  assert.equal(parseWcMoney('0.00').toNumber(), 0)
  assert.equal(parseWcMoney('').toNumber(), 0)
  assert.equal(parseWcMoney(null).toNumber(), 0)
  assert.equal(parseWcMoney(undefined).toNumber(), 0)
  assert.equal(parseWcMoney('not-a-number').toNumber(), 0)
  assert.equal(parseWcMoney(7.5).toFixed(2), '7.50')
})

test('shipping tax accumulates exactly across many rows (no float drift)', () => {
  // Native float: 0.1 summed 10x = 0.9999999999999999. Decimal addMoney = exactly 1.
  const totals = computeWcOrderForeignTotals({
    lines: [],
    shippingTaxForeign: Array.from({ length: 10 }, () => '0.10'),
    orderTotal: '1.00',
    pricesIncludeVat: false,
  })
  assert.equal(totals.taxForeign.toString(), '1')
  assert.equal(totals.totalForeign.toFixed(2), '1.00')
})

test('line tax + shipping tax accumulate without drift', () => {
  const totals = computeWcOrderForeignTotals({
    lines: Array.from({ length: 3 }, () => ({
      qty: 1,
      unitPriceForeign: '10.00',
      discountAmount: '0',
      taxForeign: '0.10',
      taxRateValue: '0',
    })),
    shippingTaxForeign: ['0.10', '0.10'],
    orderTotal: '30.50',
    pricesIncludeVat: false,
  })
  // 3 × 0.10 line tax + 2 × 0.10 shipping tax = 0.50 exactly.
  assert.equal(totals.taxForeign.toFixed(2), '0.50')
  // No VAT extraction: subtotal = 3 × (1 × 10.00 − 0) = 30.00.
  assert.equal(totals.subtotalForeign.toFixed(2), '30.00')
  assert.equal(totals.totalForeign.toFixed(2), '30.50')
})

test('VAT-inclusive subtotal extracts net per line at the line rate', () => {
  // gross 120.00 at 20% VAT → net 100.00.
  const totals = computeWcOrderForeignTotals({
    lines: [
      { qty: 2, unitPriceForeign: '60.00', discountAmount: '0', taxForeign: '20.00', taxRateValue: '0.2' },
    ],
    shippingTaxForeign: [],
    orderTotal: '120.00',
    pricesIncludeVat: true,
  })
  assert.equal(totals.subtotalForeign.toFixed(2), '100.00')
  assert.equal(totals.taxForeign.toFixed(2), '20.00')
})

test('line discount is netted out of the gross before VAT extraction', () => {
  // gross = 1 × 50.00 − 5.00 = 45.00; not VAT-inclusive so subtotal = 45.00.
  const totals = computeWcOrderForeignTotals({
    lines: [
      { qty: 1, unitPriceForeign: '50.00', discountAmount: '5.00', taxForeign: '0', taxRateValue: '0' },
    ],
    shippingTaxForeign: [],
    orderTotal: '45.00',
    pricesIncludeVat: false,
  })
  assert.equal(totals.subtotalForeign.toFixed(2), '45.00')
})
