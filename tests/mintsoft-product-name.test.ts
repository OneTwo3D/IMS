import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { fitMintsoftName, fitMintsoftProductName, MINTSOFT_NAME_MAX_LEN } from '../lib/connectors/mintsoft/api/product-name.ts'

/**
 * o3d-zvec.20: `fit_mintsoft_name`, ported from the retired Python sync.
 *
 * The golden file was produced by EXECUTING the plugin's own function (woocommerce-mintsoft-sync/wc_mintsoft_sync.py, lines 58-123,
 * read-only) over the cases of its test file (tests/test_mintsoft_name_length.py) plus the word-boundary, non-BMP and no-SKU edges.
 * Each case is {name, suffix, sku, out}: the port must return `out` exactly.
 */
type Golden = { name: string; suffix: string; sku: string; out: string }
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/mintsoft-fit-name-golden.json', import.meta.url), 'utf8')) as Golden[]

test('every golden case from the Python implementation is reproduced exactly', () => {
  assert.ok(GOLDEN.length >= 20, 'the fixture is not empty')
  for (const c of GOLDEN) {
    assert.equal(fitMintsoftName(c.name, c.suffix, c.sku), c.out, `fit(${JSON.stringify(c.name.slice(0, 30))}..., ${JSON.stringify(c.suffix.slice(0, 20))}...)`)
  }
})

test('the limit is 99 UTF-16 units, every result fits, and the fitting is idempotent', () => {
  assert.equal(MINTSOFT_NAME_MAX_LEN, 99)
  for (const c of GOLDEN) {
    const out = fitMintsoftName(c.name, c.suffix, c.sku)
    assert.ok(out.length <= MINTSOFT_NAME_MAX_LEN, out)
    assert.equal(fitMintsoftName(out), out, 'a fitted name is not re-cut')
  }
})

test('a name that fits is unchanged; the parent is cut at a word boundary with "..." and the variant is kept whole', () => {
  const parent = 'Mandala Rose Works FireThorn Flex Plate with ThornGrip Textured PEI'
  assert.equal(fitMintsoftName('x'.repeat(99)), 'x'.repeat(99))
  assert.equal(
    fitMintsoftName(parent, ' (Voron 2.4/Trident 350 (355 x 355mm))'),
    'Mandala Rose Works FireThorn Flex Plate with ThornGrip... (Voron 2.4/Trident 350 (355 x 355mm))',
  )
})

test('a long parent with oversized variants stays distinct through the SKU, and a hard cut ends in "... (Variant)"', () => {
  const longValue = 'Shared very long attribute value '.repeat(3)
  const names = new Set([0, 1, 2].map((i) => fitMintsoftName('Long parent product name '.repeat(4), ` (${longValue}${i})`, `SKU-0${i}`)))
  assert.equal(names.size, 3)
  assert.ok([...names].every((n) => n.includes('(SKU-0')))
  assert.equal(fitMintsoftName('A'.repeat(120), ' (Variant)').endsWith('... (Variant)'), true)
})

test('fitMintsoftProductName splits the IMS variation name "<parent> — <attributes>" so the attributes stay whole, in the plugin\'s "<parent> (a, b)" format', () => {
  const parent = 'Mandala Rose Works FireThorn Flex Plate with ThornGrip Textured PEI'
  const name = `${parent} — Voron 2.4/Trident 350 (355 x 355mm)`
  const fitted = fitMintsoftProductName(name, parent, 'SKU-1')
  assert.ok(fitted.length <= 99)
  assert.ok(fitted.endsWith(' (Voron 2.4/Trident 350 (355 x 355mm))'), fitted)
  assert.ok(fitted.startsWith('Mandala Rose Works FireThorn Flex Plate with ThornGrip...'), fitted)
  // No parent, or a name that does not start with the parent: fitted as a plain name.
  assert.equal(fitMintsoftProductName('Short', null, 'S'), 'Short')
  assert.equal(fitMintsoftProductName('Short', 'Other', 'S'), 'Short')
  assert.ok(fitMintsoftProductName('W '.repeat(80), null, 'S').length <= 99)
})

test('fitMintsoftProductName keeps the plugin "Parent (a, b)" format, not "Parent — a / b" (owner decision 2026-11-18)', () => {
  assert.equal(fitMintsoftProductName('Plate — Red / Large', 'Plate', 'S1'), 'Plate (Red, Large)')
  assert.equal(fitMintsoftProductName('Plate — Red', 'Plate', 'S1'), 'Plate (Red)')
})
