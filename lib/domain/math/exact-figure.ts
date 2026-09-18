import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'

/**
 * A FIGURE CARRIED AT FULL PRECISION AND ROUNDED EXACTLY ONCE, WHERE IT IS SHOWN (o3d-rv4a r5).
 *
 * WHY THIS EXISTS. Rounds 2, 3, 4 and 5 of o3d-rv4a each found another place where a COGS figure was
 * rounded and then rounded again: to six decimals in the producer and to pennies on the page (Codex r5
 * HIGH: a £1.0050 line shared 2.499999/2.5 is 1.004999598, which the producer published as 1.005000 and
 * the page printed as £1.01 — once-rounded it is £1.00), to nearest by `Number()`, to two decimals and
 * then to the currency's own. The rule that ends that is structural, not a comment: a figure is rounded
 * exactly once, at the point it is displayed or exported, from its exact value. So the producer does not
 * hand out strings at all. It hands out this, and the only ways to get digits out of it are
 * `roundTo` / `roundExact`, which take the precision and the direction at the moment of display.
 *
 * WHY NOT Decimal. Prisma's Decimal works to 20 significant digits: every `div` is itself a rounding,
 * and so is an `add` whose result needs more than twenty digits. A quantity share `revenue × q / Q`
 * rarely terminates, so "carry the Decimal unrounded" is not something Decimal can do.
 *
 * WHY NOT A PLAIN RATIONAL (the design this one replaced). Exactly right, and too slow: a group's
 * revenue is a sum of shares over many lines, each with its own line quantity, and the common
 * denominator of a sum of fractions is the lcm of theirs. A prototype of THAT design — summing everything
 * into one bigint rational — took 8 s for one warehouse group of 1,000 split lines with distinct
 * quantities, and 81 s for 2,000. Those figures describe the rejected design, not this one; this one
 * keeps the terms apart and only falls back to a rational for a near-tie (see below).
 *
 * WHAT IT IS. An exact whole part plus one quotient term per distinct denominator, every number held as
 * an integer scaled by a power of ten, so building and adding figures never rounds anything. Rounding
 * evaluates the figure as an INTERVAL — each quotient computed at `p` significant digits once toward
 * -infinity and once toward +infinity, and summed the same way — so the exact value provably lies
 * between the two ends. The three rounding modes used here (ceil, floor, half-up) are monotone, so if
 * both ends round to the same digits, the exact value rounds to those digits too: that answer is not an
 * approximation, it is the once-rounded exact value, obtained without ever materialising it. Only when
 * the ends disagree — the exact value sits within about 10^-p of a rounding boundary — is precision
 * raised (40, 200, 2000 digits) and, failing that, the figure evaluated as an exact bigint rational.
 * The fallback is slow only for a near-tie over thousands of distinct denominators at once, and it is
 * still correct.
 */

/** An exact decimal: `m / 10^s`, with `s >= 0` and no trailing zero digits in `m` unless `s == 0`. */
type Fixed = { readonly m: bigint; readonly s: number }

const TEN = BigInt(10)
const ZERO = BigInt(0)
const ONE = BigInt(1)

function normalise(m: bigint, s: number): Fixed {
  let mm = m
  let ss = s
  while (ss > 0 && mm % TEN === ZERO) {
    mm /= TEN
    ss -= 1
  }
  return { m: mm, s: ss }
}

function fixedOf(value: DecimalInput): Fixed {
  // `toFixed()` with no argument is Decimal's exact, exponent-free rendering of the stored digits.
  const text = toDecimal(value).toFixed()
  const negative = text.startsWith('-')
  const body = negative ? text.slice(1) : text
  const [intPart, fracPart = ''] = body.split('.')
  const m = BigInt(`${intPart}${fracPart}`)
  return normalise(negative ? -m : m, fracPart.length)
}

function align(a: Fixed, b: Fixed): [bigint, bigint, number] {
  if (a.s === b.s) return [a.m, b.m, a.s]
  if (a.s > b.s) return [a.m, b.m * TEN ** BigInt(a.s - b.s), a.s]
  return [a.m * TEN ** BigInt(b.s - a.s), b.m, b.s]
}

function fixedAdd(a: Fixed, b: Fixed): Fixed {
  const [x, y, s] = align(a, b)
  return normalise(x + y, s)
}

function fixedMul(a: Fixed, b: Fixed): Fixed {
  return normalise(a.m * b.m, a.s + b.s)
}

function fixedNeg(a: Fixed): Fixed {
  return { m: -a.m, s: a.s }
}

function fixedString(a: Fixed): string {
  if (a.s === 0) return a.m.toString()
  const negative = a.m < ZERO
  const digits = (negative ? -a.m : a.m).toString().padStart(a.s + 1, '0')
  const text = `${digits.slice(0, digits.length - a.s)}.${digits.slice(digits.length - a.s)}`
  return negative ? `-${text}` : text
}

const FIXED_ZERO: Fixed = { m: ZERO, s: 0 }

type Term = { readonly num: Fixed; readonly den: Fixed }

/** How a figure is rounded: toward +infinity, toward -infinity, or to nearest with ties away from zero. */
export type ExactRoundingMode = 'ceil' | 'floor' | 'halfUp'

/** The rounding a figure's own relation allows: up under `≤`, down under `≥`, nearest otherwise. */
export function roundingModeForBound(bound: DerivedFigureBound): ExactRoundingMode {
  if (bound === 'upper') return 'ceil'
  if (bound === 'lower') return 'floor'
  return 'halfUp'
}

type AnyDecimalClass = typeof Prisma.Decimal
type DecimalValue = InstanceType<AnyDecimalClass>

const PRECISIONS = [40, 200, 2000] as const
const clones = new Map<string, AnyDecimalClass>()

function decimalClass(precision: number, direction: 'floor' | 'ceil'): AnyDecimalClass {
  const key = `${precision}:${direction}`
  let clone = clones.get(key)
  if (!clone) {
    const base = Prisma.Decimal as AnyDecimalClass & { clone: (config: object) => AnyDecimalClass }
    clone = base.clone({
      precision,
      rounding: direction === 'floor' ? Prisma.Decimal.ROUND_FLOOR : Prisma.Decimal.ROUND_CEIL,
      toExpNeg: -9e15,
      toExpPos: 9e15,
    })
    clones.set(key, clone)
  }
  return clone
}

function decimalRoundingOf(mode: ExactRoundingMode) {
  if (mode === 'ceil') return Prisma.Decimal.ROUND_CEIL
  if (mode === 'floor') return Prisma.Decimal.ROUND_FLOOR
  return Prisma.Decimal.ROUND_HALF_UP
}

function formatPlaces(value: DecimalValue, places: number, trailingZeros: boolean): string {
  // Zero has no sign: a ceiling on a tiny negative leaves -0, which reads as a figure with a sign.
  const unsigned = value.isZero() ? value.abs() : value
  const text = unsigned.toFixed(places)
  return trailingZeros ? text : trimZeros(text)
}

function trimZeros(text: string): string {
  if (!text.includes('.')) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

// ---------------------------------------------------------------------------------------------
// Exact rational fallback
// ---------------------------------------------------------------------------------------------

type Rational = { n: bigint; d: bigint }

function abs(x: bigint): bigint {
  return x < ZERO ? -x : x
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a)
  let y = abs(b)
  while (y !== ZERO) [x, y] = [y, x % y]
  return x === ZERO ? ONE : x
}

function rational(n: bigint, d: bigint): Rational {
  if (d === ZERO) throw new RangeError('ExactFigure: division by zero')
  const sign = d < ZERO ? -ONE : ONE
  const g = gcd(n, d)
  return { n: (sign * n) / g, d: (sign * d) / g }
}

function rationalOfFixed(a: Fixed): Rational {
  return rational(a.m, TEN ** BigInt(a.s))
}

function rationalAdd(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d)
}

function rationalDiv(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d, a.d * b.n)
}

/** Floor division for bigints, which truncate toward zero. */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  return (n % d !== ZERO && (n < ZERO) !== (d < ZERO)) ? q - ONE : q
}

/** A reduced rational as text: a terminating decimal where it terminates, otherwise `n/d`. */
function rationalExactString(value: Rational): string {
  let d = value.d
  let tens = 0
  while (d % TEN === ZERO) { d /= TEN; tens += 1 }
  let twos = 0
  while (d % BigInt(2) === ZERO) { d /= BigInt(2); twos += 1 }
  let fives = 0
  while (d % BigInt(5) === ZERO) { d /= BigInt(5); fives += 1 }
  if (d !== ONE) return `${value.n}/${value.d}`
  const places = tens + Math.max(twos, fives)
  return fixedString(normalise((value.n * TEN ** BigInt(places)) / value.d, places))
}

function roundRational(value: Rational, places: number, mode: ExactRoundingMode, trailingZeros: boolean): string {
  const scaled = value.n * TEN ** BigInt(places)
  const q = floorDiv(scaled, value.d)
  const remainder = scaled - q * value.d // 0 <= remainder < d, since d > 0
  let k = q
  if (mode === 'ceil') {
    if (remainder !== ZERO) k = q + ONE
  } else if (mode === 'halfUp') {
    const twice = remainder * BigInt(2)
    // Ties away from zero: a positive tie rounds up, a negative tie (q is already below it) stays.
    if (twice > value.d || (twice === value.d && value.n > ZERO)) k = q + ONE
  }
  const text = fixedString({ m: k, s: places })
  const normalised = /^-0(\.0*)?$/.test(text) ? text.slice(1) : text
  const shaped = places > 0 && !normalised.includes('.') ? `${normalised}.${'0'.repeat(places)}` : normalised
  return trailingZeros ? shaped : trimZeros(shaped)
}

// ---------------------------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------------------------

export class ExactFigure {
  private constructor(
    private readonly whole: Fixed,
    private readonly terms: ReadonlyMap<string, Term>,
  ) {}

  static zero(): ExactFigure {
    return new ExactFigure(FIXED_ZERO, new Map())
  }

  /** A stored, terminating value, taken digit for digit. */
  static of(value: DecimalInput): ExactFigure {
    return new ExactFigure(fixedOf(value), new Map())
  }

  /**
   * `value × part / whole`, kept as a quotient — the quantity share. `part` must be non-negative and
   * `whole` positive, which is what a share of a quantity is; anything else is refused rather than
   * carried, for the same reason `scaleCredits` refuses it.
   */
  static share(value: DecimalInput, part: DecimalInput, whole: DecimalInput): ExactFigure {
    return ExactFigure.of(value).mulDiv(ExactFigure.of(part), ExactFigure.of(whole))
  }

  /** Sums many figures in one pass — linear in their terms, where repeated `add` would be quadratic. */
  static sum(parts: Iterable<ExactFigure>): ExactFigure {
    let whole = FIXED_ZERO
    const terms = new Map<string, Term>()
    for (const part of parts) {
      whole = fixedAdd(whole, part.whole)
      for (const [key, term] of part.terms) {
        const existing = terms.get(key)
        const num = existing ? fixedAdd(existing.num, term.num) : term.num
        if (num.m === ZERO) terms.delete(key)
        else terms.set(key, { num, den: term.den })
      }
    }
    return new ExactFigure(whole, terms)
  }

  /**
   * `this x part / whole`, kept as quotients. `part` and `whole` must be terminating quantities (no
   * quotient terms of their own), `part` non-negative and `whole` positive — a share of a quantity —
   * and anything else is refused rather than carried, as `scaleCredits` refuses it.
   */
  mulDiv(part: ExactFigure, whole: ExactFigure): ExactFigure {
    if (part.terms.size > 0 || whole.terms.size > 0) throw new RangeError('ExactFigure.mulDiv takes terminating quantities')
    const p = part.whole
    const w = whole.whole
    if (p.m < ZERO || w.m <= ZERO) {
      throw new RangeError(`ExactFigure.mulDiv requires a non-negative share, got ${fixedString(p)}/${fixedString(w)}`)
    }
    if (p.m === w.m && p.s === w.s) return this
    const terms = new Map<string, Term>()
    const put = (num: Fixed, den: Fixed) => {
      if (num.m === ZERO) return
      const key = fixedString(den)
      const existing = terms.get(key)
      const merged = existing ? fixedAdd(existing.num, num) : num
      if (merged.m === ZERO) terms.delete(key)
      else terms.set(key, { num: merged, den })
    }
    put(fixedMul(this.whole, p), w)
    for (const term of this.terms.values()) put(fixedMul(term.num, p), fixedMul(term.den, w))
    return new ExactFigure(FIXED_ZERO, terms)
  }

  add(other: ExactFigure): ExactFigure {
    const terms = new Map(this.terms)
    for (const [key, term] of other.terms) {
      const existing = terms.get(key)
      if (!existing) {
        terms.set(key, term)
        continue
      }
      const num = fixedAdd(existing.num, term.num)
      if (num.m === ZERO) terms.delete(key)
      else terms.set(key, { num, den: term.den })
    }
    return new ExactFigure(fixedAdd(this.whole, other.whole), terms)
  }

  negate(): ExactFigure {
    const terms = new Map<string, Term>()
    for (const [key, term] of this.terms) terms.set(key, { num: fixedNeg(term.num), den: term.den })
    return new ExactFigure(fixedNeg(this.whole), terms)
  }

  sub(other: ExactFigure): ExactFigure {
    return this.add(other.negate())
  }

  /** Multiplied by a terminating constant (the percentage's 100), still exactly. */
  scale(factor: DecimalInput): ExactFigure {
    const f = fixedOf(factor)
    const terms = new Map<string, Term>()
    for (const [key, term] of this.terms) {
      const num = fixedMul(term.num, f)
      if (num.m !== ZERO) terms.set(key, { num, den: term.den })
    }
    return new ExactFigure(fixedMul(this.whole, f), terms)
  }

  /** The number of quotient terms still carried — for tests and for the performance guard's evidence. */
  get quotientTerms(): number {
    return this.terms.size
  }

  /** `[lower, upper]` at `precision` significant digits per quotient; the exact value lies inside. */
  interval(precision: number): { lower: DecimalValue; upper: DecimalValue } {
    const Floor = decimalClass(precision, 'floor')
    const Ceil = decimalClass(precision, 'ceil')
    const wholeText = fixedString(this.whole)
    let lower: DecimalValue = new Floor(wholeText)
    let upper: DecimalValue = new Ceil(wholeText)
    for (const term of this.terms.values()) {
      const num = fixedString(term.num)
      const den = fixedString(term.den)
      lower = lower.add(new Floor(num).div(new Floor(den)))
      upper = upper.add(new Ceil(num).div(new Ceil(den)))
    }
    return { lower, upper }
  }

  /** The exact value as a reduced rational. Correct always; slow only for thousands of distinct denominators. */
  toRational(): Rational {
    let total = rationalOfFixed(this.whole)
    for (const term of this.terms.values()) {
      total = rationalAdd(total, rationalDiv(rationalOfFixed(term.num), rationalOfFixed(term.den)))
    }
    return total
  }

  /** The exact value as text: a terminating decimal where it terminates, otherwise `n/d`. For tests and diagnostics. */
  exactString(): string {
    return rationalExactString(this.toRational())
  }

  sign(): -1 | 0 | 1 {
    for (const precision of PRECISIONS) {
      const { lower, upper } = this.interval(precision)
      if (lower.gt(0)) return 1
      if (upper.lt(0)) return -1
      if (lower.isZero() && upper.isZero()) return 0
    }
    const exact = this.toRational()
    return exact.n > ZERO ? 1 : exact.n < ZERO ? -1 : 0
  }

  /** The one rounding: exactly `places` decimals, in `mode`, of the exact value. */
  roundTo(places: number, mode: ExactRoundingMode, trailingZeros = true): string {
    const rounding = decimalRoundingOf(mode)
    for (const precision of PRECISIONS) {
      const { lower, upper } = this.interval(precision)
      const low = lower.toDecimalPlaces(places, rounding)
      const high = upper.toDecimalPlaces(places, rounding)
      if (low.eq(high)) return formatPlaces(low, places, trailingZeros)
    }
    return roundRational(this.toRational(), places, mode, trailingZeros)
  }
}

/**
 * `numerator × scale / denominator` for a positive denominator — the margin percentage — rounded once
 * from the exact quotient by the same interval argument: over a positive denominator interval the
 * quotient's extremes are taken at the interval's ends, so its bounds are computed directly.
 */
export class ExactRatio {
  private readonly numerator: ExactFigure
  constructor(
    numerator: ExactFigure,
    private readonly denominator: ExactFigure,
    scale: DecimalInput = 1,
  ) {
    if (denominator.sign() !== 1) throw new RangeError('ExactRatio requires a positive denominator')
    this.numerator = numerator.scale(scale)
  }

  roundTo(places: number, mode: ExactRoundingMode, trailingZeros = true): string {
    const rounding = decimalRoundingOf(mode)
    for (const precision of PRECISIONS) {
      const num = this.numerator.interval(precision)
      const den = this.denominator.interval(precision)
      if (!den.lower.gt(0)) continue
      const Floor = decimalClass(precision, 'floor')
      const Ceil = decimalClass(precision, 'ceil')
      const lowNum = new Floor(num.lower)
      const highNum = new Ceil(num.upper)
      const lower = lowNum.gte(0) ? lowNum.div(new Floor(den.upper)) : lowNum.div(new Floor(den.lower))
      const upper = highNum.gte(0) ? highNum.div(new Ceil(den.lower)) : highNum.div(new Ceil(den.upper))
      const low = lower.toDecimalPlaces(places, rounding)
      const high = upper.toDecimalPlaces(places, rounding)
      if (low.eq(high)) return formatPlaces(low, places, trailingZeros)
    }
    return roundRational(rationalDiv(this.numerator.toRational(), this.denominator.toRational()), places, mode, trailingZeros)
  }

  exactString(): string {
    return rationalExactString(rationalDiv(this.numerator.toRational(), this.denominator.toRational()))
  }
}

export type ExactRoundable = ExactFigure | ExactRatio

/** THE ONE PLACE A COGS FIGURE BECOMES DIGITS: `places` decimals, in the direction `bound` allows. */
export function roundExact(
  value: ExactRoundable,
  places: number,
  bound: DerivedFigureBound,
  options: { trailingZeros?: boolean } = {},
): string {
  return value.roundTo(places, roundingModeForBound(bound), options.trailingZeros ?? true)
}
