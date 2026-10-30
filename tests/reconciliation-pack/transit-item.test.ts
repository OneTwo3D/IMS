import assert from 'node:assert/strict'
import test from 'node:test'

import { readAsOfBasis, settleAsOfBasis, type AsOfBasis } from '../../lib/reconciliation-pack/basis.ts'
import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import { identityToken } from '../../lib/reconciliation-pack/identity.ts'
import type { ImsRead, ImsReadOptions, ImsTransitSchedule, TransitNetRow, TransitOrderRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { runLedgerItem, type LedgerItemContext } from '../../lib/reconciliation-pack/ledger-items.ts'
import { TRANSIT_SOURCE_DOCUMENTS } from '../../lib/reconciliation-pack/ims-readers.ts'
import { buildTransitSchedule, TRANSIT_BALANCE_TOKEN } from '../../lib/reconciliation-pack/transit-schedule.ts'
import { CODES, D, REF_ABSENT, REF_PROVEN_ABSENT, cleanBracket, dateOf, fakeRun, goodState, type FakeState } from './basis-fixtures.ts'

/**
 * R11 over the REAL settled basis (the stored transit balance of D is 50 in the shared fixture) and a double of the IMS transit schedule.
 * The mutation each test closes is named above it.
 */

async function settled(state: FakeState = goodState()): Promise<AsOfBasis> {
  const fake = fakeRun(state)
  return settleAsOfBasis(await readAsOfBasis(D, { run: fake.run }), cleanBracket(), { run: fake.run })
}

const order = (id: string, over: Partial<TransitOrderRow> = {}): TransitOrderRow => ({ id, reference: `QBX-${id}`, status: 'PO_SENT', type: 'GOODS', createdAt: '2026-09-01T10:00:00.000Z', ...over })
const net = (poId: string, sourceType: string, amount: string): TransitNetRow => ({ poId, sourceType, net: amount })
/** THE KINDS, written out (not read from the constant under test): the durable source document of every transit source type, the ledger's own rows, and the additional log signal. */
const PRE_KINDS = ['purchase-orders', 'purchase-invoices', 'purchase-receipts', 'purchase-returns', 'supplier-credit-notes', 'landed-cost-links', 'landed-cost-revaluations', 'sales-order-refunds', 'return-expectations', 'subledger-rows', 'sync-log-reversals'] as const
const pre = (over: Record<string, number> = {}): Record<string, number> => ({ ...Object.fromEntries(PRE_KINDS.map((kind) => [kind, 0])), ...over })
function section(over: Partial<ImsTransitSchedule> = {}): ImsTransitSchedule {
  return { asOf: D, coverageStart: '2026-01-01', preWatermark: pre(), net: [net('po1', 'PURCHASE_BILL', '80'), net('po1', 'STOCK_RECEIPT', '-30')], customerReturns: '0', orders: [order('po1')], openOrders: [order('po1')], ...over }
}
function rig(value: ImsTransitSchedule | 'section-error' | 'read-error' | 'throws' | 'no-section') {
  const calls: ImsReadOptions[] = []
  const ims: NonNullable<LedgerItemContext['ims']> = async (options): Promise<ImsRead> => {
    calls.push(options)
    if (value === 'throws') throw new Error('boom')
    if (value === 'read-error') return { ok: false, reason: 'READ_INCOMPLETE' }
    if (value === 'section-error') return { ok: true, snapshotId: '1:2:', sections: { transitSchedule: { ok: false, reason: 'CAP_EXCEEDED' } } }
    if (value === 'no-section') return { ok: true, snapshotId: '1:2:', sections: {} }
    return { ok: true, snapshotId: '1:2:', sections: { transitSchedule: { ok: true, value } } }
  }
  return { calls, ims }
}
const ctx = (over: Partial<LedgerItemContext> = {}): LedgerItemContext => ({ phase: 'P2', asOf: D, ...over })
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key)
const r11 = async (value: Parameters<typeof rig>[0], state: FakeState = goodState()) => {
  const port = rig(value)
  const item = await runLedgerItem('R11', await settled(state), ctx({ ims: port.ims }))
  return { item, port }
}

test('R11 passes when the stored Stock in Transit balance equals the open-order schedule (80 - 30 = 50), naming exactly the catalogue sources and asking IMS for the schedule of the cycle date only', async () => {
  const { item, port } = await r11(section())
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R11').sources])
  assert.deepEqual(keys(item, 'bothEqual'), [TRANSIT_BALANCE_TOKEN])
  assert.equal(identityToken('sku', TRANSIT_BALANCE_TOKEN), TRANSIT_BALANCE_TOKEN)
  const [entry] = item.entries!.bothEqual! as unknown as Array<{ ims: string; vendor: string; imsCurrency: string; delta: string }>
  assert.deepEqual([entry!.ims, entry!.vendor, entry!.imsCurrency, entry!.delta], ['50', '50', 'GBP', '0'])
  assert.deepEqual(port.calls, [{ sections: ['transitSchedule'], asOf: D }])
})

// [mutation: the tolerance changed, or made exclusive]
test('R11 tolerance is GBP 1 INCLUSIVE on either side: 1.00 passes, 1.01 fails; the two implementations of the rule (the pack\'s and the ledger evaluator\'s, which rounds to the penny) must agree, so a gap in the sub-penny sliver above 1.00 is inconclusive, never a pass', async () => {
  for (const [bill, expected] of [['80', 'pass'], ['81', 'pass'], ['79', 'pass'], ['81.01', 'fail'], ['78.99', 'fail'], ['0', 'fail'], ['5000', 'fail']] as const) {
    const { item } = await r11(section({ net: [net('po1', 'PURCHASE_BILL', bill), net('po1', 'STOCK_RECEIPT', '-30')] }))
    assert.equal(item.outcome, expected, bill)
    assert.deepEqual(item.reasons, expected === 'fail' ? ['DIFFERENCES'] : [], bill)
    if (expected === 'fail') assert.deepEqual(keys(item, 'bothDiffer'), [TRANSIT_BALANCE_TOKEN], bill)
  }
  for (const bill of ['81.000001', '78.999999']) {
    const { item } = await r11(section({ net: [net('po1', 'PURCHASE_BILL', bill), net('po1', 'STOCK_RECEIPT', '-30')] }))
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['SOURCE_UNREADABLE']], bill)
  }
})

// [mutation: only the open orders summed / the refund leg dropped / the residue list left out]
test('R11 is the WHOLE sub-ledger: open orders + non-open orders still holding transit + the refund-in-transit leg are compared with the stored balance; the non-open residue is LISTED by identity (not judged) and the refund leg is not listed', async () => {
  const closed = order('po2', { status: 'RECEIVED' })
  const state = (balance: string) => goodState({ gl: goodState().gl.map((r) => (r.accountCode === CODES.transit && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: balance } : r)) })
  const ledger = section({ net: [net('po1', 'PURCHASE_BILL', '80'), net('po1', 'STOCK_RECEIPT', '-30'), net('po2', 'PURCHASE_BILL', '12')], orders: [order('po1'), closed], customerReturns: '4.5' })
  // 50 + 12 + 4.5 = 66.5 is what the account must hold
  const equal = await r11(ledger, state('66.5'))
  assert.equal(equal.item.outcome, 'pass')
  const [entry] = equal.item.entries!.bothEqual! as unknown as Array<{ ims: string; vendor: string }>
  assert.deepEqual([entry!.ims, entry!.vendor], ['66.5', '66.5'])
  assert.deepEqual(keys(equal.item, 'outOfPopulation'), [identityToken('ims-id', 'po2')], 'only the non-open order is listed; the refund leg is part of the total, not a listing')
  const listed = (equal.item.entries!.outOfPopulation as unknown as Array<{ ims: string; vendor: string | null }>)[0]!
  assert.deepEqual([listed.ims, listed.vendor], ['12', null])
  // a balance of only the open orders' 50 is a gap of 16.5: a finding, with the residue visible beside it
  const gap = await r11(ledger, state('50'))
  assert.equal(gap.item.outcome, 'fail')
  assert.deepEqual(keys(gap.item, 'bothDiffer'), [TRANSIT_BALANCE_TOKEN])
  assert.deepEqual(keys(gap.item, 'outOfPopulation'), [identityToken('ims-id', 'po2')])
  // the listing does not change the outcome by itself: the same residue with a balance that matches passes (above); no residue and a gap still fails
  const noResidue = await r11(section({ net: [net('po1', 'PURCHASE_BILL', '80')] }), state('50'))
  assert.equal(noResidue.item.outcome, 'fail')
  assert.deepEqual(keys(noResidue.item, 'outOfPopulation'), [])
})

// [mutation: an order's rows from another order's source added, or a row of an unknown order skipped]
test('R11 SCHEDULE BY ORDER: the total is every order\'s rows summed across source types plus the refund leg; the residue list holds the non-open orders with a non-zero figure only', () => {
  const s = buildTransitSchedule(section({ net: [net('po1', 'PURCHASE_BILL', '10'), net('po1', 'LANDED_COST_RECLASS', '-2.5'), net('po2', 'PURCHASE_BILL', '5'), net('po2', 'STOCK_RECEIPT', '-5'), net('po3', 'SUPPLIER_RETURN', '1')], orders: [order('po1'), order('po2', { status: 'CLOSED' }), order('po3', { status: 'CLOSED' })], openOrders: [order('po1'), order('po4')], customerReturns: '0.25' }), D)
  assert.ok(s.ok)
  assert.equal(s.value, '8.750000')
  assert.deepEqual(s.residue.map((e) => [e.key[0]!.raw, e.value]), [['po3', '1']])
})

// [mutation: any one source kind left out of the check / a kind missing from the section read as zero / only open orders considered]
test('R11 COVERAGE: the watermark must be recorded and on or before D, and NOTHING that can hold unrecorded transit history may predate it - a durable document of EACH source kind (order, bill, receipt, supplier return, credit note, landed-cost link and revaluation, customer refund, return expectation) or a ledger row - else NO_POPULATION_RECORD, even when offsetting amounts make the balance equal the partial ledger', async () => {
  for (const [label, over] of [['no watermark', { coverageStart: null }], ['a watermark after D', { coverageStart: '2026-10-20' }], ['a malformed watermark', { coverageStart: 'soon' }]] as const) {
    const { item } = await r11(section(over))
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']], label)
  }
  for (const kind of PRE_KINDS) {
    const { item } = await r11(section({ preWatermark: pre({ [kind]: 1 }) }))
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']], kind)
  }
  assert.deepEqual(TRANSIT_SOURCE_DOCUMENTS.map((d) => d.kind), [...PRE_KINDS], 'the reader counts exactly these kinds')
  // OFFSETTING HISTORY: a closed pre-watermark order whose bill (before the watermark, unrecorded) was received after it leaves a lone receipt of -30 in the ledger, and an open order
  // holds 80: the ledger sums to 50 and the stored balance is 50, so the comparison would pass on a partial ledger without the guard.
  const offsetting = section({ net: [net('po1', 'PURCHASE_BILL', '80'), net('po9', 'STOCK_RECEIPT', '-30')], orders: [order('po1'), order('po9', { status: 'RECEIVED' })], preWatermark: pre({ 'purchase-orders': 1 }) })
  assert.equal(buildTransitSchedule({ ...offsetting, preWatermark: pre() }, D).ok, true, 'precondition: without the guard the partial ledger is a clean total of 50')
  const guarded = await r11(offsetting)
  assert.deepEqual([guarded.item.outcome, guarded.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  // A purged log is not evidence of absence: the refund's durable record remains while the sync-log signal reads zero
  const purged = await r11(section({ preWatermark: pre({ 'sales-order-refunds': 1, 'sync-log-reversals': 0 }) }))
  assert.deepEqual([purged.item.outcome, purged.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  // a malformed or missing count is unreadable, never zero
  for (const bad of [pre({ 'purchase-orders': -1 }), pre({ 'subledger-rows': 1.5 }), pre({ 'sales-order-refunds': Number.NaN })]) {
    assert.deepEqual((await r11(section({ preWatermark: bad }))).item.reasons, ['SOURCE_UNREADABLE'])
  }
  const missing = pre(); delete missing['return-expectations']
  assert.deepEqual((await r11(section({ preWatermark: missing }))).item.reasons, ['SOURCE_UNREADABLE'])
  assert.deepEqual((await r11(section({ preWatermark: undefined as never }))).item.reasons, ['SOURCE_UNREADABLE'])
  // everything after the watermark passes (the watermark may be the cycle date itself)
  assert.equal((await r11(section({ coverageStart: '2026-08-31' }))).item.outcome, 'pass')
  assert.equal((await r11(section({ coverageStart: D }))).item.outcome, 'pass')
})

// [mutation: the transit/allocated sharing check removed]
test('R11 needs the transit account to be its own: transit on the allocated code leaves no basis; transit sharing with COGS or Unearned is SOURCE_UNREADABLE; nothing is compared', async () => {
  const allocated = goodState()
  allocated.settings.set('xero_transit_account', CODES.allocated)
  const a = await r11(section(), allocated)
  assert.deepEqual([a.item.outcome, a.item.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
  assert.equal(a.port.calls.length, 0, 'no IMS read on a basis that is not usable')
  for (const later of ['xero_cogs_account', 'xero_unearned_revenue_account']) {
    const state = goodState()
    state.settings.set(later, CODES.transit)
    const { item, port } = await r11(section(), state)
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['SOURCE_UNREADABLE']], later)
    assert.equal(port.calls.length, 0, later)
  }
})

// [mutation: an account the trial balance omitted compared as a zero]
test('R11: a transit balance that is the zero the pull synthesised for an account the trial balance omitted is GL_LEG_ABSENT, never a zero compared with an empty schedule', async () => {
  const state = goodState()
  state.gl = state.gl.map((r) => (r.accountCode === CODES.transit ? { ...r, amountBase: '0', sourcePayloadRef: r.balanceDate.getTime() === dateOf(D).getTime() ? REF_ABSENT(D) : r.sourcePayloadRef } : r))
  const { item, port } = await r11(section({ net: [], orders: [], openOrders: [] }), state)
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['GL_LEG_ABSENT']])
  assert.equal(port.calls.length, 0)
})

// [mutation: R11 insisting on trial-balance-row provenance]
test('R11: a transit zero the pull stored under the completeness proof is a real zero and is compared (an empty schedule passes)', async () => {
  const state = goodState()
  state.gl = state.gl.map((r) => (r.accountCode === CODES.transit ? { ...r, amountBase: '0', sourcePayloadRef: r.balanceDate.getTime() === dateOf(D).getTime() ? REF_PROVEN_ABSENT(D) : r.sourcePayloadRef } : r))
  const { item } = await r11(section({ net: [], orders: [], openOrders: [] }), state)
  assert.notDeepEqual(item.reasons, ['GL_LEG_ABSENT'])
  assert.equal(item.outcome, 'pass')
})

// [mutation: the phase check removed / the read made before it]
test('PHASES: R11 is not-applicable at P0 and P1 and reads NOTHING (the IMS port is never called); at P2 it runs', async () => {
  for (const phase of ['P0', 'P1'] as const) {
    const port = rig(section())
    const item = await runLedgerItem('R11', await settled(), ctx({ phase, ims: port.ims }))
    assert.deepEqual([item.outcome, item.reasons], ['not-applicable', ['PHASE_NOT_APPLICABLE']], phase)
    assert.equal(port.calls.length, 0, phase)
  }
  assert.equal((await r11(section())).item.outcome, 'pass')
})

test('R11: an unavailable basis, a basis for another date, no IMS port, a failed or thrown read, a missing or failed section, another date\'s section and bad figures are each inconclusive with a closed reason', async () => {
  const run = (basis: AsOfBasis, over: Partial<LedgerItemContext> = {}) => runLedgerItem('R11', basis, ctx(over))
  const basis = await settled()
  const unavailable = await settled(goodState({ tenant: null }))
  assert.equal((await run(unavailable, { ims: rig(section()).ims })).outcome, 'inconclusive')
  assert.deepEqual((await run({ ...basis, asOf: '2026-10-18' } as AsOfBasis, { ims: rig(section()).ims })).reasons, ['SOURCE_UNREADABLE'])
  assert.deepEqual((await run(basis)).reasons, ['SOURCE_UNREADABLE'])
  for (const [value, reason] of [['read-error', 'READ_INCOMPLETE'], ['section-error', 'CAP_EXCEEDED'], ['no-section', 'SOURCE_UNREADABLE'], ['throws', 'INTERNAL_ERROR']] as const) {
    const item = await run(basis, { ims: rig(value).ims })
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', [reason]], value)
  }
  const bad = async (over: Partial<ImsTransitSchedule>) => (await run(basis, { ims: rig(section(over)).ims })).reasons
  assert.deepEqual(await bad({ asOf: '2026-10-18' }), ['STALE_BASIS'])
  assert.deepEqual(await bad({ net: [net('po1', 'PURCHASE_BILL', 'NaN')] }), ['BAD_VALUE'])
  assert.deepEqual(await bad({ customerReturns: '1e3' }), ['BAD_VALUE'])
  assert.deepEqual(await bad({ net: [net('ghost', 'PURCHASE_BILL', '1')] }), ['BAD_KEY'])
  assert.deepEqual(await bad({ openOrders: [order('po1'), order('po1')] }), ['DUPLICATE_KEY'])
  assert.deepEqual(await bad({ orders: [order('po1'), order('po1')] }), ['DUPLICATE_KEY'])
})
