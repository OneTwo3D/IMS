import assert from 'node:assert/strict'
import test from 'node:test'
import * as productSyncNs from '../lib/connectors/woocommerce/sync/product-sync.ts'

const productSync = 'default' in productSyncNs
  ? productSyncNs.default as typeof import('../lib/connectors/woocommerce/sync/product-sync.ts')
  : productSyncNs

const EMPTY = { hsCode: null, countryOfOrigin: null, customsDescription: null }

test('WC trade fields overwrite differing IMS values (hs-code-woo re-classification propagates)', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '90200000', countryOfOrigin: 'GB', customsDescription: 'Old customs text' },
    { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'New customs text' },
  )
  assert.deepEqual(changes, [
    { field: 'hsCode', from: '90200000', to: '90211000' },
    { field: 'countryOfOrigin', from: 'GB', to: 'CN' },
    { field: 'customsDescription', from: 'Old customs text', to: 'New customs text' },
  ])
})

test('WC trade fields fill empty IMS values', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(EMPTY, {
    hsCode: '90211000',
    countryOfOrigin: 'CN',
    customsDescription: 'Cotton widget',
  })
  assert.deepEqual(changes, [
    { field: 'hsCode', from: null, to: '90211000' },
    { field: 'countryOfOrigin', from: null, to: 'CN' },
    { field: 'customsDescription', from: null, to: 'Cotton widget' },
  ])
})

test('identical WC and IMS values produce no change (no spurious re-push)', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Cotton widget' },
    { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Cotton widget' },
  )
  assert.deepEqual(changes, [])
})

test('absent WC attribute preserves the existing IMS value (never nulled out)', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Cotton widget' },
    EMPTY,
  )
  assert.deepEqual(changes, [])
})

test('empty-string WC value is treated as absent and preserves the IMS value', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Cotton widget' },
    { hsCode: '', countryOfOrigin: '', customsDescription: '' },
  )
  assert.deepEqual(changes, [])
})

test('only the fields WC actually supplies are changed', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '90200000', countryOfOrigin: 'GB', customsDescription: 'Keep me' },
    { hsCode: '90211000', countryOfOrigin: null, customsDescription: null },
  )
  assert.deepEqual(changes, [{ field: 'hsCode', from: '90200000', to: '90211000' }])
})
