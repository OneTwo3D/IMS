/**
 * onetwo3d-ims-30tg: connector-agnostic planner for "generate + map missing
 * accounting tax rates".
 *
 * Given the IMS's active tax rates (the canonical hub) and the tax rates that
 * already exist in the active accounting connector, decide — purely, no IO —
 * which IMS rates need a brand-new external rate created for them.
 *
 * A rate is a CREATE candidate only when it is:
 *   - active, AND
 *   - not already mapped (accountingTaxType is null/blank), AND
 *   - has no name-match among the connector's existing rates.
 *
 * Name-matches are intentionally left for auto-link (see
 * lib/tax/tax-rate-match.ts / autoLink*TaxRates) rather than re-created here,
 * so we never create a duplicate for a rate the connector already has. Matching
 * uses the same name normalization as the unified matcher.
 *
 * Pure — no IO. Unit-tested in tests/generate-missing-tax-rates.test.ts.
 */

import { normalizeTaxName } from '@/lib/tax/tax-rate-match'

export type ImsRateComponentForGeneration = {
  name: string
  /** IMS decimal fraction, e.g. 0.2 for 20%. */
  rate: number
  compoundOnPrevious: boolean
}

export type ImsRateForGeneration = {
  id: string
  name: string
  /** IMS decimal fraction, e.g. 0.2 for 20%. */
  rate: number
  usedFor: string
  reportingCategory: string | null
  accountingTaxType: string | null
  active: boolean
  /** Active components only; empty when the rate is single-component. */
  components: ImsRateComponentForGeneration[]
}

export type ExternalRateLite = {
  name: string
  ratePct: number
}

/**
 * One proposed external tax-rate creation, shown in the confirmation dialog
 * before anything is written to the accounting system. Connector-neutral: the
 * provider fills `reportType` with its own report/tax-type string (e.g. Xero
 * 'OUTPUT') or null when none applies.
 */
export type ProposedTaxRateCreation = {
  taxRateId: string
  name: string
  /** Percentage units for display, e.g. 20 for 20%. */
  ratePct: number
  reportingCategory: string | null
  reportType: string | null
}

export type MissingTaxRatePreviewResult = {
  success: boolean
  toCreate: ProposedTaxRateCreation[]
  alreadyMapped: number
  skippedExisting: number
  externalRatesCount: number
  /** Whether the active connector supports creating tax rates at all. */
  supported: boolean
  error?: string
}

export type MissingTaxRateGenerateResult = {
  success: boolean
  created: number
  failed: Array<{ name: string; error: string }>
  externalRatesCount: number
  supported: boolean
  error?: string
}

export type MissingTaxRatePlan = {
  /** Active, unmapped, no existing external name-match — create these. */
  toCreate: ImsRateForGeneration[]
  /** Active but already mapped (accountingTaxType set). */
  alreadyMapped: ImsRateForGeneration[]
  /** Active, unmapped, but an external rate with the same name already exists —
   *  OR a same-named IMS rate is already queued for creation this run — skipped
   *  so we don't create duplicates; auto-link handles these afterwards. */
  skippedExisting: ImsRateForGeneration[]
}

/** True when the IMS rate has no usable accounting mapping yet. */
function isUnmapped(rate: ImsRateForGeneration): boolean {
  return !rate.accountingTaxType || rate.accountingTaxType.trim() === ''
}

export function planMissingTaxRateCreations(
  imsRates: ImsRateForGeneration[],
  externalRates: ExternalRateLite[],
): MissingTaxRatePlan {
  const existingNames = new Set(externalRates.map((e) => normalizeTaxName(e.name)))
  // Names already queued for creation this run — a second active/unmapped IMS
  // rate with the same normalized name would post to the same Xero rate (Xero
  // keys by Name), so we skip it rather than create a collision.
  const queuedNames = new Set<string>()

  const toCreate: ImsRateForGeneration[] = []
  const alreadyMapped: ImsRateForGeneration[] = []
  const skippedExisting: ImsRateForGeneration[] = []

  for (const rate of imsRates) {
    if (!rate.active) continue
    if (!isUnmapped(rate)) {
      alreadyMapped.push(rate)
      continue
    }
    const normalized = normalizeTaxName(rate.name)
    if (existingNames.has(normalized) || queuedNames.has(normalized)) {
      skippedExisting.push(rate)
      continue
    }
    queuedNames.add(normalized)
    toCreate.push(rate)
  }

  return { toCreate, alreadyMapped, skippedExisting }
}

/**
 * The connector-neutral tax components to send when mirroring an IMS rate.
 * Multi-component rates pass their components through; single-component rates
 * synthesise one component from the rate itself (Name = rate name, so the
 * external breakdown still shows the full rate).
 */
export function taxComponentsForCreation(
  rate: ImsRateForGeneration,
): ImsRateComponentForGeneration[] {
  if (rate.components.length > 0) return rate.components
  return [{ name: rate.name, rate: rate.rate, compoundOnPrevious: false }]
}
