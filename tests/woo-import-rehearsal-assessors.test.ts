import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { StepResult, TeardownResult } from '@/lib/ops/first-install-rehearsal'
import {
  ABANDONED_STATUSES,
  DECIDED_IMPORT_STATUSES,
  REHEARSAL_NOT_PROVEN_STATEMENT,
  REHEARSAL_STAMP_STATEMENT,
  WOO_IMPORT_EXIT,
  WOO_IMPORT_EXIT_MEANING,
  WOO_STEP_CATALOGUE,
  assessIdempotency,
  assessLanding,
  assessNoStampAfterRehearsal,
  assessPassComplete,
  assessR4,
  assessR9,
  assessReadOnly,
  assessRealStamp,
  assessStatusSelection,
  wooImportExitCode,
  type ImportedOrderFact,
  type PassFacts,
  type StoreOrderFact,
} from '@/lib/ops/woo-import-rehearsal'

const REPO = process.cwd()

// ---------------------------------------------------------------------------------------------
// The shared fixtures of this file: a store of four orders and what IMS holds for them.
// ---------------------------------------------------------------------------------------------

const store = (): StoreOrderFact[] => [
  { id: 1, status: 'processing', currency: 'GBP', total: '60.00', fxPerGbp: 1, expectation: 'imports' },
  { id: 2, status: 'on-hold', currency: 'EUR', total: '75.00', fxPerGbp: 1.25, expectation: 'imports' },
  { id: 3, status: 'processing', currency: 'USD', total: '20.00', fxPerGbp: 1, expectation: 'fails-to-import' },
  { id: 9, status: 'cancelled', currency: 'GBP', total: '12.00', fxPerGbp: 1, expectation: 'abandoned-by-status' },
]

const imported = (over: Partial<ImportedOrderFact> & { externalOrderId: number }): ImportedOrderFact => ({
  salesOrderId: `so-${over.externalOrderId}`,
  status: 'PROCESSING',
  currency: 'GBP',
  totalForeign: 60,
  totalBase: 60,
  subtotalForeign: 45,
  taxForeign: 9,
  shippingForeign: 6,
  orderLevelDiscountForeign: 0,
  lineTotalForeignSum: 45,
  lineCount: 1,
  linesWithoutProduct: 0,
  hasCustomer: true,
  ...over,
})

const goodImported = (): ImportedOrderFact[] => [
  imported({ externalOrderId: 1 }),
  // EUR 75.00 at 1.25 per GBP is GBP 60.00; parts: 56.25 + 11.25 + 7.5 - 0 = 75
  imported({ externalOrderId: 2, currency: 'EUR', totalForeign: 75, totalBase: 60, subtotalForeign: 56.25, taxForeign: 11.25, shippingForeign: 7.5, lineTotalForeignSum: 56.25 }),
]

const retry = new Set([3])
const run = (over: Partial<Parameters<typeof assessR9>[0]> = {}) =>
  assessR9({ store: store(), imported: goodImported(), selectedStatuses: ['processing', 'on-hold', 'pending'], retryRecorded: retry, ...over })

// ---------------------------------------------------------------------------------------------
// R9
// ---------------------------------------------------------------------------------------------

test('R9: the control passes, and the precondition it examined is printed', () => {
  const result = run()
  console.log(`precondition: expected=${result.expectedCount} imported=${result.importedCount} knownBad=${result.knownBadCount} rows=${result.rows.length}`)
  assert.equal(result.assessment.ok, true, result.assessment.failures.join('; '))
  assert.equal(result.expectedCount, 3, 'three orders sit in the selected statuses (one of them a declared known-bad probe)')
  assert.equal(result.importedCount, 2)
  assert.equal(result.knownBadCount, 1)
})

test('R9 COUNT is exact: one order missing from IMS is RED and is named', () => {
  const result = run({ imported: goodImported().slice(0, 1) })
  assert.equal(result.assessment.ok, false)
  assert.deepEqual(result.missing, [2])
  assert.match(result.assessment.failures.join(' '), /not in IMS: 2/)
})

test('R9 VALUE: the tolerance is a boundary, per order, in the order currency AND in GBP AND between the order\'s parts', () => {
  const at = (over: Partial<ImportedOrderFact>) => run({ imported: [imported({ externalOrderId: 1, ...over }), goodImported()[1]!] })
  assert.equal(at({ totalForeign: 60.01, taxForeign: 9.01 }).assessment.ok, true, 'exactly one hundredth out (and consistent parts) is ON the boundary and inside the tolerance')
  assert.equal(at({ totalForeign: 60.01 }).assessment.ok, true, 'one hundredth out with parts one hundredth out of step is also on the boundary')
  assert.equal(at({ totalForeign: 60.02, taxForeign: 9.02 }).assessment.ok, false, 'two hundredths is outside it')
  assert.equal(at({ totalBase: 60.02 }).assessment.ok, false, 'the GBP side is judged on its own')
  assert.equal(at({ taxForeign: 9.05 }).assessment.ok, false, 'the order\'s parts must add up to its total even when the stated total matches')
  assert.deepEqual(at({ totalBase: 60.02 }).overTolerance, [1])
})

test('R9 VALUE: widening the tolerance is what lets a wrong total through (the tolerance is live)', () => {
  const wrong = [imported({ externalOrderId: 1, totalForeign: 61, totalBase: 61, taxForeign: 10 }), goodImported()[1]!]
  assert.equal(run({ imported: wrong }).assessment.ok, false)
  assert.equal(run({ imported: wrong, tolerance: 5 }).assessment.ok, true, 'with a tolerance of 5 the same wrong total passes: this is the arm the mutation of R9_VALUE_TOLERANCE turns red')
})

test('R9: a known-bad probe that imported anyway, an order outside the selected statuses, a probe with no retry row, and an empty store are each RED', () => {
  assert.match(run({ imported: [...goodImported(), imported({ externalOrderId: 3 })] }).assessment.failures.join(' '), /known to fail imported anyway/)
  assert.match(run({ imported: [...goodImported(), imported({ externalOrderId: 9 })] }).assessment.failures.join(' '), /outside the selected statuses are in IMS: 9/)
  assert.match(run({ retryRecorded: new Set() }).assessment.failures.join(' '), /no durable retry row.*3/)
  assert.match(run({ store: [], imported: [] }).assessment.failures.join(' '), /proves nothing/)
})

test('R9: the status an order was abandoned for is the reason printed, and an abandoned order has no retry expectation', () => {
  const row = run().rows.find((r) => r.externalOrderId === 9)!
  assert.equal(row.outcome, 'not-imported')
  assert.match(row.reason ?? '', /status cancelled is not selected/)
  assert.equal(row.retryRecorded, null)
})

// ---------------------------------------------------------------------------------------------
// R4
// ---------------------------------------------------------------------------------------------

test('R4: reserved equals allocated within 0.0001; a mismatch, no rows, or nothing reserved is RED', () => {
  const rows = [
    { productId: 'a', sku: 'A', warehouseId: 'w', reservedQty: 5, allocationSum: 5 },
    { productId: 'b', sku: 'B', warehouseId: 'w', reservedQty: 3, allocationSum: 3.00005 },
  ]
  const ok = assessR4(rows)
  console.log(`precondition: rows=${ok.rowsChecked} withReservations=${ok.rowsWithReservations}`)
  assert.equal(ok.assessment.ok, true)
  assert.equal(assessR4([{ ...rows[0]!, allocationSum: 4.9 }, rows[1]!]).assessment.ok, false)
  assert.equal(assessR4([rows[0]!, { ...rows[1]!, allocationSum: 3.0002 }]).assessment.ok, false, 'just outside the tolerance')
  assert.equal(assessR4([]).assessment.ok, false)
  assert.equal(assessR4([{ productId: 'a', sku: 'A', warehouseId: 'w', reservedQty: 0, allocationSum: 0 }]).assessment.ok, false, 'examining nothing is not a pass')
})

// ---------------------------------------------------------------------------------------------
// Read-only proof
// ---------------------------------------------------------------------------------------------

const get = (path: string, over: Partial<{ method: string; modelled: boolean; authenticated: boolean }> = {}) => ({ method: 'GET', path, modelled: true, status: 200, authenticated: true, ...over })
const noRefusals = { woocommerce: 0, mintsoft: 0, xero: 0 }

test('READ-ONLY: GET-only traffic with no refusals passes, and the routes are tallied', () => {
  const result = assessReadOnly({ requests: [get('/wp-json/wc/v3/orders'), get('/wp-json/wc/v3/orders'), get('/wp-json/wc/v3/orders/12/refunds')], holdRefusals: noRefusals })
  console.log(`precondition: ${result.totalRequests} requests ${JSON.stringify(result.byRoute)}`)
  assert.equal(result.assessment.ok, true)
  assert.deepEqual(result.byRoute, { 'GET /wp-json/wc/v3/orders': 2, 'GET /wp-json/wc/v3/orders/{id}/refunds': 1 })
})

test('READ-ONLY: a POST, PUT, DELETE or PATCH is RED (each method, on its own)', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const result = assessReadOnly({ requests: [get('/wp-json/wc/v3/orders'), get('/wp-json/wc/v3/webhooks', { method })], holdRefusals: noRefusals })
    assert.equal(result.assessment.ok, false, method)
    assert.equal(result.nonGet.length, 1)
    assert.match(result.assessment.failures.join(' '), new RegExp(`${method} /wp-json/wc/v3/webhooks`))
  }
})

test('READ-ONLY: HEAD is a read; no traffic at all, an unmodelled route, a missing credential, and a hold refusal are each RED', () => {
  assert.equal(assessReadOnly({ requests: [get('/wp-json/wc/v3/orders', { method: 'HEAD' })], holdRefusals: noRefusals }).assessment.ok, true)
  assert.equal(assessReadOnly({ requests: [], holdRefusals: noRefusals }).assessment.ok, false, 'a store that saw nothing proves nothing')
  assert.equal(assessReadOnly({ requests: [get('/wp-json/wc/v3/products', { modelled: false })], holdRefusals: noRefusals }).assessment.ok, false)
  assert.equal(assessReadOnly({ requests: [get('/wp-json/wc/v3/orders', { authenticated: false })], holdRefusals: noRefusals }).assessment.ok, false)
  assert.equal(assessReadOnly({ requests: [get('/wp-json/wc/v3/orders')], holdRefusals: { ...noRefusals, woocommerce: 2 } }).assessment.ok, false, 'a refused write is a write attempt')
  assert.equal(assessReadOnly({ requests: [get('/wp-json/wc/v3/orders')], holdRefusals: { ...noRefusals, xero: null } }).assessment.ok, false, 'an unreadable refusal count is not zero')
})

// ---------------------------------------------------------------------------------------------
// Stamp
// ---------------------------------------------------------------------------------------------

const none = { completed: null, cursor: null }

test('STAMP: a rehearsal that left both keys absent passes; either key written, the flag set, or an already-stamped start is RED', () => {
  assert.equal(assessNoStampAfterRehearsal({ before: none, after: none, stampedFlag: false }).ok, true)
  assert.equal(assessNoStampAfterRehearsal({ before: none, after: { completed: 'true', cursor: null }, stampedFlag: false }).ok, false)
  assert.equal(assessNoStampAfterRehearsal({ before: none, after: { completed: null, cursor: '2026-10-08T00:00:00Z' }, stampedFlag: false }).ok, false)
  assert.equal(assessNoStampAfterRehearsal({ before: none, after: none, stampedFlag: true }).ok, false)
  assert.equal(assessNoStampAfterRehearsal({ before: { completed: 'true', cursor: null }, after: { completed: 'true', cursor: null }, stampedFlag: false }).ok, false, 'a stamp that was already there cannot show the pass wrote none')
})

test('STAMP: a real pass must end complete, report the stamp, and leave "true" and a timestamp', () => {
  const good = { before: none, after: { completed: 'true', cursor: '2026-10-08T13:00:00.000Z' }, stampedFlag: true, outcome: 'complete' }
  assert.equal(assessRealStamp(good).ok, true)
  assert.equal(assessRealStamp({ ...good, outcome: 'failed' }).ok, false)
  assert.equal(assessRealStamp({ ...good, after: { completed: 'true', cursor: null } }).ok, false)
  assert.equal(assessRealStamp({ ...good, after: { completed: 'yes', cursor: good.after.cursor } }).ok, false)
  assert.equal(assessRealStamp({ ...good, stampedFlag: false }).ok, false)
})

// ---------------------------------------------------------------------------------------------
// Pass, idempotency, statuses, landing
// ---------------------------------------------------------------------------------------------

const pass = (over: Partial<PassFacts> = {}): PassFacts => ({ outcome: 'complete', imported: 125, skipped: 0, errors: [], unrecordedRefusals: 0, statuses: ['on-hold', 'pending', 'processing'], ...over })

test('PASS: complete with no error passes; a failed pass, an unrecorded refusal, or an error the fixtures did not declare is RED', () => {
  assert.equal(assessPassComplete(pass(), []).ok, true)
  assert.equal(assessPassComplete(pass({ errors: ['Order #5010: Missing GBP FX rate'] }), [5010]).ok, true, 'a declared probe may fail')
  assert.equal(assessPassComplete(pass({ errors: ['Order #5011: boom'] }), [5010]).ok, false)
  assert.equal(assessPassComplete(pass({ outcome: 'failed' }), []).ok, false)
  assert.equal(assessPassComplete(pass({ unrecordedRefusals: 1 }), []).ok, false)
})

test('IDEMPOTENCY: a second pass that imports nothing and creates nothing passes; each deviation is RED', () => {
  const base = { first: pass(), second: pass({ imported: 0, skipped: 125, errors: ['Order #5010: x'] }), ordersAfterFirst: 125, ordersAfterSecond: 125, linesAfterFirst: 140, linesAfterSecond: 140, knownBadCount: 1 }
  assert.equal(assessIdempotency(base).ok, true)
  assert.equal(assessIdempotency({ ...base, second: pass({ imported: 3, skipped: 122, errors: ['Order #5010: x'] }) }).ok, false, 'a second pass that imports')
  assert.equal(assessIdempotency({ ...base, ordersAfterSecond: 126 }).ok, false, 'an order created')
  assert.equal(assessIdempotency({ ...base, linesAfterSecond: 141 }).ok, false, 'a line created')
  assert.equal(assessIdempotency({ ...base, first: pass({ imported: 0 }) }).ok, false, 'nothing to be idempotent about')
  assert.equal(assessIdempotency({ ...base, second: pass({ imported: 0, skipped: 10, errors: ['Order #5010: x'] }) }).ok, false, 'the second pass did not skip what the first imported')
})

test('STATUS SELECTION: exactly the owner decision passes; a missing, extra or abandoned status is RED', () => {
  assert.equal(assessStatusSelection(['processing', 'pending', 'on-hold']).ok, true)
  assert.equal(assessStatusSelection(['processing']).ok, false, 'the default selection is processing alone')
  assert.equal(assessStatusSelection(['processing', 'pending', 'on-hold', 'completed']).ok, false)
  for (const abandoned of ABANDONED_STATUSES) assert.equal(assessStatusSelection([...DECIDED_IMPORT_STATUSES, abandoned]).ok, false, abandoned)
})

test('LANDING (OD-4): eligible orders allocated by the mechanisms pass; stock alone allocating, a stuck eligible order, or nothing waiting is RED; an ON_HOLD order is reported, not failed', () => {
  const facts = {
    beforeLanding: ['10', '11', '12'],
    afterLandingBeforeTrigger: ['10', '11', '12'],
    afterBackorderAllocator: ['12'],
    afterSweep: ['12'],
    statusByOrder: { '10': 'PROCESSING', '11': 'ALLOCATED', '12': 'ON_HOLD' },
  }
  const ok = assessLanding(facts)
  console.log(`precondition: waiting=${facts.beforeLanding.length} pickedUp=${ok.pickedUp.length} notPickedUp=${JSON.stringify(ok.notPickedUp)}`)
  assert.equal(ok.assessment.ok, true, ok.assessment.failures.join('; '))
  assert.deepEqual(ok.pickedUp, ['10', '11'])
  assert.deepEqual(ok.notPickedUp, [{ orderNumber: '12', imsStatus: 'ON_HOLD' }])

  assert.equal(assessLanding({ ...facts, afterSweep: ['10', '12'] }).assessment.ok, false, 'an eligible order still waiting')
  assert.equal(assessLanding({ ...facts, afterLandingBeforeTrigger: ['11', '12'] }).assessment.ok, false, 'stock alone allocated order 10: the later stages would prove nothing')
  assert.equal(assessLanding({ ...facts, beforeLanding: ['12'], afterLandingBeforeTrigger: ['12'], afterBackorderAllocator: ['12'], afterSweep: ['12'] }).assessment.ok, false, 'no eligible order waited: nothing was proved')
})

// ---------------------------------------------------------------------------------------------
// Verdict and exit codes
// ---------------------------------------------------------------------------------------------

const step = (over: Partial<StepResult>): StepResult => ({ id: 'seed', item: 0, title: 't', required: true, status: 'passed', detail: {}, durationMs: 1, ...over })
const clean: TeardownResult = { clusterStopped: true, postmasterPid: 1, envFileShredded: true, rootRemoved: true, orphanPids: [], errors: [] }

test('VERDICT: green only when every required step passed and the teardown is clean; teardown trouble outranks red', () => {
  assert.equal(wooImportExitCode([step({})], clean), WOO_IMPORT_EXIT.OK)
  assert.equal(wooImportExitCode([step({ status: 'failed' })], clean), WOO_IMPORT_EXIT.RED)
  assert.equal(wooImportExitCode([step({ status: 'skipped' })], clean), WOO_IMPORT_EXIT.RED)
  assert.equal(wooImportExitCode([step({})], clean, 'SIGTERM'), WOO_IMPORT_EXIT.RED)
  assert.equal(wooImportExitCode([step({ status: 'failed' })], { ...clean, envFileShredded: false }), WOO_IMPORT_EXIT.TEARDOWN_INCOMPLETE)
})

test('the step catalogue lists every step once, prerequisites first, in the order the script runs them', () => {
  const ids = WOO_STEP_CATALOGUE.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids.slice(0, 3), ['migrate-deploy', 'seed', 'prepare'])
  assert.ok(ids.indexOf('rehearsal-import') < ids.indexOf('status-selection'), 'the status list is read from the pass')
  assert.ok(ids.indexOf('idempotent-second-pass') < ids.indexOf('real-pass-stamps'), 'the real pass runs after the rehearsal passes')
  assert.equal(ids.at(-1), 'invariant-preflight')
})

// ---------------------------------------------------------------------------------------------
// Docs: single-sourced operator text and the one exit-code table
// ---------------------------------------------------------------------------------------------

const docs = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
const section = (() => {
  const start = docs.indexOf('## WooCommerce initial-import rehearsal')
  assert.notEqual(start, -1, 'docs/installation.md must have the "WooCommerce initial-import rehearsal" section')
  const next = docs.indexOf('\n## ', start + 5)
  return docs.slice(start, next === -1 ? undefined : next)
})()

test('the exit-code table in docs/installation.md is exactly WOO_IMPORT_EXIT (universal, both directions)', () => {
  const start = section.indexOf('### Exit codes')
  assert.notEqual(start, -1)
  const rest = section.slice(start + 5)
  const end = rest.indexOf('\n#')
  const table = rest.slice(0, end === -1 ? undefined : end)
  const rows = [...table.matchAll(/^\| (\d+) \| ([^|]+) \|$/gm)].map((m) => [Number(m[1]), m[2]!.trim()] as const)
  console.log(`precondition: ${rows.length} table rows parsed`)
  assert.equal(rows.length, Object.keys(WOO_IMPORT_EXIT_MEANING).length)
  for (const [code, meaning] of rows) assert.equal(meaning, (WOO_IMPORT_EXIT_MEANING as Record<number, string>)[code], `exit ${code}`)
  for (const [code, meaning] of Object.entries(WOO_IMPORT_EXIT_MEANING)) assert.ok(rows.some(([c, m]) => c === Number(code) && m === meaning), `exit ${code} is documented`)
})

test('the docs carry the stamp and not-proven statements verbatim from the module, and never say a rehearsal writes the stamp', () => {
  assert.ok(section.includes(REHEARSAL_STAMP_STATEMENT), 'stamp statement verbatim')
  assert.ok(section.includes(REHEARSAL_NOT_PROVEN_STATEMENT), 'not-proven statement verbatim')
  // Universal absence: no sentence in the section claims a rehearsal stamps or moves the cursor.
  const claims = section.split(/(?<=[.!?])\s+/).filter((sentence) => /rehearsal (pass )?(writes|sets|stamps|moves)\b/i.test(sentence) && !/never|not|neither/i.test(sentence))
  console.log(`absence check: ${section.split(/(?<=[.!?])\s+/).length} sentences scanned, ${claims.length} offending`)
  assert.deepEqual(claims, [])
})

test('the docs name the npm script and every step title in the catalogue', () => {
  assert.ok(section.includes('npm run rehearse:woo-import'))
  const missing = WOO_STEP_CATALOGUE.filter((s) => !section.includes(s.title)).map((s) => s.id)
  assert.deepEqual(missing, [])
})

test('the package.json script exists and points at the script', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['rehearse:woo-import'], 'tsx scripts/rehearse-woo-import.ts')
})
