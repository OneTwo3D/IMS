import assert from 'node:assert/strict'
import test from 'node:test'

import { buildImsToWcProductPayload, resolveWcSalePriceUpdate } from '@/lib/connectors/woocommerce/sync/product-sync'

test('an empty WooCommerce sale_price CLEARS the IMS sale price', () => {
  assert.equal(resolveWcSalePriceUpdate(''), null)
  assert.equal(resolveWcSalePriceUpdate('  '), null)
})

test('a live sale price is applied', () => {
  assert.equal(resolveWcSalePriceUpdate('15.50'), 15.5)
  assert.equal(resolveWcSalePriceUpdate(15), 15)
})

test('an absent or unparseable field leaves IMS alone', () => {
  assert.equal(resolveWcSalePriceUpdate(undefined), undefined)
  assert.equal(resolveWcSalePriceUpdate(null), undefined)
  assert.equal(resolveWcSalePriceUpdate('abc'), undefined)
})

test('after the clear, the next IMS push sends an empty sale_price, not the stale discount', () => {
  const cleared = resolveWcSalePriceUpdate('')
  const payload = buildImsToWcProductPayload({
    name: 'x', lifecycleStatus: 'ACTIVE', salesPriceBase: 20, salePriceBase: cleared ?? null, barcode: null,
  })
  assert.equal(payload.sale_price, '')
})
