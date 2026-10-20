import assert from 'node:assert/strict'
import test from 'node:test'

import { compareKeyed, decimalText, isUsableTolerance, outcomeOfComparison, parseDecimalStrict, withinTolerance, type CompareInput, type CompareResult, type SideRow, type Tolerance } from '../../lib/reconciliation-pack/compare.ts'
import { PACK_ITEM_CATALOGUE, PACK_INPUT_SHAPES, PACK_KNOWN_CURRENCIES, getPackItem, isKnownCurrency, type PackReasonCode } from '../../lib/reconciliation-pack/constants.ts'
import { canonicalKey, isKey } from '../../lib/reconciliation-pack/identity.ts'
import { currencyMinorUnits } from '../../lib/domain/math/decimal.ts'

/**
 * EVERY INPUT SHAPE THE COMPARATOR REFUSES, ONE CASE EACH (the table is PACK_INPUT_SHAPES in constants). Whatever a
 * case does, the result must be `unreadable` with the stated closed code, the outcome inconclusive, and nothing in a
 * bucket: no unreadable shape may reach bothEqual or a pass.
 */

const key = (raw: unknown, kind: 'sku' | 'warehouse' = 'sku') => [{ kind, raw }] as never
// An explicit undefined stays undefined (a default parameter would turn it into '1').
const row = (raw: unknown, ...rest: [value?: unknown, extra?: Record<string, unknown>]): SideRow => ({ key: key(raw), value: (rest.length > 0 ? rest[0] : '1') as never, ...(rest[1] ?? {}) } as SideRow)
const EXACT: Tolerance = { rule: 'exact' }
function run(over: Partial<Record<keyof CompareInput, unknown>> = {}): CompareResult {
  const base = { ims: [row('A')], vendor: [row('A')], imsComplete: true, vendorComplete: true, mode: 'values', tolerance: EXACT }
  return compareKeyed({ ...base, ...over } as CompareInput)
}
function refused(result: CompareResult, reason: PackReasonCode, label: string) {
  assert.deepEqual(result, { status: 'unreadable', reason }, label)
  assert.deepEqual(outcomeOfComparison(result), { outcome: 'inconclusive', reasons: [reason] }, label)
}

const STAMP = '2026-10-19T00:00:00.000Z'
const cases: Record<string, () => void> = {
  'side-not-array': () => {
    for (const bad of [null, undefined, {}, 'rows', 5, new Set([row('A')]), { length: 1, 0: row('A') }]) {
      refused(run({ ims: bad }), 'SOURCE_UNREADABLE', `ims ${String(bad)}`)
      refused(run({ vendor: bad }), 'SOURCE_UNREADABLE', `vendor ${String(bad)}`)
    }
  },
  'row-not-object': () => { for (const bad of [null, undefined, 5, 'A', ['A'], true]) refused(run({ ims: [bad] }), 'BAD_KEY', String(bad)) },
  'key-not-list': () => { for (const bad of [undefined, null, 'A', { kind: 'sku', raw: 'A' }, 5]) refused(run({ ims: [{ key: bad, value: '1' }] }), 'BAD_KEY', String(bad)) },
  'key-empty': () => refused(run({ ims: [{ key: [], value: '1' }] }), 'BAD_KEY', 'empty list'),
  'key-part-not-object': () => { for (const bad of [null, 'A', 5, ['sku', 'A'], undefined]) refused(run({ ims: [{ key: [bad], value: '1' }] }), 'BAD_KEY', String(bad)) },
  'key-kind-unknown': () => { for (const kind of ['SKU', 'id', '', undefined, null, 5, 'sku ']) refused(run({ ims: [{ key: [{ kind, raw: 'A' }], value: '1' }] }), 'BAD_KEY', String(kind)) },
  'key-raw-object': () => {
    for (const bad of [{ id: 'A' }, { id: 'B' }, {}, [], ['A'], null, undefined, true, false, BigInt(1), new Date(0), () => 'A', Symbol('A')]) {
      refused(run({ ims: [row(bad)], vendor: [row(bad)] }), 'BAD_KEY', `${typeof bad} ${String(Array.isArray(bad) ? 'array' : bad && typeof bad === 'object' ? JSON.stringify(bad) : bad)}`)
    }
    // the reviewed collision: two different objects used to share one canonical form and "matched"
    refused(run({ ims: [row({ id: 'A' })], vendor: [row({ id: 'B' })] }), 'BAD_KEY', '{id:A} against {id:B}')
    assert.throws(() => canonicalKey(key({ id: 'A' })), TypeError)
    assert.equal(isKey(key({ id: 'A' })), false)
  },
  'key-raw-number': () => { for (const bad of [Number.NaN, Infinity, -Infinity, -1, -0.5, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1e21]) refused(run({ ims: [row(bad)], vendor: [row(bad)] }), 'BAD_KEY', String(bad)) },
  'key-raw-string': () => { for (const bad of ['', 'x'.repeat(513), 'a\nb', 'a\u0000b', 'a\u007fb', 'a\tb']) refused(run({ ims: [row(bad)], vendor: [row(bad)] }), 'BAD_KEY', JSON.stringify(bad)) },
  'duplicate-key': () => {
    refused(run({ ims: [row('A'), row('A')] }), 'DUPLICATE_KEY', 'ims twice')
    refused(run({ vendor: [row('A'), row('A', '2')] }), 'DUPLICATE_KEY', 'vendor twice, values differ')
    refused(run({ ims: [row(7), row('7')] }), 'DUPLICATE_KEY', 'a number and its decimal text are one identity')
  },
  'mode-unknown': () => { for (const bad of [undefined, null, '', 'value', 'Values', 'both', 5, true]) refused(run({ mode: bad }), 'BAD_MODE', String(bad)) },
  'value-missing': () => {
    for (const missing of [null, undefined]) {
      refused(run({ ims: [row('A', missing)], vendor: [row('A', '1')] }), 'VALUE_MISSING', `ims ${missing}`)
      refused(run({ ims: [row('A', '1')], vendor: [row('A', missing)] }), 'VALUE_MISSING', `vendor ${missing}`)
      refused(run({ ims: [row('A', missing)], vendor: [row('A', missing)] }), 'VALUE_MISSING', `both ${missing}`)
    }
    refused(run({ ims: [{ key: key('A') }], vendor: [{ key: key('A') }] }), 'VALUE_MISSING', 'no value property at all')
    refused(run({ ims: [row('A'), row('B', null)], vendor: [row('A'), row('B', '1')] }), 'VALUE_MISSING', 'one row of several')
    refused(run({ ims: [row('ONLY', null)], vendor: [] }), 'VALUE_MISSING', 'an unmatched row still needs its value')
  },
  'value-not-decimal': () => {
    const bad = ['NaN', 'nan', 'Infinity', '-Infinity', '', ' ', ' 1', '1 ', '1\n', '1e3', '1E3', '+1', '0x10', '1,5', '1_000', '.5', '5.', '01', '00', '٣', '１', '0.0000000000001', '1'.repeat(31), '--1', '1.2.3', 'one', '1/2', '$1', '1%']
    for (const value of bad) {
      refused(run({ ims: [row('A', value)] }), 'BAD_VALUE', `ims ${JSON.stringify(value)}`)
      refused(run({ vendor: [row('A', value)] }), 'BAD_VALUE', `vendor ${JSON.stringify(value)}`)
    }
    for (const value of [1, 0, -0, Number.NaN, Infinity, 1.5, true, {}, [], BigInt(1), new Date(0)]) refused(run({ ims: [row('A', value)] }), 'BAD_VALUE', `type ${typeof value}`)
  },
  'value-in-presence': () => {
    for (const value of ['1', '0', '', 'x', 0, 1]) refused(run({ mode: 'presence', ims: [row('A', value)], vendor: [row('A', null)] }), 'VALUE_SHAPE_MISMATCH', JSON.stringify(value))
    refused(run({ mode: 'presence', ims: [row('A', null)], vendor: [row('A', '1')] }), 'VALUE_SHAPE_MISMATCH', 'vendor side')
  },
  'tolerance-missing': () => {
    const bad: unknown[] = [undefined, null, {}, 'exact', 5, { rule: 'fuzzy' }, { rule: 'none' }, { rule: 'EXACT' }, { rule: 'absolute' }, { rule: 'absolute', limit: '-1' }, { rule: 'absolute', limit: 'abc' }, { rule: 'absolute', limit: 1 }, { rule: 'absolute', limit: '' }, { rule: 'composite', fraction: '0.1' }, { rule: 'composite', floor: '1' }, { rule: 'composite', floor: '-1', fraction: '0.1' }, { rule: 'composite', floor: '1', fraction: 'x' }]
    for (const tolerance of bad) { refused(run({ tolerance }), 'BAD_TOLERANCE', JSON.stringify(tolerance) ?? 'undefined'); assert.equal(isUsableTolerance(tolerance), false) }
    assert.equal(isUsableTolerance({ rule: 'absolute', limit: '0' }), true)
  },
  'currency-unknown': () => {
    const minor: Tolerance = { rule: 'minor-unit' }
    for (const bad of [null, undefined, '', 'gbp', 'GBP ', ' GBP', 'GB', 'GBPP', 'QQQ', 'XXX', 'XAU', 'ZZZ', 'ABC', 'G1P', 5, {}, true]) {
      refused(run({ tolerance: minor, ims: [row('A', '1', { currency: bad })], vendor: [row('A', '1', { currency: 'GBP' })] }), 'CURRENCY_UNKNOWN', `ims ${String(bad)}`)
      refused(run({ tolerance: minor, ims: [row('A', '1', { currency: 'GBP' })], vendor: [row('A', '1', { currency: bad })] }), 'CURRENCY_UNKNOWN', `vendor ${String(bad)}`)
      // an unmatched row with an unusable currency is refused too
      refused(run({ tolerance: minor, ims: [row('A', '1', { currency: bad })], vendor: [] }), 'CURRENCY_UNKNOWN', `unmatched ${String(bad)}`)
    }
    assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1')!, 'QQQ'), null)
    assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1')!, 'gbp'), null)
  },
  'currency-one-sided': () => {
    refused(run({ ims: [row('A', '1', { currency: 'GBP' })], vendor: [row('A', '1')] }), 'CURRENCY_UNKNOWN', 'ims only')
    refused(run({ ims: [row('A', '1')], vendor: [row('A', '1', { currency: 'GBP' })] }), 'CURRENCY_UNKNOWN', 'vendor only')
    refused(run({ ims: [row('A', '1', { currency: 'QQQ' })], vendor: [row('A', '1', { currency: 'QQQ' })] }), 'CURRENCY_UNKNOWN', 'both unknown, equal')
  },
  'complete-not-true': () => {
    for (const bad of [false, undefined, null, 'true', 'yes', 1, {}, []]) {
      refused(run({ imsComplete: bad }), 'READ_INCOMPLETE', `ims ${String(bad)}`)
      refused(run({ vendorComplete: bad }), 'READ_INCOMPLETE', `vendor ${String(bad)}`)
    }
  },
  'empty-unproven': () => {
    for (const bad of [undefined, null, '', 'because', 'VENDOR-TOTAL-ZERO', true, 1, {}]) refused(run({ ims: [], vendor: [], emptyProof: bad }), 'EMPTY_UNPROVEN', String(bad))
    refused(run({ population: new Set(), emptyProof: undefined }), 'EMPTY_UNPROVEN', 'everything outside the population')
  },
  'population-not-set': () => {
    for (const bad of [[], {}, 'A', ['A|MAIN'], null, new Map(), new WeakSet()]) {
      refused(run({ population: bad }), 'NO_POPULATION_RECORD', `population ${String(bad)}`)
      refused(run({ excluded: bad }), 'NO_POPULATION_RECORD', `excluded ${String(bad)}`)
    }
  },
  'carried-malformed': () => {
    const good = { kind: 'bothDiffer', first: STAMP, later: [] }
    const bad: unknown[] = [[], {}, null, 'x', new Map([['A|MAIN', null]]), new Map([['A|MAIN', 'x']]), new Map([['A|MAIN', { ...good, kind: 'both' }]]), new Map([['A|MAIN', { ...good, first: 'yesterday' }]]), new Map([['A|MAIN', { ...good, later: 'x' }]]), new Map([['A|MAIN', { ...good, later: ['soon'] }]]), new Map([[5, good]])]
    for (const carried of bad) refused(run({ settling: { carried, stamp: STAMP } }), 'SOURCE_UNREADABLE', String(carried))
  },
  'stamp-unusable': () => { for (const stamp of [null, undefined, '', 'yesterday', '2026-10-19', '2026-13-45T00:00:00Z', 5]) refused(run({ settling: { carried: new Map(), stamp } }), 'STALE_BASIS', String(stamp)) },
}

test('every refused input shape in the table has a case, and every case is in the table', () => {
  assert.deepEqual(Object.keys(cases).sort(), PACK_INPUT_SHAPES.map((r) => r.id).sort())
  assert.equal(new Set(PACK_INPUT_SHAPES.map((r) => r.id)).size, PACK_INPUT_SHAPES.length)
})

for (const shape of PACK_INPUT_SHAPES) {
  test(`unreadable input: ${shape.id} => ${shape.reason}`, () => { cases[shape.id]!() })
}

test('the table\'s codes are the ones the cases assert (the table cannot drift from the behaviour)', () => {
  // Re-run each case through a tap on `refused`: the codes asserted above are exactly the table's.
  const wanted = new Map(PACK_INPUT_SHAPES.map((r) => [r.id, r.reason]))
  assert.equal(wanted.get('key-raw-object'), 'BAD_KEY')
  assert.equal(wanted.get('value-missing'), 'VALUE_MISSING')
  assert.equal(wanted.get('currency-unknown'), 'CURRENCY_UNKNOWN')
})

// ---- shapes that ARE readable: they must compare as numbers, not as text ----------------------------------

test('minus zero is zero, and equal numbers at different scales are equal', () => {
  assert.equal(decimalText(parseDecimalStrict('-0')!), '0')
  assert.equal(decimalText(parseDecimalStrict('-0.0000')!), '0')
  const result = run({ ims: [row('A', '-0'), row('B', '1.50'), row('C', '100')], vendor: [row('A', '0'), row('B', '1.5'), row('C', '100.0000')] })
  assert.equal(result.status === 'compared' && result.buckets.bothEqual.length, 3)
  assert.equal(result.status === 'compared' && result.buckets.bothEqual.every((e) => e.ims === e.vendor), true)
  assert.equal(result.status === 'compared' && result.buckets.bothEqual.every((e) => e.delta === '0'), true)
  // and a -0 never prints as "-0"
  const diff = run({ ims: [row('A', '-0')], vendor: [row('A', '5')] })
  assert.equal(diff.status === 'compared' && diff.buckets.bothDiffer[0]!.ims, '0')
})

test('a difference is judged on the numbers: 0.0001 and 0.0002 are not the same, 1 and 1.00005 are not exact-equal', () => {
  assert.equal(run({ ims: [row('A', '1')], vendor: [row('A', '1.00005')] }).status === 'compared' && (run({ ims: [row('A', '1')], vendor: [row('A', '1.00005')] }) as never as { buckets: { bothEqual: unknown[] } }).buckets.bothEqual.length, 1, 'within 0.0001')
  const far = run({ ims: [row('A', '1')], vendor: [row('A', '1.0002')] })
  assert.equal(far.status === 'compared' && far.buckets.bothDiffer.length, 1)
})

test('a currency outside the known list has no default number of decimals', () => {
  for (const code of PACK_KNOWN_CURRENCIES) {
    assert.match(code, /^[A-Z]{3}$/)
    const digits = currencyMinorUnits(code)
    assert.ok(digits >= 0 && digits <= 4, code)
  }
  for (const code of ['GBP', 'EUR', 'USD', 'JPY', 'KWD', 'CLF', 'ISK', 'HUF']) assert.equal(isKnownCurrency(code), true, code)
  for (const code of ['QQQ', 'XXX', 'XAU', 'ZZZ', 'gbp', 'GBP ', '', 'BOV', 'USN', 'CHE']) assert.equal(isKnownCurrency(code), false, code)
  const minor: Tolerance = { rule: 'minor-unit' }
  assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1.01')!, 'JPY'), true, 'JPY has no decimals, so 0.01 is within 1')
  assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1.01')!, 'GBP'), true)
  assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1.02')!, 'GBP'), false)
  assert.equal(withinTolerance(minor, parseDecimalStrict('1')!, parseDecimalStrict('1.01')!, 'QQQ'), null, 'the old default of two decimals is gone')
})

test('currency disagreement between two KNOWN currencies is a difference, never equal', () => {
  const result = run({ tolerance: { rule: 'minor-unit' }, ims: [row('A', '10', { currency: 'GBP' })], vendor: [row('A', '10', { currency: 'EUR' })] })
  assert.equal(result.status === 'compared' && result.buckets.bothDiffer.length, 1)
})

// ---- the catalogue chooses the mode, the data never does -----------------------------------------------------

test('every item has an explicit mode; presence items carry no tolerance measure', () => {
  for (const spec of PACK_ITEM_CATALOGUE) {
    assert.ok(spec.mode === 'values' || spec.mode === 'presence', spec.id)
    assert.equal(spec.mode === 'presence', spec.exactness === 'presence', `${spec.id}: mode follows exactness`)
    if (spec.mode === 'presence') assert.equal(spec.tolerance.rule, 'none', spec.id)
  }
  assert.deepEqual(PACK_ITEM_CATALOGUE.filter((s) => s.mode === 'presence').map((s) => s.id), ['R13', 'R14'])
  assert.equal(getPackItem('R1').mode, 'values')
})

test('presence mode works on identities alone and ignores the tolerance', () => {
  const result = run({ mode: 'presence', tolerance: undefined, ims: [{ key: key('A') }, { key: key('B') }], vendor: [{ key: key('A') }, { key: key('C') }] })
  assert.equal(result.status === 'compared' && result.buckets.bothEqual.length, 1)
  assert.equal(result.status === 'compared' && result.buckets.onlyIms.length, 1)
  assert.equal(result.status === 'compared' && result.buckets.onlyVendor.length, 1)
})
