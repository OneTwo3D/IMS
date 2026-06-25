/**
 * IMS↔Xero TaxRate drift sweeper (Phase 2, 0jls5/odvgu).
 *
 * Compares each active IMS TaxRate (with components) against the live Xero
 * TaxRate by name and, on drift, records an alert. Alert-only — no writeback.
 *
 * The orchestration (`sweepTaxRateDrift`) is dependency-injected so it is fully
 * unit-testable without hitting Xero or the database; `runXeroTaxRateDriftSweep`
 * wires it to the real fetch/db/activity-log/setting deps for the cron.
 */

import { computeTaxRateDrift, formatDriftLines, type ImsTaxRateProfile, type TaxRateDriftResult } from './tax-rate-drift'
import type { XeroTaxRate } from './tax-rates'

export type DriftSweepItem = {
  taxRateId: string
  name: string
  result: TaxRateDriftResult
  /** Human-readable change lines (empty when status is `equal`). */
  lines: string[]
}

export type TaxRateDriftSweepResult = {
  checked: number
  drifted: number
  items: DriftSweepItem[]
}

export type TaxRateDriftSweepDeps = {
  /** Active IMS TaxRates with ≥1 active component, as comparison profiles. */
  loadImsProfiles: () => Promise<Array<{ taxRateId: string; profile: ImsTaxRateProfile }>>
  fetchXeroTaxRates: () => Promise<XeroTaxRate[]>
  /** Record a single drifted rate (e.g. write an ActivityLog WARNING). */
  recordDrift: (item: DriftSweepItem) => Promise<void>
  /** Stamp the last-checked time so the UI can show "checked N ago". */
  recordCheckedAt?: (at: Date) => Promise<void>
  now?: () => Date
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

export async function sweepTaxRateDrift(deps: TaxRateDriftSweepDeps): Promise<TaxRateDriftSweepResult> {
  const [imsProfiles, xeroRates] = await Promise.all([deps.loadImsProfiles(), deps.fetchXeroTaxRates()])
  const xeroByName = new Map<string, XeroTaxRate>()
  for (const rate of xeroRates) xeroByName.set(nameKey(rate.Name), rate)

  const items: DriftSweepItem[] = []
  let drifted = 0
  for (const { taxRateId, profile } of imsProfiles) {
    const xeroRate = xeroByName.get(nameKey(profile.name)) ?? null
    const result = computeTaxRateDrift(profile, xeroRate)
    const item: DriftSweepItem = { taxRateId, name: profile.name, result, lines: formatDriftLines(result) }
    items.push(item)
    if (result.status !== 'equal') {
      drifted++
      await deps.recordDrift(item)
    }
  }

  if (deps.recordCheckedAt) {
    await deps.recordCheckedAt(deps.now ? deps.now() : new Date())
  }

  return { checked: imsProfiles.length, drifted, items }
}

export const TAX_RATE_DRIFT_LAST_CHECKED_SETTING = 'xero_tax_rate_drift_last_checked_at'

/**
 * Wire the sweep to the real IMS database, the live Xero API, the activity log,
 * and the last-checked setting. Used by the cron route.
 */
export async function runXeroTaxRateDriftSweep(): Promise<TaxRateDriftSweepResult> {
  const { db } = await import('@/lib/db')
  const { logActivity } = await import('@/lib/activity-log')
  const { fetchXeroTaxRates } = await import('./tax-rates')

  return sweepTaxRateDrift({
    async loadImsProfiles() {
      const rows = await db.taxRate.findMany({
        where: { active: true, components: { some: { active: true } } },
        select: {
          id: true,
          name: true,
          components: {
            where: { active: true },
            orderBy: { sortOrder: 'asc' },
            select: { name: true, rate: true, compoundOnPrevious: true },
          },
        },
      })
      return rows.map((row) => ({
        taxRateId: row.id,
        profile: {
          name: row.name,
          components: row.components.map((component) => ({
            name: component.name,
            rate: Number(component.rate),
            compoundOnPrevious: component.compoundOnPrevious,
          })),
        },
      }))
    },
    fetchXeroTaxRates,
    async recordDrift(item) {
      await logActivity({
        entityType: 'SYSTEM',
        entityId: item.taxRateId,
        action: 'tax_rate_drift_detected',
        tag: 'accounting',
        level: 'WARNING',
        description: item.result.status === 'missing-on-xero'
          ? `Tax rate "${item.name}" has no matching rate in Xero`
          : `Tax rate "${item.name}" differs from Xero: ${item.lines.join('; ')}`,
        metadata: {
          taxRateId: item.taxRateId,
          name: item.name,
          status: item.result.status,
          changes: item.result.status === 'mismatch' ? item.result.changes : [],
          lines: item.lines,
        },
      })
    },
    async recordCheckedAt(at) {
      await db.setting.upsert({
        where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING },
        create: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: at.toISOString() },
        update: { value: at.toISOString() },
      })
    },
  })
}
