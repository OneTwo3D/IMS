/**
 * Natural keys, fingerprints and the residual: pure functions, tested over the real tool output and over hand-built multi-chunk inputs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsvStrict, serializeCsv } from '../../lib/first-load/csv.ts'
import { keyStep, parseComponentsCell, type StepRows } from '../../lib/first-load/apply/keys.ts'
import { buildResidual, classifyStep, hasConflict, listConflicts, type ObservedEntry } from '../../lib/first-load/apply/residual.ts'
import { loadOk, prepareSynthetic, preparedFiles } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

const prepared = loadOk(preparedFiles(prepareSynthetic()))
const step = (id: string) => prepared.steps.find((s) => s.step === id)!
const asEntry = (u: { key: string; collisionKey: string; fingerprint: string; recipe: string | null }): ObservedEntry => ({ key: u.key, collisionKey: u.collisionKey, fingerprint: u.fingerprint, recipe: u.recipe })

test('keys: each step keys the way its importer matches (products by exact SKU, stock by upper SKU and warehouse, orders by reference, suppliers by lower-cased name)', (t) => {
  assert.deepEqual(step('suppliers').units.map((u) => u.key), ['cotton ltd', 'timber co'])
  assert.deepEqual(step('products').units.map((u) => u.key).slice(0, 3), ['LICENCE-FEE', 'OAK-BOARD', 'TSHIRT'])
  assert.deepEqual(step('opening-stock').units.map((u) => u.key), ['LEG-01|MAIN', 'OAK-BOARD|MAIN', 'OAK-BOARD|OVER', 'TSHIRT-M|MAIN'])
  assert.deepEqual(step('purchase-orders').units.map((u) => [u.key, u.rowIndexes.length]), [['QBX-PO-5001', 1], ['QBX-PO-5002', 2]])
  precondition(t, 'units keyed', prepared.steps.reduce((n, s) => n + s.units.length, 0))
})

test('fingerprints: a change to ANY written column of a product, supplier or stock row changes the fingerprint (universal over columns)', (t) => {
  let examined = 0
  for (const id of ['suppliers', 'products', 'opening-stock'] as const) {
    const s = step(id)
    const baseRow = s.data.rows[0]
    const base = keyStep(id, { header: s.data.header, rows: [baseRow] }).units[0].fingerprint
    for (let c = 0; c < s.data.header.length; c++) {
      const name = s.data.header[c]
      if (['productId', 'parentProductId', 'supplierId', 'components', 'productName', 'type', 'stockUnit', 'warehouseName', 'reserved', 'available', 'inventoryValueBase'].includes(name) && id !== 'products') continue
      if (name === 'components' || name === 'productId' || name === 'parentProductId' || name === 'supplierId') continue
      const cells = [...baseRow.cells]
      cells[c] = name === 'qty' || name === 'unitCostBase' || name === 'paymentTermsDays' || name === 'weight' ? '7' : `${cells[c]}X`
      const changed = keyStep(id, { header: s.data.header, rows: [{ ...baseRow, cells }] })
      assert.notEqual(changed.units[0]?.fingerprint, base, `${id}.${name} is part of the fingerprint`)
      examined++
    }
  }
  precondition(t, 'columns examined', examined)
})

test('fingerprints ignore spelling that the importer would normalise (number format, boolean case, currency case) and nothing else', () => {
  const s = step('products')
  const oak = s.data.rows.find((r) => r.cells[2] === 'OAK-BOARD')!
  const col = (n: string) => s.data.header.indexOf(n)
  const variant = [...oak.cells]
  variant[col('weight')] = '2.50'
  variant[col('active')] = 'TRUE'
  const a = keyStep('products', { header: s.data.header, rows: [{ ...oak, cells: oak.cells.map((c, i) => (i === col('weight') ? '2.5' : i === col('active') ? 'true' : c)) }] }).units[0].fingerprint
  const b = keyStep('products', { header: s.data.header, rows: [{ ...oak, cells: variant }] }).units[0].fingerprint
  assert.equal(a, b)
})

test('recipe: a multiset, order and number format independent; a repeated, zero or malformed component is a problem', () => {
  assert.equal(parseComponentsCell('A:1;B:2', 'x').recipe, parseComponentsCell('b:2.0000;a:1', 'x').recipe)
  assert.notEqual(parseComponentsCell('A:1;B:2', 'x').recipe, parseComponentsCell('A:1;B:3', 'x').recipe)
  for (const bad of ['A:1;a:2', 'A:0', 'A', 'A:abc', ':1', 'A:1;;B:2']) {
    const r = parseComponentsCell(bad, 'x')
    assert.ok(r.problems.length > 0 && r.recipe === null, bad)
  }
  assert.deepEqual(parseComponentsCell('', 'x'), { recipe: null, problems: [] })
})

test('classification: absent, present-matching, and every kind of conflict; a foreign row is counted and listed', (t) => {
  const s = step('products')
  const all = s.units.map(asEntry)
  const clean = classifyStep('products', s.units, { entries: all })
  assert.deepEqual(clean.counts, { emitted: 8, absent: 0, presentMatching: 8, presentConflicting: 0, foreign: 0 })
  assert.equal(hasConflict(clean), false)
  const empty = classifyStep('products', s.units, { entries: [] })
  assert.deepEqual(empty.counts, { emitted: 8, absent: 8, presentMatching: 0, presentConflicting: 0, foreign: 0 })
  const mixed = classifyStep('products', s.units, { entries: [...all.slice(0, 3), { ...all[3], fingerprint: 'other' }, { ...all[4], recipe: 'A:1.0000' }, { key: 'zzz', collisionKey: 'ZZZ', fingerprint: 'x', recipe: null }] })
  assert.deepEqual(mixed.counts, { emitted: 8, absent: 3, presentMatching: 3, presentConflicting: 2, foreign: 1 })
  assert.deepEqual(listConflicts(mixed).map((c) => c.code).sort(), ['FIELDS_DIFFER', 'FOREIGN_ROW', 'RECIPE_DIFFERS'])
  precondition(t, 'classified units', 8 * 3)
  // Deterministic order of the conflict list.
  assert.deepEqual(listConflicts(mixed), listConflicts(classifyStep('products', s.units, { entries: [...all.slice(0, 3), { ...all[3], fingerprint: 'other' }, { ...all[4], recipe: 'A:1.0000' }, { key: 'zzz', collisionKey: 'ZZZ', fingerprint: 'x', recipe: null }] })))
})

test('residual: only the absent units, header first, original order, one file per chunk; a purchase order is sent whole; nothing left is an empty list', () => {
  const header = ['sku', 'warehouseCode', 'qty', 'unitCostBase']
  const rows = (chunk: number, items: string[][]) => items.map((cells, i) => ({ chunk, line: i + 2, cells }))
  const data: StepRows = {
    header,
    rows: [...rows(1, [['A', 'MAIN', '1', '1.000000'], ['B', 'MAIN', '2', '1.000000'], ['C', 'MAIN', '3', '1.000000']]), ...rows(2, [['D', 'MAIN', '4', '1.000000'], ['E', 'MAIN', '5', '1.000000']])],
  }
  const keyed = keyStep('opening-stock', data)
  assert.deepEqual(keyed.problems, [])
  const have = keyed.units.filter((u) => ['A|MAIN', 'D|MAIN'].includes(u.key)).map(asEntry)
  const classified = classifyStep('opening-stock', keyed.units, { entries: have })
  const residual = buildResidual('opening-stock', data, classified)
  assert.deepEqual(residual.map((r) => [r.name, r.rows]), [['residual-opening-stock-001.csv', 2], ['residual-opening-stock-002.csv', 1]])
  assert.equal(new TextDecoder().decode(residual[0].bytes), serializeCsv(header, [['B', 'MAIN', '2', '1.000000'], ['C', 'MAIN', '3', '1.000000']]))
  assert.equal(new TextDecoder().decode(residual[1].bytes), serializeCsv(header, [['E', 'MAIN', '5', '1.000000']]))
  assert.equal(parseCsvStrict(new TextDecoder().decode(residual[0].bytes)).rows.length, 2, 'the residual parses back with the strict reader')
  assert.deepEqual(buildResidual('opening-stock', data, classifyStep('opening-stock', keyed.units, { entries: keyed.units.map(asEntry) })), [])

  const orders = step('purchase-orders')
  const second = classifyStep('purchase-orders', orders.units, { entries: [asEntry(orders.units[0])] })
  const sent = buildResidual('purchase-orders', orders.data, second)
  assert.deepEqual(sent.map((r) => r.rows), [2], 'order QBX-PO-5002 goes with both of its lines')
  assert.ok(new TextDecoder().decode(sent[0].bytes).includes('TSHIRT-M') && new TextDecoder().decode(sent[0].bytes).includes('TSHIRT-S'))
})

test('residual bytes are deterministic (same input, same SHA-256)', () => {
  const s = step('suppliers')
  const c = classifyStep('suppliers', s.units, { entries: [] })
  assert.equal(buildResidual('suppliers', s.data, c)[0].sha256, buildResidual('suppliers', s.data, c)[0].sha256)
})
