import assert from 'node:assert/strict'
import { test } from 'node:test'

import { D } from '../../lib/first-load/money.ts'
import { tablesOfKind } from '../../lib/first-load/apply/table-classes.ts'
import type { StepResult } from '../../lib/first-load/apply/orchestrate.ts'
import {
  QUEUE_TABLES, VERIFICATION_IDS, accountingItem, censusItems, changedTables, chainItem, expectedWrittenTables, fileStockTotals, parseBaseline, stockTotalsItem, type Baseline, type StockTotals,
} from '../../lib/first-load/apply/verify-core.ts'
import { loadOk, prepareSynthetic, preparedFiles, SENTINEL } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

/**
 * THE VERIFICATION RULES, without a database: every decision about "does this pass" is a pure function of a reading, so each rule is driven here with a fabricated reading and a
 * mutation of the rule is red. (The readings themselves are taken in apply-verify.test.ts against a real database.) Each arm names, in a comment, the change that makes it red.
 */

const tables = (extra: Record<string, number> = {}): Record<string, number> => ({ products: 0, suppliers: 0, settings: 4, integration_outbox: 0, accounting_sync_logs: 0, wms_sync_jobs: 0, email_outbox: 0, activity_logs: 0, ...extra })
const baseline = (): Baseline => ({ tables: tables(), heldWrites: 0 })
const byId = (items: ReturnType<typeof censusItems>) => Object.fromEntries(items.map((i) => [i.id, i]))

function result(over: Partial<StepResult> = {}): StepResult {
  return { step: 'suppliers', status: 'DONE', emitted: 3, created: 3, updated: 0, skippedExisting: 0, failed: 0, toLoad: 3, residual: [], conflicts: [], rows: [], importer: [], counterFindings: [], error: null, ...over }
}

test('the expected-write list is exactly the registry class the runner writes, and a table outside it is red in the census', (t) => {
  const expected = expectedWrittenTables()
  assert.deepEqual([...expected].sort(), tablesOfKind('RUNNER_WRITES'))
  precondition(t, 'expected tables', expected.size)
  // Mutation: expectedWrittenTables() returns tablesOfKind('CONFIG_ALLOWED') too, or every table, and the arms below go red.
  const ok = byId(censusItems(baseline(), { tables: tables({ products: 5, suppliers: 2, activity_logs: 9 }), heldWrites: 0 }))
  assert.equal(ok['write-census'].result, 'pass')
  const stray = byId(censusItems(baseline(), { tables: tables({ products: 5, settings: 5 }), heldWrites: 0 }))
  assert.equal(stray['write-census'].result, 'fail')
  assert.match(stray['write-census'].actual, /1 unexpected: settings/)
})

test('the census sees a table that appeared or vanished, not only the ones it was told to look at', () => {
  // Mutation: count only the tables of the baseline (or a fixed list) and both arms go green.
  const appeared = byId(censusItems(baseline(), { tables: tables({ zz_stray: 1 }), heldWrites: 0 }))
  assert.equal(appeared['write-census'].result, 'fail')
  assert.match(appeared['write-census'].actual, /zz_stray/)
  const gone = { ...tables() } as Record<string, number>
  delete gone.settings
  const vanished = byId(censusItems(baseline(), { tables: gone, heldWrites: 0 }))
  assert.equal(vanished['write-census'].result, 'fail')
  assert.deepEqual(changedTables(baseline(), { tables: tables({ zz_stray: 0 }), heldWrites: 0 }), ['zz_stray'])
})

test('each queue table is named on its own, and a refused outbound write is counted against the baseline', (t) => {
  let arms = 0
  // The four tables are written out here, not imported: a list that shrank in the subject would otherwise shrink in the test with it.
  const queues = ['integration_outbox', 'accounting_sync_logs', 'wms_sync_jobs', 'email_outbox']
  assert.deepEqual([...QUEUE_TABLES].sort(), [...queues].sort())
  for (const name of queues) {
    const items = byId(censusItems(baseline(), { tables: tables({ [name]: 1 }), heldWrites: 0 }))
    assert.equal(items['no-queue-growth'].result, 'fail', name)
    assert.match(items['no-queue-growth'].actual, new RegExp(name))
    assert.equal(items['write-census'].result, 'fail', `${name} is not a table the runner writes either`)
    arms++
  }
  // Mutation: compare heldWrites with 0 instead of the baseline (a baseline of 2 then fails) or ignore it.
  const held = byId(censusItems({ tables: tables(), heldWrites: 2 }, { tables: tables(), heldWrites: 3 }))
  assert.equal(held['no-held-writes'].result, 'fail')
  assert.equal(byId(censusItems({ tables: tables(), heldWrites: 2 }, { tables: tables(), heldWrites: 2 }))['no-held-writes'].result, 'pass')
  precondition(t, 'queue arms', arms)
  assert.equal(arms, 4)
})

test('no baseline fails closed: every census item fails, none is skipped', () => {
  // Mutation: return [] (or pass) when the baseline is null.
  const items = censusItems(null, { tables: tables(), heldWrites: 0 })
  assert.deepEqual(items.map((i) => i.id).sort(), ['census-baseline', 'no-held-writes', 'no-queue-growth', 'write-census'])
  assert.ok(items.every((i) => i.result === 'fail'))
})

test('a baseline is parsed strictly: anything unusable is no baseline', (t) => {
  const good = { tables: { a: 1 }, heldWrites: 0 }
  assert.deepEqual(parseBaseline(good), good)
  const bad: unknown[] = [null, 'x', [], {}, { tables: {}, heldWrites: 0 }, { tables: { a: -1 }, heldWrites: 0 }, { tables: { a: 1.5 }, heldWrites: 0 }, { tables: { a: '1' }, heldWrites: 0 }, { tables: { a: 1 } }, { tables: { a: 1 }, heldWrites: -1 }, { tables: [1], heldWrites: 0 }]
  for (const raw of bad) assert.equal(parseBaseline(raw), null, JSON.stringify(raw))
  precondition(t, 'unusable baselines', bad.length)
})

test('the accounting identity: a broken identity, an update, a failure and a conflict each fail; an empty list fails', (t) => {
  assert.equal(accountingItem([result()]).result, 'pass')
  const arms: Array<[string, StepResult[]]> = [
    ['identity broken', [result({ created: 2 })]],
    ['an update', [result({ created: 2, updated: 1 })]],
    ['a failure', [result({ created: 2, failed: 1 })]],
    ['a conflict', [result({ conflicts: [{ key: 'k', code: 'FIELDS_DIFFER', detail: 'd' }] })]],
    ['no step at all', []],
  ]
  for (const [label, steps] of arms) assert.equal(accountingItem(steps).result, 'fail', label)
  precondition(t, 'accounting arms', arms.length)
})

test('stock totals: a difference of 0.000001 in quantity or value, a missing or extra warehouse, a foreign layer and a wrong report total each fail', (t) => {
  const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const file = fileStockTotals(prepared)
  const totals = prepared.report.stock!.totals
  const report = { qty: totals.openingQty, value: totals.openingValueBase }
  assert.ok(file.size >= 2, 'the fixture has stock in two warehouses')
  const same = (): Map<string, StockTotals> => new Map([...file].map(([k, v]) => [k, { qty: new D(v.qty), value: new D(v.value) }]))
  assert.equal(stockTotalsItem({ file, database: same(), report, nonOpeningLayers: 0 }).result, 'pass')
  const [first] = [...file.keys()]
  const arms: Array<[string, ReturnType<typeof stockTotalsItem>]> = []
  const q = same(); q.set(first, { qty: q.get(first)!.qty.add('0.000001'), value: q.get(first)!.value })
  arms.push(['quantity off by 0.000001', stockTotalsItem({ file, database: q, report, nonOpeningLayers: 0 })])
  const v = same(); v.set(first, { qty: v.get(first)!.qty, value: v.get(first)!.value.add('0.000001') })
  arms.push(['value off by 0.000001', stockTotalsItem({ file, database: v, report, nonOpeningLayers: 0 })])
  const missing = same(); missing.delete(first)
  arms.push(['a warehouse missing', stockTotalsItem({ file, database: missing, report, nonOpeningLayers: 0 })])
  const extra = same(); extra.set('SOMEWHERE-ELSE', { qty: new D(0), value: new D(0) })
  arms.push(['an extra warehouse', stockTotalsItem({ file, database: extra, report, nonOpeningLayers: 0 })])
  arms.push(['a foreign layer', stockTotalsItem({ file, database: same(), report, nonOpeningLayers: 1 })])
  arms.push(['report total differs', stockTotalsItem({ file, database: same(), report: { ...report, value: new D(report.value).add('0.000001').toString() }, nonOpeningLayers: 0 })])
  arms.push(['no report total', stockTotalsItem({ file, database: same(), report: null, nonOpeningLayers: 0 })])
  // 0.000001 moved from one warehouse to another: every total (and the report's) is unchanged, so only the PER-WAREHOUSE comparison can see it.
  const [, second] = [...file.keys()]
  const moved = same(); moved.set(first, { qty: moved.get(first)!.qty.add('0.000001'), value: moved.get(first)!.value }); moved.set(second, { qty: moved.get(second)!.qty.sub('0.000001'), value: moved.get(second)!.value })
  arms.push(['0.000001 moved between warehouses', stockTotalsItem({ file, database: moved, report, nonOpeningLayers: 0 })])
  const movedValue = same(); movedValue.set(first, { qty: movedValue.get(first)!.qty, value: movedValue.get(first)!.value.add('0.000001') }); movedValue.set(second, { qty: movedValue.get(second)!.qty, value: movedValue.get(second)!.value.sub('0.000001') })
  arms.push(['value 0.000001 moved between warehouses', stockTotalsItem({ file, database: movedValue, report, nonOpeningLayers: 0 })])
  for (const [label, got] of arms) {
    assert.equal(got.result, 'fail', label)
    // Counts only: no quantity, no value, no warehouse code reaches the text.
    assert.doesNotMatch(`${got.expected} ${got.actual}`, SENTINEL, label)
    assert.doesNotMatch(got.actual, /\d+\.\d{2,}/, `${label}: no amount in the text`)
  }
  precondition(t, 'stock arms', arms.length)
  // Mutation: compare with a tolerance (|a-b| < 0.01) or through toFixed(2) and the two 0.000001 arms go green.
})

test('the chain to the prepared report: a step whose emitted count, planned rows or file rows disagree breaks it', (t) => {
  const prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  const results = prepared.steps.map((s) => result({ step: s.step, emitted: s.units.length }))
  assert.equal(chainItem(prepared, results).result, 'pass')
  assert.equal(chainItem(prepared, results.map((r, i) => (i === 0 ? { ...r, emitted: r.emitted + 1 } : r))).result, 'fail', 'emitted differs from the units')
  assert.equal(chainItem(prepared, results.slice(1)).result, 'fail', 'a selected step has no result')
  const planned = structuredClone(prepared.report) as unknown as { plannedOutputRows: Record<string, number> }
  planned.plannedOutputRows.products = (planned.plannedOutputRows.products ?? 0) + 1
  assert.equal(chainItem({ ...prepared, report: planned as unknown as typeof prepared.report }, results).result, 'fail', 'the prepared report plans another row count')
  assert.equal(chainItem({ ...prepared, steps: [] }, []).result, 'fail', 'nothing selected is not a chain')
  precondition(t, 'chain arms', 5)
})

test('the id list is closed and unique', () => {
  assert.equal(new Set(VERIFICATION_IDS).size, VERIFICATION_IDS.length)
})
