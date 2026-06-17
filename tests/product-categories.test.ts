import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProductCategoryPathMap,
  buildProductCategoryPathNormalized,
  cleanProductCategoryName,
  decodeHtmlEntities,
  getProductCategoryAncestry,
  normalizeProductCategoryName,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  parseProductCategoryPath,
  resolveProductCategoryIdByName,
} from '../lib/products/categories.ts'
import { toCsv } from '../lib/csv.ts'

test('product category names are trimmed and whitespace-normalized for display', () => {
  assert.equal(cleanProductCategoryName('  Printer   Parts  '), 'Printer Parts')
  assert.equal(cleanProductCategoryName(undefined), null)
  assert.equal(cleanProductCategoryName('   '), null)
  assert.equal(cleanProductCategoryName(null), null)
})

test('decodeHtmlEntities decodes named + numeric entities and leaves bare text intact', () => {
  assert.equal(decodeHtmlEntities('Tool Changers &amp; Multi Material'), 'Tool Changers & Multi Material')
  assert.equal(decodeHtmlEntities('Nuts &#038; Bolts'), 'Nuts & Bolts')      // numeric decimal
  assert.equal(decodeHtmlEntities('Nuts &#x26; Bolts'), 'Nuts & Bolts')      // numeric hex
  assert.equal(decodeHtmlEntities('It&#8217;s here'), 'It’s here')      // right single quote
  assert.equal(decodeHtmlEntities('A &lt;B&gt; &quot;C&quot;'), 'A <B> "C"')
  // Bare ampersands and unknown entities are preserved (idempotent on clean text).
  assert.equal(decodeHtmlEntities('R&D and Salt & Pepper'), 'R&D and Salt & Pepper')
  assert.equal(decodeHtmlEntities('Plain Category'), 'Plain Category')
  assert.equal(decodeHtmlEntities('Tea &dagger; Co'), 'Tea &dagger; Co')
})

test('product category names HTML-decode WooCommerce entities for display and matching', () => {
  assert.equal(cleanProductCategoryName('Tool Changers &amp; Multi Material'), 'Tool Changers & Multi Material')
  assert.equal(cleanProductCategoryName('Nuts &#038; Bolts'), 'Nuts & Bolts')
  // The normalized key matches the decoded plain-text form, so a WC re-sync
  // resolves to the same category instead of creating a duplicate.
  assert.equal(normalizeProductCategoryName('Tool Changers &amp; Multi Material'), 'tool changers & multi material')
  assert.equal(
    normalizeProductCategoryName('Tool Changers &amp; Multi Material'),
    normalizeProductCategoryName('Tool Changers & Multi Material'),
  )
})

test('product category normalized names are stable for case-insensitive import matching', () => {
  assert.equal(normalizeProductCategoryName('  Printer   Parts  '), 'printer parts')
  assert.equal(normalizeProductCategoryName('PRINTER PARTS'), 'printer parts')
  assert.equal(normalizeProductCategoryName('  Café\u200B   Parts  '), 'cafe parts')
})

test('dry-run product category resolution does not require a database write', async () => {
  assert.equal(
    await resolveProductCategoryIdByName('  Printer   Parts  ', { dryRun: true }),
    'preview-category:printer parts',
  )
  assert.equal(await resolveProductCategoryIdByName('', { dryRun: true }), null)
})

test('dry-run product category ids dedupe by normalized name', async () => {
  assert.equal(
    await resolveProductCategoryIdByName('Café Parts', { dryRun: true }),
    await resolveProductCategoryIdByName(' cafe\u200B parts ', { dryRun: true }),
  )
})

test('product category resolver rejects names longer than the database boundary', async () => {
  await assert.rejects(
    resolveProductCategoryIdByName('x'.repeat(PRODUCT_CATEGORY_NAME_MAX_LENGTH + 1), { dryRun: true }),
    /100 characters or fewer/,
  )
})

test('product export csv escapes category names containing csv syntax', () => {
  assert.equal(
    toCsv([{ sku: 'SKU-1', category: 'Hardware, "Special"\nParts' }], ['sku', 'category']),
    'sku,category\r\nSKU-1,"Hardware, ""Special""\nParts"',
  )
})

test('parseProductCategoryPath splits on > and cleans each segment', () => {
  assert.deepEqual(parseProductCategoryPath('Apparel > T-Shirts > V-Neck'), ['Apparel', 'T-Shirts', 'V-Neck'])
  assert.deepEqual(parseProductCategoryPath('  Apparel  >  T-Shirts  '), ['Apparel', 'T-Shirts'])
  assert.deepEqual(parseProductCategoryPath('Apparel >> T-Shirts'), ['Apparel', 'T-Shirts'])
  assert.deepEqual(parseProductCategoryPath('OnlyOne'), ['OnlyOne'])
  assert.deepEqual(parseProductCategoryPath(''), [])
  assert.deepEqual(parseProductCategoryPath(null), [])
})

test('buildProductCategoryPathNormalized joins normalized segments with the delimiter', () => {
  assert.equal(buildProductCategoryPathNormalized(['Apparel', 'T-Shirts']), 'apparel>t-shirts')
  assert.equal(buildProductCategoryPathNormalized(['Café']), 'cafe')
  assert.equal(buildProductCategoryPathNormalized(['Promo', 'T-Shirts']), 'promo>t-shirts')
})

test('repeat leaf names under different parents normalize distinctly', async () => {
  assert.notEqual(
    await resolveProductCategoryIdByName('Apparel > T-Shirts', { dryRun: true }),
    await resolveProductCategoryIdByName('Promo > T-Shirts', { dryRun: true }),
  )
  assert.equal(
    await resolveProductCategoryIdByName('Apparel > T-Shirts', { dryRun: true }),
    'preview-category:apparel>t-shirts',
  )
})

test('path normalization is whitespace-tolerant and case-insensitive', async () => {
  assert.equal(
    await resolveProductCategoryIdByName(' apparel > t-shirts ', { dryRun: true }),
    await resolveProductCategoryIdByName('APPAREL > T-Shirts', { dryRun: true }),
  )
})

test('getProductCategoryAncestry returns root-most-first chain', () => {
  const opts = [
    { id: 'a', name: 'Apparel', parentId: null },
    { id: 'b', name: 'T-Shirts', parentId: 'a' },
    { id: 'c', name: 'V-Neck', parentId: 'b' },
  ]
  assert.deepEqual(
    getProductCategoryAncestry('c', opts).map((n) => n.name),
    ['Apparel', 'T-Shirts', 'V-Neck'],
  )
  assert.deepEqual(getProductCategoryAncestry('missing', opts), [])
})

test('buildProductCategoryPathMap renders full display path per id', () => {
  const opts = [
    { id: 'a', name: 'Apparel', parentId: null },
    { id: 'b', name: 'T-Shirts', parentId: 'a' },
    { id: 'c', name: 'V-Neck', parentId: 'b' },
    { id: 'd', name: 'Promo', parentId: null },
    { id: 'e', name: 'T-Shirts', parentId: 'd' },
  ]
  const map = buildProductCategoryPathMap(opts)
  assert.equal(map.get('a'), 'Apparel')
  assert.equal(map.get('b'), 'Apparel > T-Shirts')
  assert.equal(map.get('c'), 'Apparel > T-Shirts > V-Neck')
  assert.equal(map.get('e'), 'Promo > T-Shirts')
  assert.notEqual(map.get('b'), map.get('e'))
})

test('csv export preserves fixed decimal reporting values as dot-decimal literals', () => {
  assert.equal(
    toCsv(
      [{ qty: '2.500000', unitCostBase: '1.234568', totalValueBase: '3.086420' }],
      ['qty', 'unitCostBase', 'totalValueBase'],
    ),
    'qty,unitCostBase,totalValueBase\r\n2.500000,1.234568,3.086420',
  )
})
