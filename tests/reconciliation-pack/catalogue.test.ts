import assert from 'node:assert/strict'
import test from 'node:test'

import { PACK_ITEMS, REQUIRED_READ_SYNC_STREAMS } from '../../lib/ops/readiness-gate-constants.ts'
import { READ_SYNC_STREAM_IDS } from '../../lib/ops/read-sync-liveness-constants.ts'
import {
  PACK_CADENCES, PACK_CADENCE_MAX_AGE_MS, PACK_ITEM_CATALOGUE, PACK_ITEM_IDS, PACK_REASON_CODES, PACK_REASON_CODE_LIST, PACK_CHAIN_CODES,
  PENDING_PERSISTENCE_RUNS, TOLERANCE_RULES, getPackItem, isPackReasonCode, itemApplicability, packExitCode, COMPARISON_BUCKETS, FINDING_BUCKETS,
  EXACT_DECIMAL_TOLERANCE, R5_ABSOLUTE_FLOOR_GBP, R5_RELATIVE_FRACTION,
} from '../../lib/reconciliation-pack/constants.ts'

test('the catalogue is R1..R16 once each, in order, with the gate\'s own titles', () => {
  assert.deepEqual(PACK_ITEM_CATALOGUE.map((s) => s.id), [...PACK_ITEM_IDS])
  assert.equal(PACK_ITEM_CATALOGUE.length, 16)
  for (const spec of PACK_ITEM_CATALOGUE) assert.equal(spec.title, PACK_ITEMS.find((i) => i.id === spec.id)!.title)
})

test('every item states a claim, a tolerance rule with a source, a cadence, all three phases and its dependent streams', () => {
  for (const spec of PACK_ITEM_CATALOGUE) {
    assert.ok(spec.claim.length > 20, spec.id)
    assert.ok((TOLERANCE_RULES as readonly string[]).includes(spec.tolerance.rule), spec.id)
    assert.ok(spec.tolerance.value.length > 0 && spec.tolerance.source.length > 0, spec.id)
    assert.ok((PACK_CADENCES as readonly string[]).includes(spec.cadence), spec.id)
    assert.ok(spec.population.length > 10, spec.id)
    assert.deepEqual(Object.keys(spec.phases).sort(), ['P0', 'P1', 'P2'])
    for (const stream of spec.streams) {
      assert.ok((READ_SYNC_STREAM_IDS as readonly string[]).includes(stream), `${spec.id} ${stream}`)
      assert.ok((REQUIRED_READ_SYNC_STREAMS as readonly string[]).includes(stream), `${spec.id} ${stream}`)
    }
  }
})

test('the chosen tolerances are the owner-accepted ones', () => {
  assert.equal(EXACT_DECIMAL_TOLERANCE, '0.0001')
  assert.deepEqual([R5_ABSOLUTE_FLOOR_GBP, R5_RELATIVE_FRACTION], ['1', '0.0005'])
  assert.deepEqual([getPackItem('R1').tolerance.rule, getPackItem('R1').tolerance.value], ['exact', '0.0001'])
  assert.deepEqual([getPackItem('R5').tolerance.rule, getPackItem('R5').exactness], ['composite-max-abs-or-relative', 'tolerance'])
  assert.deepEqual([getPackItem('R6').tolerance.rule, getPackItem('R6').tolerance.value], ['absolute', '1'])
  assert.deepEqual([getPackItem('R9').tolerance.rule], ['order-currency-minor-unit'])
  assert.deepEqual([getPackItem('R12').tolerance.rule, getPackItem('R12').tolerance.value], ['absolute', '0.05'])
  assert.deepEqual([getPackItem('R12').cadence, getPackItem('R5').cadence, getPackItem('R1').cadence], ['monthly', 'weekly', 'daily'])
  assert.equal(PENDING_PERSISTENCE_RUNS, 2)
})

test('phase applicability: R3, R4 and R15 everywhere; R7, R8 and R11 only at P2; R2 is listed-only at P1', () => {
  for (const id of ['R3', 'R4', 'R15'] as const) for (const phase of ['P0', 'P1', 'P2'] as const) assert.equal(itemApplicability(id, phase), 'applicable')
  for (const id of ['R7', 'R8', 'R11'] as const) assert.deepEqual((['P0', 'P1', 'P2'] as const).map((p) => itemApplicability(id, p)), ['not-applicable', 'not-applicable', 'applicable'])
  assert.deepEqual((['P0', 'P1', 'P2'] as const).map((p) => itemApplicability('R2', p)), ['not-applicable', 'listed-only', 'applicable'])
  // nothing that applies at P1 stops applying at P2
  for (const spec of PACK_ITEM_CATALOGUE) if (spec.phases.P1 === 'applicable') assert.equal(spec.phases.P2, 'applicable', spec.id)
})

test('cadence limits are daily 36 h, weekly 8 d, monthly 35 d', () => {
  assert.deepEqual(PACK_CADENCE_MAX_AGE_MS, { daily: 36 * 3600_000, weekly: 8 * 86_400_000, monthly: 35 * 86_400_000 })
})

test('reason codes are a closed set: every one has a meaning, the guard rejects everything else', () => {
  assert.equal(PACK_REASON_CODE_LIST.length, Object.keys(PACK_REASON_CODES).length)
  for (const code of PACK_REASON_CODE_LIST) { assert.ok(PACK_REASON_CODES[code].length > 10); assert.equal(isPackReasonCode(code), true) }
  for (const bad of ['', 'diff', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'DIFFERENCES ', null, undefined, 5, {}]) assert.equal(isPackReasonCode(bad), false, String(bad))
  assert.equal(Object.keys(PACK_CHAIN_CODES).filter((c) => (PACK_REASON_CODES as Record<string, string>)[c] !== undefined).length, 0, 'refusal codes and reason codes do not overlap')
})

test('exit codes are looked up by name from the one table; an unknown name throws', () => {
  assert.equal(packExitCode('all-pass'), 0)
  assert.equal(packExitCode('inconclusive'), 5)
  assert.throws(() => packExitCode('go'))
})

test('buckets: the finding buckets are a subset of the comparison buckets', () => {
  for (const b of FINDING_BUCKETS) assert.ok((COMPARISON_BUCKETS as readonly string[]).includes(b))
  assert.equal(new Set(COMPARISON_BUCKETS).size, 7)
})

test('only R1 and R9 settle (owner decision D7): their dependent streams are the stock sync and the order sweep; every other item fails on the run that sees a difference', () => {
  assert.deepEqual(PACK_ITEM_CATALOGUE.filter((spec) => spec.settles).map((spec) => spec.id), ['R1', 'R9'])
  assert.deepEqual(getPackItem('R1').streams, ['mintsoft-stock-sync'])
  assert.deepEqual(getPackItem('R9').streams, ['woocommerce-order-sweep'])
  for (const spec of PACK_ITEM_CATALOGUE) if (spec.settles) assert.ok(spec.streams.length > 0, `${spec.id} needs a stream to settle under`)
})
