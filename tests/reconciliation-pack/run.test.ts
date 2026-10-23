import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import type { AsOfBasis } from '../../lib/reconciliation-pack/basis.ts'
import { bracketLiveness, reduceStatusReport, type LivenessRead } from '../../lib/reconciliation-pack/liveness.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { memoisedInvariant, runItems, type ItemRunner, type LedgerRunner, type LivenessPort, type RunPlan } from '../../lib/reconciliation-pack/run.ts'
import { type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { goodReport, makeStale, withEntry, withStamp } from './liveness-fixtures.ts'
import { NOW, cleanup, passItem, realEvidence, scratchDir } from './helpers.ts'

const bases: string[] = []
afterEach(() => cleanup(bases))

const clean = realEvidence()

function plan(over: Partial<RunPlan> & { invariant?: () => Promise<unknown> } = {}): RunPlan {
  const { invariant, ...rest } = over
  return {
    phase: 'P1', asOf: '2026-10-19', selected: null,
    liveness: healthyLiveness(),
    basis: fakeBasisPort(goodState()),
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

test('P1: R6 passes on a balanced settled basis; R10 is inconclusive without a way to read the postings; items with no runner are NO_RUNNER; the run exits 5, never 0', async () => {
  const dir = scratchDir(bases)
  const { items, streams } = await runItems(plan())
  assert.deepEqual(items.filter((i) => i.outcome === 'pass').map((i) => i.id), ['R3', 'R4', 'R6', 'R15'])
  assert.deepEqual([outcome(items, 'R10').outcome, outcome(items, 'R10').reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  for (const id of ['R1', 'R2', 'R5', 'R9', 'R12', 'R13', 'R14']) assert.deepEqual([outcome(items, id).outcome, outcome(items, id).reasons], ['inconclusive', ['NO_RUNNER']], id)
  for (const id of ['R7', 'R8', 'R11']) assert.equal(outcome(items, id).outcome, 'not-applicable', id)
  assert.deepEqual(streams.map((s) => s.stream), ['xero-balance-snapshots'])
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
  assert.equal(ok.items.filter((i) => ['R3', 'R4', 'R15'].includes(i.id) && i.outcome === 'pass').length, 3)
  calls = 0
  const bad = await runItems(plan({ invariant: async () => { calls += 1; throw new Error('db down') } }))
  assert.equal(calls, 1)
  for (const id of ['R3', 'R4', 'R15']) assert.deepEqual([outcome(bad.items, id).outcome, outcome(bad.items, id).reasons], ['inconclusive', ['SOURCE_UNREADABLE']], id)
})

// ---- the liveness bracket ------------------------------------------------------------------------

const good = () => reduceStatusReport(goodReport())
const STAMP_A = '2026-10-20T00:30:00.000Z'
const STAMP_B = '2026-10-20T06:30:00.000Z'
/** A port that returns the given reads in order (the last one repeats); an Error is thrown. */
const seq = (...reads: Array<LivenessRead | Error>): LivenessPort => {
  let n = 0
  return { async read() { const r = reads[Math.min(n++, reads.length - 1)]!; if (r instanceof Error) throw r; return r } }
}
const r6Passes: Partial<Record<'R6' | 'R10', LedgerRunner>> = { R6: async () => passItem('R6') }
const ledgerPlan = (port: LivenessPort | undefined, over: Partial<RunPlan> = {}) => plan({ liveness: port, ledgerRunners: r6Passes, selected: ['R6'], ...over })

test('a stream-dependent pass is kept only with a fresh stamp at the start and the SAME stamp at the end', async () => {
  const kept = await runItems(ledgerPlan(seq(good(), good())))
  assert.equal(outcome(kept.items, 'R6').outcome, 'pass')
  assert.deepEqual(kept.streams, [{ stream: 'xero-balance-snapshots', start: STAMP_A, end: STAMP_A }])
  const moved = await runItems(ledgerPlan(seq(good(), reduceStatusReport(withStamp(goodReport(), 'xero-balance-snapshots', STAMP_B)))))
  assert.deepEqual([outcome(moved.items, 'R6').outcome, outcome(moved.items, 'R6').reasons], ['inconclusive', ['BASIS_MOVED']])
  // Equality only: a stamp that went BACK is also a moved basis, not "earlier so fine".
  const back = await runItems(ledgerPlan(seq(good(), reduceStatusReport(withStamp(goodReport(), 'xero-balance-snapshots', '2026-10-19T04:00:00.000Z')))))
  assert.equal(outcome(back.items, 'R6').reasons[0], 'BASIS_MOVED')
  assert.equal(back.streams[0]!.end, null, 'a stream that moved is published with no end stamp')
})

test('a stream that is stale, off, never run, missing or ambiguous is STALE_BASIS, and the runner is not even run', async () => {
  let ran = 0
  const counting: Partial<Record<'R6' | 'R10', LedgerRunner>> = { R6: async () => { ran += 1; return passItem('R6') } }
  const off = reduceStatusReport(withEntry(goodReport(), 'xero-balance-snapshots', { state: 'off', lastSuccessAt: null, ageMs: null, maxAgeMs: null }))
  const never = reduceStatusReport(withEntry(goodReport(), 'xero-balance-snapshots', { state: 'never', lastSuccessAt: null, ageMs: null }))
  const missing = reduceStatusReport(goodReport({ entries: goodReport().entries.filter((entry) => entry.stream !== 'xero-balance-snapshots') }))
  const unscheduled = reduceStatusReport(goodReport({ scheduler: { unscheduled: ['account-balance-snapshot'] } }))
  const cases: Array<[string, LivenessRead]> = [['stale', reduceStatusReport(makeStale(goodReport(), 'xero-balance-snapshots'))], ['off', off], ['never', never], ['missing', missing], ['job unscheduled', unscheduled]]
  for (const [name, read] of cases) {
    assert.equal(read.ok, true, `precondition: ${name} is a well-formed report`)
    const { items } = await runItems(plan({ liveness: seq(read), ledgerRunners: counting, selected: ['R6'] }))
    assert.deepEqual([outcome(items, 'R6').outcome, outcome(items, 'R6').reasons], ['inconclusive', ['STALE_BASIS']], name)
  }
  assert.equal(ran, 0)
  // Stale only at the END: the result is dropped.
  const late = await runItems(ledgerPlan(seq(good(), reduceStatusReport(makeStale(goodReport(), 'xero-balance-snapshots')))))
  assert.deepEqual([outcome(late.items, 'R6').outcome, outcome(late.items, 'R6').reasons], ['inconclusive', ['STALE_BASIS']])
})

// [mutation: an item with no dependent stream skips the bracket]
test('EVERY item needs a trusted scheduler and a readable status report, one with no dependent stream (R3) included', async () => {
  let invariantRuns = 0
  const counting = async () => { invariantRuns += 1; return clean }
  const unexamined = reduceStatusReport(goodReport({ scheduler: { examined: false } }))
  const crontabUnreadable = reduceStatusReport(goodReport({ scheduler: { unreadable: 'could not read the crontab' } }))
  const blockProblem = reduceStatusReport(goodReport({ scheduler: { blockProblem: 'edited by hand' } }))
  for (const [name, read] of [['scheduler not examined', unexamined], ['crontab unreadable', crontabUnreadable], ['managed block untrusted', blockProblem]] as const) {
    assert.equal(read.ok, true, `precondition: ${name}`)
    invariantRuns = 0
    const { items } = await runItems(plan({ liveness: seq(read), invariant: counting, selected: ['R3'] }))
    assert.deepEqual([outcome(items, 'R3').outcome, outcome(items, 'R3').reasons], ['inconclusive', ['STALE_BASIS']], name)
    assert.equal(invariantRuns, 0, `${name}: the invariant report was not even run`)
  }
  // Untrusted at the END only: the result is dropped.
  const late = await runItems(plan({ liveness: seq(good(), unexamined), selected: ['R3'] }))
  assert.deepEqual([outcome(late.items, 'R3').outcome, outcome(late.items, 'R3').reasons], ['inconclusive', ['STALE_BASIS']])
  assert.deepEqual(late.streams, [], 'R3 depends on no stream, so no bracket is published for it')
})

// [mutation: a missing or failing liveness reader treated as healthy]
test('liveness that cannot be read - no reader, a throw, a malformed report, a failed END read - makes EVERY item inconclusive SOURCE_UNREADABLE', async () => {
  const malformed = reduceStatusReport({ schemaVersion: 1 })
  assert.deepEqual(malformed, { ok: false })
  const cases: Array<[string, LivenessPort | undefined, number]> = [
    ['no reader', undefined, 0],
    ['the reader throws', seq(new Error('boom')), 0],
    ['a malformed report', seq(malformed), 0],
    ['a contradictory report', seq(reduceStatusReport(withEntry(goodReport(), 'xero-balance-snapshots', { state: 'fresh', ageMs: 1 }))), 0],
    ['the end read fails', seq(good(), new Error('boom')), 1],
    ['the end read is malformed', seq(good(), malformed), 1],
  ]
  for (const [name, port, startReads] of cases) {
    let invariantRuns = 0
    const { items } = await runItems(plan({ liveness: port, invariant: async () => { invariantRuns += 1; return clean } }))
    const attempted = items.filter((i) => ['R3', 'R4', 'R15', 'R6', 'R10'].includes(i.id))
    assert.ok(attempted.every((i) => i.outcome === 'inconclusive' && i.reasons[0] === 'SOURCE_UNREADABLE'), `${name}: ${JSON.stringify(attempted.map((i) => [i.id, i.outcome, i.reasons]))}`)
    assert.ok(!items.some((i) => i.outcome === 'pass'), name)
    if (startReads === 0) assert.equal(invariantRuns, 0, `${name}: nothing ran on a basis nobody could read`)
  }
})

// [mutation: the basis settled before the end read / the ledger item run before the bracket closes]
test('the order of a run: start read, basis read, the items, end read, basis settle, THEN the ledger items - on the settled basis', async () => {
  const events: string[] = []
  const inner = healthyLiveness()
  const liveness: LivenessPort = { read: async () => { events.push('liveness'); return inner.read() } }
  const base = fakeBasisPort(goodState())
  const basis = { read: async (asOf: string) => { events.push('basis.read'); return base.read(asOf) }, settle: async (read: Awaited<ReturnType<typeof base.read>>, bracket: Parameters<typeof base.settle>[1]) => { events.push('basis.settle'); return base.settle(read, bracket) } }
  let seen: AsOfBasis | null = null
  const ledgerRunners: Partial<Record<'R6' | 'R10', LedgerRunner>> = { R6: async (_context, settled) => { events.push('R6'); seen = settled; return passItem('R6') } }
  const runners: Partial<Record<PackItemId, ItemRunner>> = { R3: async () => { events.push('R3'); return passItem('R3') } }
  const { items } = await runItems(plan({ liveness, basis, ledgerRunners, runners, selected: ['R3', 'R6'] }))
  assert.deepEqual(events, ['liveness', 'basis.read', 'R3', 'liveness', 'basis.settle', 'R6'])
  assert.equal(outcome(items, 'R6').outcome, 'pass')
  assert.ok(seen !== null && (seen as AsOfBasis).available === true, 'the ledger runner is handed the settled basis')
})

// [mutation: the settle step skipped, or the unsettled read handed to the runner]
test('the basis: no basis port is an unreadable source; a basis that moved or is missing data is the item\'s inconclusive result, and the runner never sees numbers from it', async () => {
  let ran = 0
  const counting: Partial<Record<'R6' | 'R10', LedgerRunner>> = { R6: async () => { ran += 1; return passItem('R6') } }
  const none = await runItems(plan({ basis: undefined, ledgerRunners: counting, selected: ['R6'] }))
  assert.deepEqual([outcome(none.items, 'R6').outcome, outcome(none.items, 'R6').reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  assert.equal(ran, 0)

  // Stored evidence rewritten between the read inside the bracket and the settle after it.
  const state = goodState()
  const moving = fakeBasisPort(state)
  const basis = { read: moving.read, settle: async (read: Awaited<ReturnType<typeof moving.read>>, bracket: Parameters<typeof moving.settle>[1]) => { state.run = { snapshotCount: 2 }; state.snapshots = [{ valueBase: '1.00', valueReplayReliable: true }, { valueBase: '1.00', valueReplayReliable: true }]; return moving.settle(read, bracket) } }
  const moved = await runItems(plan({ basis }))
  assert.deepEqual([outcome(moved.items, 'R6').outcome, outcome(moved.items, 'R6').reasons], ['inconclusive', ['BASIS_MOVED']])

  const unreliable = await runItems(plan({ basis: fakeBasisPort(goodState({ snapshots: [{ valueBase: '700.25', valueReplayReliable: false }, { valueBase: '500.50', valueReplayReliable: true }] })) }))
  assert.deepEqual([outcome(unreliable.items, 'R6').outcome, outcome(unreliable.items, 'R6').reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  assert.ok(!unreliable.items.some((i) => i.id === 'R6' && i.outcome === 'pass'))
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
  const ledgerRunners: Partial<Record<'R6' | 'R10', LedgerRunner>> = { R6: async () => { throw new Error('secret value') }, R10: async () => passItem('R6') }
  const { items } = await runItems(plan({ runners, ledgerRunners, liveness: seq(reduceStatusReport(goodReport())) }))
  for (const id of ['R1', 'R2', 'R5', 'R9', 'R13', 'R6', 'R10']) assert.deepEqual([outcome(items, id).outcome, outcome(items, id).reasons], ['inconclusive', ['INTERNAL_ERROR']], id)
  assert.equal(outcome(items, 'R3').outcome, 'pass', 'the others are untouched')
  assert.ok(!JSON.stringify(items).includes('secret value'))
})

test('a runner cannot loosen its own test: a pass the report refuses never reaches a published pass', async () => {
  const dir = scratchDir(bases)
  const runners: Partial<Record<PackItemId, ItemRunner>> = { R1: async () => ({ id: 'R1', outcome: 'pass', reasons: [], proof: { kind: 'compared' }, sources: ['ims-database', 'mintsoft-api'] }) }
  const { items, streams } = await runItems(plan({ runners, selected: ['R1'] }))
  assert.equal(outcome(items, 'R1').outcome, 'inconclusive', 'compared with nothing equal is refused')
  const published = publishPackReport(dir, { runId: '20261020T120000Z-aaaaaaaaaaaa', systemIdentifier: '7000000000000000001', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items })
  assert.ok(published.ok && published.exitCode === 5)
})

test('the bracket is a pure function of the two reads: a stream that moved in a way the per-stream stamp shows, on an instance of a per-binding stream', async () => {
  // The Mintsoft stock sync has one entry per binding; one binding moving moves the stream (R1 has a runner stub here).
  const runners: Partial<Record<PackItemId, ItemRunner>> = { R1: async () => ({ id: 'R1', outcome: 'inconclusive', reasons: ['DIFFERENCES'] }) }
  const moved = reduceStatusReport(withStamp(goodReport(), 'mintsoft-stock-sync', STAMP_B, 'OVERFLOW'))
  const { items } = await runItems(plan({ runners, selected: ['R1'], liveness: seq(good(), moved) }))
  assert.deepEqual([outcome(items, 'R1').outcome, outcome(items, 'R1').reasons], ['inconclusive', ['BASIS_MOVED']])
  void bracketLiveness
})
