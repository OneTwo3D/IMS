/**
 * audit-wrwr: pure cross-system tax-rate matcher used by the unified tax-rate
 * mapper (onboarding wizard + Settings). It reconciles the IMS's canonical tax
 * rates (the hub) against WooCommerce tax rates and Xero tax types/rates.
 *
 * Matching is RATE-first, then normalized name — the numeric rate is the only
 * signal that survives across systems (names diverge: "20% (UK)" vs "Standard
 * rate" vs "OUTPUT2"). All three inputs are compared in PERCENTAGE units; the
 * caller converts the IMS rate (a Decimal fraction, e.g. 0.2) to a percentage
 * (20) before calling.
 *
 * Pure — no IO. Unit-tested in tests/tax-rate-match.test.ts.
 */

export type MatchConfidence = 'rate+name' | 'rate' | 'name' | 'none'

export type ImsRateLite = {
  id: string
  name: string
  ratePct: number
  accountingTaxType: string | null
  active?: boolean
}

export type WcRateLite = {
  externalTaxRateId: string
  externalName: string
  externalRatePct: number
  /** The IMS rate this WC rate is already mapped to (if any). */
  taxRateId?: string | null
  /** ShoppingTaxRateMapping row id — used by the UI to delete (unmap). */
  mappingId?: string
}

export type XeroRateLite = {
  taxType: string
  name: string
  ratePct: number
}

export type TaxMatchRow<E> = {
  match: E | null
  confidence: MatchConfidence
  /** True when matched on name but the rate differs — a conflict to resolve manually. */
  rateConflict: boolean
}

export type TaxMatchResult = {
  rows: Array<{
    ims: ImsRateLite
    wc: TaxMatchRow<WcRateLite>
    xero: TaxMatchRow<XeroRateLite>
  }>
  /** WC rates with no IMS hub — candidates for "create IMS rate". */
  unmatchedWc: WcRateLite[]
  /** Xero rates with no IMS hub — informational (we don't create IMS rates from Xero). */
  unmatchedXero: XeroRateLite[]
}

/** Lowercase + strip everything that isn't a letter or digit. */
export function normalizeTaxName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Percentage-unit equality with a half-basis-point tolerance for rounding. */
export function ratesEqual(aPct: number, bPct: number): boolean {
  if (!Number.isFinite(aPct) || !Number.isFinite(bPct)) return false
  return Math.abs(aPct - bPct) <= 0.005
}

type Candidate = { name: string; ratePct: number }

/**
 * Best match for one IMS rate against a pool of external rates, in priority
 * order. Returns the chosen external + confidence, or null. `rate+name` and
 * `rate` are the trustworthy tiers; `name` (rate differs) is a flagged conflict.
 */
function classify(ims: ImsRateLite, candidate: Candidate): MatchConfidence {
  const rateMatch = ratesEqual(ims.ratePct, candidate.ratePct)
  const nameMatch = normalizeTaxName(ims.name) === normalizeTaxName(candidate.name)
  if (rateMatch && nameMatch) return 'rate+name'
  if (rateMatch) return 'rate'
  if (nameMatch) return 'name'
  return 'none'
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { 'rate+name': 3, rate: 2, name: 1, none: 0 }

/**
 * Two-pass greedy assignment: assign all 'rate+name' matches first, then 'rate',
 * then 'name', so a perfect match is never stolen by a weaker one. Each external
 * rate is consumed once. Inputs are sorted by (ratePct, normalized name) for
 * deterministic output regardless of input order.
 */
function assign<E>(
  imsRates: ImsRateLite[],
  externals: E[],
  getName: (e: E) => string,
  getRatePct: (e: E) => number,
  getId: (e: E) => string,
): { byImsId: Map<string, { match: E; confidence: MatchConfidence }>; unmatched: E[] } {
  const byImsId = new Map<string, { match: E; confidence: MatchConfidence }>()
  const taken = new Set<E>()

  // Stable id tie-breakers so output is deterministic even when rate+name collide.
  const sortedIms = [...imsRates].sort(
    (a, b) => a.ratePct - b.ratePct
      || normalizeTaxName(a.name).localeCompare(normalizeTaxName(b.name))
      || a.id.localeCompare(b.id),
  )
  const sortedExt = [...externals].sort(
    (a, b) => getRatePct(a) - getRatePct(b)
      || normalizeTaxName(getName(a)).localeCompare(normalizeTaxName(getName(b)))
      || getId(a).localeCompare(getId(b)),
  )

  for (const tier of ['rate+name', 'rate', 'name'] as const) {
    for (const ims of sortedIms) {
      if (byImsId.has(ims.id)) continue
      for (const ext of sortedExt) {
        if (taken.has(ext)) continue
        if (classify(ims, { name: getName(ext), ratePct: getRatePct(ext) }) === tier) {
          byImsId.set(ims.id, { match: ext, confidence: tier })
          taken.add(ext)
          break
        }
      }
    }
  }

  const unmatched = externals.filter((e) => !taken.has(e))
  return { byImsId, unmatched }
}

function toRow<E>(assigned: { match: E; confidence: MatchConfidence } | undefined): TaxMatchRow<E> {
  if (!assigned) return { match: null, confidence: 'none', rateConflict: false }
  return {
    match: assigned.match,
    confidence: assigned.confidence,
    rateConflict: assigned.confidence === 'name',
  }
}

export function matchTaxRates(input: {
  imsRates: ImsRateLite[]
  wcRates: WcRateLite[]
  xeroRates: XeroRateLite[]
}): TaxMatchResult {
  const wc = assign(input.imsRates, input.wcRates, (e) => e.externalName, (e) => e.externalRatePct, (e) => e.externalTaxRateId)
  const xero = assign(input.imsRates, input.xeroRates, (e) => e.name, (e) => e.ratePct, (e) => e.taxType)

  const rows = input.imsRates.map((ims) => ({
    ims,
    wc: toRow(wc.byImsId.get(ims.id)),
    xero: toRow(xero.byImsId.get(ims.id)),
  }))

  return { rows, unmatchedWc: wc.unmatched, unmatchedXero: xero.unmatched }
}

/**
 * Best-effort suggested links the UI can auto-apply: only the trustworthy tiers
 * ('rate+name' and 'rate'), and ONLY for links that are currently UNSET — never
 * overwrite an existing mapping (which may be a deliberate manual override).
 * - WC: only when the matched WC rate is not yet mapped to any IMS rate.
 * - Xero: only when the IMS rate has no accountingTaxType yet.
 * Name-only (rate conflict) matches are excluded — manual only.
 */
export function suggestedAutoApply(result: TaxMatchResult): {
  wcLinks: Array<{ externalTaxRateId: string; taxRateId: string }>
  xeroLinks: Array<{ taxRateId: string; accountingTaxType: string }>
} {
  const wcLinks: Array<{ externalTaxRateId: string; taxRateId: string }> = []
  const xeroLinks: Array<{ taxRateId: string; accountingTaxType: string }> = []

  for (const row of result.rows) {
    if (row.wc.match && (row.wc.confidence === 'rate+name' || row.wc.confidence === 'rate')) {
      if (row.wc.match.taxRateId == null) {
        wcLinks.push({ externalTaxRateId: row.wc.match.externalTaxRateId, taxRateId: row.ims.id })
      }
    }
    if (row.xero.match && (row.xero.confidence === 'rate+name' || row.xero.confidence === 'rate')) {
      if (row.ims.accountingTaxType == null) {
        xeroLinks.push({ taxRateId: row.ims.id, accountingTaxType: row.xero.match.taxType })
      }
    }
  }

  return { wcLinks, xeroLinks }
}

export { CONFIDENCE_RANK }
