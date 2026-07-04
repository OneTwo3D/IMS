/**
 * onetwo3d-ims-30tg: translate an IMS TaxRate's reporting category into the
 * Xero ReportTaxType enum used when creating a new Xero TaxRate (POST /TaxRates).
 *
 * ReportTaxType controls which VAT-return box the rate files to. IMS's
 * reportingCategory (DOMESTIC / REVERSE_CHARGE / EC_SALES / OSS) plus the rate's
 * usedFor (SALES / PURCHASE / BOTH) determine the box. Reverse-charge and EC
 * lines are ALSO re-tagged at push time via settings.reverseCharge*TaxType
 * (see lib/accounting/reverse-charge.ts); this only sets the base rate's own
 * report type at creation.
 *
 * Default map (confirmed with the operator, Xero UK — onetwo3d-ims-30tg):
 *   DOMESTIC       SALES/BOTH  -> OUTPUT
 *   DOMESTIC       PURCHASE    -> INPUT
 *   REVERSE_CHARGE any         -> REVERSECHARGES
 *   EC_SALES       SALES/BOTH  -> ECOUTPUTSERVICES
 *   EC_SALES       PURCHASE    -> ECACQUISITIONS
 *   OSS            any         -> NONE (no UK VAT-return box)
 *   (unset)        SALES/BOTH  -> OUTPUT
 *   (unset)        PURCHASE    -> INPUT
 *
 * Pure — no IO. Unit-tested in tests/xero-tax-rate-report-type.test.ts.
 */

export type XeroReportTaxType =
  | 'OUTPUT'
  | 'INPUT'
  | 'REVERSECHARGES'
  | 'ECOUTPUTSERVICES'
  | 'ECACQUISITIONS'
  | 'NONE'

/** Normalise reportingCategory to the canonical uppercase token, or null. */
function normalizeCategory(category: string | null | undefined): string | null {
  if (!category) return null
  return category.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/** True when the rate is used on purchases only (bills), not sales. */
function isPurchaseOnly(usedFor: string | null | undefined): boolean {
  return (usedFor ?? '').trim().toUpperCase() === 'PURCHASE'
}

export function xeroReportTaxType(input: {
  reportingCategory: string | null | undefined
  usedFor: string | null | undefined
}): XeroReportTaxType {
  const category = normalizeCategory(input.reportingCategory)
  const purchase = isPurchaseOnly(input.usedFor)

  switch (category) {
    case 'REVERSE_CHARGE':
      return 'REVERSECHARGES'
    case 'EC_SALES':
      return purchase ? 'ECACQUISITIONS' : 'ECOUTPUTSERVICES'
    case 'OSS':
      return 'NONE'
    case 'DOMESTIC':
    default:
      return purchase ? 'INPUT' : 'OUTPUT'
  }
}
