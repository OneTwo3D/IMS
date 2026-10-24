import assert from 'node:assert/strict'
import test from 'node:test'

import { identityToken } from '../../lib/reconciliation-pack/identity.ts'
import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsRead, ImsReadOptions, PoLineRow, PoRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { VALUE_EXACT_GBP_TOKEN, imsSide, qoblexSide, runPoItem, type PoItemContext } from '../../lib/reconciliation-pack/purchase-order-items.ts'
import type { QoblexPoLine } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { PO_PREFIX, poLine, poLines, sourceOf } from './qoblex-fixtures.ts'

/**
 * R7 AND R8 over doubles of the IMS read and of the Qoblex source. The mutation each test closes is named above it.
 */

const line = (sku: string, qty: string, received: string, cost: string, id = `l-${sku}`): PoLineRow => ({ id, sku, qty, qtyReceived: received, unitCostBase: cost })
const po = (number: string, lines: PoLineRow[], over: Partial<PoRow> = {}): PoRow => ({ id: `po-${number}`, reference: `${PO_PREFIX}${number}`, status: 'PO_SENT', currency: 'GBP', lines, ...over })

type Fixture = { orders?: PoRow[]; firstLoad?: 'verified' | 'unverified' | 'absent'; fail?: Partial<Record<'purchaseOrders' | 'boundaries', 'READ_INCOMPLETE'>>; whole?: 'fail' | 'throws'; noSection?: 'purchaseOrders' | 'boundaries' }
function ims(fixture: Fixture = {}) {
  const calls: ImsReadOptions[] = []
  const firstLoad = fixture.firstLoad ?? 'verified'
  const values: Record<string, unknown> = {
    purchaseOrders: fixture.orders ?? [],
    boundaries: { firstLoad: firstLoad === 'verified' ? { state: 'verified', cutAt: '2026-10-01T00:00:00.000Z' } : { state: firstLoad }, storefrontImport: { state: 'not-completed' }, retentionMonths: 0 },
  }
  const port = async (options: ImsReadOptions): Promise<ImsRead> => {
    calls.push(options)
    if (fixture.whole === 'throws') throw new Error('boom')
    if (fixture.whole === 'fail') return { ok: false, reason: 'READ_INCOMPLETE' }
    const sections: Record<string, unknown> = {}
    for (const name of options.sections) {
      if (fixture.noSection === name) continue
      const failure = fixture.fail?.[name as 'purchaseOrders' | 'boundaries']
      sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: values[name] }
    }
    return { ok: true, snapshotId: '1:2:', sections } as ImsRead
  }
  return { calls, port }
}
const keys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key).sort()

async function run(id: 'R7' | 'R8', orders: PoRow[], lines: QoblexPoLine[], over: Partial<PoItemContext> & { fixture?: Fixture; prefix?: string } = {}) {
  const port = ims({ orders, ...(over.fixture ?? {}) })
  const counter = { reads: 0 }
  const item = await runPoItem(id, { phase: 'P2', ims: port.port, qoblex: sourceOf({ purchaseOrders: poLines(lines, over.prefix) }, counter), ...(over.phase !== undefined ? { phase: over.phase } : {}) })
  return { item, port, counter }
}

// ---- R7 -----------------------------------------------------------------------------------------

test('R7 passes when every incoming order agrees (set exact, value in GBP), naming exactly the catalogue sources and asking IMS for the orders and the first-load record only', async () => {
  const { item, port, counter } = await run('R7', [po('PO1', [line('A', '10', '0', '2.5')]), po('PO2', [line('B', '4', '1', '10')])], [poLine('PO1', 'A', '10', '0', '2.5'), poLine('PO2', 'B', '4', '1', '10')])
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.proof, { kind: 'compared' })
  assert.deepEqual(item.sources, [...getPackItem('R7').sources])
  assert.deepEqual(keys(item, 'bothEqual'), ['PO1', 'PO1|value-exact-gbp', 'PO2', 'PO2|value-exact-gbp'])
  assert.equal(port.calls.length, 1)
  assert.deepEqual([...port.calls[0]!.sections].sort(), ['boundaries', 'purchaseOrders'])
  assert.equal(counter.reads, 1)
  const values = Object.fromEntries((item.entries!.bothEqual as unknown as Array<{ key: string; ims: string; vendor: string }>).map((e) => [e.key, [e.ims, e.vendor]]))
  // PO2: ordered 4, received 1, outstanding 3 at 10 each.
  assert.deepEqual(values['PO2'], ['30', '30'])
})

// [mutation: comparison by total / count instead of by order]
test('R7 IDENTITY SWAP: the same figures under the other order number are two findings, never equal; an order the export omits cannot pass', async () => {
  const swapped = await run('R7', [po('PO1', [line('A', '10', '0', '2')]), po('PO2', [line('B', '5', '0', '1')])], [poLine('PO1', 'B', '5', '0', '1'), poLine('PO2', 'A', '10', '0', '2')])
  assert.equal(swapped.item.outcome, 'fail')
  assert.deepEqual(keys(swapped.item, 'bothDiffer'), ['PO1', 'PO1|value-exact-gbp', 'PO2', 'PO2|value-exact-gbp'])
  // Same two values in the other order's slot, with the counts equal: a swapped number is a difference of value, not equality.
  const omitted = await run('R7', [po('PO1', [line('A', '1', '0', '1')]), po('PO2', [line('B', '1', '0', '1')])], [poLine('PO1', 'A', '1', '0', '1')])
  assert.equal(omitted.item.outcome, 'fail')
  assert.deepEqual(keys(omitted.item, 'onlyIms'), ['PO2'])
  const added = await run('R7', [po('PO1', [line('A', '1', '0', '1')])], [poLine('PO1', 'A', '1', '0', '1'), poLine('PO3', 'C', '1', '0', '1')])
  assert.equal(added.item.outcome, 'fail')
  assert.deepEqual(keys(added.item, 'onlyVendor'), ['PO3'])
  // Equal counts, one identity swapped: PO2 in IMS, PO3 in the file.
  const exchanged = await run('R7', [po('PO1', [line('A', '1', '0', '1')]), po('PO2', [line('B', '1', '0', '1')])], [poLine('PO1', 'A', '1', '0', '1'), poLine('PO3', 'B', '1', '0', '1')])
  assert.equal(exchanged.item.outcome, 'fail')
  assert.deepEqual([keys(exchanged.item, 'onlyIms'), keys(exchanged.item, 'onlyVendor')], [['PO2'], ['PO3']])
})

// [mutation: the match relaxed to case folding, trimming or digit extraction / the prefix guessed]
test('R7 matches only by the RECORDED reference (declared prefix + number): a reference without the prefix, in another case or with another prefix is never matched', async () => {
  const lines = [poLine('PO1', 'A', '1', '0', '1')]
  const cases: Array<[string, string]> = [['PO1', identityToken('ims-id', 'po-PO1')], ['qbx-PO1', identityToken('ims-id', 'po-PO1')], ['QBX-po1', 'po1'], ['QBX- PO1', identityToken('ims-id', 'po-PO1')], ['QBX-PO1 ', identityToken('ims-id', 'po-PO1')], ['XQBX-PO1', identityToken('ims-id', 'po-PO1')]]
  for (const [reference, onlyIms] of cases) {
    const { item } = await run('R7', [po('PO1', [line('A', '1', '0', '1')], { reference })], lines)
    assert.equal(item.outcome, 'fail', reference)
    assert.equal(keys(item, 'onlyVendor').join(), 'PO1', reference)
    assert.deepEqual(keys(item, 'onlyIms'), [onlyIms], reference)
  }
  // The declared prefix is the only thing that explains the reference: a different one explains nothing.
  const wrong = await run('R7', [po('PO1', [line('A', '1', '0', '1')])], lines, { prefix: 'OTHER-' })
  assert.equal(wrong.item.outcome, 'fail')
  assert.equal(keys(wrong.item, 'bothEqual').length, 0)
})

// [mutation: an unexplained IMS order dropped from the set]
test('R7 POPULATION NARROWING: an IMS incoming order that no export line explains (an order IMS made itself) is a finding, whatever the manifest declares', async () => {
  const { item } = await run('R7', [po('PO1', [line('A', '1', '0', '1')]), po('X', [line('B', '1', '0', '1')], { reference: 'PO-2026-0001' })], [poLine('PO1', 'A', '1', '0', '1')])
  assert.equal(item.outcome, 'fail')
  assert.deepEqual(keys(item, 'onlyIms'), [identityToken('ims-id', 'po-X')])
  // And a prefix that explains nothing leaves EVERY IMS order a finding, never a smaller population.
  const none = await run('R7', [po('PO1', [line('A', '1', '0', '1')])], [], { prefix: 'ZZ-' })
  assert.equal(none.item.outcome, 'fail')
  assert.deepEqual(keys(none.item, 'onlyIms'), [identityToken('ims-id', 'po-PO1')])
})

// [mutation: the value tolerance changed, or made exclusive]
test('R7 FX BOUNDARY: an order in another currency is within GBP 1 INCLUSIVE (1.00 passes, 1.000001 fails); an order in GBP must be exact', async () => {
  // USD at rate 1.25: price 12.5 -> 10 per unit; ordered 100 -> GBP 1000.
  const usd = (cost: string) => run('R7', [po('PO1', [line('A', '100', '0', cost)], { currency: 'USD' })], [poLine('PO1', 'A', '100', '0', '12.5', { currency: 'USD', fxRateToBase: '1.25', supplier: 'S' })])
  assert.equal((await usd('10')).item.outcome, 'pass')
  assert.equal((await usd('10.01')).item.outcome, 'pass')
  assert.equal((await usd('10.01')).item.entries!.bothEqual!.length, 1)
  assert.equal((await usd('10.0100')).item.outcome, 'pass')
  assert.equal((await usd('10.010000')).item.outcome, 'pass')
  assert.equal((await usd('10.01000001')).item.outcome, 'fail')
  assert.equal((await usd('10.010001')).item.outcome, 'fail')
  assert.equal((await usd('9.99')).item.outcome, 'pass')
  assert.equal((await usd('9.989999')).item.outcome, 'fail')
  // GBP: any difference beyond the stored precision is a finding, even far inside GBP 1.
  const gbp = (cost: string) => run('R7', [po('PO1', [line('A', '100', '0', cost)])], [poLine('PO1', 'A', '100', '0', '10')])
  assert.equal((await gbp('10')).item.outcome, 'pass')
  const off = await gbp('10.005')
  assert.equal(off.item.outcome, 'fail')
  assert.deepEqual(keys(off.item, 'bothDiffer'), [`PO1|${VALUE_EXACT_GBP_TOKEN}`])
  assert.equal(keys(off.item, 'bothEqual').join(), 'PO1')
  // the stored precision is six decimals: one millionth of a pound is the finest difference, and it is tolerated; ten are not
  assert.equal((await gbp('10.00000001')).item.outcome, 'pass')
  assert.equal((await gbp('10.0000001')).item.outcome, 'fail')
})

// [mutation: the foreign price used unconverted / the rate applied the wrong way round]
test('R7 FX source: Qoblex converts price / rate with the map\'s fixed rate, six decimals half-up per unit; IMS uses its stored base cost', async () => {
  // EUR rate 1.15, price 0.4 -> 0.347826 (0.3478260869...), x 6 outstanding = 2.086956
  const eur = poLine('PO901', 'S', '10', '4', '0.4', { currency: 'EUR', fxRateToBase: '1.15', supplier: 'G' })
  const side = qoblexSide([eur])
  assert.ok(side.ok)
  assert.equal([...side.orders.values()][0]!.value.toFixed(), '2.086956')
  const { item } = await run('R7', [po('PO901', [line('S', '6', '0', '0.347826')], { currency: 'EUR' })], [eur])
  assert.equal(item.outcome, 'pass')
  const wrongWay = await run('R7', [po('PO901', [line('S', '6', '0', '0.46')], { currency: 'EUR' })], [eur])
  assert.equal(wrongWay.item.outcome, 'pass') // 2.76 vs 2.086956 is within GBP 1 only because the order is small: the tolerance is absolute
  const large = poLine('PO902', 'S', '1000', '0', '0.4', { currency: 'EUR', fxRateToBase: '1.15', supplier: 'G' })
  const bad = await run('R7', [po('PO902', [line('S', '1000', '0', '0.46')], { currency: 'EUR' })], [large])
  assert.equal(bad.item.outcome, 'fail')
})

// [mutation: an order currency disagreement ignored]
test('R7: an order whose currency differs between IMS and the export is CURRENCY_UNKNOWN, never compared across the disagreement', async () => {
  const { item } = await run('R7', [po('PO1', [line('A', '1', '0', '1')], { currency: 'EUR' })], [poLine('PO1', 'A', '1', '0', '1')])
  assert.equal(item.outcome, 'inconclusive')
  assert.deepEqual(item.reasons, ['CURRENCY_UNKNOWN'])
})

// [mutation: ordered quantity used instead of ordered - received]
test('R7 PART-RECEIVED ARITHMETIC: the value is the OUTSTANDING quantity at the unit cost on both sides, a fully received line adds nothing and an order with nothing outstanding is not in the export\'s set', async () => {
  const lines = [poLine('PO1', 'A', '10', '4', '2'), poLine('PO1', 'B', '5', '5', '100'), poLine('PO2', 'C', '3', '3', '9')]
  const { item } = await run('R7', [po('PO1', [line('A', '10', '4', '2'), line('B', '5', '5', '100')])], lines)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(keys(item, 'bothEqual'), ['PO1', 'PO1|value-exact-gbp'])
  const [entry] = (item.entries!.bothEqual as unknown as Array<{ key: string; ims: string; vendor: string }>).filter((e) => e.key === 'PO1')
  assert.deepEqual([entry!.ims, entry!.vendor], ['12', '12'])
  // IMS holding the received-in-full order in an incoming status is a finding: Qoblex lists nothing outstanding for it.
  const stale = await run('R7', [po('PO1', [line('A', '10', '4', '2')]), po('PO2', [line('C', '3', '3', '9')])], lines)
  assert.equal(stale.item.outcome, 'fail')
  assert.deepEqual(keys(stale.item, 'onlyIms'), ['PO2'])
})

test('R7 EMPTY: nothing incoming on either side passes only on the named proof; an empty export beside an IMS order fails; an export beside no IMS order fails', async () => {
  const empty = await run('R7', [], [])
  assert.equal(empty.item.outcome, 'pass')
  assert.deepEqual(empty.item.proof, { kind: 'proven-empty', source: 'qoblex-incoming-report-empty' })
  const nothingOutstanding = await run('R7', [], [poLine('PO2', 'C', '3', '3', '9')])
  assert.equal(nothingOutstanding.item.outcome, 'pass')
  const imsOnly = await run('R7', [po('PO1', [line('A', '1', '0', '1')])], [])
  assert.equal(imsOnly.item.outcome, 'fail')
  assert.deepEqual(keys(imsOnly.item, 'onlyIms'), ['PO1'])
  const fileOnly = await run('R7', [], [poLine('PO1', 'A', '1', '0', '1')])
  assert.equal(fileOnly.item.outcome, 'fail')
  assert.deepEqual(keys(fileOnly.item, 'onlyVendor'), ['PO1'])
})

// [mutation: the phase check removed / the read made before it]
test('PHASES: at P0 and P1 R7 and R8 are not-applicable and NOTHING is read (no file, no database); at P2 they run; an unknown phase is an internal error, never a pass', async () => {
  for (const id of ['R7', 'R8'] as const) {
    for (const phase of ['P0', 'P1'] as const) {
      const port = ims({})
      const counter = { reads: 0 }
      const item = await runPoItem(id, { phase, ims: port.port, qoblex: sourceOf({}, counter) })
      assert.deepEqual([item.outcome, item.reasons], ['not-applicable', ['PHASE_NOT_APPLICABLE']], `${id} ${phase}`)
      assert.deepEqual([port.calls.length, counter.reads], [0, 0], `${id} ${phase}`)
    }
    const none = await runPoItem(id, { ims: ims({}).port, qoblex: sourceOf({}) })
    assert.equal(none.outcome, 'inconclusive')
    assert.deepEqual(none.reasons, ['INTERNAL_ERROR'])
    assert.equal((await runPoItem(id, { phase: 'P2', ims: ims({}).port, qoblex: sourceOf({}) })).outcome, 'pass')
  }
})

// [mutation: a missing input read as empty]
test('R7 and R8: no export named, an unreadable part, an unreadable IMS section, a missing section, a failed or thrown read and an unverified first load are each inconclusive with a closed reason', async () => {
  for (const id of ['R7', 'R8'] as const) {
    const off = await runPoItem(id, { phase: 'P2', ims: ims({}).port })
    assert.deepEqual([off.outcome, off.reasons], ['inconclusive', ['QOBLEX_EXPORT_OFF']])
    const noIms = await runPoItem(id, { phase: 'P2', qoblex: sourceOf({}) })
    assert.deepEqual([noIms.outcome, noIms.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
    const part = await runPoItem(id, { phase: 'P2', ims: ims({}).port, qoblex: sourceOf({ purchaseOrders: 'fail' }) })
    assert.deepEqual([part.outcome, part.reasons], ['inconclusive', ['SOURCE_UNREADABLE']])
    const unreadable = await runPoItem(id, { phase: 'P2', ims: ims({}).port, qoblex: sourceOf({ stock: 'fail', purchaseOrders: 'fail' }) })
    assert.equal(unreadable.outcome, 'inconclusive')
    const section = await runPoItem(id, { phase: 'P2', ims: ims({ fail: { purchaseOrders: 'READ_INCOMPLETE' } }).port, qoblex: sourceOf({}) })
    assert.deepEqual([section.outcome, section.reasons], ['inconclusive', ['READ_INCOMPLETE']])
    const boundary = await runPoItem(id, { phase: 'P2', ims: ims({ fail: { boundaries: 'READ_INCOMPLETE' } }).port, qoblex: sourceOf({}) })
    assert.deepEqual([boundary.outcome, boundary.reasons], ['inconclusive', ['READ_INCOMPLETE']])
    for (const missing of ['purchaseOrders', 'boundaries'] as const) {
      const m = await runPoItem(id, { phase: 'P2', ims: ims({ noSection: missing }).port, qoblex: sourceOf({}) })
      assert.deepEqual([m.outcome, m.reasons], ['inconclusive', ['SOURCE_UNREADABLE']], missing)
    }
    const whole = await runPoItem(id, { phase: 'P2', ims: ims({ whole: 'fail' }).port, qoblex: sourceOf({}) })
    assert.deepEqual([whole.outcome, whole.reasons], ['inconclusive', ['READ_INCOMPLETE']])
    const thrown = await runPoItem(id, { phase: 'P2', ims: ims({ whole: 'throws' }).port, qoblex: sourceOf({}) })
    assert.deepEqual([thrown.outcome, thrown.reasons], ['inconclusive', ['INTERNAL_ERROR']])
    for (const firstLoad of ['absent', 'unverified'] as const) {
      const f = await runPoItem(id, { phase: 'P2', ims: ims({ firstLoad }).port, qoblex: sourceOf({}) })
      assert.deepEqual([f.outcome, f.reasons], ['inconclusive', ['NO_POPULATION_RECORD']], firstLoad)
    }
  }
})

test('R7 and R8: an IMS line with received above ordered is BAD_VALUE; a repeated SKU in an IMS order or a repeated (order, SKU) in the export is DUPLICATE_KEY; two IMS orders that print one number cannot both be read', async () => {
  for (const id of ['R7', 'R8'] as const) {
    const over = await run(id, [po('PO1', [line('A', '1', '2', '1')])], [])
    assert.deepEqual([over.item.outcome, over.item.reasons], ['inconclusive', ['BAD_VALUE']], id)
    const twice = await run(id, [po('PO1', [line('A', '1', '0', '1', 'l1'), line('A', '2', '0', '1', 'l2')])], [])
    assert.deepEqual([twice.item.outcome, twice.item.reasons], ['inconclusive', ['DUPLICATE_KEY']], id)
    const dupFile = await run(id, [], [poLine('PO1', 'A', '1', '0', '1'), poLine('PO1', 'A', '2', '0', '1')])
    assert.deepEqual([dupFile.item.outcome, dupFile.item.reasons], ['inconclusive', ['DUPLICATE_KEY']], id)
    const dupOrder = await run(id, [po('PO1', [line('A', '1', '0', '1')]), po('PO1b', [line('A', '1', '0', '1')], { reference: `${PO_PREFIX}PO1`, id: 'other' })], [])
    assert.deepEqual([dupOrder.item.outcome, dupOrder.item.reasons], ['inconclusive', ['DUPLICATE_KEY']], id)
    const badValue = await run(id, [po('PO1', [line('A', '1e3', '0', '1')])], [])
    assert.deepEqual([badValue.item.outcome, badValue.item.reasons], ['inconclusive', ['BAD_VALUE']], id)
  }
})

// ---- R8 -----------------------------------------------------------------------------------------

test('R8 passes when every open line\'s outstanding quantity agrees; a part-received line is compared on ordered - received; a line with nothing outstanding is no line on either side', async () => {
  const lines = [poLine('PO1', 'A', '10', '4', '2'), poLine('PO1', 'B', '5', '5', '1'), poLine('PO2', 'C', '3', '0', '9')]
  const { item, port } = await run('R8', [po('PO1', [line('A', '10', '4', '2'), line('B', '5', '5', '1')]), po('PO2', [line('C', '3', '0', '9')])], lines)
  assert.equal(item.outcome, 'pass')
  assert.deepEqual(item.sources, [...getPackItem('R8').sources])
  assert.deepEqual(keys(item, 'bothEqual'), ['PO1|A', 'PO2|C'])
  const entry = (item.entries!.bothEqual as unknown as Array<{ key: string; ims: string; vendor: string }>).find((e) => e.key === 'PO1|A')!
  assert.deepEqual([entry.ims, entry.vendor], ['6', '6'])
  assert.deepEqual([...port.calls[0]!.sections].sort(), ['boundaries', 'purchaseOrders'])
  // IMS booked the load as a smaller order with nothing received: the same outstanding quantity is the same line.
  const loaded = await run('R8', [po('PO1', [line('A', '6', '0', '2')])], [poLine('PO1', 'A', '10', '4', '2')])
  assert.equal(loaded.item.outcome, 'pass')
})

// [mutation: ordered quantity compared instead of the outstanding / the line key reduced to the order]
test('R8 LINE IDENTITY: the same quantities on the other SKU or the other order are two findings; a line missing from the export cannot pass; an extra line fails', async () => {
  const mine = [po('PO1', [line('A', '10', '0', '1'), line('B', '3', '0', '1')])]
  const swappedSku = await run('R8', mine, [poLine('PO1', 'A', '3', '0', '1'), poLine('PO1', 'B', '10', '0', '1')])
  assert.equal(swappedSku.item.outcome, 'fail')
  assert.deepEqual(keys(swappedSku.item, 'bothDiffer'), ['PO1|A', 'PO1|B'])
  const elsewhere = await run('R8', mine, [poLine('PO2', 'A', '10', '0', '1'), poLine('PO2', 'B', '3', '0', '1')])
  assert.equal(elsewhere.item.outcome, 'fail')
  assert.deepEqual(keys(elsewhere.item, 'onlyIms'), ['PO1|A', 'PO1|B'])
  assert.deepEqual(keys(elsewhere.item, 'onlyVendor'), ['PO2|A', 'PO2|B'])
  const omitted = await run('R8', mine, [poLine('PO1', 'A', '10', '0', '1')])
  assert.equal(omitted.item.outcome, 'fail')
  assert.deepEqual(keys(omitted.item, 'onlyIms'), ['PO1|B'])
  const extra = await run('R8', mine, [poLine('PO1', 'A', '10', '0', '1'), poLine('PO1', 'B', '3', '0', '1'), poLine('PO1', 'C', '1', '0', '1')])
  assert.deepEqual(keys(extra.item, 'onlyVendor'), ['PO1|C'])
  // An IMS order the references do not explain is an IMS-only line, never dropped.
  const native = await run('R8', [po('PO1', [line('A', '10', '0', '1')]), po('N', [line('Z', '1', '0', '1')], { reference: 'PO-1' })], [poLine('PO1', 'A', '10', '0', '1')])
  assert.deepEqual(keys(native.item, 'onlyIms'), [`${identityToken('ims-id', 'po-N')}|Z`])
})

// [mutation: the exact tolerance widened]
test('R8 is exact to the stored precision: 0.0001 apart is equal (inclusive), 0.0002 is not', async () => {
  const at = (qty: string) => run('R8', [po('PO1', [line('A', qty, '0', '1')])], [poLine('PO1', 'A', '10', '0', '1')])
  assert.equal((await at('10')).item.outcome, 'pass')
  assert.equal((await at('10.0001')).item.outcome, 'pass')
  assert.equal((await at('9.9999')).item.outcome, 'pass')
  assert.equal((await at('10.0002')).item.outcome, 'fail')
  assert.equal((await at('9.9998')).item.outcome, 'fail')
})

test('R8 EMPTY: no outstanding line on either side passes only on the named proof; an IMS incoming order with nothing outstanding is not proven empty', async () => {
  const empty = await run('R8', [], [])
  assert.equal(empty.item.outcome, 'pass')
  assert.deepEqual(empty.item.proof, { kind: 'proven-empty', source: 'qoblex-incoming-report-empty' })
  const noLines = await run('R8', [po('PO1', [line('A', '2', '2', '1')])], [])
  assert.deepEqual([noLines.item.outcome, noLines.item.reasons], ['inconclusive', ['EMPTY_UNPROVEN']])
})

// ---- the sides -----------------------------------------------------------------------------------

test('the sides: IMS orders are keyed by vendor number when the prefix explains the reference and by their own reference when not; the export side drops fully received lines and keeps the rest per order', () => {
  const mine = imsSide([po('PO1', [line('A', '2', '0', '1')]), po('Q', [], { reference: 'X-9' })], PO_PREFIX)
  assert.ok(mine.ok)
  assert.deepEqual([...mine.orders.values()].map((o) => [o.key[0]!.kind, o.key[0]!.raw, o.native]), [['order-ref', 'PO1', false], ['ims-id', 'po-Q', true]])
  // an IMS reference that is the prefix alone, or the prefix and an unusable number, is unexplained
  const odd = imsSide([po('A', [], { reference: PO_PREFIX }), po('B', [], { reference: `${PO_PREFIX}a/b`, id: 'b' })], PO_PREFIX)
  assert.ok(odd.ok)
  assert.deepEqual([...odd.orders.values()].map((o) => o.native), [true, true])
  const theirs = qoblexSide([poLine('PO1', 'A', '2', '1', '3'), poLine('PO1', 'B', '1', '1', '3')])
  assert.ok(theirs.ok)
  const order = [...theirs.orders.values()][0]!
  assert.equal(order.value.toFixed(), '3')
  assert.equal(order.lines.size, 1)
})
