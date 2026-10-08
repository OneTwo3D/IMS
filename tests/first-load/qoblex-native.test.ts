/**
 * The native Qoblex layouts: the wide warehouse-block stock report, the grouped bundles file, the open purchase order file with
 * its "Thu, Sep 24 2026" dates, and the contact export. The fixtures carry the REAL headers (and a leading byte-order mark on
 * every file) over invented SKUs, names and numbers.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { REPORT_JSON_NAME, runCli } from '../../lib/first-load/cli.ts'
import { parseDateByFormat } from '../../lib/first-load/dates.ts'
import { InputError, ingestDataset, mergeIngested, parseColumnMap } from '../../lib/first-load/ingest.ts'
import { EXIT_CODES } from '../../lib/first-load/spec.ts'
import { precondition } from './helpers.ts'

const NATIVE = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'qoblex-native')
const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-native-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)

const read = (name: string) => readFileSync(path.join(NATIVE, name))
const readMap = (name: string) => readFileSync(path.join(NATIVE, 'maps', name), 'utf8')
const stockMap = () => parseColumnMap(readMap('qoblex-stock-on-hand.map.json'), 'stock.map.json')
const bundlesMap = () => parseColumnMap(readMap('qoblex-bundles.map.json'), 'bundles.map.json')
const enc = (text: string) => new TextEncoder().encode(text)

async function cli(args: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

/** A copy of the native fixtures, so a test can edit a file or a map. */
function copyNative(): string {
  const dir = fresh('native')
  cpSync(NATIVE, dir, { recursive: true })
  return dir
}

/** Replace `from` by `to` in a copied file; the replacement must have happened (printed), or the test would examine nothing. */
function editFile(dir: string, name: string, from: string, to: string): void {
  const file = path.join(dir, name)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `precondition not reached: ${JSON.stringify(from)} is not in ${name}`)
  writeFileSync(file, text.replace(from, to))
}

const dropLinesWith = (dir: string, name: string, needles: string[]): number => {
  const file = path.join(dir, name)
  const lines = readFileSync(file, 'utf8').split('\r\n')
  const kept = lines.filter((line) => !needles.some((needle) => line.includes(needle)))
  writeFileSync(file, kept.join('\r\n'))
  return lines.length - kept.length
}

// ---------------------------------------------------------------------------------------------------------------------
// Wide warehouse blocks
// ---------------------------------------------------------------------------------------------------------------------

test('wide blocks: one record per source row and warehouse block, quantity from the block, code from the label (label trimmed, BOM stripped)', (t) => {
  const result = ingestDataset('stock-lots', read('stock-on-hand.csv'), 'stock-on-hand.csv', stockMap().datasets['stock-lots']!)
  // 10 data rows: 1 'Unknown' row is refused before it is split (one record), 9 rows x 5 blocks = 45 records.
  precondition(t, 'canonical records', result.recordsRead)
  assert.equal(result.hadBom, true, 'the fixture file begins with a byte-order mark, as the real export does')
  assert.equal(result.recordsRead, 9 * 5 + 1)
  const widgetA = result.rows.filter((row) => row.values.sku === 'SYN-1001')
  assert.deepEqual(
    widgetA.map((row) => [row.values.warehouseCode, row.values.qty, row.values.unitCost, row.values.currency, row.line]),
    [
      ['MIL1', '10.000000', '1.5', 'GBP', 3.01],
      ['CAMBRIDGE', '0.000000', '1.5', 'GBP', 3.02],
      ['RESTOCK', '5.000000', '1.5', 'GBP', 3.03],
      ['QUARANTINE-CAMBRIDGE', '0.000000', '1.5', 'GBP', 3.04],
      ['RXT2', '0.000000', '1.5', 'GBP', 3.05],
    ],
  )
  const quarantined = result.rows.find((row) => row.values.sku === 'SYN-1002' && row.values.warehouseCode === 'QUARANTINE-CAMBRIDGE')
  assert.equal(quarantined?.values.qty, '3.000000', 'the label with a trailing space still names its block')
  assert.equal(new Set(result.rows.map((row) => row.line)).size + result.rejected.length, result.recordsRead, 'every record has its own line number')
})

test('wide blocks: the aggregate group before the first label is never read as a warehouse', (t) => {
  const result = ingestDataset('stock-lots', read('stock-on-hand.csv'), 'stock-on-hand.csv', stockMap().datasets['stock-lots']!)
  const mil1 = result.rows.find((row) => row.values.sku === 'SYN-1001' && row.values.warehouseCode === 'MIL1')
  precondition(t, 'rows', result.rows.length)
  // The aggregate quantity of SYN-1001 is 15 (10 + 5); a reader that took the aggregate as the first warehouse would give MIL1 15.
  assert.equal(mil1?.values.qty, '10.000000')
  assert.equal(result.rows.filter((row) => row.values.sku === 'SYN-1001').reduce((sum, row) => sum + Number(row.values.qty), 0), 15)
})

/** Build a tiny wide file: a label row, a header row and data rows. */
function wideFile(labels: string[], header: string[], rows: string[][] = [['A1', '7', '3', 'y', '4', 'z']]): Uint8Array {
  const line = (cells: string[]) => cells.map((cell) => JSON.stringify(cell)).join(',')
  return enc([line(labels), line(header), ...rows.map(line)].join('\n') + '\n')
}

const wideMapText = (wide: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    formatVersion: 1,
    source: 'qoblex',
    datasets: { 'stock-lots': { rowsAboveHeader: 1, columns: { sku: 'Sku' }, constants: { currency: 'GBP' }, wide, ...extra } },
  })

const WIDE = { blockStart: 'after-label', warehouses: { 'W one': 'ONE', 'W two': 'TWO' }, blockColumns: { qty: 'Quantity' }, totals: { qty: 'Total Quantity' }, uniqueBy: 'sku' }
const HEADER = ['Sku', 'Total Quantity', 'Quantity', 'Other', 'Quantity', 'Other']
// A label sits above the LAST column of the previous block; a block starts in the column after its label.
const LABELS = ['', 'W one', '', 'W two', '', '']
const wideRead = (labels: string[], header: string[], wide: Record<string, unknown> = WIDE, rows?: string[][]) =>
  ingestDataset('stock-lots', wideFile(labels, header, rows), 'w.csv', parseColumnMap(wideMapText(wide), 'm.json').datasets['stock-lots']!)

test('wide blocks: the control file reads into two blocks, and blockStart really decides where a block starts', (t) => {
  const result = wideRead(LABELS, HEADER)
  precondition(t, 'records', result.recordsRead)
  assert.deepEqual(result.rows.map((row) => [row.values.warehouseCode, row.values.qty]), [['ONE', '3'], ['TWO', '4']])
  // Labels directly above the Quantity columns: "at-label" reads them; "after-label" would start each block one column late and refuses.
  const above = ['', '', 'W one', '', 'W two', '']
  assert.deepEqual(wideRead(above, HEADER, { ...WIDE, blockStart: 'at-label' }).rows.map((row) => [row.values.warehouseCode, row.values.qty]), [['ONE', '3'], ['TWO', '4']])
  assert.throws(() => wideRead(above, HEADER), (error) => error instanceof InputError && /has header "Quantity" 0 time/.test(error.message))
})

test('wide blocks: every structural fault is refused for the whole file, naming the fault (nothing is guessed)', (t) => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['duplicate label', () => wideRead(['', 'W one', '', 'W one', '', ''], HEADER), /"W one" appears 2 times/],
    ['unknown label', () => wideRead(['', 'W one', '', 'W three', '', ''], HEADER), /"W three" is not in the column map's wide\.warehouses/],
    ['declared warehouse absent', () => wideRead(['', 'W one', '', '', '', ''], HEADER), /declares warehouse "W two" but the file's label row has no such label/],
    ['incomplete block', () => wideRead(LABELS, ['Sku', 'Filler', 'Quantity', 'Other', 'Qty', 'Other']), /block "W two".*has header "Quantity" 0 time/],
    ['block header twice', () => wideRead(LABELS, ['Sku', 'Filler', 'Quantity', 'Quantity', 'Quantity', 'Other']), /block "W one".*has header "Quantity" 2 time/],
    ['label row length differs', () => wideRead(['', 'W one', '', 'W two', ''], HEADER), /label row has 5 cell/],
    ['per-row column inside a block', () => ingestDataset('stock-lots', wideFile(LABELS, HEADER), 'w.csv', parseColumnMap(wideMapText(WIDE, { columns: { sku: 'Other' } }), 'm.json').datasets['stock-lots']!), /appears 2 times|lies inside a warehouse block/],
    ['file with only a label row', () => ingestDataset('stock-lots', enc('"a","b"\n'), 'w.csv', parseColumnMap(wideMapText(WIDE), 'm.json').datasets['stock-lots']!), /only one row/],
  ]
  precondition(t, 'faulty wide files', cases.length)
  for (const [name, run, expected] of cases) {
    assert.throws(run, (error) => error instanceof InputError && expected.test(error.message), name)
  }
})

test('wide blocks: map-level faults (two labels one code, bad blockStart, no rowsAboveHeader, a dataset without warehouseCode) are refused', (t) => {
  const bad = (wide: Record<string, unknown>, extra: Record<string, unknown> = {}) => () => parseColumnMap(wideMapText(wide, extra), 'm.json')
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['two labels, one code', bad({ ...WIDE, warehouses: { 'W one': 'ONE', 'W two': 'one' } }), /map to the same warehouse code/],
    ['bad blockStart', bad({ ...WIDE, blockStart: 'before' }), /blockStart must be/],
    ['label not trimmed', bad({ ...WIDE, warehouses: { 'W one ': 'ONE' } }), /non-empty and trimmed/],
    ['code with a space', bad({ ...WIDE, warehouses: { 'W one': 'ON E' } }), /no whitespace/],
    ['warehouseCode also mapped', bad(WIDE, { columns: { sku: 'Sku', warehouseCode: 'Sku' } }), /set by the wide layout's labels/],
    ['unknown key', bad({ ...WIDE, extra: 1 }), /unknown key "extra"/],
    ['no block columns', bad({ ...WIDE, blockColumns: {} }), /at least one column/],
    ['without rowsAboveHeader', bad(WIDE, { rowsAboveHeader: 0 }), /needs "rowsAboveHeader": 1/],
    [
      'dataset without warehouseCode',
      () => parseColumnMap(JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets: { suppliers: { rowsAboveHeader: 1, columns: { name: 'N' }, wide: WIDE } } }), 'm.json'),
      /no warehouseCode column/,
    ],
  ]
  precondition(t, 'bad maps', cases.length)
  for (const [name, run, expected] of cases) {
    assert.throws(run, (error) => error instanceof InputError && expected.test(error.message), name)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Row selection and grouped parents (the bundles file)
// ---------------------------------------------------------------------------------------------------------------------

test('bundles file: Part rows inherit the SKU of the Bundle / BillOfMaterial row above; the header rows become products with the mapped type', (t) => {
  const map = bundlesMap()
  const recipe = ingestDataset('recipe-lines', read('bundles.csv'), 'bundles.csv', map.datasets['recipe-lines']!)
  const products = ingestDataset('products', read('bundles.csv'), 'bundles.csv', map.datasets.products!)
  precondition(t, 'recipe records', recipe.recordsRead)
  assert.deepEqual(
    recipe.rows.map((row) => [row.values.parentSku, row.values.componentSku, row.values.qty]),
    [['SYN-4001', 'SYN-3001', '2'], ['SYN-4001', 'SYN-3002', '1'], ['SYN-5001', 'SYN-3001', '5']],
  )
  assert.deepEqual(recipe.rowsSkipped, { Bundle: 1, BillOfMaterial: 1 }, 'header rows are skipped by the closed list and counted, not dropped silently')
  assert.deepEqual(products.rows.map((row) => [row.values.sku, row.values.type]), [['SYN-4001', 'KIT'], ['SYN-5001', 'BOM']])
  assert.deepEqual(products.rowsSkipped, { Part: 3 })
  assert.equal(products.recordsRead + 3, 5, 'every source row is a record or a counted skip')
})

test('bundles file: an unlisted Line Type is rejected with its line; a Part before any parent, and a Part after an unreadable row, are orphans', (t) => {
  const header = '"Product Name","SKU","Bundled Quantity","Total in Stock","Allocated","Available","Cost","Weight","Line Type"'
  const row = (sku: string, kind: string, qty = '') => `"n","${sku}","${qty}","0","","0","1","0","${kind}"`
  const text = [
    header,
    row('P0', 'Part', '1'), // no parent yet
    row('B1', 'Bundle'),
    row('P1', 'Part', '1'),
    row('Z1', 'Mystery'), // unlisted kind
    row('P2', 'Part', '2'),
    '"short","row"', // ragged: could have been a parent row
    row('P3', 'Part', '3'), // its parent is unknown now
    row('B2', 'Bundle'),
    row('P4', 'Part', '4'),
  ].join('\n') + '\n'
  const result = ingestDataset('recipe-lines', enc(text), 'b.csv', bundlesMap().datasets['recipe-lines']!)
  precondition(t, 'records', result.recordsRead)
  assert.deepEqual(result.rows.map((r) => [r.values.parentSku, r.values.componentSku]), [['B1', 'P1'], ['B1', 'P2'], ['B2', 'P4']])
  assert.deepEqual(result.rejected.map((r) => [r.line, r.code]), [[2, 'ORPHAN_CHILD_ROW'], [5, 'UNLISTED_ROW_KIND'], [7, 'RAGGED_ROW'], [8, 'ORPHAN_CHILD_ROW']])
  assert.equal(result.rowsSkipped.Bundle, 2)
})

test('row selection, parent and derived-column faults in a column map are refused', (t) => {
  const make = (entry: Record<string, unknown>) => () =>
    parseColumnMap(JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets: { 'recipe-lines': { columns: { componentSku: 'S', qty: 'Q' }, ...entry } } }), 'm.json')
  const parent = { column: 'K', parentValues: ['B'], skuColumn: 'S', into: 'parentSku' }
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['no parent source for a required column', make({}), /required canonical column "parentSku"/],
    ['value in keep and skip', make({ parentFrom: parent, rowSelect: { column: 'K', keep: ['P'], skip: ['P'] } }), /in both keep and skip/],
    ['select and parent on different columns', make({ parentFrom: parent, rowSelect: { column: 'J', keep: ['P'] } }), /must be the same source header/],
    ['parent column also mapped', make({ columns: { componentSku: 'S', qty: 'Q', parentSku: 'X' }, parentFrom: parent }), /taken from the parent row and is also mapped/],
    ['derived without a value map', make({ parentFrom: parent, derived: { sortOrder: 'qty' } }), /needs a valueMaps\.sortOrder/],
    ['derived from itself', make({ parentFrom: parent, derived: { sortOrder: 'sortOrder' }, valueMaps: { sortOrder: {} } }), /derived from itself/],
    ['derived out of order', make({ parentFrom: parent, derived: { sortOrder: 'componentSku', componentSku: 'qty' }, valueMaps: { sortOrder: {}, componentSku: {} } }), /is derived later|is also mapped/],
    ['date format on an unmapped column', make({ parentFrom: parent, dateFormats: { sortOrder: 'YYYY-MM-DD' } }), /only a column that is mapped/],
    ['date format without a month', make({ parentFrom: parent, dateFormats: { qty: 'YYYY D' } }), /exactly one month token/],
  ]
  precondition(t, 'bad maps', cases.length)
  for (const [name, run, expected] of cases) {
    assert.throws(run, (error) => error instanceof InputError && expected.test(error.message), name)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Dates and derived columns (the open purchase order file)
// ---------------------------------------------------------------------------------------------------------------------

test('dates: "Thu, Sep 24 2026" reads as 2026-09-24; a wrong weekday, an impossible day and text are refused', (t) => {
  const format = 'ddd, MMM D YYYY'
  const good: Array<[string, string]> = [['Thu, Sep 24 2026', '2026-09-24'], ['Thu, Oct 8 2026', '2026-10-08'], ['Wed, Apr 22 2026', '2026-04-22'], ['Thu, Dec 18 2025', '2025-12-18']]
  const bad = ['Fri, Sep 24 2026', 'Thu, Feb 30 2026', 'Thu, Sept 24 2026', 'Sep 24 2026', '24/09/2026', 'Thu, Sep 24 2026 ']
  precondition(t, 'date cases', good.length + bad.length)
  for (const [value, iso] of good) assert.equal(parseDateByFormat(format, value), iso, value)
  for (const value of bad) assert.equal(parseDateByFormat(format, value), null, value)
})

test('open purchase orders: due dates are converted, the currency and rate are derived from the supplier by a closed list, status is a closed list', (t) => {
  const mapping = parseColumnMap(readMap('qoblex-incoming-stock.map.json'), 'po.map.json').datasets['purchase-order-lines']!
  const result = ingestDataset('purchase-order-lines', read('incoming-stock.csv'), 'incoming-stock.csv', mapping)
  precondition(t, 'records', result.recordsRead)
  assert.equal(result.hadBom, true)
  assert.deepEqual(
    result.rows.map((row) => [row.values.orderKey, row.values.sku, row.values.status, row.values.currency, row.values.fxRateToBase, row.values.expectedDelivery, row.values.destinationWarehouseCode]),
    [
      ['PO900', 'SYN-1001', 'OPEN', 'USD', '1.25', '2026-10-08', 'MIL1'],
      ['PO900', 'SYN-1002', 'OPEN', 'USD', '1.25', '2026-10-08', 'MIL1'],
      ['PO901', 'SYN-3001', 'OPEN', 'EUR', '1.15', '2026-10-14', 'MIL1'],
      ['PO901', 'SYN-3002', 'OPEN', 'EUR', '1.15', '2026-10-14', 'MIL1'],
    ],
  )
  assert.deepEqual(result.unmappedHeaders, ['Product variant', 'Created on', 'Received on', 'Discount (%)'], 'unread columns (a discount among them) stay visible')
  // A supplier that is not in the closed list, a status that is not, and a bad date are each refused on their row (one edit per case).
  const original = readFileSync(path.join(NATIVE, 'incoming-stock.csv'), 'utf8')
  const edits: Array<[string, string, string, RegExp]> = [
    ['supplier', '"Supplier Alpha","REF-1"', '"Supplier Unlisted","REF-1"', /currency is derived from supplierName = "Supplier Unlisted"/],
    ['status', '"Approved"', '"Draft"', /status value "Draft" is not in the column map's valueMaps\.status/],
    ['weekday', '"Wed, Oct 14 2026"', '"Tue, Oct 14 2026"', /does not match the declared date format/],
  ]
  for (const [name, from, to, expected] of edits) {
    assert.ok(original.includes(from), `precondition not reached: ${name}`)
    const refused = ingestDataset('purchase-order-lines', enc(original.replace(from, to)), 'incoming-stock.csv', mapping)
    assert.equal(refused.rejected.length, 1, name)
    assert.match(refused.rejected[0].reason, expected, name)
    assert.equal(refused.rows.length, 3, name)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Several files for one dataset
// ---------------------------------------------------------------------------------------------------------------------

test('products from two files: the later file supersedes earlier rows of the same SKU, and each replaced row is booked as excluded', (t) => {
  const stock = ingestDataset('products', read('stock-on-hand.csv'), 'stock-on-hand.csv', stockMap().datasets.products!)
  const bundles = ingestDataset('products', read('bundles.csv'), 'bundles.csv', bundlesMap().datasets.products!)
  const merged = mergeIngested([stock, bundles], [false, true])
  precondition(t, 'superseded rows', merged.superseded.length)
  assert.deepEqual(merged.superseded.map((s) => s.key), ['SYN-5001'])
  assert.equal(merged.rows.filter((row) => row.values.sku === 'SYN-5001').length, 1)
  assert.equal(merged.rows.find((row) => row.values.sku === 'SYN-5001')?.values.type, 'BOM')
  assert.equal(merged.recordsRead, stock.recordsRead + bundles.recordsRead, 'a superseded row is still a record read')
  assert.ok(merged.rows.some((row) => row.line >= 1_000_000), 'rows of the second file are reported as 1,000,000 + line')
  // Without the flag both rows stay and the transform will refuse the conflict.
  assert.equal(mergeIngested([stock, bundles]).rows.filter((row) => row.values.sku === 'SYN-5001').length, 2)
})

// ---------------------------------------------------------------------------------------------------------------------
// Whole runs through the command line
// ---------------------------------------------------------------------------------------------------------------------

type Report = {
  verdict: string
  accounting: Array<{ dataset: string; recordsRead: number; emitted: number; excluded: number; rejected: number; unaccounted: number }>
  accountingByCode: Array<{ dataset: string; outcome: string; code: string; count: number }>
  findings: Array<{ severity: string; code: string; keys?: string[] }>
  notSupplied: string[]
  inputs: Array<{ dataset: string; hadBom: boolean }>
}
const reportOf = (out: string): Report => JSON.parse(readFileSync(path.join(out, REPORT_JSON_NAME), 'utf8')) as Report
const countOf = (report: Report, dataset: string, code: string) => report.accountingByCode.find((row) => row.dataset === dataset && row.code === code)?.count ?? 0

test('the fixture run as shipped is BLOCKED, and for the real reasons: Unknown types, a negative balance, a variant with no parent', async (t) => {
  const out = fresh('blocked')
  const { code } = await cli(['--manifest', path.join(NATIVE, 'manifest.json'), '--out', out])
  const report = reportOf(out)
  precondition(t, 'accounting rows', report.accounting.length)
  assert.equal(code, EXIT_CODES.BLOCKING_FINDINGS)
  assert.equal(report.verdict, 'BLOCKED')
  assert.ok(report.accounting.every((row) => row.unaccounted === 0), 'the identity holds for the wide, grouped and merged datasets')
  assert.equal(countOf(report, 'products', 'UNMAPPED_VALUE'), 1, 'Product Type "Unknown"')
  assert.equal(countOf(report, 'products', 'VARIANT_WITHOUT_PARENT'), 1, 'the stock report carries no parent for a "variable" row')
  assert.equal(countOf(report, 'products', 'SUPERSEDED_BY_LATER_FILE'), 1)
  assert.equal(countOf(report, 'stock-lots', 'NEGATIVE_ON_HAND'), 1)
  assert.equal(countOf(report, 'stock-lots', 'UNLISTED_ROW_KIND'), 1)
  assert.equal(countOf(report, 'purchase-order-lines', 'FULLY_RECEIVED'), 1)
  assert.ok(report.notSupplied.includes('transfers'), 'Qoblex has no in-transit status: the transfers dataset is simply not supplied')
  assert.ok(report.inputs.every((input) => input.hadBom), 'every native file starts with a byte-order mark')
  assert.equal(readdirSync(out).filter((name) => name.endsWith('.csv')).length, 0, 'a blocked run writes no import file')
})

test('a clean extract: one opening-stock row per SKU and warehouse at the moving average cost, outstanding quantity on the PO, no transfers needed (exit 0)', async (t) => {
  const dir = copyNative()
  const dropped = dropLinesWith(dir, 'stock-on-hand.csv', ['"SYN-6001"', '"SYN-7001"', '"SYN-2000-01"'])
  precondition(t, 'lines dropped from the stock report', dropped)
  const out = fresh('clean')
  const { code, stdout, stderr } = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  assert.equal(code, EXIT_CODES.OK, stdout + stderr)
  const files = readdirSync(out).sort()
  assert.deepEqual(files.filter((name) => name.endsWith('.csv')), ['01-suppliers-001-of-001.csv', '02-products-001-of-001.csv', '03-opening-stock-001-of-001.csv', '05-purchase-orders-001-of-001.csv'])
  const stock = readFileSync(path.join(out, '03-opening-stock-001-of-001.csv'), 'utf8').split('\r\n').filter(Boolean).slice(1).map((line) => line.split(',').slice(0, 4).join(','))
  assert.deepEqual(stock, [
    'SYN-1001,MIL1,10,1.500000',
    'SYN-1001,RESTOCK,5,1.500000',
    'SYN-1002,QUARANTINE-CAMBRIDGE,3,2.250000',
    'SYN-3001,MIL1,100,0.500000',
    'SYN-3002,MIL1,200,0.250000',
    'SYN-5001,MIL1,12,4.000000',
    'SYN-8001,MIL1,9,0.000000',
  ])
  const po = readFileSync(path.join(out, '05-purchase-orders-001-of-001.csv'), 'utf8').split('\r\n').filter(Boolean).slice(1).map((line) => line.split(',').slice(0, 8).join(','))
  assert.deepEqual(po, [
    'QBX-PO900,Supplier Alpha,USD,1.25,MIL1,SYN-1001,16,18.5',
    'QBX-PO900,Supplier Alpha,USD,1.25,MIL1,SYN-1002,20,7.93',
    'QBX-PO901,Supplier Gamma,EUR,1.15,MIL1,SYN-3001,6,0.4',
  ])
  const products = readFileSync(path.join(out, '02-products-001-of-001.csv'), 'utf8')
  assert.match(products, /SYN-4001,[^\r]*,KIT,/, 'the bundle is a KIT')
  assert.match(products, /SYN-5001,[^\r]*,BOM,/, 'the manufactured item is a BOM, not the SIMPLE the stock report called it')
  assert.match(products, /SYN-4001.*SYN-3001:2;SYN-3002:1/, 'the recipe rides in the components cell')
})

test('a Retail contact is refused for an owner decision, never loaded as a supplier by default', async (t) => {
  const dir = copyNative()
  editFile(dir, 'contacts.csv', '"Wholesale","","","","Account Manager","30 days net"', '"Retail","","","","Account Manager","30 days net"')
  const out = fresh('retail')
  const { code } = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  const report = reportOf(out)
  precondition(t, 'rejected suppliers', countOf(report, 'suppliers', 'UNLISTED_ROW_KIND'))
  assert.equal(code, EXIT_CODES.BLOCKING_FINDINGS)
  assert.equal(countOf(report, 'suppliers', 'UNLISTED_ROW_KIND'), 1)
})

test('two bundle groups for one product with the same component are refused as a conflict, not summed', async (t) => {
  const dir = copyNative()
  // Repeat the BillOfMaterial group: the real file lists some products more than once.
  editFile(
    dir,
    'bundles.csv',
    '"Synthetic part one","SYN-3001","5","100.000000","","100.000000","1.0","0","Part"',
    '"Synthetic part one","SYN-3001","5","100.000000","","100.000000","1.0","0","Part"\r\n"Synthetic bom item","SYN-5001","","12.000000","","12.000000","1.0","0","BillOfMaterial"\r\n"Synthetic part one","SYN-3001","6","100.000000","","100.000000","1.0","0","Part"',
  )
  const out = fresh('dupbom')
  await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  const report = reportOf(out)
  precondition(t, 'duplicate recipe lines', countOf(report, 'recipe-lines', 'DUPLICATE_RECIPE_LINE'))
  assert.equal(countOf(report, 'recipe-lines', 'DUPLICATE_RECIPE_LINE'), 2)
  assert.ok(report.findings.some((f) => f.code === 'NO_RECIPE_LINES' && f.keys?.includes('SYN-5001')))
})

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1: duplicate rows, totals, superseding merges, cost rules
// ---------------------------------------------------------------------------------------------------------------------

test('wide blocks: a SKU on more than one row refuses EVERY row that carries it, whatever the quantities say (never summed)', (t) => {
  const rows = [['A1', '7', '3', 'y', '4', 'z'], ['a1', '9', '5', 'y', '4', 'z'], ['B1', '7', '3', 'y', '4', 'z'], ['', '7', '3', 'y', '4', 'z'], ['', '7', '3', 'y', '4', 'z']]
  const result = wideRead(LABELS, HEADER, WIDE, rows)
  precondition(t, 'source rows', rows.length)
  assert.deepEqual(result.rejected.map((r) => [r.line, r.code]), [[3, 'DUPLICATE_SOURCE_ROW'], [4, 'DUPLICATE_SOURCE_ROW']])
  assert.deepEqual([...new Set(result.rows.map((row) => row.values.sku))], ['B1', ''], 'unequal duplicates are both gone; blank SKUs are the transform\'s problem, not a duplicate group')
  // Control: with the second row's SKU changed, nothing is refused and the units are the rows' own.
  const control = wideRead(LABELS, HEADER, WIDE, [rows[0], ['A2', ...rows[1].slice(1)]])
  assert.equal(control.rejected.length, 0)
})

test('wide blocks: the report total must equal the exact sum of the warehouse blocks (missing, edited, blank and negative cells)', (t) => {
  const cases: Array<[string, string[], string | null]> = [
    ['balanced', ['A1', '7', '3', 'y', '4', 'z'], null],
    ['balanced with a negative block', ['A1', '2', '6', 'y', '-4', 'z'], null],
    ['one block cell lowered', ['A1', '7', '3', 'y', '3', 'z'], 'up to 6'],
    ['total raised', ['A1', '8', '3', 'y', '4', 'z'], 'is 8 but'],
    ['blank block cell', ['A1', '7', '3', 'y', '', 'z'], 'blank or not a plain number'],
    ['blank total', ['A1', '', '3', 'y', '4', 'z'], 'blank or not a plain number'],
    ['quantity shifted into the next column (asymmetric)', ['A1', '7', 'y', '3', 'z', '4'], 'blank or not a plain number'],
    ['negative hidden by a zero total', ['A1', '0', '0', 'y', '-5', 'z'], 'up to -5'],
  ]
  precondition(t, 'cases', cases.length)
  for (const [name, row, expected] of cases) {
    const result = wideRead(LABELS, HEADER, WIDE, [row])
    if (expected === null) assert.equal(result.rejected.length, 0, name)
    else {
      assert.deepEqual(result.rejected.map((r) => r.code), ['WIDE_TOTAL_MISMATCH'], name)
      assert.ok(result.rejected[0].reason.includes(expected), `${name}: ${result.rejected[0].reason}`)
      assert.equal(result.rows.length, 0, `${name}: no block record of a mismatched row is emitted`)
    }
  }
  // The total header must exist exactly once before the first block.
  assert.throws(() => wideRead(LABELS, ['Sku', 'Totl', 'Quantity', 'Other', 'Quantity', 'Other']), (e) => e instanceof InputError && /total header "Total Quantity".*appears 0 time/.test(e.message))
  assert.throws(() => parseColumnMap(wideMapText({ ...WIDE, totals: undefined }), 'm.json'), (e) => e instanceof InputError && /wide\.totals is required/.test(e.message))
  assert.throws(() => parseColumnMap(wideMapText({ ...WIDE, uniqueBy: undefined }), 'm.json'), (e) => e instanceof InputError && /uniqueBy must name/.test(e.message))
})

test('the shipped fixture: a changed warehouse cell and a repeated SKU in the real-shape report are refused, not loaded', async (t) => {
  const dir = copyNative()
  // SYN-1001 MIL1 quantity 10 -> 11 while its total stays 15.
  editFile(dir, 'stock-on-hand.csv', '"15.000000","0.000000","15.000000","0.000000","0.000000","0.000000","False","10.000000"', '"15.000000","0.000000","15.000000","0.000000","0.000000","0.000000","False","11.000000"')
  const result = ingestDataset('stock-lots', readFileSync(path.join(dir, 'stock-on-hand.csv')), 'stock-on-hand.csv', stockMap().datasets['stock-lots']!)
  precondition(t, 'rejections', result.rejected.length)
  assert.ok(result.rejected.some((r) => r.code === 'WIDE_TOTAL_MISMATCH' && r.line === 3), 'line 3 is SYN-1001')
  assert.equal(result.rows.filter((row) => row.values.sku === 'SYN-1001').length, 0)
  // A repeated SKU with different quantity and cost (the real report has five of these).
  const dup = copyNative()
  const text = readFileSync(path.join(dup, 'stock-on-hand.csv'), 'utf8')
  const twin = text.split('\r\n').find((line) => line.includes('"SYN-6001"'))!.replace('"Unknown","Active"', '"simple","Active"').replace('"Synthetic twin"', '"Synthetic twin again"').replace(/"SYN-6001","Unknown"/, '"SYN-3001","Unknown"')
  assert.ok(twin.includes('"SYN-3001"'), 'precondition: the twin row names SYN-3001')
  writeFileSync(path.join(dup, 'stock-on-hand.csv'), text.replace('"Synthetic part one"', `${twin.replace(/^"[^"]*"/, '"Synthetic part one twin"')}\r\n"Synthetic part one"`))
  const second = ingestDataset('stock-lots', readFileSync(path.join(dup, 'stock-on-hand.csv')), 'stock-on-hand.csv', stockMap().datasets['stock-lots']!)
  assert.ok(second.rejected.filter((r) => r.code === 'DUPLICATE_SOURCE_ROW').length >= 2)
  assert.equal(second.rows.filter((row) => row.values.sku === 'SYN-3001').length, 0, 'neither the real row nor its twin reaches opening stock')
})

test('superseding: a later file fills what it lacks from the earlier row (barcode), never blanks it, and a disagreeing identity field rejects the row', (t) => {
  const stock = ingestDataset('products', read('stock-on-hand.csv'), 'stock-on-hand.csv', stockMap().datasets.products!)
  const bundles = ingestDataset('products', read('bundles.csv'), 'bundles.csv', bundlesMap().datasets.products!)
  const merged = mergeIngested([stock, bundles], [false, true])
  const made = merged.rows.find((row) => row.values.sku === 'SYN-5001')!
  precondition(t, 'merged rows', merged.rows.length)
  assert.equal(made.values.barcode, '5012345678900', 'the barcode only the stock report reads survives')
  assert.equal(made.values.active, 'TRUE')
  assert.equal(made.values.type, 'BOM')
  assert.equal(made.values.weight, '0', 'the later file fills a field the earlier one did not read')
  assert.match(merged.superseded[0].reason, /kept from this row: .*barcode/)
  // Conflicts: a different name, then a type change that is not SIMPLE -> KIT/BOM.
  const renamed = { ...bundles, rows: bundles.rows.map((row) => (row.values.sku === 'SYN-5001' ? { ...row, values: { ...row.values, name: 'A different name' } } : row)) }
  const clash = mergeIngested([stock, renamed], [false, true])
  assert.deepEqual(clash.rejected.filter((r) => r.code === 'SUPERSEDE_CONFLICT').map((r) => r.line), [1_000_000 + 5])
  assert.ok(clash.rejected.find((r) => r.code === 'SUPERSEDE_CONFLICT')!.reason.includes('name differs'))
  assert.equal(clash.rows.filter((row) => row.values.sku === 'SYN-5001').length, 0)
  const retyped = { ...stock, rows: stock.rows.map((row) => (row.values.sku === 'SYN-5001' ? { ...row, values: { ...row.values, type: 'VARIANT' } } : row)) }
  const bad = mergeIngested([retyped, bundles], [false, true])
  assert.ok(bad.rejected.some((r) => r.code === 'SUPERSEDE_CONFLICT' && /only SIMPLE -> KIT or BOM/.test(r.reason)))
  assert.equal(clash.recordsRead, stock.recordsRead + bundles.recordsRead, 'a conflict moves a row from rows to rejected; nothing is lost from the count')
})

test('superseding: a product listed in several groups of the later file replaces the earlier row ONCE (one disposition per record)', (t) => {
  const stock = ingestDataset('products', read('stock-on-hand.csv'), 'stock-on-hand.csv', stockMap().datasets.products!)
  const bundles = ingestDataset('products', read('bundles.csv'), 'bundles.csv', bundlesMap().datasets.products!)
  const twice = { ...bundles, rows: [...bundles.rows, ...bundles.rows.filter((row) => row.values.sku === 'SYN-5001').map((row) => ({ ...row, line: row.line + 100 }))] }
  const merged = mergeIngested([stock, twice], [false, true])
  precondition(t, 'later rows for SYN-5001', twice.rows.filter((row) => row.values.sku === 'SYN-5001').length)
  assert.equal(merged.superseded.filter((entry) => entry.key === 'SYN-5001').length, 1)
  assert.equal(merged.rows.length + merged.rejected.length + merged.superseded.length, stock.rows.length + twice.rows.length + stock.rejected.length + twice.rejected.length, 'every record has exactly one place')
})

test('opening cost: zero cost with stock WARNS, a blank cost with stock is rejected (MISSING_UNIT_COST), a blank cost with no stock is just zero on hand', async (t) => {
  const dir = copyNative()
  dropLinesWith(dir, 'stock-on-hand.csv', ['"SYN-6001"', '"SYN-7001"', '"SYN-2000-01"'])
  const text = readFileSync(path.join(dir, 'stock-on-hand.csv'), 'utf8')
  // Blank the moving average cost of SYN-8001 (9 units in MIL1, cost "0" today) and of SYN-1003 (no stock).
  const blank = (sku: string, source: string) =>
    source
      .split('\r\n')
      .map((line) => {
        if (!line.includes(`"${sku}"`)) return line
        const cells = line.match(/"(?:[^"]|"")*"/g)!
        cells[8] = '""' // Moving Average Cost
        return cells.join(',')
      })
      .join('\r\n')
  const warnOut = fresh('zerocost')
  const warn = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', warnOut])
  precondition(t, 'report bytes', warn.stdout.length)
  assert.equal(warn.code, EXIT_CODES.OK)
  assert.ok(reportOf(warnOut).findings.some((f) => f.severity === 'WARNING' && f.code === 'ZERO_COST_OPENING_STOCK' && f.keys?.some((k) => k.startsWith('SYN-8001'))))
  writeFileSync(path.join(dir, 'stock-on-hand.csv'), blank('SYN-1003', blank('SYN-8001', text)))
  assert.notEqual(readFileSync(path.join(dir, 'stock-on-hand.csv'), 'utf8'), text)
  const out = fresh('blankcost')
  const run = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  const report = reportOf(out)
  assert.equal(run.code, EXIT_CODES.BLOCKING_FINDINGS)
  assert.equal(countOf(report, 'stock-lots', 'MISSING_UNIT_COST'), 1, 'only the SKU that holds stock')
  assert.ok(!report.findings.some((f) => f.code === 'ZERO_COST_OPENING_STOCK' && f.keys?.some((k) => k.startsWith('SYN-8001'))))
})

test('wide blocks across files: a key in two stock files refuses every row carrying it in BOTH files; one SKU in several blocks of one row is not a duplicate', async (t) => {
  const fileA = [['A1', '7', '3', 'y', '4', 'z'], ['B1', '5', '5', 'y', '0', 'z']]
  const fileB = [['a1', '9', '2', 'y', '7', 'z'], ['C1', '2', '1', 'y', '1', 'z']] // A1 again, asymmetric quantities
  const a = wideRead(LABELS, HEADER, WIDE, fileA)
  const b = wideRead(LABELS, HEADER, WIDE, fileB)
  const merged = mergeIngested([a, b])
  precondition(t, 'records across both files', merged.recordsRead)
  assert.deepEqual([...new Set(merged.rows.map((row) => row.values.sku))].sort(), ['B1', 'C1'], 'A1 is in neither file\'s accepted rows')
  assert.deepEqual(merged.rejected.map((r) => [r.line, r.code]).sort(), [[1_000_000 + 3, 'DUPLICATE_SOURCE_ROW'], [3, 'DUPLICATE_SOURCE_ROW']])
  assert.match(merged.rejected[0].reason, /is also on/)
  assert.equal(merged.rows.length + merged.rejected.length, merged.recordsRead, 'every record has one place')
  // Controls: B1 holds stock in two blocks of one row (not a duplicate), and distinct keys across files merge untouched.
  assert.equal(merged.rows.filter((row) => row.values.sku === 'B1').length, 2)
  const clean = mergeIngested([a, wideRead(LABELS, HEADER, WIDE, [['D1', '2', '1', 'y', '1', 'z']])])
  assert.equal(clean.rejected.length, 0)
  assert.equal(clean.recordsRead, 6)
  // Through the command line: the same SKU in two stock-lots files with different quantities never reaches opening stock.
  const dir = copyNative()
  const second = readFileSync(path.join(dir, 'stock-on-hand.csv'), 'utf8').replace('"15.000000","0.000000","15.000000","0.000000","0.000000","0.000000","False","10.000000"', '"21.000000","0.000000","21.000000","0.000000","0.000000","0.000000","False","16.000000"')
  writeFileSync(path.join(dir, 'stock-on-hand-2.csv'), second)
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  manifest.inputs.push({ dataset: 'stock-lots', file: 'stock-on-hand-2.csv', columnMap: 'maps/qoblex-stock-on-hand.map.json' })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  const out = fresh('twofiles')
  const run = await cli(['--manifest', path.join(dir, 'manifest.json'), '--out', out])
  const report = reportOf(out)
  assert.equal(run.code, EXIT_CODES.BLOCKING_FINDINGS)
  assert.ok(countOf(report, 'stock-lots', 'DUPLICATE_SOURCE_ROW') >= 2 * 7, 'every row of both files that shares a SKU is refused')
  assert.ok(report.accounting.every((row) => row.unaccounted === 0))
})

test('wide map: every block column needs a report total (omitting qty is refused at validation)', (t) => {
  const two = { ...WIDE, blockColumns: { qty: 'Quantity', unitCost: 'Other' }, totals: { unitCost: 'Total Quantity' } }
  precondition(t, 'maps', 2)
  assert.throws(() => parseColumnMap(wideMapText(two), 'm.json'), (e) => e instanceof InputError && /block column "qty" has no total header/.test(e.message))
  assert.doesNotThrow(() => parseColumnMap(wideMapText({ ...two, totals: { qty: 'Total Quantity', unitCost: 'Total Quantity' } }), 'm.json'))
})
