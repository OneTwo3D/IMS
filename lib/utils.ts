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
 * (0.015625 at 9e13) is wider than the hundredth being rounded to.
 *
 * AND THE PRECISION IS THE CURRENCY'S, PINNED, SO NOTHING HERE ROUNDS AGAIN (o3d-rv4a r4, Codex round 4
 * HIGH). Round 3 rounded every amount to two decimals and then let `Intl` apply the currency's own
 * precision on top: a yen ceiling of 100.004 went to 100.01 and printed `¥100 ≤`, below the figure, and
 * an exact dinar figure of 100.004 printed `KWD 100.000`. So the caller rounds in its bound's direction
 * to `moneyCodeFractionDigits(currency)` — the digits THIS formatter prints for that currency — and
 * this function pins minimum and maximum fraction digits to exactly that and REFUSES a string with
 * more decimals, because pinning alone would let `Intl` round a longer string to nearest in silence.
 */
export function formatMoneyCodeExact(
  amount: string,
  currencyCode: string,
  options: { fractionDigits: number; locale?: string },
): string {
  const { fractionDigits } = options
  const match = /^-?\d+(?:\.(\d+))?$/.exec(amount)
  if (!match) throw new RangeError(`formatMoneyCodeExact needs a plain decimal string, got ${JSON.stringify(amount)}`)
  const decimals = match[1]?.length ?? 0
  if (decimals > fractionDigits) {
    throw new RangeError(
      `formatMoneyCodeExact would have to round ${amount} to ${fractionDigits} decimals for ${currencyCode}; round it in the figure's own direction first`,
    )
  }
  return formatMoneyCodeOfValue(amount, currencyCode, {
    locale: options.locale,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

/**
 * THE FRACTION DIGITS `formatMoneyCodeExact` PRINTS FOR A CURRENCY — read off the formatter itself.
 *
 * Deliberately NOT `currencyMinorUnits` (lib/domain/math/decimal.ts). That is the ISO 4217 table, and
 * ICU's currency data disagrees with it on seventeen currencies: HUF, IDR, COP, PKR and others are two
 * decimals in ISO and printed with none. A bound rounded to the ISO digits and printed at ICU's would be
 * rounded twice, which is round 4's defect again. The only precision a second rounding cannot undo is
 * the one the formatter will print.
 */
export function moneyCodeFractionDigits(currencyCode: string, options?: { locale?: string }): number {
  return new Intl.NumberFormat(options?.locale ?? 'en-GB', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
  }).resolvedOptions().maximumFractionDigits ?? 2
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
