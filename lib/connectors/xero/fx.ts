/**
 * FX rate translation between IMS's `fxRateToBase` convention and Xero's
 * `CurrencyRate` convention.
 *
 * - IMS stores `fxRateToBase` as: 1 base = X document-currency.
 * - Xero `CurrencyRate` is defined as: 1 document-currency = X base.
 *
 * So `xeroCurrencyRate = 1 / fxRateToBase`.
 *
 * Stamping `CurrencyRate` on every Xero invoice/bill/credit note prevents Xero
 * from substituting its own daily XE rate — keeping IMS and Xero numerically
 * aligned per document.
 */

const XERO_RATE_DECIMALS = 8

/**
 * Translate IMS's `fxRateToBase` (1 base = X doc-ccy) into Xero's
 * `CurrencyRate` (1 doc-ccy = X base). Returns `undefined` for non-positive,
 * non-finite, or missing inputs so the caller can omit the field cleanly and
 * let Xero default — rather than posting an invalid rate.
 */
export function imsRateToXeroCurrencyRate(rateToBase: number | undefined | null): number | undefined {
  if (rateToBase == null) return undefined
  const n = Number(rateToBase)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const inverted = 1 / n
  // Xero accepts up to ~6dp; round to 8 to keep symmetric with our Decimal(18,8).
  const factor = 10 ** XERO_RATE_DECIMALS
  return Math.round(inverted * factor) / factor
}
