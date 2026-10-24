import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { collectGateResults, type GateDeps } from '../../lib/ops/readiness-gate-collect.ts'
import { assessPackItem, assessPackItems, combineDerivations, readNewestPackReport, type PackAssessContext, type PackReportRead } from '../../lib/ops/readiness-gate-pack.ts'
import { PACK_ITEMS } from '../../lib/ops/readiness-gate-constants.ts'
import { decideVerdict, type CheckResult } from '../../lib/ops/readiness-gate.ts'
import { PACK_CADENCE_MAX_AGE_MS, PACK_ITEM_IDS, getPackItem, itemApplicability, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import type { ItemInput } from '../../lib/reconciliation-pack/report.ts'
import { APPLY_RUN, APPLY_SYSTEM_ID, ALL_CONSTRAINTS, DAY, GATE_BUILD, NOW, NO_ACCEPTANCES, cleanInvariant, cleanOutbound, greenApplyReport, greenRehearsal, packPass, packRecord, packStreams } from '../helpers/readiness-gate-fixtures.ts'

/**
 * THE GATE READS THE PACK'S NEWEST REPORT (lib/ops/readiness-gate-pack.ts): the mapping, every trust rule, and the two-way
 * derivation of R3, R4 and R15. Mutations are listed in the PR.
 */

const bases: string[] = []
function scratch(): string {
  const dir = mkdtempSync(path.join('/var/tmp', 'ims-gate-pack-'))
  chmodSync(dir, 0o700)
  bases.push(dir)
  return dir
}
after(() => { for (const dir of bases) rmSync(dir, { recursive: true, force: true }) })

const ctx = (over: Partial<PackAssessContext> = {}): PackAssessContext => ({ phase: 'P1', now: NOW, systemIdentifier: APPLY_SYSTEM_ID, ...over })
const fail = (id: PackItemId): ItemInput => ({ id, outcome: 'fail', reasons: ['DIFFERENCES'], entries: { onlyIms: [{ key: 'A1', ims: '1', vendor: null, delta: null, imsPresent: true, vendorPresent: false }] } })
const inconclusive = (id: PackItemId, ...reasons: ItemInput['reasons'][number][]): ItemInput => ({ id, outcome: 'inconclusive', reasons })
const kinds = (results: Record<PackItemId, CheckResult>) => Object.fromEntries(PACK_ITEM_IDS.map((id) => [id, results[id].kind]))

// ---- the mapping --------------------------------------------------------------------------------------

test('the mapping: pass -> pass, fail -> fail, inconclusive -> unreadable, not-applicable -> not-available (P1 report, every outcome present)', () => {
  const record = packRecord('P1', { items: { R6: packPass('R6'), R10: fail('R10'), R9: inconclusive('R9', 'STALE_BASIS'), R5: inconclusive('R5', 'READ_INCOMPLETE', 'SOURCE_UNREADABLE') } })
  const results = assessPackItems({ record }, ctx())
  assert.equal(results.R3.kind, 'pass')
  assert.equal(results.R6.kind, 'pass')
  assert.equal(results.R10.kind, 'fail')
  assert.ok(results.R10.kind === 'fail' && results.R10.reasons[0]!.includes('DIFFERENCES') && results.R10.reasons[0]!.includes(record.runId))
  assert.equal(results.R9.kind, 'unreadable')
  assert.ok(results.R9.kind === 'unreadable' && results.R9.reason.includes('STALE_BASIS'))
  assert.equal(results.R5.kind, 'unreadable')
  for (const id of ['R7', 'R8', 'R11'] as const) assert.equal(results[id].kind, 'not-available', id)
})

// [mutation: inconclusive mapped to not-available / to pass]
test('an inconclusive item is NEVER a pass or "not available" - with one exception, stated: NO_RUNNER alone (no runner on that build) is not available', () => {
  const reasons = ['READ_INCOMPLETE', 'STALE_BASIS', 'BASIS_MOVED', 'SOURCE_UNREADABLE', 'NOT_SELECTED', 'INTERNAL_ERROR', 'NO_POPULATION_RECORD', 'GL_LEG_ABSENT'] as const
  for (const reason of reasons) {
    const record = packRecord('P1', { items: { R9: inconclusive('R9', reason) } })
    assert.equal(assessPackItem({ record }, 'R9', ctx()).kind, 'unreadable', reason)
  }
  assert.equal(assessPackItem({ record: packRecord('P1', { items: { R9: inconclusive('R9', 'NO_RUNNER') } }) }, 'R9', ctx()).kind, 'not-available')
  assert.equal(assessPackItem({ record: packRecord('P1', { items: { R9: inconclusive('R9', 'NO_RUNNER', 'STALE_BASIS') } }) }, 'R9', ctx()).kind, 'unreadable', 'NO_RUNNER with another reason is not the exception')
})

// [mutation: UNSETTLED_PENDING (alone, or beside SETTLING_STATE_UNUSABLE) mapped to pass or to not-available]
test('D7: R9 still settling (UNSETTLED_PENDING, with or without SETTLING_STATE_UNUSABLE) is UNREADABLE for the gate - not a pass, not "not available" (a failure maps to fail as for every item, above)', () => {
  const stamp = '2026-10-19T00:00:00.000Z'
  const unsettled = (reasons: ItemInput['reasons']): ItemInput => ({ id: 'R9', outcome: 'inconclusive', reasons, entries: { unsettled: [{ key: '12', ims: '1', vendor: null, delta: null, imsCurrency: 'GBP', settling: { sequence: 1, first: stamp, later: [] } }] } })
  for (const reasons of [['UNSETTLED_PENDING'], ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']] as const) {
    const result = assessPackItem({ record: packRecord('P1', { items: { R9: unsettled(reasons) } }) }, 'R9', ctx())
    assert.equal(result.kind, 'unreadable', reasons.join(','))
    assert.ok(result.kind === 'unreadable' && result.reason.includes('UNSETTLED_PENDING'))
  }
})

// [mutation: the VENDOR_READS_OFF reading removed from assessPackItem / widened to "any reason list that contains it"]
test('VENDOR_READS_OFF alone (the run did not opt in to vendor reads) is not available, like NO_RUNNER: the slot is what it was before the pack could read vendors; and a partial run (NOT_SELECTED) stays unreadable', () => {
  const off = assessPackItem({ record: packRecord('P1', { items: { R9: inconclusive('R9', 'VENDOR_READS_OFF') } }) }, 'R9', ctx())
  assert.equal(off.kind, 'not-available')
  assert.ok(off.kind === 'not-available' && off.reason.includes('--vendor-reads-only'))
  // The report builder refuses VENDOR_READS_OFF beside another reason (tests/reconciliation-pack/consistency.test.ts), so a pack report never carries one.
  // A partial run (NOT_SELECTED) is an operator's choice of a different kind and stays unreadable.
  assert.equal(assessPackItem({ record: packRecord('P1', { items: { R9: inconclusive('R9', 'NOT_SELECTED') } }) }, 'R9', ctx()).kind, 'unreadable')
  // It blocks only where not-available blocks: not at P1, at P2 the slot is required.
  const p1 = decideVerdict({ phase: 'P1', results: { ...passingFixed(), ...Object.fromEntries(PACK_ITEMS.map((item) => [`pack-${item.id}`, assessPackItem({ record: packRecord('P1', { items: { R9: inconclusive('R9', 'VENDOR_READS_OFF') } }) }, item.id, ctx())])) }, acceptances: NO_ACCEPTANCES, now: NOW })
  assert.ok(!p1.blockingReasons.some((reason) => reason.startsWith('pack-R9:')))
})

test('the gate\'s verdict on a pack-fed run: unreadable ALWAYS blocks, a failing item blocks at P2 only as listed, not-available does not block before P2', () => {
  const record = packRecord('P1', { items: { R9: inconclusive('R9', 'STALE_BASIS') } })
  const results: Record<string, CheckResult> = Object.fromEntries(PACK_ITEMS.map((item) => [`pack-${item.id}`, assessPackItem({ record }, item.id, ctx())]))
  const rows = decideVerdict({ phase: 'P1', results: { ...passingFixed(), ...results }, acceptances: NO_ACCEPTANCES, now: NOW })
  assert.equal(rows.verdict, 'NO-GO')
  assert.ok(rows.blockingReasons.some((reason) => reason.startsWith('pack-R9: UNREADABLE')))
  assert.ok(!rows.blockingReasons.some((reason) => reason.startsWith('pack-R1:')), 'NO_RUNNER items do not block at P1')
})
function passingFixed(): Record<string, CheckResult> {
  return Object.fromEntries(['invariant-preflight', 'schema-state', 'outbound-status', 'first-install-rehearsal', 'first-load-apply', 'reconciliation-completeness', 'read-sync-liveness'].map((id) => [id, { kind: 'pass', summary: 'ok' } as CheckResult]))
}

// ---- no usable report ---------------------------------------------------------------------------------

// [mutation: a missing or untrusted report mapped to not-available / to pass]
test('no report, or an untrusted one, is unreadable for every item the pack applies in the phase - and not-available only where the catalogue says the phase does not apply', () => {
  for (const read of [{ none: 'no reconciliation pack report was found' }, { untrusted: 'the location is not trusted (DIR_UNTRUSTED)' }] as PackReportRead[]) {
    for (const phase of ['P0', 'P1', 'P2'] as const) {
      const results = assessPackItems(read, ctx({ phase }))
      for (const id of PACK_ITEM_IDS) {
        const expected = itemApplicability(id, phase) === 'not-applicable' ? 'not-available' : 'unreadable'
        assert.equal(results[id].kind, expected, `${id} ${phase}`)
      }
    }
  }
})

// ---- identity, phase, age -------------------------------------------------------------------------------

// [mutation: the system identifier comparison removed]
test('a report of another installation, or when this installation\'s identifier cannot be read, makes every applicable item unreadable', () => {
  const other = packRecord('P1', { systemIdentifier: '7400000000000000002' })
  assert.deepEqual(new Set(Object.values(kinds(assessPackItems({ record: other }, ctx())))), new Set(['unreadable', 'not-available']))
  assert.equal(assessPackItem({ record: other }, 'R3', ctx()).kind, 'unreadable')
  assert.equal(assessPackItem({ record: packRecord('P1') }, 'R3', ctx({ systemIdentifier: { unreadable: 'connection refused' } })).kind, 'unreadable')
  assert.equal(assessPackItem({ record: packRecord('P1') }, 'R3', ctx({ systemIdentifier: '' })).kind, 'unreadable', 'an empty identifier matches nothing')
  assert.equal(assessPackItem({ record: packRecord('P1') }, 'R3', ctx()).kind, 'pass')
})

// [mutation: the phase comparison removed]
test('a report made for another phase says nothing about the one asked', () => {
  for (const [made, asked] of [['P0', 'P1'], ['P1', 'P0'], ['P1', 'P2'], ['P2', 'P1']] as const) {
    assert.equal(assessPackItem({ record: packRecord(made) }, 'R3', ctx({ phase: asked })).kind, 'unreadable', `${made} read at ${asked}`)
  }
})

// [mutation: the cycle-date check removed / applied by finish time instead / the day-ended rule dropped]
test('R6 and R10 need a CURRENT cycle date: a fresh report about an old date, or about a day not yet ended, is not established', () => {
  // NOW is 2026-10-08T12:00Z; the default cycle date 2026-10-07 ended 12 hours ago.
  for (const id of ['R6', 'R10'] as PackItemId[]) {
    const at = (asOf: string, finishedAt: Date = new Date(NOW.getTime() - 3600_000)) => assessPackItem({ record: packRecord('P1', { asOf, finishedAt, items: { [id]: packPass(id) } }) }, id, ctx()).kind
    assert.equal(at('2026-10-07'), 'pass', `${id}: yesterday, read after it ended`)
    assert.equal(at('2026-10-06'), 'pass', `${id}: ended 36 hours ago, inclusive`)
    assert.equal(at('2026-10-05'), 'unreadable', `${id}: a fresh report about a date that ended 60 hours ago`)
    assert.equal(at('2026-09-01'), 'unreadable', `${id}: an old date`)
    assert.equal(at('2026-10-08'), 'unreadable', `${id}: today, not yet ended`)
    assert.equal(at('2026-10-07', new Date('2026-10-07T23:00:00.000Z')), 'unreadable', `${id}: read before its day ended`)
    // A record the report reader would refuse, met here anyway: the gate does not rely on the reader for it.
    for (const bad of ['2026-02-30', '20261007', '', 'yesterday', null]) {
      const record = { ...packRecord('P1', { items: { [id]: packPass(id) } }), asOf: bad as never }
      assert.equal(assessPackItem({ record }, id, ctx()).kind, 'unreadable', `${id}: cycle date ${JSON.stringify(bad)}`)
    }
  }
  // Items that read no cycle-dated evidence are not held to it.
  assert.equal(assessPackItem({ record: packRecord('P1', { asOf: '2026-09-01' }) }, 'R3', ctx()).kind, 'pass')
})

// [mutation: 'ims-ledger' removed from the gate's cycle-dated sources]
test('R12 reads the ledger as of its cycle date: a fresh report about an old date, a day not yet ended or an unreadable date is not established; the monthly limit is counted from the end of the cycle day, inclusive', () => {
  const id: PackItemId = 'R12'
  assert.ok(getPackItem(id).sources.includes('ims-ledger') && getPackItem(id).cadence === 'monthly')
  const at = (asOf: string, finishedAt: Date = new Date(NOW.getTime() - 3600_000)) => assessPackItem({ record: packRecord('P1', { asOf, finishedAt, items: { [id]: packPass(id) } }) }, id, ctx()).kind
  assert.equal(at('2026-10-07'), 'pass', 'yesterday, read after it ended')
  assert.equal(at('2026-09-03', new Date(NOW.getTime() - 3600_000)), 'pass', 'its day ended 34.5 days ago: inside the monthly limit')
  assert.equal(at('2026-09-02'), 'unreadable', 'its day ended 35.5 days ago: a fresh report about an old cycle date')
  assert.equal(at('2026-08-01'), 'unreadable')
  assert.equal(at('2026-10-08'), 'unreadable', 'today, not yet ended')
  assert.equal(at('2026-10-07', new Date('2026-10-07T23:00:00.000Z')), 'unreadable', 'read before its day ended')
  for (const bad of ['2026-02-30', '20261007', '', 'yesterday', null]) {
    const record = { ...packRecord('P1', { items: { R12: packPass('R12') } }), asOf: bad as never }
    assert.equal(assessPackItem({ record }, 'R12', ctx()).kind, 'unreadable', JSON.stringify(bad))
  }
  // The monthly age of the report itself still applies.
  const limit = PACK_CADENCE_MAX_AGE_MS.monthly
  assert.equal(assessPackItem({ record: packRecord('P1', { asOf: '2026-09-03', finishedAt: new Date(NOW.getTime() - limit - 1), items: { [id]: packPass(id) } }) }, id, ctx()).kind, 'unreadable')
})

// [mutation: the age check removed / the cadence ignored / the boundary moved]
test('a report is current by its item\'s cadence: daily 36 hours, weekly 8 days, monthly 35 days - inclusive at the limit, stale one millisecond past it', () => {
  // R12 is monthly but reads a cycle-dated source (ims-ledger), so its age is judged by the end of its cycle day: its own test follows.
  const cases: Array<[PackItemId, 'daily' | 'weekly' | 'monthly']> = [['R3', 'daily'], ['R14', 'weekly']]
  for (const [id, cadence] of cases) {
    const limit = PACK_CADENCE_MAX_AGE_MS[cadence]
    const at = (age: number) => packRecord('P1', { finishedAt: new Date(NOW.getTime() - age), items: { [id]: packPass(id) } })
    assert.equal(assessPackItem({ record: at(limit) }, id, ctx()).kind, 'pass', `${id} exactly ${cadence} limit`)
    assert.equal(assessPackItem({ record: at(limit + 1) }, id, ctx()).kind, 'unreadable', `${id} one ms past`)
    assert.equal(assessPackItem({ record: at(limit * 10) }, id, ctx()).kind, 'unreadable', `${id} long past`)
  }
  assert.deepEqual([PACK_CADENCE_MAX_AGE_MS.daily, PACK_CADENCE_MAX_AGE_MS.weekly, PACK_CADENCE_MAX_AGE_MS.monthly], [36 * 3600_000, 8 * DAY, 35 * DAY])
  // One report, two cadences: at 40 hours the daily items are stale and the weekly item still holds.
  const record = packRecord('P1', { finishedAt: new Date(NOW.getTime() - 40 * 3600_000), items: { R14: packPass('R14') } })
  assert.equal(assessPackItem({ record }, 'R3', ctx()).kind, 'unreadable')
  assert.equal(assessPackItem({ record }, 'R14', ctx()).kind, 'pass')
})

// [mutation: a future-dated report accepted]
test('a report dated in the future is unreadable (it cannot be "current")', () => {
  assert.equal(assessPackItem({ record: packRecord('P1', { finishedAt: new Date(NOW.getTime() + 1) }) }, 'R3', ctx()).kind, 'unreadable')
  assert.equal(assessPackItem({ record: packRecord('P1', { finishedAt: NOW }) }, 'R3', ctx()).kind, 'pass', 'finished this instant is not the future')
})

// [mutation: a report's "not applicable" believed where the catalogue applies the item]
test('a report that calls an item not applicable where the catalogue applies it is not believed (and one the catalogue does not apply is not available whatever it says)', () => {
  const record = packRecord('P1')
  const lies = { ...record, items: record.items.map((item) => (item.id === 'R3' ? { ...item, outcome: 'not-applicable' as const, reasons: ['PHASE_NOT_APPLICABLE' as const] } : item)) }
  assert.equal(assessPackItem({ record: lies }, 'R3', ctx()).kind, 'unreadable')
  const claimsPass = { ...record, items: record.items.map((item) => (item.id === 'R7' ? { ...item, outcome: 'pass' as const, reasons: [] } : item)) }
  assert.equal(assessPackItem({ record: claimsPass }, 'R7', ctx()).kind, 'not-available', 'R7 does not apply at P1: the catalogue decides, not the report')
})

test('a record that lists an item twice, not at all, or with an outcome this gate does not know is unreadable for it', () => {
  const record = packRecord('P1')
  const twice = { ...record, items: [...record.items, record.items.find((item) => item.id === 'R3')!] }
  assert.equal(assessPackItem({ record: twice }, 'R3', ctx()).kind, 'unreadable')
  const missing = { ...record, items: record.items.filter((item) => item.id !== 'R3') }
  assert.equal(assessPackItem({ record: missing }, 'R3', ctx()).kind, 'unreadable')
  const odd = { ...record, items: record.items.map((item) => (item.id === 'R3' ? { ...item, outcome: 'green' as never } : item)) }
  assert.equal(assessPackItem({ record: odd }, 'R3', ctx()).kind, 'unreadable')
})

// ---- R3, R4, R15: two derivations -----------------------------------------------------------------------

// [mutation: the gate's own reading returned alone / the pack's returned alone]
test('combineDerivations: two passes are a pass, two fails are a fail, EVERY other pair is unreadable - a disagreement is never a pass', () => {
  const pass: CheckResult = { kind: 'pass', summary: 'ok' }
  const failed: CheckResult = { kind: 'fail', reasons: ['x'] }
  const unreadable: CheckResult = { kind: 'unreadable', reason: 'y' }
  const notAvailable: CheckResult = { kind: 'not-available', reason: 'z' }
  const all = [pass, failed, unreadable, notAvailable]
  let examined = 0
  for (const gate of all) {
    for (const pack of all) {
      examined += 1
      const out = combineDerivations('R3', gate, pack)
      const expected = (gate.kind === 'pass' && pack.kind === 'pass') ? 'pass' : (gate.kind === 'fail' && pack.kind === 'fail') ? 'fail' : 'unreadable'
      assert.equal(out.kind, expected, `${gate.kind} / ${pack.kind}`)
      if (gate.kind !== pack.kind) assert.notEqual(out.kind, 'pass')
    }
  }
  assert.equal(examined, 16)
})

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    now: () => NOW,
    runInvariant: async () => cleanInvariant(),
    readOutbound: async () => cleanOutbound(),
    readReconciliation: async () => ({ latest: { id: 'r', status: 'COMPLETED', totalCount: 0, warningCount: 0, criticalCount: 0, createdAt: NOW.toISOString() }, proof: { state: 'proven' }, blockers: [], warnings: [] }),
    runScript: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    readPackageScripts: () => ({}),
    readBuildIdentity: () => GATE_BUILD,
    readInstalledConstraints: ALL_CONSTRAINTS,
    readApplyRun: async () => ({ systemId: APPLY_SYSTEM_ID, runs: [{ ...APPLY_RUN }] }),
    readApplyReports: () => ({ reports: [{ parsed: greenApplyReport(), markdownDigestOk: true }], unparseable: 0 }),
    readNewestPackReport: () => ({ record: packRecord('P1') }),
    readSystemIdentifier: async () => APPLY_SYSTEM_ID,
    readNewestRehearsal: () => ({ digest: { ok: true }, parsed: greenRehearsal(), location: '/r' }),
    env: { PATH: '/usr/bin', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' },
    repoRoot: process.cwd(),
    ...over,
  }
}
const OPTIONS = { phase: 'P1' as const, expectGranted: null, rehearsalDir: '/r', applyReportDir: '/a', packReportDir: '/p' }
const warningR3 = { severity: 'warning', code: 'stock_cost_layer_quantity_mismatch', productId: 'cproduct0000000000000001a', warehouseId: 'cwarehouse000000000000001' }

test('collected: R3, R4 and R15 need the gate\'s reading AND the pack\'s to agree; every disagreement is unreadable and every agreement keeps the gate\'s own result', async () => {
  const both = await collectGateResults(OPTIONS, gateDeps())
  for (const id of ['pack-R3', 'pack-R4', 'pack-R15']) assert.equal(both.results[id]!.kind, 'pass', id)

  // Gate sees a stock mismatch (fail), the pack says pass: disagreement.
  const gateFails = await collectGateResults(OPTIONS, gateDeps({ runInvariant: async () => cleanInvariant({ inventory: [warningR3] }) }))
  assert.equal(gateFails.results['pack-R3']!.kind, 'unreadable')
  // Gate passes, the pack says fail.
  const packFails = await collectGateResults(OPTIONS, gateDeps({ readNewestPackReport: () => ({ record: packRecord('P1', { items: { R3: fail('R3') } }) }) }))
  assert.equal(packFails.results['pack-R3']!.kind, 'unreadable')
  // Both fail: a fail, the gate's own.
  const bothFail = await collectGateResults(OPTIONS, gateDeps({ runInvariant: async () => cleanInvariant({ inventory: [warningR3] }), readNewestPackReport: () => ({ record: packRecord('P1', { items: { R3: fail('R3') } }) }) }))
  assert.equal(bothFail.results['pack-R3']!.kind, 'fail')
  // The pack could not prove it while the gate can.
  const packInconclusive = await collectGateResults(OPTIONS, gateDeps({ readNewestPackReport: () => ({ record: packRecord('P1', { items: { R15: inconclusive('R15', 'READ_INCOMPLETE') } }) }) }))
  assert.equal(packInconclusive.results['pack-R15']!.kind, 'unreadable')
  assert.equal(packInconclusive.results['pack-R3']!.kind, 'pass', 'the other items are read on their own')
  // And no report at all: the gate alone is not enough.
  const none = await collectGateResults(OPTIONS, gateDeps({ readNewestPackReport: () => ({ none: 'no reconciliation pack report was found' }) }))
  for (const id of ['pack-R3', 'pack-R4', 'pack-R15']) assert.equal(none.results[id]!.kind, 'unreadable', id)
  // The gate cannot read its own invariant report but the pack passes: still unreadable.
  const gateUnreadable = await collectGateResults(OPTIONS, gateDeps({ runInvariant: async () => { throw new Error('db down') } }))
  assert.equal(gateUnreadable.results['pack-R3']!.kind, 'unreadable')
})

test('collected: a pack reader that throws, or a system identifier that cannot be read, is unreadable for the applicable items - never a pass and never a crash', async () => {
  const throwsRead = await collectGateResults(OPTIONS, gateDeps({ readNewestPackReport: () => { throw Object.assign(new Error('EACCES: permission denied, scandir /secret/path'), { code: 'EACCES' }) } }))
  assert.equal(throwsRead.results['pack-R3']!.kind, 'unreadable')
  assert.ok(JSON.stringify(throwsRead.results['pack-R3']).includes('EACCES') && !JSON.stringify(throwsRead.results).includes('/secret/path'), 'only the system error code reaches the text')
  const throwsId = await collectGateResults(OPTIONS, gateDeps({ readSystemIdentifier: async () => { throw new Error('postgresql://u:hunter2@host/db refused') } }))
  assert.equal(throwsId.results['pack-R3']!.kind, 'unreadable')
  assert.ok(!JSON.stringify(throwsId.results).includes('hunter2'), 'nothing the database said reaches the text')
  const emptyId = await collectGateResults(OPTIONS, gateDeps({ readSystemIdentifier: async () => '' }))
  assert.equal(emptyId.results['pack-R3']!.kind, 'unreadable')
  assert.equal(Object.keys(throwsId.results).length, 22, 'every slot still has a result')
})

test('collected, P2: an item the pack reports as failing blocks, one it could not prove blocks, and a pass the report supports does not', async () => {
  const options = { ...OPTIONS, phase: 'P2' as const, expectGranted: [] as string[] }
  const record = packRecord('P2', { items: { R6: packPass('R6'), R10: fail('R10') } })
  const { results } = await collectGateResults(options, gateDeps({ readNewestPackReport: () => ({ record }) }))
  assert.equal(results['pack-R6']!.kind, 'pass')
  assert.equal(results['pack-R10']!.kind, 'fail')
  assert.equal(results['pack-R9']!.kind, 'not-available', 'NO_RUNNER: not available, which is required at P2 and so blocks there')
  const verdict = decideVerdict({ phase: 'P2', results, acceptances: NO_ACCEPTANCES, now: NOW })
  assert.ok(verdict.blockingReasons.some((r) => r.startsWith('pack-R10:')) && verdict.blockingReasons.some((r) => r.startsWith('pack-R9:')) && !verdict.blockingReasons.some((r) => r.startsWith('pack-R6:')))
})

// ---- the report on disk -------------------------------------------------------------------------------

const T1 = new Date(NOW.getTime() - 3 * 3600_000)
const T2 = new Date(NOW.getTime() - 1 * 3600_000)
function publish(dir: string, now: Date, items: Partial<Record<PackItemId, ItemInput>> = { R3: packPass('R3'), R4: packPass('R4'), R15: packPass('R15') }) {
  const result = publishSyntheticRun({ reportDir: dir, phase: 'P0', asOf: '2026-10-07', now, systemIdentifier: APPLY_SYSTEM_ID, items })
  assert.ok(result.ok, JSON.stringify(result))
  return result
}
const runDirs = (dir: string) => readdirSync(dir).filter((name) => /^\d{8}T/.test(name))

test('on disk: a missing directory, and an empty one, are "none"', () => {
  assert.ok('none' in readNewestPackReport(path.join(scratch(), 'absent')))
  assert.ok('none' in readNewestPackReport(scratch()))
})

// [mutation: the newest chosen by time, or the first read]
test('on disk: the NEWEST report is the highest SEQUENCE, never the latest time', () => {
  const dir = scratch()
  publish(dir, T2) // sequence 1, the later time
  publish(dir, T1, { R3: fail('R3') }) // sequence 2, the earlier time
  const read = readNewestPackReport(dir)
  assert.ok('record' in read)
  if ('record' in read) {
    assert.equal(read.record.sequence, 2)
    assert.equal(read.record.finishedAt, T1.toISOString())
    assert.equal(read.record.items.find((item) => item.id === 'R3')!.outcome, 'fail', 'an older green report is never a fallback for a newer red one')
  }
})

// [mutation: the trust checks removed]
test('on disk: every trust rule refuses the WHOLE location (a bad pair anywhere, even not the newest)', () => {
  const make = (prepare: (dir: string, runs: string[]) => void): PackReportRead => {
    const dir = scratch()
    publish(dir, T1)
    publish(dir, T2)
    prepare(dir, runDirs(dir).sort())
    return readNewestPackReport(dir)
  }
  assert.ok('record' in make(() => undefined), 'control: an untouched location is read')
  const refused: Array<[string, (dir: string, runs: string[]) => void]> = [
    ['the report directory is group/other-writable', (dir) => chmodSync(dir, 0o777)],
    ['a run directory is group-readable', (dir, runs) => chmodSync(path.join(dir, runs[0]!), 0o750)],
    ['an OLDER pair\'s JSON is group-writable', (dir, runs) => chmodSync(path.join(dir, runs[0]!, 'reconciliation-pack.json'), 0o664)],
    ['the newest pair\'s Markdown is group-writable', (dir, runs) => chmodSync(path.join(dir, runs[1]!, 'reconciliation-pack.md'), 0o666)],
    ['the evidence is group-writable', (dir, runs) => chmodSync(path.join(dir, runs[1]!, 'evidence.jsonl'), 0o666)],
    ['a run directory is a symlink', (dir, runs) => { rmSync(path.join(dir, runs[0]!), { recursive: true }); symlinkSync(path.join(dir, runs[1]!), path.join(dir, runs[0]!)) }],
    ['the JSON is a symlink', (dir, runs) => { const json = path.join(dir, runs[1]!, 'reconciliation-pack.json'); const text = readFileSync(json); rmSync(json); writeFileSync(path.join(dir, 'real.json'), text, { mode: 0o600 }); symlinkSync(path.join(dir, 'real.json'), json) }],
    ['the Markdown no longer matches the JSON digest', (dir, runs) => writeFileSync(path.join(dir, runs[1]!, 'reconciliation-pack.md'), 'tampered\n')],
    ['the evidence no longer matches', (dir, runs) => writeFileSync(path.join(dir, runs[1]!, 'evidence.jsonl'), 'tampered\n')],
    ['the JSON is not JSON', (dir, runs) => writeFileSync(path.join(dir, runs[1]!, 'reconciliation-pack.json'), 'not json')],
    ['the JSON says it is another run', (dir, runs) => { const json = path.join(dir, runs[1]!, 'reconciliation-pack.json'); writeFileSync(json, readFileSync(json, 'utf8').replace(runs[1]!, runs[0]!)) }],
    ['a sequence is missing (a gap)', (dir, runs) => rmSync(path.join(dir, runs[0]!), { recursive: true })],
  ]
  for (const [name, prepare] of refused) {
    const read = make(prepare)
    assert.ok('untrusted' in read, `${name}: ${JSON.stringify(read).slice(0, 120)}`)
    if ('untrusted' in read) assert.match(read.untrusted, /\([A-Z_]+\)/, 'the reason is one of the pack\'s closed codes')
  }
})

test('on disk: the digest is taken on the bytes that are parsed - a Markdown changed after the JSON was written is refused, an unchanged one is read', () => {
  const dir = scratch()
  publish(dir, T2)
  const [runId] = runDirs(dir)
  const record = readNewestPackReport(dir)
  assert.ok('record' in record)
  writeFileSync(path.join(dir, runId!, 'reconciliation-pack.md'), `${readFileSync(path.join(dir, runId!, 'reconciliation-pack.md'), 'utf8')}\n`)
  assert.ok('untrusted' in readNewestPackReport(dir))
})

test('on disk and through the gate: a real published P0 report feeds the P0 slots, and another installation\'s report does not', async () => {
  const dir = scratch()
  publish(dir, T2)
  const read = readNewestPackReport(dir)
  assert.ok('record' in read)
  const results = assessPackItems(read, ctx({ phase: 'P0' }))
  assert.deepEqual(['R3', 'R4', 'R15'].map((id) => results[id as PackItemId].kind), ['pass', 'pass', 'pass'])
  assert.equal(results.R1.kind, 'not-available', 'not applicable at P0')
  const elsewhere = assessPackItems(read, ctx({ phase: 'P0', systemIdentifier: '7400000000000000009' }))
  assert.equal(elsewhere.R3.kind, 'unreadable')
  assert.equal(packStreams().length, 6)
})

// ---- R1 (the Mintsoft stock item) maps exactly as R9 does ---------------------------------------------

// [mutation: the VENDOR_READS_OFF reading made specific to R9; UNSETTLED_PENDING for R1 mapped to pass or not-available]
test('R1 is read like R9: VENDOR_READS_OFF alone is not available, an item still settling (UNSETTLED_PENDING, with or without SETTLING_STATE_UNUSABLE) is unreadable, anything else inconclusive is unreadable (a failure maps as for every item, above)', () => {
  const stamp = '2026-10-19T00:00:00.000Z'
  const off = assessPackItem({ record: packRecord('P1', { items: { R1: inconclusive('R1', 'VENDOR_READS_OFF') } }) }, 'R1', ctx())
  assert.equal(off.kind, 'not-available')
  assert.ok(off.kind === 'not-available' && off.reason.includes('--vendor-reads-only'))
  for (const reasons of [['UNSETTLED_PENDING'], ['UNSETTLED_PENDING', 'SETTLING_STATE_UNUSABLE']] as const) {
    const unsettled: ItemInput = { id: 'R1', outcome: 'inconclusive', reasons, entries: { unsettled: [{ key: 'MIL1|129552751', ims: '35', vendor: '36', delta: '-1', imsPresent: true, vendorPresent: true, settling: { sequence: 1, first: stamp, later: [] } }] } }
    const result = assessPackItem({ record: packRecord('P1', { items: { R1: unsettled } }) }, 'R1', ctx())
    assert.equal(result.kind, 'unreadable', reasons.join(','))
    assert.ok(result.kind === 'unreadable' && result.reason.includes('UNSETTLED_PENDING'))
  }
  for (const reason of ['VENDOR_AUTH_REFUSED', 'IDENTITY_CONFLICT', 'VENDOR_READ_UNSTABLE', 'BASIS_MOVED', 'NO_POPULATION_RECORD', 'READ_INCOMPLETE', 'STALE_BASIS', 'NOT_SELECTED'] as const) {
    assert.equal(assessPackItem({ record: packRecord('P1', { items: { R1: inconclusive('R1', reason) } }) }, 'R1', ctx()).kind, 'unreadable', reason)
  }
  assert.equal(assessPackItem({ record: packRecord('P1', { items: { R1: packPass('R1') } }) }, 'R1', ctx()).kind, 'pass')
  assert.equal(itemApplicability('R1', 'P0'), 'not-applicable')
  assert.equal(assessPackItem({ record: packRecord('P1', { items: { R1: packPass('R1') } }) }, 'R1', ctx({ phase: 'P0' })).kind, 'not-available', 'the catalogue says R1 does not apply at P0, whatever the report says')
})
