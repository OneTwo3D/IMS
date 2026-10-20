import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceDifference, bracketStable, bucketCounts, compareKeyed, outcomeOfComparison, parseDecimalStrict, toleranceLimit, withinTolerance,
  type CarriedDifference, type CompareInput, type CompareResult, type SideRow, type Tolerance,
} from '../../lib/reconciliation-pack/compare.ts'
import { canonicalKey, keyToken, type KeyPart } from '../../lib/reconciliation-pack/identity.ts'

const key = (sku: string, warehouse = 'MAIN'): KeyPart[] => [{ kind: 'sku', raw: sku }, { kind: 'warehouse', raw: warehouse }]
const row = (sku: string, value: string | null, extra: Partial<SideRow> = {}): SideRow => ({ key: key(sku), value, ...extra })
const D = (value: string) => parseDecimalStrict(value)!
const EXACT: Tolerance = { rule: 'exact' }

function compare(over: Partial<CompareInput> & Pick<CompareInput, 'ims' | 'vendor'>): CompareResult {
  return compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: EXACT, ...over })
}
function buckets(result: CompareResult) {
  assert.equal(result.status, 'compared')
  return (result as Extract<CompareResult, { status: 'compared' }>).buckets
}
const tokens = (entries: Array<{ key: string }>) => entries.map((e) => e.key)

test('equal sets pass and the counts are derived from the lists', () => {
  const result = compare({ ims: [row('A', '1'), row('B', '2.5')], vendor: [row('B', '2.5'), row('A', '1')] })
  const b = buckets(result)
  assert.deepEqual(bucketCounts(b), { onlyIms: 0, onlyVendor: 0, bothEqual: 2, bothDiffer: 0, unsettled: 0, outOfPopulation: 0, excluded: 0 })
  assert.deepEqual(outcomeOfComparison(result), { outcome: 'pass', reasons: [] })
})

test('IDENTITY SWAP: equal counts, equal values, one identity swapped => fail with one onlyIms and one onlyVendor', () => {
  const result = compare({ ims: [row('A', '5'), row('B', '7')], vendor: [row('A', '5'), row('C', '7')] })
  const b = buckets(result)
  assert.deepEqual(tokens(b.onlyIms), ['B|MAIN'])
  assert.deepEqual(tokens(b.onlyVendor), ['C|MAIN'])
  assert.equal(b.bothEqual.length, 1)
  assert.equal(outcomeOfComparison(result).outcome, 'fail')
})

test('the same SKU in two warehouses is two identities: a warehouse swap fails', () => {
  const ims = [{ key: key('A', 'MAIN'), value: '1' }, { key: key('A', 'EAST'), value: '2' }]
  const vendor = [{ key: key('A', 'MAIN'), value: '2' }, { key: key('A', 'EAST'), value: '1' }]
  assert.equal(outcomeOfComparison(compare({ ims, vendor })).outcome, 'fail')
})

test('exact tolerance is 0.0001 and inclusive', () => {
  assert.equal(withinTolerance(EXACT, D('10'), D('10.0001')), true)
  assert.equal(withinTolerance(EXACT, D('10'), D('10.0002')), false)
  assert.equal(withinTolerance(EXACT, D('-3'), D('-3.0001')), true)
  const result = compare({ ims: [row('A', '10')], vendor: [row('A', '10.0002')] })
  assert.deepEqual(tokens(buckets(result).bothDiffer), ['A|MAIN'])
  assert.equal(buckets(result).bothDiffer[0]!.delta, '-0.0002')
})

test('absolute tolerance (GBP 1, GBP 0.05) is inclusive of its limit', () => {
  const gbp1: Tolerance = { rule: 'absolute', limit: '1' }
  assert.equal(withinTolerance(gbp1, D('100'), D('101')), true)
  assert.equal(withinTolerance(gbp1, D('100'), D('101.01')), false)
  const vat: Tolerance = { rule: 'absolute', limit: '0.05' }
  assert.equal(withinTolerance(vat, D('10'), D('10.05')), true)
  assert.equal(withinTolerance(vat, D('10'), D('10.06')), false)
})

test('R5 composite: max(GBP 1, 0.05% of the larger total), symmetric', () => {
  const r5: Tolerance = { rule: 'composite', floor: '1', fraction: '0.0005' }
  // floor dominates on small totals
  assert.equal(withinTolerance(r5, D('100'), D('100.99'), null), true)
  assert.equal(withinTolerance(r5, D('100'), D('101.01'), null), false)
  // relative dominates on large totals: 0.05% of 1,000,000 is 500
  assert.equal(withinTolerance(r5, D('1000000'), D('999500.01'), null), true)
  assert.equal(withinTolerance(r5, D('1000000'), D('999499.99'), null), false)
  // symmetric: swapping the sides changes nothing
  assert.equal(withinTolerance(r5, D('999500.01'), D('1000000'), null), true)
  assert.equal(withinTolerance(r5, D('999499.99'), D('1000000'), null), false)
  assert.equal(toleranceLimit(r5, D('0'), D('0'))!.toFixed(), '1')
  assert.equal(toleranceLimit(r5, D('-2000000'), D('0'))!.toFixed(), '1000')
})

test('order-currency minor-unit rule: one minor unit of THAT currency', () => {
  const minor: Tolerance = { rule: 'minor-unit' }
  assert.equal(withinTolerance(minor, D('10.00'), D('10.01'), 'GBP'), true)
  assert.equal(withinTolerance(minor, D('10.00'), D('10.02'), 'GBP'), false)
  assert.equal(withinTolerance(minor, D('100'), D('101'), 'JPY'), true)
  assert.equal(withinTolerance(minor, D('100'), D('102'), 'JPY'), false)
  assert.equal(withinTolerance(minor, D('1.000'), D('1.001'), 'KWD'), true)
  assert.equal(withinTolerance(minor, D('1.000'), D('1.002'), 'KWD'), false)
  for (const bad of [null, undefined, '', 'gbp', 'GBPX', 'G1']) assert.equal(withinTolerance(minor, D('1'), D('1'), bad), null, String(bad))
})

test('minor-unit comparison: an unknown currency is unreadable, a currency disagreement is a difference', () => {
  const minor: Tolerance = { rule: 'minor-unit' }
  const unknown = compare({ tolerance: minor, ims: [row('A', '10', { currency: null })], vendor: [row('A', '10', { currency: null })] })
  assert.deepEqual(unknown, { status: 'unreadable', reason: 'CURRENCY_UNKNOWN' })
  const mismatch = compare({ tolerance: minor, ims: [row('A', '10', { currency: 'GBP' })], vendor: [row('A', '10', { currency: 'EUR' })] })
  assert.deepEqual(tokens(buckets(mismatch).bothDiffer), ['A|MAIN'])
  const ok = compare({ tolerance: minor, ims: [row('A', '10.00', { currency: 'GBP' })], vendor: [row('A', '10.01', { currency: 'GBP' })] })
  assert.equal(outcomeOfComparison(ok).outcome, 'pass')
})

test('values are plain decimals only: NaN, exponents, whitespace, empty and numbers are BAD_VALUE, never dropped', () => {
  for (const bad of ['NaN', '1e3', ' 1', '1 ', '', '0x10', '1,5', '--1', '+1', 'Infinity', '01', '.5']) {
    assert.deepEqual(compare({ ims: [row('A', bad)], vendor: [row('A', '1')] }), { status: 'unreadable', reason: 'BAD_VALUE' }, JSON.stringify(bad))
    assert.deepEqual(compare({ ims: [row('A', '1')], vendor: [row('A', bad)] }), { status: 'unreadable', reason: 'BAD_VALUE' }, JSON.stringify(bad))
  }
  assert.deepEqual(compare({ ims: [{ key: key('A'), value: 5 as unknown as string }], vendor: [row('A', '5')] }), { status: 'unreadable', reason: 'BAD_VALUE' })
})

test('a duplicate identity on a side is never summed or picked between', () => {
  assert.deepEqual(compare({ ims: [row('A', '1'), row('A', '1')], vendor: [row('A', '2')] }), { status: 'unreadable', reason: 'DUPLICATE_KEY' })
  assert.deepEqual(compare({ ims: [row('A', '2')], vendor: [row('A', '1'), row('A', '1')] }), { status: 'unreadable', reason: 'DUPLICATE_KEY' })
})

test('presence mode compares identities only; values mode demands a value on every row of both sides', () => {
  const presence = compare({ mode: 'presence', ims: [row('A', null), row('B', null)], vendor: [row('A', null)] })
  assert.deepEqual(tokens(buckets(presence).onlyIms), ['B|MAIN'])
  assert.equal(buckets(presence).bothEqual.length, 1)
  assert.deepEqual(compare({ mode: 'presence', ims: [row('A', '1')], vendor: [row('A', null)] }), { status: 'unreadable', reason: 'VALUE_SHAPE_MISMATCH' })
  assert.deepEqual(compare({ ims: [row('A', null)], vendor: [row('A', null)] }), { status: 'unreadable', reason: 'VALUE_MISSING' }, 'missing on both sides is not equal')
  assert.deepEqual(compare({ ims: [row('A', '1')], vendor: [row('A', null)] }), { status: 'unreadable', reason: 'VALUE_MISSING' })
  assert.deepEqual(compare({ ims: [row('A', '1'), row('B', null)], vendor: [row('A', '1'), row('B', '1')] }), { status: 'unreadable', reason: 'VALUE_MISSING' })
})

test('a side not known complete never passes', () => {
  const rows = [row('A', '1')]
  assert.deepEqual(compare({ ims: rows, vendor: rows, imsComplete: false }), { status: 'unreadable', reason: 'READ_INCOMPLETE' })
  assert.deepEqual(compare({ ims: rows, vendor: rows, vendorComplete: false }), { status: 'unreadable', reason: 'READ_INCOMPLETE' })
})

test('"looks empty": nothing compared is EMPTY_UNPROVEN unless positive evidence is supplied', () => {
  assert.deepEqual(compare({ ims: [], vendor: [] }), { status: 'unreadable', reason: 'EMPTY_UNPROVEN' })
  assert.equal(outcomeOfComparison(compare({ ims: [], vendor: [] })).outcome, 'inconclusive')
  assert.equal(outcomeOfComparison(compare({ ims: [], vendor: [], emptyProof: 'vendor-total-zero' })).outcome, 'pass')
  // everything outside the population is also "nothing compared"
  const outside = compare({ ims: [row('A', '1')], vendor: [row('A', '1')], population: new Set() })
  assert.deepEqual(outside, { status: 'unreadable', reason: 'EMPTY_UNPROVEN' })
})

test('identities outside the RECORDED population are listed, never findings', () => {
  const population = new Set([canonicalKey(key('A'))])
  const result = compare({ ims: [row('A', '1'), row('OLD', '9')], vendor: [row('A', '1'), row('OLD2', '3')], population })
  const b = buckets(result)
  assert.deepEqual(tokens(b.outOfPopulation).sort(), ['OLD2|MAIN', 'OLD|MAIN'])
  assert.equal(b.onlyIms.length + b.onlyVendor.length + b.bothDiffer.length, 0)
  assert.equal(outcomeOfComparison(result).outcome, 'pass')
})

test('a written exclusion lists the identity and keeps it out of the findings', () => {
  const excluded = new Set([canonicalKey(key('X'))])
  const result = compare({ ims: [row('A', '1'), row('X', '1')], vendor: [row('A', '1')], excluded })
  assert.deepEqual(tokens(buckets(result).excluded), ['X|MAIN'])
  assert.equal(outcomeOfComparison(result).outcome, 'pass')
  // without the exclusion the same data fails
  assert.equal(outcomeOfComparison(compare({ ims: [row('A', '1'), row('X', '1')], vendor: [row('A', '1')] })).outcome, 'fail')
})

test('raw hostile identities never appear in any entry', () => {
  const hostile = 'victim@example.com'
  const result = compare({ ims: [row(hostile, '1')], vendor: [] })
  assert.ok(!JSON.stringify(result).includes(hostile))
  assert.equal(tokens(buckets(result).onlyIms)[0], keyToken(key(hostile)))
})

// ---- the stability bracket and pending persistence -------------------------------------------------

const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'
const T3 = '2026-10-03T00:00:00.000Z'
const T4 = '2026-10-04T00:00:00.000Z'

function run(stamp: string | null, carried: ReadonlyMap<string, CarriedDifference>, ims = '1', vendor = '2') {
  const result = compare({ ims: [row('A', ims)], vendor: [row('A', vendor)], settling: { carried, stamp } })
  return result as Extract<CompareResult, { status: 'compared' }>
}

test('a difference fails only after two LATER successful runs of its stream (distinct stamps)', () => {
  const first = run(T1, new Map())
  assert.equal(first.buckets.unsettled.length, 1)
  assert.deepEqual(first.buckets.unsettled[0]!.settling, { first: T1, later: [] })
  assert.deepEqual(outcomeOfComparison(first), { outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'] })
  const second = run(T2, first.nextCarried)
  assert.equal(second.buckets.unsettled.length, 1)
  assert.deepEqual(second.buckets.unsettled[0]!.settling, { first: T1, later: [T2] })
  assert.equal(outcomeOfComparison(second).outcome, 'inconclusive')
  const third = run(T3, second.nextCarried)
  assert.equal(third.buckets.unsettled.length, 0)
  assert.equal(third.buckets.bothDiffer.length, 1)
  assert.deepEqual(outcomeOfComparison(third), { outcome: 'fail', reasons: ['DIFFERENCES'] })
  // and it stays failed on the next run, whatever the stamp
  const fourth = run(T4, third.nextCarried)
  assert.equal(fourth.buckets.bothDiffer.length, 1)
})

test('a repeated stamp is the same run: no progress, however often it is seen', () => {
  let carried: ReadonlyMap<string, CarriedDifference> = new Map()
  for (let i = 0; i < 6; i += 1) {
    const result = run(T1, carried)
    assert.equal(result.buckets.unsettled.length, 1)
    assert.equal(result.buckets.bothDiffer.length, 0)
    carried = result.nextCarried
  }
  const afterOne = run(T2, carried)
  const repeatedLater = run(T2, afterOne.nextCarried)
  assert.equal(repeatedLater.buckets.bothDiffer.length, 0, 'T2 seen twice counts once')
  assert.equal(run(T3, repeatedLater.nextCarried).buckets.bothDiffer.length, 1)
})

test('NO ORDER from timestamps: descending or arbitrary distinct stamps count exactly the same', () => {
  const a = run(T4, new Map())
  const b = run(T1, a.nextCarried)
  const c = run(T3, b.nextCarried)
  assert.equal(c.buckets.bothDiffer.length, 1)
  assert.deepEqual(outcomeOfComparison(c).outcome, 'fail')
})

test('a difference that goes away is dropped from the carried state, and returns as new', () => {
  const first = run(T1, new Map())
  const healed = run(T2, first.nextCarried, '2', '2')
  assert.equal(healed.nextCarried.size, 0)
  assert.equal(outcomeOfComparison(healed).outcome, 'pass')
  const back = run(T3, healed.nextCarried)
  assert.deepEqual(back.buckets.unsettled[0]!.settling, { first: T3, later: [] })
})

test('a difference that changes kind restarts its count', () => {
  const first = run(T1, new Map())
  const kinds = compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: EXACT, ims: [row('A', '1')], vendor: [], settling: { carried: first.nextCarried, stamp: T2 } }) as Extract<CompareResult, { status: 'compared' }>
  assert.deepEqual(kinds.buckets.unsettled[0]!.settling, { first: T2, later: [] })
})

test('onlyIms and onlyVendor settle the same way as a value difference', () => {
  let carried: ReadonlyMap<string, CarriedDifference> = new Map()
  for (const stamp of [T1, T2]) {
    const r = compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: EXACT, ims: [], vendor: [row('V', '1')], settling: { carried, stamp } }) as Extract<CompareResult, { status: 'compared' }>
    assert.equal(r.buckets.unsettled.length, 1)
    carried = r.nextCarried
  }
  const done = compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: EXACT, ims: [], vendor: [row('V', '1')], settling: { carried, stamp: T3 } }) as Extract<CompareResult, { status: 'compared' }>
  assert.deepEqual(tokens(done.buckets.onlyVendor), ['V|MAIN'])
})

test('settling needs a usable stamp: a missing or malformed one is STALE_BASIS', () => {
  for (const stamp of [null, '', 'yesterday', '2026-10-01', '2026-13-45T00:00:00Z']) {
    assert.deepEqual(compare({ ims: [row('A', '1')], vendor: [row('A', '2')], settling: { carried: new Map(), stamp } }), { status: 'unreadable', reason: 'STALE_BASIS' }, String(stamp))
  }
})

test('advanceDifference: the pure rule, directly', () => {
  assert.deepEqual(advanceDifference('onlyIms', undefined, T1), { carried: { kind: 'onlyIms', first: T1, later: [] }, persisted: false })
  const mid = advanceDifference('onlyIms', { kind: 'onlyIms', first: T1, later: [] }, T2)
  assert.deepEqual(mid, { carried: { kind: 'onlyIms', first: T1, later: [T2] }, persisted: false })
  assert.equal(advanceDifference('onlyIms', mid.carried, T3).persisted, true)
  assert.equal(advanceDifference('onlyIms', mid.carried, T1).persisted, false)
  assert.equal(advanceDifference('onlyIms', mid.carried, T2).persisted, false)
})

test('the stability bracket is equality of both stamps and nothing else', () => {
  assert.equal(bracketStable(T1, T1), true)
  assert.equal(bracketStable(T1, T2), false)
  assert.equal(bracketStable(T2, T1), false)
  assert.equal(bracketStable(null, null), false)
  assert.equal(bracketStable(T1, null), false)
  assert.equal(bracketStable('x', 'x'), false)
})

test('outcome: a finding beats unsettled; unsettled alone is never a pass', () => {
  const both = compare({ ims: [row('A', '1'), row('B', '1')], vendor: [row('A', '2'), row('B', '1')], settling: { carried: new Map([['A|MAIN', { kind: 'bothDiffer' as const, first: T1, later: [T2, T3] }]]), stamp: T4 } })
  assert.deepEqual(outcomeOfComparison(both), { outcome: 'fail', reasons: ['DIFFERENCES'] })
  const mix = compare({ ims: [row('A', '1'), row('B', '1')], vendor: [row('A', '2'), row('C', '1')], settling: { carried: new Map([['A|MAIN', { kind: 'bothDiffer' as const, first: T1, later: [T2, T3] }]]), stamp: T4 } })
  assert.deepEqual(outcomeOfComparison(mix), { outcome: 'fail', reasons: ['DIFFERENCES', 'UNSETTLED_PENDING'] })
})
