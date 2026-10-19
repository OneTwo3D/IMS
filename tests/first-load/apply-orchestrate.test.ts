/**
 * The orchestration: plan (read only), apply, resume. Everything runs against an in-memory "database" whose importer behaves like the real ones
 * where it matters (it refuses a key that already exists, it can crash between row transactions, it can create a product and silently drop its recipe).
 * Each arm names what it proves; the honest control (a clean full apply) runs first and every refusal arm asserts that NO importer call was made.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFLICT_CODES, REHEARSAL_RECORD_FORMAT_VERSION, REPORT_CONFLICT_FIELDS, REPORT_IMPORTER_MESSAGE_FIELDS, REPORT_ROW_FIELDS, ROW_OUTCOMES } from '../../lib/first-load/apply/constants.ts'
import { StepLockError, checkRehearsalGate, runLoad, type ApplyOptions, type ApplyResult, type RunRecord } from '../../lib/first-load/apply/orchestrate.ts'
import { ObservationError } from '../../lib/first-load/apply/residual.ts'
import { buildApplyReport, renderApplyJson, renderApplyMarkdown } from '../../lib/first-load/apply/report.ts'
import { FakeDatabase, NO_LOCK, loadOk, prepareSynthetic, preparedFiles } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

const files = preparedFiles(prepareSynthetic())
const NOW = new Date('2026-10-20T12:00:00Z')

function setup() {
  const prepared = loadOk(files)
  const db = new FakeDatabase(prepared)
  const rehearsal = { formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: prepared.manifestDigest, verdict: 'OK', systemId: 'sys-1', finishedAt: '2026-10-20T11:00:00Z' }
  const options = (over: Partial<ApplyOptions> = {}): ApplyOptions => ({ mode: 'apply', resume: false, rehearsal, systemId: 'sys-1', now: NOW, maxRehearsalAgeHours: 24, ...over })
  return { prepared, db, rehearsal, options }
}

function untouched(db: FakeDatabase): void {
  assert.equal(db.executed.length, 0, 'no importer call was made')
  assert.equal(db.journalRecord, null, 'no run record was written')
  assert.equal([...db.entries.values()].reduce((t, e) => t + e.length, 0), 0, 'no row was written')
}

test('control: a clean apply loads every unit of every step, the identity holds, and the run record says APPLIED', (t) => {
  const { prepared, db, options } = setup()
  return runLoad(prepared, db.ports(), options()).then((result) => {
    assert.equal(result.exit, 'OK', result.problems.join('; '))
    precondition(t, 'steps applied', result.steps.length)
    for (const s of result.steps) {
      assert.equal(s.status, 'DONE', s.step)
      assert.equal(s.created, s.emitted, `${s.step}: every unit was created`)
      assert.equal(s.skippedExisting + s.failed + s.updated, 0)
      assert.deepEqual(s.counterFindings, [], `${s.step}: the importer's counters agree with the database`)
    }
    assert.deepEqual(result.steps.map((s) => [s.step, s.created]), [['suppliers', 2], ['products', 8], ['opening-stock', 4], ['purchase-orders', 2]])
    assert.equal(db.journalRecord?.status, 'VERIFIED')
    assert.deepEqual(db.executed.map((e) => e.step), ['suppliers', 'products', 'opening-stock', 'purchase-orders'], 'steps run in load order')
  })
})

test('plan: reads the database and writes nothing (no importer call, no run record), and lists the residual it would send', async (t) => {
  const { prepared, db, options } = setup()
  const result = await runLoad(prepared, db.ports(), options({ mode: 'plan', rehearsal: null, systemId: null }))
  assert.equal(result.exit, 'OK')
  precondition(t, 'steps planned', result.steps.length)
  untouched(db)
  for (const s of result.steps) {
    assert.equal(s.toLoad, s.emitted)
    assert.equal(s.created, 0, 'a plan creates nothing')
    assert.ok(s.rows.every((r) => r.outcome === 'planned'))
    assert.equal(s.residual.reduce((n, r) => n + r.rows, 0), prepared.steps.find((p) => p.step === s.step)!.data.rows.length)
  }
})

test('plan: against a database that already holds part of the load it reports would-skip-existing and the smaller residual', async () => {
  const { prepared, db, options } = setup()
  assert.equal((await runLoad(prepared, db.ports(), options())).exit, 'OK')
  db.journalRecord = null
  const result = await runLoad(prepared, db.ports(), options({ mode: 'plan', rehearsal: null, systemId: null }))
  assert.equal(result.exit, 'OK')
  for (const s of result.steps) {
    assert.equal(s.toLoad, 0)
    assert.equal(s.skippedExisting, s.emitted)
    assert.deepEqual(s.residual, [])
    assert.ok(s.rows.every((r) => r.outcome === 'would-skip-existing'))
  }
})

test('rehearsal gate: --apply without a matching, recent, OK rehearsal of the same load on the same target is refused before the database is read', async (t) => {
  const { prepared, db, rehearsal, options } = setup()
  const arms: Array<[string, Partial<ApplyOptions>]> = [
    ['no rehearsal', { rehearsal: null }],
    ['verdict not OK', { rehearsal: { ...rehearsal, verdict: 'VERIFY_FAILED' } }],
    ['another load', { rehearsal: { ...rehearsal, manifestDigest: 'f'.repeat(64) } }],
    ['another target', { rehearsal: { ...rehearsal, systemId: 'sys-2' } }],
    ['target system id unknown', { systemId: null }],
    ['too old', { rehearsal: { ...rehearsal, finishedAt: '2026-10-19T11:59:59Z' } }],
    ['finished in the future', { rehearsal: { ...rehearsal, finishedAt: '2026-10-20T12:00:01Z' } }],
    ['no timestamp', { rehearsal: { ...rehearsal, finishedAt: undefined } }],
    ['wrong format', { rehearsal: { ...rehearsal, formatVersion: 2 } }],
    ['not an object', { rehearsal: 'OK' }],
  ]
  precondition(t, 'gate arms', arms.length)
  for (const [label, over] of arms) {
    const result = await runLoad(prepared, db.ports(), options(over))
    assert.equal(result.exit, 'PRECONDITION_REFUSED', label)
    assert.ok(result.problems.length > 0, label)
    untouched(db)
    assert.equal(db.readsOf.size, 0, `${label}: the database was not even read`)
  }
  assert.equal((await runLoad(prepared, db.ports(), options({ rehearsal: { ...rehearsal, finishedAt: '2026-10-19T12:00:00Z' } }))).exit, 'OK', 'exactly at the age limit is still accepted (the boundary control)')
})

test('rehearsal age: the 24 hour ceiling is fixed in the core; a larger, infinite, NaN, zero or negative limit and an invalid clock are refused', async (t) => {
  const { prepared, db, rehearsal, options } = setup()
  const old = { ...rehearsal, finishedAt: '2026-10-19T11:00:00Z' } // 25 hours old
  const arms: Array<[string, Partial<ApplyOptions>]> = [
    ['limit raised to 1000 h', { rehearsal: old, maxRehearsalAgeHours: 1000 }],
    ['limit Infinity', { rehearsal: old, maxRehearsalAgeHours: Number.POSITIVE_INFINITY }],
    ['limit NaN', { maxRehearsalAgeHours: Number.NaN }],
    ['limit zero', { maxRehearsalAgeHours: 0 }],
    ['limit negative', { maxRehearsalAgeHours: -5 }],
    ['clock invalid', { now: new Date('not a date') }],
  ]
  precondition(t, 'age arms', arms.length)
  for (const [label, over] of arms) {
    const result = await runLoad(prepared, db.ports(), options(over))
    assert.equal(result.exit, 'PRECONDITION_REFUSED', label)
    untouched(db)
  }
  assert.equal((await runLoad(prepared, db.ports(), options({ maxRehearsalAgeHours: 1 }))).exit, 'OK', 'control: a tighter limit than the ceiling is honoured and a 1 hour old rehearsal passes it')
})

test('reports never carry importer error text or exception messages: only a code, a row number and the step', async (t) => {
  const SECRET_FILE_VALUE = 'SENTINEL-FILE-VALUE-91'
  const SECRET_EXCEPTION = 'SENTINEL-EXCEPTION-SECRET-77'
  const runs: ApplyResult[] = []
  const a = setup()
  runs.push(await runLoad(a.prepared, a.db.ports({ execute: async (step, file, lock) => { const r = await a.db.ports().execute(step, file, lock); return step === 'suppliers' ? { ...r, errors: [`Row 7: order ${SECRET_FILE_VALUE} already exists`, `unexpected ${SECRET_EXCEPTION}`] } : r } }), a.options()))
  const b = setup()
  runs.push(await runLoad(b.prepared, b.db.ports({ execute: async () => { throw new Error(`password=${SECRET_EXCEPTION}`) } }), b.options()))
  const c = setup()
  c.db.unreadable = true
  runs.push(await runLoad(c.prepared, c.db.ports({ observe: async () => { throw new ObservationError(`connect failed ${SECRET_EXCEPTION}`) } }), c.options()))
  precondition(t, 'runs rendered', runs.length)
  const first = runs[0].steps[0].importer[0].errors
  assert.deepEqual(first, [{ code: 'ALREADY_EXISTS', row: 7 }, { code: 'OTHER', row: null }], 'control: the code and the row number survive')
  for (const result of runs) {
    const prepared = a.prepared
    const report = buildApplyReport({ prepared, result })
    for (const text of [renderApplyJson(report), renderApplyMarkdown(report), JSON.stringify(result.problems)]) {
      assert.ok(!text.includes(SECRET_FILE_VALUE) && !text.includes(SECRET_EXCEPTION), 'no sentinel in the output')
    }
  }
  assert.ok(renderApplyMarkdown(buildApplyReport({ prepared: a.prepared, result: runs[0] })).includes('ALREADY_EXISTS (row 7)'))
})

test('report rows carry only the declared identifier fields: unit key plus closed words; no other cell, importer text or exception text', async (t) => {
  const { prepared, db, options } = setup()
  db.dropRecipeFor.add('ZQSENT-GIFT-SET')
  const failed = await runLoad(prepared, db.ports({ execute: async (step, file, lock) => { const r = await db.ports().execute(step, file, lock); return step === 'suppliers' ? { ...r, errors: ['Row 3: free text from the importer SENTINEL-IMPORTER-TEXT'] } : r } }), options())
  const second = setup()
  second.db.foreignHistory = ['ZQSENT-LEG-01|ZQSENT-MAIN']
  const conflicted = await runLoad(second.prepared, second.db.ports(), second.options())
  const third = setup()
  third.db.seed('products', { ...third.prepared.steps[1].units[1], fingerprint: '{"x":1}', recipe: null })
  third.db.seed('suppliers', { key: 'stranger', collisionKey: 'STRANGER', fingerprint: 'x', recipe: null })
  const differing = await runLoad(third.prepared, third.db.ports(), third.options())
  const reports = [failed, conflicted, differing].map((result) => JSON.parse(renderApplyJson(buildApplyReport({ prepared, result }))))
  let rows = 0
  let conflicts = 0
  let messages = 0
  for (const report of reports) {
    for (const step of report.steps) {
      const keys = new Set(prepared.steps.find((s) => s.step === step.step)!.units.map((u) => u.key))
      for (const row of step.rows) {
        assert.deepEqual(Object.keys(row).sort(), [...REPORT_ROW_FIELDS].sort())
        assert.ok(keys.has(row.key), 'a row key is a unit key of the step')
        assert.ok((ROW_OUTCOMES as readonly string[]).includes(row.outcome))
        assert.ok(row.reason === null || (CONFLICT_CODES as readonly string[]).includes(row.reason) || ['not loaded', 'changed during the step'].includes(row.reason))
        rows++
      }
      for (const c of step.conflicts) {
        assert.deepEqual(Object.keys(c).sort(), [...REPORT_CONFLICT_FIELDS].sort())
        assert.ok((CONFLICT_CODES as readonly string[]).includes(c.code))
        assert.ok(/^[a-z0-9 ]{1,80}$/.test(c.detail) && ![...keys].some((k) => c.detail.includes(k)), 'a conflict detail is a short fixed sentence that names no key')
        conflicts++
      }
      for (const i of step.importer) for (const e of i.errors) {
        assert.deepEqual(Object.keys(e).sort(), [...REPORT_IMPORTER_MESSAGE_FIELDS].sort())
        messages++
      }
    }
    const text = JSON.stringify(report)
    assert.ok(!text.includes('SENTINEL-IMPORTER-TEXT') && !text.includes('Name of '), 'no importer text and no other cell (a product name) is in the report')
  }
  precondition(t, 'report rows examined', rows)
  precondition(t, 'conflicts examined', conflicts)
  precondition(t, 'importer messages examined', messages)
})

test('run record: a second load over an existing record, a resume with no record, a different digest and a finished run are each refused', async (t) => {
  const { prepared, db, options } = setup()
  assert.equal((await runLoad(prepared, db.ports(), options({ resume: true }))).exit, 'PRECONDITION_REFUSED', 'resume with no record')
  untouched(db)
  assert.equal((await runLoad(prepared, db.ports(), options())).exit, 'OK')
  const before = db.executed.length
  const second = await runLoad(prepared, db.ports(), options())
  assert.equal(second.exit, 'PRECONDITION_REFUSED')
  assert.match(second.problems[0], /run record already exists/)
  const finished = await runLoad(prepared, db.ports(), options({ resume: true }))
  assert.equal(finished.exit, 'PRECONDITION_REFUSED')
  assert.match(finished.problems[0], /VERIFIED, which is not resumable/)
  db.journalRecord = { ...(db.journalRecord as RunRecord), manifestDigest: 'e'.repeat(64), status: 'STEP_FAILED' }
  const other = await runLoad(prepared, db.ports(), options({ resume: true }))
  assert.equal(other.exit, 'PRECONDITION_REFUSED')
  assert.ok(other.problems[0].includes('e'.repeat(64)) && other.problems[0].includes(prepared.manifestDigest), 'names both digests')
  assert.equal(db.executed.length, before, 'none of the refusals sent anything to an importer')
  precondition(t, 'refusals', 4)
})

test('fail closed: an unreadable database is a refusal, never an empty database', async () => {
  const { prepared, db, options } = setup()
  db.unreadable = true
  const result = await runLoad(prepared, db.ports(), options())
  assert.equal(result.exit, 'PRECONDITION_REFUSED')
  assert.match(result.problems[0], /never assumed to be empty/)
  untouched(db)
})

test('conflicts on a fresh run stop everything before the first write: changed fields, a look-alike key, a foreign row, foreign stock history', async (t) => {
  const arms: Array<[string, (db: FakeDatabase, p: ReturnType<typeof setup>['prepared']) => void, string]> = [
    ['supplier with other fields', (db, p) => db.seed('suppliers', { ...p.steps[0].units[0], fingerprint: '{"name":"x"}', recipe: null }), 'FIELDS_DIFFER'],
    ['SKU equal in upper case', (db) => db.seed('products', { key: 'zqsent-oak-board', collisionKey: 'ZQSENT-OAK-BOARD', fingerprint: 'x', recipe: null }), 'CASE_COLLISION'],
    ['a product nobody emitted', (db) => db.seed('products', { key: 'STRANGER', collisionKey: 'STRANGER', fingerprint: 'x', recipe: null }), 'FOREIGN_ROW'],
    ['the product exists but its recipe does not', (db, p) => { const u = p.steps[1].units.find((x) => x.key === 'ZQSENT-LEG-01')!; db.seed('products', { key: u.key, collisionKey: u.collisionKey, fingerprint: u.fingerprint, recipe: null }) }, 'RECIPE_DIFFERS'],
    ['stock history that is not an opening layer', (db) => { db.foreignHistory = ['ZQSENT-LEG-01|ZQSENT-MAIN'] }, 'FOREIGN_HISTORY'],
    ['the same key twice', (db, p) => { const u = p.steps[0].units[0]; db.seed('suppliers', { ...u }); db.seed('suppliers', { ...u }) }, 'DUPLICATE_IN_DATABASE'],
  ]
  precondition(t, 'conflict arms', arms.length)
  for (const [label, arrange, code] of arms) {
    const { prepared, db, options } = setup()
    arrange(db, prepared)
    const seeded = [...db.entries.values()].reduce((n, e) => n + e.length, 0)
    const result = await runLoad(prepared, db.ports(), options())
    assert.equal(result.exit, 'PRECONDITION_REFUSED', label)
    assert.ok(result.steps.flatMap((s) => s.conflicts).some((c) => c.code === code), `${label}: ${JSON.stringify(result.steps.flatMap((s) => s.conflicts))}`)
    assert.equal(db.executed.length, 0, `${label}: nothing was sent to an importer`)
    assert.equal(db.journalRecord, null, `${label}: no run record`)
    assert.equal([...db.entries.values()].reduce((n, e) => n + e.length, 0), seeded, `${label}: no row was added`)
  }
})

test('crash in the middle of opening stock: the resume sends ONLY the rows that are not there, and the totals are exact', async () => {
  const { prepared, db, options } = setup()
  db.failAfterRows = 2 + 8 + 2 // suppliers + products + two of the four stock rows
  const crashed = await runLoad(prepared, db.ports(), options())
  assert.equal(crashed.exit, 'STEP_FAILED')
  assert.equal(db.journalRecord?.status, 'STEP_FAILED')
  const stockAfterCrash = crashed.steps.find((s) => s.step === 'opening-stock')!
  assert.equal(stockAfterCrash.created, 2)
  assert.equal(stockAfterCrash.failed, 2)
  assert.equal(stockAfterCrash.emitted, stockAfterCrash.created + stockAfterCrash.skippedExisting + stockAfterCrash.failed + stockAfterCrash.updated)
  assert.deepEqual(stockAfterCrash.importer[0].errors, [{ code: 'EXCEPTION', row: null }])
  assert.ok(!crashed.steps.some((s) => s.step === 'purchase-orders'), 'later steps did not run')
  db.failAfterRows = null
  const executedBefore = db.executed.length
  const resumed = await runLoad(prepared, db.ports(), options({ resume: true }))
  assert.equal(resumed.exit, 'OK', resumed.problems.join('; '))
  const sent = db.executed.slice(executedBefore)
  assert.deepEqual(sent.map((e) => [e.step, e.rows]), [['opening-stock', 2], ['purchase-orders', 3]], 'suppliers and products were already complete and were not re-sent; stock sent its two missing rows')
  const stock = resumed.steps.find((s) => s.step === 'opening-stock')!
  assert.deepEqual([stock.created, stock.skippedExisting, stock.failed], [2, 2, 0])
  assert.deepEqual(stock.importer.map((i) => i.skipped), [0], 'the importer was never asked to re-load a row that exists')
  for (const s of resumed.steps.filter((x) => x.step === 'suppliers' || x.step === 'products')) assert.equal(s.skippedExisting, s.emitted)
  assert.equal(db.entries.get('opening-stock')!.length, 4, 'exactly one opening layer per pair')
  assert.equal(db.journalRecord?.status, 'VERIFIED')
})

test('silent recipe loss: a product the importer counted as created but whose recipe is missing is FAILED, the run stops, and the counters are only a cross-check', async () => {
  const { prepared, db, options } = setup()
  db.dropRecipeFor.add('ZQSENT-GIFT-SET')
  const result = await runLoad(prepared, db.ports(), options())
  assert.equal(result.exit, 'STEP_FAILED')
  const products = result.steps.find((s) => s.step === 'products')!
  assert.equal(products.importer[0].created, 8, 'the importer says all eight were created')
  assert.equal(products.created, 7)
  assert.equal(products.failed, 1)
  assert.deepEqual(products.rows.filter((r) => r.outcome === 'failed'), [{ key: 'ZQSENT-GIFT-SET', outcome: 'failed', reason: 'RECIPE_DIFFERS' }])
  assert.match(products.counterFindings[0], /reported 8 row\(s\) created, the database shows 7/)
  assert.ok(!db.executed.some((e) => e.step === 'opening-stock'), 'nothing after the failed step ran')
  assert.equal(db.journalRecord?.steps.products?.status, 'FAILED')
})

test('conflict that appears AFTER the first read (another writer): the step re-reads under its lock and stops with CONFLICT, earlier steps stand', async () => {
  const { prepared, db, options } = setup()
  let stockReads = 0
  const ports = db.ports({
    observe: async (step) => {
      if (step === 'opening-stock' && ++stockReads === 2) db.foreignHistory = ['ZQSENT-OAK-BOARD|ZQSENT-MAIN']
      return db.observeNow(step)
    },
  })
  const result = await runLoad(prepared, ports, options())
  assert.equal(result.exit, 'CONFLICT')
  assert.equal(db.journalRecord?.status, 'CONFLICT')
  assert.deepEqual(db.executed.map((e) => e.step), ['suppliers', 'products'], 'nothing was sent for the conflicting step or after it')
  assert.ok(result.steps.find((s) => s.step === 'opening-stock')!.conflicts.some((c) => c.code === 'FOREIGN_HISTORY'))
})

test('a conflict found on a RESUME is reported as CONFLICT (earlier writes stand), not as a refusal', async () => {
  const { prepared, db, options } = setup()
  db.failAfterRows = 2 + 8 + 1
  assert.equal((await runLoad(prepared, db.ports(), options())).exit, 'STEP_FAILED')
  db.failAfterRows = null
  db.foreignHistory = ['ZQSENT-LEG-01|ZQSENT-MAIN']
  const result = await runLoad(prepared, db.ports(), options({ resume: true }))
  assert.equal(result.exit, 'CONFLICT')
})

test('rails re-evaluated inside the step: a rail that fails at step start, or just before the first write, stops the step; nothing is sent', async (t) => {
  for (const phase of ['step-start', 'before-first-write'] as const) {
    const { prepared, db, options } = setup()
    const ports = db.ports({ recheckRails: async (_step, p) => (p === phase ? ['a connector became runnable'] : []) })
    const result = await runLoad(prepared, ports, options())
    assert.equal(result.exit, 'STEP_FAILED', phase)
    assert.match(result.problems[0], /a rail no longer holds: a connector became runnable/)
    assert.equal(db.executed.length, 0, phase)
    assert.equal(db.journalRecord?.status, 'STEP_FAILED', 'resumable')
  }
  precondition(t, 'phases', 2)
})

test('an unreadable database in the middle of the run is a resumable STEP_FAILED (the post-step read cannot be skipped)', async () => {
  const { prepared, db, options } = setup()
  const ports = db.ports({
    execute: async (step, file) => {
      const answer = await db.ports().execute(step, file, NO_LOCK)
      if (step === 'products') db.unreadable = true
      return answer
    },
  })
  const result = await runLoad(prepared, ports, options())
  assert.equal(result.exit, 'STEP_FAILED')
  assert.match(result.problems[0], /could not be read/)
  assert.equal(db.journalRecord?.status, 'STEP_FAILED')
  db.unreadable = false
  assert.equal((await runLoad(prepared, db.ports(), options({ resume: true }))).exit, 'OK')
})

test('another runner moving the run record: the save is refused (compare-and-swap) and the run stops instead of overwriting it', async () => {
  const { prepared, db, options } = setup()
  let saves = 0
  const base = db.ports()
  const ports = db.ports({ journal: { load: base.journal.load, save: async (record, expected) => { if (++saves === 3) db.journalRecord = { ...(db.journalRecord as RunRecord), version: 99 }; return base.journal.save(record, expected) } } })
  const result = await runLoad(prepared, ports, options())
  assert.equal(result.exit, 'STEP_FAILED')
  assert.match(result.problems[0], /another runner/)
  assert.equal(db.journalRecord?.version, 99, 'the other runner\'s record was not overwritten')
})

test('an importer that throws is recorded as an EXCEPTION code (no message) and ends the step as STEP_FAILED', async () => {
  const { prepared, db, options } = setup()
  const ports = db.ports({ execute: async (step) => { if (step === 'suppliers') throw new Error('deadlock detected'); return { created: 0, updated: 0, skipped: 0, errors: [] } } })
  const result = await runLoad(prepared, ports, options())
  assert.equal(result.exit, 'STEP_FAILED')
  assert.deepEqual(result.steps[0].importer[0].errors, [{ code: 'EXCEPTION', row: null }])
  assert.equal(result.steps[0].failed, 2)
})

test('verification port: a failed check ends VERIFY_FAILED with the record resumable; a clean one ends VERIFIED', async () => {
  const bad = setup()
  const failed = await runLoad(bad.prepared, bad.db.ports({ verify: async () => [{ id: 'stock-total', result: 'fail', expected: '76', actual: '75' }] }), bad.options())
  assert.equal(failed.exit, 'VERIFY_FAILED')
  assert.match(failed.problems[0], /stock-total: expected 76, found 75/)
  assert.equal(bad.db.journalRecord?.status, 'VERIFY_FAILED')
  const good = setup()
  const ok = await runLoad(good.prepared, good.db.ports({ verify: async () => [{ id: 'stock-total', result: 'pass', expected: '76', actual: '76' }] }), good.options())
  assert.equal(ok.exit, 'OK')
  assert.equal(good.db.journalRecord?.status, 'VERIFIED')
})

test('report: deterministic bytes; the operator text claims "nothing written" only for exits where that is proven', async (t) => {
  const { prepared, db, options } = setup()
  const result = await runLoad(prepared, db.ports(), options())
  const a = renderApplyJson(buildApplyReport({ prepared, result, window: { start: 'a', end: 'b' } }))
  const b = renderApplyJson(buildApplyReport({ prepared, result, window: { start: 'a', end: 'b' } }))
  assert.equal(a, b)
  assert.equal(JSON.parse(a).accountingBalanced, true)
  assert.ok(renderApplyMarkdown(buildApplyReport({ prepared, result })).includes('identity emitted = created + updated + skipped (existing) + failed holds'))
  const exits: ApplyResult['exit'][] = ['VERIFY_FAILED', 'USAGE', 'PRECONDITION_REFUSED', 'STEP_FAILED', 'CONFLICT', 'INTERNAL', 'REHEARSAL_TEARDOWN_INCOMPLETE']
  precondition(t, 'exits rendered', exits.length)
  for (const exit of exits) {
    const text = JSON.parse(renderApplyJson(buildApplyReport({ prepared, result: { ...result, exit } }))).exit.operatorText as string
    const claimsNothing = /wrote nothing/.test(text)
    assert.equal(claimsNothing, exit === 'USAGE' || exit === 'PRECONDITION_REFUSED', exit)
    assert.equal(/restore/.test(text), ['VERIFY_FAILED', 'STEP_FAILED', 'CONFLICT', 'INTERNAL'].includes(exit), `${exit}: the restore procedure appears exactly where rows may be written`)
  }
})

test('the observation error type is distinct (a port that throws anything else is a defect, not a "database is empty")', () => {
  assert.ok(new ObservationError('x') instanceof Error)
  assert.equal(new ObservationError('x').name, 'ObservationError')
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The preflight port and the step lock (the database slice supplies both)
// ---------------------------------------------------------------------------------------------------------------------------------

test('preflight: problems refuse a plan and an apply before anything is written, and the core tells it whether a run record exists', async (t) => {
  const { prepared, db, options } = setup()
  const seen: boolean[] = []
  const refuse = (problems: string[]) => db.ports({ preflight: async ({ resuming }) => { seen.push(resuming); return problems } })
  // CONTROL: no problems, and the apply goes through.
  const clean = await runLoad(prepared, refuse([]), options())
  assert.equal(clean.exit, 'OK')
  assert.deepEqual(seen, [false], 'a fresh load is told it is not resuming')
  // A fresh database, problems found: both modes refuse; nothing is written.
  const fresh = setup()
  const planned = await runLoad(fresh.prepared, fresh.db.ports({ preflight: async () => ['empty target: the suppliers table holds 1 row(s)'] }), options({ mode: 'plan', rehearsal: null, systemId: null }))
  assert.equal(planned.exit, 'PRECONDITION_REFUSED')
  assert.deepEqual(planned.problems, ['empty target: the suppliers table holds 1 row(s)'])
  const applied = await runLoad(fresh.prepared, fresh.db.ports({ preflight: async () => ['empty target: the suppliers table holds 1 row(s)'] }), options())
  assert.equal(applied.exit, 'PRECONDITION_REFUSED')
  untouched(fresh.db)
  precondition(t, 'modes refused', 2)
})

test('preflight: a resume is told it is resuming; an unreadable database in preflight is a refusal, not a pass', async () => {
  const { options } = setup()
  const first = setup()
  first.db.failAfterRows = 1
  await runLoad(first.prepared, first.db.ports(), options())
  first.db.failAfterRows = null
  const seen: boolean[] = []
  const resumed = await runLoad(first.prepared, first.db.ports({ preflight: async ({ resuming }) => { seen.push(resuming); return [] } }), options({ resume: true }))
  assert.equal(resumed.exit, 'OK', resumed.problems.join('; '))
  assert.deepEqual(seen, [true])
  const unreadable = setup()
  const refused = await runLoad(unreadable.prepared, unreadable.db.ports({ preflight: async () => { throw new ObservationError('connection refused') } }), options())
  assert.equal(refused.exit, 'PRECONDITION_REFUSED')
  assert.match(refused.problems.join(' '), /never assumed to be empty/)
  untouched(unreadable.db)
})

test('step lock: a step whose lock is busy, lost or unavailable stops the run as STEP_FAILED, makes no importer call for it and leaves the run record as it was', async () => {
  for (const reason of ['busy', 'lost', 'unavailable'] as const) {
    const { prepared, db, options } = setup()
    const result = await runLoad(prepared, db.ports({ withStepLock: async () => { throw new StepLockError(reason) } }), options())
    assert.equal(result.exit, 'STEP_FAILED', reason)
    assert.match(result.problems.join(' '), new RegExp(`step lock was not available \\(${reason}\\)`))
    assert.equal(db.executed.length, 0, `${reason}: no importer call`)
    assert.equal(db.journalRecord?.version, 1, `${reason}: the record is as the run created it`)
    assert.equal(db.journalRecord?.status, 'RUNNING')
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------
// No verification port: not a success; APPLIED is resumable for verification only
// ---------------------------------------------------------------------------------------------------------------------------------

test('without a verification port a completed load is APPLIED_UNVERIFIED, never OK, and the record stays APPLIED', async () => {
  // Mutation named: return 'OK' when ports.verify is absent (the old behaviour) -> this arm is red.
  const { prepared, db, options } = setup()
  const result = await runLoad(prepared, db.ports({ verify: undefined }), options())
  assert.equal(result.exit, 'APPLIED_UNVERIFIED')
  assert.notEqual(result.exit as string, 'OK')
  assert.match(result.problems.join(' '), /no verification port/)
  assert.equal(db.journalRecord?.status, 'APPLIED')
  assert.equal(result.verification.length, 0)
  assert.ok(result.steps.every((s) => s.status === 'DONE'), 'the load itself finished')
})

test('control: with a verification port the same load is OK and VERIFIED', async () => {
  const { prepared, db, options } = setup()
  const result = await runLoad(prepared, db.ports({ verify: async () => [{ id: 'x', result: 'pass', expected: 'a', actual: 'a' }] }), options())
  assert.equal(result.exit, 'OK')
  assert.equal(db.journalRecord?.status, 'VERIFIED')
  assert.equal(result.verification.length, 1)
})

test('resume on an APPLIED run sends nothing and, without a verification port, writes nothing and says APPLIED_UNVERIFIED again', async () => {
  // Mutation named: leave APPLIED out of the resumable path -> "not resumable" refusal; run the steps again -> importer calls here.
  const { prepared, db, options } = setup()
  await runLoad(prepared, db.ports({ verify: undefined }), options())
  const calls = db.executed.length
  const version = db.journalRecord!.version
  const again = await runLoad(prepared, db.ports({ verify: undefined }), options({ resume: true }))
  assert.equal(again.exit, 'APPLIED_UNVERIFIED')
  assert.equal(db.executed.length, calls, 'no importer call')
  assert.equal(db.journalRecord!.version, version, 'the run record was not written')
  assert.equal(db.journalRecord!.status, 'APPLIED')
})

test('resume on an APPLIED run with a verification port runs ONLY the verification, and records the verdict', async () => {
  for (const verdict of ['pass', 'fail'] as const) {
    const { prepared, db, options } = setup()
    await runLoad(prepared, db.ports({ verify: undefined }), options())
    const calls = db.executed.length
    let verified = 0
    const resumed = await runLoad(prepared, db.ports({ verify: async () => { verified++; return [{ id: 'check', result: verdict, expected: 'a', actual: verdict === 'pass' ? 'a' : 'b' }] } }), options({ resume: true }))
    assert.equal(verified, 1)
    assert.equal(db.executed.length, calls, `${verdict}: no importer call`)
    assert.equal(resumed.exit, verdict === 'pass' ? 'OK' : 'VERIFY_FAILED')
    assert.equal(db.journalRecord!.status, verdict === 'pass' ? 'VERIFIED' : 'VERIFY_FAILED')
  }
})

test('resume on an APPLIED run whose data has since changed is a CONFLICT and verifies nothing', async () => {
  const { prepared, db, options } = setup()
  await runLoad(prepared, db.ports({ verify: undefined }), options())
  const supplier = db.entries.get('suppliers')![0]
  supplier.fingerprint = '{"changed":true}'
  let verified = 0
  const resumed = await runLoad(prepared, db.ports({ verify: async () => { verified++; return [] } }), options({ resume: true }))
  assert.equal(resumed.exit, 'CONFLICT')
  assert.equal(verified, 0)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Problem text carries no data key
// ---------------------------------------------------------------------------------------------------------------------------------

test('a conflict found under the lock is reported as a closed code and a count: no supplier name, SKU, stock pair or order reference is in any problem, error or finding string', async (t) => {
  // Mutation named: put the first conflicting key back into the problem sentence (the old text) -> this arm is red for every step.
  let examined = 0
  for (const stepId of ['suppliers', 'products', 'opening-stock', 'purchase-orders'] as const) {
    const { prepared, db, options } = setup()
    const target = prepared.steps.find((s) => s.step === stepId)!
    const seededKey = target.units[0]!.key
    const real = db.ports()
    const reads = new Map<string, number>()
    const ports = {
      ...real,
      // The first read (the plan) is clean; the read under the lock finds a different row for the first key of this step.
      observe: async (step: typeof stepId) => {
        reads.set(step, (reads.get(step) ?? 0) + 1)
        const observed = await real.observe(step)
        if (step === stepId && (reads.get(step) ?? 0) >= 2) {
          return { ...observed, entries: [{ key: seededKey, collisionKey: seededKey.toUpperCase(), fingerprint: '{"other":"value"}', recipe: null }, ...observed.entries.filter((e) => e.key !== seededKey)] }
        }
        return observed
      },
    }
    const result = await runLoad(prepared, ports, options())
    assert.equal(result.exit, 'CONFLICT', `${stepId}: ${result.problems.join('; ')}`)
    const strings = [...result.problems, ...result.steps.flatMap((s) => [s.error ?? '', ...s.counterFindings, ...s.importer.flatMap((i) => i.errors.map((e) => `${e.code}`))])]
    const parts = seededKey.split('|')
    for (const text of strings) {
      for (const part of [seededKey, ...parts]) assert.ok(!text.toLowerCase().includes(part.toLowerCase()), `${stepId}: a string carries the key ${part}: ${text}`)
    }
    assert.match(result.problems.join(' '), /1 conflict\(s\): FIELDS_DIFFER x1/)
    // The key IS in the controlled place: the conflict report.
    assert.ok(result.steps.some((s) => s.conflicts.some((c) => c.key === seededKey)), `${stepId}: the conflict list names the key`)
    examined++
  }
  precondition(t, 'steps examined', examined)
})

test('a rehearsal verdict that is not OK is refused with a fixed message: nothing the report supplied is echoed', () => {
  const { prepared, rehearsal } = setup()
  const marker = 'MARKER-SUPPLIED-VALUE'
  for (const verdict of [marker, { nested: marker }, 7, null]) {
    const problems = checkRehearsalGate({ ...rehearsal, verdict }, { manifestDigest: prepared.manifestDigest, systemId: 'sys-1', now: NOW, maxAgeHours: 24 })
    assert.ok(problems.includes('the rehearsal verdict is missing or is not OK'))
    assert.ok(!problems.join(';').includes(marker))
  }
})

test('an importer result without the system outcome ends the step FAILED and journals it, even when the database read-back matches the file; the step\'s second file is never sent', async () => {
  // Mutation named: let the executor return normally after such a result -> the core sends file 2 and (the rows being there) marks the step DONE: red.
  const { prepared, db, options } = setup()
  // The suppliers step in two prepared chunks, so there are two residual files.
  const split: typeof prepared = { ...prepared, steps: prepared.steps.map((st) => (st.step !== 'suppliers' ? st : { ...st, data: { ...st.data, rows: st.data.rows.map((r, i) => ({ ...r, chunk: i % 2 === 0 ? 1 : 2 })) } })) }
  const sent: string[] = []
  const real = db.ports()
  const ports = db.ports({
    execute: async (step, file, lock) => {
      sent.push(`${step}:${file.name}`)
      if (step !== 'suppliers') return real.execute(step, file, lock)
      await real.execute(step, file, lock) // the rows ARE written ...
      throw Object.assign(new Error('ImporterIgnoredSystemContext'), { name: 'ImporterIgnoredSystemContext' }) // ... and then the executor refuses the result
    },
  })
  const result = await runLoad(split, ports, options())
  assert.equal(result.exit, 'STEP_FAILED')
  assert.deepEqual(sent, ['suppliers:residual-suppliers-001.csv'], 'file 2 and the later steps were never sent')
  const step = result.steps.find((s) => s.step === 'suppliers')!
  assert.equal(step.status, 'FAILED')
  assert.deepEqual(step.importer[0].errors, [{ code: 'EXCEPTION', row: null }])
  assert.equal(db.journalRecord?.steps.suppliers?.status, 'FAILED')
})
