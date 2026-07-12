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
