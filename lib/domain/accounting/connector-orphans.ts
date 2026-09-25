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

// o3d-remove-parked-connectors: this module DECLARED its own `AccountingConnectorId`, shadowing the
// registry's with an identical-but-unlinked copy. It is re-exported from the registry instead, so the
// two cannot drift and every existing importer keeps the spelling it already uses.
//
// AND THE SURFACE THIS MODULE IS FOR IS NOW UNREACHABLE BY A CONNECTOR SWITCH. With one accounting
// connector registered there is no switch to strand rows, so `orphanGroups` can only be non-empty
// for a connector this build no longer ships — which is exactly the state a development database is
// in after this branch (rows stamped `quickbooks`). That is not a reason to delete it: the summary is
// how those rows become visible and cancellable, and a second ledger reinstates the original case.
// See docs/archive/quickbooks-connector-removal.md.
import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'

export type { AccountingConnectorId }

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
