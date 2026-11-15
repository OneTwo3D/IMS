/**
 * THE SHADOW REPORT'S REFUSALS ARE CLOSED CODES, NEVER THE IMPORTER'S TEXT. The importer's and the treatment's refusal sentences can quote an order line's or fee's name (`tax mismatch on "<description>"`), and a WooCommerce item
 * or fee name can carry customer data. The report therefore never carries a refusal sentence: it classifies the reason here, keeps the CODE (and numeric ids), and prints a fixed sentence written below. The real importer's
 * own logging is untouched. Pure.
 */
export const SHADOW_REFUSAL_TEXT = {
  currency_unreadable: 'the order currency is missing or unreadable',
  store_credit: 'the order carries store credit, and IMS refuses a store-credit invoice whole',
  coupons_unclassifiable: 'the order’s coupons cannot be classified',
  connector_not_xero: 'the accounting connector is not Xero, so no Xero document would be built',
  unmapped_tax_rate: 'a WooCommerce tax rate on the order is not mapped to an IMS tax rate, so IMS would substitute the default rate',
  tax_mismatch: 'the document does not total the order (the tax IMS models differs from the tax WooCommerce reported, or the total is outside the rounding allowance)',
  gift_card_flag_missing: 'a goods line carries no readable gift-card flag',
  regime_refused: 'the order’s EU VAT regime cannot be established',
  scheme_posting_type: 'the scheme’s zero-rated posting type is not proven by the stored Xero list',
  fee_or_account_missing: 'a landed-cost fee or VAT account setting is missing or a marked fee carries VAT off the scheme',
  fx_rate_unavailable: 'no usable exchange rate for the order',
  tax_type_missing: 'a line would post with no decided tax type',
  currency_rate_missing: 'a foreign-currency invoice has no usable exchange rate',
  builder_failed: 'the invoice builder failed on this order',
  not_comparable_built: 'the built invoice could not be reduced to comparable figures',
  other: 'IMS would refuse this order (the reason is in the IMS activity log of a real import, not in this report)',
} as const

export type ShadowRefusalCode = keyof typeof SHADOW_REFUSAL_TEXT

/** Classify an importer or treatment refusal sentence to a closed code. The sentence is read and discarded; only the code leaves. */
export function classifyShadowRefusal(reason: string): ShadowRefusalCode {
  const r = reason.toLowerCase()
  if (r.includes('store credit')) return 'store_credit'
  if (r.includes('gift_card') || r.includes('gift-card') || r.includes('gift card')) return 'gift_card_flag_missing'
  if (r.includes('unmapped') || r.includes('not mapped')) return 'unmapped_tax_rate'
  if (r.includes('does not total the order') || r.includes('document total') || r.includes('rounding') || r.includes('reconcil') || r.includes('tax mismatch') || r.includes('totals ')) return 'tax_mismatch'
  if (r.includes('posting type') || r.includes('zero-rated type') || r.includes('stored xero')) return 'scheme_posting_type'
  if (r.includes('exchange rate') || r.includes('no usable rate') || r.includes('fx')) return 'fx_rate_unavailable'
  if (r.includes('regime')) return 'regime_refused'
  if (r.includes('fee account') || r.includes('no account configured') || r.includes('marked fee')) return 'fee_or_account_missing'
  return 'other'
}

export const shadowRefusalDetail = (code: ShadowRefusalCode, ids: readonly number[] = []): string =>
  `${code}${ids.length > 0 ? ` (rate ${ids.join(', ')})` : ''}: ${SHADOW_REFUSAL_TEXT[code]}`
