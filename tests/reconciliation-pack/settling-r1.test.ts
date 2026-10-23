import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { newRunId } from '../../lib/reconciliation-pack/harness.ts'
import { reduceStatusReport } from '../../lib/reconciliation-pack/liveness.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { memoisedInvariant, runItems, type LivenessPort, type RunPlan } from '../../lib/reconciliation-pack/run.ts'
import { carriedStateFromChain } from '../../lib/reconciliation-pack/settling.ts'
import { readPackChain, type ChainResult } from '../../lib/reconciliation-pack/trend.ts'
import { fakeBasisPort, goodState } from './basis-fixtures.ts'
import { NOW, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { goodReport, withStamp } from './liveness-fixtures.ts'
import { equalEstate, fakeWms, imsFor, noSleep } from './wms-fixtures.ts'

/**
 * D7 FOR R1, THROUGH THE REAL CHAIN: a difference in Mintsoft stock is unsettled on its first sight, still unsettled after one further
 * run of the mintsoft-stock-sync stream, a failure after two, counted from the pack's own published reports. Mutations are listed in the PR.
 */

const bases: string[] = []
after(() => cleanup(bases))
const SID = '7000000000000000001'
// Stamps the liveness reducer accepts as fresh against its report clock (2026-10-20T12:00): the code under test never orders them.
const L1 = '2026-10-20T01:00:00.000Z'
const L2 = '2026-10-20T02:00:00.000Z'
const L3 = '2026-10-20T03:00:00.000Z'
const L4 = '2026-10-20T04:00:00.000Z'

const stockSync = (...stamps: string[]): LivenessPort => {
  let n = 0
  return { read: async () => reduceStatusReport(withStamp(goodReport(), 'mintsoft-stock-sync', stamps[Math.min(n++, stamps.length - 1)]!)) }
}

function plan(liveness: LivenessPort, carried: RunPlan['carried'], short: boolean): RunPlan {
  const { estate, wms } = equalEstate()
  if (short) estate.stock = estate.stock.map((s) => (s.warehouseCode === 'MIL1' && s.sku === '129552751' ? { ...s, quantity: '35' } : s))
  const ims = imsFor(estate)
  return {
    phase: 'P1', asOf: '2026-10-19', selected: ['R1'], liveness, basis: fakeBasisPort(goodState()), carried,
    context: { phase: 'P1', asOf: '2026-10-19', now: () => NOW, acceptances: parseAcceptanceFile(null), invariant: memoisedInvariant(async () => realEvidence()), vendorReads: true, vendor: { wms: fakeWms(wms) }, ims: ims.ims, wmsOptions: { sleep: noSleep } },
  }
}

async function publishRun(dir: string, stamp: string, short = true, liveness: LivenessPort = stockSync(stamp, stamp)) {
  const chain = readPackChain(dir)
  const carried = { R1: carriedStateFromChain(chain, 'R1', { phase: 'P1', systemIdentifier: SID }) }
  const { items, streams } = await runItems(plan(liveness, carried, short))
  const published = publishPackReport(dir, {
    runId: newRunId(new Date(NOW.getTime() + 1000 * (chain.ok ? chain.reports.length : 0))), systemIdentifier: SID, phase: 'P1', asOf: '2026-10-19',
    startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items,
  })
  assert.equal(published.ok, true, JSON.stringify(published))
  return items.find((i) => i.id === 'R1')!
}
const head = (dir: string) => { const chain = readPackChain(dir); assert.equal(chain.ok, true); return (chain as Extract<ChainResult, { ok: true }>).head! }
const r1 = (dir: string) => head(dir).record.items.find((entry) => entry.id === 'R1')!
const shape = (item: { outcome: string; reasons: readonly string[] }) => [item.outcome, [...item.reasons]]

// [mutation: R1's catalogue row settles removed, a difference failing on first sight / the stream stamp not taken from the published bracket]
test('R1 THROUGH THE CHAIN: first sight (nothing to carry, and it says so), one further stream run, two further runs (fail), and the failure stays', async () => {
  const dir = scratchDir(bases)
  await publishRun(dir, L1)
  assert.deepEqual(shape(r1(dir)), ['inconclusive', ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']])
  assert.deepEqual(head(dir).settling.map((line) => [line.item, line.bucket, line.entry.key, line.entry.settling]), [['R1', 'unsettled', 'MIL1|129552751', { sequence: 1, first: L1, later: [], count: 0 }]])
  await publishRun(dir, L2)
  assert.deepEqual(shape(r1(dir)), ['inconclusive', ['UNSETTLED_PENDING']])
  assert.deepEqual(head(dir).settling.map((line) => line.entry.settling), [{ sequence: 1, first: L1, later: [L2], count: 1 }])
  await publishRun(dir, L3)
  assert.deepEqual(shape(r1(dir)), ['fail', ['DIFFERENCES']])
  assert.deepEqual(head(dir).settling.map((line) => [line.bucket, line.entry.settling]), [['bothDiffer', { sequence: 1, first: L1, later: [L2, L3], count: 2 }]], 'the failing entry keeps its state')
  await publishRun(dir, L4)
  assert.deepEqual(shape(r1(dir)), ['fail', ['DIFFERENCES']])
  assert.equal(head(dir).record.sequence, 4)
})

// [mutation: the same stamp counted across reports]
test('R1: an unchanged stock-sync stamp is no progress however often the pack runs, and a difference that heals is dropped from the next report', async () => {
  const dir = scratchDir(bases)
  for (let n = 0; n < 4; n += 1) await publishRun(dir, L1)
  assert.deepEqual(head(dir).settling.map((line) => line.entry.settling), [{ sequence: 1, first: L1, later: [], count: 0 }])
  assert.deepEqual(shape(r1(dir)), ['inconclusive', ['UNSETTLED_PENDING']])
  await publishRun(dir, L2, false)
  assert.equal(r1(dir).outcome, 'pass', 'IMS caught up with Mintsoft: nothing is listed as unsettled')
  assert.deepEqual(head(dir).settling.filter((line) => line.item === 'R1'), [])
  await publishRun(dir, L3)
  assert.deepEqual(head(dir).settling.map((line) => line.entry.settling), [{ sequence: 6, first: L3, later: [], count: 0 }], 'and if it returns it starts again')
})

// [mutation: the stamp taken from the END read]
test('R1: a stock-sync stamp that MOVED during the read counts for nothing (BASIS_MOVED), and the next run starts the count again', async () => {
  const dir = scratchDir(bases)
  await publishRun(dir, L1)
  const moved = await publishRun(dir, L2, true, stockSync(L2, L3))
  assert.deepEqual(shape(moved), ['inconclusive', ['BASIS_MOVED']])
  assert.deepEqual(shape(r1(dir)), ['inconclusive', ['BASIS_MOVED']])
  await publishRun(dir, L3)
  assert.deepEqual(shape(r1(dir)), ['inconclusive', ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']], 'the previous report was not compared to the end, so nothing is carried')
})
