/**
 * Reading input files: strict CSV, UTF-8 and BOM, and the column-map format failing closed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CsvFormatError, parseCsvStrict, serializeCsv } from '../../lib/first-load/csv.ts'
import { InputError, ingestDataset, parseColumnMap } from '../../lib/first-load/ingest.ts'
import { parseDecimal } from '../../lib/first-load/money.ts'
import { precondition } from './helpers.ts'

const enc = (text: string) => new TextEncoder().encode(text)

test('strict CSV: a UTF-8 BOM is stripped and reported, CRLF and embedded newlines keep line numbers', (t) => {
  const parsed = parseCsvStrict('﻿a,b\r\n1,"x\ny"\r\n\r\n2,3\r\n')
  precondition(t, 'records', parsed.rows.length)
  assert.equal(parsed.hadBom, true)
  assert.deepEqual(parsed.header, ['a', 'b'])
  assert.deepEqual(parsed.rows.map((r) => [r.line, r.cells]), [[2, ['1', 'x\ny']], [5, ['2', '3']]])
  assert.equal(parsed.blankRows, 1)
})

test('strict CSV: stray quotes, text after a closing quote and an unterminated quote are refused', (t) => {
  const bad = ['a,b\n1,x"y\n', 'a,b\n1,"x"y\n', 'a,b\n1,"never closed\n', '']
  precondition(t, 'malformed inputs', bad.length)
  for (const text of bad) assert.throws(() => parseCsvStrict(text), CsvFormatError, JSON.stringify(text))
})

test('strict CSV: round trip through the writer is exact for commas, quotes and newlines', (t) => {
  const rows = [['plain', 'a,b', 'say "hi"', 'two\nlines', ' padded ']]
  const text = serializeCsv(['h1', 'h2', 'h3', 'h4', 'h5'], rows)
  const parsed = parseCsvStrict(text)
  precondition(t, 'cells', rows[0].length)
  assert.deepEqual(parsed.rows[0].cells, rows[0])
  assert.ok(!text.startsWith('﻿'), 'no BOM is ever written')
  assert.ok(text.endsWith('\r\n'))
})

test('ingest: invalid UTF-8 is refused (no other encoding is guessed)', (t) => {
  precondition(t, 'cases', 1)
  assert.throws(() => ingestDataset('suppliers', new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xff, 0xfe, 0x0a]), 'f.csv', null), (error) => error instanceof InputError && /UTF-8/.test(error.message))
})

test('ingest: a ragged row is rejected with its line, never padded; blank lines are counted apart', (t) => {
  const result = ingestDataset('suppliers', enc('name,currency\nAcme,GBP\nShort\n\nLong,GBP,extra\n'), 'f.csv', null)
  precondition(t, 'records read', result.recordsRead)
  assert.equal(result.rows.length, 1)
  assert.deepEqual(result.rejected.map((r) => [r.line, r.code]), [[3, 'RAGGED_ROW'], [5, 'RAGGED_ROW']])
  assert.equal(result.blankRows, 1)
  assert.equal(result.recordsRead, 3)
})

test('ingest: a canonical file with an unknown or duplicated column, or a missing required one, is refused', (t) => {
  const cases = ['name,mystery\nA,1\n', 'name,name\nA,A\n', 'currency\nGBP\n']
  precondition(t, 'bad canonical files', cases.length)
  for (const text of cases) assert.throws(() => ingestDataset('suppliers', enc(text), 'f.csv', null), InputError, text)
})

const map = (datasets: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ formatVersion: 1, source: 'qoblex', datasets, ...extra })
const supplierMap = (entry: Record<string, unknown>) => map({ suppliers: { columns: { name: 'Supplier' }, ...entry } })

test('column map: every ambiguous or sloppy shape is refused with a message naming the problem', (t) => {
  const cases: Array<[string, string, RegExp]> = [
    ['unknown top-level key', map({}, { surprise: 1 }), /unknown key "surprise"/],
    ['unknown dataset key', supplierMap({ colunms: {} }), /unknown key "colunms"/],
    ['unknown canonical column', supplierMap({ columns: { name: 'Supplier', nmae: 'X' } }), /"nmae" is not a canonical column/],
    ['one source header, two canonical columns', supplierMap({ columns: { name: 'Supplier', contactName: 'Supplier' } }), /more than one canonical column/],
    ['mapped and constant', supplierMap({ constants: { name: 'X' } }), /both mapped to a column and given a constant/],
    ['required column absent', map({ suppliers: { columns: { currency: 'Cur' } } }), /required canonical column "name"/],
    ['decimal comma declared', supplierMap({ decimalSeparator: ',' }), /decimal commas are rejected/],
    ['wrong source for the dataset', JSON.stringify({ formatVersion: 1, source: 'wms', datasets: { products: { columns: { sku: 'a', name: 'b', type: 'c' } } } }), /cannot feed this dataset/],
    ['bad format version', JSON.stringify({ formatVersion: 2, source: 'qoblex', datasets: {} }), /formatVersion must be 1/],
    ['not JSON', '{', /not valid JSON/],
  ]
  precondition(t, 'bad column maps', cases.length)
  for (const [name, text, expected] of cases) {
    assert.throws(() => parseColumnMap(text, 'm.json'), (error) => error instanceof InputError && expected.test(error.message), name)
  }
})

test('column map: a mapped header that is missing or duplicated is an error; a look-alike header is a hint, never used', (t) => {
  const mapping = parseColumnMap(supplierMap({}), 'm.json').datasets.suppliers!
  precondition(t, 'cases', 2)
  assert.throws(() => ingestDataset('suppliers', enc('supplier,Cur\nA,GBP\n'), 'f.csv', mapping), (error) => (
    error instanceof InputError && /is not in the file/.test(error.message) && /A similar header exists \("supplier"\)/.test(error.message) && /NOT used/.test(error.message)
  ))
  assert.throws(() => ingestDataset('suppliers', enc('Supplier,Supplier\nA,B\n'), 'f.csv', mapping), (error) => error instanceof InputError && /appears 2 times/.test(error.message))
})

test('column map: a value map is a closed list (unmapped value rejects that row), constants fill, unread columns are listed', (t) => {
  const mapping = parseColumnMap(map({
    products: {
      columns: { sku: 'Code', name: 'Name', type: 'Class' },
      constants: { stockUnit: 'pcs' },
      valueMaps: { type: { Stocked: 'SIMPLE', Bundle: 'KIT' } },
    },
  }), 'm.json').datasets.products!
  const result = ingestDataset('products', enc('Code,Name,Class,Colour\nA,Alpha,Stocked,red\nB,Beta,Gadget,blue\nC,Gamma,Bundle,green\n'), 'f.csv', mapping)
  precondition(t, 'records read', result.recordsRead)
  assert.deepEqual(result.rows.map((r) => [r.values.sku, r.values.type, r.values.stockUnit]), [['A', 'SIMPLE', 'pcs'], ['C', 'KIT', 'pcs']])
  assert.deepEqual(result.rejected.map((r) => [r.line, r.code]), [[3, 'UNMAPPED_VALUE']])
  assert.deepEqual(result.unmappedHeaders, ['Colour'])
})

test('column map: expectedHeaders pins the sample header against export drift; a delimiter other than "," must be declared', (t) => {
  const pinned = parseColumnMap(supplierMap({ expectedHeaders: ['Supplier', 'Cur'] }), 'm.json').datasets.suppliers!
  const semicolon = parseColumnMap(supplierMap({ delimiter: ';' }), 'm.json').datasets.suppliers!
  precondition(t, 'cases', 3)
  assert.equal(ingestDataset('suppliers', enc('Supplier,Cur\nA,GBP\n'), 'f.csv', pinned).rows.length, 1)
  assert.throws(() => ingestDataset('suppliers', enc('Supplier,Cur,Extra\nA,GBP,x\n'), 'f.csv', pinned), (error) => error instanceof InputError && /expectedHeaders/.test(error.message))
  assert.equal(ingestDataset('suppliers', enc('Supplier;Cur\nA;GBP\n'), 'f.csv', semicolon).rows[0].values.name, 'A')
})

test('decimal parsing: accepted and refused forms', (t) => {
  const limits = { maxIntDigits: 8, maxDp: 6 }
  const accepted = ['0', '12', '12.5', '0.000001', '007', '99999999.999999']
  const refused = ['', ' ', '1,5', '1.5.5', '1e3', 'NaN', 'Infinity', '٣', '1_000', '- 1', '12345678.1234567', '100000000']
  precondition(t, 'forms', accepted.length + refused.length)
  for (const text of accepted) assert.equal(parseDecimal(text, 'x', limits).ok, true, text)
  for (const text of refused) assert.equal(parseDecimal(text, 'x', limits).ok, false, text)
})
