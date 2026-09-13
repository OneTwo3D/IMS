import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { ExactFigure, ExactRatio, roundExact } from '@/lib/domain/math/exact-figure'

/**
 * o3d-rv4a r5 (Codex round 5 HIGH): "rounded exactly once, from full precision" AS A PROPERTY.
 *
 * Every assertion compares the figure's one rounding with an ORACLE written here from plain bigint
 * arithmetic on the exact fraction — never with the implementation's own rounder — and each fixture is
 * chosen so that rounding twice (to six decimals first, or through a 20-significant-digit Decimal
 * division) gives a DIFFERENT answer, which the test asserts as a precondition. A property test whose
 * cases could not tell once from twice would pass for the defect it is named after.
 */

const ZERO = BigInt(0)
const ONE = BigInt(1)
type Mode = 'ceil' | 'floor' | 'halfUp'

function oracleRound(numerator: bigint, denominator: bigint, places: number, mode: Mode): string {
  let n = numerator
  let d = denominator
  if (d < ZERO) { n = -n; d = -d }
  const scaled = n * BigInt(10) ** BigInt(places)
  let q = scaled / d
  if (scaled % d !== ZERO && scaled < ZERO) q -= ONE
  const r = scaled - q * d
  if (mode === 'ceil' && r !== ZERO) q += ONE
  if (mode === 'halfUp' && (r * BigInt(2) > d || (r * BigInt(2) === d && n > ZERO))) q += ONE
  const negative = q < ZERO
  const digits = (negative ? -q : q).toString().padStart(places + 1, '0')
  const body = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

const DECIMAL_MODE: Record<Mode, Prisma.Decimal.Rounding> = {
  ceil: Prisma.Decimal.ROUND_CEIL,
  floor: Prisma.Decimal.ROUND_FLOOR,
  halfUp: Prisma.Decimal.ROUND_HALF_UP,
}

/** The shape round 4 had: a 20-digit Decimal value, rounded to six decimals, then to `places`. */
function twiceRounded(decimal: Prisma.Decimal, places: number, mode: Mode): string {
  const six = decimal.toDecimalPlaces(6, mode === 'halfUp' ? Prisma.Decimal.ROUND_HALF_UP : DECIMAL_MODE[mode])
  const out = six.toDecimalPlaces(places, DECIMAL_MODE[mode])
  return (out.isZero() ? out.abs() : out).toFixed(places)
}

type Case = {
  name: string
  build: () => ExactFigure
  /** The exact value as a fraction, worked out by hand in the comment beside it. */
  exact: [bigint, bigint]
  /** The exact value written out as a decimal, where it terminates. */
  exactText: string
  /** The same figure computed the old way: Prisma.Decimal arithmetic at 20 significant digits. */
  decimal: () => Prisma.Decimal
  places: number
  mode: Mode
}

const D = (value: string | number) => new Prisma.Decimal(value)

const cases: Case[] = [
  {
    // The reviewer's: 1.005 x 2.499999 / 2.5 = 1.004999598. Nearest at 2 dp once: 1.00; twice: 1.01.
    name: 'exact, 2 dp (£), the reviewer’s 1.0050 line',
    build: () => ExactFigure.share('1.005', '2.499999', '2.5'),
    exact: [BigInt(1004999598), BigInt(1000000000)],
    exactText: '1.004999598',
    decimal: () => D('1.005').mul('2.499999').div('2.5'),
    places: 2,
    mode: 'halfUp',
  },
  {
    // 100.5 x 249.999999 / 250 = 100.499999598. Nearest at 0 dp once: 100; twice: 101.
    name: 'exact, 0 dp (¥)',
    build: () => ExactFigure.share('100.5', '249.999999', '250'),
    exact: [BigInt(100499999598), BigInt(1000000000)],
    exactText: '100.499999598',
    decimal: () => D('100.5').mul('249.999999').div('250'),
    places: 0,
    mode: 'halfUp',
  },
  {
    // 2/3 + 2/3 + 2/3 = 2 exactly. Decimal: 0.66666666666666666667 x 3 = 2.0000000000000000001, whose
    // ceiling at 2 dp is 2.01; the ceiling of 2 is 2.00.
    name: '≤ (ceil), 2 dp, thirds of 2',
    build: () => ExactFigure.share('2', '1', '3').add(ExactFigure.share('2', '1', '3')).add(ExactFigure.share('2', '1', '3')),
    exact: [BigInt(2), ONE],
    exactText: '2',
    decimal: () => D(2).mul(1).div(3).add(D(2).mul(1).div(3)).add(D(2).mul(1).div(3)),
    places: 2,
    mode: 'ceil',
  },
  {
    // Same, at 0 dp: the ceiling of 2.0000000000000000001 is 3; of 2, 2.
    name: '≤ (ceil), 0 dp, thirds of 2',
    build: () => ExactFigure.share('2', '1', '3').add(ExactFigure.share('2', '1', '3')).add(ExactFigure.share('2', '1', '3')),
    exact: [BigInt(2), ONE],
    exactText: '2',
    decimal: () => D(2).mul(1).div(3).add(D(2).mul(1).div(3)).add(D(2).mul(1).div(3)),
    places: 0,
    mode: 'ceil',
  },
  {
    // 1/3 + 1/3 + 1/3 = 1 exactly. Decimal: 0.33333333333333333333 x 3 = 0.99999999999999999999, whose
    // floor at 2 dp is 0.99; the floor of 1 is 1.00. This is the `≥` direction, which this report's
    // producer cannot mint today (its linear and ratio classifiers never return `lower`), so it is
    // exercised here rather than through the page.
    name: '≥ (floor), 2 dp, thirds of 1',
    build: () => ExactFigure.share('1', '1', '3').add(ExactFigure.share('1', '1', '3')).add(ExactFigure.share('1', '1', '3')),
    exact: [ONE, ONE],
    exactText: '1',
    decimal: () => D(1).mul(1).div(3).add(D(1).mul(1).div(3)).add(D(1).mul(1).div(3)),
    places: 2,
    mode: 'floor',
  },
  {
    // Same, at 0 dp: floor(0.99999999999999999999) = 0; floor(1) = 1.
    name: '≥ (floor), 0 dp, thirds of 1',
    build: () => ExactFigure.share('1', '1', '3').add(ExactFigure.share('1', '1', '3')).add(ExactFigure.share('1', '1', '3')),
    exact: [ONE, ONE],
    exactText: '1',
    decimal: () => D(1).mul(1).div(3).add(D(1).mul(1).div(3)).add(D(1).mul(1).div(3)),
    places: 0,
    mode: 'floor',
  },
  {
    // A negative ceiling: -(1/3 x 3) = -1. Decimal: -0.99999999999999999999 whose ceiling at 2 dp is
    // -0.99; the ceiling of -1 is -1.00.
    name: '≤ (ceil), 2 dp, a negative figure',
    build: () => ExactFigure.zero().sub(ExactFigure.share('1', '1', '3').add(ExactFigure.share('1', '1', '3')).add(ExactFigure.share('1', '1', '3'))),
    exact: [-ONE, ONE],
    exactText: '-1',
    decimal: () => D(0).sub(D(1).mul(1).div(3).add(D(1).mul(1).div(3)).add(D(1).mul(1).div(3))),
    places: 2,
    mode: 'ceil',
  },
]

test('every case: the one rounding equals the oracle, and rounding twice would not have (Codex r5 HIGH)', () => {
  let discriminating = 0
  for (const c of cases) {
    const want = oracleRound(c.exact[0], c.exact[1], c.places, c.mode)
    const twice = twiceRounded(c.decimal(), c.places, c.mode)
    assert.notEqual(twice, want, `${c.name}: the fixture does not tell once from twice (both ${want})`)
    discriminating += 1
    assert.equal(c.build().roundTo(c.places, c.mode), want, c.name)
    assert.equal(c.build().exactString(), c.exactText, `${c.name}: exact value`)
  }
  assert.equal(discriminating, cases.length)
  assert.ok(cases.some((c) => c.mode === 'halfUp') && cases.some((c) => c.mode === 'ceil') && cases.some((c) => c.mode === 'floor'))
  assert.ok(cases.some((c) => c.places === 0) && cases.some((c) => c.places === 2))
})

test('a grid of shares, every mode, 0/2/3/6 places: the one rounding equals the oracle', () => {
  // Shares value x part / whole over values, parts and wholes chosen to land on and around rounding
  // boundaries, summed in pairs with different denominators so the quotient terms do not merge.
  const values = ['1.005', '-1.005', '100.5', '2', '0.0001', '-37.12345']
  const parts = ['1', '2.499999', '0.333333', '7']
  const wholes = ['3', '2.5', '7', '9.999999']
  let checked = 0
  for (const value of values) {
    for (const part of parts) {
      for (const whole of wholes) {
        for (const other of ['0.5', '-0.000001']) {
          const figure = ExactFigure.share(value, part, whole).add(ExactFigure.share(other, '1', '11'))
          // Exact fraction by hand-rolled bigint: value*part/whole + other/11.
          const frac = (text: string): [bigint, bigint] => {
            const neg = text.startsWith('-')
            const [i, f = ''] = (neg ? text.slice(1) : text).split('.')
            return [BigInt(`${neg ? '-' : ''}${i}${f}`), BigInt(10) ** BigInt(f.length)]
          }
          const [vn, vd] = frac(value)
          const [pn, pd] = frac(part)
          const [wn, wd] = frac(whole)
          const [on, od] = frac(other)
          const n1 = vn * pn * wd
          const d1 = vd * pd * wn
          const n = n1 * od * BigInt(11) + on * d1
          const d = d1 * od * BigInt(11)
          for (const mode of ['ceil', 'floor', 'halfUp'] as const) {
            for (const places of [0, 2, 3, 6]) {
              assert.equal(figure.roundTo(places, mode), oracleRound(n, d, places, mode), `${value}x${part}/${whole} + ${other}/11 @${places} ${mode}`)
              checked += 1
            }
          }
        }
      }
    }
  }
  assert.equal(checked, values.length * parts.length * wholes.length * 2 * 3 * 4)
})

test('an exact tie rounds half-up (away from zero), and a figure with no quotient rounds as stored', () => {
  assert.equal(ExactFigure.of('1.005').roundTo(2, 'halfUp'), '1.01')
  assert.equal(ExactFigure.of('-1.005').roundTo(2, 'halfUp'), '-1.01')
  assert.equal(ExactFigure.of('-0.001').roundTo(2, 'ceil'), '0.00', 'no negative zero')
  // 1/8 = 0.125 exactly, reached through a quotient: both interval ends are 0.125, so the tie is decided exactly.
  assert.equal(ExactFigure.share('1', '1', '8').roundTo(2, 'halfUp'), '0.13')
  assert.equal(roundExact(ExactFigure.share('2', '1', '3'), 2, 'upper'), '0.67')
  assert.equal(roundExact(ExactFigure.share('2', '1', '3'), 2, 'lower'), '0.66')
  assert.equal(roundExact(ExactFigure.of('60'), 2, 'exact', { trailingZeros: false }), '60')
})

test('the margin ratio is rounded once from the exact quotient', () => {
  // margin 2/3 over revenue 1, x 100 = 66.666...%. Ceil 66.67, floor 66.66, nearest 66.67.
  const margin = ExactFigure.share('2', '1', '3')
  const revenue = ExactFigure.of('1')
  const ratio = new ExactRatio(margin, revenue, 100)
  assert.equal(ratio.roundTo(2, 'ceil'), oracleRound(BigInt(200), BigInt(3), 2, 'ceil'))
  assert.equal(ratio.roundTo(2, 'floor'), oracleRound(BigInt(200), BigInt(3), 2, 'floor'))
  assert.equal(ratio.roundTo(2, 'halfUp'), oracleRound(BigInt(200), BigInt(3), 2, 'halfUp'))
  // A negative margin over a split revenue: (1/3 - 1) / (1/3) x 100 = -200% exactly.
  const split = ExactFigure.share('1', '1', '3')
  assert.equal(new ExactRatio(split.sub(ExactFigure.of('1')), split, 100).roundTo(2, 'ceil'), '-200.00')
  assert.throws(() => new ExactRatio(margin, ExactFigure.zero(), 100), /positive denominator/)
})

test('thousands of distinct denominators round quickly, and correctly against a 400-digit oracle', () => {
  // The case that made a plain rational unusable: one group of 3,000 split lines with distinct line
  // quantities, whose common denominator has tens of thousands of digits.
  const count = 3000
  const parts: ExactFigure[] = []
  const High = (Prisma.Decimal as unknown as { clone: (c: object) => typeof Prisma.Decimal }).clone({ precision: 400, rounding: Prisma.Decimal.ROUND_HALF_UP })
  let oracle = new High(0)
  for (let k = 0; k < count; k += 1) {
    const whole = `${k + 1}.${String((k * 7919) % 999983).padStart(6, '0')}`
    parts.push(ExactFigure.share('1234.5678', '1', whole))
    oracle = oracle.add(new High('1234.5678').div(new High(whole)))
  }
  const figure = ExactFigure.sum(parts)
  assert.equal(figure.quotientTerms, count, 'the terms did not merge, so the case is the hard one')
  const started = Date.now()
  const rounded = figure.roundTo(2, 'halfUp')
  const elapsed = Date.now() - started
  assert.equal(rounded, oracle.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2))
  assert.ok(elapsed < 5000, `rounding took ${elapsed} ms`)
})
