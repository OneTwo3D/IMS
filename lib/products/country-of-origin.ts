import { toIsoCountryCode, DEFAULT_COUNTRY_OF_ORIGIN } from '@/lib/countries'

/**
 * bhdm.7: resolve a product's country of origin for a CSV IMPORT create.
 *
 * A created product must never be left with a null origin: the WMS/customs push already sends
 * `countryOfOrigin ?? 'CN'`, so a null here shows blank in the UI while the WMS receives CN (a display-vs-sent
 * inconsistency). We import the CSV value when it is a valid country, and fall back to the same CN default
 * otherwise (absent column, blank cell, or an unrecognised country string) so the displayed origin matches what
 * is actually sent.
 */
export function resolveImportedCountryOfOriginForCreate(raw: string | null | undefined): string {
  return toIsoCountryCode(raw) ?? DEFAULT_COUNTRY_OF_ORIGIN
}

/**
 * bhdm.7: resolve a country-of-origin UPDATE from a CSV cell.
 *
 * Returns a normalised ISO-2 code only when the cell holds a valid country; otherwise null, meaning "leave the
 * existing origin untouched". A blank/invalid cell must never clear or overwrite an origin that is already set
 * (which would reintroduce the display-vs-sent gap).
 */
export function resolveImportedCountryOfOriginForUpdate(raw: string | null | undefined): string | null {
  return toIsoCountryCode(raw)
}
