import assert from 'node:assert/strict'
import test from 'node:test'

import { ProductType } from '@/app/generated/prisma/client'
import { productSchema } from '@/lib/products/product-schema'

// bhdm.7 r5: the product server-action schema is the real trust boundary (FormData is client-controlled). It
// must normalise + validate countryOfOrigin regardless of what the dropdown offers.
const base = { sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE }

function parseOrigin(value: unknown): string | null {
  return productSchema.parse({ ...base, countryOfOrigin: value }).countryOfOrigin
}

test('a recognised country is normalised to canonical uppercase ISO-2 (bhdm.7)', () => {
  assert.equal(parseOrigin('GB'), 'GB')
  assert.equal(parseOrigin('ad'), 'AD', 'lowercase is canonicalised (no erase-on-edit on the next save)')
  assert.equal(parseOrigin('md'), 'MD')
  assert.equal(parseOrigin('united kingdom'), 'GB')
  assert.equal(parseOrigin('USA'), 'US')
})

test('blank / absent origin is null (bhdm.7)', () => {
  assert.equal(parseOrigin(''), null)
  assert.equal(parseOrigin('   '), null)
  assert.equal(parseOrigin(null), null)
  assert.equal(parseOrigin(undefined), null)
})

test('a nonblank reserved / invalid origin is REJECTED, never stored verbatim (bhdm.7 r5)', () => {
  for (const bad of ['EU', 'UN', 'ZZ', 'SU', 'XA', '!!', 'Narnia']) {
    assert.throws(() => parseOrigin(bad), /Unrecognised country of origin/, `${bad} must be rejected`)
  }
})
