/**
 * IMS↔Xero TaxRate drift detection — pure comparison helpers (Phase 1, 0jls5/2txvn).
 *
 * When an operator edits a TaxRate directly in Xero (e.g. tweaks a component rate from
 * 7.00% to 7.50%), IMS never notices and the next invoice posts with the IMS-side
 * definition, conflicting with Xero on the VAT return. These helpers compare an IMS
 * TaxRate profile against the live Xero TaxRate (already fetched by name) and produce a
 * typed diff plus human-readable change lines. Alert-only: no writeback here.
 *
 * Pure and dependency-free so it is fully unit-testable without hitting Xero (the
 * fetching/sweeping lives in Phase 2).
 */

import type { XeroTaxRate } from './tax-rates'

/**
 * IMS-shaped tax rate: a name plus active components. `rate` is the IMS-native decimal
 * fraction (0.05 = 5%), matching TaxRateComponent.rate; it is normalised to a percent
 * the same way buildXeroTaxRatePayload does before comparing against Xero.
 */
export type ImsTaxRateProfile = {
  name: string
  components: Array<{ name: string; rate: number; compoundOnPrevious: boolean }>
}

export type TaxRateDriftChange =
  | { kind: 'parent-name'; ims: string; xero: string }
  | { kind: 'component-added'; component: string; xeroPercent: number }
  | { kind: 'component-removed'; component: string; imsPercent: number }
  | { kind: 'component-rate'; component: string; imsPercent: number; xeroPercent: number }
  | { kind: 'component-compound'; component: string; ims: boolean; xero: boolean }
  // Two components with the same (trimmed, case-insensitive) name on one side: the
  // by-name comparison can't reliably pair them, so surface it as drift rather than
  // silently collapsing them in the map and risking a missed real change.
  | { kind: 'duplicate-component'; side: 'ims' | 'xero'; component: string }

export type TaxRateDriftResult =
  | { status: 'equal' }
  | { status: 'missing-on-xero' }
  | { status: 'missing-on-ims' }
  | { status: 'mismatch'; changes: TaxRateDriftChange[] }

// Match IMS→Xero conversion (buildXeroTaxRatePayload): IMS decimals (0.05) → percent (5),
// rounded to 4dp. Xero rates are already percent; round to the same scale so equal rates
// don't read as drift through floating-point noise.
function imsToPercent(rate: number): number {
  return Math.round(rate * 100 * 10_000) / 10_000
}
function normalizePercent(rate: number): number {
  return Math.round(rate * 10_000) / 10_000
}
function componentKey(name: string): string {
  return name.trim().toLowerCase()
}
function duplicateComponentKeys(names: string[]): string[] {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const name of names) {
    const key = componentKey(name)
    if (seen.has(key)) dups.add(key)
    else seen.add(key)
  }
  return [...dups]
}

/**
 * Compare an IMS tax-rate profile against the matching live Xero tax rate.
 * Pass `null` for whichever side is absent (the sweeper matches by name).
 */
export function computeTaxRateDrift(
  imsRate: ImsTaxRateProfile | null,
  xeroRate: XeroTaxRate | null,
): TaxRateDriftResult {
  if (!imsRate && !xeroRate) return { status: 'equal' }
  if (!xeroRate) return { status: 'missing-on-xero' }
  if (!imsRate) return { status: 'missing-on-ims' }

  const changes: TaxRateDriftChange[] = []

  if (imsRate.name.trim() !== xeroRate.Name.trim()) {
    changes.push({ kind: 'parent-name', ims: imsRate.name, xero: xeroRate.Name })
  }

  for (const component of duplicateComponentKeys(imsRate.components.map((c) => c.name))) {
    changes.push({ kind: 'duplicate-component', side: 'ims', component })
  }
  for (const component of duplicateComponentKeys(xeroRate.TaxComponents.map((c) => c.Name))) {
    changes.push({ kind: 'duplicate-component', side: 'xero', component })
  }

  const imsByKey = new Map(
    imsRate.components.map((c) => [
      componentKey(c.name),
      { name: c.name, percent: imsToPercent(c.rate), compound: c.compoundOnPrevious },
    ]),
  )
  const xeroByKey = new Map(
    xeroRate.TaxComponents.map((c) => [
      componentKey(c.Name),
      { name: c.Name, percent: normalizePercent(c.Rate), compound: c.IsCompound === true },
    ]),
  )

  for (const [key, ims] of imsByKey) {
    const xero = xeroByKey.get(key)
    if (!xero) {
      changes.push({ kind: 'component-removed', component: ims.name, imsPercent: ims.percent })
      continue
    }
    if (ims.percent !== xero.percent) {
      changes.push({ kind: 'component-rate', component: ims.name, imsPercent: ims.percent, xeroPercent: xero.percent })
    }
    if (ims.compound !== xero.compound) {
      changes.push({ kind: 'component-compound', component: ims.name, ims: ims.compound, xero: xero.compound })
    }
  }
  for (const [key, xero] of xeroByKey) {
    if (!imsByKey.has(key)) {
      changes.push({ kind: 'component-added', component: xero.name, xeroPercent: xero.percent })
    }
  }

  return changes.length === 0 ? { status: 'equal' } : { status: 'mismatch', changes }
}

function fmtPercent(percent: number): string {
  // Trim trailing zeros: 7.5000 → "7.5", 7.0000 → "7".
  return `${parseFloat(percent.toFixed(4))}%`
}

/**
 * Human-readable change lines for an activity-log entry / UI tooltip, e.g.
 * `PST component rate: IMS 7%, Xero 7.5%`.
 */
export function formatDriftLines(result: TaxRateDriftResult): string[] {
  switch (result.status) {
    case 'equal':
      return []
    case 'missing-on-xero':
      return ['No matching tax rate found in Xero']
    case 'missing-on-ims':
      return ['No matching tax rate found in IMS']
    case 'mismatch':
      return result.changes.map((change) => {
        switch (change.kind) {
          case 'parent-name':
            return `Tax rate name: IMS "${change.ims}", Xero "${change.xero}"`
          case 'component-added':
            return `Component "${change.component}" added in Xero (${fmtPercent(change.xeroPercent)})`
          case 'component-removed':
            return `Component "${change.component}" missing in Xero (IMS ${fmtPercent(change.imsPercent)})`
          case 'component-rate':
            return `${change.component} component rate: IMS ${fmtPercent(change.imsPercent)}, Xero ${fmtPercent(change.xeroPercent)}`
          case 'component-compound':
            return `Component "${change.component}" compound: IMS ${change.ims}, Xero ${change.xero}`
          case 'duplicate-component':
            return `Duplicate component "${change.component}" on the ${change.side === 'ims' ? 'IMS' : 'Xero'} side — resolve before comparison is reliable`
          default:
            return assertNever(change)
        }
      })
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tax-rate drift change: ${JSON.stringify(value)}`)
}
