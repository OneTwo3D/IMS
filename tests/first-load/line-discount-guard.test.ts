/**
 * Owner ruling (2026-10-26): the Qoblex Incoming report has a per-line Discount (%) that the load never applies. An OPEN line (a quantity outstanding) with a
 * non-zero discount would import the GROSS price as its unit cost, so it is refused (PO_LINE_DISCOUNT_NOT_SUPPORTED). A blank discount is 0; a value that is not
 * a plain number from 0 to 100 is BAD_DISCOUNT. A line that is not imported (fully or over received, closed, cancelled) is not judged.
 *
 * Every arm names the mutation that turns it red (all are in /var/tmp/disc-mut.py).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ingestDataset, parseColumnMap } from '../../lib/first-load/ingest.ts'
import { dispositionCodes, ds, precondition, product, rowsOf, run } from './helpers.ts'

const NATIVE = path.join(process.cwd(), 'tests', 'first-load', 'fixtures', 'qoblex-native')
const line = (orderKey: string, extra: Record<string, string> = {}) => ({ orderKey, supplierName: 'Sup', sku: 'A', qtyOrdered: '2', qtyReceived: '0', unitCostForeign: '3', ...extra })
const po = (lines: Array<Record<string, string>>) => run({ products: ds('products', [product('A'), product('B')]), 'purchase-order-lines': ds('purchase-order-lines', lines) })
const codes = (r: ReturnType<typeof run>, outcome: 'REJECTED' | 'EXCLUDED') => dispositionCodes(r, 'purchase-order-lines', outcome).sort()

// [mutation: the discount check removed / the zero test inverted / the check run on a fully received line]
test('an OPEN line with a non-zero discount is refused PO_LINE_DISCOUNT_NOT_SUPPORTED, naming the order and SKU; the run is blocked and the line is not loaded', (t) => {
  const r = po([line('O1', { lineDiscountPercent: '15' }), line('O2', { lineDiscountPercent: '0.5' }), line('O3', { lineDiscountPercent: '100' }), line('O4', { qtyReceived: '1', lineDiscountPercent: '15' })])
  precondition(t, 'lines', 4)
  assert.deepEqual(codes(r, 'REJECTED'), ['PO_LINE_DISCOUNT_NOT_SUPPORTED', 'PO_LINE_DISCOUNT_NOT_SUPPORTED', 'PO_LINE_DISCOUNT_NOT_SUPPORTED', 'PO_LINE_DISCOUNT_NOT_SUPPORTED'], 'part received is still open')
  assert.equal(r.blocking, true)
  assert.deepEqual(rowsOf(r, 'purchase-orders'), [])
  const reason = r.report.dispositions.find((d) => d.code === 'PO_LINE_DISCOUNT_NOT_SUPPORTED')?.reason ?? ''
  assert.ok(/order O1 line A /.test(reason), 'the reason names the order and the SKU')
})

// [mutation: a fully received line judged / a closed line judged / a cancelled line judged]
test('a fully received, over received, closed or cancelled line with a discount is NOT refused (it is not imported)', (t) => {
  const r = po([
    line('O1', { qtyReceived: '2', lineDiscountPercent: '15' }),
    line('O2', { qtyReceived: '3', lineDiscountPercent: '15' }),
    line('O3', { status: 'CLOSED', lineDiscountPercent: '15' }),
    line('O4', { status: 'CANCELLED', lineDiscountPercent: '100' }),
    line('O5', { qtyReceived: '2', lineDiscountPercent: 'abc' }),
  ])
  precondition(t, 'lines', 5)
  assert.deepEqual(codes(r, 'REJECTED'), [])
  assert.deepEqual(codes(r, 'EXCLUDED'), ['FULLY_RECEIVED', 'FULLY_RECEIVED', 'NOT_OPEN', 'NOT_OPEN', 'OVER_RECEIVED'])
})

// [mutation: a blank discount treated as bad / as non-zero; a zero discount refused]
test('a blank, 0, 0.00 or whitespace discount loads the line normally at the written price', (t) => {
  const r = po([line('O1'), line('O2', { lineDiscountPercent: '' }), line('O3', { lineDiscountPercent: '0' }), line('O4', { lineDiscountPercent: '0.00' }), line('O5', { lineDiscountPercent: '  ' })])
  precondition(t, 'lines', 5)
  assert.deepEqual(codes(r, 'REJECTED'), [])
  assert.equal(r.blocking, false)
  assert.deepEqual(rowsOf(r, 'purchase-orders').map((x) => x.unitCostForeign), ['3', '3', '3', '3', '3'])
})

// [mutation: the non-numeric test removed / the upper bound removed / the lower bound removed / the bound moved to >= 100]
test('a discount that is not a number, is negative, or is above 100 is BAD_DISCOUNT; exactly 100 is a valid (refused-as-discounted) value, not a bad one', (t) => {
  const bad = ['abc', '120', '100.01', '-5', '15%', '1,5', '1e1']
  const r = po(bad.map((d, i) => line(`B${i}`, { lineDiscountPercent: d })))
  precondition(t, 'bad values', bad.length)
  assert.deepEqual(codes(r, 'REJECTED'), bad.map(() => 'BAD_DISCOUNT'))
  assert.deepEqual(codes(po([line('O1', { lineDiscountPercent: '100' })]), 'REJECTED'), ['PO_LINE_DISCOUNT_NOT_SUPPORTED'])
})

// [mutation: the discount column removed from the pinned map / the canonical column dropped from the spec]
test('the pinned native map reads Discount (%) into lineDiscountPercent, and a native file 15 arrives as the canonical value', (t) => {
  const mapping = parseColumnMap(readFileSync(path.join(NATIVE, 'maps', 'qoblex-incoming-stock.map.json'), 'utf8'), 'po.map.json').datasets['purchase-order-lines']!
  assert.equal(mapping.columns.lineDiscountPercent, 'Discount (%)')
  const csv = readFileSync(path.join(NATIVE, 'incoming-stock.csv'), 'utf8').replace('"18.5","0"', '"18.5","15"')
  precondition(t, 'edited', csv.includes('"18.5","15"') ? 1 : 0)
  const result = ingestDataset('purchase-order-lines', Buffer.from(csv, 'utf8'), 'incoming-stock.csv', mapping)
  assert.deepEqual(result.rows.map((row) => row.values.lineDiscountPercent), ['15', '0', '0', '0'])
})

const mapText = () => readFileSync(path.join(NATIVE, 'maps', 'qoblex-incoming-stock.map.json'), 'utf8')
const withoutDiscount = (constant?: string) => {
  const m = JSON.parse(mapText()) as { datasets: { 'purchase-order-lines': { columns: Record<string, string>; constants: Record<string, string> } } }
  const d = m.datasets['purchase-order-lines']
  delete d.columns.lineDiscountPercent
  if (constant !== undefined) d.constants.lineDiscountPercent = constant
  return JSON.stringify(m)
}

// [mutation: lineDiscountPercent dropped from the dataset's required columns]
test('a column map that leaves lineDiscountPercent out is refused (an omitted column must not read every discount as 0); a canonical file without the header is refused too', (t) => {
  precondition(t, 'maps', 1)
  assert.throws(() => parseColumnMap(withoutDiscount(), 'po.map.json'), /required canonical column "lineDiscountPercent" is neither mapped nor given a constant.*PO_LINE_DISCOUNT_COLUMN_REQUIRED/)
  assert.doesNotThrow(() => parseColumnMap(mapText(), 'po.map.json'), 'the full map works as today')
  const header = 'orderKey,supplierName,sku,qtyOrdered,qtyReceived,unitCostForeign\r\nO1,Sup,A,2,0,100\r\n'
  assert.throws(() => ingestDataset('purchase-order-lines', Buffer.from(header, 'utf8'), 'po.csv', null), /required column "lineDiscountPercent" is missing/)
})

type PoMap = { datasets: { 'purchase-order-lines': { columns: Record<string, string>; constants: Record<string, string>; valueMaps: Record<string, Record<string, string>>; derived?: Record<string, string>; dateFormats?: Record<string, string>; expectedHeaders?: string[] } } }
const editedMap = (edit: (d: PoMap['datasets']['purchase-order-lines']) => void) => {
  const m = JSON.parse(mapText()) as PoMap
  edit(m.datasets['purchase-order-lines'])
  return JSON.stringify(m)
}

// [mutation: the direct-column rule removed / limited to lineDiscountPercent / the constant check removed for one column]
test('a valuation column given a constant is refused (VALUATION_COLUMN_NOT_DIRECT): the discount, the price, both quantities, the stock-lot figures and the transfer quantities', (t) => {
  const cases: Array<[string, string, string]> = [
    ['purchase-order-lines', 'lineDiscountPercent', 'Discount (%)'], ['purchase-order-lines', 'unitCostForeign', 'Price'], ['purchase-order-lines', 'qtyOrdered', 'Ordered Quantity'], ['purchase-order-lines', 'qtyReceived', 'Received Quantity'],
    ['stock-lots', 'qty', 'Q'], ['stock-lots', 'unitCost', 'C'], ['stock-lots', 'fxRateToBase', 'R'], ['transfers', 'qtyShipped', 'S'], ['transfers', 'qtyReceived', 'R'],
  ]
  precondition(t, 'cases', cases.length)
  for (const [dataset, column, header] of cases) {
    const base = { formatVersion: 1, source: 'qoblex', datasets: { [dataset]: { columns: { [column]: header }, constants: {} } } }
    const text = (edit: (d: { columns: Record<string, string>; constants: Record<string, string>; valueMaps?: Record<string, Record<string, string>> }) => void) => { const m = JSON.parse(JSON.stringify(base)); edit(m.datasets[dataset]); return JSON.stringify(m) }
    const refusedWith = (json: string) => { try { parseColumnMap(json, 'x.map.json'); return '' } catch (e) { return String((e as Error).message) } }
    assert.match(refusedWith(text((d) => { delete d.columns[column]; d.constants[column] = '0' })), /VALUATION_COLUMN_NOT_DIRECT: "[A-Za-z]+" is given a constant/, `${dataset}.${column} constant`)
    assert.match(refusedWith(text((d) => { d.valueMaps = { [column]: { x: '1' } } })), /VALUATION_COLUMN_NOT_DIRECT: "[A-Za-z]+" has a valueMaps entry/, `${dataset}.${column} value map`)
  }
})

// [mutation: the derived check removed]
test('a valuation column that is derived is refused (VALUATION_COLUMN_NOT_DIRECT)', (t) => {
  precondition(t, 'maps', 1)
  const text = editedMap((d) => { delete d.columns.lineDiscountPercent; d.derived = { lineDiscountPercent: 'qtyOrdered' }; d.valueMaps.lineDiscountPercent = { '2': '0' } })
  assert.throws(() => parseColumnMap(text, 'x.map.json'), /VALUATION_COLUMN_NOT_DIRECT: "lineDiscountPercent" is derived/)
})

// [mutation: the renamed-header map rejected / the header looked up by name]
test('a direct map to a renamed header is accepted for a custom map, with or without declared headers', (t) => {
  precondition(t, 'maps', 2)
  assert.doesNotThrow(() => parseColumnMap(editedMap((d) => { d.columns.lineDiscountPercent = 'Disc %'; delete d.expectedHeaders }), 'x.map.json'))
  assert.doesNotThrow(() => parseColumnMap(editedMap((d) => { d.columns.lineDiscountPercent = 'Disc %'; d.expectedHeaders = (d.expectedHeaders ?? []).map((h) => (h === 'Discount (%)' ? 'Disc %' : h)) }), 'x.map.json'))
})

// [mutation: the exact-header rule removed / the discount-looking header rule removed]
test('a map whose file has the pinned "Discount (%)" header must map lineDiscountPercent to exactly it; a declared discount-looking header must be the mapped one', (t) => {
  precondition(t, 'maps', 3)
  assert.throws(() => parseColumnMap(editedMap((d) => { d.columns.lineDiscountPercent = 'Received on' }), 'x.map.json'), /must be mapped to exactly that header/)
  assert.throws(() => parseColumnMap(editedMap((d) => { d.columns.lineDiscountPercent = 'Received on'; d.expectedHeaders = (d.expectedHeaders ?? []).map((h) => (h === 'Discount (%)' ? 'Disc (%)' : h)) }), 'x.map.json'), /looks like a discount column/)
  assert.doesNotThrow(() => parseColumnMap(mapText(), 'x.map.json'))
})

// [mutation: the unread-discount-header finding removed / narrowed to "discount" / downgraded to a warning]
test('BACKSTOP: a discount-looking header the map leaves unread (Rabatt, Remise, Sconto, Descuento, Disc) blocks the run (DISCOUNT_COLUMN_NOT_READ); the full map does not', (t) => {
  const names = ['Rabatt', 'Remise %', 'Sconto', 'Descuento', 'Disc (%)']
  precondition(t, 'names', names.length)
  for (const name of names) {
    const csv = `Purchase Order,Supplier,SKU,Ordered Quantity,Received Quantity,Price,Disc,Status,${name}\r\nO1,Sup,A,2,0,100,0,Approved,15\r\n`
    const mapped = parseColumnMap(editedMap((d) => { d.columns.lineDiscountPercent = 'Disc'; d.columns.status = 'Status'; delete d.expectedHeaders; delete d.dateFormats; delete d.columns.createdOn; delete d.columns.expectedDelivery; delete d.columns.supplierRef }), 'x.map.json').datasets['purchase-order-lines']!
    const ingested = ingestDataset('purchase-order-lines', Buffer.from(csv, 'utf8'), 'po.csv', mapped)
    const found = run({ products: ds('products', [product('A')]), 'purchase-order-lines': ingested }).report.findings.filter((f) => f.code === 'DISCOUNT_COLUMN_NOT_READ' && f.severity === 'ERROR')
    assert.equal(found.length, 1, name)
  }
})
