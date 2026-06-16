import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pickPrimaryWcCategoryId,
  resolveImsCategoryId,
  type WcCategoryMirror,
} from '@/lib/connectors/woocommerce/sync/category-mirror'

// audit-az15: a WC product with several categories should land in IMS under the
// category the operator marked PRIMARY (Yoast / Rank Math), not an arbitrary deepest.

// Mirror modelled on the real SKU 4923239082: 34 "3D Printer Model" (root, depth 0)
// and 233 "Hotends" (child, depth 1, the primary). 35 is mapped but not primary.
const mirror: WcCategoryMirror = {
  wcToIms: new Map([[34, 'ims-3dmodel'], [233, 'ims-hotends'], [35, 'ims-voron24']]),
  wcDepth: new Map([[34, 0], [233, 1], [35, 0]]),
}

test('pickPrimaryWcCategoryId reads the Yoast primary product-category meta', () => {
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: '233' }]), 233)
})

test('pickPrimaryWcCategoryId reads the Rank Math primary product-category meta', () => {
  assert.equal(pickPrimaryWcCategoryId([{ key: 'rank_math_primary_product_cat', value: 233 }]), 233)
})

test('pickPrimaryWcCategoryId ignores brand-primary, blank, and non-numeric values', () => {
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_pwb-brand', value: '290' }]), null)
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: '' }]), null)
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: 'abc' }]), null)
  assert.equal(pickPrimaryWcCategoryId(undefined), null)
  assert.equal(pickPrimaryWcCategoryId(null), null)
  assert.equal(pickPrimaryWcCategoryId([]), null)
})

test('pickPrimaryWcCategoryId guards numeric edge cases', () => {
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: '0' }]), null) // not > 0
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: null }]), null)
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: '233.0' }]), null) // decimal string
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: '9007199254740993' }]), null) // unsafe int
  assert.equal(pickPrimaryWcCategoryId([{ key: '_yoast_wpseo_primary_product_cat', value: ' 233 ' }]), 233) // padded ok
})

test('pickPrimaryWcCategoryId: Yoast wins over Rank Math when both are present', () => {
  assert.equal(pickPrimaryWcCategoryId([
    { key: 'rank_math_primary_product_cat', value: '35' },
    { key: '_yoast_wpseo_primary_product_cat', value: '233' },
  ]), 233)
})

test('resolveImsCategoryId ignores a stale primary not in the product categories', () => {
  // Meta says primary 233 (mirrored) but the product is only in 34 + 35 now.
  const categories = [{ id: 34 }, { id: 35 }]
  const meta = [{ key: '_yoast_wpseo_primary_product_cat', value: '233' }]
  assert.equal(resolveImsCategoryId(categories, meta, mirror), 'ims-3dmodel') // deepest of 34/35
})

test('resolveImsCategoryId prefers the primary category over the deepest', () => {
  // Product has 3 mapped categories; 35 is deepest-or-tied, but 233 is primary.
  const categories = [{ id: 34 }, { id: 233 }, { id: 35 }]
  const meta = [{ key: '_yoast_wpseo_primary_product_cat', value: '233' }]
  assert.equal(resolveImsCategoryId(categories, meta, mirror), 'ims-hotends')
})

test('resolveImsCategoryId falls back to deepest when no primary is set', () => {
  const categories = [{ id: 34 }, { id: 233 }] // 233 is deeper (depth 1)
  assert.equal(resolveImsCategoryId(categories, [], mirror), 'ims-hotends')
})

test('resolveImsCategoryId falls back to deepest when the primary is not mirrored', () => {
  const categories = [{ id: 34 }, { id: 233 }]
  const meta = [{ key: '_yoast_wpseo_primary_product_cat', value: '999' }] // 999 not in mirror
  assert.equal(resolveImsCategoryId(categories, meta, mirror), 'ims-hotends') // deepest of 34/233
})
