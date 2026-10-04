/**
 * Exact decimal handling for the first-load tools. No `number` arithmetic touches a quantity or a cost.
 *
 * The repo's decimal type is `Prisma.Decimal` (decimal.js), wrapped by `lib/domain/math/decimal.ts`. That wrapper uses the
 * library's DEFAULT precision of 20 significant digits, which is too few here: one lot is quantity (up to 14 digits) times a
 * unit cost (up to 19), and a sum of such products would be silently rounded to 20 digits. So this module takes its own
 * clone of the same class with 80 significant digits and the repo's rounding mode (ROUND_HALF_UP, as `roundQuantity`),
 * which holds every product and sum the input limits allow without rounding. Only an explicit `roundTo` ever rounds.
 *
 * Parsing is deliberately narrow and REJECTS rather than guesses: a decimal comma ("1,5"), a thousands separator
 * ("1,000.50"), an exponent ("1e3"), a leading plus, a bare ".5", or any text is refused with a reason.
 */
import { Prisma } from '@/app/generated/prisma/client'

export const D = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP })
export type Dec = InstanceType<typeof D>

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/

export interface DecimalLimits {
  maxIntDigits: number
  maxDp: number
}

export type DecimalParse = { ok: true; value: Dec } | { ok: false; reason: string }

export function parseDecimal(raw: string, label: string, limits: DecimalLimits, opts: { allowNegative?: boolean } = {}): DecimalParse {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: `${label} is empty` }
  const match = PLAIN_DECIMAL.exec(text)
  if (!match) {
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
      return { ok: false, reason: `${label} "${text}" uses a thousands separator; only plain digits with "." as the decimal point are accepted` }
    }
    if (/^-?\d+,\d+$/.test(text)) {
      return { ok: false, reason: `${label} "${text}" uses a decimal comma; only "." is accepted (nothing is guessed: re-export with a decimal point)` }
    }
    return { ok: false, reason: `${label} "${text}" is not a plain decimal number (digits with an optional "." fraction; no exponent, sign prefix or text)` }
  }
  const negative = match[1] === '-'
  const intDigits = match[2].replace(/^0+(?=\d)/, '')
  const fraction = match[3] ?? ''
  if (negative && !opts.allowNegative) return { ok: false, reason: `${label} "${text}" is negative` }
  if (intDigits.length > limits.maxIntDigits) {
    return { ok: false, reason: `${label} "${text}" has more than ${limits.maxIntDigits} integer digits (the target column or the importer's number type cannot hold it exactly)` }
  }
  if (fraction.length > limits.maxDp) {
    return { ok: false, reason: `${label} "${text}" has more than ${limits.maxDp} decimal places (it would be rounded by the importer, so it is refused here)` }
  }
  return { ok: true, value: new D(`${negative ? '-' : ''}${intDigits}${fraction ? `.${fraction}` : ''}`) }
}

/** Plain notation, no exponent, no trailing zeros ("25", "0.5"). */
export function fmt(value: Dec): string {
  return value.toFixed()
}

/** Fixed decimal places ("4.500000"). */
export function fmtFixed(value: Dec, dp: number): string {
  return value.toFixed(dp, Prisma.Decimal.ROUND_HALF_UP)
}

export function roundTo(value: Dec, dp: number): Dec {
  return value.toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP)
}

export function sum(values: Iterable<Dec>): Dec {
  let total = new D(0)
  for (const value of values) total = total.add(value)
  return total
}
