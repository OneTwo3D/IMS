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
  const base = params.baseTaxType ?? undefined
  if (params.reverseCharge && params.reverseChargeSalesTaxType) {
    return params.reverseChargeSalesTaxType
  }
  return base
}
