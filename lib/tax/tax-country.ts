/**
 * The country statements of a tax rate, in one place: the leading two-letter prefix of a Xero or IMS rate name ("CY VAT", "cy VAT", "el vat") and the normal form of a country code (UK = GB, EL = GR, upper case, trimmed).
 * Shared by the re-key (lib/tax/tax-rekey.ts) and the reconciliation pack's R13 VAT set identity, so the two judge a country the same way. Pure.
 */
const ALIASES: Record<string, string> = { UK: 'GB', EL: 'GR' }

export const normaliseCountryCode = (code: string): string => {
  const upper = code.trim().toUpperCase()
  return ALIASES[upper] ?? upper
}

/** "CY VAT" -> "CY"; a name with no leading two-letter word gives null. Case-insensitive, like the name comparison that finds a rate. */
export function xeroNameCountry(name: string): string | null {
  const match = /^([A-Za-z]{2})(?:[\s-]|$)/.exec(name.trim())
  return match ? normaliseCountryCode(match[1]!) : null
}
