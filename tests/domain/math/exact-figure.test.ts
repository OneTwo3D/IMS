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

const DECIMAL_MODE = {
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
  // THE DIRECTED CASES, REWORKED ON RESUME (o3d-rv4a r5). The parked draft used thirds of 2 and of 1 and
  // claimed Prisma.Decimal would sum 2/3 + 2/3 + 2/3 to 2.0000000000000000001. It does not: that sum needs
  // 21 significant digits and Decimal rounds it straight back to 2, so those cases could not tell once
  // from twice — and the page test built on the same fixture PASSED on the unfixed head. For a directed
  // rounding, rounding to six decimals first changes nothing (ceil6 then ceil2 is ceil2), so the only way
  // a ceiling or floor goes wrong is Decimal's own 20-significant-digit arithmetic ABSORBING a small part
  // of the figure. These cases are built so that it does: a fourteen-digit amount (schema-valid for a
  // Decimal(18, 4) money column) plus or minus 0.0001 x 0.000001 / 1 = 0.0000000001, which Decimal's add
  // drops entirely — so the ceiling it prints is BELOW the exact figure, and the floor ABOVE it.
  {
    name: '\u2264 (ceil), 2 dp: a fourteen-digit amount plus a share Decimal absorbs',
    build: () => ExactFigure.of('12345678901234').add(ExactFigure.share('0.0001', '0.000001', '1')),
    exact: [BigInt('123456789012340000000001'), BigInt('10000000000')],
    exactText: '12345678901234.0000000001',
    decimal: () => D('12345678901234').add(D('0.0001').mul('0.000001').div('1')),
    places: 2,
    mode: 'ceil',
  },
  {
    name: '\u2264 (ceil), 0 dp: the same figure in a zero-decimal currency',
    build: () => ExactFigure.of('12345678901234').add(ExactFigure.share('0.0001', '0.000001', '1')),
    exact: [BigInt('123456789012340000000001'), BigInt('10000000000')],
    exactText: '12345678901234.0000000001',
    decimal: () => D('12345678901234').add(D('0.0001').mul('0.000001').div('1')),
    places: 0,
    mode: 'ceil',
  },
  {
    // This report's producer cannot mint `lower` today (netLinearFigureBoundDecimal returns exact, upper
    // or indeterminate), so the `\u2265` direction is exercised here rather than through the page.
    name: '\u2265 (floor), 2 dp: a fourteen-digit amount minus a share Decimal absorbs',
    build: () => ExactFigure.of('12345678901234').sub(ExactFigure.share('0.0001', '0.000001', '1')),
    exact: [BigInt('123456789012339999999999'), BigInt('10000000000')],
    exactText: '12345678901233.9999999999',
    decimal: () => D('12345678901234').sub(D('0.0001').mul('0.000001').div('1')),
    places: 2,
    mode: 'floor',
  },
  {
    name: '\u2265 (floor), 0 dp: the same figure in a zero-decimal currency',
    build: () => ExactFigure.of('12345678901234').sub(ExactFigure.share('0.0001', '0.000001', '1')),
    exact: [BigInt('123456789012339999999999'), BigInt('10000000000')],
    exactText: '12345678901233.9999999999',
    decimal: () => D('12345678901234').sub(D('0.0001').mul('0.000001').div('1')),
    places: 0,
    mode: 'floor',
  },
  {
    // A NEGATIVE ceiling, toward zero: -12345678901234 + 0.0000000001 = -12345678901233.9999999999, whose
    // ceiling at 2 dp is -…233.99; Decimal absorbs the share and prints -…234.00, below the exact figure.
    name: '\u2264 (ceil), 2 dp, a negative figure',
    build: () => ExactFigure.of('-12345678901234').add(ExactFigure.share('0.0001', '0.000001', '1')),
    exact: [BigInt('-123456789012339999999999'), BigInt('10000000000')],
    exactText: '-12345678901233.9999999999',
    decimal: () => D('-12345678901234').add(D('0.0001').mul('0.000001').div('1')),
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

test('the directed-rounding cases the removed boundedFigureString tests pinned, now on roundExact', () => {
  // Carried over when boundedFigureString was deleted (o3d-rv4a r5): a negative ceiling rounds TOWARD
  // zero and a negative floor AWAY from it (ROUND_CEIL / ROUND_FLOOR, never ROUND_UP / ROUND_DOWN), and a
  // ceiling on a tiny negative prints an unsigned zero.
  assert.equal(roundExact(ExactFigure.of('100.0000004'), 6, 'upper'), '100.000001')
  assert.equal(roundExact(ExactFigure.of('100.0000004'), 6, 'lower'), '100.000000')
  assert.equal(roundExact(ExactFigure.of('100.0000004'), 6, 'exact'), '100.000000')
  assert.equal(roundExact(ExactFigure.of('100.0000006'), 6, 'indeterminate'), '100.000001')
  assert.equal(roundExact(ExactFigure.of('-40.0000004'), 6, 'upper'), '-40.000000', 'a negative ceiling rounds TOWARD ZERO')
  assert.equal(roundExact(ExactFigure.of('-40.0000004'), 6, 'lower'), '-40.000001', 'a negative floor rounds AWAY from zero')
  assert.equal(roundExact(ExactFigure.of('60.001'), 2, 'upper', { trailingZeros: false }), '60.01')
  assert.equal(roundExact(ExactFigure.of('60'), 2, 'exact', { trailingZeros: false }), '60')
  assert.equal(roundExact(ExactFigure.of('-0.0000001'), 6, 'upper'), '0.000000')
})

test('a figure EXACTLY on a rounding boundary, reached only through quotients, rounds as the boundary', () => {
  // 1/3 + 2/6 + 3/9 is exactly 1, and twice each is exactly 2 — but the three quotients have DIFFERENT
  // denominators, so they are carried as three terms and no finite-precision evaluation of them lands on
  // the boundary: the interval's lower end is just below it and its upper end just above, at 40, 200
  // and 2,000 digits alike. These can only come out right if the rounder refuses to guess from one end
  // and settles the tie exactly. (Thirds with one denominator would merge into a single 3/3 term and
  // prove nothing about this path.) Every mode, 0 and 2 places.
  const ones = ExactFigure.sum([ExactFigure.share('1', '1', '3'), ExactFigure.share('1', '2', '6'), ExactFigure.share('1', '3', '9')])
  const twos = ExactFigure.sum([ExactFigure.share('2', '1', '3'), ExactFigure.share('2', '2', '6'), ExactFigure.share('2', '3', '9')])
  assert.equal(ones.quotientTerms, 3, 'three distinct denominators, so the fallback path is the one under test')
  const interval = ones.interval(2000)
  assert.ok(interval.lower.lt(1) && interval.upper.gt(1), 'the interval straddles 1 even at 2,000 digits')
  assert.equal(ones.exactString(), '1')
  assert.equal(twos.exactString(), '2')
  for (const places of [0, 2]) {
    for (const mode of ['ceil', 'floor', 'halfUp'] as const) {
      assert.equal(ones.roundTo(places, mode), oracleRound(ONE, ONE, places, mode), `1 via thirds, ${mode} @${places}`)
      assert.equal(twos.roundTo(places, mode), oracleRound(BigInt(2), ONE, places, mode), `2 via thirds, ${mode} @${places}`)
    }
  }
  assert.equal(ones.sign(), 1)
  assert.equal(ones.sub(ExactFigure.of('1')).sign(), 0, 'and the exact difference from 1 is zero, not a sliver')
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
    // A non-zero fraction on every line quantity: k = 0 would otherwise give exactly 1, a share that is
    // the whole and carries no quotient term at all.
    const whole = `${k + 1}.${String(((k * 7919) % 999983) + 1).padStart(6, '0')}`
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
