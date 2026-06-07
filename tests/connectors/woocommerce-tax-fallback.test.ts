import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldBlockWcTaxRateFallback,
  type WcTaxRateFallbackLine,
} from '@/lib/connectors/woocommerce/sync/order-import'

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
