import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCsvCountryOfOrigin } from '@/lib/products/country-of-origin'

test('a valid CSV country name/alias/code is normalised to ISO-2 (bhdm.7)', () => {
  assert.equal(normalizeCsvCountryOfOrigin('GB'), 'GB')
  assert.equal(normalizeCsvCountryOfOrigin('united kingdom'), 'GB')
  assert.equal(normalizeCsvCountryOfOrigin('  us  '), 'US')
  assert.equal(normalizeCsvCountryOfOrigin('germany'), 'DE')
})

test('valid ISO-2 codes the curated map omits are still accepted (round-trip safe) — bhdm.7 r2', () => {
  // AD/MD/LI are valid ISO 3166-1 alpha-2 but absent from the small curated COUNTRIES map; they must not be
  // silently discarded, or an export→import round-trip would lose the origin.
  assert.equal(normalizeCsvCountryOfOrigin('AD'), 'AD')
  assert.equal(normalizeCsvCountryOfOrigin('md'), 'MD')
  assert.equal(normalizeCsvCountryOfOrigin('  li '), 'LI')
})

test('an absent, blank, or genuinely unrecognised origin yields null — never a silent default (bhdm.7)', () => {
  assert.equal(normalizeCsvCountryOfOrigin(null), null)
  assert.equal(normalizeCsvCountryOfOrigin(undefined), null)
  assert.equal(normalizeCsvCountryOfOrigin(''), null)
  assert.equal(normalizeCsvCountryOfOrigin('   '), null)
  assert.equal(normalizeCsvCountryOfOrigin('Narnia'), null)
  assert.equal(normalizeCsvCountryOfOrigin('X'), null, 'a single letter is not a valid code')
  assert.equal(normalizeCsvCountryOfOrigin('!!'), null, 'non-letters are not a valid code')
})

test('reserved / pseudo / retired region codes are rejected — not assigned ISO 3166-1 countries (bhdm.7 r3)', () => {
  // Intl.DisplayNames resolves these, but they are not assigned country codes and must not reach WMS/customs.
  for (const code of ['EU', 'UN', 'ZZ', 'XA', 'XB', 'BU', 'SU', 'YU', 'QO']) {
    assert.equal(normalizeCsvCountryOfOrigin(code), null, `${code} is not an assigned ISO 3166-1 alpha-2 country`)
  }
  // XK (Kosovo) is the one intentional user-assigned exception we DO accept.
  assert.equal(normalizeCsvCountryOfOrigin('XK'), 'XK')
})
