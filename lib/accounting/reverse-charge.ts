/**
 * Reverse-charge tax-type resolution for sales documents (invoices, credit
 * notes) pushed to the accounting connector.
 *
 * When a line's resolved TaxRate has reverseCharge = true, the line must post
 * to the accounting system under the configured reverse-charge tax code (e.g.
 * Xero ECOUTPUTSERVICES) instead of the rate's normal accountingTaxType, so the
 * VAT return classifies it on the reverse-charge boxes. When the reverse-charge
 * setting is empty the original tax type is preserved — the line still posts,
 * it just is not reverse-charge-tagged on the accounting side (defensive
 * default; an unconfigured swap should not change the amount, only the tag).
 *
 * Single source of truth shared by the sales-invoice push and the credit-note
 * push so the two never drift (audit finding H1: credit notes used to skip the
 * swap, posting a reverse-charged refund under the standard tax type and
 * breaking the VAT return debit/credit symmetry).
 */
export function resolveSalesLineTaxType(params: {
  /** The line's normal accounting tax type (from its TaxRate, or a fallback). */
  baseTaxType: string | null | undefined
  /** Whether the line's resolved TaxRate is flagged reverseCharge. */
  reverseCharge: boolean | null | undefined
  /** settings.reverseChargeSalesTaxType — empty string disables the swap. */
  reverseChargeSalesTaxType: string | null | undefined
}): string | undefined {
  return taxTypeForBasis('sales_line', params)
}

/** The purchase-side twin (bills): the configured reverse-charge PURCHASE type replaces the line's normal type for a reverse-charge rate. */
export function resolvePurchaseLineTaxType(params: {
  baseTaxType: string | null | undefined
  reverseCharge: boolean | null | undefined
  /** settings.reverseChargePurchaseTaxType — empty disables the swap. */
  reverseChargePurchaseTaxType: string | null | undefined
}): string | undefined {
  return taxTypeForBasis('purchase_line', params)
}

/**
 * THE BASIS OF A TAX-RATE BINDING: how the tax type sent beside a bound rate id was derived from that rate. The ONE definition, shared by every producer (which sends `taxTypeForBasis(...)` and
 * binds the rate with `rateBinding(...)`) and by the enqueue guard (lib/tax/retired-tax-code-guard.ts, which recomputes the expected type from the rate AS IT IS NOW with the same function and
 * requires exact equality), so the two cannot diverge. tests/tax/tax-type-basis-census.test.ts pins that every producer goes through it.
 *   sales_line     a goods line of a sales document: the rate's code, or the configured reverse-charge SALES type for a reverse-charge rate;
 *   purchase_line  a goods line of a bill: the rate's code, or the configured reverse-charge PURCHASE type for a reverse-charge rate;
 *   plain          the rate's code as it stands, never swapped (shipping and discount, a supplier default, a cost line).
 * A binding that carries no basis, or one the guard does not know, is refused for a rate a re-key cleared: the binding cannot say what the producer would send.
 */
export type TaxBindingBasis = 'sales_line' | 'purchase_line' | 'plain'
export const TAX_BINDING_BASES: readonly TaxBindingBasis[] = ['sales_line', 'purchase_line', 'plain']

export function taxTypeForBasis(basis: TaxBindingBasis, params: {
  baseTaxType: string | null | undefined
  reverseCharge: boolean | null | undefined
  reverseChargeSalesTaxType?: string | null | undefined
  reverseChargePurchaseTaxType?: string | null | undefined
}): string | undefined {
  const base = params.baseTaxType ?? undefined
  if (basis === 'sales_line' && params.reverseCharge && params.reverseChargeSalesTaxType) return params.reverseChargeSalesTaxType
  if (basis === 'purchase_line' && params.reverseCharge && params.reverseChargePurchaseTaxType) return params.reverseChargePurchaseTaxType
  return base
}

/** The sibling key that carries the basis of a binding key: `taxRateId` -> `taxRateBasis`, `shippingTaxRateId` -> `shippingTaxRateBasis`. */
export function basisKeyFor(bindingKey: string): string {
  return bindingKey.replace(/TaxRateId$/, 'TaxRateBasis').replace(/^taxRateId$/, 'taxRateBasis')
}

/** `{ <prefix>TaxRateId, <prefix>TaxRateBasis }` for a payload object (prefix '' for the object's own `taxRateId`), or {} when there is no rate to bind. Never sent by the senders. */
export function rateBinding(rateId: string | null | undefined, basis: TaxBindingBasis, prefix: '' | 'shipping' | 'discount' = ''): Record<string, string> {
  if (!rateId) return {}
  const key = prefix === '' ? 'taxRateId' : `${prefix}TaxRateId`
  return { [key]: rateId, [basisKeyFor(key)]: basis }
}
