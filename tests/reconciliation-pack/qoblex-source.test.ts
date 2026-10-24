import assert from 'node:assert/strict'
import { chmodSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { PACK_CADENCE_MAX_AGE_MS } from '../../lib/reconciliation-pack/constants.ts'
import { QOBLEX_NATIVE_COLUMN_MAP } from '../../lib/reconciliation-pack/qoblex-native-map.ts'
import { createQoblexSource, parseQoblexManifest, qoblexStaleness, readQoblexExport } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { ASOF, DEFAULT_STOCK, EXPORTED_AT, LOCATIONS, productsCsv, sha256, stockCsv, writeExport } from './qoblex-fixtures.ts'
import { NOW, cleanup } from './helpers.ts'

/**
 * THE QOBLEX SOURCE: trust, digest, manifest, freshness and the parse of the export. Every refusal is a closed reason and NO rows.
 * Mutations are listed in the PR.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))
const read = (dir: string, asOf = ASOF, now = NOW) => readQoblexExport(dir, asOf, now)
const refused = (dir: string, reason: string, asOf = ASOF, now = NOW) => {
  const r = read(dir, asOf, now)
  assert.deepEqual(r.ok ? 'ok' : r.reason, reason)
}
const partReason = (r: ReturnType<typeof read>, name: 'stock' | 'products') => {
  assert.ok(r.ok, JSON.stringify(r))
  const part = r.value[name]
  return part.ok ? 'ok' : part.reason
}

test('a well-formed export reads: stock lots, products, locations, and the digest of every file read once', () => {
  const dir = writeExport(bases)
  const r = read(dir)
  assert.ok(r.ok)
  assert.equal(r.value.stock.ok && r.value.stock.value.length, 3)
  assert.deepEqual(r.value.products.ok && r.value.products.value.map((p) => p.sku), ['SKU-1', 'SKU-2', 'SKU-3'])
  assert.deepEqual(r.value.locations, LOCATIONS)
  assert.deepEqual(r.value.files.map((f) => f.name).sort(), ['products.csv', 'stock.csv'])
  assert.equal(r.value.files.find((f) => f.name === 'stock.csv')!.sha256, sha256(DEFAULT_STOCK))
})

// [mutation: the directory/ancestor trust check removed]
test('a directory another account could modify is SOURCE_UNREADABLE', () => {
  const dir = writeExport(bases)
  chmodSync(dir, 0o777)
  refused(dir, 'SOURCE_UNREADABLE')
})

// [mutation: the file mode / owner check removed (readTrustedRegularFileBytes replaced by a plain read)]
test('a file writable by group or others, or reached through a symlink, is SOURCE_UNREADABLE (the manifest, and a data file)', () => {
  const dir = writeExport(bases)
  chmodSync(path.join(dir, 'stock.csv'), 0o666)
  assert.equal(partReason(read(dir), 'stock'), 'SOURCE_UNREADABLE')
  assert.equal(partReason(read(dir), 'products'), 'ok', 'the other part is judged on its own')
  chmodSync(path.join(dir, 'stock.csv'), 0o644)
  chmodSync(path.join(dir, 'manifest.json'), 0o664)
  refused(dir, 'SOURCE_UNREADABLE')
  chmodSync(path.join(dir, 'manifest.json'), 0o644)
  // a symlink in place of the data file
  renameSync(path.join(dir, 'products.csv'), path.join(dir, 'real-products.csv'))
  symlinkSync(path.join(dir, 'real-products.csv'), path.join(dir, 'products.csv'))
  assert.equal(partReason(read(dir), 'products'), 'SOURCE_UNREADABLE')
  // a symlink in place of the manifest
  renameSync(path.join(dir, 'manifest.json'), path.join(dir, 'real-manifest.json'))
  symlinkSync(path.join(dir, 'real-manifest.json'), path.join(dir, 'manifest.json'))
  refused(dir, 'SOURCE_UNREADABLE')
})

test('a directory that does not exist, or no manifest, is SOURCE_UNREADABLE', () => {
  const dir = writeExport(bases)
  refused(path.join(dir, 'nope'), 'SOURCE_UNREADABLE')
  renameSync(path.join(dir, 'manifest.json'), path.join(dir, 'm.json'))
  refused(dir, 'SOURCE_UNREADABLE')
})

// [mutation: the declared-digest comparison removed]
test('a file whose bytes do not hash to the digest the manifest declares is unreadable (a copy in progress, an edit)', () => {
  const dir = writeExport(bases)
  writeFileSync(path.join(dir, 'stock.csv'), DEFAULT_STOCK.replace('SKU-1', 'SKU-9'))
  assert.equal(partReason(read(dir), 'stock'), 'SOURCE_UNREADABLE')
  assert.equal(partReason(read(dir), 'products'), 'ok')
})

// [mutation: the cache removed so a shared file is read twice / the second use's digest not compared]
test('a file used by two parts is read ONCE, and a second use must declare the same digest', () => {
  const same = productsCsv([{ sku: 'SKU-1' }])
  const dir = writeExport(bases, { stock: null, products: same, patch: (m) => { m.stock = { file: 'products.csv', sha256: sha256(same) } } })
  const r = read(dir)
  assert.ok(r.ok)
  assert.equal(r.value.files.filter((f) => f.name === 'products.csv').length, 1)
  const other = writeExport(bases, { stock: null, products: same, patch: (m) => { m.stock = { file: 'products.csv', sha256: 'a'.repeat(64) } } })
  assert.equal(partReason(read(other), 'stock'), 'SOURCE_UNREADABLE')
})

// [mutation: any one of the manifest's closed-set checks removed]
test('the manifest is closed: an unknown or missing key, another version, another currency, a repeated or ill-named location, a path as a file name', () => {
  const dir = (patch: (m: Record<string, unknown>) => void) => writeExport(bases, { patch })
  refused(dir((m) => { m.extra = 1 }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { delete m.exportedAt }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { delete m.asOf }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { m.formatVersion = 2 }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { m.baseCurrency = 'EUR' }), 'CURRENCY_UNKNOWN')
  refused(dir((m) => { m.locations = [] }), 'NO_POPULATION_RECORD')
  refused(dir((m) => { m.locations = [...LOCATIONS, { ...LOCATIONS[0]! }] }), 'DUPLICATE_KEY')
  refused(dir((m) => { m.locations = [{ code: 'mil1', company: 'ACME', threePl: false }] }), 'NO_POPULATION_RECORD')
  refused(dir((m) => { m.locations = [{ code: 'MIL1', company: 'ACME', threePl: 'no' }] }), 'NO_POPULATION_RECORD')
  refused(dir((m) => { m.locations = [{ code: 'MIL1', company: 'ACME', threePl: false, extra: 1 }] }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { (m.stock as Record<string, unknown>).file = '../stock.csv' }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { (m.stock as Record<string, unknown>).file = 'sub/stock.csv' }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { (m.stock as Record<string, unknown>).file = 'manifest.json' }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { (m.stock as Record<string, unknown>).sha256 = 'XYZ' }), 'SOURCE_UNREADABLE')
  refused(dir((m) => { (m.stock as Record<string, unknown>).columnMap = { file: 'stock.csv', sha256: sha256(DEFAULT_STOCK) } }), 'DUPLICATE_KEY')
  assert.throws(() => parseQoblexManifest('{not json'), (e) => (e as { reason?: string }).reason === 'SOURCE_UNREADABLE')
  refused(writeExport(bases, { manifestText: '[]' }), 'SOURCE_UNREADABLE')
  refused(writeExport(bases, { manifestText: '{"__proto__":{"x":1}}' }), 'SOURCE_UNREADABLE')
})

test('a manifest that lists no stock part (or no products part) leaves that part unreadable, not empty', () => {
  assert.equal(partReason(read(writeExport(bases, { stock: null })), 'stock'), 'SOURCE_UNREADABLE')
  assert.equal(partReason(read(writeExport(bases, { products: null })), 'products'), 'SOURCE_UNREADABLE')
})

// [mutation: any one freshness test removed or loosened: the asOf equality, the day-end floor, the future test, the age limit]
test('freshness: asOf must be the run\'s, exported after that day ended, not in the future, within the weekly cadence (boundaries)', () => {
  const weekly = PACK_CADENCE_MAX_AGE_MS.weekly
  const stale = (exportedAt: string, asOf = ASOF, run = ASOF, now = NOW) => qoblexStaleness({ exportedAt, asOf }, run, now)
  assert.equal(stale(EXPORTED_AT), null)
  assert.equal(stale(EXPORTED_AT, '2026-10-18'), 'QOBLEX_EXPORT_STALE', 'an export for another day')
  assert.equal(stale('2026-10-19T23:59:59.999Z'), 'QOBLEX_EXPORT_STALE', 'exported before the cycle date ended')
  assert.equal(stale('2026-10-20T00:00:00.000Z'), null, 'exactly at the end of the day')
  assert.equal(stale('2026-10-20T12:00:00.001Z'), 'QOBLEX_EXPORT_STALE', 'dated after now')
  assert.equal(stale('2026-10-20T12:00:00.000Z'), null, 'exactly now')
  const old = new Date(NOW.getTime() + weekly)
  assert.equal(stale('2026-10-20T12:00:00.000Z', ASOF, ASOF, old), null, 'exactly at the cadence')
  assert.equal(stale('2026-10-20T12:00:00.000Z', ASOF, ASOF, new Date(old.getTime() + 1)), 'QOBLEX_EXPORT_STALE', 'one millisecond past')
  // through the whole read: stale refuses before any data file is parsed
  refused(writeExport(bases, { asOf: '2026-10-18' }), 'QOBLEX_EXPORT_STALE')
  refused(writeExport(bases, { exportedAt: '2026-10-19T12:00:00Z' }), 'QOBLEX_EXPORT_STALE')
  refused(writeExport(bases), 'QOBLEX_EXPORT_STALE', ASOF, new Date('2026-11-30T00:00:00Z'))
})

// [mutation: the ingest's rejected rows ignored / a partial list returned]
test('a malformed export part is unreadable and returns NO rows: header, row, quantity, location, SKU, empty file', () => {
  const stockWith = (csv: string) => partReason(read(writeExport(bases, { stock: csv })), 'stock')
  assert.equal(stockWith(DEFAULT_STOCK.replace('sku,warehouseCode', 'sku,wh')), 'SOURCE_UNREADABLE', 'a header that is not canonical')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '-1', unitCost: '1' }])), 'ok', 'a negative quantity is data (an oversold position), compared as it is')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '1.0000000000001', unitCost: '1' }])), 'BAD_VALUE', 'more decimals than the comparator reads')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '1e3', unitCost: '1' }])), 'BAD_VALUE', 'an exponent')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: 'ten', unitCost: '1' }])), 'BAD_VALUE')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1' }, { sku: 'SKU-2', location: 'MIL1', qty: 'x', unitCost: '1' }])), 'BAD_VALUE', 'one bad row among good ones: no partial list')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'ELSEWHERE', qty: '1', unitCost: '1' }])), 'NO_POPULATION_RECORD', 'a location the manifest does not declare')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU 1​', location: 'MIL1', qty: '1', unitCost: '1' }])), 'IDENTITY_NOT_CANONICAL', 'a zero-width character in a SKU')
  assert.equal(stockWith(stockCsv([{ sku: '', location: 'MIL1', qty: '1', unitCost: '1' }])), 'IDENTITY_NOT_CANONICAL', 'an empty SKU')
  assert.equal(stockWith(stockCsv([])), 'SOURCE_UNREADABLE', 'a file with no rows says nothing about the stock')
  assert.equal(stockWith(''), 'SOURCE_UNREADABLE')
  assert.equal(stockWith(stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1', currency: 'gbp' }])), 'CURRENCY_UNKNOWN')
})

// [mutation: the duplicate (SKU, location) test removed / lots summed without distinct references]
test('a repeated (SKU, location) is a duplicate unless every row carries a distinct lot reference, and then the lots are all kept', () => {
  const stockWith = (rows: Parameters<typeof stockCsv>[0]) => read(writeExport(bases, { stock: stockCsv(rows) }))
  const dupe = stockWith([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1' }, { sku: 'SKU-1', location: 'MIL1', qty: '2', unitCost: '1' }])
  assert.equal(partReason(dupe, 'stock'), 'DUPLICATE_KEY')
  const oneBlank = stockWith([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1', lot: 'A' }, { sku: 'SKU-1', location: 'MIL1', qty: '2', unitCost: '1' }])
  assert.equal(partReason(oneBlank, 'stock'), 'DUPLICATE_KEY')
  const lotted = stockWith([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1', lot: 'A' }, { sku: 'SKU-1', location: 'MIL1', qty: '2', unitCost: '1', lot: 'B' }])
  assert.equal(partReason(lotted, 'stock'), 'ok')
  const sameRef = stockWith([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1', lot: 'A' }, { sku: 'SKU-1', location: 'MIL1', qty: '2', unitCost: '1', lot: 'a ' }])
  assert.equal(partReason(sameRef, 'stock'), 'DUPLICATE_KEY', 'a reference that differs only by case or a space is the same reference')
})

test('products: a type that is not a product type, a repeated SKU and two SKUs that differ only in case are unreadable', () => {
  const productsWith = (csv: string) => partReason(read(writeExport(bases, { products: csv })), 'products')
  assert.equal(productsWith(productsCsv([{ sku: 'SKU-1', type: 'WIDGET' }])), 'SOURCE_UNREADABLE')
  assert.equal(productsWith(productsCsv([{ sku: 'SKU-1' }, { sku: 'SKU-1' }])), 'DUPLICATE_KEY')
  assert.equal(productsWith(productsCsv([{ sku: 'SKU-1' }, { sku: 'sku-1' }])), 'DUPLICATE_KEY')
  assert.equal(productsWith(productsCsv([{ sku: 'SKU-1', type: 'VARIANT' }])), 'ok')
})

test('the native column map is read once and parsed by the first-load ingest; a map that is not the native one is refused', () => {
  const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')
  const native = readFileSync(path.join(nativeDir, 'stock-on-hand.csv'), 'utf8').split('\r\n')
  // The fixture carries a deliberately bad row ('Unknown' product type); the export an operator supplies must not.
  const clean = native.filter((line) => !/^"[^"]*","[^"]*","SYN-[0-9A-Z-]*","[^"]*","[Uu]nknown"/.test(line)).join('\r\n')
  assert.ok(clean.length < native.join('\r\n').length, 'the bad row was dropped')
  const map = readFileSync(path.join(nativeDir, 'maps/qoblex-stock-on-hand.map.json'), 'utf8')
  const dir = writeExport(bases, {
    stock: clean, products: null,
    locations: ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: code === 'RXT2' })),
    extra: { 'map.json': map, 'stock.csv': clean },
    patch: (m) => {
      m.stock = { file: 'stock.csv', sha256: sha256(clean), columnMap: { file: 'map.json', sha256: sha256(map) } }
      m.products = { file: 'stock.csv', sha256: sha256(clean), columnMap: { file: 'map.json', sha256: sha256(map) } }
    },
  })
  const r = read(dir)
  assert.ok(r.ok)
  assert.equal(r.value.files.filter((f) => f.name === 'stock.csv').length, 1, 'the one report feeds two datasets and is read once')
  assert.equal(r.value.files.filter((f) => f.name === 'map.json').length, 1)
  assert.ok(r.value.stock.ok, JSON.stringify(r.value.stock))
  assert.ok(r.value.stock.ok && r.value.stock.value.some((l) => l.sku === 'SYN-1001' && l.location === 'MIL1' && l.qty === '10.000000'))
  // not a qoblex map
  const wrong = map.replace('"source": "qoblex"', '"source": "wms"')
  assert.notEqual(wrong, map)
  const bad = writeExport(bases, { stock: clean, products: null, locations: ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: false })), extra: { 'map.json': wrong, 'stock.csv': clean }, patch: (m) => { m.stock = { file: 'stock.csv', sha256: sha256(clean), columnMap: { file: 'map.json', sha256: sha256(wrong) } } } })
  assert.equal(partReason(read(bad), 'stock'), 'COLUMN_MAP_NOT_NATIVE')
})

// [mutation: the native-map digest check removed from ingest()]
test('a column map cannot change what is compared: ONLY the repository\'s native map is accepted, by the bytes read (a valueMap 9 -> 10, a constant, a skip, one changed byte are all COLUMN_MAP_NOT_NATIVE)', () => {
  const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')
  const clean = readFileSync(path.join(nativeDir, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((line) => !/^"[^"]*","[^"]*","SYN-[0-9A-Z-]*","[^"]*","[Uu]nknown"/.test(line)).join('\r\n')
  const nativeText = readFileSync(path.join(nativeDir, 'maps/qoblex-stock-on-hand.map.json'), 'utf8')
  const original = JSON.parse(nativeText) as { datasets: Record<string, Record<string, unknown>> }
  const locations = ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: code === 'RXT2' }))
  const exportWithText = (map: string | null) => read(writeExport(bases, { stock: clean, products: null, locations, extra: { 'map.json': map ?? '', 'stock.csv': clean }, patch: (man) => {
    const ref = { file: 'stock.csv', sha256: sha256(clean), ...(map === null ? {} : { columnMap: { file: 'map.json', sha256: sha256(map) } }) }
    man.stock = ref; man.products = ref
  } }))
  const exportWith = (edit: (m: typeof original) => void) => { const m = JSON.parse(nativeText) as typeof original; edit(m); return exportWithText(JSON.stringify(m)) }
  // the repository's own copy is the first-load tool's tested map, byte for byte
  assert.equal(QOBLEX_NATIVE_COLUMN_MAP, nativeText)
  // the unedited native map reads both datasets
  const plain = exportWithText(nativeText)
  assert.equal(partReason(plain, 'stock'), 'ok')
  assert.equal(partReason(plain, 'products'), 'ok')
  // one changed byte, with the digest declared honestly, is still not the native map
  for (const text of [`${nativeText} `, `${nativeText}\n`, nativeText.replace('"formatVersion": 1', '"formatVersion":1')]) {
    assert.notEqual(text, nativeText)
    assert.equal(partReason(exportWithText(text), 'stock'), 'COLUMN_MAP_NOT_NATIVE')
    assert.equal(partReason(exportWithText(text), 'products'), 'COLUMN_MAP_NOT_NATIVE')
  }
  // the same content re-serialised (every key and value equal) is not the native map either: the bytes are what is pinned
  assert.equal(partReason(exportWith(() => undefined), 'stock'), 'COLUMN_MAP_NOT_NATIVE')
  // edits that would change a compared value
  const edits: Array<[string, (m: typeof original) => void]> = [
    ['a valueMap turning stock qty 9 into 10', (m) => { const e = m.datasets['stock-lots']!; (e.valueMaps as Record<string, unknown>) = { qty: { '9.000000': '10.000000' } } }],
    ['a valueMap on the SKU', (m) => { m.datasets['stock-lots']!.valueMaps = { sku: { 'SYN-1001': 'SYN-9999' } } }],
    ['a valueMap on the product type', (m) => { (m.datasets.products!.valueMaps as Record<string, Record<string, string>>).type!.simple = 'VARIANT' }],
    ['a warehouse label pointed at another code', (m) => { ((m.datasets['stock-lots']!.wide as { warehouses: Record<string, string> }).warehouses)['1 MIL1'] = 'RXT2' }],
    ['a mapped skip', (m) => { m.datasets['stock-lots']!.rowSelect = { column: 'Product Type', keep: ['simple'], skip: ['variable'] } }],
    ['a constant for the quantity', (m) => { (m.datasets['stock-lots']!.constants as Record<string, string>).unitCost = '1' }],
    ['another currency constant', (m) => { (m.datasets['stock-lots']!.constants as Record<string, string>).currency = 'EUR' }],
  ]
  for (const [label, edit] of edits) {
    const r = exportWith(edit)
    assert.equal(partReason(r, 'stock'), 'COLUMN_MAP_NOT_NATIVE', label)
    assert.equal(partReason(r, 'products'), 'COLUMN_MAP_NOT_NATIVE', label)
  }
  // a map declared with a wrong digest is refused earlier, as unreadable; no map at all means the canonical layout (no transform exists)
  assert.equal(partReason(read(writeExport(bases)), 'stock'), 'ok')
})

// [mutation: assertRawIdentities removed / its trim, NFC, forbidden-character or upper-case test removed]
test('a SKU or warehouse code the ingest would trim or normalise is IDENTITY_NOT_CANONICAL, never compared in its transformed form (canonical and native layouts)', () => {
  const stockOf = (sku: string, location = 'MIL1') => stockCsv([{ sku, location, qty: '1', unitCost: '1' }])
  const reasons = (stock: string, products: string) => { const r = read(writeExport(bases, { stock, products })); return [partReason(r, 'stock'), partReason(r, 'products')] }
  assert.deepEqual(reasons(stockOf('SKU-1'), productsCsv([{ sku: 'SKU-1' }])), ['ok', 'ok'])
  const nfd = 'CAFÉ-1'
  assert.notEqual(nfd, nfd.normalize('NFC'))
  for (const [label, sku] of [['leading space', ' SKU-1'], ['trailing space', 'SKU-1 '], ['trailing tab', 'SKU-1\t'], ['non-NFC', nfd], ['no-break space inside', 'SKU 1'], ['zero-width', 'SKU​1']] as const) {
    assert.deepEqual(reasons(stockOf(sku), productsCsv([{ sku }])).map((r, i) => (r === 'ok' ? r : `${i}:${r}`)), ['0:' + 'IDENTITY_NOT_CANONICAL', '1:IDENTITY_NOT_CANONICAL'].map((x) => x), label)
  }
  // a lower-case warehouse code would be upper-cased by the ingest and so match the manifest's code
  assert.equal(partReason(read(writeExport(bases, { stock: stockOf('SKU-1', 'mil1') })), 'stock'), 'IDENTITY_NOT_CANONICAL')
  assert.equal(partReason(read(writeExport(bases, { stock: stockOf('SKU-1', ' MIL1') })), 'stock'), 'IDENTITY_NOT_CANONICAL')
  // one bad row among good ones refuses the part
  assert.equal(partReason(read(writeExport(bases, { stock: stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: '1', unitCost: '1' }, { sku: ' SKU-2', location: 'MIL1', qty: '1', unitCost: '1' }]) })), 'stock'), 'IDENTITY_NOT_CANONICAL')
  // a padded number has one value: accepted, trimmed
  assert.equal(partReason(read(writeExport(bases, { stock: stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: ' 5 ', unitCost: '1' }]) })), 'stock'), 'ok')
  // the native layout: the Sku cell of the stock report
  const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')
  const nativeText = readFileSync(path.join(nativeDir, 'maps/qoblex-stock-on-hand.map.json'), 'utf8')
  const clean = readFileSync(path.join(nativeDir, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((line) => !/^"[^"]*","[^"]*","SYN-[0-9A-Z-]*","[^"]*","[Uu]nknown"/.test(line)).join('\r\n')
  const locations = ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: code === 'RXT2' }))
  const native = (csv: string) => read(writeExport(bases, { stock: csv, products: null, locations, extra: { 'map.json': nativeText, 'stock.csv': csv }, patch: (man) => {
    const ref = { file: 'stock.csv', sha256: sha256(csv), columnMap: { file: 'map.json', sha256: sha256(nativeText) } }
    man.stock = ref; man.products = ref
  } }))
  assert.deepEqual([partReason(native(clean), 'stock'), partReason(native(clean), 'products')], ['ok', 'ok'])
  assert.ok(clean.includes('"SYN-1001"'))
  for (const spelling of ['" SYN-1001"', '"SYN-1001 "', '"SYN-1001 "']) {
    const padded = native(clean.replace('"SYN-1001"', spelling))
    assert.deepEqual([partReason(padded, 'stock'), partReason(padded, 'products')], ['IDENTITY_NOT_CANONICAL', 'IDENTITY_NOT_CANONICAL'], spelling)
  }
})

// [mutation: the shared promise removed so each item reads the export again]
test('the source reads the export ONCE for the run and hands every item the same result', async () => {
  const dir = writeExport(bases)
  let clock = 0
  const source = createQoblexSource({ dir, asOf: ASOF, now: () => { clock += 1; return NOW } })
  const [a, b, c] = await Promise.all([source.read(), source.read(), source.read()])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(clock, 1)
  // a source over a missing directory is a closed reason, never a throw
  const missing = createQoblexSource({ dir: path.join(dir, 'gone'), asOf: ASOF, now: () => NOW })
  assert.deepEqual(await missing.read(), { ok: false, reason: 'SOURCE_UNREADABLE' })
})

test('the secrets scan: nothing a file says reaches a reason', () => {
  const secret = 'ck_live_SECRETVALUE123456789'
  const r = read(writeExport(bases, { stock: stockCsv([{ sku: secret, location: 'MIL1', qty: 'x', unitCost: '1' }]) }))
  assert.ok(!JSON.stringify(r).includes('SECRETVALUE'))
})
