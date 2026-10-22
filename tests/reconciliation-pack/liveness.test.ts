import assert from 'node:assert/strict'
import test from 'node:test'

import { READ_SYNC_STREAMS, READ_SYNC_STREAM_IDS, type ReadSyncStreamId } from '../../lib/ops/read-sync-liveness-constants.ts'
import { STOCK_SYNC_WATCHDOG_CRON_SLUG, assembleReadSyncReport, type ReadSyncInputs, type ReadSyncReport } from '../../lib/ops/read-sync-status.ts'
import { PACK_ITEM_CATALOGUE, getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import { bracketStable } from '../../lib/reconciliation-pack/compare.ts'
import { ReportInvalid, buildReport } from '../../lib/reconciliation-pack/report.ts'
import {
  WATCHDOG_JOB_SLUG, bracketLiveness, itemLivenessVerdict, publishedStreamBrackets, readLiveness, reduceStatusReport, streamsVerdict, type LivenessRead,
} from '../../lib/reconciliation-pack/liveness.ts'
import { defaultItems } from '../../lib/reconciliation-pack/harness.ts'
import { passItem } from './helpers.ts'
import { GENERATED_AT, STAMP_A, STAMP_B, cleanScheduler, freshEntry, goodReport, makeFuture, makeNever, makeOff, makeStale, recount, withEntry, withStamp, withoutStream } from './liveness-fixtures.ts'

/**
 * THE LIVENESS BRACKET. Every guard below has a mutation (named in the test title) that makes the test fail; the
 * mutations were run by hand against lib/reconciliation-pack/liveness.ts and are listed in the PR.
 */

function read(report: unknown): LivenessRead {
  return reduceStatusReport(report)
}
const ITEMS_WITH_STREAMS = PACK_ITEM_CATALOGUE.filter((spec) => spec.streams.length > 0)
const ITEMS_WITHOUT_STREAMS = PACK_ITEM_CATALOGUE.filter((spec) => spec.streams.length === 0)

test('precondition: the catalogue has items that depend on streams and items that do not, and every stream id is a status stream', () => {
  console.log(`precondition: ${ITEMS_WITH_STREAMS.length} items with streams, ${ITEMS_WITHOUT_STREAMS.length} without`)
  assert.ok(ITEMS_WITH_STREAMS.length >= 6)
  assert.ok(ITEMS_WITHOUT_STREAMS.length >= 5)
  for (const spec of ITEMS_WITH_STREAMS) for (const stream of spec.streams) assert.ok(READ_SYNC_STREAM_IDS.includes(stream))
})

test('a clean bracket lets every item through, with equal stamps and ages and states recorded for both reads', () => {
  const bracket = bracketLiveness(read(goodReport()), read(goodReport()))
  assert.equal(bracket.readable, true)
  for (const spec of PACK_ITEM_CATALOGUE) assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: true }, spec.id)
  const stock = bracket.instances.filter((instance) => instance.stream === 'mintsoft-stock-sync')
  assert.equal(stock.length, 2)
  for (const instance of bracket.instances) {
    assert.equal(instance.stateAtStart, 'fresh')
    assert.equal(instance.stateAtEnd, 'fresh')
    assert.equal(instance.lastSuccessAtStart, STAMP_A)
    assert.equal(instance.lastSuccessAtEnd, STAMP_A)
    assert.equal(instance.ageMsAtStart, 41_400_000)
    assert.equal(instance.ageMsAtEnd, 41_400_000)
    assert.equal(instance.maxAgeMsAtStart, 36 * 3_600_000)
    assert.equal(instance.fresh && instance.stable && instance.inBothReads, true)
  }
  assert.deepEqual(bracket.scheduler.atStart, { examined: true, unreadable: false, blockProblem: false, unscheduled: [], disabled: [] })
})

// [mutation: a state other than `fresh` accepted] each non-fresh state, at EACH read, for EACH dependent stream of each item
for (const spec of ITEMS_WITH_STREAMS) {
  for (const stream of spec.streams) {
    const makers = { stale: makeStale, future: makeFuture, never: makeNever, off: makeOff }
    for (const state of ['stale', 'future', 'never', 'off'] as const) {
      for (const where of ['start', 'end'] as const) {
        test(`${spec.id} on ${stream}: state ${state} at the ${where} read is STALE_BASIS, never a pass`, () => {
          const bad = makers[state](goodReport(), stream)
          const bracket = where === 'start' ? bracketLiveness(read(bad), read(goodReport())) : bracketLiveness(read(goodReport()), read(bad))
          assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: false, reason: 'STALE_BASIS' })
        })
      }
    }
    for (const where of ['start', 'end', 'both'] as const) {
      test(`${spec.id} on ${stream}: no entry at the ${where} read(s) is not fresh`, () => {
        const missing = withoutStream(goodReport(), stream)
        const bracket = bracketLiveness(read(where === 'end' ? goodReport() : missing), read(where === 'start' ? goodReport() : missing))
        const verdict = itemLivenessVerdict(bracket, spec.id)
        assert.equal(verdict.ok, false)
        if (where === 'both') assert.deepEqual(verdict, { ok: false, reason: 'STALE_BASIS' })
      })
    }
  }
}

test('every instance counts: one stale Mintsoft binding of two blocks R1, at either read', () => {
  const bad = makeStale(goodReport(), 'mintsoft-stock-sync', 'OVERFLOW')
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(bad), read(goodReport())), 'R1'), { ok: false, reason: 'STALE_BASIS' })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(goodReport()), read(bad)), 'R1'), { ok: false, reason: 'STALE_BASIS' })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(goodReport()), read(goodReport())), 'R1'), { ok: true })
})

test('two entries for one instance are ambiguous, so not fresh', () => {
  const doubled: ReadSyncReport = recount({ ...goodReport(), entries: [...goodReport().entries, freshEntry('xero-balance-snapshots')] })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(doubled), read(goodReport())), 'R6'), { ok: false, reason: 'STALE_BASIS' })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(goodReport()), read(doubled)), 'R6'), { ok: false, reason: 'STALE_BASIS' })
})

// [mutation: stamp equality check removed / ordering used instead]
test('a stamp that differs between the reads is BASIS_MOVED in EITHER direction: equality is the only comparison', () => {
  const later = withStamp(goodReport(), 'xero-balance-snapshots', STAMP_B)
  const forward = bracketLiveness(read(goodReport()), read(later))
  const backward = bracketLiveness(read(later), read(goodReport()))
  assert.deepEqual(itemLivenessVerdict(forward, 'R6'), { ok: false, reason: 'BASIS_MOVED' })
  assert.deepEqual(itemLivenessVerdict(backward, 'R6'), { ok: false, reason: 'BASIS_MOVED' })
  // An item that does not depend on that stream is unaffected.
  assert.deepEqual(itemLivenessVerdict(forward, 'R9'), { ok: true })
})

test('an instance that appears in only one read is BASIS_MOVED', () => {
  const fewer: ReadSyncReport = recount({ ...goodReport(), entries: goodReport().entries.filter((entry) => entry.instance !== 'OVERFLOW') })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(goodReport()), read(fewer)), 'R1'), { ok: false, reason: 'BASIS_MOVED' })
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(fewer), read(goodReport())), 'R1'), { ok: false, reason: 'BASIS_MOVED' })
})

test('STALE_BASIS outranks BASIS_MOVED when both are true', () => {
  const stale = makeStale(withStamp(goodReport(), 'xero-balance-snapshots', STAMP_B), 'xero-tax-rates')
  assert.deepEqual(streamsVerdict(bracketLiveness(read(goodReport()), read(stale)), ['xero-balance-snapshots', 'xero-tax-rates']), { ok: false, reason: 'STALE_BASIS' })
})

// [mutation: scheduler examined/unreadable/blockProblem ignored]
test('a scheduler that was not examined, could not be read, or has an untrusted block withholds every item that has a dependent stream, at either read', () => {
  const variants: Array<[string, Partial<ReadSyncReport['scheduler']>]> = [
    ['not examined', { examined: false }],
    ['unreadable', { unreadable: 'the crontab could not be read: permission denied' }],
    ['block problem', { blockProblem: 'the crontab must hold exactly one managed region' }],
  ]
  for (const [name, scheduler] of variants) {
    const bad = goodReport({ scheduler })
    for (const [first, second] of [[bad, goodReport()], [goodReport(), bad]] as const) {
      const bracket = bracketLiveness(read(first), read(second))
      for (const spec of ITEMS_WITH_STREAMS) assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: false, reason: 'STALE_BASIS' }, `${name} ${spec.id}`)
      for (const spec of ITEMS_WITHOUT_STREAMS) assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: true }, `${name} ${spec.id} depends on no stream`)
    }
  }
})

// [mutation: dependent-job filter removed (any job blocks) or inverted (no job blocks)]
test('an unscheduled or disabled job blocks only the items whose streams run on it', () => {
  for (const key of ['unscheduled', 'disabled'] as const) {
    const bad = goodReport({ scheduler: { [key]: ['account-balance-snapshot'] } })
    const bracket = bracketLiveness(read(bad), read(bad))
    assert.deepEqual(itemLivenessVerdict(bracket, 'R6'), { ok: false, reason: 'STALE_BASIS' }, key)
    assert.deepEqual(itemLivenessVerdict(bracket, 'R10'), { ok: false, reason: 'STALE_BASIS' }, key)
    assert.deepEqual(itemLivenessVerdict(bracket, 'R9'), { ok: true }, `${key}: the WooCommerce job is a different job`)
    assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(goodReport()), read(bad)), 'R6'), { ok: false, reason: 'STALE_BASIS' }, `${key} at the end read`)
    assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(bad), read(goodReport())), 'R6'), { ok: false, reason: 'STALE_BASIS' }, `${key} at the start read`)
  }
})

// [mutation: a failed/malformed read treated as healthy]
test('a liveness read that fails or is malformed makes EVERY item unreadable, including items with no dependent stream', () => {
  const malformed: unknown[] = [
    null, undefined, 'a report', 7, [],
    { ...goodReport(), schemaVersion: 2 },
    { ...goodReport(), entries: 'nope' },
    { ...goodReport(), scheduler: null },
    { ...goodReport(), scheduler: { ...cleanScheduler(), examined: 'yes' } },
    { ...goodReport(), scheduler: { ...cleanScheduler(), unscheduled: 'none' } },
    { ...goodReport(), scheduler: { ...cleanScheduler(), unscheduled: ['not-a-registered-job'] } },
    { ...goodReport(), scheduler: { ...cleanScheduler(), unreadable: 3 } },
    { ...goodReport(), entries: [{ stream: 'not-a-stream', instance: null, state: 'fresh' }] },
    { ...goodReport(), entries: [null] },
    { ...goodReport(), entries: [{ stream: 'xero-tax-rates', instance: 4, state: 'fresh' }] },
  ]
  for (const report of malformed) {
    for (const [first, second] of [[read(report), read(goodReport())], [read(goodReport()), read(report)], [read(report), read(report)]] as const) {
      const bracket = bracketLiveness(first, second)
      assert.equal(bracket.readable, false)
      for (const spec of PACK_ITEM_CATALOGUE) assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: false, reason: 'SOURCE_UNREADABLE' }, `${JSON.stringify(report)?.slice(0, 40)} ${spec.id}`)
    }
  }
})

test('readLiveness: a build that rejects, throws synchronously, returns garbage or never has a usable shape is { ok: false } with no cause kept', async () => {
  const bad = await Promise.all([
    readLiveness({ build: async () => { throw new Error('connect ECONNREFUSED postgres://user:hunter2@db/ims') } }),
    readLiveness({ build: () => { throw new Error('sync') } }),
    readLiveness({ build: async () => 'x' as never }),
    readLiveness({ build: async () => ({ ...goodReport(), schemaVersion: 9 }) as never }),
  ])
  for (const result of bad) assert.deepEqual(result, { ok: false })
  const good = await readLiveness({ build: async () => goodReport() })
  assert.equal(good.ok, true)
})

test('the pack\'s watchdog slug is the status module\'s, and the status report\'s own scheduler output is accepted unchanged', () => {
  assert.equal(WATCHDOG_JOB_SLUG, STOCK_SYNC_WATCHDOG_CRON_SLUG)
  const inputs: ReadSyncInputs = {
    settings: new Map([['wc_sync_enabled', 'true']]),
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    xeroConnected: true,
    cronEnabled: Object.fromEntries([...READ_SYNC_STREAMS.flatMap((def) => (def.cronSlug ? [[def.cronSlug, true]] : [])), [STOCK_SYNC_WATCHDOG_CRON_SLUG, true], ['read-sync-liveness', true]]),
    bindings: [{ id: 'b1', warehouseCode: 'MAIN', syncFrequencyMinutes: 60, lastStockSyncSuccessAt: new Date('2026-10-20T11:30:00.000Z') }],
    lastDispatchSuccessAt: new Date('2026-10-20T11:30:00.000Z'),
    crontab: { resolved: false, reason: 'crontab: cannot open: permission denied' },
  }
  const real = assembleReadSyncReport(inputs, new Date('2026-10-20T12:00:00.000Z'))
  const reduced = reduceStatusReport(real)
  assert.equal(reduced.ok, true)
  if (reduced.ok) {
    assert.equal(reduced.scheduler.examined, true)
    assert.equal(reduced.scheduler.unreadable, true)
    assert.ok(!JSON.stringify(reduced).includes('permission denied'), 'the cause text is reduced to a boolean')
  }
  // The scheduler could not be read, so even with every stream fresh no stream-dependent item passes.
  const bracket = bracketLiveness(reduced, reduced)
  assert.deepEqual(itemLivenessVerdict(bracket, 'R1'), { ok: false, reason: 'STALE_BASIS' })
  // The not-examined shape (no crontab given at all) is the same.
  const unexamined = reduceStatusReport(assembleReadSyncReport({ ...inputs, crontab: undefined }, new Date('2026-10-20T12:00:00.000Z')))
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(unexamined, unexamined), 'R1'), { ok: false, reason: 'STALE_BASIS' })
})

test('text safety: hostile warehouse codes and scheduler prose never reach the bracket', () => {
  const hostile = 'https://evil.example/?token=' + ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123'].join('_')
  const bad = goodReport({
    entries: [...goodReport().entries, freshEntry('mintsoft-stock-sync', hostile)],
    scheduler: { blockProblem: `the managed block says ${hostile}` },
  })
  const bracket = bracketLiveness(read(bad), read(bad))
  const text = JSON.stringify(bracket)
  assert.ok(!text.includes('evil.example'))
  assert.ok(!text.includes('sk_live'))
  assert.ok(!text.includes('managed block says'))
  const instance = bracket.instances.find((entry) => entry.instance !== null && entry.instance.startsWith('warehouse#'))
  assert.ok(instance, 'the hostile code is printed as a digest token')
})

// [mutation: the unclean stream is published with its end stamp] and the report writer/reader are the second lock
test('published stream brackets: a clean stream has equal start and end; an unclean one has no end, and a pass on it is refused by the report writer', () => {
  const stale = makeStale(goodReport(), 'xero-balance-snapshots')
  const bracket = bracketLiveness(read(goodReport()), read(stale))
  const brackets = publishedStreamBrackets(bracket, [...READ_SYNC_STREAM_IDS])
  assert.equal(brackets.length, READ_SYNC_STREAM_IDS.length)
  const xero = brackets.find((entry) => entry.stream === 'xero-balance-snapshots')!
  assert.equal(xero.start, STAMP_A)
  assert.equal(xero.end, null)
  assert.equal(bracketStable(xero.start, xero.end), false)
  for (const entry of brackets.filter((candidate) => candidate.stream !== 'xero-balance-snapshots')) assert.equal(bracketStable(entry.start, entry.end), true, entry.stream)

  const input = (streams: typeof brackets) => ({
    runId: '20261020T120000Z-0123456789ab', systemIdentifier: '7000000000000000001', phase: 'P1' as const, asOf: '2026-10-19',
    startedAt: '2026-10-20T12:00:00.000Z', finishedAt: '2026-10-20T12:00:01.000Z', streams,
    items: defaultItems('P1', { R6: passItem('R6') }),
  })
  assert.throws(() => buildReport(input(brackets), 1, null), (error: unknown) => error instanceof ReportInvalid && /equal start and end stamp for stream xero-balance-snapshots/.test(error.message))
  const clean = publishedStreamBrackets(bracketLiveness(read(goodReport()), read(goodReport())), [...READ_SYNC_STREAM_IDS])
  assert.doesNotThrow(() => buildReport(input(clean), 1, null))
})

test('a stream with several instances publishes one bracket, taken from the instance first by token; a moved sibling removes its end', () => {
  const moved = withStamp(goodReport(), 'mintsoft-stock-sync', STAMP_B, 'OVERFLOW')
  const bracket = bracketLiveness(read(goodReport()), read(moved))
  const stock = publishedStreamBrackets(bracket, ['mintsoft-stock-sync'])
  assert.equal(stock.length, 1)
  assert.equal(stock[0]!.end, null)
})

test('the catalogue\'s own stream lists are what decides: R1 depends on the Mintsoft stock sync and not the Xero pull', () => {
  const xeroStale = makeStale(goodReport(), 'xero-balance-snapshots')
  const bracket = bracketLiveness(read(xeroStale), read(xeroStale))
  assert.deepEqual(itemLivenessVerdict(bracket, 'R1'), { ok: true })
  assert.deepEqual(getPackItem('R1').streams, ['mintsoft-stock-sync'])
  assert.deepEqual(itemLivenessVerdict(bracket, 'R6'), { ok: false, reason: 'STALE_BASIS' })
  const streamsAll: ReadSyncStreamId[] = [...READ_SYNC_STREAM_IDS]
  assert.equal(streamsVerdict(bracket, streamsAll).ok, false)
})

// [mutation: any one of the consistency checks in reduceStatusReport removed]
test('CONTRADICTIONS: a report that disagrees with itself is unreadable as a whole, never believed in part', () => {
  const base = goodReport()
  const first = (stream: string) => base.entries.findIndex((entry) => entry.stream === stream)
  const entryAt = (index: number, change: Record<string, unknown>) => recount({ ...base, entries: base.entries.map((entry, at) => (at === index ? ({ ...entry, ...change } as never) : entry)) })
  const i = first('xero-balance-snapshots')
  const cases: Array<[string, unknown]> = [
    ['fresh but older than its own limit', entryAt(i, { ageMs: 40 * 3_600_000, lastSuccessAt: new Date(Date.parse(GENERATED_AT) - 40 * 3_600_000).toISOString() })],
    ['fresh but flagged future', entryAt(i, { futureTimestamp: true })],
    ['fresh but dated in the future', entryAt(i, { lastSuccessAt: '2026-10-20T15:00:00.000Z', ageMs: -3 * 3_600_000 })],
    ['fresh with no stamp', entryAt(i, { lastSuccessAt: null })],
    ['fresh with no age', entryAt(i, { ageMs: null })],
    ['fresh with no limit', entryAt(i, { maxAgeMs: null })],
    ['fresh with a zero limit', entryAt(i, { maxAgeMs: 0 })],
    ['fresh with an age that is not the distance to the stamp', entryAt(i, { ageMs: 1 })],
    ['fresh with a non-finite age', entryAt(i, { ageMs: Number.POSITIVE_INFINITY })],
    ['fresh with a string age', entryAt(i, { ageMs: '3600000' })],
    ['fresh with a non-ISO stamp', entryAt(i, { lastSuccessAt: 'yesterday' })],
    ['fresh with a stamp that is not UTC', entryAt(i, { lastSuccessAt: '2026-10-20T00:30:00+01:00' })],
    ['stale but young', entryAt(i, { state: 'stale' })],
    ['stale with the future flag missing the stamp', entryAt(i, { state: 'stale', lastSuccessAt: null, ageMs: null })],
    ['never with a stamp', entryAt(i, { state: 'never' })],
    ['never with an age', entryAt(i, { state: 'never', lastSuccessAt: null })],
    ['never with no limit', entryAt(i, { state: 'never', lastSuccessAt: null, ageMs: null, maxAgeMs: null })],
    ['off with a stamp', entryAt(i, { state: 'off' })],
    ['off with a limit', entryAt(i, { state: 'off', lastSuccessAt: null, ageMs: null })],
    ['future flag with no stamp', entryAt(i, { state: 'never', lastSuccessAt: null, ageMs: null, futureTimestamp: true })],
    ['a state the report does not define', entryAt(i, { state: 'invalid' })],
    ['a missing state', entryAt(i, { state: undefined })],
    ['a missing future flag', entryAt(i, { futureTimestamp: undefined })],
    ['a non-boolean future flag', entryAt(i, { futureTimestamp: 'false' })],
    ['a missing limit field', (() => { const e = entryAt(i, {}); delete (e.entries[i] as Record<string, unknown>).maxAgeMs; return e })()],
    ['counts that are not the tally', { ...base, counts: { fresh: 99, stale: 0, never: 0, off: 0 } }],
    ['counts missing', { ...base, counts: undefined }],
    ['a generation time that is not a time', { ...base, generatedAt: 'now' }],
    ['no generation time', { ...base, generatedAt: undefined }],
    ['a scheduler that was not examined yet names a problem', goodReport({ scheduler: { examined: false, blockProblem: 'x' } })],
    ['a scheduler that was not examined yet lists a job', goodReport({ scheduler: { examined: false, disabled: ['account-balance-snapshot'] } })],
    ['an unreadable crontab that also names a block problem', goodReport({ scheduler: { unreadable: 'a', blockProblem: 'b' } })],
  ]
  for (const [name, report] of cases) {
    assert.deepEqual(reduceStatusReport(report), { ok: false }, name)
    const bracket = bracketLiveness(read(report), read(goodReport()))
    for (const spec of PACK_ITEM_CATALOGUE) assert.deepEqual(itemLivenessVerdict(bracket, spec.id), { ok: false, reason: 'SOURCE_UNREADABLE' }, `${name} ${spec.id}`)
  }
})

test('CONTRADICTIONS: the consistent forms of the same entries ARE read, so the checks are not rejecting everything', () => {
  for (const report of [goodReport(), makeStale(goodReport(), 'xero-tax-rates'), makeFuture(goodReport(), 'xero-tax-rates'), makeNever(goodReport(), 'xero-tax-rates'), makeOff(goodReport(), 'xero-tax-rates')]) {
    assert.equal(reduceStatusReport(report).ok, true)
  }
  // A stamp a few minutes ahead of the report's clock is inside the skew tolerance: still fresh, not flagged.
  const skew = withStamp(goodReport(), 'xero-tax-rates', '2026-10-20T12:03:00.000Z')
  assert.equal(reduceStatusReport(skew).ok, true)
  assert.deepEqual(itemLivenessVerdict(bracketLiveness(read(skew), read(skew)), 'R13'), { ok: true })
  assert.equal(withEntry(goodReport(), 'xero-tax-rates', {}).entries.length, goodReport().entries.length)
})
