import { toIsoCountryCode } from '@/lib/countries'

// Built-in, complete ISO 3166-1 region validator — used to accept valid alpha-2 codes that the repository's
// small curated COUNTRIES name-map (toIsoCountryCode) does not list (e.g. AD, MD). For an unknown but
// well-formed region code, Intl.DisplayNames returns the code unchanged; for a valid one it returns a name.
let regionNames: Intl.DisplayNames | null | undefined
function isValidIsoAlpha2(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false
  try {
    if (regionNames === undefined) regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
    if (!regionNames) return false
    return regionNames.of(code) !== code
  } catch {
    return false
  }
}

/**
 * bhdm.7: normalise a country-of-origin value supplied on a product CSV import to an ISO-2 code.
 *
 * Accepts a country name/alias/known code via the curated map, OR any well-formed, VALID ISO 3166-1 alpha-2
 * code the curated map happens to omit (so export→import round-trips every stored origin). Returns null for an
 * absent, blank, or genuinely unrecognised value — the caller warns on a nonblank unrecognised value rather
 * than silently dropping it, and on UPDATE applies the result only when non-null so a bad cell never clears an
 * existing origin. Purely operator-supplied explicit data — never defaulted, so it cannot silently relabel.
 */
export function normalizeCsvCountryOfOrigin(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const mapped = toIsoCountryCode(trimmed)
  if (mapped) return mapped
  const upper = trimmed.toUpperCase()
  return isValidIsoAlpha2(upper) ? upper : null
}
