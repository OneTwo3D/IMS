import assert from 'node:assert/strict'
import test from 'node:test'

import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsRead, ImsReadOptions, SnapshotValueRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { runQoblexItem } from '../../lib/reconciliation-pack/qoblex-items.ts'
import type { QoblexLocation } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { ASOF, LOCATIONS, lot, sourceOf } from './qoblex-fixtures.ts'

/**
 * R2 AND R5 over doubles of the IMS read and of the Qoblex source. Mutations are listed in the PR.
 */

const wid = (code: string) => `w-${code}`
const pid = (sku: string) => `p-${sku}`
type Snap = { sku: string; code: string; qty: string; value?: string; reliable?: boolean }
type Fixture = {
  snaps?: Snap[]
  warehouses?: string[]
  bindings?: string[]
  skus?: string[]
  run?: boolean
  fail?: Partial<Record<'snapshots' | 'products' | 'warehouses' | 'wmsBindings', 'READ_INCOMPLETE'>>
  whole?: 'fail'
}
function ims(fixture: Fixture = {}) {
  const calls: ImsReadOptions[] = []
  const snaps = fixture.snaps ?? []
  const skus = fixture.skus ?? [...new Set(snaps.map((s) => s.sku))]
  const values: Record<string, unknown> = {
    snapshots: {
      asOf: ASOF,
      run: fixture.run === false ? null : { stockLevelCount: snaps.length, snapshotCount: snaps.length },
      values: snaps.map((s): SnapshotValueRow => ({ productId: pid(s.sku), warehouseId: wid(s.code), qty: s.qty, valueBase: s.value ?? '0', valueReplayReliable: s.reliable !== false })),
      balances: [],
    },
    products: skus.map((sku) => ({ id: pid(sku), sku, type: 'SIMPLE', active: true, lifecycleStatus: 'ACTIVE' })),
    warehouses: (fixture.warehouses ?? ['MIL1', 'CAMBRIDGE', 'RXT2']).map((code) => ({ id: wid(code), code, active: true })),
    wmsBindings: (fixture.bindings ?? []).map((code) => ({ connector: 'x', warehouseId: wid(code), warehouseCode: code, externalWarehouseId: '1', active: true, stockSyncMode: 'NOTIFICATION_ONLY', alignmentConfirmed: false })),
  }
  const port = async (options: ImsReadOptions): Promise<ImsRead> => {
    calls.push(options)
    if (fixture.whole === 'fail') return { ok: false, reason: 'READ_INCOMPLETE' }
    const sections: Record<string, unknown> = {}
    for (const name of options.sections) {
      const failure = fixture.fail?.[name as keyof NonNullable<Fixture['fail']>]
      sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: (values as Record<string, unknown>)[name] }
    }
    return { ok: true, snapshotId: '1:2:', sections } as ImsRead
  }
  return { calls, port }
}
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key).sort()

const run2 = (id: 'R2' | 'R5', stock: ReturnType<typeof lot>[], fixture: Fixture, locations?: readonly QoblexLocation[]) => {
  const port = ims(fixture)
  const counter = { reads: 0 }
  return runQoblexItem(id, { asOf: ASOF, ims: port.port, qoblex: sourceOf({ stock, locations }, counter) }).then((item) => ({ item, port, counter }))
}

// ---- R2 -----------------------------------------------------------------------------------------

test('R2 passes when the non-3PL positions agree exactly, naming both sources; a 3PL location in the file is set aside', async () => {
  const { item, port } = await run2('R2', [lot('SKU-1', 'MIL1', '10'), lot('SKU-2', 'CAMBRIDGE', '4'), lot('SKU-3', 'RXT2', '7')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }, { sku: 'SKU-2', code: 'CAMBRIDGE', qty: '4' }] })
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R2').sources])
  assert.deepEqual(keys(item, 'bothEqual'), ['SKU-1|MIL1', 'SKU-2|CAMBRIDGE'])
  // the snapshot is asked for the cycle date, and for nothing else the item does not use
  assert.equal(port.calls.length, 1)
  assert.equal(port.calls[0]!.asOf, ASOF)
  assert.deepEqual([...port.calls[0]!.sections].sort(), ['products', 'snapshots', 'warehouses', 'wmsBindings'])
})

// [mutation: comparison by total instead of by identity / the warehouse dropped from the key]
test('R2 IDENTITY SWAP: the same quantities in the other warehouse, or under the other SKU, are two findings, never equal', async () => {
  const stock = [lot('SKU-1', 'MIL1', '10'), lot('SKU-2', 'CAMBRIDGE', '4')]
  const swappedWarehouse = await run2('R2', stock, { snaps: [{ sku: 'SKU-1', code: 'CAMBRIDGE', qty: '10' }, { sku: 'SKU-2', code: 'MIL1', qty: '4' }] })
  assert.equal(swappedWarehouse.item.outcome, 'fail')
  assert.deepEqual(swappedWarehouse.item.reasons, ['DIFFERENCES'])
  assert.deepEqual(keys(swappedWarehouse.item, 'onlyIms'), ['SKU-1|CAMBRIDGE', 'SKU-2|MIL1'])
  assert.deepEqual(keys(swappedWarehouse.item, 'onlyVendor'), ['SKU-1|MIL1', 'SKU-2|CAMBRIDGE'])
  const swappedSku = await run2('R2', stock, { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '4' }, { sku: 'SKU-2', code: 'CAMBRIDGE', qty: '10' }] })
  assert.equal(swappedSku.item.outcome, 'fail')
  assert.equal(keys(swappedSku.item, 'bothDiffer').length, 2)
})

// [mutation: the exact tolerance widened]
test('R2 is exact to the stored precision: 0.0001 is equal (inclusive), 0.0002 is not', async () => {
  const at = async (ims_: string) => (await run2('R2', [lot('SKU-1', 'MIL1', '10')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: ims_ }] })).item
  assert.equal((await at('10')).outcome, 'pass')
  assert.equal((await at('10.0001')).outcome, 'pass')
  const off = await at('10.0002')
  assert.equal(off.outcome, 'fail')
  assert.deepEqual(keys(off, 'bothDiffer'), ['SKU-1|MIL1'])
  assert.equal((await at('9')).outcome, 'fail')
})

// [mutation: zero rows kept on one side]
test('R2: a zero position and no position are the same; a non-zero IMS position that Qoblex lacks (and the reverse) is a finding', async () => {
  const zero = await run2('R2', [lot('SKU-1', 'MIL1', '10'), lot('SKU-2', 'MIL1', '0')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }, { sku: 'SKU-3', code: 'MIL1', qty: '0' }] })
  assert.equal(zero.item.outcome, 'pass')
  assert.deepEqual(keys(zero.item, 'bothEqual'), ['SKU-1|MIL1'])
  const extra = await run2('R2', [lot('SKU-1', 'MIL1', '10')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }, { sku: 'SKU-9', code: 'MIL1', qty: '1' }] })
  assert.deepEqual(keys(extra.item, 'onlyIms'), ['SKU-9|MIL1'])
  const missing = await run2('R2', [lot('SKU-1', 'MIL1', '10'), lot('SKU-8', 'MIL1', '2')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }] })
  assert.deepEqual(keys(missing.item, 'onlyVendor'), ['SKU-8|MIL1'])
  assert.deepEqual(missing.item.reasons, ['DIFFERENCES'])
})

test('R2 sums the lots of one position and compares the sum; negative stock is compared as it is', async () => {
  const lots = await run2('R2', [lot('SKU-1', 'MIL1', '4', '1', { lotRef: 'A' }), lot('SKU-1', 'MIL1', '6', '1', { lotRef: 'B' }), lot('SKU-2', 'MIL1', '-3')], { snaps: [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }, { sku: 'SKU-2', code: 'MIL1', qty: '-3' }] })
  assert.equal(lots.item.outcome, 'pass')
})

// [mutation: the empty-proof removed / given without the run row]
test('R2: everything zero on both sides passes only on the snapshot run row; with no run row it is SNAPSHOT_UNAVAILABLE', async () => {
  const zero = await run2('R2', [lot('SKU-1', 'MIL1', '0')], { snaps: [] })
  assert.equal(zero.item.outcome, 'pass')
  assert.deepEqual(zero.item.proof, { kind: 'proven-empty', source: 'snapshot-run-row-present' })
  const noRun = await run2('R2', [lot('SKU-1', 'MIL1', '0')], { snaps: [], run: false })
  assert.deepEqual([noRun.item.outcome, noRun.item.reasons], ['inconclusive', ['SNAPSHOT_UNAVAILABLE']])
})

// [mutation: the location resolution / WMS-binding check removed]
test('R2 location mapping fails closed: a declared non-3PL location IMS does not hold, or holds as a 3PL\'s, is NO_POPULATION_RECORD; so is a manifest with no non-3PL location', async () => {
  const stock = [lot('SKU-1', 'MIL1', '10')]
  const snaps = [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }]
  const unknown = await run2('R2', stock, { snaps, warehouses: ['CAMBRIDGE'] })
  assert.deepEqual([unknown.item.outcome, unknown.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  const bound = await run2('R2', stock, { snaps, bindings: ['MIL1'] })
  assert.deepEqual([bound.item.outcome, bound.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
  const bound3pl = await run2('R2', stock, { snaps, bindings: ['RXT2'] })
  assert.equal(bound3pl.item.outcome, 'pass', 'a binding on a warehouse that is declared 3PL is consistent')
  const allThreePl = await run2('R2', stock, { snaps }, LOCATIONS.map((l) => ({ ...l, threePl: true })))
  assert.deepEqual([allThreePl.item.outcome, allThreePl.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']])
})

test('R2 snapshot problems: a product or warehouse the snapshot names that IMS does not hold, a failed section or read, is a closed reason', async () => {
  const stock = [lot('SKU-1', 'MIL1', '10')]
  const snaps = [{ sku: 'SKU-1', code: 'MIL1', qty: '10' }]
  const noProduct = await run2('R2', stock, { snaps, skus: [] })
  assert.deepEqual(noProduct.item.reasons, ['SNAPSHOT_UNAVAILABLE'])
  const section = await run2('R2', stock, { snaps, fail: { snapshots: 'READ_INCOMPLETE' } })
  assert.deepEqual([section.item.outcome, section.item.reasons], ['inconclusive', ['READ_INCOMPLETE']])
  const whole = await run2('R2', stock, { snaps, whole: 'fail' })
  assert.deepEqual([whole.item.outcome, whole.item.reasons], ['inconclusive', ['READ_INCOMPLETE']])
})

// [mutation: the Qoblex source failure ignored / read before the opt-in is checked]
test('R2 and R5 with no export named read NOTHING (QOBLEX_EXPORT_OFF); an unreadable export is its closed reason and IMS is not read', async () => {
  for (const id of ['R2', 'R5'] as const) {
    const port = ims()
    const off = await runQoblexItem(id, { asOf: ASOF, ims: port.port })
    assert.deepEqual([off.outcome, off.reasons, off.sources ?? []], ['inconclusive', ['QOBLEX_EXPORT_OFF'], []])
    assert.equal(port.calls.length, 0)
    const stale = await runQoblexItem(id, { asOf: ASOF, ims: port.port, qoblex: sourceOf({ ok: false, reason: 'QOBLEX_EXPORT_STALE' }) })
    assert.deepEqual([stale.outcome, stale.reasons], ['inconclusive', ['QOBLEX_EXPORT_STALE']])
    assert.equal(port.calls.length, 0)
    const part = await runQoblexItem(id, { asOf: ASOF, ims: port.port, qoblex: sourceOf({ stock: 'fail' }) })
    assert.deepEqual([part.outcome, part.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
    const throws = await runQoblexItem(id, { asOf: ASOF, ims: port.port, qoblex: { read: async () => { throw new Error('boom') } } })
    assert.deepEqual([throws.outcome, throws.reasons], ['inconclusive', ['INTERNAL_ERROR']])
  }
})

// ---- R5 -----------------------------------------------------------------------------------------

const snapV = (sku: string, code: string, value: string, over: Partial<Snap> = {}): Snap => ({ sku, code, qty: '1', value, ...over })
const r5 = (stock: Parameters<typeof run2>[1], snaps: Snap[], locations?: readonly QoblexLocation[], fixture: Fixture = {}) => run2('R5', stock, { snaps, ...fixture }, locations)

test('R5 passes when each warehouse and each company agrees, and names both sources', async () => {
  // SKU-1 qty 10 x 2.5 = 25 in MIL1; SKU-2 qty 4 x 10 = 40 in CAMBRIDGE; one company holds both
  const { item } = await r5([lot('SKU-1', 'MIL1', '10', '2.5'), lot('SKU-2', 'CAMBRIDGE', '4', '10'), lot('SKU-3', 'RXT2', '7', '1')], [snapV('SKU-1', 'MIL1', '25'), snapV('SKU-2', 'CAMBRIDGE', '40')])
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.sources, [...getPackItem('R5').sources])
  assert.deepEqual(keys(item, 'bothEqual'), ['COMPANY|ACME', 'CAMBRIDGE', 'MIL1'].sort())
  assert.deepEqual(keys(item, 'outOfPopulation'), [])
})

// [mutation: the floor or the fraction changed, the base changed from the larger total, the boundary made exclusive]
test('R5 composite boundary: max(GBP 1, 0.05% of the larger total), inclusive; one penny past fails', async () => {
  const at = async (qobValue: string, imsValue: string) => {
    const { item } = await r5([lot('SKU-1', 'MIL1', '1', qobValue)], [snapV('SKU-1', 'MIL1', imsValue)], [{ code: 'MIL1', company: 'ACME', threePl: false }])
    return item
  }
  // the floor: totals near 100, limit is GBP 1
  assert.equal((await at('100', '101')).outcome, 'pass')
  assert.equal((await at('101', '100')).outcome, 'pass')
  const penny = await at('100', '101.01')
  assert.equal(penny.outcome, 'fail')
  assert.deepEqual(keys(penny, 'bothDiffer'), ['COMPANY|ACME', 'MIL1'])
  // the relative rule: larger total 20000, limit 0.05% = 10 exactly (10 > 1)
  assert.equal((await at('20000', '19990')).outcome, 'pass', 'exactly at 0.05% of the larger')
  assert.equal((await at('20000', '19989.99')).outcome, 'fail', 'one penny past')
  assert.equal((await at('19990', '20000')).outcome, 'pass', 'symmetric: the larger is the base on either side')
  assert.equal((await at('19989.99', '20000')).outcome, 'fail')
  // the base is the LARGER, not the smaller (the smaller would give 9.995 and fail 10)
  assert.equal((await at('20000', '19990')).outcome, 'pass')
})

// [mutation: the per-SKU list affects the outcome / uses the wrong base or an inclusive comparison]
test('R5 lists every (SKU, warehouse) differing by MORE than 0.5% of the larger, under outOfPopulation, and the list never decides', async () => {
  const one: QoblexLocation[] = [{ code: 'MIL1', company: 'ACME', threePl: false }]
  // Totals: IMS 1400.4, Qoblex 1400.01 (inside GBP 1). SKU-B differs by exactly 0.5% of 200 (not more), SKU-C by 1.01 of 201.01 (more).
  const { item } = await r5(
    [lot('SKU-A', 'MIL1', '1', '1000'), lot('SKU-B', 'MIL1', '1', '199'), lot('SKU-C', 'MIL1', '1', '201.01'), lot('SKU-F', 'MIL1', '1', '0')],
    [snapV('SKU-A', 'MIL1', '1000'), snapV('SKU-B', 'MIL1', '200'), snapV('SKU-C', 'MIL1', '200'), snapV('SKU-D', 'MIL1', '0.4'), snapV('SKU-F', 'MIL1', '0')],
    one,
  )
  assert.equal(item.outcome, 'pass', JSON.stringify(item.reasons))
  assert.deepEqual(keys(item, 'outOfPopulation'), ['SKU-C|MIL1', 'SKU-D|MIL1'])
  const d = item.entries!.outOfPopulation!.find((e) => e.key === 'SKU-D|MIL1')!
  assert.deepEqual([d.ims, d.vendor, d.imsPresent, d.vendorPresent, d.delta], ['0.4', null, true, false, null])
  // and a list entry on the other side only (Qoblex has a SKU the snapshot lacks)
  const rev = await r5([lot('SKU-A', 'MIL1', '1', '1000'), lot('SKU-E', 'MIL1', '1', '0.4')], [snapV('SKU-A', 'MIL1', '1000')], one)
  assert.deepEqual(keys(rev.item, 'outOfPopulation'), ['SKU-E|MIL1'])
  assert.equal(rev.item.outcome, 'pass')
  // listed SKUs do not rescue a failing total, and the failure is the total's
  const failing = await r5([lot('SKU-A', 'MIL1', '1', '1000')], [snapV('SKU-A', 'MIL1', '1010')], one)
  assert.equal(failing.item.outcome, 'fail')
  assert.deepEqual(keys(failing.item, 'outOfPopulation'), ['SKU-A|MIL1'])
  assert.deepEqual(failing.item.reasons, ['DIFFERENCES'])
})

// [mutation: the company total dropped / computed from the wrong warehouses / the warehouse identity dropped]
test('R5 judges every warehouse AND every company: offsetting warehouse differences net out at the company but the warehouses still fail; a swap of two warehouses\' values fails', async () => {
  const stock = [lot('SKU-1', 'MIL1', '1', '500'), lot('SKU-2', 'CAMBRIDGE', '1', '700')]
  const offsetting = await r5(stock, [snapV('SKU-1', 'MIL1', '700'), snapV('SKU-2', 'CAMBRIDGE', '500')])
  assert.equal(offsetting.item.outcome, 'fail')
  assert.deepEqual(keys(offsetting.item, 'bothDiffer'), ['CAMBRIDGE', 'MIL1'])
  assert.deepEqual(keys(offsetting.item, 'bothEqual'), ['COMPANY|ACME'], 'the company total agrees: the swap is only visible per warehouse')
  const twoCompanies: QoblexLocation[] = [{ code: 'MIL1', company: 'ACME', threePl: false }, { code: 'CAMBRIDGE', company: 'BETA', threePl: false }]
  const split = await r5(stock, [snapV('SKU-1', 'MIL1', '700'), snapV('SKU-2', 'CAMBRIDGE', '500')], twoCompanies)
  assert.deepEqual(keys(split.item, 'bothDiffer'), ['CAMBRIDGE', 'COMPANY|ACME', 'COMPANY|BETA', 'MIL1'])
  // a warehouse's own totals sum its lots; a company's sum its warehouses'
  const sums = await r5([lot('SKU-1', 'MIL1', '2', '10'), lot('SKU-2', 'MIL1', '1', '5'), lot('SKU-3', 'CAMBRIDGE', '1', '3')], [snapV('SKU-1', 'MIL1', '20'), snapV('SKU-2', 'MIL1', '5'), snapV('SKU-3', 'CAMBRIDGE', '3')])
  assert.equal(sums.item.outcome, 'pass')
  assert.deepEqual(sums.item.entries!.bothEqual!.map((e) => [e.key, e.ims, e.vendor]).sort(), [['CAMBRIDGE', '3', '3'], ['COMPANY|ACME', '28', '28'], ['MIL1', '25', '25']])
})

test('R5 sets a 3PL location aside on both sides; a warehouse with no stock is a zero total on both sides, not a missing identity', async () => {
  const { item } = await r5([lot('SKU-1', 'MIL1', '1', '10'), lot('SKU-3', 'RXT2', '1', '999')], [snapV('SKU-1', 'MIL1', '10'), snapV('SKU-3', 'RXT2', '999')])
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.entries!.bothEqual!.map((e) => [e.key, e.ims, e.vendor]).sort(), [['CAMBRIDGE', '0', '0'], ['COMPANY|ACME', '10', '10'], ['MIL1', '10', '10']])
})

// [mutation: the currency / rate / cost / reliability checks removed]
test('R5 is inconclusive, never converted or guessed, for another currency, a rate on a GBP row, a cost missing on stock, or an unreliable snapshot row', async () => {
  const good = [snapV('SKU-1', 'MIL1', '10')]
  const eur = await r5([lot('SKU-1', 'MIL1', '1', '10', { currency: 'EUR' })], good)
  assert.deepEqual([eur.item.outcome, eur.item.reasons], ['inconclusive', ['CURRENCY_UNKNOWN']])
  const rate = await r5([lot('SKU-1', 'MIL1', '1', '10', { fxRateToBase: '1.17' })], good)
  assert.deepEqual([rate.item.outcome, rate.item.reasons], ['inconclusive', ['CURRENCY_UNKNOWN']])
  const rateOne = await r5([lot('SKU-1', 'MIL1', '1', '10', { fxRateToBase: '1' })], good)
  assert.equal(rateOne.item.outcome, 'pass')
  const eurZero = await r5([lot('SKU-1', 'MIL1', '1', '10'), lot('SKU-2', 'MIL1', '0', null, { currency: 'USD' })], good)
  assert.deepEqual(eurZero.item.reasons, ['CURRENCY_UNKNOWN'], 'even a row with no stock must be in the base currency')
  const noCost = await r5([lot('SKU-1', 'MIL1', '1', null)], good)
  assert.deepEqual([noCost.item.outcome, noCost.item.reasons], ['inconclusive', ['VALUE_MISSING']])
  const unreliable = await r5([lot('SKU-1', 'MIL1', '1', '10')], [snapV('SKU-1', 'MIL1', '10', { reliable: false })])
  assert.deepEqual([unreliable.item.outcome, unreliable.item.reasons], ['inconclusive', ['SNAPSHOT_UNAVAILABLE']])
  const noRun = await r5([lot('SKU-1', 'MIL1', '1', '10')], good, undefined, { run: false })
  assert.deepEqual(noRun.item.reasons, ['SNAPSHOT_UNAVAILABLE'])
  // an unreliable row in a warehouse outside the population is not this item's concern
  const outside = await r5([lot('SKU-1', 'MIL1', '1', '10')], [...good, snapV('SKU-9', 'RXT2', '5', { reliable: false })])
  assert.equal(outside.item.outcome, 'pass')
})

test('R5 rounds each Qoblex product half-up to the snapshot\'s six decimals before summing', async () => {
  // 3 x 0.3333335 = 1.0000005 -> 1.000001 (half up at the 7th decimal); the IMS total 1.000001 is equal exactly
  const { item } = await r5([lot('SKU-1', 'MIL1', '3', '0.3333335')], [snapV('SKU-1', 'MIL1', '1.000001')], [{ code: 'MIL1', company: 'ACME', threePl: false }])
  assert.equal(item.outcome, 'pass')
  assert.equal(item.entries!.bothEqual!.find((e) => e.key === 'MIL1')!.vendor, '1.000001')
})

test('R5 no run: a throwing IMS port is INTERNAL_ERROR and nothing escapes', async () => {
  const item = await runQoblexItem('R5', { asOf: ASOF, ims: async () => { throw new Error('boom') }, qoblex: sourceOf({ stock: [lot('SKU-1', 'MIL1', '1', '1')] }) })
  assert.deepEqual([item.outcome, item.reasons], ['inconclusive', ['INTERNAL_ERROR']])
})
