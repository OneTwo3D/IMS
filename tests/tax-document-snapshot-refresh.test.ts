import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculatePurchaseLineTaxSnapshot,
  calculateSalesLineTaxSnapshot,
} from '@/lib/tax/document-tax-snapshot-refresh'

test('sales tax snapshot refresh extracts net from tax-inclusive prices at the new rate', () => {
  const refreshed = calculateSalesLineTaxSnapshot({
    qty: '2',
    unitPriceForeign: '12',
    discountAmount: '0',
    fxRateToBase: '1.2',
    pricesIncludeVat: true,
    taxRateValue: '0.2',
  })

  assert.equal(refreshed.totalForeign.toFixed(4), '20.0000')
  assert.equal(refreshed.taxForeign.toFixed(4), '4.0000')
  assert.equal(refreshed.totalBase.toFixed(4), '16.6667')
  assert.equal(refreshed.taxBase.toFixed(4), '3.3333')
})

test('purchase tax snapshot refresh keeps the net line total and recalculates tax only', () => {
  const refreshed = calculatePurchaseLineTaxSnapshot({
    totalForeign: '100',
    fxRateToBase: '1.25',
    taxRateValue: '0.05',
  })

  assert.equal(refreshed.taxForeign.toFixed(4), '5.0000')
  assert.equal(refreshed.taxBase.toFixed(4), '4.0000')
})
