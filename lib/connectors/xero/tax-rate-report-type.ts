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
 *   OSS (non-EU/   0% SALES/BOTH -> EXEMPTOUTPUT   0% PURCHASE -> EXEMPTINPUT
 *    non-VOEC)     ≠0 SALES/BOTH -> OUTPUT         ≠0 PURCHASE -> INPUT
 *   (unset)        SALES/BOTH  -> OUTPUT
 *   (unset)        PURCHASE    -> INPUT
 *
 * NOTE (onetwo3d-ims-tdzp): Xero rejects ReportTaxType `NONE` at rate creation
 * ("not valid for this organisation"), so it is never emitted or offered.
 *
 * EU / VOEC distance-selling override (onetwo3d-ims-tdzp): a SALES rate whose
 * NAME starts with an EU member-state ISO code (e.g. "DE Standard", "FR 20%") or
 * a VOEC code (Norway "NO") is an OSS/IOSS/VOEC distance sale, so it reports via
 * MOSSSALES (Xero "MOSS Sales"). This overrides the category default for every
 * case EXCEPT an explicit REVERSE_CHARGE (which still wins) and purchase-only
 * rates. OSS rates outside those schemes (e.g. Channel Islands, Isle of Man,
 * Monaco) are treated as exempt when zero-rated (EXEMPTOUTPUT / EXEMPTINPUT);
 * ones that still charge VAT can't be exempt in Xero, so they fall back to
 * OUTPUT / INPUT. The operator can change any of these per-rate in the dialog.
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
  | 'EXEMPTOUTPUT'
  | 'EXEMPTINPUT'

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
  'EXEMPTOUTPUT',
  'EXEMPTINPUT',
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

/**
 * VOEC (VAT On E-Commerce) ISO codes — Norway's low-value-goods scheme. Like the
 * EU OSS/IOSS rates, VOEC sales report via MOSS Sales (onetwo3d-ims-tdzp).
 */
const VOEC_ISO_CODES = new Set(['NO'])

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
 * The leading ISO 3166-1 alpha-2 code a rate name starts with, or null. Only
 * matches a leading 2-letter token that is NOT part of a longer word — so
 * "DE Standard", "FR-20%" and "NL" match, but "Deutschland" does not.
 */
function leadingIsoCode(name: string | null | undefined): string | null {
  const match = (name ?? '').trim().match(/^([A-Za-z]{2})(?![A-Za-z])/)
  return match ? match[1].toUpperCase() : null
}

export function xeroReportTaxType(input: {
  reportingCategory: string | null | undefined
  usedFor: string | null | undefined
  /** Rate name — used to detect the EU/VOEC-distance-selling (MOSS) default. */
  name?: string | null
  /** Effective rate as a decimal fraction (e.g. 0.2 for 20%). Used to keep the
   *  exempt default valid — Xero rejects an exempt rate with a non-zero component. */
  rate?: number | null
}): XeroReportTaxType {
  const category = normalizeCategory(input.reportingCategory)
  const purchase = isPurchaseOnly(input.usedFor)
  const code = leadingIsoCode(input.name)
  const isEuOrVoec = code != null && (EU_ISO_CODES.has(code) || VOEC_ISO_CODES.has(code))
  const isZeroRated = Math.abs(input.rate ?? 0) < 1e-9

  // Reverse charge is a deliberate, fundamentally different treatment — it wins
  // even for EU-named rates.
  if (category === 'REVERSE_CHARGE') return 'REVERSECHARGES'

  // EU distance-selling (OSS/IOSS) and VOEC both report sales via MOSS Sales.
  if (!purchase && isEuOrVoec) return 'MOSSSALES'

  switch (category) {
    case 'EC_SALES':
      return purchase ? 'ECACQUISITIONS' : 'ECOUTPUTSERVICES'
    case 'OSS':
      // OSS rates outside EU/IOSS/VOEC (e.g. Channel Islands, Isle of Man,
      // Monaco) are treated as exempt — but Xero rejects a non-zero exempt
      // component, so only zero-rated ones map to EXEMPT. Any that still charge
      // VAT get a safe standard default the operator changes per-rate in the
      // confirmation dialog.
      if (isZeroRated) return purchase ? 'EXEMPTINPUT' : 'EXEMPTOUTPUT'
      return purchase ? 'INPUT' : 'OUTPUT'
    case 'DOMESTIC':
    default:
      return purchase ? 'INPUT' : 'OUTPUT'
  }
}
