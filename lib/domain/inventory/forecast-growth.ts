import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Growth factor on the Reorder Planning forecast (V1): ONE percentage that scales the calculated daily
 * sales rate by 1 + growth/100 before forecast quantity, projected stock, timing and the suggested
 * quantities are derived. 20 means every derived output runs about 20% higher; negative values are a
 * planned decline. Applied globally to one run and entered each time, never stored. Default 0 = no change.
 */
export const MIN_GROWTH_PERCENT = -90
export const MAX_GROWTH_PERCENT = 500

export type GrowthResolution = {
  /** The percentage actually applied (0 when none, unparseable, or the input was cleared). */
  percent: number
  /** 1 + percent / 100 as a Decimal; exactly 1 when percent is 0. */
  factor: Decimal
  /** Set when the input was out of range (clamped) or not a number (ignored). Null otherwise. */
  notice: string | null
}

/**
 * Server-side validation of a growth percentage from any untrusted source (URL, export request, server
 * action argument). A missing/empty value is 0. A non-numeric value is ignored (0) and said so. A value
 * outside MIN..MAX is clamped to the bound and said so. Rounded to two decimals.
 */
export function resolveGrowthPercent(raw: unknown): GrowthResolution {
  const none: GrowthResolution = { percent: 0, factor: toDecimal(1), notice: null }
  if (raw == null || raw === '') return none
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(n)) {
    return { ...none, notice: 'The growth percentage was not a number, so it was ignored and demand is unchanged.' }
  }
  const rounded = Math.round(n * 100) / 100
  const percent = Math.min(MAX_GROWTH_PERCENT, Math.max(MIN_GROWTH_PERCENT, rounded))
  const clamped = percent !== rounded
  if (percent === 0) return { ...none, notice: null }
  return {
    percent,
    factor: toDecimal(percent).div(100).add(1),
    notice: clamped
      ? `The growth percentage must be between ${MIN_GROWTH_PERCENT}% and +${MAX_GROWTH_PERCENT}%, so ${rounded}% was limited to ${percent}%.`
      : null,
  }
}

/** Scale a daily rate by the growth factor. Identity (same object) when growth is 0. */
export function applyGrowth(rate: Decimal, growth: GrowthResolution): Decimal {
  return growth.percent === 0 ? rate : rate.mul(growth.factor)
}

/** "+50%" / "-20%" for notices and labels. */
export function formatGrowthPercent(percent: number): string {
  return `${percent > 0 ? '+' : ''}${percent}%`
}

/**
 * Query value for carrying a validated growth through a URL or action filters: the number, or undefined
 * when it is 0, so an untouched run produces the same query/evidence it always did.
 */
export function growthForCarry(raw: unknown): number | undefined {
  const { percent } = resolveGrowthPercent(raw)
  return percent === 0 ? undefined : percent
}
