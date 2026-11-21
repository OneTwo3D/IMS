import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { QOBLEX_NATIVE_COLUMN_MAP } from '../../lib/reconciliation-pack/qoblex-native-map.ts'
import { readQoblexExport } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { ASOF, productsCsv, sha256, stockCsv, writeExport } from './qoblex-fixtures.ts'
import { NOW, cleanup } from './helpers.ts'

/**
 * What the Qoblex read changes is REPORTED (ghost rows, rows read as zero, rows skipped), a ghost holding stock makes its part inconclusive, and the
 * first load's SKU renames are a pinned, digest-checked input applied by the first load's own rules. Synthetic data only.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))
const read = (dir: string) => readQoblexExport(dir, ASOF, NOW)

const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')
const nativeLines = readFileSync(path.join(nativeDir, 'stock-on-hand.csv'), 'utf8').split('\r\n')
const LABEL_AND_HEADER = nativeLines.slice(0, 2)
const NATIVE_MAP = QOBLEX_NATIVE_COLUMN_MAP
const NATIVE_LOCATIONS = ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: code === 'RXT2' }))

/** One row of the native stock-on-hand report: 56 cells, the total quantity at 15, the five warehouse quantities at 22, 29, 36, 43 and 50. */
function nativeRow(row: { sku: string; type?: string; state?: string; total: string; cells?: [string, string, string, string, string] }): string {
  const cells = Array.from({ length: 56 }, () => '')
  cells[0] = `Name ${row.sku}`; cells[1] = row.sku; cells[3] = row.state ?? 'Active'; cells[5] = row.type ?? 'simple'; cells[8] = '1.5'; cells[15] = row.total
  ;(row.cells ?? ['0', '0', '0', '0', '0']).forEach((value, index) => { cells[22 + 7 * index] = value })
  return cells.map((cell) => `"${cell}"`).join(',')
}
function nativeExport(rows: string[]): string {
  const csv = [...LABEL_AND_HEADER, ...rows, ''].join('\r\n')
  return writeExport(bases, {
    stock: csv, products: null, locations: NATIVE_LOCATIONS,
    extra: { 'map.json': NATIVE_MAP, 'stock.csv': csv },
    patch: (m) => {
      const columnMap = { file: 'map.json', sha256: sha256(NATIVE_MAP) }
      m.stock = { file: 'stock.csv', sha256: sha256(csv), columnMap }
      m.products = { file: 'stock.csv', sha256: sha256(csv), columnMap }
    },
  })
}
const reason = (part: { ok: boolean; reason?: string }) => (part.ok ? 'ok' : part.reason)

// [mutation: the pack ignores the ingest's notes and rowsSkipped, or does not refuse a ghost that holds stock]
test('a ghost row with a NON-ZERO quantity makes the stock AND the products part inconclusive; a zero ghost is dropped and listed', () => {
  const typed = nativeRow({ sku: 'SYN-A', total: '4', cells: ['4', '0', '0', '0', '0'] })
  const ghostStock = nativeRow({ sku: 'SYN-A', type: 'Unknown', total: '5', cells: ['5', '0', '0', '0', '0'] })
  const r = read(nativeExport([typed, ghostStock]))
  assert.ok(r.ok)
  assert.equal(reason(r.value.stock), 'QOBLEX_GHOST_STOCK')
  assert.equal(reason(r.value.products), 'QOBLEX_GHOST_STOCK')
  assert.deepEqual(r.value.evidence.stock.ghostRows, [{ sku: 'SYN-A', quantity: '5' }], 'the refused part is still explained')

  const zeroGhost = nativeRow({ sku: 'SYN-A', type: 'Unknown', total: '0', cells: ['0', '0', '0', '0', '0'] })
  const ok = read(nativeExport([typed, zeroGhost]))
  assert.ok(ok.ok)
  assert.equal(reason(ok.value.stock), 'ok', JSON.stringify(ok.value.stock))
  assert.equal(reason(ok.value.products), 'ok')
  assert.deepEqual(ok.value.evidence.stock.ghostRows, [{ sku: 'SYN-A', quantity: '0' }])
  assert.deepEqual(ok.value.evidence.products.ghostRows, [{ sku: 'SYN-A', quantity: '0' }])
  assert.equal(ok.value.evidence.stock.rowsSkipped['ghost row dropped'], 1)
})

// [mutation: blankStockIsZero rows not collected]
test('every SKU read as 0 on hand (blank total over blank-or-zero cells) and every skipped row is in the evidence, per run', () => {
  const r = read(nativeExport([
    nativeRow({ sku: 'SYN-B', total: '', cells: ['', '', '', '', ''] }),
    nativeRow({ sku: 'SYN-C', total: '', cells: ['0', '', '0.000000', '', ''] }),
    nativeRow({ sku: 'SYN-D', total: '3', cells: ['3', '0', '0', '0', '0'] }),
    nativeRow({ sku: 'SYN-E', total: '1', cells: ['1', '0', '0', '0', '0'], state: 'Deleted' }),
    nativeRow({ sku: 'SYN-K', total: '', type: 'kit' }),
  ]))
  assert.ok(r.ok)
  assert.equal(reason(r.value.stock), 'ok', JSON.stringify(r.value.stock))
  assert.deepEqual([...r.value.evidence.stock.blankAsZero].sort(), ['SYN-B', 'SYN-C'])
  assert.equal(r.value.evidence.stock.rowsSkipped.Deleted, 1)
  assert.equal(r.value.evidence.stock.rowsSkipped.kit, 1)
  assert.equal(r.value.evidence.products.rowsSkipped.Deleted, 1)
})

// ---- the first load's SKU renames ---------------------------------------------------------------

const renamesCsv = (rows: Array<[string, string, string]>) => ['fromSku,toSku,reason', ...rows.map(([a, b, c]) => `${a},${b},${c}`), ''].join('\r\n')
function renamedExport(rename: string, over: { stock?: string; products?: string; mutate?: (m: Record<string, unknown>) => void; declared?: string } = {}): string {
  return writeExport(bases, {
    stock: over.stock ?? stockCsv([{ sku: 'OLD-1', location: 'MIL1', qty: '5', unitCost: '2' }, { sku: 'SKU-2', location: 'MIL1', qty: '1', unitCost: '2' }]),
    products: over.products ?? productsCsv([{ sku: 'OLD-1' }, { sku: 'SKU-2' }]),
    extra: { 'renames.csv': rename },
    patch: (m) => { m.skuRenames = { file: 'renames.csv', sha256: over.declared ?? sha256(rename) }; over.mutate?.(m) },
  })
}

// [mutation: the renames not applied / applied to the stock only / not judged by the first load's rules]
test('the first load\'s sku-renames are applied to the stock and products parts, and every rename applied (or unused) is listed', () => {
  const r = read(renamedExport(renamesCsv([['OLD-1', 'NEW-1', 'source spelling differs'], ['GONE-1', 'NEW-2', 'not in this export']])))
  assert.ok(r.ok)
  assert.deepEqual(r.value.stock.ok && r.value.stock.value.map((l) => l.sku), ['NEW-1', 'SKU-2'])
  assert.deepEqual(r.value.products.ok && r.value.products.value.map((p) => p.sku), ['NEW-1', 'SKU-2'])
  assert.deepEqual(r.value.evidence.skuRenames, [{ from: 'OLD-1', to: 'NEW-1', cells: 2 }, { from: 'GONE-1', to: 'NEW-2', cells: 0 }])
  assert.ok(r.value.files.some((f) => f.name === 'renames.csv'), 'the list is a digest-checked file read once')
  // without the list the export reads under the source SKU
  const plain = read(writeExport(bases))
  assert.ok(plain.ok)
  assert.deepEqual(plain.value.evidence.skuRenames, [])
})

// [mutation: the digest of the rename list not checked]
test('a rename list whose bytes do not hash to the declared digest, or are unreadable, leaves every part unreadable', () => {
  const list = renamesCsv([['OLD-1', 'NEW-1', 'x']])
  const r = read(renamedExport(list, { declared: sha256('something else') }))
  assert.ok(r.ok)
  for (const part of [r.value.stock, r.value.products]) assert.equal(reason(part), 'SOURCE_UNREADABLE')
})

// [mutation: a refused rename ignored (the first load's rules not applied)]
test('a rename the first load refuses makes the stock, products and incoming parts unreadable (SKU_RENAMES_REFUSED)', () => {
  for (const [label, rows] of [
    ['target already in the export', [['OLD-1', 'SKU-2', 'x']]],
    ['chain', [['OLD-1', 'MID-1', 'x'], ['MID-1', 'END-1', 'x']]],
    ['listed twice', [['OLD-1', 'A-1', 'x'], ['OLD-1', 'B-1', 'x']]],
    ['to itself', [['OLD-1', 'OLD-1', 'x']]],
    ['no reason', [['OLD-1', 'NEW-1', '']]],
  ] as Array<[string, Array<[string, string, string]>]>) {
    const r = read(renamedExport(renamesCsv(rows)))
    assert.ok(r.ok, label)
    assert.equal(reason(r.value.stock), 'SKU_RENAMES_REFUSED', label)
    assert.equal(reason(r.value.products), 'SKU_RENAMES_REFUSED', label)
  }
})

test('the rename list is its own file: naming a part file or a repeated file for it is a manifest that contradicts itself', () => {
  const list = renamesCsv([['OLD-1', 'NEW-1', 'x']])
  const r = read(renamedExport(list, { mutate: (m) => { m.skuRenames = { file: 'stock.csv', sha256: (m.stock as { sha256: string }).sha256 } } }))
  assert.deepEqual(r.ok ? 'ok' : r.reason, 'MANIFEST_INCONSISTENT')
})
