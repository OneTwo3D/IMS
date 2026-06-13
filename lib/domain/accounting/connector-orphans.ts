// ---------------------------------------------------------------------------
// Cross-connector orphaned sync rows (audit-H4)
//
// AccountingSyncLog rows are stamped with their connector at queue time. When
// the active accounting connector is switched (e.g. Xero → QuickBooks), any
// PENDING/PROCESSING rows for the OUTGOING connector become invisible to both
// processors (each only claims rows for its own connector) — they accumulate
// silently forever. This module classifies those orphans so the sync dashboard
// can surface them and offer a bulk-cancel. Pure functions over plain rows.
// ---------------------------------------------------------------------------

export type AccountingConnectorId = 'xero' | 'quickbooks'

/** Per-connector count of live (PENDING/PROCESSING) sync rows — the shape a Prisma groupBy yields. */
export type ConnectorLiveCount = { connector: string; count: number }

export type ConnectorOrphanGroup = { connector: string; count: number }

export type ConnectorOrphanSummary = {
  /** The currently active connector (null when no accounting plugin is enabled). */
  activeConnector: AccountingConnectorId | null
  /** Per-connector counts of live rows that DON'T belong to the active connector. */
  orphanGroups: ConnectorOrphanGroup[]
  /** Total orphaned live rows across all non-active connectors. */
  totalOrphans: number
}

/**
 * From per-connector live-row counts, keep only those whose connector differs
 * from the active connector. When no connector is active, every live row is an
 * orphan (nothing will ever process them).
 */
export function summarizeCrossConnectorOrphans(
  liveCounts: ConnectorLiveCount[],
  activeConnector: AccountingConnectorId | null,
): ConnectorOrphanSummary {
  const orphanGroups = liveCounts
    .filter((group) => group.count > 0 && !(activeConnector && group.connector === activeConnector))
    .map((group) => ({ connector: group.connector, count: group.count }))
    .sort((a, b) => (a.connector < b.connector ? -1 : a.connector > b.connector ? 1 : 0))
  return {
    activeConnector,
    orphanGroups,
    totalOrphans: orphanGroups.reduce((sum, group) => sum + group.count, 0),
  }
}
