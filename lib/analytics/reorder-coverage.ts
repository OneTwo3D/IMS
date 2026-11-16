/**
 * Coverage-weeks <-> order-quantity round-trip for the Reorder Planning screen (per row, not
 * persisted). Pure, DB-free and client-safe: it deliberately avoids Prisma.Decimal so the browser
 * bundle stays free of the Prisma runtime, and avoids floats so the arithmetic is exact. Inputs
 * and outputs are decimal strings; the maths is exact rational arithmetic on BigInt.
 *
 *   weeks of cover = quantity / (7 x averageDailyDemand)      (shown to 1 decimal place, half up)
 *   quantity       = ceil(weeks x 7 x averageDailyDemand)     (whole units: you cannot order a fraction)
 *
 * "Cover" is weeks of the row's OWN average daily demand that the ordered quantity alone supplies.
 * Demand of 0 has no meaningful cover: weeks is null (shown as an em dash) and weeks cannot be
 * edited, because no number of weeks maps to a quantity.
 */

export const COVERAGE_WEEKS_DECIMALS = 1
// BigInt() calls, not 7n literals: the tsconfig target predates ES2020 bigint literals.
const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)
const TEN = BigInt(10)
const DAYS_PER_WEEK = BigInt(7)
const MAX_DIGITS = 15

type Rational = { num: bigint; den: bigint }

/** Parse a non-negative plain decimal string ("12", "0.5", ".5", "3.") into an exact rational. */
function parseNonNegative(value: string | null | undefined): Rational | null {
  const text = (value ?? '').trim()
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match) return null
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  if (whole === '' && fraction === '') return null
  if (whole.length + fraction.length > MAX_DIGITS + 4) return null
  return { num: BigInt(`${whole}${fraction}` || '0'), den: pow10(fraction.length) }
}

function pow10(exponent: number): bigint {
  let result = ONE
  for (let i = 0; i < exponent; i += 1) result *= TEN
  return result
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - ONE) / b
}

/** True when demand is a usable positive rate. */
export function hasCoverageDemand(averageDailyDemand: string | null | undefined): boolean {
  const demand = parseNonNegative(averageDailyDemand)
  return demand != null && demand.num > ZERO
}

/** Weeks of cover a quantity gives, or null when demand is 0/invalid or the quantity is invalid. */
export function coverageWeeksForQty(qty: string, averageDailyDemand: string): string | null {
  const q = parseNonNegative(qty)
  const demand = parseNonNegative(averageDailyDemand)
  if (!q || !demand || demand.num <= ZERO) return null
  // weeks = (q.num/q.den) / (7 x d.num/d.den) = q.num x d.den / (7 x d.num x q.den), rounded half up
  // to COVERAGE_WEEKS_DECIMALS places.
  const scale = pow10(COVERAGE_WEEKS_DECIMALS)
  const numerator = q.num * demand.den * scale * TWO + DAYS_PER_WEEK * demand.num * q.den
  const denominator = DAYS_PER_WEEK * demand.num * q.den * TWO
  const scaled = numerator / denominator
  const whole = scaled / scale
  const frac = (scaled % scale).toString().padStart(COVERAGE_WEEKS_DECIMALS, '0')
  return `${whole}.${frac}`
}

/** Whole-unit quantity that covers the given weeks, or null when demand is 0/invalid or weeks is invalid. */
export function qtyForCoverageWeeks(weeks: string, averageDailyDemand: string): string | null {
  const w = parseNonNegative(weeks)
  const demand = parseNonNegative(averageDailyDemand)
  if (!w || !demand || demand.num <= ZERO) return null
  return ceilDiv(w.num * DAYS_PER_WEEK * demand.num, w.den * demand.den).toString()
}

export type CoverageValues = { qty: string; weeks: string | null }

/** The system suggestion expressed as both values (what each row's reset restores). */
export function systemCoverageValues(suggestedQty: string, averageDailyDemand: string): CoverageValues {
  return { qty: suggestedQty, weeks: coverageWeeksForQty(suggestedQty, averageDailyDemand) }
}

/** Editing the quantity: weeks follow. An unparsable quantity leaves weeks null. */
export function coverageValuesFromQty(qty: string, averageDailyDemand: string): CoverageValues {
  return { qty, weeks: coverageWeeksForQty(qty, averageDailyDemand) }
}

/**
 * Editing the weeks: quantity follows. Returns null when the edit cannot be applied (demand 0 or
 * unparsable weeks) so the caller keeps the previous values. The weeks the operator typed are kept
 * verbatim rather than re-derived from the rounded-up quantity.
 */
export function coverageValuesFromWeeks(weeks: string, averageDailyDemand: string): CoverageValues | null {
  const qty = qtyForCoverageWeeks(weeks, averageDailyDemand)
  return qty == null ? null : { qty, weeks }
}
