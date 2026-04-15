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
  const pos: SymbolPos = position ?? (FALLBACK_POSTFIX.has(symbol) ? 'POSTFIX' : 'PREFIX')
  if (pos === 'POSTFIX') return `${sign}${abs}${symbol}`
  return `${sign}${symbol}${abs}`
}

export function formatMoneyCode(
  amount: number,
  currencyCode: string,
  options?: {
    locale?: string
    minimumFractionDigits?: number
    maximumFractionDigits?: number
    notation?: 'standard' | 'compact'
  },
): string {
  const formatter = new Intl.NumberFormat(options?.locale ?? 'en-GB', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: options?.minimumFractionDigits,
    maximumFractionDigits: options?.maximumFractionDigits,
    notation: options?.notation,
  })
  return formatter.format(amount)
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
