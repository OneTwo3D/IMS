import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanProductCategoryName,
  normalizeProductCategoryName,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  resolveProductCategoryIdByName,
} from '../lib/products/categories.ts'
import { toCsv } from '../lib/csv.ts'

test('product category names are trimmed and whitespace-normalized for display', () => {
  assert.equal(cleanProductCategoryName('  Printer   Parts  '), 'Printer Parts')
  assert.equal(cleanProductCategoryName(undefined), null)
  assert.equal(cleanProductCategoryName('   '), null)
  assert.equal(cleanProductCategoryName(null), null)
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
