import assert from 'node:assert/strict'
import test from 'node:test'
import * as countriesNs from '../lib/countries.ts'

const countries = 'default' in countriesNs
  ? countriesNs.default as typeof import('../lib/countries.ts')
  : countriesNs

test('DEFAULT_COUNTRY_OF_ORIGIN is a valid ISO that renders as China', () => {
  assert.equal(countries.DEFAULT_COUNTRY_OF_ORIGIN, 'CN')
  assert.equal(countries.countryName(countries.DEFAULT_COUNTRY_OF_ORIGIN), 'China')
  assert.equal(countries.formatCountryDisplay(countries.DEFAULT_COUNTRY_OF_ORIGIN), 'China')
})

test('defaultCountryOfOriginLabel renders the sent-fallback for an unset origin (o3d-vj5)', () => {
  // The UI shows this for a blank origin so display == what customs/WMS actually send
  // (countryOfOrigin ?? DEFAULT_COUNTRY_OF_ORIGIN). Stays in sync with the constant.
  assert.equal(
    countries.defaultCountryOfOriginLabel(),
    `${countries.countryName(countries.DEFAULT_COUNTRY_OF_ORIGIN)} (${countries.DEFAULT_COUNTRY_OF_ORIGIN})`,
  )
  assert.equal(countries.defaultCountryOfOriginLabel(), 'China (CN)')
})
