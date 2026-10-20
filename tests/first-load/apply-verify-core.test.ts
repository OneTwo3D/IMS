import assert from 'node:assert/strict'
import { test } from 'node:test'

import { D } from '../../lib/first-load/money.ts'
import { tablesOfKind } from '../../lib/first-load/apply/table-classes.ts'
import type { StepResult } from '../../lib/first-load/apply/orchestrate.ts'
import {
  HELD_IDS_CAP, QUEUE_TABLES, VERIFICATION_IDS, VERIFICATION_MEANING, accountingItem, censusItems, chainItem, changedContent, changedTables, compareMigrations, expectedWrittenTables, fileStockPairs, migrationsHash,
  openingMovementsItem, parseBaseline, purchaseOrdersItem, stockTotalsItem, type Baseline, type MigrationRow, type StoredLayer, type StoredMovement,
} from '../../lib/first-load/apply/verify-core.ts'
import { loadOk, prepareSynthetic, preparedFiles, SENTINEL } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

/**
 * THE VERIFICATION RULES, without a database: every decision about "does this pass" is a pure function of a reading, so each rule is driven here with a fabricated reading and a
 * mutation of the rule is red. (The readings themselves are taken in apply-verify.test.ts against a real database.)
 *
 * THE RULE THESE TESTS PIN: a count, a sum or an aggregate never stands in for the identity of a record. Every arm below keeps the counts and the totals equal and changes WHICH records
 * are there; each names, in a comment, the change to the subject that makes it green again.
 */

const D32 = (c: string) => c.repeat(32)
const tables = (extra: Record<string, number> = {}): Record<string, number> => ({ products: 0, suppliers: 0, settings: 4, integration_outbox: 0, accounting_sync_logs: 0, wms_sync_jobs: 0, email_outbox: 0, activity_logs: 0, ...extra })
const digests = (extra: Record<string, string> = {}): Record<string, string> => ({ settings: D32('a'), integration_outbox: D32('b'), accounting_sync_logs: D32('c'), wms_sync_jobs: D32('d'), email_outbox: D32('e'), ...extra })
const baseline = (): Baseline => ({ tables: tables(), digests: digests(), heldIds: [] })
const byId = (items: ReturnType<typeof censusItems>) => Object.fromEntries(items.map((i) => [i.id, i]))

const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })

function results(over: (r: StepResult, i: number) => Partial<StepResult> = () => ({})): StepResult[] {
  return prepared.steps.map((s, i) => {
    const base: StepResult = {
      step: s.step, status: 'DONE', emitted: s.units.length, created: s.units.length, updated: 0, skippedExisting: 0, failed: 0, toLoad: s.units.length, residual: [], conflicts: [],
      rows: s.units.map((u) => ({ key: u.key, outcome: 'created' as const, reason: null })), importer: [], counterFindings: [], error: null,
    }
    return { ...base, ...over(base, i) }
  })
}

test('the expected-write list is exactly the registry class the runner writes, and a table outside it is red in the census', (t) => {
  const expected = expectedWrittenTables()
  assert.deepEqual([...expected].sort(), tablesOfKind('RUNNER_WRITES'))
  precondition(t, 'expected tables', expected.size)
  // Mutation: expectedWrittenTables() returns tablesOfKind('CONFIG_ALLOWED') too, or every table, and the arms below go red.
  const ok = byId(censusItems(baseline(), { tables: tables({ products: 5, suppliers: 2, activity_logs: 9 }), digests: digests(), heldIds: [] }))
  assert.equal(ok['write-census'].result, 'pass')
  const stray = byId(censusItems(baseline(), { tables: tables({ products: 5, settings: 5 }), digests: digests({ settings: D32('f') }), heldIds: [] }))
  assert.equal(stray['write-census'].result, 'fail')
  assert.match(stray['write-census'].actual, /1 unexpected: settings/)
})

test('write-census: a row REPLACED or CHANGED IN PLACE (the count unchanged) is a change; the count alone does not stand in for the content', () => {
  // Mutation: compare only the counts (drop changedContent from the census) and this is green.
  const sameCountOtherContent = byId(censusItems(baseline(), { tables: tables(), digests: digests({ settings: D32('f') }), heldIds: [] }))
  assert.equal(sameCountOtherContent['write-census'].result, 'fail')
  assert.match(sameCountOtherContent['write-census'].actual, /settings/)
  assert.deepEqual(changedTables(baseline(), { tables: tables(), digests: digests({ settings: D32('f') }), heldIds: [] }), [])
  assert.deepEqual(changedContent(baseline(), { tables: tables(), digests: digests({ settings: D32('f') }), heldIds: [] }), ['settings'])
  // A table that gained or lost its digest is a change too.
  const lost = digests(); delete (lost as Record<string, string>).settings
  assert.deepEqual(changedContent(baseline(), { tables: tables(), digests: lost, heldIds: [] }), ['settings'])
})

test('the census sees a table that appeared or vanished, not only the ones it was told to look at', () => {
  // Mutation: count only the tables of the baseline (or a fixed list) and both arms go green.
  const appeared = byId(censusItems(baseline(), { tables: tables({ zz_stray: 1 }), digests: digests(), heldIds: [] }))
  assert.equal(appeared['write-census'].result, 'fail')
  assert.match(appeared['write-census'].actual, /zz_stray/)
  const gone = { ...tables() } as Record<string, number>
  delete gone.settings
  const vanished = byId(censusItems(baseline(), { tables: gone, digests: digests(), heldIds: [] }))
  assert.equal(vanished['write-census'].result, 'fail')
})

test('queues: each table is named on its own, and a row swapped for another (same count) is growth in identity', (t) => {
  let arms = 0
  // The four tables are written out here, not imported: a list that shrank in the subject would otherwise shrink in the test with it.
  const queues = ['integration_outbox', 'accounting_sync_logs', 'wms_sync_jobs', 'email_outbox']
  assert.deepEqual([...QUEUE_TABLES].sort(), [...queues].sort())
  for (const name of queues) {
    const grew = byId(censusItems(baseline(), { tables: tables({ [name]: 1 }), digests: digests({ [name]: D32('9') }), heldIds: [] }))
    assert.equal(grew['no-queue-growth'].result, 'fail', name)
    assert.match(grew['no-queue-growth'].actual, new RegExp(name))
    // Mutation: compare the queue counts only and the swap arm is green.
    const swapped = byId(censusItems({ ...baseline(), tables: tables({ [name]: 1 }) }, { tables: tables({ [name]: 1 }), digests: digests({ [name]: D32('9') }), heldIds: [] }))
    assert.equal(swapped['no-queue-growth'].result, 'fail', `${name}: same count, another row`)
    arms++
  }
  assert.equal(arms, 4)
  precondition(t, 'queue arms', arms)
})

test('refused outbound writes are compared by ID: the same count with another row, and a row gone, are both a difference', (t) => {
  // Mutation: compare the lengths of the id lists (the old count) and the swapped arm is green.
  const base = { ...baseline(), heldIds: ['h1', 'h2'] }
  const held = (heldIds: string[] | null) => byId(censusItems(base, { tables: tables(), digests: digests(), heldIds }))['no-held-writes']
  assert.equal(held(['h2', 'h1']).result, 'pass')
  const arms: Array<[string, string[] | null]> = [['one swapped for another', ['h1', 'h3']], ['one gone', ['h1']], ['one more', ['h1', 'h2', 'h3']], ['too many to list now', null]]
  for (const [label, ids] of arms) assert.equal(held(ids).result, 'fail', label)
  assert.equal(byId(censusItems({ ...baseline(), heldIds: null }, { tables: tables(), digests: digests(), heldIds: [] }))['no-held-writes'].result, 'fail', 'too many to list at the start: nothing can be proved')
  assert.ok(HELD_IDS_CAP > 0)
  precondition(t, 'held arms', arms.length + 1)
})

test('no baseline fails closed: every census item fails, none is skipped', () => {
  // Mutation: return [] (or pass) when the baseline is null.
  const items = censusItems(null, { tables: tables(), digests: digests(), heldIds: [] })
  assert.deepEqual(items.map((i) => i.id).sort(), ['census-baseline', 'no-held-writes', 'no-queue-growth', 'write-census'])
  assert.ok(items.every((i) => i.result === 'fail'))
})

test('a baseline is parsed strictly: anything unusable is no baseline', (t) => {
  const good = { tables: { a: 1 }, digests: { a: D32('a') }, heldIds: ['x'] }
  assert.deepEqual(parseBaseline(good), good)
  assert.deepEqual(parseBaseline({ ...good, heldIds: null }), { ...good, heldIds: null })
  const bad: unknown[] = [null, 'x', [], {}, { ...good, tables: {} }, { ...good, tables: { a: -1 } }, { ...good, tables: { a: 1.5 } }, { ...good, tables: { a: '1' } }, { tables: good.tables, digests: good.digests },
    { ...good, digests: { a: 'short' } }, { ...good, digests: [] }, { ...good, heldIds: [1] }, { ...good, heldIds: 'x' }, { ...good, heldIds: Array.from({ length: HELD_IDS_CAP + 1 }, (_, i) => String(i)) }, { ...good, tables: [1] }]
  for (const raw of bad) assert.equal(parseBaseline(raw), null, JSON.stringify(raw).slice(0, 80))
  precondition(t, 'unusable baselines', bad.length)
})

test('accounting-identity: equal counts over DIFFERENT units fail; a missing, extra, duplicated or failed row each fail', (t) => {
  assert.equal(accountingItem(prepared, results()).result, 'pass')
  const withRows = (edit: (rows: StepResult['rows']) => StepResult['rows']) => results((r, i) => (i === 0 ? { rows: edit(r.rows) } : {}))
  const arms: Array<[string, StepResult[]]> = [
    ['identity broken', results((r, i) => (i === 0 ? { created: r.created - 1 } : {}))],
    ['an update', results((r, i) => (i === 0 ? { created: r.created - 1, updated: 1 } : {}))],
    ['a failure', results((r, i) => (i === 0 ? { created: r.created - 1, failed: 1 } : {}))],
    ['a conflict', results((r, i) => (i === 0 ? { conflicts: [{ key: 'k', code: 'FIELDS_DIFFER', detail: 'd' }] } : {}))],
    // Mutation: drop the key-set comparison (count the rows only) and these three are green.
    ['one row renamed (same counts, another unit)', withRows((rows) => rows.map((row, k) => (k === 0 ? { ...row, key: 'SOMEONE-ELSE' } : row)))],
    ['one row duplicated for another', withRows((rows) => rows.map((row, k) => (k === 0 ? { ...rows[1]! } : row)))],
    ['a row whose outcome is failed', withRows((rows) => rows.map((row, k) => (k === 0 ? { ...row, outcome: 'failed' as const } : row)))],
    ['a step missing', results().slice(1)],
    ['no steps', []],
  ]
  for (const [label, steps] of arms) assert.equal(accountingItem(prepared, steps).result, 'fail', label)
  precondition(t, 'accounting arms', arms.length)
})

test('the chain: unit rows that are NOT a permutation of the file rows fail even when their number is right', (t) => {
  const r = results()
  assert.equal(chainItem(prepared, r).result, 'pass')
  assert.equal(chainItem(prepared, r.map((x, i) => (i === 0 ? { ...x, emitted: x.emitted + 1 } : x))).result, 'fail', 'emitted differs from the units')
  assert.equal(chainItem(prepared, r.slice(1)).result, 'fail', 'a selected step has no result')
  assert.equal(chainItem({ ...prepared, steps: [] }, []).result, 'fail', 'nothing selected is not a chain')
  const planned = structuredClone(prepared.report) as unknown as { plannedOutputRows: Record<string, number> }
  planned.plannedOutputRows.products = (planned.plannedOutputRows.products ?? 0) + 1
  assert.equal(chainItem({ ...prepared, report: planned as unknown as typeof prepared.report }, r).result, 'fail', 'the prepared report plans another row count')
  // Same number of rows, but one row index claimed twice and another claimed by nobody. Mutation: compare the sum/length only and this is green.
  const products = prepared.steps.find((s) => s.step === 'products')!
  assert.ok(products.units.length >= 2 && products.units.every((u) => u.rowIndexes.length === 1))
  const shifted = prepared.steps.map((s) => (s.step === 'products' ? { ...s, units: s.units.map((u, k) => (k === 0 ? { ...u, rowIndexes: [products.units[1]!.rowIndexes[0]!] } : u)) } : s))
  assert.equal(chainItem({ ...prepared, steps: shifted }, r).result, 'fail')
  precondition(t, 'chain arms', 6)
})

// ---- stock ------------------------------------------------------------------------------------------------------------------------------------

const file = fileStockPairs(prepared)
const layersOf = (): StoredLayer[] => [...file].map(([key, p]) => ({ key, received: new D(p.qty), remaining: new D(p.qty), cost: new D(p.cost) }))
const total = (layers: StoredLayer[]) => ({ qty: layers.reduce((t, l) => t.add(l.received), new D(0)).toString(), value: layers.reduce((t, l) => t.add(l.received.mul(l.cost)), new D(0)).toString() })

test('stock-totals: per RECORD. Two quantities swapped between pairs (every sum equal) fail; so do a changed cost with the same value, a consumed layer, a renamed key, a duplicate and a foreign layer', (t) => {
  assert.ok(file.size >= 3, 'the fixture has several pairs')
  const base = layersOf()
  const report = total(base)
  const run = (layers: StoredLayer[], over: { report?: { qty: string; value: string } | null; nonOpeningLayers?: number } = {}) => stockTotalsItem({ file, layers, report: over.report === undefined ? total(layers) : over.report, nonOpeningLayers: over.nonOpeningLayers ?? 0 })
  assert.equal(run(base).result, 'pass')
  assert.equal(stockTotalsItem({ file, layers: base, report, nonOpeningLayers: 0 }).result, 'pass')
  const arms: Array<[string, StoredLayer[]]> = []
  // Mutation: compare per warehouse sums, or the grand total, instead of per record, and the swap arms are green.
  const swapQty = base.map((l) => ({ ...l })); const [a, b] = [swapQty[0]!, swapQty[1]!]; [a.received, b.received] = [b.received, a.received]; [a.remaining, b.remaining] = [b.remaining, a.remaining]
  arms.push(['quantities swapped between two pairs (totals equal)', swapQty])
  const swapCost = base.map((l) => ({ ...l })); [swapCost[0]!.cost, swapCost[1]!.cost] = [swapCost[1]!.cost, swapCost[0]!.cost]
  arms.push(['unit costs swapped between two pairs', swapCost])
  arms.push(['quantity +0.000001 on one and -0.000001 on another', base.map((l, i) => (i === 0 ? { ...l, received: l.received.add('0.000001'), remaining: l.remaining.add('0.000001') } : i === 1 ? { ...l, received: l.received.sub('0.000001'), remaining: l.remaining.sub('0.000001') } : l))])
  arms.push(['a layer partly consumed', base.map((l, i) => (i === 0 ? { ...l, remaining: l.remaining.sub('0.000001') } : l))])
  arms.push(['a key renamed (same count)', base.map((l, i) => (i === 0 ? { ...l, key: 'OTHER|PAIR' } : l))])
  arms.push(['a pair duplicated in place of another', base.map((l, i) => (i === 0 ? { ...base[1]! } : l))])
  arms.push(['a layer missing', base.slice(1)])
  arms.push(['an extra layer', [...base, { key: 'EXTRA|PAIR', received: new D(1), remaining: new D(1), cost: new D(1) }]])
  for (const [label, layers] of arms) assert.equal(run(layers).result, 'fail', label)
  assert.equal(run(base, { nonOpeningLayers: 1 }).result, 'fail', 'a foreign layer')
  assert.equal(run(base, { report: { ...report, value: new D(report.value).add('0.000001').toString() } }).result, 'fail', 'the prepared report total differs by 0.000001')
  assert.equal(run(base, { report: null }).result, 'fail', 'no report total')
  for (const [label, layers] of arms) {
    const got = run(layers)
    assert.doesNotMatch(`${got.expected} ${got.actual}`, SENTINEL, label)
    assert.doesNotMatch(got.actual, /\d+\.\d{2,}/, `${label}: no amount in the text`)
  }
  precondition(t, 'stock arms', arms.length + 3)
})

const movementsOf = (): StoredMovement[] => [...file].map(([key, p], i) => ({
  id: `m${i}`, key, qty: new D(p.qty), cost: new D(p.cost), total: p.qty.mul(p.cost).toDecimalPlaces(6), fromWarehouse: false, layers: [{ key, received: new D(p.qty), cost: new D(p.cost) }],
}))

test('opening-movements: each movement PAIRED with its layer and the file by identity; counts and sums that match while records are exchanged fail', (t) => {
  const run = (movements: StoredMovement[], otherTypes = 0) => openingMovementsItem({ file, movements, otherTypes })
  assert.equal(run(movementsOf()).result, 'pass')
  const base = movementsOf()
  const clone = () => movementsOf()
  const arms: Array<[string, StoredMovement[]]> = []
  // Mutation: compare the number of movements and the total quantity only (the old item) and every swap arm is green.
  const swapQty = clone(); [swapQty[0]!.qty, swapQty[1]!.qty] = [swapQty[1]!.qty, swapQty[0]!.qty]; arms.push(['movement quantities swapped (count and total equal)', swapQty])
  const swapKeys = clone(); [swapKeys[0]!.key, swapKeys[1]!.key] = [swapKeys[1]!.key, swapKeys[0]!.key]; arms.push(['movements moved to each other\'s pair', swapKeys])
  const crossLinked = clone(); [crossLinked[0]!.layers, crossLinked[1]!.layers] = [crossLinked[1]!.layers, crossLinked[0]!.layers]; arms.push(['movements linked to each other\'s layer', crossLinked])
  const otherPair = clone(); otherPair[0]!.layers = [{ ...otherPair[0]!.layers[0]!, key: 'OTHER|PAIR' }]; arms.push(['linked to a layer of ANOTHER pair with identical quantity and cost', otherPair])
  const unlinked = clone(); unlinked[0]!.layers = []; arms.push(['a movement with no layer linked', unlinked])
  const twice = clone(); twice[0]!.layers = [...twice[0]!.layers, twice[0]!.layers[0]!]; arms.push(['a movement linked to two layers', twice])
  const layerQty = clone(); layerQty[0]!.layers = [{ ...layerQty[0]!.layers[0]!, received: layerQty[0]!.layers[0]!.received.add(1) }]; arms.push(['the linked layer holds another quantity', layerQty])
  const costs = clone(); [costs[0]!.cost, costs[1]!.cost] = [costs[1]!.cost, costs[0]!.cost]; arms.push(['unit costs swapped', costs])
  const totals = clone(); [totals[0]!.total, totals[1]!.total] = [totals[1]!.total, totals[0]!.total]; arms.push(['values swapped', totals])
  const noCost = clone(); noCost[0]!.cost = null; arms.push(['a movement with no cost', noCost])
  const out = clone(); out[0]!.fromWarehouse = true; arms.push(['a movement that also leaves a warehouse', out])
  arms.push(['a duplicate in place of another', base.map((m, i) => (i === 0 ? { ...base[1]!, id: 'dup' } : m))])
  arms.push(['one missing', base.slice(1)])
  arms.push(['one extra', [...base, { ...base[0]!, id: 'extra', key: 'EXTRA|PAIR' }]])
  for (const [label, movements] of arms) assert.equal(run(movements).result, 'fail', label)
  assert.equal(run(base, 1).result, 'fail', 'a movement of another type')
  precondition(t, 'movement arms', arms.length + 1)
})

test('purchase-orders-draft: the stored references are EXACTLY the file\'s; a renamed order with the same count fails', (t) => {
  const references = ['PO-1', 'PO-2']
  const stored = (rows: Array<[string, string]>) => rows.map(([reference, status]) => ({ reference, status }))
  assert.equal(purchaseOrdersItem({ references, stored: stored([['PO-1', 'DRAFT'], ['PO-2', 'DRAFT']]) }).result, 'pass')
  const arms: Array<[string, Array<[string, string]>]> = [
    // Mutation: compare the number of orders and the non-draft count (the old item) and the rename arm is green.
    ['one renamed (count equal, all draft)', [['PO-1', 'DRAFT'], ['PO-X', 'DRAFT']]],
    ['one duplicated for another', [['PO-1', 'DRAFT'], ['PO-1', 'DRAFT']]],
    ['one not a draft', [['PO-1', 'DRAFT'], ['PO-2', 'PO_SENT']]],
    ['one missing', [['PO-1', 'DRAFT']]],
    ['one extra', [['PO-1', 'DRAFT'], ['PO-2', 'DRAFT'], ['PO-3', 'DRAFT']]],
  ]
  for (const [label, rows] of arms) assert.equal(purchaseOrdersItem({ references, stored: stored(rows) }).result, 'fail', label)
  assert.equal(purchaseOrdersItem({ references: [], stored: stored([['PO-1', 'DRAFT']]) }).result, 'fail', 'orders in a run that selects none')
  precondition(t, 'order arms', arms.length + 1)
})

// ---- migrations -------------------------------------------------------------------------------------------------------------------------------

const names = ['20260101000000_a', '20260102000000_b', '20260103000000_c']
const rowsOf = (list: string[], over: Partial<MigrationRow> = {}): MigrationRow[] => list.map((name) => ({ name, finished: true, rolledBack: false, ...over }))

test('migrations: the target holds EXACTLY the checkout\'s ordered list; the same count with one different name fails, with closed codes and counts only', (t) => {
  assert.deepEqual(compareMigrations(names, rowsOf(names)), [])
  // Mutation: compare the number of rows (the old precondition) and the swapped-name arm is green.
  const arms: Array<[string, MigrationRow[], RegExp]> = [
    ['one missing and one different (same count)', rowsOf([names[0]!, names[1]!, '20260199000000_other']), /MIGRATIONS_MISSING x1.*MIGRATIONS_EXTRA x1/],
    ['one missing', rowsOf(names.slice(1)), /MIGRATIONS_MISSING x1/],
    ['one extra', rowsOf([...names, '20260104000000_d']), /MIGRATIONS_EXTRA x1/],
    ['one duplicated in place of another', rowsOf([names[0]!, names[1]!, names[1]!]), /MIGRATIONS_(MISSING|DUPLICATE)/],
    ['one unfinished', [...rowsOf(names.slice(0, 2)), { name: names[2]!, finished: false, rolledBack: false }], /MIGRATIONS_UNFINISHED x1/],
    ['one rolled back', [...rowsOf(names.slice(0, 2)), { name: names[2]!, finished: true, rolledBack: true }], /MIGRATIONS_ROLLED_BACK x1/],
    ['applied out of order', rowsOf([names[1]!, names[0]!, names[2]!]), /MIGRATIONS_OUT_OF_ORDER x1/],
    ['an empty table', [], /MIGRATIONS_MISSING x3/],
  ]
  for (const [label, rows, pattern] of arms) {
    const problems = compareMigrations(names, rows).join(' ')
    assert.match(problems, pattern, label)
    assert.doesNotMatch(problems, /2026/, `${label}: no migration name in the text`)
  }
  assert.notEqual(migrationsHash(names), migrationsHash([names[0]!, names[1]!, '20260199000000_other']), 'the schema hash tells apart two lists of the same length')
  assert.notEqual(migrationsHash(names), migrationsHash([names[1]!, names[0]!, names[2]!]), 'and the same names in another order')
  assert.match(migrationsHash(names), /^[0-9a-f]{64}$/)
  precondition(t, 'migration arms', arms.length + 2)
})

test('the id list is closed, unique, and every id has a meaning', () => {
  assert.equal(new Set(VERIFICATION_IDS).size, VERIFICATION_IDS.length)
  assert.deepEqual(Object.keys(VERIFICATION_MEANING).sort(), [...VERIFICATION_IDS].sort())
})
