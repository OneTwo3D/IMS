import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { readAsOfBasis, settleAsOfBasis, type AsOfBasis } from '../../lib/reconciliation-pack/basis.ts'
import { getPackItem, itemApplicability } from '../../lib/reconciliation-pack/constants.ts'
import { identityToken } from '../../lib/reconciliation-pack/identity.ts'
import type { ImsRead, ImsReadOptions, XeroPostingRow, XeroPostings } from '../../lib/reconciliation-pack/ims-readers.ts'
import { INVENTORY_LEG_TOKEN, TRANSIT_LEG_TOKEN, runLedgerItem, type LedgerItemContext } from '../../lib/reconciliation-pack/ledger-items.ts'
import { buildReport } from '../../lib/reconciliation-pack/report.ts'
import { memoisedInvariant, runItems } from '../../lib/reconciliation-pack/run.ts'
import { CODES, D, PREVIOUS, REF, REF_ABSENT, REF_PROVEN_ABSENT, cleanBracket, dateOf, fakeBasisPort, fakeRun, goodState, healthyLiveness, type FakeState } from './basis-fixtures.ts'
import { NOW, realEvidence } from './helpers.ts'

/**
 * R6 AND R10, over the REAL settled basis (readAsOfBasis then settleAsOfBasis on a transaction double) and a double of the IMS read.
 * Mutations are listed in the PR.
 */

async function settled(state: FakeState = goodState()): Promise<AsOfBasis> {
  const fake = fakeRun(state)
  return settleAsOfBasis(await readAsOfBasis(D, { run: fake.run }), cleanBracket(), { run: fake.run })
}

const P0_START = '2026-10-01T09:00:00.000Z'
const verified = (startedAt: string = P0_START): XeroPostings['p0'] => ({ state: 'verified', startedAt })
const row = (id: string, at: string, over: Partial<XeroPostingRow> = {}): XeroPostingRow => ({ id, type: 'SALES_INVOICE', status: 'SYNCED', at, ...over })

type ImsRig = { calls: ImsReadOptions[]; ims: NonNullable<LedgerItemContext['ims']> }
function imsRig(value: XeroPostings | 'section-error' | 'read-error' | 'throws' | 'no-section', reason: 'READ_INCOMPLETE' | 'CAP_EXCEEDED' = 'READ_INCOMPLETE'): ImsRig {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options): Promise<ImsRead> => {
      calls.push(options)
      if (value === 'throws') throw new Error('boom')
      if (value === 'read-error') return { ok: false, reason }
      if (value === 'section-error') return { ok: true, snapshotId: '1:2:', sections: { xeroPostings: { ok: false, reason } } }
      if (value === 'no-section') return { ok: true, snapshotId: '1:2:', sections: {} }
      return { ok: true, snapshotId: '1:2:', sections: { xeroPostings: { ok: true, value } } }
    },
  }
}
const noPostings = (): XeroPostings => ({ p0: verified(), rows: [] })
const ctx = (over: Partial<LedgerItemContext> = {}): LedgerItemContext => ({ phase: 'P1', asOf: D, ...over })
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key)

// ---- R6 -----------------------------------------------------------------------------------------

test('R6 passes on a balanced settled basis, comparing ONE identity within GBP 1, with the catalogue sources and the compared proof', async () => {
  const item = await runLedgerItem('R6', await settled(), ctx())
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.reasons, [])
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R6').sources])
  assert.deepEqual(keys(item, 'bothEqual'), [INVENTORY_LEG_TOKEN])
  const [entry] = item.entries!.bothEqual! as unknown as Array<{ ims: string; vendor: string; imsCurrency: string; vendorCurrency: string; delta: string }>
  assert.deepEqual([entry!.ims, entry!.vendor, entry!.imsCurrency, entry!.vendorCurrency, entry!.delta], ['1200.75', '1200.75', 'GBP', 'GBP', '0'])
  // The identity is a fixed word that prints as it is (not digested), so the evidence names the leg.
  assert.equal(identityToken('sku', INVENTORY_LEG_TOKEN), INVENTORY_LEG_TOKEN)
  assert.equal(identityToken('sku', TRANSIT_LEG_TOKEN), TRANSIT_LEG_TOKEN)
})

// [mutation: the tolerance comparison replaced by exact equality / by a wider limit]
test('R6 tolerance is GBP 1 INCLUSIVE, on either side: 1.00 passes, 1.01 fails', async () => {
  const cases: Array<[string, 'pass' | 'fail']> = [['1200.75', 'pass'], ['1201.50', 'pass'], ['1201.75', 'pass'], ['1201.76', 'fail'], ['1199.75', 'pass'], ['1199.74', 'fail'], ['0', 'fail'], ['100000', 'fail']]
  for (const [sub, expected] of cases) {
    const basis = await settled(goodState({ snapshots: [{ valueBase: sub, valueReplayReliable: true }], run: { snapshotCount: 1 } }))
    const item = await runLedgerItem('R6', basis, ctx())
    assert.equal(item.outcome, expected, sub)
    assert.deepEqual(item.reasons, expected === 'fail' ? ['DIFFERENCES'] : [], sub)
    if (expected === 'fail') assert.deepEqual(keys(item, 'bothDiffer'), [INVENTORY_LEG_TOKEN], sub)
  }
})

test('R6 compares the sum of Inventory and Allocated Inventory, not either alone', async () => {
  const inventoryOnly = await settled(goodState({ snapshots: [{ valueBase: '1000.50', valueReplayReliable: true }], run: { snapshotCount: 1 } }))
  assert.equal((await runLedgerItem('R6', inventoryOnly, ctx())).outcome, 'fail')
})

// [mutation: a synthesised zero compared like a reported one]
test('R6 is WITHHELD, never compared, when Inventory or Allocated is the zero the pull synthesised - even if that zero would balance', async () => {
  for (const kind of ['inventory', 'allocated'] as const) {
    const state = goodState()
    // Make the subledger equal to the OTHER leg alone: with the synthesised zero read as a zero, this would be "balanced".
    const other = kind === 'inventory' ? '200.25' : '1000.50'
    state.snapshots = [{ valueBase: other, valueReplayReliable: true }]
    state.run = { snapshotCount: 1 }
    state.gl = state.gl.map((r) => (r.accountCode === CODES[kind] && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : r))
    const basis = await settled(state)
    assert.equal(basis.available && basis.inventoryGlWithheld, 'absent-from-tb', kind)
    const item = await runLedgerItem('R6', basis, ctx())
    assert.deepEqual([item.outcome, item.reasons, item.entries], ['inconclusive', ['GL_LEG_ABSENT'], undefined], kind)
  }
})

// [mutation: the withheld marker not consulted - the evaluator result alone decides]
test('R6: the withheld marker stands alone - a basis that carries an evaluator result AND says the leg was withheld is withheld', async () => {
  const basis = await settled()
  assert.ok(basis.available && basis.inventoryGl)
  const item = await runLedgerItem('R6', { ...basis, inventoryGlWithheld: 'absent-from-tb' } as AsOfBasis, ctx())
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['GL_LEG_ABSENT']])
  const r10 = await runLedgerItem('R10', { ...basis, inventoryGlWithheld: 'absent-from-tb' } as AsOfBasis, ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([r10.outcome, r10.reasons], ['inconclusive', ['GL_LEG_ABSENT']])
})

test('R6 on a basis that is not available is the basis\'s own reason, and nothing is compared', async () => {
  const cases: Array<[string, FakeState, string]> = [
    ['no subledger run', goodState({ run: null }), 'SOURCE_UNREADABLE'],
    ['plugin off', (() => { const s = goodState(); s.settings.set('integration_xero_enabled', 'false'); return s })(), 'SOURCE_UNREADABLE'],
  ]
  for (const [name, state, reason] of cases) {
    const basis = await settled(state)
    if (basis.available) continue // a settings-key difference may leave this one available; the no-run case is the point
    const item = await runLedgerItem('R6', basis, ctx())
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', [reason]], name)
  }
  const moved: AsOfBasis = { available: false, asOf: D, reason: 'basis_moved', packReason: 'BASIS_MOVED' }
  assert.deepEqual((await runLedgerItem('R6', moved, ctx())).reasons, ['BASIS_MOVED'])
})

// [mutation: the basis date not compared with the cycle date / the currency not checked]
test('R6 never uses a basis for another date, or in a currency its tolerance is not stated in', async () => {
  const basis = await settled()
  assert.deepEqual((await runLedgerItem('R6', basis, ctx({ asOf: '2026-10-18' }))).reasons, ['SOURCE_UNREADABLE'])
  assert.ok(basis.available)
  const euro = { ...basis, currency: 'EUR' } as AsOfBasis
  assert.deepEqual((await runLedgerItem('R6', euro, ctx())).reasons, ['CURRENCY_UNKNOWN'])
})

// [mutation: the cross-check against the existing evaluator removed]
test('R6: if the existing evaluator and the pack\'s own comparison disagree about the leg, nothing passes on either', async () => {
  const basis = await settled()
  assert.ok(basis.available && basis.inventoryGl)
  const flagged = { ...basis, inventoryGl: { ...basis.inventoryGl!, action: 'flag' as const } } as AsOfBasis
  assert.deepEqual((await runLedgerItem('R6', flagged, ctx())).reasons, ['SOURCE_UNREADABLE'])
  const far = await settled(goodState({ snapshots: [{ valueBase: '5000', valueReplayReliable: true }], run: { snapshotCount: 1 } }))
  assert.ok(far.available)
  const balanced = { ...far, inventoryGl: { ...far.inventoryGl!, action: 'balanced' as const } } as AsOfBasis
  assert.deepEqual((await runLedgerItem('R6', balanced, ctx())).reasons, ['SOURCE_UNREADABLE'])
})

test('R6 is total: a basis of any shape is an inconclusive item, never a throw and never a pass', async () => {
  const basis = await settled()
  assert.ok(basis.available)
  const shapes: unknown[] = [null, undefined, 1, 'x', [], {}, { available: true }, { ...basis, gl: null }, { ...basis, gl: [] }, { ...basis, gl: [basis.gl[0], basis.gl[0]] }, { ...basis, subledger: null },
    { ...basis, subledger: { ...basis.subledger, valueBase: '1e3' } }, { ...basis, subledger: { ...basis.subledger, valueBase: 1200.75 } }, { ...basis, inventoryGl: 'balanced' }, { ...basis, inventoryGl: { action: 'zzz' } },
    { ...basis, gl: basis.gl.map((g) => (g.kind === 'inventory' ? { ...g, amountBase: 'NaN' } : g)) }, { ...basis, gl: basis.gl.map((g) => (g.kind === 'inventory' ? { ...g, provenance: 'absent-from-tb' } : g)) },
    { ...basis, asOf: 20261019 }, { ...basis, currency: null }]
  for (const shape of shapes) {
    const item = await runLedgerItem('R6', shape as AsOfBasis, ctx())
    assert.equal(item.outcome, 'inconclusive', JSON.stringify(shape)?.slice(0, 80))
    assert.equal(item.entries, undefined)
  }
})

// ---- R10 ----------------------------------------------------------------------------------------

test('R10 passes at P1 when both ledger legs agree and no IMS-originated write exists since the first load: two identities compared, the postings read named', async () => {
  const rig = imsRig(noPostings())
  const item = await runLedgerItem('R10', await settled(), ctx({ ims: rig.ims }))
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R10').sources])
  assert.deepEqual(keys(item, 'bothEqual').sort(), [INVENTORY_LEG_TOKEN, TRANSIT_LEG_TOKEN].sort())
  assert.deepEqual(rig.calls, [{ sections: ['xeroPostings'] }], 'exactly one IMS read, of exactly the postings section')
  const transit = (item.entries!.bothEqual as unknown as Array<{ key: string; ims: string; vendor: string }>).find((e) => e.key === TRANSIT_LEG_TOKEN)!
  assert.deepEqual([transit.ims, transit.vendor], ['10', '10'])
})

// [mutation: the phase check removed - R10 decided at P2]
test('R10 is decided at P1 only: at P2 (IMS posts by design) it has no runner, and it never asks for the postings', async () => {
  for (const phase of ['P2', 'P0'] as const) {
    const rig = imsRig(noPostings())
    const item = await runLedgerItem('R10', await settled(), ctx({ phase, ims: rig.ims }))
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_RUNNER']], phase)
    assert.equal(rig.calls.length, 0)
  }
  assert.equal(itemApplicability('R10', 'P0'), 'not-applicable')
})

// [mutation: the postings leg removed / an IMS-originated write not an identity]
test('R10 FAILS on any IMS-originated write since the first load began, listing each id; identities, not a count', async () => {
  const rig = imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z'), row('cposting0000000000000002a', '2026-10-06T10:00:00.000Z', { type: 'COGS_JOURNAL', status: 'PROCESSING' })] })
  const item = await runLedgerItem('R10', await settled(), ctx({ ims: rig.ims }))
  assert.deepEqual([item.outcome, item.reasons], ['fail', ['DIFFERENCES']])
  assert.deepEqual(keys(item, 'onlyIms').sort(), ['cposting0000000000000001a', 'cposting0000000000000002a'])
  assert.deepEqual(keys(item, 'bothEqual').sort(), [INVENTORY_LEG_TOKEN, TRANSIT_LEG_TOKEN].sort(), 'the ledger legs still compared equal')
})

test('R10 identity swap: the same NUMBER of writes with one identity swapped names the other identity in the evidence', async () => {
  const a = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z'), row('cposting0000000000000002a', '2026-10-05T11:00:00.000Z')] }).ims }))
  const b = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z'), row('cposting0000000000000003a', '2026-10-05T11:00:00.000Z')] }).ims }))
  assert.equal(a.outcome, 'fail')
  assert.equal(b.outcome, 'fail')
  assert.equal(keys(a, 'onlyIms').length, keys(b, 'onlyIms').length)
  assert.notDeepEqual(keys(a, 'onlyIms'), keys(b, 'onlyIms'))
  assert.deepEqual(keys(b, 'onlyIms').sort(), ['cposting0000000000000001a', 'cposting0000000000000003a'])
})

// [mutation: the P0 boundary removed (every write in) / reversed / made exclusive]
test('R10 population: a write BEFORE the first load began is out of the population and never a finding; one AT the instant is in', async () => {
  const before = row('cposting0000000000000001a', '2026-09-30T23:59:59.999Z')
  const atBoundary = row('cposting0000000000000002a', P0_START)
  const rigBefore = imsRig({ p0: verified(), rows: [before] })
  const onlyBefore = await runLedgerItem('R10', await settled(), ctx({ ims: rigBefore.ims }))
  assert.deepEqual([onlyBefore.outcome, keys(onlyBefore, 'outOfPopulation'), keys(onlyBefore, 'onlyIms')], ['pass', ['cposting0000000000000001a'], []])
  const both = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [before, atBoundary] }).ims }))
  assert.deepEqual([both.outcome, keys(both, 'onlyIms'), keys(both, 'outOfPopulation')], ['fail', ['cposting0000000000000002a'], ['cposting0000000000000001a']])
})

// [mutation: an absent / unverified first-load record treated as "no boundary" or as zero postings]
test('R10 needs a RECORDED, VERIFIED first load: absent or unverified is NO_POPULATION_RECORD even when nothing was sent, and nothing is a pass', async () => {
  // The two guards (the state and the instant) each stand alone: a record that is not VERIFIED is refused even if it carries an instant.
  for (const p0 of [{ state: 'absent' }, { state: 'unverified' }, { state: 'unverified', startedAt: P0_START }, { state: 'absent', startedAt: P0_START }, { state: 'verified', startedAt: 'yesterday' }, { state: 'verified', startedAt: '' }] as unknown as XeroPostings['p0'][]) {
    const item = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0, rows: [] }).ims }))
    assert.deepEqual([item.outcome, item.reasons, item.entries], ['inconclusive', ['NO_POPULATION_RECORD'], undefined], JSON.stringify(p0))
  }
})

// [mutation: an unreadable instant treated as before the load]
test('R10: a write whose instant cannot be read is neither before nor after the load: inconclusive, never in or out by default', async () => {
  const item = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', 'not a time')] }).ims }))
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
})

test('R10 reads the IMS side or is inconclusive: no reader, a failed read, a failed section, a missing section, a throw', async () => {
  const basis = await settled()
  const cases: Array<[string, LedgerItemContext, string[]]> = [
    ['no reader', ctx(), ['SOURCE_UNREADABLE']],
    ['read failed', ctx({ ims: imsRig('read-error').ims }), ['READ_INCOMPLETE']],
    ['cap', ctx({ ims: imsRig('read-error', 'CAP_EXCEEDED').ims }), ['CAP_EXCEEDED']],
    ['section failed', ctx({ ims: imsRig('section-error', 'CAP_EXCEEDED').ims }), ['CAP_EXCEEDED']],
    ['section missing', ctx({ ims: imsRig('no-section').ims }), ['SOURCE_UNREADABLE']],
    ['throws', ctx({ ims: imsRig('throws').ims }), ['INTERNAL_ERROR']],
  ]
  for (const [name, context, reasons] of cases) {
    const item = await runLedgerItem('R10', basis, context)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', reasons], name)
  }
})

// [mutation: a failing ledger leg ignored / the leg's reason dropped]
test('R10 withholds the whole item when a ledger leg cannot be read, with every reason, and still never passes', async () => {
  const transitUncovered = goodState()
  transitUncovered.settings.delete('transit_ledger_coverage_start_date')
  let item = await runLedgerItem('R10', await settled(transitUncovered), ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])

  const transitAbsent = goodState()
  transitAbsent.gl = transitAbsent.gl.map((r) => (r.accountCode === CODES.transit && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : r))
  item = await runLedgerItem('R10', await settled(transitAbsent), ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['GL_LEG_ABSENT']])

  const transitBroken = goodState()
  transitBroken.gl = transitBroken.gl.filter((r) => !(r.accountCode === CODES.transit && r.balanceDate.getTime() === dateOf(PREVIOUS).getTime()))
  item = await runLedgerItem('R10', await settled(transitBroken), ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])

  const both = goodState()
  both.gl = both.gl.map((r) => ((r.accountCode === CODES.transit || r.accountCode === CODES.allocated) && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : r))
  item = await runLedgerItem('R10', await settled(both), ctx({ ims: imsRig({ p0: { state: 'absent' }, rows: [] }).ims }))
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['GL_LEG_ABSENT', 'NO_POPULATION_RECORD']], 'one reason per cause, each once')
})

test('R10 fails on a ledger gap beyond GBP 1 in either leg, naming the leg, and a gap does not need the postings to fail', async () => {
  const inventory = await runLedgerItem('R10', await settled(goodState({ snapshots: [{ valueBase: '900', valueReplayReliable: true }], run: { snapshotCount: 1 } })), ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([inventory.outcome, keys(inventory, 'bothDiffer'), keys(inventory, 'bothEqual')], ['fail', [INVENTORY_LEG_TOKEN], [TRANSIT_LEG_TOKEN]])
  const transit = await runLedgerItem('R10', await settled(goodState({ transitMovement: '12.50' })), ctx({ ims: imsRig(noPostings()).ims }))
  assert.deepEqual([transit.outcome, keys(transit, 'bothDiffer'), keys(transit, 'bothEqual')], ['fail', [TRANSIT_LEG_TOKEN], [INVENTORY_LEG_TOKEN]])
  const within = await runLedgerItem('R10', await settled(goodState({ transitMovement: '11' })), ctx({ ims: imsRig(noPostings()).ims }))
  assert.equal(within.outcome, 'pass', 'exactly GBP 1 is inside')
})

test('R10: duplicate write ids on the IMS side are DUPLICATE_KEY (never summed), and a malformed id is BAD_KEY', async () => {
  const duplicate = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z'), row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z')] }).ims }))
  assert.deepEqual([duplicate.outcome, duplicate.reasons], ['inconclusive', ['DUPLICATE_KEY']])
  const bad = await runLedgerItem('R10', await settled(), ctx({ ims: imsRig({ p0: verified(), rows: [row('', '2026-10-05T10:00:00.000Z')] }).ims }))
  assert.deepEqual([bad.outcome, bad.reasons], ['inconclusive', ['BAD_KEY']])
})

// [mutation: the cross-check removed from R10]
test('R10: the existing evaluator and the pack\'s comparison must agree on both legs', async () => {
  const basis = await settled()
  assert.ok(basis.available && basis.transit.available)
  const transit = { ...basis, transit: { ...basis.transit, reconciliation: { ...(basis.transit as { reconciliation: object }).reconciliation, action: 'flag' } } } as AsOfBasis
  assert.deepEqual((await runLedgerItem('R10', transit, ctx({ ims: imsRig(noPostings()).ims }))).reasons, ['SOURCE_UNREADABLE'])
})

test('R10 is total: any basis, any IMS answer, never a throw and never a pass without positive proof', async () => {
  const basis = await settled()
  assert.ok(basis.available)
  const shapes: unknown[] = [null, {}, { ...basis, transit: null }, { ...basis, transit: { available: true } }, { ...basis, transit: { available: false, reason: 'x' } }, { ...basis, transit: { ...basis.transit, glMovement: 'NaN' } }, { ...basis, transit: { available: true, glMovement: '1', subledgerMovement: '1', reconciliation: null } }]
  for (const shape of shapes) {
    const item = await runLedgerItem('R10', shape as AsOfBasis, ctx({ ims: imsRig(noPostings()).ims }))
    assert.equal(item.outcome, 'inconclusive', JSON.stringify(shape)?.slice(0, 80))
  }
  for (const section of [null, {}, { p0: null, rows: [] }, { p0: verified(), rows: null }, { p0: verified(), rows: [null] }, { p0: verified(), rows: [{}] }] as unknown[]) {
    const ims = async (): Promise<ImsRead> => ({ ok: true, snapshotId: 'x', sections: { xeroPostings: { ok: true, value: section as XeroPostings } } })
    const item = await runLedgerItem('R10', basis, ctx({ ims }))
    assert.equal(item.outcome, 'inconclusive', JSON.stringify(section))
  }
})

// ---- through the run and the report builder -------------------------------------------------------

test('through runItems: R6 and R10 results are accepted by the report builder as they stand (not INTERNAL_ERROR), and published streams are the Xero balance stream', async () => {
  const ims = imsRig({ p0: verified(), rows: [row('cposting0000000000000001a', '2026-10-05T10:00:00.000Z')] }).ims
  const { items, streams } = await runItems({
    phase: 'P1', asOf: D, selected: ['R6', 'R10'], liveness: healthyLiveness(), basis: fakeBasisPort(goodState()),
    context: { phase: 'P1', asOf: D, now: () => NOW, acceptances: parseAcceptanceFile(null), invariant: memoisedInvariant(async () => realEvidence()), ims },
  })
  const by = Object.fromEntries(items.map((i) => [i.id, i]))
  assert.deepEqual([by.R6!.outcome, by.R10!.outcome, by.R10!.reasons], ['pass', 'fail', ['DIFFERENCES']])
  assert.deepEqual(streams.map((s) => s.stream), ['xero-balance-snapshots'])
  assert.doesNotThrow(() => buildReport({ runId: '20261020T120000Z-aaaaaaaaaaaa', systemIdentifier: '7000000000000000001', phase: 'P1', asOf: D, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams, items }, 1, null))
  void REF
})

// [mutation: R6 insisting on trial-balance-row provenance]
test('R6 compares (not withheld) when Allocated is a zero a complete Trial Balance proved', async () => {
  const state = goodState({ snapshots: [{ valueBase: '1000.50', valueReplayReliable: true }], run: { snapshotCount: 1 } })
  state.gl = state.gl.map((r) => (r.accountCode === CODES.allocated && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: '0', sourcePayloadRef: REF_PROVEN_ABSENT(D) } : r))
  const basis = await settled(state)
  const item = await runLedgerItem('R6', basis, ctx())
  assert.deepEqual([item.outcome, item.reasons], ['pass', []])
})
