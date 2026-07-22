import { toIsoCountryCode } from '@/lib/countries'

/**
 * bhdm.7: normalise a country-of-origin value supplied on a product CSV import to an ISO-2 code.
 *
 * Delegates to toIsoCountryCode, which is backed by the COMPLETE assigned ISO 3166-1 alpha-2 set, so every
 * valid origin (name, alias, or code — including ones outside the small curated trading list) round-trips
 * through export→import and is editable in the product form, while reserved/pseudo/retired codes
 * (EU/UN/ZZ/SU) and genuine garbage yield null. The caller warns on a nonblank unrecognised value rather than
 * silently dropping it, and on UPDATE applies the result only when non-null so a bad cell never clears an
 * existing origin. Purely operator-supplied explicit data — never defaulted, so it cannot silently relabel.
 */
export function normalizeCsvCountryOfOrigin(raw: string | null | undefined): string | null {
  return toIsoCountryCode(raw)
}

/**
 * bhdm.7: true when a product update must be BLOCKED because it would clear a legacy INVALID origin without a
 * valid replacement. Only a nonblank persisted value that is not a valid country, combined with a blank/null
 * submission, blocks — a blank/whitespace-only or already-valid persisted origin may still be cleared.
 * `submittedIso` is the post-schema submitted value (null for blank, or a canonical ISO-2 code).
 */
export function blocksClearingInvalidOrigin(persisted: string | null | undefined, submittedIso: string | null): boolean {
  const trimmed = (persisted ?? '').trim()
  if (trimmed === '') return false
  if (toIsoCountryCode(trimmed) !== null) return false
  return !submittedIso
}
