/**
 * Owner rulings from dry run 4 (all fixtures synthetic), and two tool bugs:
 *   - a SKU the map or the decisions skip (non-stock-skus) is never total-checked in a wide stock report (was WIDE_TOTAL_MISMATCH);
 *   - a recipe override is all or nothing;
 *   - blankStockIsZero: a stock row blank everywhere loads as 0 on hand, a blank total beside a stated cell stays refused;
 *   - a WooCommerce variation can carry a BOM recipe (IMS: type BOM with a VARIABLE parent);
 *   - sku-renames, including through the CLI with the decision file listed after the data files.
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { runCli } from '../../lib/first-load/cli.ts'
import { ingestDataset, mergeIngested, parseColumnMap, type IngestDecisions } from '../../lib/first-load/ingest.ts'
import { loadPreparedRun } from '../../lib/first-load/apply/prepared.ts'
import { loadOk, problemsOf, prepareSynthetic, preparedFiles, syntheticDatasets, withConsistentFile } from './apply-helpers.ts'
import { dispositionCodes, ds, findingCodes, lot, precondition, product, rowsOf, run } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const mapText = readFileSync(path.join(NATIVE, 'maps', 'qoblex-stock-on-hand.map.json'), 'utf8')
const stockMap = parseColumnMap(mapText, 'qoblex-stock-on-hand.map.json')
const lines = readFileSync(path.join(NATIVE, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((l) => l !== '')
const cellsOf = (line: string): string[] => line.replace(/^﻿/, '').slice(1, -1).split('","')
const HEADER = cellsOf(lines[1])
const TEMPLATE = cellsOf(lines.find((l) => l.includes('"SYN-1001"'))!)
const QTY_AT = HEADER.map((h, i) => (h === 'Quantity' ? i : -1)).filter((i) => i >= 0) // [total, block1, ... block5]

/** A synthetic stock row: `qty` sets the total (first) and each warehouse block quantity (rest); '' leaves a cell blank. */
function stockRow(sku: string, type: string, qty: string[]): string {
  const cells = [...TEMPLATE]
  cells[0] = `Name of ${sku}`
  cells[1] = sku
  cells[5] = type
  QTY_AT.forEach((at, i) => (cells[at] = qty[i] ?? ''))
  return `"${cells.join('","')}"`
}
const csv = (...rows: string[]) => Buffer.from([lines[0], lines[1], ...rows, ''].join('\r\n'))
const stock = (data: Buffer, decisions?: IngestDecisions, mapping = stockMap.datasets['stock-lots']!) => ingestDataset('stock-lots', data, 's.csv', mapping, decisions)
const NONE = ['', '', '', '', '', '']

// [mutation: the wide-total check runs before the rowSelect skip again]
test('o3d-d9lj5: a non-stock SKU (decision) and a skipped kind (map) are never total-checked; a counted SKU with the same blank total is still refused', (t) => {
  const decisions: IngestDecisions = { nonStockSkus: new Set(['SYN-NS']), skuByName: new Map() }
  const data = csv(
    stockRow('SYN-NS', 'Unknown', ['', '4', '', '', '', '']), // non-stock by decision, blank total beside a stated cell
    stockRow('SYN-KIT', 'kit', NONE), // skipped by the map
    stockRow('SYN-LIVE', 'simple', ['', '4', '', '', '', '']), // counted: blank total beside a stated cell
  )
  const r = stock(data, decisions)
  precondition(t, 'stock rows read or skipped', r.recordsRead + Object.values(r.rowsSkipped).reduce((n, c) => n + c, 0))
  assert.deepEqual(r.rejected.map((x) => x.code), ['WIDE_TOTAL_MISMATCH'], 'only the counted SKU is refused')
  assert.match(r.rejected[0].reason, /blank/)
  assert.equal(r.rowsSkipped['non-inventory'], 1)
  assert.equal(r.rowsSkipped.kit, 1)
  assert.deepEqual(r.rows.length, 0)
})

const bomBase = () => ({ products: ds('products', [product('KIT-1', 'BOM'), product('C1'), product('C2')]) })

// [mutation: the accepted lines of a failed override are kept]
test('o3d-1th8a: a recipe override with any rejected line is rejected as a whole and the parent gets no recipe', (t) => {
  const partial = run({
    ...bomBase(),
    'recipe-overrides': ds('recipe-overrides', [
      { parentSku: 'KIT-1', componentSku: 'C1', qty: '1', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'C2', qty: '2', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'NOPE', qty: '1', reason: 'owner' },
    ]),
  })
  const whole = run({
    ...bomBase(),
    'recipe-overrides': ds('recipe-overrides', [
      { parentSku: 'KIT-1', componentSku: 'C1', qty: '1', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'C2', qty: '2', reason: 'owner' },
    ]),
  })
  precondition(t, 'recipe dispositions', [partial, whole].reduce((n, x) => n + x.report.dispositions.filter((d) => d.dataset === 'recipe-overrides').length, 0))
  assert.deepEqual(dispositionCodes(partial, 'recipe-overrides', 'REJECTED').sort(), ['RECIPE_OVERRIDE_INCOMPLETE', 'RECIPE_OVERRIDE_INCOMPLETE', 'SKU_NOT_IN_CATALOGUE'])
  assert.deepEqual(dispositionCodes(partial, 'recipe-overrides', 'EMITTED'), [])
  assert.equal(rowsOf(partial, 'products').find((r) => r.sku === 'KIT-1')?.components ?? '', '', 'no partial recipe is written')
  assert.ok(findingCodes(partial, 'ERROR').includes('RECIPE_OVERRIDE_REJECTED'))
  assert.equal(partial.blocking, true)
  assert.equal(whole.blocking, false)
  assert.match(rowsOf(whole, 'products').find((r) => r.sku === 'KIT-1')!.components, /C1:1;C2:2|C2:2;C1:1/)
  // a rejected line that is not even a line of the recipe (missing reason) rejects the rest too, and the export's lines stay set aside
  const noReason = run({
    ...bomBase(),
    'recipe-lines': ds('recipe-lines', [{ parentSku: 'KIT-1', componentSku: 'C1', qty: '1' }]),
    'recipe-overrides': ds('recipe-overrides', [
      { parentSku: 'KIT-1', componentSku: 'C1', qty: '1', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'C2', qty: '2', reason: '' },
    ]),
  })
  assert.deepEqual(dispositionCodes(noReason, 'recipe-overrides', 'REJECTED').sort(), ['MISSING_REASON', 'RECIPE_OVERRIDE_INCOMPLETE'])
  assert.deepEqual(dispositionCodes(noReason, 'recipe-lines', 'EXCLUDED'), ['REPLACED_BY_RECIPE_OVERRIDE'])
  assert.equal(noReason.blocking, true)
})

// [mutation: a blank total is read as zero whatever the warehouse cells say, or the key is not needed]
test('blankStockIsZero: blank everywhere loads as 0 on hand with one INFO per row; a blank total beside any stated cell stays refused; the key is opt-in', (t) => {
  const mapping = stockMap.datasets['stock-lots']!
  assert.equal(mapping.blankStockIsZero, true, 'the shipped Qoblex stock map sets it')
  const data = csv(
    stockRow('SYN-BLANK', 'simple', NONE),
    stockRow('SYN-MIXED', 'simple', ['', '', '3', '', '', '']),
    stockRow('SYN-TOTAL', 'simple', ['5', '', '', '', '', '']),
    stockRow('SYN-OK', 'simple', ['3', '3', '0', '0', '0', '0']),
  )
  const r = stock(data)
  precondition(t, 'stock rows read', r.recordsRead)
  assert.deepEqual(r.rejected.map((x) => x.code), ['WIDE_TOTAL_MISMATCH', 'WIDE_TOTAL_MISMATCH'], 'a stated cell beside a blank total, and a stated total over blank cells, are refused')
  assert.equal(r.notes?.filter((n) => n.code === 'BLANK_STOCK_AS_ZERO').length, 1)
  assert.match(r.notes![0].reason, /SYN-BLANK.*line \d+.*0 on hand/)
  const blankRows = r.rows.filter((x) => x.values.sku === 'SYN-BLANK')
  assert.equal(blankRows.length, 5, 'one canonical row per warehouse block')
  assert.ok(blankRows.every((x) => x.values.qty === '0'))
  // through the transform: the SKU is a stated zero (no opening layer), reported, counted
  const result = run({ products: ds('products', [product('SYN-BLANK'), product('SYN-OK')]), 'stock-lots': r })
  assert.ok(result.report.findings.some((f) => f.severity === 'INFO' && f.code === 'BLANK_STOCK_AS_ZERO' && /SYN-BLANK/.test(f.message)))
  assert.ok(result.report.findings.some((f) => f.code === 'BLANK_STOCK_AS_ZERO_COUNT' && /1 stock row/.test(f.message)))
  assert.ok(dispositionCodes(result, 'stock-lots', 'EXCLUDED').includes('ZERO_ON_HAND'))
  // opt-in: the same map without the key refuses the blank row
  const without = parseColumnMap(mapText.replace(/,\s*"blankStockIsZero": true/, ''), 'm').datasets['stock-lots']!
  assert.equal(without.blankStockIsZero, false)
  const refused = stock(csv(stockRow('SYN-BLANK', 'simple', NONE)), undefined, without)
  assert.deepEqual(refused.rejected.map((x) => x.code), ['WIDE_TOTAL_MISMATCH'])
  // the key only belongs on a wide stock-lots map
  assert.throws(() => parseColumnMap(JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets: { products: { columns: { sku: 'S', name: 'N', type: 'T' }, blankStockIsZero: true } } }), 'm'), /blankStockIsZero/)
})

// [mutation: a blank total over zero cells stays refused, or a non-zero / unparseable cell is read as zero, or the key is not needed]
test('blankStockIsZero: a blank total over blank-or-zero warehouse cells is 0 on hand; a non-zero or unparseable cell is refused; the key is opt-in', (t) => {
  const r = stock(csv(
    stockRow('SYN-ZEROS', 'simple', ['', '0', '0.0', '0.0000', '0', '0']),
    stockRow('SYN-HALF', 'simple', ['', '', '0', '', '0.0', '']),
    stockRow('SYN-NONZERO', 'simple', ['', '0', '0', '0.5', '0', '0']),
    stockRow('SYN-ODD', 'simple', ['', '0', 'n/a', '0', '0', '0']),
  ))
  precondition(t, 'stock rows read', r.recordsRead)
  assert.deepEqual(r.rejected.map((x) => x.code), ['WIDE_TOTAL_MISMATCH', 'WIDE_TOTAL_MISMATCH'])
  const notes = r.notes!.filter((n) => n.code === 'BLANK_STOCK_AS_ZERO')
  assert.equal(notes.length, 2)
  assert.match(notes[0].reason, /SYN-ZEROS.*warehouse .*cell is zero/)
  assert.match(notes[1].reason, /SYN-HALF.*blank or zero/)
  for (const sku of ['SYN-ZEROS', 'SYN-HALF']) {
    const rows = r.rows.filter((x) => x.values.sku === sku)
    assert.equal(rows.length, 5)
    assert.ok(rows.every((x) => x.values.qty === '0'))
  }
  assert.ok(!r.rows.some((x) => x.values.sku === 'SYN-NONZERO' || x.values.sku === 'SYN-ODD'))
  const without = parseColumnMap(mapText.replace(/,\s*"blankStockIsZero": true/, ''), 'm').datasets['stock-lots']!
  const refused = stock(csv(stockRow('SYN-ZEROS', 'simple', ['', '0', '0', '0', '0', '0'])), undefined, without)
  assert.deepEqual(refused.rejected.map((x) => x.code), ['WIDE_TOTAL_MISMATCH'])
})

// ---------------------------------------------------------------------------
// A variation that carries a BOM recipe
// ---------------------------------------------------------------------------
const wooRow = (variantSku: string, parentSku: string) => ({ variantSku, wooVariationId: '501', parentSku, parentName: `Parent ${parentSku}`, parentStatus: 'publish', wooParentId: '900' })
const merged = (second: string) => mergeIngested([ds('products', [product('V-01', 'VARIANT')], 'stock.csv'), ds('products', [product('V-01', second)], 'bundles.csv')], [false, true])
const bomRecipe = ds('recipe-lines', [{ parentSku: 'V-01', componentSku: 'C1', qty: '10' }])

// [mutation: VARIANT -> BOM is a SUPERSEDE_CONFLICT again, or the type becomes BOM with no parent]
test('a VARIANT superseded by a BOM (or KIT) row keeps its WooCommerce parent, loads as BOM (or KIT) with a recipe and is reported', (t) => {
  const ok = run({ products: merged('BOM'), 'recipe-lines': bomRecipe, 'variant-parents': ds('variant-parents', [wooRow('V-01', 'V')]) })
  const withComponent = run({ products: mergeIngested([ds('products', [product('V-01', 'VARIANT'), product('C1')], 'stock.csv'), ds('products', [product('V-01', 'BOM')], 'bundles.csv')], [false, true]), 'recipe-lines': bomRecipe, 'variant-parents': ds('variant-parents', [wooRow('V-01', 'V')]) })
  precondition(t, 'product rows', rowsOf(withComponent, 'products').length)
  assert.equal(ok.report.dispositions.some((d) => d.code === 'SUPERSEDE_CONFLICT'), false)
  const row = rowsOf(withComponent, 'products').find((r) => r.sku === 'V-01')!
  assert.deepEqual([row.type, row.parentSku, row.components], ['BOM', 'V', 'C1:10'])
  assert.ok(rowsOf(withComponent, 'products').some((r) => r.sku === 'V' && r.type === 'VARIABLE'), 'the parent is emitted once')
  assert.equal(withComponent.blocking, false)
  assert.ok(withComponent.report.findings.some((f) => f.severity === 'INFO' && f.code === 'VARIANT_CARRIES_RECIPE' && f.keys?.[0] === 'V-01 (under V)'))
  // never loaded without its parent
  const orphan = run({ products: mergeIngested([ds('products', [product('V-01', 'VARIANT'), product('C1')], 'stock.csv'), ds('products', [product('V-01', 'BOM')], 'bundles.csv')], [false, true]), 'recipe-lines': bomRecipe, 'variant-parents': ds('variant-parents', [wooRow('OTHER-01', 'OTHER')]) })
  assert.deepEqual(dispositionCodes(orphan, 'products', 'REJECTED'), ['VARIANT_WITHOUT_PARENT'])
  // KIT on a variation is allowed too (owner ruling): same join, type KIT, parent kept
  const kit = run({ products: mergeIngested([ds('products', [product('V-01', 'VARIANT'), product('C1')], 'stock.csv'), ds('products', [product('V-01', 'KIT')], 'bundles.csv')], [false, true]), 'recipe-lines': bomRecipe, 'variant-parents': ds('variant-parents', [wooRow('V-01', 'V')]) })
  const kitRow = rowsOf(kit, 'products').find((r) => r.sku === 'V-01')!
  assert.deepEqual([kitRow.type, kitRow.parentSku, kitRow.components], ['KIT', 'V', 'C1:10'])
  assert.equal(kit.blocking, false)
  // a SIMPLE row superseded by VARIANT is still a conflict
  assert.deepEqual(mergeIngested([ds('products', [product('V-01', 'KIT')], 'a.csv'), ds('products', [product('V-01', 'VARIANT')], 'b.csv')], [false, true]).rejected.map((x) => x.code), ['SUPERSEDE_CONFLICT'])
  // a plain BOM row (not a variation) is not given a parent it never had
  const plain = run({ products: merged('BOM'), 'recipe-lines': bomRecipe })
  assert.ok(plain.blocking)
})

// [mutation: the type check only allows an override type equal to the products type]
test('recipe-overrides type BOM or KIT on a variation gives it that recipe type under its parent; a mismatch on a SIMPLE, or a failed override, is refused', (t) => {
  const base = { products: ds('products', [product('V-01', 'VARIANT'), product('C1'), product('C2')]), 'variant-parents': ds('variant-parents', [wooRow('V-01', 'V')]) }
  const good = run({ ...base, 'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'V-01', componentSku: 'C1', qty: '3', type: 'BOM', reason: 'owner' }]) })
  precondition(t, 'products emitted', rowsOf(good, 'products').length)
  const row = rowsOf(good, 'products').find((r) => r.sku === 'V-01')!
  assert.deepEqual([row.type, row.parentSku, row.components], ['BOM', 'V', 'C1:3'])
  assert.equal(good.blocking, false)
  assert.ok(good.report.findings.some((f) => f.code === 'VARIANT_CARRIES_RECIPE' && f.severity === 'INFO'))
  const kit = run({ ...base, 'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'V-01', componentSku: 'C1', qty: '3', type: 'KIT', reason: 'owner' }]) })
  const kitRow = rowsOf(kit, 'products').find((r) => r.sku === 'V-01')!
  assert.deepEqual([kitRow.type, kitRow.parentSku, kitRow.components], ['KIT', 'V', 'C1:3'])
  const simple = run({ ...base, 'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'C2', componentSku: 'C1', qty: '3', type: 'KIT', reason: 'owner' }]) })
  assert.deepEqual(dispositionCodes(simple, 'recipe-overrides', 'REJECTED'), ['RECIPE_OVERRIDE_TYPE_MISMATCH'])
  const failed = run({ ...base, 'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'V-01', componentSku: 'C1', qty: '3', type: 'BOM', reason: 'owner' }, { parentSku: 'V-01', componentSku: 'NOPE', qty: '1', type: 'BOM', reason: 'owner' }]) })
  assert.equal(failed.blocking, true)
  assert.ok(!findingCodes(failed).includes('VARIANT_CARRIES_RECIPE'))
})

// ---------------------------------------------------------------------------
// sku-renames
// ---------------------------------------------------------------------------
const rename = (fromSku: string, toSku: string, reason = 'owner: the WooCommerce SKU is right') => ({ fromSku, toSku, reason })
const poLine = (sku: string) => ({ orderKey: 'PO-1', supplierName: 'Sup', sku, qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3' })
const renameBase = () => ({
  products: ds('products', [product('AV-1', 'VARIANT'), product('AV-2', 'VARIANT'), product('KIT-1', 'BOM')]),
  'recipe-lines': ds('recipe-lines', [{ parentSku: 'KIT-1', componentSku: 'AV-1', qty: '2' }]),
  'stock-lots': ds('stock-lots', [lot('AV-1', '5', '2')]),
  'purchase-order-lines': ds('purchase-order-lines', [poLine('AV-1')]),
  'variant-parents': ds('variant-parents', [wooRow('W-1', 'W'), wooRow('AV-2', 'W')]),
})

// [mutation: the rename is applied to the products only, or after the join]
test('sku-renames: the SKU is renamed in products, recipe lines, stock lots and order lines before the join, and each rename is reported', (t) => {
  const result = run({ ...renameBase(), 'sku-renames': ds('sku-renames', [rename('AV-1', 'W-1')]) })
  precondition(t, 'products emitted', rowsOf(result, 'products').length)
  const products = rowsOf(result, 'products')
  assert.ok(products.some((r) => r.sku === 'W-1' && r.type === 'VARIANT' && r.parentSku === 'W'), 'the renamed variant joins the WooCommerce variation of that SKU')
  assert.ok(!products.some((r) => r.sku === 'AV-1'))
  assert.match(products.find((r) => r.sku === 'KIT-1')!.components, /W-1:2/)
  assert.ok(rowsOf(result, 'opening-stock').some((r) => r.sku === 'W-1'))
  assert.ok(rowsOf(result, 'purchase-orders').some((r) => Object.values(r).includes('W-1')))
  const info = result.report.findings.find((f) => f.code === 'SKU_RENAMED')!
  assert.equal(info.severity, 'INFO')
  assert.match(info.message, /AV-1 -> W-1.*1 cell\(s\) in products.*1 cell\(s\) in stock-lots.*1 cell\(s\) in purchase-order-lines/)
  assert.ok(!findingCodes(result).includes('SKU_RENAME_UNUSED'))
  // without the rename the same data has no parent for AV-1
  assert.ok(dispositionCodes(run(renameBase()), 'products', 'REJECTED').includes('VARIANT_WITHOUT_PARENT'))
})

// [mutation: any one refusal is dropped]
test('sku-renames: a missing source SKU, an existing target, a chain, a cycle, a repeated SKU and a shared target are all refused, and a rename that changes no product warns', (t) => {
  const refused = (rows: Array<Record<string, string>>) => dispositionCodes(run({ ...renameBase(), 'sku-renames': ds('sku-renames', rows) }), 'sku-renames', 'REJECTED').sort()
  precondition(t, 'refusal arms', 6)
  assert.deepEqual(refused([rename('NOT-THERE', 'X-1')]), ['RENAME_FROM_NOT_IN_SOURCE'])
  assert.deepEqual(refused([rename('AV-1', 'AV-2')]), ['RENAME_TARGET_EXISTS'])
  assert.deepEqual(refused([rename('AV-1', 'av-2')]), ['RENAME_TARGET_EXISTS'], 'compared like every SKU, case-insensitively')
  assert.deepEqual(refused([rename('AV-1', 'B-1'), rename('B-1', 'C-1')]), ['RENAME_CHAIN', 'RENAME_CHAIN'])
  assert.deepEqual(refused([rename('AV-1', 'B-1'), rename('B-1', 'AV-1')]), ['RENAME_CHAIN', 'RENAME_CHAIN'])
  assert.deepEqual(refused([rename('AV-1', 'B-1'), rename('AV-1', 'C-1')]), ['DUPLICATE_RENAME', 'DUPLICATE_RENAME'])
  assert.deepEqual(refused([rename('AV-1', 'B-1'), rename('KIT-1', 'B-1')]), ['RENAME_TARGET_COLLISION', 'RENAME_TARGET_COLLISION'])
  assert.deepEqual(refused([rename('AV-1', 'av-1')]), ['RENAME_TO_SELF'])
  assert.deepEqual(refused([rename('AV-1', 'B-1', '')]), ['MISSING_REASON'])
  // a refused rename is applied nowhere and blocks the run
  const untouched = run({ ...renameBase(), 'sku-renames': ds('sku-renames', [rename('AV-1', 'AV-2')]) })
  assert.equal(untouched.blocking, true)
  assert.ok(!findingCodes(untouched).includes('SKU_RENAMED'))
  // accepted, but no product row carries the SKU (only a stock lot does): a warning
  const unused = run({ products: ds('products', [product('P-1')]), 'stock-lots': ds('stock-lots', [lot('GHOST-1', '1', '1')]), 'sku-renames': ds('sku-renames', [rename('GHOST-1', 'P-1x')]) })
  assert.ok(findingCodes(unused).includes('SKU_RENAMED'))
  assert.ok(unused.report.findings.some((f) => f.severity === 'WARNING' && f.code === 'SKU_RENAME_UNUSED'))
})

// ---------------------------------------------------------------------------
// The CLI: the decision file is listed AFTER the data files
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-dry4-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

// [mutation: the rename is applied only to files read after it, or after the data is joined]
test('runCli: sku-renames listed after the data files still renames the SKU in every dataset (o3d-jawwa)', async (t) => {
  const dir = path.join(scratch, 'in')
  const out = path.join(scratch, 'out')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'products.csv'), 'sku,name,type\nOLD-1,Synthetic one,SIMPLE\nSYN-2,Synthetic two,SIMPLE\n')
  writeFileSync(path.join(dir, 'stock.csv'), 'sku,warehouseCode,qty,unitCost,currency\nOLD-1,MAIN,5,2,GBP\n')
  writeFileSync(path.join(dir, 'renames.csv'), 'fromSku,toSku,reason\nOLD-1,NEW-1,owner ruling\n')
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    formatVersion: 1, baseCurrency: 'GBP', asOf: '2026-10-01', inTransitConvention: 'counted-in-source', purchaseOrderKeyPrefix: 'T-', transferKeyPrefix: 'T-', maxPurchaseTaxRate: '0.25',
    inputs: [
      { dataset: 'products', file: 'products.csv' },
      { dataset: 'stock-lots', file: 'stock.csv' },
      { dataset: 'sku-renames', file: 'renames.csv' },
    ],
  }))
  let stdout = ''
  let stderr = ''
  const code = await runCli(['--manifest', path.join(dir, 'manifest.json'), '--out', out, '--run-id', 'dry4'], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, {})
  assert.equal(code, 0, stderr + stdout)
  const files = readdirSync(out)
  precondition(t, 'files written', files.length)
  const all = files.map((f) => readFileSync(path.join(out, f), 'utf8')).join('\n')
  assert.match(readFileSync(path.join(out, files.find((f) => f.includes('products') && f.endsWith('.csv'))!), 'utf8'), /NEW-1/)
  assert.match(readFileSync(path.join(out, files.find((f) => f.includes('opening-stock') && f.endsWith('.csv'))!), 'utf8'), /NEW-1/)
  assert.ok(!/OLD-1,/.test(readFileSync(path.join(out, files.find((f) => f.includes('products') && f.endsWith('.csv'))!), 'utf8')))
  assert.match(all, /SKU_RENAMED/)
})

// [mutation: any one rejected path of an override stops triggering the whole-override rejection]
test('o3d-1th8a: a repeated component line in an override rejects the whole override too (no partial recipe)', (t) => {
  const dup = run({
    ...bomBase(),
    'recipe-overrides': ds('recipe-overrides', [
      { parentSku: 'KIT-1', componentSku: 'C1', qty: '1', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'C1', qty: '2', reason: 'owner' },
      { parentSku: 'KIT-1', componentSku: 'C2', qty: '2', reason: 'owner' },
    ]),
  })
  precondition(t, 'override dispositions', dup.report.dispositions.filter((d) => d.dataset === 'recipe-overrides').length)
  assert.deepEqual(dispositionCodes(dup, 'recipe-overrides', 'REJECTED').sort(), ['DUPLICATE_RECIPE_LINE', 'DUPLICATE_RECIPE_LINE', 'RECIPE_OVERRIDE_INCOMPLETE'])
  assert.ok(findingCodes(dup, 'ERROR').includes('RECIPE_OVERRIDE_REJECTED'))
  assert.equal(dup.blocking, true)
})

// [mutation: the loader refuses a KIT or BOM with a parentSku again, or lets a SIMPLE have one]
test('apply: a prepared run holding a variant-BOM and a variant-KIT loads (under a VARIABLE parent); a SIMPLE with a parent, or a KIT/BOM whose parent is not VARIABLE, is refused', (t) => {
  const d = syntheticDatasets()
  const products = mergeIngested([
    ds('products', [...d.products!.rows.map((r) => r.values), product('ZQSENT-TSHIRT-X', 'VARIANT', { parentSku: 'ZQSENT-TSHIRT' }), product('ZQSENT-TSHIRT-K', 'VARIANT', { parentSku: 'ZQSENT-TSHIRT' })], 'a.csv'),
    ds('products', [product('ZQSENT-TSHIRT-X', 'BOM'), product('ZQSENT-TSHIRT-K', 'KIT')], 'b.csv'),
  ], [false, true])
  const recipes = ds('recipe-lines', [...d['recipe-lines']!.rows.map((r) => r.values), { parentSku: 'ZQSENT-TSHIRT-X', componentSku: 'ZQSENT-OAK-BOARD', qty: '2' }, { parentSku: 'ZQSENT-TSHIRT-K', componentSku: 'ZQSENT-OAK-BOARD', qty: '1' }])
  const files = preparedFiles(prepareSynthetic({ ...d, products, 'recipe-lines': recipes }))
  const name = [...files.keys()].find((k) => k.includes('products'))!
  const loaded = loadOk(files)
  precondition(t, 'steps loaded', loaded.steps.length)
  const text = new TextDecoder().decode(files.get(name)!)
  assert.match(text, /ZQSENT-TSHIRT-X,[^\r]*,BOM,ZQSENT-TSHIRT,/)
  assert.match(text, /ZQSENT-TSHIRT-K,[^\r]*,KIT,ZQSENT-TSHIRT,/)
  assert.ok(loadPreparedRun)
  const simple = problemsOf(withConsistentFile(files, name, (x) => x.replace(/(ZQSENT-TSHIRT-X,[^\r]*,)BOM(,ZQSENT-TSHIRT,)/, '$1SIMPLE$2')))
  assert.ok(simple.some((p) => /only a VARIANT, KIT or BOM may have a parentSku/.test(p)), JSON.stringify(simple))
  const notVariable = problemsOf(withConsistentFile(files, name, (x) => x.replace(/(ZQSENT-TSHIRT-X,[^\r]*,BOM,)ZQSENT-TSHIRT,/, '$1ZQSENT-OAK-BOARD,')))
  assert.ok(notVariable.some((p) => /parent is not a VARIABLE/.test(p)), JSON.stringify(notVariable))
})

// [mutation: the rename skips transfers, recipe-override components or products.parentSku; blankStockIsZero accepted on a long map]
test('sku-renames reach a transfer line, a recipe-override component and products.parentSku; blankStockIsZero on a non-wide stock-lots map is refused', (t) => {
  const transfer = run({
    products: ds('products', [product('OLDA')]),
    'stock-lots': ds('stock-lots', [lot('OLDA', '10', '2')]),
    transfers: ds('transfers', [{ transferKey: 'TR1', status: 'IN_TRANSIT', fromWarehouseCode: 'MAIN', toWarehouseCode: 'OVER', sku: 'OLDA', qtyShipped: '4', qtyReceived: '0' }]),
    'sku-renames': ds('sku-renames', [rename('OLDA', 'NEWA')]),
  })
  const transferRows = rowsOf(transfer, 'transfers')
  precondition(t, 'transfer rows', transferRows.length)
  assert.ok(transferRows.every((r) => r.sku === 'NEWA'))
  const override = run({
    products: ds('products', [product('KIT-1', 'BOM'), product('OLDC')]),
    'recipe-overrides': ds('recipe-overrides', [{ parentSku: 'KIT-1', componentSku: 'OLDC', qty: '1', reason: 'owner' }]),
    'sku-renames': ds('sku-renames', [rename('OLDC', 'NEWC')]),
  })
  assert.equal(rowsOf(override, 'products').find((r) => r.sku === 'KIT-1')!.components, 'NEWC:1')
  const parent = run({
    products: ds('products', [product('OLDP', 'VARIABLE'), product('V1', 'VARIANT', { parentSku: 'OLDP' })]),
    'sku-renames': ds('sku-renames', [rename('OLDP', 'NEWP')]),
  })
  const rows = rowsOf(parent, 'products')
  assert.equal(rows.find((r) => r.sku === 'V1')!.parentSku, 'NEWP')
  assert.ok(rows.some((r) => r.sku === 'NEWP'))
  assert.throws(() => parseColumnMap(JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets: { 'stock-lots': { columns: { sku: 'S', warehouseCode: 'W', qty: 'Q', unitCost: 'U' }, blankStockIsZero: true } } }), 'm'), /blankStockIsZero/)
})

// [mutation: the note is written for a row that is later dropped or refused]
test('BLANK_STOCK_AS_ZERO is reported only for rows actually emitted (not a ghost, not a refused row)', (t) => {
  const r = stock(csv(
    stockRow('SYN-EMIT', 'simple', NONE),
    stockRow('SYN-GHOST', 'Unknown', NONE),
    stockRow('SYN-GHOST', 'simple', ['2', '2', '0', '0', '0', '0']),
    stockRow('SYN-ODD', 'weird', NONE), // unlisted kind: refused
  ))
  precondition(t, 'records', r.recordsRead)
  const notes = r.notes!.filter((n) => n.code === 'BLANK_STOCK_AS_ZERO')
  assert.equal(notes.length, 1)
  assert.match(notes[0].reason, /SYN-EMIT/)
})

// [mutation: a KIT/BOM that Woo has as an exact-SKU variation is left parentless again, or joined without Woo confirming it]
test('a KIT or BOM typed so from the start joins its WooCommerce parent by exact SKU; one Woo does not list stays a plain KIT; its stock-report on-hand is ignored, not an error', (t) => {
  const base = {
    products: ds('products', [product('KV-01', 'KIT'), product('BV-01', 'BOM'), product('PLAIN-KIT', 'KIT'), product('PLAIN-1'), product('C1')]),
    'recipe-lines': ds('recipe-lines', [
      { parentSku: 'KV-01', componentSku: 'C1', qty: '1' }, { parentSku: 'BV-01', componentSku: 'C1', qty: '2' }, { parentSku: 'PLAIN-KIT', componentSku: 'C1', qty: '1' },
    ]),
    'stock-lots': ds('stock-lots', [lot('KV-01', '7', '0'), lot('BV-01', '3', '1')]),
    'variant-parents': ds('variant-parents', [wooRow('KV-01', 'P'), wooRow('BV-01', 'P'), wooRow('PLAIN-1', 'P')]),
  }
  const result = run(base)
  const rows = rowsOf(result, 'products')
  precondition(t, 'product rows', rows.length)
  assert.deepEqual(['KV-01', 'BV-01', 'PLAIN-KIT', 'PLAIN-1'].map((s) => { const r = rows.find((x) => x.sku === s)!; return [r.type, r.parentSku] }), [['KIT', 'P'], ['BOM', 'P'], ['KIT', ''], ['SIMPLE', '']])
  const info = result.report.findings.find((f) => f.code === 'VARIANT_CARRIES_RECIPE')!
  assert.equal(info.severity, 'INFO')
  assert.deepEqual(info.keys, ['BV-01 (under P)', 'KV-01 (under P)'])
  assert.deepEqual(result.report.findings.find((f) => f.code === 'QOBLEX_TYPE_NOT_VARIANT')?.keys, ['PLAIN-1'])
  assert.equal(result.blocking, false, JSON.stringify(result.report.findings.filter((f) => f.severity === 'ERROR')))
  // the KIT's on-hand is ignored (INFO, no ERROR); the BOM's stock loads
  assert.deepEqual(dispositionCodes(result, 'stock-lots', 'EXCLUDED'), ['KIT_STOCK_IGNORED'])
  assert.deepEqual(rowsOf(result, 'opening-stock').map((r) => r.sku), ['BV-01'])
  assert.ok(result.report.findings.some((f) => f.severity === 'INFO' && f.code === 'KIT_STOCK_IGNORED' && f.keys?.[0] === 'KV-01 (7)'))
  // exact-SKU confirmation stays mandatory when the join is required and Woo does not list it
  const unconfirmed = run({ ...base, 'variant-parents': ds('variant-parents', [wooRow('PLAIN-1', 'P')]) }, { requireVariantParents: true })
  assert.ok(!findingCodes(unconfirmed).includes('VARIANT_CARRIES_RECIPE'))
})
