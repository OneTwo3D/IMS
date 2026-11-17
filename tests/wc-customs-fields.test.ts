import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractWcCustomsFields } from '@/lib/connectors/woocommerce/sync/customs-fields'

const attr = (name: string, option: string) => ({ name, options: [option] })

test('native fields win over attributes', () => {
  const r = extractWcCustomsFields({
    customs_commodity_code: '85011099',
    customs_country_of_origin: 'CN',
    customs_description: 'stepper motor',
    attributes: [attr('HS Code', '11111111'), attr('Country of Origin', 'DE'), attr('Customs Description', 'old text')],
  })
  assert.deepEqual(r, { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'stepper motor' })
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
  assert.deepEqual(r, { hsCode: '3926909090', countryOfOrigin: 'CN', customsDescription: 'plastic bracket' })
})

test('nothing supplied yields nulls', () => {
  assert.deepEqual(extractWcCustomsFields({}), { hsCode: null, countryOfOrigin: null, customsDescription: null })
})

test('variation in view context: the inherited parent value reads like a native value', () => {
  const variation = { customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'inherited', attributes: [] }
  assert.deepEqual(extractWcCustomsFields(variation), { hsCode: '85011099', countryOfOrigin: 'CN', customsDescription: 'inherited' })
})
