/**
 * The orchestration: plan (read only), apply, resume. Everything runs against an in-memory "database" whose importer behaves like the real ones
 * where it matters (it refuses a key that already exists, it can crash between row transactions, it can create a product and silently drop its recipe).
 * Each arm names what it proves; the honest control (a clean full apply) runs first and every refusal arm asserts that NO importer call was made.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { REHEARSAL_RECORD_FORMAT_VERSION } from '../../lib/first-load/apply/constants.ts'
import { runLoad, type ApplyOptions, type ApplyResult, type RunRecord } from '../../lib/first-load/apply/orchestrate.ts'
import { ObservationError } from '../../lib/first-load/apply/residual.ts'
import { buildApplyReport, renderApplyJson, renderApplyMarkdown } from '../../lib/first-load/apply/report.ts'
import { FakeDatabase, loadOk, prepareSynthetic, preparedFiles } from './apply-helpers.ts'
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
    assert.equal(db.journalRecord?.status, 'APPLIED')
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
  runs.push(await runLoad(a.prepared, a.db.ports({ execute: async (step, file) => { const r = await a.db.ports().execute(step, file); return step === 'suppliers' ? { ...r, errors: [`Row 7: order ${SECRET_FILE_VALUE} already exists`, `unexpected ${SECRET_EXCEPTION}`] } : r } }), a.options()))
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
  assert.match(finished.problems[0], /APPLIED, which is not resumable/)
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
  assert.equal(db.journalRecord?.status, 'APPLIED')
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
      const answer = await db.ports().execute(step, file)
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
