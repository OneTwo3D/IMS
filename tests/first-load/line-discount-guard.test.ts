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

// [mutation: the unread-discount-header check removed / narrowed to a different pattern]
test('a discount header the map leaves unread blocks the run (DISCOUNT_COLUMN_NOT_READ), even when lineDiscountPercent is given a constant; the full map reads it and does not', (t) => {
  const csv = Buffer.from(readFileSync(path.join(NATIVE, 'incoming-stock.csv'), 'utf8').replace('"18.5","0"', '"18.5","15"'), 'utf8')
  precondition(t, 'csv', csv.length)
  const ingest = (text: string) => ingestDataset('purchase-order-lines', csv, 'incoming-stock.csv', parseColumnMap(text, 'po.map.json').datasets['purchase-order-lines']!)
  const finding = (d: ReturnType<typeof ingest>) => run({ products: ds('products', [product('SYN-1001'), product('SYN-1002'), product('SYN-3001'), product('SYN-3002')]), 'purchase-order-lines': d }).report.findings.filter((f) => f.code === 'DISCOUNT_COLUMN_NOT_READ' && f.severity === 'ERROR')
  assert.equal(finding(ingest(withoutDiscount('0'))).length, 1, 'constant 0 with the header unread is blocked')
  assert.equal(finding(ingest(mapText())).length, 0, 'the full map reads the column')
  const blocked = run({ products: ds('products', [product('SYN-1001')]), 'purchase-order-lines': ingest(withoutDiscount('0')) })
  assert.equal(blocked.blocking, true)
})
