/**
 * Exact decimal-string arithmetic for figures that must not pass through float64 (o3d-0868).
 *
 * KEEP THIS FILE IMPORT-FREE. The Product Profitability page re-sums an arbitrary filtered subset of rows IN THE
 * BROWSER and has to round a bounded figure once, in its bound's direction; importing Prisma's Decimal here would
 * pull it into the client chunk (the o3d-iigc r4 build failure), as `derived-figure-bound.ts` documents. BigInt is
 * native, so the whole of it is a scaled integer.
 *
 * A float64 figure is exact to 2^53 units of its last place; above 9e13 the spacing of doubles is wider than the
 * hundredth being rounded to, so a ceiling taken from one can sit BELOW the truth it claims to bound. Nothing here
 * ever builds a Number.
 */

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/

const B0 = BigInt(0)
const B1 = BigInt(1)
const B2 = BigInt(2)
const B10 = BigInt(10)

function pow10(exponent: number): bigint {
  let result = B1
  for (let i = 0; i < exponent; i++) result *= B10
  return result
}

type Scaled = { value: bigint; scale: number }

function parse(text: string): Scaled {
  const match = PLAIN_DECIMAL.exec(text)
  if (!match) throw new RangeError(`not a plain decimal string: ${JSON.stringify(text)}`)
  const fraction = match[3] ?? ''
  const magnitude = BigInt(`${match[2]}${fraction}`)
  return { value: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length }
}

function upscale(figure: Scaled, scale: number): bigint {
  return figure.value * pow10(scale - figure.scale)
}

function format(value: bigint, scale: number): string {
  const negative = value < B0
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = scale > 0 ? digits.slice(digits.length - scale) : ''
  const text = fraction ? `${whole}.${fraction}` : whole
  return negative && /[1-9]/.test(text) ? `-${text}` : text
}

/** The exact sum of decimal strings, as a decimal string (no digits dropped). */
export function sumDecimalStrings(parts: readonly string[]): string {
  const figures = parts.map(parse)
  const scale = figures.reduce((widest, figure) => Math.max(widest, figure.scale), 0)
  const total = format(figures.reduce((sum, figure) => sum + upscale(figure, scale), B0), scale)
  return total.includes('.') ? total.replace(/\.?0+$/, '') : total
}

export type CentsRounding = 'ceil' | 'floor' | 'nearest'

/**
 * Round a decimal string to `places` decimals (cents by default) in the stated direction, exactly. `nearest` breaks
 * ties away from zero. The result always carries exactly `places` decimals.
 */
export function roundDecimalString(text: string, mode: CentsRounding, places = 2): string {
  const figure = parse(text)
  if (figure.scale <= places) return format(upscale(figure, places), places)
  const drop = pow10(figure.scale - places)
  let quotient = figure.value / drop // truncates toward zero
  const remainder = figure.value % drop
  if (remainder !== B0) {
    if (mode === 'ceil' && figure.value > B0) quotient += B1
    else if (mode === 'floor' && figure.value < B0) quotient -= B1
    else if (mode === 'nearest') {
      const twice = (remainder < B0 ? -remainder : remainder) * B2
      if (twice >= drop) quotient += figure.value < B0 ? -B1 : B1
    }
  }
  return format(quotient, places)
}

/** `-1 | 0 | 1`: the sign of a decimal string. */
export function decimalStringSign(text: string): -1 | 0 | 1 {
  const { value } = parse(text)
  return value === B0 ? 0 : value < B0 ? -1 : 1
}
