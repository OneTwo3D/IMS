import assert from 'node:assert/strict'
import test from 'node:test'

import { readAsOfBasis, settleAsOfBasis, type AsOfBasis } from '../../lib/reconciliation-pack/basis.ts'
import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import { identityToken } from '../../lib/reconciliation-pack/identity.ts'
import type { ImsRead, ImsReadOptions, ImsTransitSchedule, TransitNetRow, TransitOrderRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { runLedgerItem, type LedgerItemContext } from '../../lib/reconciliation-pack/ledger-items.ts'
import { buildTransitSchedule, TRANSIT_BALANCE_TOKEN } from '../../lib/reconciliation-pack/transit-schedule.ts'
import { CODES, D, REF_ABSENT, cleanBracket, dateOf, fakeRun, goodState, type FakeState } from './basis-fixtures.ts'

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
function section(over: Partial<ImsTransitSchedule> = {}): ImsTransitSchedule {
  return { asOf: D, coverageStart: '2026-01-01', net: [net('po1', 'PURCHASE_BILL', '80'), net('po1', 'STOCK_RECEIPT', '-30')], customerReturns: '0', orders: [order('po1')], openOrders: [order('po1')], ...over }
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

// [mutation: every order summed, not only the open ones / the refund leg dropped silently]
test('R11 schedules only the OPEN orders: a closed order still holding transit and the refund-in-transit leg are listed out of the population, never judged, and the balance then differs', async () => {
  const closed = order('po2', { status: 'RECEIVED' })
  const { item } = await r11(section({ net: [net('po1', 'PURCHASE_BILL', '80'), net('po1', 'STOCK_RECEIPT', '-30'), net('po2', 'PURCHASE_BILL', '12')], orders: [order('po1'), closed], customerReturns: '4.5' }))
  // the schedule is 50 and so is the stored balance: the listed amounts are not in the account here, so the item passes and shows what it left out
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(keys(item, 'outOfPopulation'), [identityToken('ims-id', 'po2'), 'ledger-transit-customer-return'].sort())
  const listed = Object.fromEntries((item.entries!.outOfPopulation as unknown as Array<{ key: string; ims: string; vendor: string | null }>).map((e) => [e.key, [e.ims, e.vendor]]))
  assert.deepEqual(listed[identityToken('ims-id', 'po2')], ['12', null])
  assert.deepEqual(listed['ledger-transit-customer-return'], ['4.5', null])
  // and when the account does hold them, the schedule (open orders only) is short of the balance: a finding
  const short = await r11(section({ net: [net('po1', 'PURCHASE_BILL', '80'), net('po1', 'STOCK_RECEIPT', '-30'), net('po2', 'PURCHASE_BILL', '12')], orders: [order('po1'), closed] }), goodState({ gl: goodState().gl.map((r) => (r.accountCode === CODES.transit && r.balanceDate.getTime() === dateOf(D).getTime() ? { ...r, amountBase: '62' } : r)) }))
  assert.equal(short.item.outcome, 'fail')
  assert.deepEqual(keys(short.item, 'bothDiffer'), [TRANSIT_BALANCE_TOKEN])
  assert.deepEqual(keys(short.item, 'outOfPopulation'), [identityToken('ims-id', 'po2')])
})

// [mutation: an order's rows from another order's source added, or a row of an unknown order skipped]
test('R11 SCHEDULE BY ORDER: rows are summed per order across source types; an open order with nothing recorded is zero; a non-open order netting to zero is not listed', () => {
  const s = buildTransitSchedule(section({ net: [net('po1', 'PURCHASE_BILL', '10'), net('po1', 'LANDED_COST_RECLASS', '-2.5'), net('po2', 'PURCHASE_BILL', '5'), net('po2', 'STOCK_RECEIPT', '-5'), net('po3', 'SUPPLIER_RETURN', '1')], orders: [order('po1'), order('po2', { status: 'CLOSED' }), order('po3', { status: 'CLOSED' })], openOrders: [order('po1'), order('po4')] }), D)
  assert.ok(s.ok)
  assert.equal(s.value, '7.500000')
  assert.deepEqual(s.listed.map((e) => [e.key[0]!.raw, e.value]), [['po3', '1']])
})

// [mutation: the coverage check removed or weakened to "any watermark"]
test('R11 COVERAGE: the sub-ledger must be recorded as covering every open order; an unrecorded, later-than-D, malformed watermark, or an open order created on or before it, is NO_POPULATION_RECORD, never a short schedule', async () => {
  for (const [label, over] of [
    ['no watermark', { coverageStart: null }],
    ['a watermark after D', { coverageStart: '2026-10-20' }],
    ['an open order created on the watermark day', { coverageStart: '2026-09-01' }],
    ['an open order created before the watermark', { coverageStart: '2026-09-02' }],
    ['an open order with no usable creation instant', { openOrders: [order('po1', { createdAt: 'yesterday' })] }],
  ] as const) {
    const { item } = await r11(section(over))
    assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']], label)
  }
  const ok = await r11(section({ coverageStart: '2026-08-31' }))
  assert.equal(ok.item.outcome, 'pass')
  const atD = await r11(section({ coverageStart: D, openOrders: [order('po1', { createdAt: '2026-10-20T00:00:00.000Z' })] }))
  assert.equal(atD.item.outcome, 'pass')
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
