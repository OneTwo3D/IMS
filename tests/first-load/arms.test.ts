/**
 * The named arms of the first-load transform. Each arm asserts and prints its precondition (how many cases it examined) and
 * is paired with ONE mutation that turns it red (listed in the PR). Arm letters follow the work-package brief.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { detectBomItemCycleInEdges } from '../../lib/products/bom-recipe.ts'
import { collapseLots } from '../../lib/first-load/transform.ts'
import { D } from '../../lib/first-load/money.ts'
import { chunkUnits, findRecipeCycles } from '../../lib/first-load/validate.ts'
import { IMPORTER_MAX_ROWS, MAX_ROWS_PER_FILE } from '../../lib/first-load/spec.ts'
import {
  dispositionCodes, ds, findingCodes, loadFixtureDatasets, lot, mulberry32, precondition, product, rowsOf, run, shuffleCsvText,
} from './helpers.ts'

// ---------------------------------------------------------------------------
// (a) cyclic recipe pair rejected
// ---------------------------------------------------------------------------
test('arm (a): a cyclic recipe pair is rejected, the acyclic recipe beside it is not', (t) => {
  const lines = ds('recipe-lines', [
    { parentSku: 'A', componentSku: 'B', qty: '1' },
    { parentSku: 'B', componentSku: 'A', qty: '1' },
    { parentSku: 'C', componentSku: 'D', qty: '2' },
  ])
  const result = run({ products: ds('products', [product('A', 'BOM'), product('B', 'BOM'), product('C', 'BOM'), product('D')]), 'recipe-lines': lines })
  precondition(t, 'recipe edges examined', lines.rows.length)
  assert.equal(result.blocking, true)
  assert.deepEqual(result.report.recipes.cycles, [['A', 'B', 'A']])
  assert.ok(findingCodes(result, 'ERROR').includes('RECIPE_CYCLE'))
  assert.deepEqual(dispositionCodes(result, 'recipe-lines', 'REJECTED'), ['RECIPE_CYCLE', 'RECIPE_CYCLE'])
  const accepted = result.report.accountingByCode.find((row) => row.dataset === 'recipe-lines' && row.code === 'RECIPE_LINE')
  assert.equal(accepted?.count, 1, 'the unrelated acyclic line is still accepted')
  assert.equal(result.outputs.length, 0, 'a blocked run writes no import file')
})

test('arm (a): self-reference and a three-node cycle are cycles; a diamond is not', (t) => {
  const cases: Array<{ name: string; edges: Array<[string, string]>; cyclic: boolean }> = [
    { name: 'self', edges: [['A', 'A']], cyclic: true },
    { name: 'three', edges: [['A', 'B'], ['B', 'C'], ['C', 'A']], cyclic: true },
    { name: 'diamond', edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']], cyclic: false },
  ]
  precondition(t, 'graphs examined', cases.length)
  for (const c of cases) {
    const skus = [...new Set(c.edges.flat())]
    const result = run({
      products: ds('products', skus.map((sku) => product(sku, sku === 'D' ? 'SIMPLE' : 'BOM'))),
      'recipe-lines': ds('recipe-lines', c.edges.map(([parentSku, componentSku]) => ({ parentSku, componentSku, qty: '1' }))),
    })
    assert.equal(result.report.recipes.cycles.length > 0, c.cyclic, c.name)
  }
})

test('arm (a): the cycle finder agrees with detectBomItemCycleInEdges on random graphs (same algorithm)', (t) => {
  const random = mulberry32(7)
  let cyclic = 0
  const graphs = 300
  for (let g = 0; g < graphs; g++) {
    const edges: Array<{ parent: string; component: string }> = []
    const count = 1 + Math.floor(random() * 8)
    for (let e = 0; e < count; e++) edges.push({ parent: `N${Math.floor(random() * 6)}`, component: `N${Math.floor(random() * 6)}` })
    const theirs = detectBomItemCycleInEdges(edges.map((edge) => ({ parentProductId: edge.parent, componentProductId: edge.component })))
    const ours = findRecipeCycles(edges)
    assert.equal(ours.cycles.length > 0, theirs !== null, JSON.stringify(edges))
    if (theirs) cyclic++
  }
  precondition(t, 'random graphs that contain a cycle', cyclic)
  t.diagnostic(`graphs compared = ${graphs}`)
})

// ---------------------------------------------------------------------------
// (b) weighted average exact
// ---------------------------------------------------------------------------
test('arm (b): the weighted average of a 3-lot fixture is exact, a simple mean is not', (t) => {
  const result = run({
    products: ds('products', [product('A')]),
    'stock-lots': ds('stock-lots', [lot('A', '10', '4.00'), lot('A', '20', '5.00'), lot('A', '30', '6.00')]),
  })
  const simpleMean = (4 + 5 + 6) / 3
  precondition(t, 'lots collapsed', result.report.stock.groups[0]?.lots ?? 0)
  assert.notEqual(simpleMean.toFixed(6), '5.333333', 'the fixture must separate weighted from simple mean')
  const [row] = rowsOf(result, 'opening-stock')
  assert.equal(row.qty, '60')
  assert.equal(row.unitCostBase, '5.333333')
  const [group] = result.report.stock.groups
  assert.equal(group.lotTotalBase, '320')
  assert.equal(group.collapsedTotalBase, '319.99998')
  assert.equal(group.roundingResidualBase, '-0.00002')
  assert.equal(result.report.stock.totals.roundingResidualBase, '-0.00002')
})

/** An independent oracle: the same weighted average done in integer arithmetic (BigInt), rounded half up to 6 dp. */
function oracle(lots: Array<[string, string]>): string {
  const scaled = (text: string, dp: number) => {
    const [i, f = ''] = text.split('.')
    return BigInt(i + f.padEnd(dp, '0'))
  }
  let total = BigInt(0)
  let qty = BigInt(0)
  for (const [q, c] of lots) {
    total += scaled(q, 6) * scaled(c, 10)
    qty += scaled(q, 6)
  }
  const num = total
  const den = qty * BigInt(10000)
  const rounded = (BigInt(2) * num + den) / (BigInt(2) * den)
  const s = rounded.toString().padStart(7, '0')
  return `${s.slice(0, -6)}.${s.slice(-6)}`
}

test('arm (b): exact against an integer oracle, including a half-up tie and limit-sized values', (t) => {
  const cases: Array<Array<[string, string]>> = [
    [['1', '0.000001'], ['1', '0.000002']],
    [['10', '4.00'], ['20', '5.00'], ['30', '6.00']],
    [['99999999.999999', '999999999.1234567891'], ['12345678.123456', '0.0000000001'], ['3', '7.7777777777']],
    [['0.000001', '123456789.9999999999'], ['7', '0.3333333333']],
    [['2', '1.1111115'], ['3', '1.1111115']],
  ]
  precondition(t, 'lot sets compared with the oracle', cases.length)
  for (const lots of cases) {
    const collapsed = collapseLots(lots.map(([qty, cost]) => ({ qty: new D(qty), unitCostBase: new D(cost) })))
    assert.equal(collapsed.average.toFixed(6), oracle(lots), JSON.stringify(lots))
    // And the residual identity: collapsed total = lot total + residual, exactly.
    assert.ok(collapsed.collapsedTotal.sub(collapsed.lotTotal).eq(collapsed.residual))
  }
  assert.equal(collapseLots([{ qty: new D('1'), unitCostBase: new D('0.000001') }, { qty: new D('1'), unitCostBase: new D('0.000002') }]).average.toFixed(6), '0.000002', 'half rounds up')
})

// ---------------------------------------------------------------------------
// (c) missing SKU holding stock elsewhere vs zero on hand
// ---------------------------------------------------------------------------
test('arm (c): a SKU missing from the extract that holds stock elsewhere is reported, separately from a stated zero', (t) => {
  const result = run({
    products: ds('products', [product('MISSING-HELD'), product('MISSING-QUIET'), product('STATED-ZERO'), product('HAS-STOCK')]),
    'stock-lots': ds('stock-lots', [lot('STATED-ZERO', '0', '1.00'), lot('HAS-STOCK', '5', '2.00')]),
    'mintsoft-stock': ds('mintsoft-stock', [{ sku: 'MISSING-HELD', qty: '7' }, { sku: 'HAS-STOCK', qty: '5' }]),
  })
  const missing = result.report.stock.missingFromExtract
  precondition(t, 'SKUs in the missing bucket', missing.length)
  precondition(t, 'SKUs in the zero bucket', result.report.stock.zeroOnHand.length)
  assert.deepEqual(missing.map((m) => [m.sku, m.holdsStockElsewhere, m.mintsoftQty]), [['MISSING-HELD', true, '7'], ['MISSING-QUIET', false, '0']])
  assert.deepEqual(result.report.stock.zeroOnHand, ['STATED-ZERO'])
  assert.ok(!missing.some((m) => m.sku === 'STATED-ZERO'), 'a stated zero is never "missing"')
  assert.ok(!result.report.stock.zeroOnHand.includes('MISSING-HELD'), 'a missing SKU is never "zero"')
  const errors = result.report.findings.filter((f) => f.code === 'MISSING_SKU_HOLDS_STOCK')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].severity, 'ERROR')
  assert.ok(errors[0].keys?.[0].startsWith('MISSING-HELD'))
  assert.equal(result.blocking, true)
})

test('arm (c): without Mintsoft stock the answer is UNKNOWN, not "no"', (t) => {
  const result = run({
    products: ds('products', [product('MISSING')]),
    'stock-lots': ds('stock-lots', [lot('OTHER', '1', '1')]),
  })
  precondition(t, 'missing SKUs', result.report.stock.missingFromExtract.length)
  assert.equal(result.report.stock.missingFromExtract[0].holdsStockElsewhere, null)
})

// ---------------------------------------------------------------------------
// (d) chunking
// ---------------------------------------------------------------------------
function manyProducts(count: number) {
  return ds('products', Array.from({ length: count }, (_, i) => product(`P${String(i + 1).padStart(5, '0')}`)))
}

test('arm (d): the 10,001st row lands in chunk 2 and no file reaches the importers\' cap', (t) => {
  const result = run({ products: manyProducts(10_001) })
  const files = result.outputs.filter((f) => f.target === 'products').sort((a, b) => a.chunk - b.chunk)
  precondition(t, 'product files', files.length)
  assert.equal(result.blocking, false)
  assert.equal(files.length, 2)
  assert.equal(files[0].rows + files[1].rows, 10_001)
  for (const file of files) assert.ok(file.rows < IMPORTER_MAX_ROWS, `${file.name} has ${file.rows} rows`)
  assert.ok(files[0].content.includes('P09999,'), 'row 9,999 is in chunk 1')
  assert.ok(!files[0].content.includes('P10001,'), 'the 10,001st row is not in chunk 1')
  assert.ok(files[1].content.includes('P10001,'), 'the 10,001st row is in chunk 2')
  assert.ok(files[1].content.includes('P10000,'), 'the 10,000th row is in chunk 2 (fewer than 10,000 rows per file)')
  assert.match(files[0].name, /^02-products-001-of-002\.csv$/)
})

test('arm (d): 9,999 rows fit one file; 10,000 rows already need two', (t) => {
  const one = run({ products: manyProducts(MAX_ROWS_PER_FILE) })
  const two = run({ products: manyProducts(IMPORTER_MAX_ROWS) })
  precondition(t, 'row counts examined', 2)
  assert.equal(MAX_ROWS_PER_FILE, 9_999)
  assert.equal(one.outputs.filter((f) => f.target === 'products').length, 1)
  assert.equal(two.outputs.filter((f) => f.target === 'products').length, 2)
})

test('arm (d): a purchase order or transfer is never split across files, and the byte limit also splits', (t) => {
  const header = ['k', 'v']
  const units = Array.from({ length: 4 }, (_, i) => [[`K${i}`, 'a'], [`K${i}`, 'b'], [`K${i}`, 'c']])
  const byRows = chunkUnits(header, units, { maxRows: 7, maxBytes: 1_000_000 })
  precondition(t, 'groups chunked', units.length)
  assert.deepEqual(byRows.chunks.map((c) => c.length), [6, 6], 'groups of 3 rows are kept whole under a 7-row cap')
  for (const chunk of byRows.chunks) {
    const keys = chunk.map((row) => row[0])
    for (const key of new Set(keys)) assert.equal(keys.filter((k) => k === key).length, 3)
  }
  const byBytes = chunkUnits(header, units, { maxRows: 100, maxBytes: 40 })
  assert.ok(byBytes.chunks.length > 1, 'a byte limit splits too')
  assert.equal(chunkUnits(header, [[['x', 'y'], ['x', 'z']]], { maxRows: 1, maxBytes: 1000 }).oversizedUnits.length, 1, 'a group larger than a file is reported, not split')
})

// ---------------------------------------------------------------------------
// (e) row accounting on the mixed fixture
// ---------------------------------------------------------------------------
test('arm (e): every input row is emitted, excluded or rejected, and the totals reconcile (mixed fixture)', (t) => {
  const result = run(loadFixtureDatasets())
  const report = result.report
  precondition(t, 'datasets accounted', report.inputs.length)
  assert.equal(report.verdict, 'PASS')
  let read = 0
  let excludedTotal = 0
  for (const input of report.inputs) {
    const excluded = report.dispositions.filter((d) => d.dataset === input.dataset && d.outcome === 'EXCLUDED').length
    const rejected = report.dispositions.filter((d) => d.dataset === input.dataset && d.outcome === 'REJECTED').length
    const emitted = report.accountingByCode.filter((r) => r.dataset === input.dataset && r.outcome === 'EMITTED').reduce((n, r) => n + r.count, 0)
    assert.equal(input.recordsRead, emitted + excluded + rejected, `${input.dataset}: read ${input.recordsRead} != ${emitted}+${excluded}+${rejected}`)
    read += input.recordsRead
    excludedTotal += excluded
  }
  assert.equal(read, 64)
  assert.equal(excludedTotal, 7)
  t.diagnostic(`records read = ${read}, excluded = ${excludedTotal}`)
  assert.equal(report.accountingBalanced, true)
  assert.deepEqual(report.selfCheckFailures, [])
  const reasons = new Set(report.dispositions.filter((d) => d.outcome === 'EXCLUDED').map((d) => d.code))
  for (const expected of ['ZERO_ON_HAND', 'EXCLUDED_TYPE', 'FULLY_RECEIVED', 'NOT_OPEN', 'OVER_RECEIVED', 'NO_SKU']) assert.ok(reasons.has(expected), `${expected} is reported`)
})

// ---------------------------------------------------------------------------
// (f) determinism
// ---------------------------------------------------------------------------
test('arm (f): shuffled input rows give byte-identical import files and an identical report (line numbers aside)', (t) => {
  const original = run(loadFixtureDatasets())
  let changedFiles = 0
  const strip = (report: unknown) => JSON.parse(JSON.stringify(report, (key, value) => (key === 'line' || key === 'inputs' ? undefined : value)))
  for (const seed of [1, 2, 3, 4, 5]) {
    const shuffledText = new Map<string, string>()
    const shuffled = run(loadFixtureDatasets(undefined, (dataset, text) => {
      const out = shuffleCsvText(text, seed)
      if (out !== text) changedFiles++
      shuffledText.set(dataset, out)
      return out
    }))
    assert.deepEqual(shuffled.outputs.map((f) => [f.name, f.sha256, f.content]), original.outputs.map((f) => [f.name, f.sha256, f.content]), `seed ${seed}`)
    assert.deepEqual(strip(shuffled.report), strip(original.report), `seed ${seed} report`)
  }
  precondition(t, 'input files whose row order actually changed', changedFiles)
  precondition(t, 'output files compared', original.outputs.length)
})

test('arm (f): the same input twice gives the identical full report, and no output carries a run timestamp', (t) => {
  const a = run(loadFixtureDatasets())
  const b = run(loadFixtureDatasets())
  precondition(t, 'output files', a.outputs.length)
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report))
  const everything = JSON.stringify(a.report) + a.outputs.map((f) => f.content).join('')
  assert.ok(!/generatedAt|timestamp|createdAt/i.test(everything))
  assert.ok(!everything.includes(new Date().toISOString().slice(0, 10)) || '2026-10-01' === new Date().toISOString().slice(0, 10), 'no run date in any output')
  assert.equal(a.report.runId, 'test', 'the only run-specific text is the explicit run id')
})

// ---------------------------------------------------------------------------
// (h) KIT, VARIABLE and NON_INVENTORY exclusion
// ---------------------------------------------------------------------------
test('arm (h): KIT, VARIABLE and NON_INVENTORY stock rows are excluded and reported; the products themselves are still loaded', (t) => {
  const result = run({
    products: ds('products', [product('KITTED', 'KIT'), product('PARENT', 'VARIABLE'), product('SERVICE', 'NON_INVENTORY'), product('REAL'), product('PART')]),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'KITTED', componentSku: 'PART', qty: '1' }]),
    'stock-lots': ds('stock-lots', [lot('KITTED', '5', '1'), lot('PARENT', '3', '1'), lot('SERVICE', '9', '1'), lot('REAL', '2', '1')]),
  })
  const excluded = result.report.dispositions.filter((d) => d.dataset === 'stock-lots' && d.code === 'EXCLUDED_TYPE')
  precondition(t, 'excluded-by-type stock rows', excluded.length)
  assert.equal(excluded.length, 3)
  assert.deepEqual(rowsOf(result, 'opening-stock').map((r) => r.sku), ['REAL'])
  assert.equal(rowsOf(result, 'products').length, 5, 'KIT, VARIABLE and NON_INVENTORY products are still loaded as products')
  assert.deepEqual(result.report.findings.filter((f) => f.code === 'EXCLUDED_TYPE_HOLDS_STOCK').length, 3, 'each holds stock in the source, so each is also a warning')
})

// ---------------------------------------------------------------------------
// (i) in-transit counted exactly once
// ---------------------------------------------------------------------------
const transferLine = (qtyShipped: string, extra: Record<string, string> = {}) => ({
  transferKey: 'TR1', status: 'IN_TRANSIT', fromWarehouseCode: 'MAIN', toWarehouseCode: 'OVER', sku: 'A', qtyShipped, qtyReceived: '0', ...extra,
})

test('arm (i): in-transit stock is counted once under both conventions', (t) => {
  const base = { products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', [lot('A', '10', '2.00')]), transfers: ds('transfers', [transferLine('4')]) }
  const included = run(base, { inTransitConvention: 'counted-in-source' })
  const excluded = run(base, { inTransitConvention: 'excluded-from-source' })
  precondition(t, 'conventions examined', 2)
  const physicalAfterDispatch = (result: ReturnType<typeof run>) => Number(rowsOf(result, 'opening-stock')[0].qty) - Number(rowsOf(result, 'transfers')[0].qty)
  // Source reports 10 INCLUDING the 4 in transit: open 10, dispatch removes 4, 6 are physically in the warehouse, 4 in the transfer: total 10.
  assert.equal(rowsOf(included, 'opening-stock')[0].qty, '10')
  assert.equal(physicalAfterDispatch(included), 6)
  assert.equal(physicalAfterDispatch(included) + Number(rowsOf(included, 'transfers')[0].qty), 10)
  // Source reports 10 EXCLUDING the 4: open 14, dispatch removes 4, 10 physically there, 4 in the transfer: total 14.
  assert.equal(rowsOf(excluded, 'opening-stock')[0].qty, '14')
  assert.equal(physicalAfterDispatch(excluded), 10)
  assert.equal(physicalAfterDispatch(excluded) + Number(rowsOf(excluded, 'transfers')[0].qty), 14)
  assert.equal(rowsOf(excluded, 'opening-stock')[0].unitCostBase, '2.000000', 'added in-transit units carry the source weighted-average cost')
})

test('arm (i): an in-transit quantity the source cannot cover is rejected, not guessed', (t) => {
  const covered = run({ products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', [lot('A', '3', '2')]), transfers: ds('transfers', [transferLine('4')]) })
  const noCost = run({ products: ds('products', [product('A')]), 'stock-lots': ds('stock-lots', []), transfers: ds('transfers', [transferLine('4')]) }, { inTransitConvention: 'excluded-from-source' })
  precondition(t, 'cases', 2)
  assert.deepEqual(dispositionCodes(covered, 'transfers', 'REJECTED'), ['IN_TRANSIT_EXCEEDS_SOURCE_STOCK'])
  assert.deepEqual(dispositionCodes(noCost, 'transfers', 'REJECTED'), ['NO_COST_BASIS_AT_SOURCE'])
  assert.equal(covered.blocking && noCost.blocking, true)
})

test('arm (i): two transfers from the same source are summed against it; partial receipt moves only the remainder', (t) => {
  const result = run({
    products: ds('products', [product('A')]),
    'stock-lots': ds('stock-lots', [lot('A', '10', '2')]),
    transfers: ds('transfers', [
      transferLine('4', { transferKey: 'T1' }),
      transferLine('9', { transferKey: 'T2', qtyReceived: '4' }),
    ]),
  })
  precondition(t, 'transfers', 2)
  assert.equal(result.blocking, false)
  assert.deepEqual(rowsOf(result, 'transfers').map((r) => [r.transferKey, r.qty]), [['T-T1', '4'], ['T-T2', '5']])
  assert.equal(result.report.stock.groups[0].inTransitQty, '9')
  const tooMuch = run({
    products: ds('products', [product('A')]),
    'stock-lots': ds('stock-lots', [lot('A', '8', '2')]),
    transfers: ds('transfers', [transferLine('4', { transferKey: 'T1' }), transferLine('9', { transferKey: 'T2', qtyReceived: '4' })]),
  })
  assert.deepEqual(dispositionCodes(tooMuch, 'transfers', 'REJECTED'), ['IN_TRANSIT_EXCEEDS_SOURCE_STOCK', 'IN_TRANSIT_EXCEEDS_SOURCE_STOCK'], 'together they exceed the 8 on hand')
})
