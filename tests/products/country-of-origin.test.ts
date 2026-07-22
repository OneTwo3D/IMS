import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveImportedCountryOfOriginForCreate,
  resolveImportedCountryOfOriginForUpdate,
} from '@/lib/products/country-of-origin'

test('create: a valid CSV country is imported (normalised to ISO-2) — bhdm.7', () => {
  assert.equal(resolveImportedCountryOfOriginForCreate('GB'), 'GB')
  assert.equal(resolveImportedCountryOfOriginForCreate('united kingdom'), 'GB')
  assert.equal(resolveImportedCountryOfOriginForCreate('  us  '), 'US')
})

test('create: an absent, blank, or unrecognised origin defaults to CN (matches the WMS/customs fallback) — bhdm.7', () => {
  assert.equal(resolveImportedCountryOfOriginForCreate(null), 'CN')
  assert.equal(resolveImportedCountryOfOriginForCreate(undefined), 'CN')
  assert.equal(resolveImportedCountryOfOriginForCreate(''), 'CN')
  assert.equal(resolveImportedCountryOfOriginForCreate('   '), 'CN')
  assert.equal(resolveImportedCountryOfOriginForCreate('Narnia'), 'CN')
})

test('update: only a valid country updates; blank/invalid leaves the existing origin untouched (null) — bhdm.7', () => {
  assert.equal(resolveImportedCountryOfOriginForUpdate('DE'), 'DE')
  assert.equal(resolveImportedCountryOfOriginForUpdate('germany'), 'DE')
  assert.equal(resolveImportedCountryOfOriginForUpdate(''), null)
  assert.equal(resolveImportedCountryOfOriginForUpdate(null), null)
  assert.equal(resolveImportedCountryOfOriginForUpdate('Narnia'), null)
})
