import { db } from '@/lib/db'

/**
 * Sync-log retention window shared by the daily-batch "recreate missing logs"
 * recovery (Xero + QuickBooks). Recreate rebuilds a daily-batch log that went
 * MISSING before it posted so the journal still reaches the ledger — but
 * data-retention (retention_sync_logs_months) HARD-DELETES old SYNCED daily-batch
 * logs while the shipment/order keeps its journaled-date marker. Beyond the
 * retention window recreate can no longer distinguish "never posted" from "posted
 * then pruned", so rebuilding would re-post an already-ledgered journal (scjz.36
 * double-post). Bounding recreate to the same window means a missing log inside it
 * genuinely never posted. Mirrors the windowing the accounting invariants apply
 * (collectAccountingInvariantRows / retainedDateFilter).
 */
export const DEFAULT_SYNC_LOG_RETENTION_MONTHS = 6

/** Parse the retention_sync_logs_months setting; non-numeric/negative → the default. */
export function resolveRetentionMonths(rawValue: string | null | undefined): number {
  const parsed = Number.parseInt(rawValue ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SYNC_LOG_RETENTION_MONTHS
}

/** Pure cutoff: oldest journaled-date recreate may act on, or null (retention disabled). */
export function computeRetentionCutoff(months: number, now: Date): Date | null {
  if (months <= 0) return null
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - months)
  return cutoff
}

/** Oldest journaled-date recreate may safely act on, or null when retention is
 *  disabled (months <= 0) — nothing is pruned then, so recreate stays unbounded. */
export async function recreateRetentionCutoff(now: Date = new Date()): Promise<Date | null> {
  const row = await db.setting.findUnique({
    where: { key: 'retention_sync_logs_months' },
    select: { value: true },
  }).catch(() => null)
  return computeRetentionCutoff(resolveRetentionMonths(row?.value), now)
}

/** Prisma date filter for recreate's journaled-shipment/order queries: within the
 *  retention window when set ({ gte } also excludes nulls), else any non-null marker.
 *
 *  The cutoff stays EXACT here, deliberately (o3d-0qoo). Flooring it to UTC start-of-day —
 *  which is right for reconciliation SCANS — is dangerous for RECOVERY: sync-log retention
 *  purges against an exact `createdAt`, so a floored filter would include a batch-day stamp
 *  whose log has already been purged, find no live log, and re-queue an ALREADY POSTED
 *  journal. Duplicate journals are far worse than a boundary-day batch that recovery declines
 *  to recreate. This helper is also applied to `shipmentJournalDate`, which is a genuine
 *  wall-clock timestamp and must not be floored at all.
 *
 *  Recovering the boundary day safely needs day-aligned purging, or a durable exact batch
 *  reference per order — tracked on o3d-v7sy. */
export async function recreateJournaledDateFilter(now?: Date): Promise<{ gte: Date } | { not: null }> {
  const cutoff = await recreateRetentionCutoff(now)
  return cutoff ? { gte: cutoff } : { not: null }
}

/** Midnight UTC on the same day as `value`. Batch-day markers are stamped at exactly this. */
export function startOfUtcDay(value: Date): Date {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`)
}
