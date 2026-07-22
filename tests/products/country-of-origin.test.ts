import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCsvCountryOfOrigin } from '@/lib/products/country-of-origin'

test('a valid CSV country is normalised to ISO-2 (bhdm.7)', () => {
  assert.equal(normalizeCsvCountryOfOrigin('GB'), 'GB')
  assert.equal(normalizeCsvCountryOfOrigin('united kingdom'), 'GB')
  assert.equal(normalizeCsvCountryOfOrigin('  us  '), 'US')
  assert.equal(normalizeCsvCountryOfOrigin('germany'), 'DE')
})

test('an absent, blank, or unrecognised origin yields null — never a silent default (bhdm.7)', () => {
  assert.equal(normalizeCsvCountryOfOrigin(null), null)
  assert.equal(normalizeCsvCountryOfOrigin(undefined), null)
  assert.equal(normalizeCsvCountryOfOrigin(''), null)
  assert.equal(normalizeCsvCountryOfOrigin('   '), null)
  assert.equal(normalizeCsvCountryOfOrigin('Narnia'), null)
})
