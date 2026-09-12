import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---------------------------------------------------------------------------
// Currency formatting
// ---------------------------------------------------------------------------
// Symbol position is stored on the Currency model (`symbolPosition`), so
// call sites pass it in alongside the symbol. A small fallback lookup is
// kept here only for the base currency GBP and for one-off "£"/"$"/"€"
// literals that appear outside the currency-aware flows.
export type SymbolPos = 'PREFIX' | 'POSTFIX'

const FALLBACK_POSTFIX = new Set(['€', 'kr', 'zł', 'Kč', 'Ft', 'лв', 'kn'])
const CANONICAL_POSITIONS = new Map<string, SymbolPos>([
  ['£', 'PREFIX'],
  ['$', 'PREFIX'],
  ['C$', 'PREFIX'],
  ['€', 'POSTFIX'],
  ['kr', 'POSTFIX'],
  ['zł', 'POSTFIX'],
  ['Kč', 'POSTFIX'],
  ['Ft', 'POSTFIX'],
  ['лв', 'POSTFIX'],
  ['kn', 'POSTFIX'],
])

/**
 * Format a numeric amount with its currency symbol in the correct position.
 *
 * Pass `position` explicitly whenever it's available on the current Currency
 * row (that's the source of truth). If not provided, we fall back to a small
 * hard-coded hint so literal "£" / "$" / "€" call sites still work.
 *
 * Examples:
 *   formatMoney(23.99, '£', 'PREFIX')   → "£23.99"
 *   formatMoney(23.99, '€', 'POSTFIX')  → "23.99€"
 *   formatMoney(-5,    '£')             → "-£5.00"
 *   formatMoney(23.99, '€')             → "23.99€"  (fallback)
 */
export function formatMoney(
  amount: number,
  symbol: string,
  position?: SymbolPos,
  digits: number = 2,
): string {
  const abs = Math.abs(amount).toFixed(digits)
  const sign = amount < 0 ? '-' : ''
  const pos: SymbolPos = CANONICAL_POSITIONS.get(symbol) ?? position ?? (FALLBACK_POSTFIX.has(symbol) ? 'POSTFIX' : 'PREFIX')
  if (pos === 'POSTFIX') return `${sign}${abs}${symbol}`
  return `${sign}${symbol}${abs}`
}

type MoneyCodeOptions = {
  locale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  notation?: 'standard' | 'compact'
}

export function formatMoneyCode(
  amount: number,
  currencyCode: string,
  options?: MoneyCodeOptions,
): string {
  return formatMoneyCodeOfValue(amount, currencyCode, options)
}

/**
 * `formatMoneyCode` FOR A FIGURE THAT MUST NOT PASS THROUGH FLOAT64 (o3d-rv4a r3, Codex round 3 HIGH).
 *
 * `Intl.NumberFormat#format` accepts a DECIMAL STRING and reads it as an exact mathematical value
 * (Intl.NumberFormat v3, ES2023). `Number(...)` on the same text first snaps it to the nearest double,
 * and NEAREST is the one direction a bounded figure cannot survive: `Number('90071992547409.990000')`
 * is 90071992547409.984375, so a COGS row whose true completed-basis revenue is 90071992547409.989917
 * printed a ceiling of 90071992547409.98 — below the truth it claimed to be at or above. The defect is
 * invisible below 2^53 and unavoidable above it, because there the gap between representable doubles
 * (0.015625 at 9e13) is wider than the penny being rounded to.
 *
 * THE VALUE MUST ARRIVE ALREADY ROUNDED TO THE TWO DECIMALS THIS PRINTS, IN THE DIRECTION ITS RELATION
 * ALLOWS. `boundedFigureString(value, bound, 2)` is what does that. `Intl` rounds anything longer to
 * nearest itself, so handing it an unrounded string moves the defect one step later rather than fixing
 * it; handing it a correctly directed one leaves it nothing to round.
 */
export function formatMoneyCodeExact(
  amount: string,
  currencyCode: string,
  options?: { locale?: string },
): string {
  return formatMoneyCodeOfValue(amount, currencyCode, options)
}

function formatMoneyCodeOfValue(
  amount: number | string,
  currencyCode: string,
  options?: MoneyCodeOptions,
): string {
  const formatter = new Intl.NumberFormat(options?.locale ?? 'en-GB', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: options?.minimumFractionDigits,
    maximumFractionDigits: options?.maximumFractionDigits,
    notation: options?.notation,
  })
  // The cast is TypeScript's and not the runtime's: `StringNumericLiteral` is a template-literal type
  // that no value merely typed `string` can satisfy, while the runtime reads any numeric string
  // exactly. Kept to this one site so no caller has to write it.
  return formatter.format(typeof amount === 'string' ? (amount as `${number}`) : amount)
}

export function formatCompactMoneyCode(
  amount: number,
  currencyCode: string,
  options?: {
    locale?: string
    maximumFractionDigits?: number
  },
): string {
  return formatMoneyCode(amount, currencyCode, {
    locale: options?.locale,
    notation: 'compact',
    maximumFractionDigits: options?.maximumFractionDigits ?? 1,
  })
}

export function formatCompactMoney(
  amount: number,
  symbol: string,
  position?: SymbolPos,
  maximumFractionDigits: number = 1,
): string {
  const abs = Math.abs(amount)
  let value = abs
  let suffix = ''
  if (abs >= 1_000_000) {
    value = abs / 1_000_000
    suffix = 'M'
  } else if (abs >= 1_000) {
    value = abs / 1_000
    suffix = 'K'
  }
  const digits = suffix ? maximumFractionDigits : 2
  const formatted = formatMoney(value, symbol, position, digits)
  const sign = amount < 0 ? '-' : ''
  const unsigned = formatted.startsWith('-') ? formatted.slice(1) : formatted
  return `${sign}${unsigned}${suffix}`
}
