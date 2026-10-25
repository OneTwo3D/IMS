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

// Xero's API schema specifies CurrencyRate as Decimal(18,6). Round here so we
// never send more precision than Xero accepts.
const XERO_RATE_DECIMALS = 6

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
  const factor = 10 ** XERO_RATE_DECIMALS
  return Math.round(inverted * factor) / factor
}

/**
 * A foreign-currency Xero document or payment that has no usable IMS rate. Thrown by the connector builders BEFORE a payload is built:
 * an omitted `CurrencyRate` makes Xero apply its own XE.com day rate, which is a second FX reference the owner has ruled out
 * (2026-10-24: one central reference, IMS fx_rates; IMS sends its own rate on every foreign document and payment).
 */
export class XeroForeignCurrencyRateError extends Error {
  constructor(
    message: string,
    readonly currency: string,
    readonly baseCurrency: string,
  ) {
    super(message)
    this.name = 'XeroForeignCurrencyRateError'
  }
}

export function isXeroForeignCurrencyRateError(error: unknown): error is XeroForeignCurrencyRateError {
  return error instanceof XeroForeignCurrencyRateError
}

function normaliseCurrencyCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : ''
}

/**
 * Is this document or payment in a currency other than the base? An EMPTY currency is not foreign: the payload names no currency,
 * so Xero books it in the organisation's base currency and there is no rate to send. A non-empty code that differs from the base is
 * foreign.
 */
export function isForeignCurrency(currency: unknown, baseCurrency: unknown): boolean {
  const c = normaliseCurrencyCode(currency)
  if (c === '') return false
  return c !== normaliseCurrencyCode(baseCurrency)
}

/**
 * The `CurrencyRate` to send for a document or payment, or a refusal.
 *
 *   - a usable IMS rate always converts (1 / rate, 6 dp) and is sent, base or foreign (unchanged for base-currency documents that
 *     carry one);
 *   - a BASE-currency (or currency-less) item with no usable rate returns `undefined`: Xero books it at 1, there is nothing to
 *     substitute;
 *   - a FOREIGN item with no usable rate THROWS. It is never sent without one.
 *
 * `rateToBase` is IMS's convention (1 base = X foreign), the STORED rate of the document or the settlement rate of the payment.
 * This function never looks a rate up.
 */
export function xeroCurrencyRateOrRefuse(params: {
  currency: unknown
  baseCurrency: string
  rateToBase: number | undefined | null
  /** What to call it in the message, e.g. `sales invoice INV-1`. */
  what: string
}): number | undefined {
  const converted = imsRateToXeroCurrencyRate(params.rateToBase)
  const usable = converted !== undefined && converted > 0
  if (usable) return converted
  if (!isForeignCurrency(params.currency, params.baseCurrency)) return undefined
  const currency = normaliseCurrencyCode(params.currency)
  const base = normaliseCurrencyCode(params.baseCurrency)
  throw new XeroForeignCurrencyRateError(
    `${params.what} is in ${currency} but carries no usable IMS rate to ${base} (found ${params.rateToBase == null ? 'none' : String(params.rateToBase)}). `
    + 'Nothing was sent: without a CurrencyRate Xero would apply its own XE.com day rate. Correct the exchange rate on the document, then retry.',
    currency,
    base,
  )
}

/** `xeroCurrencyRateOrRefuse` as a value: the refusal message, or null when the document may be built. For a caller that must refuse BEFORE a side effect. */
export function foreignCurrencyRateProblem(params: Parameters<typeof xeroCurrencyRateOrRefuse>[0]): string | null {
  try {
    xeroCurrencyRateOrRefuse(params)
    return null
  } catch (error) {
    if (isXeroForeignCurrencyRateError(error)) return error.message
    throw error
  }
}

/**
 * The READ direction, for a caller that holds a Xero document and wants its base-currency amount (the reconciliation pack's R12). Xero's
 * `CurrencyRate` is 1 document-currency = X base (above), so the base amount is the document amount TIMES the rate: EUR 50 at 1.25 is GBP
 * 62.50. Generic over the decimal type so the pack keeps its exact arithmetic; this file stays free of imports.
 */
export function xeroDocumentAmountToBase<T extends { mul(factor: string): T }>(documentAmount: T, xeroCurrencyRate: string): T {
  return documentAmount.mul(xeroCurrencyRate)
}
