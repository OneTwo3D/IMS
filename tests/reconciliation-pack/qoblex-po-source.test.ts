import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { QOBLEX_NATIVE_PO_COLUMN_MAP } from '../../lib/reconciliation-pack/qoblex-native-map.ts'
import { parseQoblexManifest, readQoblexExport } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { ASOF, DEFAULT_INCOMING, DEFAULT_PRODUCTS, DEFAULT_STOCK, INCOMING_HEADERS, incomingCsv, sha256, writeExport } from './qoblex-fixtures.ts'
import { NOW, cleanup } from './helpers.ts'

/**
 * THE INCOMING REPORT PART OF THE QOBLEX SOURCE (R7, R8): the pinned native map, the manifest's purchaseOrders part, and every refusal as a
 * closed reason with NO lines. Mutations are listed above each test.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))
const read = (dir: string) => readQoblexExport(dir, ASOF, NOW)
const poReason = (dir: string) => {
  const r = read(dir)
  assert.ok(r.ok, JSON.stringify(r))
  return r.value.purchaseOrders.ok ? 'ok' : r.value.purchaseOrders.reason
}
const withPo = (csv: string, extra: Parameters<typeof writeExport>[1] = {}) => writeExport(bases, { purchaseOrders: { csv }, ...extra })
const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')

// [mutation: the repository's copy edited, or the pin test removed]
test('the pack\'s native incoming-stock map is the first-load tool\'s tested map, byte for byte', () => {
  assert.equal(QOBLEX_NATIVE_PO_COLUMN_MAP, readFileSync(path.join(nativeDir, 'maps/qoblex-incoming-stock.map.json'), 'utf8'))
})

test('a well-formed incoming report reads: each line as written, the supplier\'s currency and rate from the pinned map, the declared prefix, and the digest of every file', () => {
  const r = read(writeExport(bases, { purchaseOrders: {} }))
  assert.ok(r.ok)
  assert.ok(r.value.purchaseOrders.ok)
  const { keyPrefix, lines } = r.value.purchaseOrders.value
  assert.equal(keyPrefix, 'QBX-')
  assert.deepEqual(lines.map((l) => [l.orderKey, l.sku, l.qtyOrdered, l.qtyReceived, l.unitCostForeign, l.currency, l.fxRateToBase]), [
    ['PO1', 'SKU-1', '10', '4', '2.5', 'GBP', ''], ['PO1', 'SKU-2', '3', '0', '10', 'GBP', ''], ['PO2', 'SKU-3', '8', '0', '12.5', 'USD', '1.25'],
  ])
  assert.deepEqual(r.value.files.map((f) => f.name).sort(), ['incoming-map.json', 'incoming.csv', 'products.csv', 'stock.csv'])
  assert.equal(r.value.files.find((f) => f.name === 'incoming.csv')!.sha256, sha256(DEFAULT_INCOMING))
  // the first-load tool's own fixture reads too (its three suppliers, EUR at 1.15)
  const fixture = readFileSync(path.join(nativeDir, 'incoming-stock.csv'), 'utf8')
  const real = read(writeExport(bases, { purchaseOrders: { csv: fixture } }))
  assert.ok(real.ok && real.value.purchaseOrders.ok)
  assert.equal(real.value.purchaseOrders.ok && real.value.purchaseOrders.value.lines.length, 4)
})

test('a manifest with no purchaseOrders part leaves that part SOURCE_UNREADABLE and the stock and products parts untouched', () => {
  const r = read(writeExport(bases))
  assert.ok(r.ok)
  assert.deepEqual(r.value.purchaseOrders, { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.ok(r.value.stock.ok && r.value.products.ok)
})

// [mutation: the PO map accepted by anything but its digest / a missing map allowed / the stock map accepted for the incoming report]
test('the incoming report accepts ONLY the native incoming-stock map: any other bytes, no map, or the stock map is COLUMN_MAP_NOT_NATIVE', () => {
  for (const map of [`${QOBLEX_NATIVE_PO_COLUMN_MAP} `, QOBLEX_NATIVE_PO_COLUMN_MAP.replace('"Supplier Beta": "GBP"', '"Supplier Beta": "USD"'), QOBLEX_NATIVE_PO_COLUMN_MAP.replace('"1.25"', '"1.50"'), readFileSync(path.join(nativeDir, 'maps/qoblex-stock-on-hand.map.json'), 'utf8')]) {
    assert.notEqual(map, QOBLEX_NATIVE_PO_COLUMN_MAP)
    assert.equal(poReason(writeExport(bases, { purchaseOrders: { map } })), 'COLUMN_MAP_NOT_NATIVE')
  }
  // no map at all: the manifest's closed shape refuses the part before any file is read
  const bare = read(writeExport(bases, { purchaseOrders: { noMap: true } }))
  assert.deepEqual(bare.ok ? 'ok' : bare.reason, 'SOURCE_UNREADABLE')
})

// [mutation: the prefix pattern loosened, or the declaration made optional]
test('the manifest\'s declared prefix is an upper-case token; a missing, empty, lower-case, padded or over-long one rejects the manifest', () => {
  for (const prefix of ['', 'qbx-', 'QBX- ', ' QBX-', 'QBX/', 'A'.repeat(17), 'QBX:']) {
    const dir = writeExport(bases, { purchaseOrders: { prefix } })
    const r = read(dir)
    assert.deepEqual(r.ok ? 'ok' : r.reason, 'NO_POPULATION_RECORD', JSON.stringify(prefix))
  }
  const dir = writeExport(bases, { purchaseOrders: {}, patch: (m) => { delete (m.purchaseOrders as Record<string, unknown>).keyPrefix } })
  const r = read(dir)
  assert.deepEqual(r.ok ? 'ok' : r.reason, 'SOURCE_UNREADABLE')
})

// [mutation: the part shares a file with another part without the manifest check]
test('the incoming report is its own file: naming the stock or products file again, in any case, is MANIFEST_INCONSISTENT for the whole manifest', () => {
  // the same bytes under the same name and digest are consistent for the file reader, so only the part rule can refuse them
  for (const [name, digest] of [['stock.csv', sha256(DEFAULT_STOCK)], ['products.csv', sha256(DEFAULT_PRODUCTS)], ['STOCK.csv', sha256(DEFAULT_STOCK)], ['stock.csv', '0'.repeat(64)]] as const) {
    const dir = writeExport(bases, { purchaseOrders: {}, patch: (m) => { Object.assign(m.purchaseOrders as Record<string, unknown>, { file: name, sha256: digest }) } })
    const r = read(dir)
    assert.deepEqual(r.ok ? 'ok' : r.reason, 'MANIFEST_INCONSISTENT', `${name} ${digest.slice(0, 4)}`)
  }
  const strict = () => parseQoblexManifest(JSON.stringify({ formatVersion: 1, exportedAt: '2026-10-20T08:00:00Z', asOf: ASOF, baseCurrency: 'GBP', locations: [{ code: 'MIL1', company: 'ACME', threePl: false }], purchaseOrders: { file: 'a.csv', sha256: 'f'.repeat(64), keyPrefix: 'QBX-', columnMap: { file: 'a.csv', sha256: 'f'.repeat(64) } } }))
  assert.throws(strict)
})

test('an EMPTY incoming report (header only) is legal and reads as no lines; a different header, or no header at all, is unreadable', () => {
  assert.equal(poReason(withPo(incomingCsv([]))), 'ok')
  const r = read(withPo(incomingCsv([])))
  assert.ok(r.ok && r.value.purchaseOrders.ok && r.value.purchaseOrders.value.lines.length === 0)
  assert.equal(poReason(withPo(incomingCsv([{ po: 'PO1', sku: 'A', ordered: '1', received: '0', price: '1' }], [...INCOMING_HEADERS.slice(0, 5), 'Order', ...INCOMING_HEADERS.slice(6)]))), 'SOURCE_UNREADABLE')
  assert.equal(poReason(withPo('')), 'SOURCE_UNREADABLE')
})

// [mutation: a row dropped, defaulted or summed instead of refused]
test('every malformed line makes the whole part unreadable with a closed reason, and no line is returned', () => {
  const row = (over: Partial<Parameters<typeof incomingCsv>[0][number]> = {}) => incomingCsv([{ po: 'PO1', sku: 'SKU-1', ordered: '10', received: '4', price: '2.5', ...over }])
  const cases: Array<[string, string, string]> = [
    ['a status that is not open', row({ status: 'Received' }), 'SOURCE_UNREADABLE'],
    ['received above ordered', row({ received: '11' }), 'BAD_VALUE'],
    ['a negative ordered quantity', row({ ordered: '-1', received: '0' }), 'BAD_VALUE'],
    ['an exponent quantity', row({ ordered: '1e3' }), 'BAD_VALUE'],
    ['a negative price', row({ price: '-2.5' }), 'BAD_VALUE'],
    ['a supplier the pinned map does not know', row({ supplier: 'Supplier Delta' }), 'SOURCE_UNREADABLE'],
    ['an order number with a colon', row({ po: 'PO:1' }), 'BAD_KEY'],
    ['an order number with a slash', row({ po: 'PO/1' }), 'BAD_KEY'],
    ['a padded order number', row({ po: ' PO1' }), 'IDENTITY_NOT_CANONICAL'],
    ['a padded SKU', row({ sku: 'SKU-1 ' }), 'IDENTITY_NOT_CANONICAL'],
    ['an empty order number', row({ po: '' }), 'IDENTITY_NOT_CANONICAL'],
  ]
  for (const [label, csv, reason] of cases) {
    const dir = withPo(csv)
    const r = read(dir)
    assert.ok(r.ok, label)
    assert.deepEqual(r.value.purchaseOrders.ok ? 'ok' : r.value.purchaseOrders.reason, reason, label)
  }
})

// [mutation: duplicates summed or picked between]
test('a repeated (order, SKU) or two order numbers that differ only in case is DUPLICATE_KEY, and the lines of one order must share supplier, currency and rate', () => {
  const dup = incomingCsv([{ po: 'PO1', sku: 'A', ordered: '1', received: '0', price: '1' }, { po: 'PO1', sku: 'A', ordered: '2', received: '0', price: '1' }])
  assert.equal(poReason(withPo(dup)), 'DUPLICATE_KEY')
  const cased = incomingCsv([{ po: 'PO1', sku: 'A', ordered: '1', received: '0', price: '1' }, { po: 'po1', sku: 'B', ordered: '2', received: '0', price: '1' }])
  assert.equal(poReason(withPo(cased)), 'DUPLICATE_KEY')
  const mixed = incomingCsv([{ po: 'PO1', sku: 'A', ordered: '1', received: '0', price: '1' }, { po: 'PO1', sku: 'B', ordered: '2', received: '0', price: '1', supplier: 'Supplier Alpha' }])
  assert.equal(poReason(withPo(mixed)), 'EXPORT_INCONSISTENT')
  // the same SKU under two different orders is two lines
  const fine = incomingCsv([{ po: 'PO1', sku: 'A', ordered: '1', received: '0', price: '1' }, { po: 'PO2', sku: 'A', ordered: '2', received: '0', price: '1' }])
  assert.equal(poReason(withPo(fine)), 'ok')
})

test('a file that hashes to something else than the manifest declares is unreadable; the other parts are judged on their own', () => {
  const dir = writeExport(bases, { purchaseOrders: {}, patch: (m) => { (m.purchaseOrders as Record<string, unknown>).sha256 = '0'.repeat(64) } })
  assert.equal(poReason(dir), 'SOURCE_UNREADABLE')
  const r = read(dir)
  assert.ok(r.ok && r.value.stock.ok)
})
