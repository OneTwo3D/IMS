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

// ---- explicit clears ----

const HELD = { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Cotton widget' }

test('an explicit WC clear nulls the IMS value', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(HELD, EMPTY, ['hsCode', 'customsDescription'])
  assert.deepEqual(changes, [
    { field: 'hsCode', from: '90211000', to: null },
    { field: 'customsDescription', from: 'Cotton widget', to: null },
  ])
})

test('without a clear, an absent/invalid WC value changes nothing (key absent, or rejected)', () => {
  assert.deepEqual(productSync.resolveWcTradeFieldUpdates(HELD, EMPTY, []), [])
  assert.deepEqual(productSync.resolveWcTradeFieldUpdates(HELD, EMPTY), [])
})

test('a clear of an already-empty IMS field is no change', () => {
  assert.deepEqual(productSync.resolveWcTradeFieldUpdates(EMPTY, EMPTY, ['hsCode']), [])
})

test('a usable incoming value beats a clear for the same field', () => {
  const changes = productSync.resolveWcTradeFieldUpdates(HELD, { ...EMPTY, hsCode: '90219000' }, ['hsCode'])
  assert.deepEqual(changes, [{ field: 'hsCode', from: '90211000', to: '90219000' }])
})

test('a variation inheriting a populated parent is not cleared (inherited value fills the field)', () => {
  // variation's own value empty + cleared, but the parent supplies the code: the merged snapshot carries it.
  const changes = productSync.resolveWcTradeFieldUpdates(HELD, { ...HELD, hsCode: '90211000' }, [])
  assert.deepEqual(changes, [])
})

test('variation: only the variation own marker clears; parent-only marker and present-but-invalid never do', () => {
  const none = { hsCode: null, countryOfOrigin: null, customsDescription: null }
  const invalidOwn = { cleared: [] as never[], rejected: [{ field: 'hsCode' as const, value: '850110' }] }
  assert.deepEqual(productSync.resolveVariationCleared(invalidOwn, { cleared: ['hsCode'], rejected: [] }, none), [])
  // parent-only marker: the variation may hold its own IMS value, so nothing is cleared
  assert.deepEqual(productSync.resolveVariationCleared({ cleared: [], rejected: [] }, { cleared: ['hsCode'], rejected: [] }, none), [])
  // the variation's own marker clears
  assert.deepEqual(productSync.resolveVariationCleared({ cleared: ['hsCode'], rejected: [] }, { cleared: ['hsCode'], rejected: [] }, none), ['hsCode'])
  assert.deepEqual(productSync.resolveVariationCleared({ cleared: ['hsCode'], rejected: [] }, {}, none), ['hsCode'])
  assert.deepEqual(productSync.resolveVariationCleared({ cleared: ['hsCode'], rejected: [] }, {}, { ...none, hsCode: '90211000' }), [])
  assert.deepEqual(productSync.resolveVariationCleared({ cleared: [], rejected: [] }, { cleared: [], rejected: [] }, none), [])
})
