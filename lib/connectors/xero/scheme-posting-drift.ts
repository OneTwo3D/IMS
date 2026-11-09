/**
 * DRIFT OF THE SCHEME POSTING TYPES: an IMS rate's `schemePostingTaxType` (the zero-rated Xero type an IOSS or VOEC sale's goods, shipping and discount lines post on) is matched to Xero BY
 * CODE, because it is a code and not a name that gets sent. The name-matched sweep (tax-rate-drift.ts) cannot see it: the posting type is a different Xero rate from the one the IMS rate is named
 * for ("DE VAT" against "DE IOSS VAT"), and a rate with no components is not compared at all.
 *
 * A posting type is drifted when its Xero type is gone from the list or no longer ACTIVE, is no longer at an effective rate of exactly 0, has another name than the declaration
 * (lib/tax/eu-vat-seed.json, byte-exact) states for that code, or when the IMS rate carries it without an IOSS/VOEC marker. Pure; alert-only, as the rest of the sweep: nothing is written back.
 */
import type { NormalisedXeroTaxRate } from './tax-rate-list'

export type SchemePostingRate = { taxRateId: string; name: string; schemePostingTaxType: string; reportingCategory: string | null; accountingTaxType: string | null }

/** `expectedNames`: the declared Xero name of each scheme posting code (byte-exact), from the seed. */
export function computeSchemePostingDrift(
  rates: readonly SchemePostingRate[],
  xero: readonly NormalisedXeroTaxRate[],
  expectedNames: ReadonlyMap<string, string>,
): Array<{ taxRateId: string; name: string; lines: string[] }> {
  const byType = new Map(xero.map((row) => [row.taxType, row]))
  const out: Array<{ taxRateId: string; name: string; lines: string[] }> = []
  for (const rate of rates) {
    const lines: string[] = []
    const code = rate.schemePostingTaxType
    const live = byType.get(code)
    if (live === undefined) lines.push(`Scheme posting type ${code} is not in the Xero tax-rate list`)
    else {
      if (live.status !== 'ACTIVE') lines.push(`Scheme posting type ${code} is ${live.status} in Xero, not ACTIVE`)
      const stated = live.effectiveRate ?? live.displayTaxRate
      if (stated === null) lines.push(`Scheme posting type ${code} states no rate in Xero, so it cannot be shown to be zero-rated`)
      else if (Number(stated) !== 0) lines.push(`Scheme posting type ${code} is ${Number(stated)}% in Xero, not 0%`)
      const expected = expectedNames.get(code)
      if (expected !== undefined && live.name !== expected) lines.push(`Scheme posting type ${code} is named "${live.name}" in Xero, declared "${expected}"`)
    }
    const category = (rate.reportingCategory ?? '').trim().toUpperCase()
    if (category !== 'IOSS' && category !== 'VOEC') lines.push(`Carries scheme posting type ${code} but its reporting category is "${rate.reportingCategory ?? ''}", not IOSS or VOEC`)
    if (rate.accountingTaxType !== null && rate.accountingTaxType === code) lines.push(`Its charged code is its scheme posting type ${code}: a scheme line would post on the charged rate`)
    if (lines.length > 0) out.push({ taxRateId: rate.taxRateId, name: rate.name, lines })
  }
  return out
}
