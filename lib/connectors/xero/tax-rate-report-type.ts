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
 *   OSS            SALES/BOTH  -> MOSSSALES
 *   OSS            PURCHASE    -> INPUT
 *   (unset)        SALES/BOTH  -> OUTPUT
 *   (unset)        PURCHASE    -> INPUT
 *
 * NOTE (onetwo3d-ims-tdzp): Xero rejects ReportTaxType `NONE` at rate creation
 * ("not valid for this organisation"), so it is never emitted or offered. OSS
 * sales report via MOSS (One Stop Shop = the MOSS successor), which Xero accepts.
 *
 * EU distance-selling override (onetwo3d-ims-tdzp): a rate whose NAME starts
 * with an EU member-state ISO code (e.g. "DE Standard", "FR 20%") is an OSS/MOSS
 * distance sale, so it defaults to MOSSSALES (Xero "MOSS Sales"). This overrides
 * the category default for every case EXCEPT an explicit REVERSE_CHARGE (a
 * deliberately different VAT treatment that still wins) and purchase-only rates
 * (MOSS Sales is a sales report type).
 *
 * Pure — no IO. Unit-tested in tests/xero-tax-rate-report-type.test.ts.
 */

export type XeroReportTaxType =
  | 'OUTPUT'
  | 'INPUT'
  | 'REVERSECHARGES'
  | 'ECOUTPUTSERVICES'
  | 'ECACQUISITIONS'
  | 'MOSSSALES'

/**
 * The report types the generator can produce / the operator may pick in the
 * confirmation dialog. All are operator-confirmed valid Xero UK ReportTaxType
 * values (onetwo3d-ims-30tg / -tdzp); the server validates any user override
 * against this list before sending it to Xero. `NONE` is intentionally excluded
 * — Xero rejects it at rate creation.
 */
export const XERO_REPORT_TAX_TYPES: XeroReportTaxType[] = [
  'OUTPUT',
  'INPUT',
  'ECOUTPUTSERVICES',
  'ECACQUISITIONS',
  'MOSSSALES',
  'REVERSECHARGES',
]

/** True when `value` is a report type the generator is allowed to send to Xero. */
export function isXeroReportTaxType(value: string | null | undefined): value is XeroReportTaxType {
  return value != null && (XERO_REPORT_TAX_TYPES as string[]).includes(value)
}

/**
 * EU member-state ISO 3166-1 alpha-2 codes (27 states). Greece is included as
 * both GR (ISO) and EL (the EU/VAT variant). GB is intentionally excluded.
 */
const EU_ISO_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'EL', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

/** Normalise reportingCategory to the canonical uppercase token, or null. */
function normalizeCategory(category: string | null | undefined): string | null {
  if (!category) return null
  return category.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/** True when the rate is used on purchases only (bills), not sales. */
function isPurchaseOnly(usedFor: string | null | undefined): boolean {
  return (usedFor ?? '').trim().toUpperCase() === 'PURCHASE'
}

/**
 * The EU ISO code a rate name starts with, or null. Only matches a leading
 * 2-letter token that is NOT part of a longer word — so "DE Standard",
 * "FR-20%" and "NL" match, but "Deutschland" (DE followed by a letter) does not.
 */
function euIsoPrefix(name: string | null | undefined): string | null {
  const match = (name ?? '').trim().match(/^([A-Za-z]{2})(?![A-Za-z])/)
  if (!match) return null
  const code = match[1].toUpperCase()
  return EU_ISO_CODES.has(code) ? code : null
}

export function xeroReportTaxType(input: {
  reportingCategory: string | null | undefined
  usedFor: string | null | undefined
  /** Rate name — used to detect the EU-distance-selling (MOSS) default. */
  name?: string | null
}): XeroReportTaxType {
  const category = normalizeCategory(input.reportingCategory)
  const purchase = isPurchaseOnly(input.usedFor)

  // Reverse charge is a deliberate, fundamentally different treatment — it wins
  // even for EU-named rates.
  if (category === 'REVERSE_CHARGE') return 'REVERSECHARGES'

  // EU distance-selling: an EU-ISO-prefixed sales rate defaults to MOSS Sales.
  if (!purchase && euIsoPrefix(input.name)) return 'MOSSSALES'

  switch (category) {
    case 'EC_SALES':
      return purchase ? 'ECACQUISITIONS' : 'ECOUTPUTSERVICES'
    case 'OSS':
      // OSS (One Stop Shop) sales report via MOSS; Xero rejects NONE at creation.
      return purchase ? 'INPUT' : 'MOSSSALES'
    case 'DOMESTIC':
    default:
      return purchase ? 'INPUT' : 'OUTPUT'
  }
}
