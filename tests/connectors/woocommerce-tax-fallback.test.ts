import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPendingFxOrderPayload,
  isQueuedWcOrderPayload,
  pendingFxQueueWhere,
  shouldBlockWcTaxRateFallback,
  type WcTaxRateFallbackLine,
} from '@/lib/connectors/woocommerce/sync/order-import'
import { MissingFxRateError, isMissingFxRateError } from '@/lib/connectors/woocommerce/sync/field-mapping'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

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
  const where = pendingFxQueueWhere('wc-123')

  assert.deepEqual(where, {
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
  assert.equal('errorMessage' in where, false)
})

test('WooCommerce pending FX payload is currency-agnostic and replayable', () => {
  const asOf = new Date('2026-05-01T00:00:00.000Z')
  const order = {
    id: 987,
    number: 'EU-987',
    currency: 'EUR',
  } as WcFullOrder

  const payload = buildPendingFxOrderPayload(order, { currency: 'EUR', asOf })

  assert.deepEqual(payload, {
    reason: 'missing_fx_rate',
    connector: 'woocommerce',
    externalOrderId: '987',
    externalOrderNumber: 'EU-987',
    currency: 'EUR',
    asOf: '2026-05-01T00:00:00.000Z',
    order,
  })
  assert.equal(isQueuedWcOrderPayload(payload), true)
  assert.equal(isQueuedWcOrderPayload({ ...payload, reason: 'Missing GBP FX rate for EUR' }), false)
  assert.equal(isQueuedWcOrderPayload({ ...payload, connector: 'shopify' }), false)
  assert.equal(isQueuedWcOrderPayload({ ...payload, externalOrderNumber: 123 }), false)
  assert.equal(isQueuedWcOrderPayload({ ...payload, asOf: 0 }), false)
  assert.equal(isQueuedWcOrderPayload({ ...payload, order: { id: '987' } }), false)
})
