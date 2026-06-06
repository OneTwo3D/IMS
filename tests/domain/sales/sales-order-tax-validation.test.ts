import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expectedSalesOrderLineTaxForeign,
  validateSalesOrderLineTaxInputs,
} from '@/lib/domain/sales/sales-order-tax-validation'

test('sales order tax validation accepts correct tax-inclusive line tax', () => {
  const line = {
    sku: 'INC-20',
    qty: 2,
    unitPriceForeign: 60,
    discountAmount: 0,
    taxRateValue: 0.2,
    taxForeign: 20,
  }

  assert.equal(expectedSalesOrderLineTaxForeign(line, true).toFixed(4), '20.0000')
  assert.deepEqual(validateSalesOrderLineTaxInputs([line], true), { success: true })
})

test('sales order tax validation rejects incorrect tax-inclusive line tax', () => {
  const result = validateSalesOrderLineTaxInputs([{
    sku: 'INC-BAD',
    qty: 2,
    unitPriceForeign: 60,
    discountAmount: 0,
    taxRateValue: 0.2,
    taxForeign: 24,
  }], true)

  assert.deepEqual(result, {
    success: false,
    error: 'Line tax for INC-BAD does not match tax-inclusive pricing: expected 20.0000, received 24.0000',
  })
})

test('sales order tax validation accepts correct tax-exclusive line tax', () => {
  const line = {
    sku: 'EXC-20',
    qty: 2,
    unitPriceForeign: 50,
    discountAmount: 0,
    taxRateValue: 0.2,
    taxForeign: 20,
  }

  assert.equal(expectedSalesOrderLineTaxForeign(line, false).toFixed(4), '20.0000')
  assert.deepEqual(validateSalesOrderLineTaxInputs([line], false), { success: true })
})

test('sales order tax validation rejects incorrect tax-exclusive line tax', () => {
  const result = validateSalesOrderLineTaxInputs([{
    sku: 'EXC-BAD',
    qty: 2,
    unitPriceForeign: 50,
    discountAmount: 0,
    taxRateValue: 0.2,
    taxForeign: 16.67,
  }], false)

  assert.deepEqual(result, {
    success: false,
    error: 'Line tax for EXC-BAD does not match tax-exclusive pricing: expected 20.0000, received 16.6700',
  })
})

test('sales order tax validation rejects discounts above line total', () => {
  const result = validateSalesOrderLineTaxInputs([{
    sku: 'DISC-BAD',
    qty: 1,
    unitPriceForeign: 10,
    discountAmount: 11,
    taxRateValue: 0.2,
    taxForeign: 0,
  }], true)

  assert.deepEqual(result, {
    success: false,
    error: 'Discount exceeds line total for DISC-BAD',
  })
})
