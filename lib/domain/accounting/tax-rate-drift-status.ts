/**
 * Read side of IMS↔Xero TaxRate drift detection (Phase 3, 0jls5/1sbg2).
 *
 * The Phase 2 sweeper writes an atomic snapshot of the drifted rates
 * (`xero_tax_rate_drift_current`) and a `xero_tax_rate_drift_last_checked_at`
 * stamp at the end of every completed run. The snapshot is fully replaced each
 * sweep, so a fixed rate drops out on the next run — no activity-log time-window
 * heuristic. A staleness guard suppresses the snapshot if no sweep has completed
 * recently (e.g. Xero disconnected and the cron has been skipping), so the UI
 * never shows indefinitely-stale drift.
 */

import {
  TAX_RATE_DRIFT_LAST_CHECKED_SETTING,
  TAX_RATE_DRIFT_SNAPSHOT_SETTING,
  type TaxRateDriftSnapshotEntry,
} from '@/lib/connectors/xero/tax-rate-drift-sweeper'

/** Drop the snapshot once the last completed sweep is older than this (broken/stopped cron). */
export const DRIFT_MAX_STALENESS_MS = 26 * 60 * 60 * 1000

export type TaxRateDriftStatus = {
  taxRateId: string
  name: string
  status: 'missing-on-xero' | 'mismatch'
  lines: string[]
  detectedAt: string
}

export type CurrentTaxRateDrift = {
  /** ISO timestamp of the last completed sweep, or null if none has run. */
  lastCheckedAt: string | null
  /** Whether IMS→Xero tax-rate sync is enabled (so the operator can push a fix). */
  syncEnabled: boolean
  byTaxRateId: Record<string, TaxRateDriftStatus>
  count: number
}

const EMPTY = (lastCheckedAt: string | null, syncEnabled: boolean): CurrentTaxRateDrift => ({
  lastCheckedAt,
  syncEnabled,
  byTaxRateId: {},
  count: 0,
})

/**
 * Pure: parse the drift snapshot JSON into a map keyed by taxRateId. Defends
 * against malformed entries; `detectedAt` is the sweep's checked-at time (all
 * snapshot entries were detected by the same sweep).
 */
export function parseDriftSnapshot(json: string | null | undefined, detectedAt: string): Record<string, TaxRateDriftStatus> {
  if (!json) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (!Array.isArray(parsed)) return {}

  const byTaxRateId: Record<string, TaxRateDriftStatus> = {}
  for (const raw of parsed as TaxRateDriftSnapshotEntry[]) {
    const entry = raw as { taxRateId?: unknown; name?: unknown; status?: unknown; lines?: unknown }
    const taxRateId = typeof entry.taxRateId === 'string' ? entry.taxRateId : null
    const status = entry.status === 'mismatch' || entry.status === 'missing-on-xero' ? entry.status : null
    if (!taxRateId || !status || byTaxRateId[taxRateId]) continue
    byTaxRateId[taxRateId] = {
      taxRateId,
      name: typeof entry.name === 'string' ? entry.name : '',
      status,
      lines: Array.isArray(entry.lines) ? entry.lines.filter((l): l is string => typeof l === 'string') : [],
      detectedAt,
    }
  }
  return byTaxRateId
}

export async function getCurrentTaxRateDrift(): Promise<CurrentTaxRateDrift> {
  const { db } = await import('@/lib/db')
  const { isAccountingSyncTypeEnabled } = await import('@/lib/accounting')

  const [checkedSetting, snapshotSetting, syncEnabled] = await Promise.all([
    db.setting.findUnique({ where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING } }),
    db.setting.findUnique({ where: { key: TAX_RATE_DRIFT_SNAPSHOT_SETTING } }),
    isAccountingSyncTypeEnabled('TAX_RATE_SYNC').catch(() => false),
  ])

  const lastCheckedAt = checkedSetting?.value ?? null
  if (!lastCheckedAt) return EMPTY(null, syncEnabled)

  // Suppress indefinitely-stale drift: if the cron stopped completing sweeps
  // (e.g. Xero disconnected), don't keep asserting the old snapshot as current.
  const checkedMs = new Date(lastCheckedAt).getTime()
  if (!Number.isFinite(checkedMs) || Date.now() - checkedMs > DRIFT_MAX_STALENESS_MS) {
    return EMPTY(lastCheckedAt, syncEnabled)
  }

  const byTaxRateId = parseDriftSnapshot(snapshotSetting?.value, lastCheckedAt)
  return { lastCheckedAt, syncEnabled, byTaxRateId, count: Object.keys(byTaxRateId).length }
}
