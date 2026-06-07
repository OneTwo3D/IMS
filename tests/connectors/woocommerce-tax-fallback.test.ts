import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldBlockWcTaxRateFallback,
  type WcTaxRateFallbackLine,
} from '@/lib/connectors/woocommerce/sync/order-import'
import { MissingFxRateError, isMissingFxRateError } from '@/lib/connectors/woocommerce/sync/field-mapping'

const baseLine = {
  sku: 'SKU-1',
  productCategory: 'STANDARD',
  externalTaxRateId: null,
  warning: 'fallback',
} satisfies Omit<WcTaxRateFallbackLine, 'taxRateValue'>

test('WooCommerce tax fallback blocks non-zero order-default rates', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0.2 }]), true)
})

test('WooCommerce tax fallback allows zero-rated order-default rates but still records them', () => {
  assert.equal(shouldBlockWcTaxRateFallback([{ ...baseLine, taxRateValue: 0 }]), false)
})

test('WooCommerce missing FX errors are distinguishable for retry queues', () => {
  const asOf = new Date('2026-05-01T00:00:00.000Z')
  const error = new MissingFxRateError('Missing GBP FX rate for EUR', 'EUR', asOf)

  assert.equal(isMissingFxRateError(error), true)
  assert.equal(isMissingFxRateError(new Error(error.message)), false)
  assert.equal(error.currency, 'EUR')
  assert.deepEqual(error.asOf, asOf)
})
