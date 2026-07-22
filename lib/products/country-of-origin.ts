import { toIsoCountryCode } from '@/lib/countries'

/**
 * bhdm.7: normalise a country-of-origin value supplied on a product CSV import to an ISO-2 code.
 *
 * Returns the ISO-2 code when the cell holds a recognised country, otherwise null (absent column, blank cell,
 * or an unrecognised country string). Importing origin is purely additive operator-supplied data — it never
 * defaults to a fallback, so it cannot silently relabel a product. On an UPDATE the caller applies the result
 * only when non-null, so a blank/invalid cell never clears an existing origin.
 */
export function normalizeCsvCountryOfOrigin(raw: string | null | undefined): string | null {
  return toIsoCountryCode(raw)
}
