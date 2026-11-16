import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIdentifierReport, classifyProductIdentifiers } from '@/lib/domain/products/identifier-report'

const GTIN = '4006381333931'
const p = (barcode: string | null, mpn: string | null, sku = 'S') => ({ sku, barcode, mpn })

test('a GTIN barcode with a part number already in mpn is unchanged', () => {
  assert.equal(classifyProductIdentifiers(p(GTIN, 'LN1')).action, 'unchanged')
  assert.equal(classifyProductIdentifiers(p(GTIN, null)).action, 'unchanged')
  assert.equal(classifyProductIdentifiers(p(null, 'LN1')).action, 'unchanged')
})

test('a part number or zero-padded counter in barcode would move to mpn', () => {
  const row = classifyProductIdentifiers(p('00000287', null))
  assert.equal(row.action, 'move_barcode_to_mpn')
  assert.equal(row.newMpn, '00000287')
  assert.equal(row.gtin, '')
  assert.equal(classifyProductIdentifiers(p('LN00000287', null)).action, 'move_barcode_to_mpn')
})

test('barcode equal to mpn clears the duplicate; swapped fields swap', () => {
  assert.equal(classifyProductIdentifiers(p('LN1', 'LN1')).action, 'clear_duplicate_barcode')
  const swapped = classifyProductIdentifiers(p('LN1', GTIN))
  assert.equal(swapped.action, 'swap')
  assert.equal(swapped.gtin, GTIN)
  assert.equal(swapped.newMpn, 'LN1')
})

test('two part numbers or two GTINs land in leftover, never resolved', () => {
  const parts = classifyProductIdentifiers(p('LN00000059', 'LN00000282'))
  assert.equal(parts.action, 'leftover')
  assert.equal(parts.leftover, 'LN00000059')
  assert.equal(parts.newMpn, 'LN00000282')
  assert.equal(classifyProductIdentifiers(p(GTIN, '036000291452')).action, 'leftover')
})

test('the report counts every scanned product, lists only what changes, and skips products with no identifier', () => {
  const report = buildIdentifierReport([
    p(GTIN, 'LN1', 'A'), p('00000287', null, 'B'), p(null, null, 'C'), p('LN1', 'LN2', 'D'), p('', '  ', 'E'),
  ])
  assert.equal(report.scanned, 5)
  assert.equal(report.withIdentifiers, 3)
  assert.deepEqual(report.counts, { unchanged: 1, move_barcode_to_mpn: 1, clear_duplicate_barcode: 0, swap: 0, leftover: 1 })
  assert.deepEqual(report.rows.map((row) => row.sku), ['B', 'D'])
})
