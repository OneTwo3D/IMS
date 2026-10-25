import { imsRateToXeroCurrencyRate, isForeignCurrency } from '@/lib/connectors/xero/fx'

/**
 * o3d-q0x56.2 / .3 - A FOREIGN-CURRENCY POSTING THAT CARRIES NO IMS RATE IS NOT QUEUED.
 *
 * Owner rulings, 2026-10-24: one central FX reference (IMS fx_rates); a missing rate refuses; IMS sends its own rate on every foreign
 * document and payment it posts and never lets Xero fall back to its XE.com day rate. An omitted `CurrencyRate` is exactly that
 * fallback, so a foreign posting without a usable rate must not reach the queue (this guard, at the single enqueue chokepoint every
 * site routes through) and must not be built into a payload (the connector builders, defence in depth).
 *
 *   documents  SALES_INVOICE, SALES_INVOICE_UPDATE, CREDIT_NOTE, PURCHASE_INVOICE, PURCHASE_INVOICE_UPDATE, PURCHASE_CREDIT_NOTE
 *              carry `currency` and `currencyRateToBase`: the document's STORED booked rate (1 base = X foreign). Never looked up.
 *   payments   INVOICE_PAYMENT, BILL_PAYMENT carry `currency` and `settlementRateToBase`: the settlement rate IMS resolved for THAT
 *              payment when it was recorded (same convention). Carried on the queued work so the processor posts exactly what IMS
 *              used, with no lookup at send time.
 *
 * A payload with no `currency` (or a base-currency one) is not foreign and is not touched: Xero books it at 1.
 */
export const FOREIGN_RATE_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'SALES_INVOICE',
  'SALES_INVOICE_UPDATE',
  'CREDIT_NOTE',
  'PURCHASE_INVOICE',
  'PURCHASE_INVOICE_UPDATE',
  'PURCHASE_CREDIT_NOTE',
])

export const FOREIGN_RATE_PAYMENT_TYPES: ReadonlySet<string> = new Set(['INVOICE_PAYMENT', 'BILL_PAYMENT'])

export type ForeignRateRefusal = {
  /** The inbox row's reason. */
  reason: 'foreign_document_missing_rate' | 'foreign_payment_missing_rate'
  message: string
  remedy: string
  detail: Record<string, unknown>
}

/** True when the value is a usable IMS rate: a finite number (or numeric string) greater than zero that survives the 1/rate, 6 dp conversion. */
export function isUsableImsRate(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  if (typeof value === 'string' && value.trim() === '') return false
  const converted = imsRateToXeroCurrencyRate(Number(value))
  return converted !== undefined && converted > 0
}

export function needsForeignRate(type: string): boolean {
  return FOREIGN_RATE_DOCUMENT_TYPES.has(type) || FOREIGN_RATE_PAYMENT_TYPES.has(type)
}

export function foreignCurrencyRateRefusal(params: {
  type: string
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  baseCurrency: string
}): ForeignRateRefusal | null {
  const isPayment = FOREIGN_RATE_PAYMENT_TYPES.has(params.type)
  if (!isPayment && !FOREIGN_RATE_DOCUMENT_TYPES.has(params.type)) return null
  const currency = params.payload.currency
  if (!isForeignCurrency(currency, params.baseCurrency)) return null
  const field = isPayment ? 'settlementRateToBase' : 'currencyRateToBase'
  const value = params.payload[field]
  if (isUsableImsRate(value)) return null
  const code = String(currency).trim().toUpperCase()
  const base = params.baseCurrency.trim().toUpperCase()
  const found = value === undefined || value === null ? 'none' : String(value)
  if (isPayment) {
    return {
      reason: 'foreign_payment_missing_rate',
      message:
        `The ${params.type} for ${params.referenceType} ${params.referenceId} is in ${code} but carries no usable settlement rate to ${base} (found ${found}). `
        + 'IMS will not send a foreign payment without its own rate: Xero would apply its XE.com day rate and book a different realised FX.',
      remedy:
        `Add an ${base}/${code} rate to the FX rates (Settings > Currencies) for the payment date, then record the payment again.`,
      detail: { currency: code, baseCurrency: base, field, found },
    }
  }
  return {
    reason: 'foreign_document_missing_rate',
    message:
      `The ${params.type} for ${params.referenceType} ${params.referenceId} is in ${code} but its stored FX rate to ${base} is unusable (found ${found}). `
      + 'IMS will not send a foreign document without its own rate: Xero would apply its XE.com day rate.',
    remedy:
      `Correct the exchange rate on the document (it must be a positive ${base}-to-${code} rate), then raise the posting again.`,
    detail: { currency: code, baseCurrency: base, field, found },
  }
}
