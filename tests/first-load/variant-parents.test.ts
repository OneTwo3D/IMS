/**
 * The variant-parent join: Qoblex variants (no parent in any Qoblex export) are joined to the WooCommerce variation with the SAME SKU, and each
 * parent reached is emitted once as a VARIABLE product. Every arm asserts and prints its precondition, and is paired with ONE named mutation
 * (listed in the PR) that turns it red.
 *
 * The data here is synthetic. No real SKU, title or customer value appears in this repository.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson } from '../../lib/first-load/report.ts'
import { joinVariantParents, skuStem } from '../../lib/first-load/variant-parents.ts'
import { dispositionCodes, ds, findingCodes, precondition, product, rowsOf, run, shuffleCsvText } from './helpers.ts'

let nextId = 9000
function vp(variantSku: string, parentSku: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    variantSku, wooVariationId: String(nextId++), parentSku, parentName: `Parent ${parentSku}`, parentStatus: 'publish', wooParentId: String(100000 + parentSku.length * 1000 + [...parentSku].reduce((n, c) => n + c.charCodeAt(0), 0)), ...extra,
  }
}

const variant = (sku: string, extra: Record<string, string> = {}) => product(sku, 'VARIANT', extra)

test('arm (a): the parent comes from the WooCommerce variation (exact SKU), never from the SKU stem', (t) => {
  // AAA-01 and AAA-02 have the stem AAA, but WooCommerce says their parent is PARENT-X; BBB-01 has stem BBB and parent BBB.
  const result = run({
    products: ds('products', [variant('AAA-01'), variant('AAA-02'), variant('BBB-01')]),
    'variant-parents': ds('variant-parents', [vp('AAA-01', 'PARENT-X'), vp('AAA-02', 'PARENT-X'), vp('BBB-01', 'BBB')]),
  })
  const rows = rowsOf(result, 'products')
  precondition(t, 'products rows emitted', rows.length)
  precondition(t, 'variants whose stem is not their real parent', rows.filter((r) => r.type === 'VARIANT' && r.parentSku === 'PARENT-X').length)
  assert.equal(result.blocking, false, JSON.stringify(result.report.findings))
  assert.deepEqual(rows.filter((r) => r.type === 'VARIANT').map((r) => [r.sku, r.parentSku]), [['AAA-01', 'PARENT-X'], ['AAA-02', 'PARENT-X'], ['BBB-01', 'BBB']])
  const stem = result.report.findings.find((f) => f.code === 'PARENT_STEM_MISMATCH')
  assert.deepEqual(stem?.keys, ['AAA-01 -> PARENT-X', 'AAA-02 -> PARENT-X'], 'the stem is only a cross-check warning')
  assert.equal(stem?.severity, 'WARNING')
  assert.equal(skuStem('AAA-01'), 'AAA')
})

test('arm (b): a parent shared by several variants is emitted once, as VARIABLE, named by WooCommerce; variants keep the Qoblex name', (t) => {
  const result = run({
    products: ds('products', [variant('P-01', { name: 'Qoblex name one' }), variant('P-02', { name: 'Qoblex name two' }), variant('P-03', { name: 'Qoblex name three' })]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P'), vp('P-02', 'P'), vp('P-03', 'P')]),
  })
  const rows = rowsOf(result, 'products')
  precondition(t, 'variants joined to the one parent', rows.filter((r) => r.parentSku === 'P').length)
  const parents = rows.filter((r) => r.sku === 'P')
  assert.equal(parents.length, 1, 'one parent row for three variants')
  assert.equal(parents[0].type, 'VARIABLE')
  assert.equal(parents[0].name, 'Parent P', 'the parent title is the WooCommerce title')
  assert.deepEqual(rows.filter((r) => r.type === 'VARIANT').map((r) => r.name), ['Qoblex name one', 'Qoblex name two', 'Qoblex name three'])
  assert.ok(rows.findIndex((r) => r.sku === 'P') < rows.findIndex((r) => r.sku === 'P-01'), 'the parent comes before its children in the file')
  assert.deepEqual(result.report.variantParents, { supplied: true, rowsRead: 3, variantsJoined: 3, parentsEmitted: 1, parentsWithoutQoblexVariant: 0 })
})

test('arm (c): a variant no WooCommerce variation matches stays VARIANT_WITHOUT_PARENT and is never loaded as a simple product', (t) => {
  const result = run({
    products: ds('products', [variant('LOST-01'), variant('OK-01')]),
    'variant-parents': ds('variant-parents', [vp('OK-01', 'OK')]),
  })
  precondition(t, 'unjoined variants', dispositionCodes(result, 'products', 'REJECTED').filter((c) => c === 'VARIANT_WITHOUT_PARENT').length)
  assert.equal(result.blocking, true)
  assert.deepEqual(dispositionCodes(result, 'products', 'REJECTED'), ['VARIANT_WITHOUT_PARENT'])
  const finding = result.report.findings.find((f) => f.code === 'VARIANT_WITHOUT_PARENT')
  assert.equal(finding?.severity, 'ERROR')
  assert.deepEqual(finding?.keys, ['LOST-01'])
  assert.equal(result.outputs.length, 0, 'a blocked run writes no import file, so nothing is loaded as a simple product')
  assert.ok(!result.report.dispositions.some((d) => d.dataset === 'products' && d.key === 'LOST-01' && d.outcome === 'EMITTED'))
})

test('arm (d): a repeated variation SKU (letter case ignored) rejects every row that carries it', (t) => {
  const result = run({
    products: ds('products', [variant('DUP-01'), variant('OK-01')]),
    'variant-parents': ds('variant-parents', [vp('DUP-01', 'ONE'), vp('dup-01', 'TWO'), vp('OK-01', 'OK')]),
  })
  precondition(t, 'rows with a repeated SKU', dispositionCodes(result, 'variant-parents', 'REJECTED').length)
  assert.deepEqual(dispositionCodes(result, 'variant-parents', 'REJECTED'), ['DUPLICATE_VARIATION_SKU', 'DUPLICATE_VARIATION_SKU'])
  assert.equal(result.blocking, true)
  assert.ok(dispositionCodes(result, 'products', 'REJECTED').includes('VARIANT_WITHOUT_PARENT'), 'the variant is not given either candidate parent')
  assert.ok(!rowsOf(result, 'products').some((r) => r.sku === 'ONE' || r.sku === 'TWO'))
})

test('arm (e): a parent SKU that collides with a Qoblex SKU rejects the parent and all its variants', (t) => {
  const result = run({
    products: ds('products', [product('Taken'), variant('V-01'), variant('V-02')]),
    'variant-parents': ds('variant-parents', [vp('V-01', 'TAKEN'), vp('V-02', 'TAKEN')]),
  })
  precondition(t, 'collisions', dispositionCodes(result, 'variant-parents', 'REJECTED').filter((c) => c === 'PARENT_SKU_COLLIDES').length)
  assert.deepEqual(dispositionCodes(result, 'variant-parents', 'REJECTED'), ['PARENT_SKU_COLLIDES', 'PARENT_SKU_COLLIDES'])
  assert.equal(result.blocking, true)
  assert.equal(result.outputs.length, 0)
})

test('arm (e2): a parent SKU that is also a variation SKU, or already exists in IMS, is rejected', (t) => {
  const asVariation = run({
    products: ds('products', [variant('X-01'), variant('Y-01')]),
    'variant-parents': ds('variant-parents', [vp('X-01', 'Y-01'), vp('Y-01', 'OTHER')]),
  })
  const inIms = run({
    products: ds('products', [variant('Z-01')]),
    'variant-parents': ds('variant-parents', [vp('Z-01', 'Z')]),
    'ims-skus': ds('ims-skus', [{ sku: 'z', type: 'SIMPLE' }]),
  })
  precondition(t, 'collision cases', 2)
  assert.ok(dispositionCodes(asVariation, 'variant-parents', 'REJECTED').includes('PARENT_SKU_COLLIDES'))
  assert.deepEqual(dispositionCodes(inIms, 'variant-parents', 'REJECTED'), ['PARENT_SKU_COLLIDES'])
})

test('arm (f): a WooCommerce parent with no Qoblex variant is a finding and is not loaded', (t) => {
  const result = run({
    products: ds('products', [variant('A-01')]),
    'variant-parents': ds('variant-parents', [vp('A-01', 'A'), vp('W-01', 'WOO-ONLY'), vp('W-02', 'WOO-ONLY')]),
  })
  const finding = result.report.findings.find((f) => f.code === 'WOO_PARENT_WITHOUT_QOBLEX_VARIANT')
  precondition(t, 'WooCommerce-only parents reported', finding?.keys?.length ?? 0)
  assert.equal(finding?.severity, 'WARNING')
  assert.deepEqual(finding?.keys, ['WOO-ONLY'])
  assert.equal(result.blocking, false, 'a WooCommerce-only parent is a warning: the owner excludes it or loads it later')
  assert.ok(!rowsOf(result, 'products').some((r) => r.sku === 'WOO-ONLY'), 'it is not loaded')
  assert.deepEqual(dispositionCodes(result, 'variant-parents', 'EXCLUDED'), ['NO_QOBLEX_PRODUCT', 'NO_QOBLEX_PRODUCT'])
  assert.equal(result.report.variantParents.parentsWithoutQoblexVariant, 1)
})

test('arm (g): sku-exclusions are honoured: an excluded parent or variation is not reported, an excluded parent takes its Qoblex variants with it', (t) => {
  const result = run({
    products: ds('products', [variant('KEEP-01'), variant('GONE-01')]),
    'variant-parents': ds('variant-parents', [vp('KEEP-01', 'KEEP'), vp('GONE-01', 'GONE'), vp('W-01', 'WOO-ONLY-EXCLUDED'), vp('W-02', 'WOO-ONLY-BY-VARIATION')]),
    'sku-exclusions': ds('sku-exclusions', [
      { sku: 'GONE', reason: 'discontinued parent' },
      { sku: 'WOO-ONLY-EXCLUDED', reason: 'not sold any more' },
      { sku: 'W-02', reason: 'draft variation' },
    ]),
  })
  precondition(t, 'exclusions in force', 3)
  const orphan = result.report.findings.find((f) => f.code === 'WOO_PARENT_WITHOUT_QOBLEX_VARIANT')
  assert.equal(orphan, undefined, 'excluded parents and parents whose variations are all excluded are not reported')
  assert.ok(!findingCodes(result).includes('STALE_EXCLUSION'), 'an exclusion that names a WooCommerce parent or variation is not stale')
  assert.deepEqual(dispositionCodes(result, 'products', 'REJECTED'), ['VARIANT_PARENT_INVALID'], 'the Qoblex variant of an excluded parent is rejected, not loaded parentless')
  assert.match(result.report.dispositions.find((d) => d.code === 'VARIANT_PARENT_INVALID')!.reason, /exclusion list/)
  assert.ok(!rowsOf(result, 'products').some((r) => r.sku === 'GONE' || r.sku === 'WOO-ONLY-EXCLUDED'))
})

test('arm (h): variations of one parent that disagree on its title, status or id reject the parent and all of them', (t) => {
  const result = run({
    products: ds('products', [variant('Q-01'), variant('Q-02'), variant('R-01')]),
    'variant-parents': ds('variant-parents', [vp('Q-01', 'Q', { parentName: 'Title one' }), vp('Q-02', 'Q', { parentName: 'Title two' }), vp('R-01', 'R')]),
  })
  precondition(t, 'rows in conflict', dispositionCodes(result, 'variant-parents', 'REJECTED').length)
  assert.deepEqual(dispositionCodes(result, 'variant-parents', 'REJECTED'), ['PARENT_ATTRIBUTE_CONFLICT', 'PARENT_ATTRIBUTE_CONFLICT'])
  assert.equal(result.blocking, true)
  assert.ok(!rowsOf(result, 'products').some((r) => r.sku === 'Q'))
})

test('arm (i): a WooCommerce status becomes a lifecycle status through a closed list; an unknown status rejects its rows', (t) => {
  const result = run({
    products: ds('products', [variant('S1-01'), variant('S2-01'), variant('S3-01')]),
    'variant-parents': ds('variant-parents', [vp('S1-01', 'S1', { parentStatus: 'publish' }), vp('S2-01', 'S2', { parentStatus: 'draft' }), vp('S3-01', 'S3', { parentStatus: 'private' })]),
  })
  const lifecycle = Object.fromEntries(rowsOf(result, 'products').filter((r) => r.type === 'VARIABLE').map((r) => [r.sku, r.lifecycleStatus]))
  precondition(t, 'parents mapped', Object.keys(lifecycle).length)
  assert.deepEqual(lifecycle, { S1: 'ACTIVE', S2: 'DRAFT', S3: 'DRAFT' })
  const bad = run({
    products: ds('products', [variant('T-01')]),
    'variant-parents': ds('variant-parents', [vp('T-01', 'T', { parentStatus: 'trash' })]),
  })
  assert.deepEqual(dispositionCodes(bad, 'variant-parents', 'REJECTED'), ['UNMAPPED_PARENT_STATUS'])
  assert.equal(bad.blocking, true)
})

test('arm (j): a WooCommerce variation that Qoblex types as a bundle or a product loads with its Qoblex type, without a parent, and is not an error', (t) => {
  const result = run({
    products: ds('products', [product('KIT-1', 'BOM'), product('PLAIN-1'), variant('V-01')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'KIT-1', componentSku: 'PLAIN-1', qty: '1' }]),
    'variant-parents': ds('variant-parents', [vp('KIT-1', 'MIXED'), vp('PLAIN-1', 'MIXED'), vp('V-01', 'MIXED')]),
  })
  const info = result.report.findings.find((f) => f.code === 'QOBLEX_TYPE_NOT_VARIANT')
  precondition(t, 'non-variant SKUs that are WooCommerce variations', info?.keys?.length ?? 0)
  assert.equal(info?.severity, 'INFO')
  assert.deepEqual(info?.keys, ['KIT-1', 'PLAIN-1'])
  assert.equal(result.blocking, false, JSON.stringify(result.report.findings))
  const rows = rowsOf(result, 'products')
  assert.equal(rows.find((r) => r.sku === 'KIT-1')?.type, 'BOM')
  assert.equal(rows.find((r) => r.sku === 'KIT-1')?.parentSku, '')
  assert.equal(rows.find((r) => r.sku === 'V-01')?.parentSku, 'MIXED')
})

test('arm (k): a parent the products file already names must agree with WooCommerce', (t) => {
  const agree = run({
    products: ds('products', [product('M', 'VARIABLE'), variant('M-01', { parentSku: 'M' })]),
    'variant-parents': ds('variant-parents', [vp('M-01', 'M')]),
  })
  const disagree = run({
    products: ds('products', [product('M', 'VARIABLE'), product('N', 'VARIABLE'), variant('M-01', { parentSku: 'M' })]),
    'variant-parents': ds('variant-parents', [vp('M-01', 'N')]),
  })
  precondition(t, 'cases', 2)
  assert.equal(agree.report.accountingByCode.find((r) => r.dataset === 'variant-parents' && r.code === 'VARIATION_JOINED')?.count, 1)
  assert.equal(agree.blocking, false, JSON.stringify(agree.report.findings))
  assert.deepEqual(dispositionCodes(disagree, 'variant-parents', 'REJECTED'), ['PARENT_CONFLICT'])
})

test('arm (l): the output is the same bytes whatever order the rows arrive in, report included', (t) => {
  const products = [variant('A-01'), variant('A-02'), variant('B-01'), variant('C-01'), variant('LOST-01'), product('S')]
  const links = [vp('A-01', 'A'), vp('A-02', 'A'), vp('B-01', 'B'), vp('C-01', 'C'), vp('W-1', 'WOO-ONLY'), vp('dup-9', 'D1'), vp('DUP-9', 'D2')]
  const text = (name: 'products' | 'variant-parents', rows: Array<Record<string, string>>) => ds(name, rows)
  const base = run({ products: text('products', products), 'variant-parents': text('variant-parents', links) })
  // The input checksums and line numbers describe the order the rows arrived in; everything else must not depend on it.
  const comparable = (r: ReturnType<typeof run>) => JSON.stringify({ ...JSON.parse(renderJson(r.report)), inputs: null, dispositions: r.report.dispositions.map((d) => ({ ...d, line: 0 })) })
  let compared = 0
  for (const seed of [1, 2, 3]) {
    const shuffled = run({
      products: text('products', [...products].reverse()),
      'variant-parents': text('variant-parents', seed === 1 ? [...links].reverse() : [...links.slice(seed), ...links.slice(0, seed)]),
    })
    assert.equal(comparable(shuffled), comparable(base), `seed ${seed}`)
    assert.deepEqual(shuffled.outputs.map((f) => f.content), base.outputs.map((f) => f.content), `seed ${seed}: the files`)
    compared++
  }
  precondition(t, 'shuffled runs compared with the base run', compared)
  assert.equal(shuffleCsvText('h\na\nb\n', 1).split('\n')[0], 'h')
})

test('arm (m): the row accounting balances with the new dataset, and the products file holds the products records plus the parents', (t) => {
  const result = run({
    products: ds('products', [variant('A-01'), variant('A-02'), variant('B-01'), product('S')]),
    'variant-parents': ds('variant-parents', [vp('A-01', 'A'), vp('A-02', 'A'), vp('B-01', 'B'), vp('W-1', 'WOO-ONLY')]),
  })
  const accounting = result.report.accounting.find((row) => row.dataset === 'variant-parents')!
  precondition(t, 'variant-parents rows read', accounting.recordsRead)
  assert.deepEqual([accounting.emitted, accounting.excluded, accounting.rejected, accounting.unaccounted], [3, 1, 0, 0])
  assert.deepEqual(result.report.selfCheckFailures, [])
  assert.equal(result.report.plannedOutputRows.products, 4 + 2, 'four product records plus two VARIABLE parents')
  assert.equal(result.report.accountingBalanced, true)
})

test('arm (n): variant-parents without a products dataset is an error, not a silent no-op', (t) => {
  const result = run({ 'variant-parents': ds('variant-parents', [vp('A-01', 'A')]) })
  precondition(t, 'rows booked', result.report.dispositions.filter((d) => d.dataset === 'variant-parents').length)
  assert.ok(findingCodes(result, 'ERROR').includes('VARIANT_PARENTS_NEED_CATALOGUE'))
  assert.equal(result.blocking, true)
})

test('arm (o): the join function alone: it never reads a stem to assign a parent', (t) => {
  const rows = ds('variant-parents', [vp('AAA-01', 'REAL-PARENT')]).rows
  const result = joinVariantParents({
    rows,
    catalogue: (key) => (key === 'AAA-01' ? { state: 'candidate', sku: 'AAA-01', type: 'VARIANT', parentSku: '' } : { state: 'absent' }),
    imsKeys: new Set(),
    exclusions: new Map(),
  })
  precondition(t, 'assignments', result.assignments.size)
  assert.equal(result.assignments.get('AAA-01'), 'REAL-PARENT')
  assert.notEqual(result.assignments.get('AAA-01'), skuStem('AAA-01'))
})
