/**
 * XERO'S BUILT-IN TAX TYPES: the codes that mean the same thing in every organisation, unlike the CUSTOM codes (TAX001..TAXnnn), which Xero numbers per organisation in
 * creation order. The one list: scripts/copy-tax-rates.ts copies only these between instances, and lib/tax/tax-rekey.ts (npm run tax:rekey) treats every OTHER code on an IMS
 * tax rate as organisation-specific, to be checked against the organisation connected now.
 */
export const XERO_BUILT_IN_TAX_TYPES: ReadonlySet<string> = new Set([
  'OUTPUT', 'OUTPUT2', 'INPUT', 'INPUT2', 'RRINPUT', 'RROUTPUT',
  'ZERORATEDOUTPUT', 'ZERORATEDINPUT', 'EXEMPTOUTPUT', 'EXEMPTINPUT',
  'NONE', 'GSTONIMPORTS', 'REVERSECHARGES',
  'ECZROUTPUT', 'ECZRINPUT', 'ECOUTPUT', 'ECINPUT', 'ECACQUISITIONS',
])

/** True for a code that is organisation-specific: any code that is not a built-in (TAX001..TAXnnn and anything else a Xero organisation mints). */
export const isOrganisationSpecificTaxType = (taxType: string): boolean => !XERO_BUILT_IN_TAX_TYPES.has(taxType)
