import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { memoisedInvariant, runItems, type ItemRunner, type LivenessPort, type RunPlan, type StreamReadings } from '../../lib/reconciliation-pack/run.ts'
import { type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { NOW, cleanup, passItem, scratchDir } from './helpers.ts'

const bases: string[] = []
afterEach(() => cleanup(bases))

const STAMP = '2026-10-19T03:00:00.000Z'
const clean = { ok: true, result: { status: 'completed', errors: [], criticalFindings: [], summary: { total: { critical: 0, warning: 0 } }, reports: Object.fromEntries(['inventory', 'accounting', 'sales'].map((d) => [d, { findings: [], truncated: false, nextCursor: null, summary: { total: 0, info: 0, warning: 0, critical: 0 } }])) } }

function plan(over: Partial<RunPlan> & { invariant?: () => Promise<unknown> } = {}): RunPlan {
  const { invariant, ...rest } = over
  return {
    phase: 'P1', asOf: '2026-10-19', selected: null,
    context: { phase: 'P1', asOf: '2026-10-19', now: () => NOW, acceptances: parseAcceptanceFile(null), invariant: memoisedInvariant(invariant ?? (async () => clean)) },
    ...rest,
  }
}
const outcome = (items: Array<{ id: string; outcome: string; reasons: readonly string[] }>, id: string) => items.find((i) => i.id === id)!

test('P0: R3, R4 and R15 pass from a clean report and every other item is not-applicable, so the run exits 0', async () => {
  const dir = scratchDir(bases)
  const { items, streams } = await runItems(plan({ phase: 'P0', context: { ...plan().context, phase: 'P0' } }))
  assert.deepEqual(items.filter((i) => i.outcome === 'pass').map((i) => i.id), ['R3', 'R4', 'R15'])
  assert.ok(items.filter((i) => !['R3', 'R4', 'R15'].includes(i.id)).every((i) => i.outcome === 'not-applicable' && i.reasons[0] === 'PHASE_NOT_APPLICABLE'))
  const published = publishPackReport(dir, { runId: '20261020T120000Z-aaaaaaaaaaaa', systemIdentifier: '7000000000000000001', phase: 'P0', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items })
  assert.ok(published.ok && published.exitCode === 0)
})

test('P1: items with no runner are inconclusive NO_RUNNER with nothing listed, and the run exits 5, never 0', async () => {
  const dir = scratchDir(bases)
  const { items, streams } = await runItems(plan())
  assert.deepEqual(items.filter((i) => i.outcome === 'pass').map((i) => i.id), ['R3', 'R4', 'R15'])
  for (const id of ['R1', 'R2', 'R5', 'R6', 'R9', 'R10', 'R12', 'R13', 'R14']) assert.deepEqual([outcome(items, id).outcome, outcome(items, id).reasons], ['inconclusive', ['NO_RUNNER']], id)
  for (const id of ['R7', 'R8', 'R11']) assert.equal(outcome(items, id).outcome, 'not-applicable', id)
  const published = publishPackReport(dir, { runId: '20261020T120000Z-aaaaaaaaaaaa', systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items })
  assert.ok(published.ok && published.exitCode === 5)
})

test('--items: an item that is not asked for is NOT_SELECTED (inconclusive), an item the phase does not apply stays not-applicable, and the exit is not 0', async () => {
  const { items } = await runItems(plan({ selected: ['R3'] }))
  assert.equal(outcome(items, 'R3').outcome, 'pass')
  for (const id of ['R4', 'R15', 'R1', 'R6']) assert.deepEqual([outcome(items, id).outcome, outcome(items, id).reasons], ['inconclusive', ['NOT_SELECTED']], id)
  assert.equal(outcome(items, 'R7').outcome, 'not-applicable')
  const p0 = await runItems(plan({ phase: 'P0', selected: ['R3'], context: { ...plan().context, phase: 'P0' } }))
  assert.deepEqual(p0.items.filter((i) => i.outcome !== 'not-applicable').map((i) => [i.id, i.outcome]), [['R3', 'pass'], ['R4', 'inconclusive'], ['R15', 'inconclusive']])
})

test('the invariant report is run ONCE for the three items; a run that throws makes all three inconclusive and is not retried', async () => {
  let calls = 0
  const ok = await runItems(plan({ invariant: async () => { calls += 1; return clean } }))
  assert.equal(calls, 1)
  assert.equal(ok.items.filter((i) => i.outcome === 'pass').length, 3)
  calls = 0
  const bad = await runItems(plan({ invariant: async () => { calls += 1; throw new Error('db down') } }))
  assert.equal(calls, 1)
  for (const id of ['R3', 'R4', 'R15']) assert.deepEqual([outcome(bad.items, id).outcome, outcome(bad.items, id).reasons], ['inconclusive', ['SOURCE_UNREADABLE']], id)
})

// ---- stream-dependent items ---------------------------------------------------------------------

const fresh = (stamp = STAMP) => ({ state: 'fresh' as const, lastSuccess: stamp })
const liveness = (...reads: Array<StreamReadings | Error>): LivenessPort => {
  let n = 0
  return { async read() { const r = reads[Math.min(n++, reads.length - 1)]!; if (r instanceof Error) throw r; return r } }
}
const ALL_FRESH: StreamReadings = Object.fromEntries(['woocommerce-order-sweep', 'mintsoft-stock-sync', 'mintsoft-dispatch-poll', 'mintsoft-order-status', 'xero-balance-snapshots', 'xero-tax-rates'].map((s) => [s, fresh()]))
const r6Passes: Partial<Record<PackItemId, ItemRunner>> = { R6: async () => passItem('R6') }
const streamPlan = (port: LivenessPort | undefined) => plan({ liveness: port, runners: r6Passes, selected: ['R6'] })

test('a stream-dependent pass is kept only with a fresh stamp at the start and the SAME stamp at the end', async () => {
  const kept = await runItems(streamPlan(liveness({ 'xero-balance-snapshots': fresh() }, { 'xero-balance-snapshots': fresh() })))
  assert.equal(outcome(kept.items, 'R6').outcome, 'pass')
  assert.deepEqual(kept.streams, [{ stream: 'xero-balance-snapshots', start: STAMP, end: STAMP }])
  const moved = await runItems(streamPlan(liveness({ 'xero-balance-snapshots': fresh() }, { 'xero-balance-snapshots': fresh('2026-10-19T04:00:00.000Z') })))
  assert.deepEqual([outcome(moved.items, 'R6').outcome, outcome(moved.items, 'R6').reasons], ['inconclusive', ['BASIS_MOVED']])
  // Equality only: a stamp that went BACK is also a moved basis, not "earlier so fine".
  const back = await runItems(streamPlan(liveness({ 'xero-balance-snapshots': fresh() }, { 'xero-balance-snapshots': fresh('2026-10-18T04:00:00.000Z') })))
  assert.equal(outcome(back.items, 'R6').reasons[0], 'BASIS_MOVED')
})

test('a stream that is stale, off, unknown, missing, malformed, unreadable or has no reader at all is STALE_BASIS, and the runner is not even run', async () => {
  let ran = 0
  const counting: Partial<Record<PackItemId, ItemRunner>> = { R6: async () => { ran += 1; return passItem('R6') } }
  const cases: Array<[string, LivenessPort | undefined]> = [
    ['no reader', undefined],
    ['stale', liveness({ 'xero-balance-snapshots': { state: 'stale', lastSuccess: STAMP } })],
    ['off', liveness({ 'xero-balance-snapshots': { state: 'off', lastSuccess: STAMP } })],
    ['unknown', liveness({ 'xero-balance-snapshots': { state: 'unknown', lastSuccess: null } })],
    ['missing stream', liveness({})],
    ['fresh without a stamp', liveness({ 'xero-balance-snapshots': { state: 'fresh', lastSuccess: null } })],
    ['malformed stamp', liveness({ 'xero-balance-snapshots': { state: 'fresh', lastSuccess: 'yesterday' } })],
    ['reader throws', liveness(new Error('boom'))],
  ]
  for (const [name, port] of cases) {
    const { items } = await runItems(plan({ liveness: port, runners: counting, selected: ['R6'] }))
    assert.deepEqual([outcome(items, 'R6').outcome, outcome(items, 'R6').reasons], ['inconclusive', ['STALE_BASIS']], name)
  }
  assert.equal(ran, 0)
  // Stale only at the END: the result is dropped.
  const late = await runItems(streamPlan(liveness({ 'xero-balance-snapshots': fresh() }, { 'xero-balance-snapshots': { state: 'stale', lastSuccess: STAMP } })))
  assert.equal(outcome(late.items, 'R6').reasons[0], 'STALE_BASIS')
})

// ---- a misbehaving runner -----------------------------------------------------------------------

test('a runner that throws, names another item, or returns something the report refuses is INTERNAL_ERROR for that item only', async () => {
  const runners: Partial<Record<PackItemId, ItemRunner>> = {
    R1: async () => { throw new Error('secret value') },
    R2: async () => passItem('R5'),
    R5: async () => ({ id: 'R5', outcome: 'pass', reasons: [] }), // a pass with no proof and no sources
    R9: async () => ({ id: 'R9', outcome: 'pass', reasons: ['DIFFERENCES'], proof: { kind: 'compared' }, sources: ['ims-database', 'woocommerce-api'] }),
    R13: async () => ({ id: 'R13', outcome: 'pass', reasons: [], proof: { kind: 'proven-empty', source: 'vendor-total-zero' }, sources: ['woocommerce-api', 'xero-api'], entries: { onlyIms: [{ key: 'A1', ims: null, vendor: null, delta: null }] } }),
  }
  const { items } = await runItems(plan({ runners, liveness: liveness(ALL_FRESH) }))
  for (const id of ['R1', 'R2', 'R5', 'R9', 'R13']) assert.deepEqual([outcome(items, id).outcome, outcome(items, id).reasons], ['inconclusive', ['INTERNAL_ERROR']], id)
  assert.equal(outcome(items, 'R3').outcome, 'pass', 'the others are untouched')
  assert.ok(!JSON.stringify(items).includes('secret value'))
})

test('a runner cannot loosen its own test: a pass the report refuses never reaches a published pass', async () => {
  const dir = scratchDir(bases)
  const runners: Partial<Record<PackItemId, ItemRunner>> = { R1: async () => ({ id: 'R1', outcome: 'pass', reasons: [], proof: { kind: 'compared' }, sources: ['ims-database', 'mintsoft-api'] }) }
  const { items, streams } = await runItems(plan({ runners, selected: ['R1'], liveness: liveness({ 'mintsoft-stock-sync': fresh() }, { 'mintsoft-stock-sync': fresh() }) }))
  assert.equal(outcome(items, 'R1').outcome, 'inconclusive', 'compared with nothing equal is refused')
  const published = publishPackReport(dir, { runId: '20261020T120000Z-aaaaaaaaaaaa', systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items })
  assert.ok(published.ok && published.exitCode === 5)
})
