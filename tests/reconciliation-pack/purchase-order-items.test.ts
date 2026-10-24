import assert from 'node:assert/strict'
import test from 'node:test'

import { identityToken } from '../../lib/reconciliation-pack/identity.ts'
import { getPackItem } from '../../lib/reconciliation-pack/constants.ts'
import type { FirstLoadProvenance, FxRateRow, ImsRead, ImsReadOptions, PoLineRow, PoRow } from '../../lib/reconciliation-pack/ims-readers.ts'
import { ORDER_LINES_TOKEN, VALUE_EXACT_GBP_TOKEN, imsSide, qoblexSide, rateAt, runPoItem, type PoItemContext } from '../../lib/reconciliation-pack/purchase-order-items.ts'
import type { QoblexPoLine } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { PO_PREFIX, poLine, poLines, sourceOf } from './qoblex-fixtures.ts'

/**
 * R7 AND R8 over doubles of the IMS read and of the Qoblex source. The mutation each test closes is named above it.
 */

const line = (sku: string, qty: string, received: string, cost: string, id = `l-${sku}`): PoLineRow => ({ id, sku, qty, qtyReceived: received, unitCostBase: cost })
const po = (number: string, lines: PoLineRow[], over: Partial<PoRow> = {}): PoRow => ({ id: `po-${number}`, reference: `${PO_PREFIX}${number}`, status: 'PO_SENT', currency: 'GBP', createdAt: '2026-03-01T10:00:00.000Z', discount: '0', lines, ...over })

type Fixture = { orders?: PoRow[]; fx?: FxRateRow[]; native?: string[]; provenance?: Partial<FirstLoadProvenance> | null; fxSection?: 'fail'; firstLoad?: 'verified' | 'unverified' | 'absent'; fail?: Partial<Record<'purchaseOrders' | 'boundaries', 'READ_INCOMPLETE'>>; whole?: 'fail' | 'throws'; noSection?: 'purchaseOrders' | 'boundaries' }
function ims(fixture: Fixture = {}) {
  const calls: ImsReadOptions[] = []
  const firstLoad = fixture.firstLoad ?? 'verified'
  const values: Record<string, unknown> = {
    purchaseOrders: fixture.orders ?? [],
    // THE FIRST LOAD'S RECORDED PROVENANCE: every order of the fixture was created by it unless named in `native`; the run record's line count is the attributed orders' lines.
    firstLoadProvenance: fixture.provenance === null ? null : (() => {
      const attributed = (fixture.orders ?? []).filter((o) => !(fixture.native ?? []).includes(o.id))
      const lineCount = attributed.reduce((n, o) => n + o.lines.length, 0)
      return { runId: 'run-1', status: 'VERIFIED', journalCreated: lineCount, attributed: attributed.map((o) => o.id), attributedLines: lineCount, ...(fixture.provenance ?? {}) }
    })(),
    fxRates: fixture.fx ?? [],
    boundaries: { firstLoad: firstLoad === 'verified' ? { state: 'verified', cutAt: '2026-10-01T00:00:00.000Z' } : { state: firstLoad }, storefrontImport: { state: 'not-completed' }, retentionMonths: 0 },
  }
  const port = async (options: ImsReadOptions): Promise<ImsRead> => {
    calls.push(options)
    if (fixture.whole === 'throws') throw new Error('boom')
    if (fixture.whole === 'fail') return { ok: false, reason: 'READ_INCOMPLETE' }
    const sections: Record<string, unknown> = {}
    for (const name of options.sections) {
      if (fixture.noSection === name) continue
      const failure = name === 'fxRates' && fixture.fxSection === 'fail' ? 'READ_INCOMPLETE' : fixture.fail?.[name as 'purchaseOrders' | 'boundaries']
      sections[name] = failure ? { ok: false, reason: failure } : { ok: true, value: values[name] }
    }
    return { ok: true, snapshotId: '1:2:', sections } as ImsRead
  }
  return { calls, port }
}
const lineKeys = (item: { entries?: Partial<Record<string, readonly { key: string }[]>> }, bucket: string) => (item.entries?.[bucket] ?? []).map((e) => e.key).filter((k) => !k.endsWith(`|${ORDER_LINES_TOKEN}`)).sort()
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
  assert.deepEqual([...port.calls[0]!.sections].sort(), ['boundaries', 'firstLoadProvenance', 'fxRates', 'purchaseOrders'])
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
  const usd = (cost: string) => run('R7', [po('PO1', [line('A', '100', '0', cost)], { currency: 'USD' })], [poLine('PO1', 'A', '100', '0', '12.5')], { fixture: { fx: [fxRow('USD', '1.25', '2026-02-20T00:00:00.000Z')] } })
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
  // the stored precision is six decimals: ONE MILLIONTH of a pound is a difference, and a GBP order must not carry one
  assert.equal((await gbp('10.00000001')).item.outcome, 'fail')
  assert.equal((await gbp('10.0000001')).item.outcome, 'fail')
  const micro = (cost: string) => run('R7', [po('PO1', [line('A', '1', '0', cost)])], [poLine('PO1', 'A', '1', '0', '10')])
  for (const [cost, expected] of [['10', 'pass'], ['10.000001', 'fail'], ['9.999999', 'fail']] as const) {
    const m = await micro(cost)
    assert.equal(m.item.outcome, expected, cost)
    if (expected === 'fail') assert.deepEqual(keys(m.item, 'bothDiffer'), [`PO1|${VALUE_EXACT_GBP_TOKEN}`], cost)
  }
})

const fxRow = (currency: string, rate: string, fetchedAt: string): FxRateRow => ({ currency, rate, fetchedAt })

// [mutation: the foreign price used unconverted / the rate applied the wrong way round / the map's fixed table used]
test('R7 FX source: Qoblex converts price / rate (1 GBP = rate foreign) with the central fx_rates row, six decimals half-up per unit; IMS uses its stored base cost', async () => {
  const fx = [fxRow('EUR', '1.15', '2026-02-20T00:00:00.000Z')]
  // EUR rate 1.15, price 0.4 -> 0.347826 (0.3478260869...), x 6 outstanding = 2.086956
  const eur = poLine('PO901', 'S', '10', '4', '0.4')
  const mine = imsSide([po('PO901', [line('S', '6', '0', '0.347826')], { currency: 'EUR' })], PO_PREFIX)
  assert.ok(mine.ok)
  const side = qoblexSide([eur], { mine: mine.orders, fxRates: fx })
  assert.ok(side.ok)
  assert.equal([...side.orders.values()][0]!.value.toFixed(), '2.086956')
  const { item } = await run('R7', [po('PO901', [line('S', '6', '0', '0.347826')], { currency: 'EUR' })], [eur], { fixture: { fx } })
  assert.equal(item.outcome, 'pass')
  // the same order at a different central rate is a different Qoblex value (the rate is read, not carried by the pack)
  const large = poLine('PO902', 'S', '1000', '0', '0.4')
  const same = await run('R7', [po('PO902', [line('S', '1000', '0', '0.347826')], { currency: 'EUR' })], [large], { fixture: { fx } })
  assert.equal(same.item.outcome, 'pass')
  const other = await run('R7', [po('PO902', [line('S', '1000', '0', '0.347826')], { currency: 'EUR' })], [large], { fixture: { fx: [fxRow('EUR', '1.30', '2026-02-20T00:00:00.000Z')] } })
  assert.equal(other.item.outcome, 'fail')
  // an order no IMS order explains has no recorded currency: it is onlyVendor with its unconverted sum
  const orphan = await run('R7', [], [poLine('PX', 'S', '2', '0', '3')], { fixture: { fx } })
  assert.equal(orphan.item.outcome, 'fail')
  assert.equal((orphan.item.entries!.onlyVendor as unknown as Array<{ vendor: string }>)[0]!.vendor, '6')
})

// [mutation: the latest row picked without the instant bound / a tie broken silently / a missing row read as rate 1]
test('R7 RATE SELECTION: the latest fx_rates row on or before the IMS order\'s creation; none, a non-positive rate or a tie that disagrees is CURRENCY_UNKNOWN, never a pass', async () => {
  const at = '2026-03-01T10:00:00.000Z'
  const rows = [fxRow('USD', '1.20', '2026-02-01T00:00:00.000Z'), fxRow('USD', '1.25', '2026-02-20T00:00:00.000Z'), fxRow('USD', '9.99', '2026-03-02T00:00:00.000Z'), fxRow('EUR', '1.10', '2026-02-25T00:00:00.000Z')]
  assert.equal(rateAt('USD', at, rows)!.toFixed(), '1.25', 'the latest on or before; a later row is ignored')
  assert.equal(rateAt('USD', '2026-02-20T00:00:00.000Z', rows)!.toFixed(), '1.25', 'a row at exactly the instant is on or before it')
  assert.equal(rateAt('USD', '2026-02-19T23:59:59.999Z', rows)!.toFixed(), '1.2')
  assert.equal(rateAt('GBP', at, [])!.toFixed(), '1', 'the base currency needs no row')
  assert.equal(rateAt('USD', '2026-01-01T00:00:00.000Z', rows), null, 'no row on or before the instant')
  assert.equal(rateAt('JPY', at, rows), null, 'no row for the currency')
  assert.equal(rateAt('USD', 'soon', rows), null)
  assert.equal(rateAt('USD', at, [fxRow('USD', '0', '2026-02-20T00:00:00.000Z')]), null)
  assert.equal(rateAt('USD', at, [fxRow('USD', '-1.2', '2026-02-20T00:00:00.000Z')]), null)
  assert.equal(rateAt('USD', at, [fxRow('USD', '1.25', '2026-02-20T00:00:00.000Z'), fxRow('USD', '1.26', '2026-02-20T00:00:00.000Z')]), null, 'two rows at the latest instant that disagree')
  assert.equal(rateAt('USD', at, [fxRow('USD', '1.25', '2026-02-20T00:00:00.000Z'), fxRow('USD', '1.25', '2026-02-20T00:00:00.000Z')])!.toFixed(), '1.25', 'the same rate twice is not an ambiguity')
  assert.equal(rateAt('usd', at, rows), null, 'a currency code is exact')
  // through the item
  const order = [po('PO1', [line('A', '1', '0', '1')], { currency: 'USD' })]
  const lines = [poLine('PO1', 'A', '1', '0', '1')]
  for (const fx of [[], [fxRow('USD', '0', '2026-02-20T00:00:00.000Z')], [fxRow('USD', '1', '2026-03-02T00:00:00.000Z')], [fxRow('USD', '1', '2026-02-20T00:00:00.000Z'), fxRow('USD', '2', '2026-02-20T00:00:00.000Z')]]) {
    const r = await run('R7', order, lines, { fixture: { fx } })
    assert.deepEqual([r.item.outcome, r.item.reasons], ['inconclusive', ['CURRENCY_UNKNOWN']], JSON.stringify(fx))
  }
  const failed = await run('R7', order, lines, { fixture: { fx: [], fxSection: 'fail' } })
  assert.deepEqual([failed.item.outcome, failed.item.reasons], ['inconclusive', ['READ_INCOMPLETE']])
  // R8 does not need rates: the same orders compare without them
  assert.equal((await run('R8', order, lines)).item.outcome, 'pass')
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
  assert.deepEqual(lineKeys(item, 'bothEqual'), ['PO1|A', 'PO2|C'])
  const entry = (item.entries!.bothEqual as unknown as Array<{ key: string; ims: string; vendor: string }>).find((e) => e.key === 'PO1|A')!
  assert.deepEqual([entry.ims, entry.vendor], ['6', '6'])
  assert.deepEqual([...port.calls[0]!.sections].sort(), ['boundaries', 'firstLoadProvenance', 'purchaseOrders'])
  // IMS booked the load as a smaller order with nothing received: the same outstanding quantity is the same line.
  const loaded = await run('R8', [po('PO1', [line('A', '6', '0', '2')])], [poLine('PO1', 'A', '10', '4', '2')])
  assert.equal(loaded.item.outcome, 'pass')
})

// [mutation: ordered quantity compared instead of the outstanding / the line key reduced to the order]
test('R8 LINE IDENTITY: the same quantities on the other SKU or the other order are two findings; a line missing from the export cannot pass; an extra line fails', async () => {
  const mine = [po('PO1', [line('A', '10', '0', '1'), line('B', '3', '0', '1')])]
  const swappedSku = await run('R8', mine, [poLine('PO1', 'A', '3', '0', '1'), poLine('PO1', 'B', '10', '0', '1')])
  assert.equal(swappedSku.item.outcome, 'fail')
  assert.deepEqual(lineKeys(swappedSku.item, 'bothDiffer'), ['PO1|A', 'PO1|B'])
  const elsewhere = await run('R8', mine, [poLine('PO2', 'A', '10', '0', '1'), poLine('PO2', 'B', '3', '0', '1')])
  assert.equal(elsewhere.item.outcome, 'fail')
  assert.deepEqual(lineKeys(elsewhere.item, 'onlyIms'), ['PO1|A', 'PO1|B'])
  assert.deepEqual(lineKeys(elsewhere.item, 'onlyVendor'), ['PO2|A', 'PO2|B'])
  const omitted = await run('R8', mine, [poLine('PO1', 'A', '10', '0', '1')])
  assert.equal(omitted.item.outcome, 'fail')
  assert.deepEqual(lineKeys(omitted.item, 'onlyIms'), ['PO1|B'])
  const extra = await run('R8', mine, [poLine('PO1', 'A', '10', '0', '1'), poLine('PO1', 'B', '3', '0', '1'), poLine('PO1', 'C', '1', '0', '1')])
  assert.deepEqual(lineKeys(extra.item, 'onlyVendor'), ['PO1|C'])
  // An IMS order the references do not explain is an IMS-only line, never dropped.
  const native = await run('R8', [po('PO1', [line('A', '10', '0', '1')]), po('N', [line('Z', '1', '0', '1')], { reference: 'PO-1' })], [poLine('PO1', 'A', '10', '0', '1')])
  assert.deepEqual(lineKeys(native.item, 'onlyIms'), [`${identityToken('ims-id', 'po-N')}|Z`])
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
  // an IMS order in an incoming status with every line received, absent from the export, is an ORDER-level finding (it has no open line to show)
  const noLines = await run('R8', [po('PO1', [line('A', '2', '2', '1')])], [])
  assert.equal(noLines.item.outcome, 'fail')
  assert.deepEqual(keys(noLines.item, 'onlyIms'), [`PO1|${ORDER_LINES_TOKEN}`])
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
  const theirs = qoblexSide([poLine('PO1', 'A', '2', '1', '3'), poLine('PO1', 'B', '1', '1', '3')], { mine: new Map(), fxRates: [] })
  assert.ok(theirs.ok)
  const order = [...theirs.orders.values()][0]!
  assert.equal(order.value.toFixed(), '3')
  assert.equal(order.lines.size, 1)
})

// [mutation: R8 emits rows only for nonzero-outstanding lines]
test('R8 ORDER PRESENCE: PO1 matching plus an IMS incoming order PO2 whose lines are all received and which the export omits cannot pass; the order-level count is judged on a matched order too', async () => {
  const mine = [po('PO1', [line('A', '10', '4', '2')]), po('PO2', [line('B', '5', '5', '1')])]
  const lines = [poLine('PO1', 'A', '10', '4', '2')]
  const r = await run('R8', mine, lines)
  assert.equal(r.item.outcome, 'fail')
  assert.deepEqual(keys(r.item, 'onlyIms'), [`PO2|${ORDER_LINES_TOKEN}`])
  assert.deepEqual(keys(r.item, 'bothEqual'), [`PO1|${ORDER_LINES_TOKEN}`, 'PO1|A'].sort())
  // with the order in the export too, R8 has nothing to compare for PO2 beyond its (zero) count, and Qoblex lists none: still a finding, never a pass
  const both = await run('R8', mine, [...lines, poLine('PO2', 'B', '5', '5', '1')])
  assert.equal(both.item.outcome, 'fail')
  // an order whose count of open lines differs is a difference even when the lines it shares are equal
  const extra = await run('R8', [po('PO1', [line('A', '10', '4', '2'), line('C', '1', '0', '1')])], lines)
  assert.equal(extra.item.outcome, 'fail')
})

// ---- the population: first-load provenance, order-level discount ------------------------------------------------------------------

// [mutation: the population taken from the reference prefix / from the export / native orders judged]
test('POPULATION BY RECORDED PROVENANCE: an incoming IMS order the first load did not create is listed out of the population and never judged or matched (whatever its reference looks like); an export order with no in-scope IMS match is onlyVendor; a first-load order the export omits is onlyIms', async () => {
  const loaded = po('PO1', [line('A', '10', '4', '2')])
  const native = po('PO2', [line('B', '5', '0', '1')])   // its reference carries the prefix, but nothing records the first load creating it
  const fixture = { native: [native.id] }
  for (const id of ['R7', 'R8'] as const) {
    const ok = await run(id, [loaded, native], [poLine('PO1', 'A', '10', '4', '2')], { fixture })
    assert.equal(ok.item.outcome, 'pass', id)
    const outside = keys(ok.item, 'outOfPopulation')
    assert.ok(outside.length >= 1 && outside.every((k) => k.startsWith(identityToken('ims-id', native.id))), `${id} ${outside.join()}`)
    assert.ok(!keys(ok.item, 'bothEqual').some((k) => k.startsWith(identityToken('ims-id', native.id))))
    // an export order carrying the native order's number does not match it: onlyVendor
    const claims = await run(id, [loaded, native], [poLine('PO1', 'A', '10', '4', '2'), poLine('PO2', 'B', '5', '0', '1')], { fixture })
    assert.equal(claims.item.outcome, 'fail', id)
    assert.ok(keys(claims.item, 'onlyVendor').some((k) => k.startsWith('PO2')), id)
    // a first-load order the export omits cannot pass
    const omitted = await run(id, [loaded, native], [], { fixture })
    assert.equal(omitted.item.outcome, 'fail', id)
    assert.ok(keys(omitted.item, 'onlyIms').some((k) => k.startsWith('PO1')), id)
  }
  // with only native orders in IMS and an empty report the named empty proof holds (nothing the first load created is incoming), the natives listed
  const onlyNative = await run('R8', [native], [], { fixture })
  assert.equal(onlyNative.item.outcome, 'pass')
  assert.deepEqual(onlyNative.item.proof, { kind: 'proven-empty', source: 'qoblex-incoming-report-empty' })
  assert.ok(keys(onlyNative.item, 'outOfPopulation').length >= 1)
})

// [mutation: the provenance checks removed]
test('PROVENANCE MUST BE RECORDED, OF THE VERIFIED RUN, AND COMPLETE: none, an unverified run, no run-record count, or attributed lines that differ from what the run created (a pruned log) is NO_POPULATION_RECORD; an unreadable section is its own reason', async () => {
  const orders = [po('PO1', [line('A', '10', '4', '2')])]
  const lines = [poLine('PO1', 'A', '10', '4', '2')]
  const arms: Array<[string, Fixture['provenance']]> = [['no run', null], ['unverified run', { status: 'APPLIED' }], ['no count', { journalCreated: null }], ['pruned (fewer lines attributed)', { attributedLines: 0, attributed: [] }], ['more lines than created', { journalCreated: 0 }]]
  for (const id of ['R7', 'R8'] as const) {
    for (const [label, provenance] of arms) {
      const r = await run(id, orders, lines, { fixture: { provenance } })
      assert.deepEqual([r.item.outcome, r.item.reasons], ['inconclusive', ['NO_POPULATION_RECORD']], `${id} ${label}`)
    }
    const missing = await runPoItem(id, { phase: 'P2', ims: ims({ orders, noSection: 'firstLoadProvenance' }).port, qoblex: sourceOf({ purchaseOrders: poLines(lines) }) })
    assert.deepEqual([missing.outcome, missing.reasons], ['inconclusive', ['SOURCE_UNREADABLE']], id)
  }
})

// [mutation: the discount check removed / applied to out-of-scope orders / to R8]
test('ORDER-LEVEL DISCOUNT: an in-scope order with a non-zero order discount makes R7 inconclusive (the export cannot express it, so it could pass with the discount on one side only); a native order\'s discount is out of scope; R8 compares quantities and is unaffected', async () => {
  const discounted = po('PO1', [line('A', '10', '4', '2')], { discount: '5.00' })
  const lines = [poLine('PO1', 'A', '10', '4', '2')]
  const r7 = await run('R7', [discounted], lines)
  assert.deepEqual([r7.item.outcome, r7.item.reasons], ['inconclusive', ['VALUE_SHAPE_MISMATCH']])
  assert.equal((await run('R8', [discounted], lines)).item.outcome, 'pass')
  assert.equal((await run('R7', [discounted], lines, { fixture: { native: [discounted.id] } })).item.reasons[0], 'DIFFERENCES', 'a native order is out of scope; the export order is then onlyVendor')
  assert.equal((await run('R7', [po('PO1', [line('A', '10', '4', '2')], { discount: '0.000000' })], lines)).item.outcome, 'pass')
})
