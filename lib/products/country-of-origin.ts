import { toIsoCountryCode } from '@/lib/countries'
import { isAssignedIsoAlpha2 } from '@/lib/iso-3166-1-alpha2'

/**
 * bhdm.7: normalise a country-of-origin value supplied on a product CSV import to an ISO-2 code.
 *
 * Accepts a country name/alias/known code via the curated map, OR any ASSIGNED ISO 3166-1 alpha-2 code the
 * curated map happens to omit (validated against a deterministic versioned set, NOT Intl.DisplayNames which
 * also resolves reserved/pseudo/retired codes like EU/UN/ZZ/SU) — so export→import round-trips every stored
 * origin. Returns null for an
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
  return isAssignedIsoAlpha2(upper) ? upper : null
}
