import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pendingFxQueueWhere,
  shouldBlockWcTaxRateFallback,
  type WcTaxRateFallbackLine,
} from '@/lib/connectors/woocommerce/sync/order-import'
import { MissingFxRateError, isMissingFxRateError } from '@/lib/connectors/woocommerce/sync/field-mapping'

const baseLine = {
  sku: 'SKU-1',
  productCategory: 'STANDARD',
  externalTaxRateId: null,
  warning: 'fallback',
} satisfies Omit<WcTaxRateFallbackLine, 'taxRateValue' | 'expectedTaxRateValue'>

test('WooCommerce tax fallback blocks non-zero order-default rates', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0.2, expectedTaxRateValue: null }]), true)
})

test('WooCommerce tax fallback allows zero-rated order-default rates but still records them', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0, expectedTaxRateValue: null }]), false)
})

test('WooCommerce tax fallback blocks zero-rate fallback when destination category is taxable', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0, expectedTaxRateValue: 0.19 }]), true)
})

test('WooCommerce tax fallback allows matching destination expected rates', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0.19, expectedTaxRateValue: 0.19 }]), false)
})

test('WooCommerce missing FX errors are distinguishable for retry queues', () => {
  const asOf = new Date('2026-05-01T00:00:00.000Z')
  const error = new MissingFxRateError('Missing GBP FX rate for EUR', 'EUR', asOf)

  assert.equal(isMissingFxRateError(error), true)
  assert.equal(isMissingFxRateError(new Error(error.message)), false)
  assert.equal(error.currency, 'EUR')
  assert.deepEqual(error.asOf, asOf)
})

test('WooCommerce pending FX queue lookup uses structured payload reason, not GBP error text', () => {
  assert.deepEqual(pendingFxQueueWhere('wc-123'), {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    externalId: 'wc-123',
    payload: {
      path: ['reason'],
      equals: 'missing_fx_rate',
    },
  })
})
