/**
 * The country statements of a tax rate, in one place: the leading two-letter prefix of a Xero or IMS rate name ("CY VAT", "cy VAT", "el vat") and the normal form of a country code (UK = GB, EL = GR, upper case, trimmed).
 * Also the REGION a name states ("PT-30 VAT" is region 30) and the comparable form of a name (trimmed, whitespace runs collapsed, case ignored).
 * Shared by the re-key (lib/tax/tax-rekey.ts) and the reconciliation pack's R13 VAT set identity, so the two judge a country, a region and a name the same way. Pure.
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

/** A region token as one comparable string: upper case, letters and digits only, the leading country code dropped ("PT-30" and "30" are both "30"). */
export function regionToken(text: string, country: string): string {
  const token = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return country !== '' && token.startsWith(country) && token.length > country.length ? token.slice(country.length) : token
}
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set(['VAT', 'TAX', 'GST', 'ZERO', 'STANDARD', 'REDUCED', 'RATE', 'OSS', 'IOSS', 'VOEC', 'EXEMPT'])
/**
 * The region a rate NAME states, one parser for IMS and Xero names: the token after a two-letter country prefix joined by a hyphen ("PT-30 VAT" is "30").
 *   region    a hyphenated region token ("PT-30 VAT")
 *   wide      the prefix is followed by a generic word or nothing ("PT VAT", "GB VAT (Income)", "UK Standard Rate (20%)"), or there is no country prefix: no region is stated
 *   unreadable  the prefix is followed by a word that is not generic ("ES Canary VAT", "PT Madeira VAT"): a region may be stated in a convention this parser does not read
 */
export type NameRegion = { kind: 'region'; token: string } | { kind: 'wide' } | { kind: 'unreadable' }
export function nameRegion(name: string, country: string): NameRegion {
  const text = name.trim()
  const hyphen = /^[A-Za-z]{2}-([A-Za-z0-9]+)/.exec(text)
  if (hyphen !== null && !GENERIC_NAME_WORDS.has(hyphen[1]!.toUpperCase())) return { kind: 'region', token: regionToken(hyphen[1]!, country) }
  const word = /^[A-Za-z]{2}[\s-]+([A-Za-z]+)/.exec(text)
  if (word !== null && !GENERIC_NAME_WORDS.has(word[1]!.toUpperCase())) return { kind: 'unreadable' }
  return { kind: 'wide' }
}

/** A rate name with its surrounding spaces removed and every run of whitespace collapsed to one space; case kept (the re-key's first, case-sensitive name tier). */
export const collapseName = (name: string): string => name.trim().replace(/\s+/g, ' ')
/** A rate name as the re-key and R13 compare it: trimmed, whitespace runs collapsed, case ignored. */
export const comparableName = (name: string): string => collapseName(name).toLowerCase()
