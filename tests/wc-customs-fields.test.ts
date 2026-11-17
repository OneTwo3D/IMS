import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractWcCustomsFields } from '@/lib/connectors/woocommerce/sync/customs-fields'
import * as productSyncNs from '../lib/connectors/woocommerce/sync/product-sync.ts'

const productSync = 'default' in productSyncNs
  ? productSyncNs.default as typeof import('../lib/connectors/woocommerce/sync/product-sync.ts')
  : productSyncNs

const attr = (name: string, option: string) => ({ name, options: [option] })

test('native fields win over attributes', () => {
  const r = extractWcCustomsFields({
    customs_commodity_code: '85011099',
    customs_country_of_origin: 'CN',
    customs_description: 'stepper motor',
    attributes: [attr('HS Code', '11111111'), attr('Country of Origin', 'DE'), attr('Customs Description', 'old text')],
  })
  assert.deepEqual(r, { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'stepper motor', rejected: [] })
})

test('description falls back to legacy meta when native and attribute are empty', () => {
  const r = extractWcCustomsFields({
    customs_description: '',
    meta_data: [{ key: '_other', value: 'x' }, { key: '_customs_description_legacy', value: '  legacy text  ' }],
  })
  assert.equal(r.customsDescription, 'legacy text')
})

test('legacy description is clamped to 35', () => {
  const r = extractWcCustomsFields({
    meta_data: [{ key: '_customs_description_legacy', value: 'precision brass nozzle for high temperature hotend' }],
  })
  assert.ok((r.customsDescription ?? '').length <= 35)
  assert.ok((r.customsDescription ?? '').length > 0)
})

test('attribute description beats legacy meta', () => {
  const r = extractWcCustomsFields({
    attributes: [attr('customs_description', 'from attribute')],
    meta_data: [{ key: '_customs_description_legacy', value: 'legacy' }],
  })
  assert.equal(r.customsDescription, 'from attribute')
})

test('per-field attribute fallback when native fields are absent', () => {
  const r = extractWcCustomsFields({
    customs_country_of_origin: 'US',
    attributes: [attr('pa_hs_code', 'x'), attr('hs_code', '3926909090'), attr('country_of_origin', 'CN')],
  })
  assert.equal(r.hsCode, '3926909090')
  assert.equal(r.countryOfOrigin, 'US')
  assert.equal(r.customsDescription, null)
})

test('variation attributes carry a singular `option`', () => {
  const r = extractWcCustomsFields({
    attributes: [
      { name: 'hs_code', option: '3926909090' },
      { name: 'country_of_origin', option: 'CN' },
      { name: 'customs_description', option: 'plastic bracket' },
    ],
  })
  assert.deepEqual(r, { hsCode: '3926909090', countryOfOrigin: 'CN', customsDescription: 'plastic bracket', rejected: [] })
})

test('nothing supplied yields nulls', () => {
  assert.deepEqual(extractWcCustomsFields({}), { hsCode: null, countryOfOrigin: null, customsDescription: null, rejected: [] })
})

test('variation in view context: the inherited parent value reads like a native value', () => {
  const variation = { customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'inherited', attributes: [] }
  assert.deepEqual(extractWcCustomsFields(variation), { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'inherited', rejected: [] })
})

test('unmappable native origin falls back to a valid attribute', () => {
  const r = extractWcCustomsFields({
    customs_country_of_origin: 'Atlantis',
    attributes: [attr('Country of Origin', 'Germany')],
  })
  assert.equal(r.countryOfOrigin, 'DE')
  assert.deepEqual(r.rejected, [{ field: 'countryOfOrigin', value: 'Atlantis' }])
})

test('unmappable origin with no fallback is absent, not a default', () => {
  const r = extractWcCustomsFields({ customs_country_of_origin: 'Atlantis' })
  assert.equal(r.countryOfOrigin, null)
})

test('6-digit native code is unusable and the valid 8-digit IMS code is preserved', () => {
  const r = extractWcCustomsFields({ customs_commodity_code: '850110' })
  assert.equal(r.hsCode, null)
  assert.deepEqual(r.rejected, [{ field: 'hsCode', value: '850110' }])
  const changes = productSync.resolveWcTradeFieldUpdates(
    { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: null },
    { hsCode: r.hsCode, countryOfOrigin: r.countryOfOrigin, customsDescription: r.customsDescription },
  )
  assert.deepEqual(changes, [])
})

test('6-digit native code falls back to a valid 8-digit attribute', () => {
  const r = extractWcCustomsFields({ customs_commodity_code: '850110', attributes: [attr('HS Code', '8501 1099')] })
  assert.equal(r.hsCode, '85011099')
})

test('native codes with separators normalise; 6-digit, overlong or non-numeric ones are unusable', () => {
  assert.equal(extractWcCustomsFields({ customs_commodity_code: '8501.10.99' }).hsCode, '85011099')
  assert.equal(extractWcCustomsFields({ customs_commodity_code: '8501109900' }).hsCode, '8501109900')
  assert.equal(extractWcCustomsFields({ customs_commodity_code: '850110' }).hsCode, null)
  assert.equal(extractWcCustomsFields({ customs_commodity_code: '850110990011223' }).hsCode, null)
  assert.equal(extractWcCustomsFields({ customs_commodity_code: '8501ABCD' }).hsCode, null)
})

test('description that clamps to nothing falls through to the next source', () => {
  const r = extractWcCustomsFields({
    customs_description: '<>™',
    attributes: [attr('customs_description', 'usable text')],
  })
  assert.equal(r.customsDescription, 'usable text')
})

test('warnings: rejected values and a defaulted origin on a new row', () => {
  const w = productSync.describeWcCustomsWarnings('SKU1', [{ field: 'countryOfOrigin', value: 'Atlantis' }], {
    isNewRow: true,
    resolvedOrigin: null,
  })
  assert.equal(w.length, 2)
  assert.match(w[0], /Atlantis/)
  assert.match(w[1], /default CN/)
  assert.deepEqual(productSync.describeWcCustomsWarnings('SKU1', [], { isNewRow: false, resolvedOrigin: null }), [])
})
