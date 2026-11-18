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

test('variation: a parent clear clears the variations that held the value by inheritance, never one with its own value', () => {
  const none = { hsCode: null, countryOfOrigin: null, customsDescription: null }
  const own = { cleared: [] as never[], rejected: [] }
  const parentCleared = { cleared: ['hsCode' as const], rejected: [] }
  // held by inheritance on the previous import: cleared
  assert.deepEqual(productSync.resolveVariationCleared(own, parentCleared, none, ['hsCode']), ['hsCode'])
  // a different field was inherited: nothing for hsCode
  assert.deepEqual(productSync.resolveVariationCleared(own, parentCleared, none, ['countryOfOrigin']), [])
  // never recorded as inherited (it had its own value, or the record predates the flag): kept
  assert.deepEqual(productSync.resolveVariationCleared(own, parentCleared, none, []), [])
  // the parent is not cleared: nothing, however it was held
  assert.deepEqual(productSync.resolveVariationCleared(own, { cleared: [], rejected: [] }, none, ['hsCode']), [])
  // the variation still shows a value (its own after all): kept
  assert.deepEqual(productSync.resolveVariationCleared(own, parentCleared, { ...none, hsCode: '90211000' }, ['hsCode']), [])
  // a present-but-unusable parent value blocks the clear
  assert.deepEqual(productSync.resolveVariationCleared(own, { cleared: ['hsCode'], rejected: [{ field: 'hsCode', value: '85' }] }, none, ['hsCode']), [])
})

test('variation inheritance is recorded per field at import', () => {
  const none = { hsCode: null, countryOfOrigin: null, customsDescription: null }
  const parent = { hsCode: '90211000', countryOfOrigin: 'CN', customsDescription: 'Part' }
  // REST shows the parent value on an inheriting variation: equal to the parent's is inherited; different or parent-less is its own
  assert.deepEqual(productSync.resolveVariationInherited({ ...parent }, parent, [], []), ['hsCode', 'countryOfOrigin', 'customsDescription'])
  assert.deepEqual(productSync.resolveVariationInherited({ hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: null }, parent, [], []), ['countryOfOrigin', 'customsDescription'])
  assert.deepEqual(productSync.resolveVariationInherited({ ...none, hsCode: '85011099' }, none, ['hsCode'], []), [])
  // neither supplies it: the earlier record stands while the IMS value is preserved, and goes once the field is cleared
  assert.deepEqual(productSync.resolveVariationInherited(none, none, ['hsCode'], []), ['hsCode'])
  assert.deepEqual(productSync.resolveVariationInherited(none, none, ['hsCode'], ['hsCode']), [])
})
