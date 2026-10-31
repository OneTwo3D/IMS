import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import test, { after } from 'node:test'

import { differenceSignature, type CarriedDifference } from '../../lib/reconciliation-pack/compare.ts'
import { PACK_ITEM_CATALOGUE } from '../../lib/reconciliation-pack/constants.ts'
import { defaultItems, newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { ReportInvalid, buildReport, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { carriedStateFromChain, unusableCarriedState } from '../../lib/reconciliation-pack/settling.ts'
import { readPackChain, type ChainResult } from '../../lib/reconciliation-pack/trend.ts'
import { runVendorItem } from '../../lib/reconciliation-pack/vendor-items.ts'
import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { memoisedInvariant, runItems, type LivenessPort, type RunPlan } from '../../lib/reconciliation-pack/run.ts'
import { reduceStatusReport } from '../../lib/reconciliation-pack/liveness.ts'
import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { D, fakeBasisPort, goodState } from './basis-fixtures.ts'
import { goodReport, withStamp } from './liveness-fixtures.ts'
import { fakeStore, order } from './woo-fixtures.ts'
import { NOW, allBrackets, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { S1, S2, S3, S4, carryFrom, r9Context, runR9Once } from './settling-fixtures.ts'

/**
 * D7: SETTLING FOR R9 (R1 settles too; see settling-r1.test.ts). A difference first seen is unsettled and fails only after two LATER successful runs of the order sweep
 * stream, counted from the pack's own trusted reports. Mutations are listed in the PR.
 */

const bases: string[] = []
after(() => cleanup(bases))
const SID = '7000000000000000001'
const WHERE = { phase: 'P1' as const, systemIdentifier: SID }

const lacking = () => r9Context([{ n: 1, wooId: '11' }, { n: 2, wooId: '12' }], [{ id: 11 }]) // IMS has 12, the store does not: onlyIms 12
const equal = () => r9Context([{ n: 1, wooId: '11' }], [{ id: 11 }])
const keysOf = (item: ItemInput, bucket: string) => ((item.entries as Record<string, Array<{ key: string }>> | undefined)?.[bucket] ?? []).map((e) => e.key)
const shape = (item: ItemInput) => [item.outcome, [...item.reasons]] as const

// ---- the semantics, run to run (in memory) -----------------------------------------------------------------------------------------

// [mutation: PENDING_PERSISTENCE_RUNS counted as 1 / a difference failing on first sight / the second later run not required]
test('FIRST SEEN is unsettled (inconclusive UNSETTLED_PENDING, no finding); still there after ONE further stream run is unsettled; after TWO it fails', async () => {
  const one = await runR9Once(lacking(), new Map(), S1)
  assert.deepEqual(shape(one), ['inconclusive', ['UNSETTLED_PENDING']])
  assert.deepEqual(keysOf(one, 'unsettled'), ['12'])
  assert.deepEqual(keysOf(one, 'onlyIms'), [], 'not a finding yet')
  const two = await runR9Once(lacking(), carryFrom(one), S2)
  assert.deepEqual(shape(two), ['inconclusive', ['UNSETTLED_PENDING']])
  assert.deepEqual((two.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: 1, first: S1, later: [S2] })
  const three = await runR9Once(lacking(), carryFrom(two), S3)
  assert.deepEqual(shape(three), ['fail', ['DIFFERENCES']])
  assert.deepEqual(keysOf(three, 'onlyIms'), ['12'])
  assert.deepEqual(keysOf(three, 'unsettled'), [])
  // and it stays a failure while it is there, on any stamp
  const four = await runR9Once(lacking(), carryFrom(three), S4)
  assert.deepEqual(shape(four), ['fail', ['DIFFERENCES']])
})

// [mutation: a repeated stamp counted / the first stamp counted as a later run / the stamp not compared at all]
test('NO NEW STREAM RUN (the stamp is unchanged) does not count, however many times the pack runs', async () => {
  let carried: ReadonlyMap<string, CarriedDifference> = new Map()
  for (let n = 0; n < 6; n += 1) {
    const item = await runR9Once(lacking(), carried, S1)
    assert.deepEqual(shape(item), ['inconclusive', ['UNSETTLED_PENDING']], `run ${n}`)
    carried = carryFrom(item)
  }
  const second = await runR9Once(lacking(), carried, S2)
  const repeat = await runR9Once(lacking(), carryFrom(second), S2)
  assert.equal(repeat.outcome, 'inconclusive', 'S2 seen twice counts once')
  assert.equal((await runR9Once(lacking(), carryFrom(repeat), S3)).outcome, 'fail')
})

// [mutation: stamps ordered / a stamp that looks older refused / a later stamp required to be newer]
test('STAMPS ARE COMPARED BY EQUALITY ONLY: an older-looking stamp is a distinct run and counts', async () => {
  const a = await runR9Once(lacking(), new Map(), S4)
  const b = await runR9Once(lacking(), carryFrom(a), S2)
  assert.equal(b.outcome, 'inconclusive')
  assert.equal((await runR9Once(lacking(), carryFrom(b), S1)).outcome, 'fail', 'S4, then S2, then S1: three distinct values')
  // but a value already counted (even the first) never counts again, whatever it looks like
  const c = await runR9Once(lacking(), carryFrom(b), S4)
  assert.equal(c.outcome, 'inconclusive')
  assert.equal((await runR9Once(lacking(), carryFrom(c), S2)).outcome, 'inconclusive')
})

// [mutation: the carried state not dropped for an identity that is gone / a healed difference kept]
test('A DIFFERENCE THAT DISAPPEARS is settled: it is no longer listed, nothing is carried, and if it returns it starts again', async () => {
  const one = await runR9Once(lacking(), new Map(), S1)
  const two = await runR9Once(lacking(), carryFrom(one), S2)
  const healed = await runR9Once(equal(), carryFrom(two), S3)
  assert.deepEqual(shape(healed), ['pass', []])
  assert.equal(carryFrom(healed).size, 0)
  const back = await runR9Once(lacking(), carryFrom(healed), S4)
  assert.deepEqual(shape(back), ['inconclusive', ['UNSETTLED_PENDING']])
  assert.deepEqual((back.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: null, first: S4, later: [] })
})

// [mutation: the signature (values, currencies) left out of the identity / the kind left out of it]
test('A VALUE THAT CHANGES between runs is a NEW first-seen difference, not a continuation; so is a change of kind', async () => {
  const ims = [{ n: 1, wooId: '11', total: '20.00' }]
  const one = await runR9Once(r9Context(ims, [{ id: 11, total: '25.00' }]), new Map(), S1)
  const two = await runR9Once(r9Context(ims, [{ id: 11, total: '25.00' }]), carryFrom(one), S2)
  assert.deepEqual((two.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: 1, first: S1, later: [S2] }, 'the same values continue')
  const changed = await runR9Once(r9Context(ims, [{ id: 11, total: '26.00' }]), carryFrom(two), S3)
  assert.deepEqual(shape(changed), ['inconclusive', ['UNSETTLED_PENDING']], 'the vendor total moved: not matured, even on the third distinct stamp')
  assert.deepEqual((changed.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: null, first: S3, later: [] })
  // the IMS value moving does the same
  const imsMoved = await runR9Once(r9Context([{ n: 1, wooId: '11', total: '21.00' }], [{ id: 11, total: '26.00' }]), carryFrom(changed), S4)
  assert.deepEqual((imsMoved.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: null, first: S4, later: [] })
  // a pair that becomes one-sided is another kind
  const side = await runR9Once(r9Context([{ n: 1, wooId: '11', total: '21.00' }], []), carryFrom(imsMoved), S1)
  assert.deepEqual((side.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: null, first: S1, later: [] })
  assert.notEqual(differenceSignature('bothDiffer', { ims: '1', vendor: '2', imsCurrency: 'GBP', vendorCurrency: 'GBP' }), differenceSignature('bothDiffer', { ims: '1', vendor: '2', imsCurrency: 'GBP', vendorCurrency: 'EUR' }))
})

// [mutation: carried identities judged in sorted order with the rest]
test('CARRIED IDENTITIES ARE RE-CHECKED FIRST: they are listed ahead of every identity first seen now', async () => {
  const some = r9Context([{ n: 1, wooId: '90' }], [])
  const first = await runR9Once(some, new Map(), S1)
  const both = r9Context([{ n: 1, wooId: '90' }, { n: 2, wooId: '12' }, { n: 3, wooId: '30' }], [])
  const second = await runR9Once(both, carryFrom(first), S2)
  assert.deepEqual(keysOf(second, 'unsettled'), ['90', '12', '30'], '90 sorts last but was carried, so it is first')
  const none = await runR9Once(both, new Map(), S2)
  assert.deepEqual(keysOf(none, 'unsettled'), ['12', '30', '90'])
})

// [mutation: SETTLING_STATE_UNUSABLE not added / a difference settled although the state was unusable]
test('UNUSABLE CARRIED STATE: every difference is first seen, whatever the stamps, the item says so, and it is never a pass and never settled', async () => {
  let last: ItemInput | null = null
  for (const stamp of [S1, S2, S3, S4, S1, S2]) {
    last = await runR9Once(lacking(), new Map(), stamp, false)
    assert.deepEqual(shape(last), ['inconclusive', ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']], stamp)
    assert.deepEqual((last.entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: null, first: stamp, later: [] })
  }
  // nothing to carry and nothing wrong: unusable state with no difference is a plain pass (the claim holds)
  assert.deepEqual(shape(await runR9Once(equal(), new Map(), S1, false)), ['pass', []])
})

// [mutation: R9 passes while something is unsettled / a persisted difference beside a new one dropped]
test('R9 PASSES ONLY WITH NO CURRENT DIFFERENCE: a settled difference beside a new one fails and lists both; unsettled alone is inconclusive', async () => {
  const one = await runR9Once(lacking(), new Map(), S1)
  const two = await runR9Once(lacking(), carryFrom(one), S2)
  const withNew = r9Context([{ n: 1, wooId: '11' }, { n: 2, wooId: '12' }, { n: 3, wooId: '13' }], [{ id: 11 }])
  const three = await runR9Once(withNew, carryFrom(two), S3)
  assert.deepEqual(shape(three), ['fail', ['DIFFERENCES', 'UNSETTLED_PENDING']])
  assert.deepEqual([keysOf(three, 'onlyIms'), keysOf(three, 'unsettled')], [['12'], ['13']])
  assert.equal(three.proof, null)
})

// [mutation: the settling input made optional for R9 (a difference failing at once without a stamp)]
test('R9 WITHOUT THE RUN\'S SETTLING INPUT is inconclusive STALE_BASIS: it never falls back to failing at once, and R13 does not settle', async () => {
  const noInput = await runVendorItem('R9', lacking())
  assert.deepEqual(shape(noInput), ['inconclusive', ['STALE_BASIS']])
  const noStamp = await runR9Once(lacking(), new Map(), null)
  assert.deepEqual(shape(noStamp), ['inconclusive', ['STALE_BASIS']])
  assert.deepEqual(PACK_ITEM_CATALOGUE.filter((spec) => spec.settles).map((spec) => spec.id), ['R1', 'R9'], 'only R1 and R9 opt in')
  for (const spec of PACK_ITEM_CATALOGUE.filter((candidate) => candidate.settles)) assert.ok(spec.streams.length > 0, 'an item that settles has a stream whose stamp it counts')
})

// ---- the chain: what may be carried, from where -----------------------------------------------------------------------------------

type Run = { item: ItemInput; sequence: number }
async function publishRun(dir: string, context: ReturnType<typeof lacking>, stamp: string, over: { phase?: 'P1' | 'P2'; sid?: string; brackets?: ReportInput['streams']; items?: ItemInput[]; build?: { maxLinesPerItem?: number } } = {}): Promise<Run> {
  const chain = readPackChain(dir)
  const state = carriedStateFromChain(chain, 'R9', { phase: over.phase ?? 'P1', systemIdentifier: over.sid ?? SID })
  const item = await runR9Once(context, state.carried, stamp, state.usable)
  const phase = over.phase ?? 'P1'
  const published = publishPackReport(dir, {
    runId: newRunId(new Date(NOW.getTime() + 1000 * (chain.ok ? chain.reports.length : 0))), systemIdentifier: over.sid ?? SID, phase, asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
    streams: over.brackets ?? allBrackets(stamp), items: over.items ?? defaultItems(phase, { R9: item }),
  }, over.build ? { build: over.build } : {})
  assert.equal(published.ok, true, JSON.stringify(published))
  return { item, sequence: published.ok ? published.record.sequence : 0 }
}
const head = (dir: string) => { const chain = readPackChain(dir); assert.equal(chain.ok, true); return (chain as Extract<ChainResult, { ok: true }>).head! }
const r9 = (dir: string) => head(dir).record.items.find((entry) => entry.id === 'R9')!

// [mutation: carried state read from anywhere but the chain / a persisted failure forgotten between reports]
test('THROUGH THE REAL CHAIN: first sight, one further run, two further runs (fail), and the failure stays; the first-seen sequence is the report that saw it', async () => {
  const dir = scratchDir(bases)
  await publishRun(dir, lacking(), S1)
  assert.deepEqual([r9(dir).outcome, r9(dir).reasons], ['inconclusive', ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']], 'no previous report: nothing to carry, and it says so')
  assert.deepEqual(head(dir).settling.map((line) => [line.bucket, line.entry.key, line.entry.settling]), [['unsettled', '12', { sequence: 1, first: S1, later: [], count: 0 }]])
  await publishRun(dir, lacking(), S2)
  assert.deepEqual([r9(dir).outcome, r9(dir).reasons], ['inconclusive', ['UNSETTLED_PENDING']], 'the previous report is usable now')
  assert.deepEqual(head(dir).settling.map((line) => line.entry.settling), [{ sequence: 1, first: S1, later: [S2], count: 1 }])
  await publishRun(dir, lacking(), S3)
  assert.deepEqual([r9(dir).outcome, r9(dir).reasons], ['fail', ['DIFFERENCES']])
  assert.deepEqual(head(dir).settling.map((line) => [line.bucket, line.entry.settling]), [['onlyIms', { sequence: 1, first: S1, later: [S2, S3], count: 2 }]], 'the failing entry keeps its state')
  await publishRun(dir, lacking(), S4)
  assert.deepEqual([r9(dir).outcome, r9(dir).reasons], ['fail', ['DIFFERENCES']], 'and keeps failing')
  assert.equal(head(dir).record.sequence, 4)
})

// [mutation: the same stamp counted across reports]
test('through the chain, an unchanged stamp is no progress and a difference that heals is dropped from the next report', async () => {
  const dir = scratchDir(bases)
  await publishRun(dir, lacking(), S1)
  await publishRun(dir, lacking(), S1)
  await publishRun(dir, lacking(), S1)
  assert.deepEqual(head(dir).settling.map((line) => line.entry.settling), [{ sequence: 1, first: S1, later: [], count: 0 }])
  await publishRun(dir, equal(), S2)
  assert.deepEqual([r9(dir).outcome, head(dir).settling.length], ['pass', 0])
})

test('NO CARRIED STATE from an untrusted directory, a broken chain, no previous report, another phase, another installation', async () => {
  // an untrusted directory: group- and other-writable
  const open = scratchDir(bases)
  await publishRun(open, lacking(), S1)
  chmodSync(open, 0o777)
  const refused = readPackChain(open)
  assert.equal(refused.ok, false)
  assert.deepEqual(carriedStateFromChain(refused, 'R9', WHERE), unusableCarriedState())
  chmodSync(open, 0o700)
  // every refusal code the chain reader can give
  for (const code of ['FORK', 'GAP', 'LINK_BROKEN', 'PAIR_INVALID', 'SYSTEM_MISMATCH', 'DIR_UNTRUSTED', 'DIR_UNREADABLE', 'TOO_MANY'] as const) {
    assert.deepEqual(carriedStateFromChain({ ok: false, code, runId: null }, 'R9', WHERE), unusableCarriedState(), code)
  }
  // no previous report
  const none = scratchDir(bases)
  assert.deepEqual(carriedStateFromChain(readPackChain(none), 'R9', WHERE), unusableCarriedState())
  // a good chain, used under its own phase and installation, and not otherwise
  const dir = scratchDir(bases)
  await publishRun(dir, lacking(), S1)
  const chain = readPackChain(dir)
  assert.equal(carriedStateFromChain(chain, 'R9', WHERE).usable, true)
  assert.equal(carriedStateFromChain(chain, 'R9', WHERE).carried.size, 1)
  assert.deepEqual(carriedStateFromChain(chain, 'R9', { phase: 'P2', systemIdentifier: SID }), unusableCarriedState(), 'another phase')
  assert.deepEqual(carriedStateFromChain(chain, 'R9', { phase: 'P1', systemIdentifier: '7000000000000000002' }), unusableCarriedState(), 'another installation')
  // an item that does not settle has no state to carry
  assert.deepEqual(carriedStateFromChain(chain, 'R13', WHERE), unusableCarriedState())
})

// [mutation: a report whose item was not compared to the end used / a capped report used / an unstable bracket used]
test('A PREVIOUS REPORT THAT DOES NOT CARRY THE STATE IN THE EXACT SHAPE is not used: not compared, capped, unstable bracket, entries that do not add up', async () => {
  const stale: ItemInput = { id: 'R9', outcome: 'inconclusive', reasons: ['STALE_BASIS'] }
  const dir = scratchDir(bases)
  await publishRun(dir, lacking(), S1, { items: defaultItems('P1', { R9: stale }) })
  assert.deepEqual(carriedStateFromChain(readPackChain(dir), 'R9', WHERE), unusableCarriedState(), 'inconclusive for another reason')

  // a capped listing: the entries that were cut are unknown
  const capped = scratchDir(bases)
  const many = r9Context(Array.from({ length: 12 }, (_, i) => ({ n: i + 1, wooId: String(100 + i) })), [])
  await publishRun(capped, many, S1, { build: { maxLinesPerItem: 5 } })
  assert.ok(r9(capped).reasons.includes('CAP_EXCEEDED'))
  assert.deepEqual(carriedStateFromChain(readPackChain(capped), 'R9', WHERE), unusableCarriedState())

  // a bracket that moved: the stream stamp changed between the start and the end read of that report
  const moved = scratchDir(bases)
  await publishRun(moved, lacking(), S1, { brackets: allBrackets(S1).map((b) => (b.stream === 'woocommerce-order-sweep' ? { ...b, end: S2 } : b)) })
  assert.deepEqual(carriedStateFromChain(readPackChain(moved), 'R9', WHERE), unusableCarriedState())

  // entries that do not add up to the item's own counts (a state lost, or one that belongs to nothing)
  const good = scratchDir(bases)
  await publishRun(good, lacking(), S1)
  const chain = readPackChain(good) as Extract<ChainResult, { ok: true }>
  const lost = { ...chain, head: { ...chain.head!, settling: [] } }
  assert.deepEqual(carriedStateFromChain(lost, 'R9', WHERE), unusableCarriedState())
  const extra = { ...chain, head: { ...chain.head!, settling: [...chain.head!.settling, { ...chain.head!.settling[0]!, entry: { ...chain.head!.settling[0]!.entry, key: '99' } }] } }
  assert.deepEqual(carriedStateFromChain(extra, 'R9', WHERE), unusableCarriedState())
  const doubled = { ...chain, head: { ...chain.head!, settling: [chain.head!.settling[0]!, chain.head!.settling[0]!] } }
  assert.deepEqual(carriedStateFromChain(doubled, 'R9', WHERE), unusableCarriedState())
})

// ---- the report refuses malformed settling state ------------------------------------------------------------------------------------

function reportWith(items: ItemInput[], sequence = 3, over: Partial<ReportInput> = {}) {
  return buildReport({ runId: newRunId(NOW), systemIdentifier: SID, phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: allBrackets(S1), items, ...over }, sequence, '0'.repeat(64))
}
const solo = (key: string, settling?: unknown): never => ({ key, ims: '5', vendor: null, delta: null, imsCurrency: 'GBP', ...(settling === undefined ? {} : { settling }) }) as never
const unsettledR9 = (entry: unknown, reasons: ItemInput['reasons'] = ['UNSETTLED_PENDING']): ItemInput => ({ id: 'R9', outcome: 'inconclusive', reasons, entries: { unsettled: [entry as never] } })
const failedR9 = (entry: unknown): ItemInput => ({ id: 'R9', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [entry as never] } })
const withR9 = (r: ItemInput) => defaultItems('P1', { R9: r })

// [mutation: any one of these checks removed from the builder or the reader]
test('THE REPORT BUILDER REFUSES MALFORMED SETTLING STATE, each with its own case', () => {
  const ok = { sequence: 2, first: S1, later: [S2], count: 1 }
  assert.doesNotThrow(() => reportWith(withR9(unsettledR9(solo('12', ok)))))
  const refuse = (label: string, items: ItemInput[], sequence = 3) => assert.throws(() => reportWith(items, sequence), ReportInvalid, label)
  refuse('count is not the number of later stamps', withR9(unsettledR9(solo('12', { ...ok, count: 2 }))))
  refuse('count below the number of later stamps', withR9(unsettledR9(solo('12', { ...ok, count: 0 }))))
  refuse('count above the number of later stamps', withR9(unsettledR9(solo('12', { sequence: 2, first: S1, later: [], count: 1 }))))
  refuse('first seen in a report that does not exist yet, nothing counted', withR9(unsettledR9(solo('12', { sequence: 4, first: S1, later: [], count: 0 }))))
  refuse('a later stamp equal to the first', withR9(unsettledR9(solo('12', { ...ok, later: [S1] }))))
  refuse('the same later stamp twice', withR9(unsettledR9(solo('12', { sequence: 1, first: S1, later: [S2, S2], count: 2 }))))
  refuse('a bad stamp', withR9(unsettledR9(solo('12', { ...ok, later: ['soon'] }))))
  refuse('a bad first-seen sequence (zero)', withR9(unsettledR9(solo('12', { ...ok, sequence: 0 }))))
  refuse('a first-seen sequence of a report that does not exist yet', withR9(unsettledR9(solo('12', { ...ok, sequence: 4 }))))
  refuse('later runs counted but first seen in THIS report', withR9(unsettledR9(solo('12', { sequence: 3, first: S1, later: [S2], count: 1 }))))
  refuse('an unsettled entry that has already persisted', withR9(unsettledR9(solo('12', { sequence: 1, first: S1, later: [S2, S3], count: 2 }))))
  refuse('an extra field', withR9(unsettledR9(solo('12', { ...ok, extra: 1 }))))
  refuse('a failing entry of R9 with no settling state', withR9(failedR9(solo('12'))))
  refuse('a failing entry that has not persisted', withR9(failedR9(solo('12', ok))))
  assert.doesNotThrow(() => reportWith(withR9(failedR9(solo('12', { sequence: 1, first: S1, later: [S2, S3], count: 2 })))))
  // an item that does not settle carries no settling on a failing entry
  refuse('settling on a failing entry of an item that does not settle', defaultItems('P1', { R3: { id: 'R3', outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [solo('A|MAIN', { sequence: 1, first: S1, later: [S2, S3], count: 2 })] } } }))
  // SETTLING_STATE_UNUSABLE: only with something unsettled, only on a first sight in this very report, only on an item that settles
  const first = { sequence: 3, first: S1, later: [] as string[], count: 0 }
  assert.doesNotThrow(() => reportWith(withR9(unsettledR9(solo('12', first), ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']))))
  refuse('UNUSABLE beside a continuation', withR9(unsettledR9(solo('12', ok), ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE'])))
  refuse('UNUSABLE with nothing unsettled', withR9({ id: 'R9', outcome: 'inconclusive', reasons: ['STALE_BASIS', 'SETTLING_STATE_UNUSABLE'] }))
  refuse('UNUSABLE on an item that does not settle', defaultItems('P1', { R3: unsettledOn('R3', solo('A|MAIN', first), ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']) }))
  refuse('a pass with something unsettled', withR9({ ...unsettledR9(solo('12', first)), outcome: 'pass', reasons: [], proof: { kind: 'compared' } }))
  refuse('an unsettled entry with no settling state', withR9(unsettledR9(solo('12'))))
})
function unsettledOn(id: 'R3', entry: unknown, reasons: ItemInput['reasons']): ItemInput {
  return { id, outcome: 'inconclusive', reasons, entries: { unsettled: [entry as never] } }
}

// ---- the run: which stamp is counted, and what is handed in ----------------------------------------------------------------------

/** A liveness port whose order-sweep stamp is whatever `stamps` says for each successive read. */
function sweepLiveness(...stamps: string[]): LivenessPort {
  let n = 0
  return { read: async () => reduceStatusReport(withStamp(goodReport(), 'woocommerce-order-sweep', stamps[Math.min(n++, stamps.length - 1)]!)) }
}
function vendorPlan(context: ReturnType<typeof lacking>, liveness: LivenessPort, carried?: RunPlan['carried']): RunPlan {
  return {
    phase: 'P1', asOf: '2026-10-19', selected: ['R9'], liveness, basis: fakeBasisPort(goodState()), carried,
    context: { phase: 'P1', asOf: '2026-10-19', now: () => NOW, acceptances: parseAcceptanceFile(null), invariant: memoisedInvariant(async () => realEvidence()), vendorReads: true, vendor: context.vendor, ims: context.ims, wooOptions: context.wooOptions },
  }
}
// Stamps the liveness reducer accepts as fresh against its report clock (2026-10-20T12:00): the code under test never orders them.
const L1 = '2026-10-20T01:00:00.000Z'
const L2 = '2026-10-20T02:00:00.000Z'
const L3 = '2026-10-20T03:00:00.000Z'
const L4 = '2026-10-20T04:00:00.000Z'
const r9Of = (items: ItemInput[]) => items.find((i) => i.id === 'R9')!

// [mutation: the stamp taken from the END read / the carried state not passed / the stamp not taken from the published bracket]
test('RUN: the stamp counted is the one the START read saw (the published bracket\'s), the carried state is handed in, and a stamp that moved counts for nothing', async () => {
  const stable = await runItems(vendorPlan(lacking(), sweepLiveness(L1, L1)))
  assert.deepEqual(shape(r9Of(stable.items)), ['inconclusive', ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']], 'no carried state given: first seen, and it says so')
  assert.deepEqual((r9Of(stable.items).entries!.unsettled![0] as { settling?: { first: string } }).settling?.first, L1)
  assert.deepEqual(stable.streams.find((b) => b.stream === 'woocommerce-order-sweep'), { stream: 'woocommerce-order-sweep', start: L1, end: L1 })

  const carried = { R9: { usable: true, carried: carryFrom(await runR9Once(lacking(), new Map(), L1)) } }
  const next = await runItems(vendorPlan(lacking(), sweepLiveness(L2, L2), carried))
  assert.deepEqual(shape(r9Of(next.items)), ['inconclusive', ['UNSETTLED_PENDING']])
  assert.deepEqual((r9Of(next.items).entries!.unsettled![0] as { settling?: unknown }).settling, { sequence: 1, first: L1, later: [L2] })
  const final = await runItems(vendorPlan(lacking(), sweepLiveness(L3, L3), { R9: { usable: true, carried: carryFrom(r9Of(next.items)) } }))
  assert.deepEqual(shape(r9Of(final.items)), ['fail', ['DIFFERENCES']])

  // the stream ran during the pack's own read: start L2, end L3. The run is BASIS_MOVED, lists nothing and counts for nothing.
  const moved = await runItems(vendorPlan(lacking(), sweepLiveness(L2, L3), carried))
  assert.deepEqual(shape(r9Of(moved.items)), ['inconclusive', ['BASIS_MOVED']])
  assert.equal(r9Of(moved.items).entries, undefined)
  // a stale stream is not counted either
  const stale = await runItems(vendorPlan(lacking(), { read: async () => ({ ok: false }) }, carried))
  assert.deepEqual(shape(r9Of(stale.items)), ['inconclusive', ['SOURCE_UNREADABLE']])
})

// [mutation: an item that does not settle handed a settling input / R9 run without the catalogue flag]
test('RUN: only an item whose catalogue row settles is handed a settling input', async () => {
  const seen: Array<[string, unknown]> = []
  const base = vendorPlan(lacking(), sweepLiveness(L1))
  await runItems({ ...base, selected: ['R3', 'R9'], runners: { R3: async (c) => { seen.push(['R3', c.settling]); return { id: 'R3', outcome: 'inconclusive', reasons: ['SOURCE_UNREADABLE'] } }, R9: async (c) => { seen.push(['R9', c.settling]); return { id: 'R9', outcome: 'inconclusive', reasons: ['SOURCE_UNREADABLE'] } } } })
  assert.deepEqual(seen.find(([id]) => id === 'R3')?.[1], undefined)
  assert.deepEqual(seen.find(([id]) => id === 'R9')?.[1], { carried: new Map(), usable: false, stamp: L1 })
})

// ---- the whole command ---------------------------------------------------------------------------------------------------------

const cliBases: string[] = []
after(() => cleanup(cliBases))
function cliRig(stampOf: () => string, storeIds: number[]) {
  const imsOrders = [11, 12].map((n) => ({ id: `c${String(n).padStart(24, '0')}`, status: 'PROCESSING', currency: 'GBP', total: '12.50', created: '2026-10-10T09:30:00.000Z', updated: null }))
  const sent: string[] = []
  const client: ImsQueryClient = {
    async query(sql) {
      sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: 'on' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/FROM sales_orders/.test(sql)) return { rows: imsOrders.map((o) => ({ ...o })) }
      if (/FROM shopping_order_links/.test(sql)) return { rows: imsOrders.map((o, i) => ({ order_id: o.id, connector: 'woocommerce', external_id: String(11 + i) })) }
      return { rows: [] }
    },
  }
  const woo = fakeStore({ orders: { processing: storeIds.map((id) => order(id)) } })
  const deps: Partial<PackCliDeps> = {
    now: () => NOW, openIms: async () => ({ client, close: async () => undefined }), runInvariant: async () => realEvidence(), disconnect: async () => undefined,
    liveness: { read: async () => reduceStatusReport(withStamp(goodReport(), 'woocommerce-order-sweep', stampOf())) }, basis: fakeBasisPort(goodState()), woo,
  }
  return { deps, woo, sent }
}
async function command(dir: string, stamp: string, storeIds = [11], extra: string[] = []) {
  const rig = cliRig(() => stamp, storeIds)
  const out: string[] = []
  const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', D, '--items', 'R9', '--report-dir', dir, '--vendor-reads-only', ...extra], env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: rig.deps, stdout: (t) => out.push(t), stderr: () => undefined })
  return { code, line: out.find((l) => l.startsWith('R9 ')), rig }
}

// [mutation: the chain not turned into carried state by the command / the carried state read from a stale chain]
test('THE COMMAND: store lacks an order IMS holds - run 1 unsettled, run 2 unsettled, run 3 fails (exit 1), run 4 still fails; an unchanged stamp is no progress; a run that does not compare R9 starts the count again', async () => {
  const dir = scratchDir(cliBases)
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L1)), [5, 'R9 inconclusive UNSETTLED_PENDING,SETTLING_STATE_UNUSABLE'])
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L1)), [5, 'R9 inconclusive UNSETTLED_PENDING'], 'same stamp: the first run again')
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L2)), [5, 'R9 inconclusive UNSETTLED_PENDING'])
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L3)), [1, 'R9 fail DIFFERENCES'])
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L4)), [1, 'R9 fail DIFFERENCES'])
  // the store catches up: the difference is settled and gone
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L1, [11, 12])), [5, 'R9 pass -'])
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L2)), [5, 'R9 inconclusive UNSETTLED_PENDING'], 'and when it returns it starts again, with a usable previous report')
  // a run that did not compare R9 (vendor reads off) leaves nothing to carry: the count starts again and says so
  await command(dir, L3, [11], [])
  const off = runPackCli({ argv: ['--phase', 'P1', '--as-of', D, '--items', 'R9', '--report-dir', dir], env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: cliRig(() => L3, [11]).deps, stdout: () => undefined, stderr: () => undefined })
  assert.equal(await off, 5)
  assert.deepEqual((({ code, line }) => [code, line])(await command(dir, L4)), [5, 'R9 inconclusive UNSETTLED_PENDING,SETTLING_STATE_UNUSABLE'])
})

// ---- a carried stamp is verified against the prior reports of the chain ---------------------------------------------------------------

type OkChain = Extract<ChainResult, { ok: true }>
/** A copy of the chain with one report edited in memory (what a forged, hash-valid report would look like to the carry reader). */
function forge(chain: OkChain, sequence: number, edit: (entry: OkChain['reports'][number]) => void): OkChain {
  const copy = structuredClone(chain)
  edit(copy.reports[sequence - 1]!)
  return { ...copy, head: copy.reports[copy.reports.length - 1]! }
}
async function chainOf(stamps: string[]): Promise<OkChain> {
  const dir = scratchDir(bases)
  for (const stamp of stamps) await publishRun(dir, lacking(), stamp)
  const chain = readPackChain(dir)
  assert.equal(chain.ok, true)
  return chain as OkChain
}
const carriedLater = (chain: OkChain) => [...(carriedStateFromChain(chain, 'R9', WHERE).carried.get('12')?.later ?? [])]

// [mutation: carriedMatchesChain removed / any one of its checks removed]
test('A CARRIED STAMP IS TAKEN ONLY IF THE PRIOR REPORTS BEAR IT OUT: the honest chain is used, every forgery gives no carried state', async () => {
  const two = await chainOf([S1, S2])
  const three = await chainOf([S1, S2, S3])
  assert.deepEqual(carriedLater(two), [S2])
  assert.deepEqual(carriedLater(three), [S2, S3], 'a persisted failure is carried too')
  const unusable = (chain: OkChain, why: string) => assert.deepEqual(carriedStateFromChain(chain, 'R9', WHERE), unusableCarriedState(), why)
  const line = (entry: OkChain['reports'][number]) => entry.settling[0]!

  // the reviewed attack: a sequence-2 report that claims two later stamps (one run counted twice over)
  unusable(forge(two, 2, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [S2, S3], count: 2 } }), 'two stamps added by one report')
  // the claimed stamp is not the one the report's own stream bracket read
  unusable(forge(two, 2, (e) => { e.record.streams = e.record.streams.map((b) => (b.stream === 'woocommerce-order-sweep' ? { ...b, start: S4, end: S4 } : b)) }), 'a later stamp the report did not read')
  unusable(forge(two, 2, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [S4], count: 1 } }), 'a later stamp that is not the bracket start')
  // the stream bracket of the adding report is not stable
  unusable(forge(two, 2, (e) => { e.record.streams = e.record.streams.map((b) => (b.stream === 'woocommerce-order-sweep' ? { ...b, end: S4 } : b)) }), 'an unstable bracket')
  // the first-seen report does not list the identity, or lists it with another first stamp, kind or values
  unusable(forge(two, 1, (e) => { e.settling = [] }), 'the first-seen report does not list it')
  unusable(forge(two, 1, (e) => { line(e).entry.settling = { sequence: 1, first: S3, later: [], count: 0 } }), 'another first stamp')
  unusable(forge(two, 1, (e) => { line(e).entry.ims = '99' }), 'another value (a new difference, not a continuation)')
  unusable(forge(two, 1, (e) => { line(e).entry.imsPresent = false; line(e).entry.vendorPresent = true }), 'another kind')
  unusable(forge(two, 1, (e) => { e.record.streams = e.record.streams.map((b) => (b.stream === 'woocommerce-order-sweep' ? { ...b, start: S4, end: S4 } : b)) }), 'the first stamp is not the first-seen report\'s own bracket')
  // a first-seen report that already counted a later stamp
  unusable(forge(two, 1, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [S2], count: 1 } }), 'later stamps in the first-seen report')
  // the claimed first-seen sequence is wrong
  unusable(forge(two, 2, (e) => { line(e).entry.settling = { sequence: 2, first: S1, later: [S2], count: 1 } }), 'claims the newest report as the first sight but counts a later stamp')
  unusable(forge(two, 2, (e) => { line(e).entry.settling = { sequence: 3, first: S1, later: [], count: 0 } }), 'a first-seen report that does not exist yet')
  // a report in between: not the same installation phase, not compared, shrinking list, a stamp that is not its own
  unusable(forge(three, 2, (e) => { e.record.phase = 'P2' }), 'a report of another phase in between')
  unusable(forge(three, 2, (e) => { e.record.items.find((i) => i.id === 'R9')!.reasons = ['CAP_EXCEEDED'] }), 'a report in between that did not compare the item to the end')
  unusable(forge(three, 2, (e) => { e.settling = [] }), 'a report in between that lacks the identity')
  unusable(forge(three, 2, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [], count: 0 } }), 'a later list that shrinks and grows')
  unusable(forge(three, 2, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [S4], count: 1 } }), 'a list that is not a prefix of the next')
  unusable(forge(three, 3, (e) => { line(e).entry.settling = { sequence: 1, first: S1, later: [S3, S2], count: 2 } }), 'a list that is not a prefix extension')
  unusable(forge(three, 2, (e) => { e.record.systemIdentifier = '7000000000000000002' }), 'a report of another installation in between')
  unusable(forge(three, 2, (e) => { e.record.items.find((i) => i.id === 'R9')!.applicability = 'not-applicable' }), 'a report in between where the item did not apply')
  unusable(forge(three, 2, (e) => { e.settling = [e.settling[0]!, e.settling[0]!] }), 'listed twice in a report in between')
  // two copies of the identity in one report
  unusable(forge(two, 2, (e) => { e.settling = [e.settling[0]!, e.settling[0]!] }), 'listed twice')
})
