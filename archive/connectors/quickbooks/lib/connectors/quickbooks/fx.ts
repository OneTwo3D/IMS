/**
 * FX rate translation between IMS's `fxRateToBase` convention and QBO's
 * `ExchangeRate` field.
 *
 * - IMS stores `fxRateToBase` as: 1 base = X document-currency.
 * - QuickBooks `ExchangeRate` (per Intuit API docs) is "the number of home
 *   currency units it takes to equal one unit of currency specified by
 *   `CurrencyRef`", i.e. 1 document-currency = X base.
 *
 * So `qboExchangeRate = 1 / fxRateToBase` — the same inversion as the Xero
 * adapter. Round to 6 decimals to match QBO's documented precision.
 *
 * Stamping `ExchangeRate` on every QBO Invoice / Bill / CreditMemo prevents
 * QuickBooks from substituting its own daily rate, keeping IMS and QBO
 * numerically aligned per document.
 */

const QBO_RATE_DECIMALS = 6

export function imsRateToQboExchangeRate(rateToBase: number | undefined | null): number | undefined {
  if (rateToBase == null) return undefined
  const n = Number(rateToBase)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const inverted = 1 / n
  const factor = 10 ** QBO_RATE_DECIMALS
  return Math.round(inverted * factor) / factor
}
