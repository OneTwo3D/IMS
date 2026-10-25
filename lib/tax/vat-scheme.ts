/**
 * WHICH VAT SCHEME A RATE BELONGS TO: uk, ioss, voec or other (EU OSS and every other foreign registration), or UNCLASSIFIED. Pure and deterministic.
 *
 * Owner ruling 2026-10-25: the VAT difference report is four reports, one per scheme. A rate that cannot be classified is never dropped and never guessed: it
 * is its own reason (UNCLASSIFIED_SCHEME) and the report lists it in a visible "unclassified" section.
 *
 * CLASSIFICATION SOURCES (in this order; the first rule that applies decides, and its name is returned as `source`):
 *   1. IMS TaxRate.reportingCategory. The schema comment says DOMESTIC, REVERSE_CHARGE, EC_SALES, OSS (free text, "e.g."); neither IOSS nor VOEC is a
 *      value IMS writes today, so the category tokens `IOSS` and `VOEC` are accepted as EXPLICIT markers (an operator sets them), and `OSS` means the
 *      EU one-stop-shop / foreign registrations ("other").
 *   2. The country: IMS TaxRate.countryCode, the WooCommerce rate's country, or, for a Xero type no IMS rate carries, the ISO prefix of its name
 *      (upper-case two-letter prefix, the convention of lib/connectors/xero/tax-rate-report-type.ts). Norway (NO) is VOEC
 *      (VOEC_ISO_CODES of that module); GB/UK is the UK scheme; an EU member state (EU_ISO_CODES of that module) is ambiguous between OSS and IOSS
 *      (Xero files both under MOSSSALES) and is UNCLASSIFIED unless rule 1 marked it; any other country is "other".
 *   3. A global rate (no country) is UK when its category is empty, DOMESTIC, REVERSE_CHARGE or EC_SALES (UK VAT return concepts) and Xero's ReportTaxType is
 *      not MOSSSALES. For a Xero-only type (no category exists) Xero's ReportTaxType must be one of the UK return types.
 * Anything else, including a conflict (an OSS category on a GB rate, an unknown category) is UNCLASSIFIED with the reason.
 */

import { EU_ISO_CODES, VOEC_ISO_CODES } from '@/lib/connectors/xero/tax-rate-report-type'

export const VAT_SCHEMES = ['uk', 'ioss', 'voec', 'other'] as const
export type VatScheme = (typeof VAT_SCHEMES)[number]
export type VatSchemeBucket = VatScheme | 'unclassified'
export const VAT_SCHEME_BUCKETS = [...VAT_SCHEMES, 'unclassified'] as const
export const VAT_SCHEME_TITLES: Record<VatSchemeBucket, string> = {
  uk: 'UK VAT', ioss: 'IOSS VAT', voec: 'VOEC (Norway) VAT', other: 'Other foreign VAT (EU OSS and other registrations)', unclassified: 'Unclassified',
}

export type Classification = { scheme: VatSchemeBucket; source: string }

const UK_CATEGORIES = new Set(['', 'DOMESTIC', 'REVERSE_CHARGE', 'EC_SALES'])
/** Xero ReportTaxType values of the UK VAT return (what the rate generator emits for UK rates). */
const UK_REPORT_TYPES = new Set(['OUTPUT', 'INPUT', 'ECOUTPUTSERVICES', 'ECACQUISITIONS', 'REVERSECHARGES', 'EXEMPTOUTPUT', 'EXEMPTINPUT', 'ZERORATEDOUTPUT', 'ZERORATEDINPUT', 'EXEMPTEXPORT', 'EXEMPTEXPENSES'])

const normaliseCategory = (category: string | null | undefined): string => (category ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
const normaliseCountry = (country: string | null | undefined): string => {
  const code = (country ?? '').trim().toUpperCase()
  return code === 'UK' ? 'GB' : code
}

function classify(input: { country: string; countrySource: string; category: string | null | undefined; reportType: string | null | undefined; xeroOnly: boolean }): Classification {
  const category = normaliseCategory(input.category)
  const country = input.country
  const unclassified = (why: string): Classification => ({ scheme: 'unclassified', source: why })
  if (category === 'IOSS') return country === 'GB' ? unclassified('reportingCategory IOSS on a GB rate (conflict)') : { scheme: 'ioss', source: 'reportingCategory=IOSS' }
  if (category === 'VOEC') return country === 'GB' ? unclassified('reportingCategory VOEC on a GB rate (conflict)') : { scheme: 'voec', source: 'reportingCategory=VOEC' }
  if (VOEC_ISO_CODES.has(country)) return { scheme: 'voec', source: `${input.countrySource} ${country} (VOEC)` }
  if (category === 'OSS') return country === 'GB' ? unclassified('reportingCategory OSS on a GB rate (conflict)') : { scheme: 'other', source: 'reportingCategory=OSS' }
  if (country === 'GB') return UK_CATEGORIES.has(category) ? { scheme: 'uk', source: `${input.countrySource} GB` } : unclassified(`unknown reportingCategory ${category} on a GB rate`)
  if (country === '') {
    if (!UK_CATEGORIES.has(category)) return unclassified(`unknown reportingCategory ${category} on a rate with no country`)
    if (input.reportType === 'MOSSSALES') return unclassified('no country and Xero ReportTaxType MOSSSALES (OSS, IOSS or VOEC cannot be told apart)')
    if (input.xeroOnly) return input.reportType != null && UK_REPORT_TYPES.has(input.reportType) ? { scheme: 'uk', source: `Xero ReportTaxType ${input.reportType}` } : unclassified(`Xero type with no country prefix and ReportTaxType ${input.reportType ?? '(none)'}`)
    return { scheme: 'uk', source: `no country, reportingCategory ${category === '' ? '(none)' : category}` }
  }
  if (EU_ISO_CODES.has(country)) return unclassified(`EU member state ${country} with no OSS or IOSS marker in reportingCategory (OSS and IOSS cannot be told apart)`)
  return { scheme: 'other', source: `${input.countrySource} ${country} (not GB, NO or an EU member state)` }
}

export const classifyImsRate = (rate: { countryCode: string | null; reportingCategory: string | null }, xeroReportTaxType: string | null): Classification =>
  classify({ country: normaliseCountry(rate.countryCode), countrySource: 'IMS countryCode', category: rate.reportingCategory, reportType: xeroReportTaxType, xeroOnly: false })

/** A WooCommerce rate no IMS rate is mapped to: its country is all there is (none = unclassified). */
export function classifyWooRate(country: string): Classification {
  const code = normaliseCountry(country)
  if (code === '') return { scheme: 'unclassified', source: 'WooCommerce rate with no country and no IMS mapping' }
  return classify({ country: code, countrySource: 'WooCommerce country', category: null, reportType: null, xeroOnly: false })
}

/**
 * A Xero tax type no active IMS rate carries: an UPPER-CASE two-letter ISO prefix of its name ("NO 25%", "DE Standard"; the rate generator's convention, but
 * upper case only, so "No VAT" is not Norway) and its ReportTaxType.
 */
export function classifyXeroType(row: { name: string; reportTaxType: string | null }): Classification {
  const prefix = /^([A-Z]{2})(?![A-Za-z])/.exec(row.name.trim())
  return classify({ country: normaliseCountry(prefix ? prefix[1] : ''), countrySource: 'Xero name prefix', category: null, reportType: row.reportTaxType, xeroOnly: true })
}
