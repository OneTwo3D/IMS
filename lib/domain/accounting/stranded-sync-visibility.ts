import type { ConnectorOrphanSummary } from './connector-orphans'

/**
 * o3d-osl8 item 1 — the VISIBILITY decisions for stranded accounting sync rows, as pure
 * functions.
 *
 * WHY THIS MODULE EXISTS. The stranded-row list lives on the Integrations page, and the two
 * decisions that determine whether an operator ever sees it were previously expressed only
 * inside `app/(dashboard)/sync/page.tsx` and `connector-orphan-banner.tsx`. This repo has no
 * React render harness (there is not a single .tsx file under tests/), so logic living in a
 * component is logic that no test can reach: the wiring could be reverted wholesale and every
 * test would stay green. Both decisions are therefore extracted here and unit-tested the way
 * connector-orphans.ts and stranded-sync-rows.ts are, with the components kept as thin wrappers
 * that render what these functions return.
 */

// ---------------------------------------------------------------------------
// Decision 1 — should the Integrations page redirect away?
// ---------------------------------------------------------------------------

export type SyncPageRedirectInput = {
  /** True when ANY integration plugin (shopping / accounting / WMS) is enabled. */
  anyIntegrationPluginEnabled: boolean
  /** Whether this session holds `sync` — the permission that gates the stranded-row read. */
  hasSyncPermission: boolean
  /** Whether the stranded-row read found at least one row. Must be false when it was not read. */
  strandedRowsExist: boolean
  /**
   * The stranded-row read FAILED, so whether rows exist is unknown. Distinct from
   * `strandedRowsExist: false`: redirecting on a failed read would make a failure
   * indistinguishable from "nothing is stranded", which is the exact blind spot this feature
   * exists to close.
   */
  strandedRowsUnknown: boolean
}

/**
 * The Integrations page sends an operator to the plugin settings when no integration is enabled
 * — there is nothing to configure otherwise.
 *
 * EXCEPT in the one state this feature exists for. When the last enabled plugin was the
 * accounting connector that stranded rows belong to, `activeConnector` is null and — by this
 * feature's own rule (buildStrandedSyncRowWhere(null)) — EVERY unresolved accounting row is
 * stranded. Redirecting first meant the only page that can show those rows was unreachable in
 * precisely the state that produces the most of them.
 *
 * The redirect is NOT weakened for any other reason: a session without `sync` never reads the
 * rows, and so redirects exactly as before.
 */
export function shouldRedirectFromSyncPage(input: SyncPageRedirectInput): boolean {
  if (input.anyIntegrationPluginEnabled) return false
  if (!input.hasSyncPermission) return true
  return !input.strandedRowsExist && !input.strandedRowsUnknown
}

// ---------------------------------------------------------------------------
// Decision 2 — should the connector-orphan banner render, and in which state?
// ---------------------------------------------------------------------------

export type ConnectorOrphanBannerInput = {
  /**
   * The aggregate orphan summary, or null when its fetch failed. Nullable on purpose: a failed
   * aggregate must not take the stranded list down with it.
   */
  summary: ConnectorOrphanSummary | null
  /** How many stranded rows were actually returned (already truncated to the page limit). */
  rowCount: number
  /** How many stranded rows exist in total. Only meaningful alongside `rowCount`. */
  totalStrandedRows: number
  /** True when more stranded rows exist than were returned. */
  hasMore: boolean
  /**
   * The stranded-row read FAILED. NOT the same as returning zero rows: falling back to the
   * count-only banner (or to nothing at all, when only inactive FAILED rows exist) would tell
   * the operator "there are none" when the truth is "we could not look".
   */
  loadFailed: boolean
}

export type ConnectorOrphanBannerState = {
  /** Render the banner at all. */
  render: boolean
  /** Show the aggregate count paragraph and the per-connector cancel controls. */
  showSummary: boolean
  /** Show the stranded-row table. */
  showRows: boolean
  /** Show the "could not be loaded" state — explicitly not "there are none". */
  showLoadFailure: boolean
  /** True when rows exist that are NOT in the table. */
  truncated: boolean
  /**
   * The sentence above the table. Never a bare count of what was returned: when the list is
   * truncated it says how many of how many are shown and how many are hidden, because a bare
   * "50 shown" reads as "50 exist".
   */
  rowsSummary: string | null
}

/**
 * The banner has three independent sources of content — the aggregate summary, the stranded-row
 * list, and the failure of that list to load — and it must render if ANY of them has something
 * to say. In particular a failed row read must render even when the summary is null or zero:
 * only FAILED rows on a retired connector are invisible to the summary (it counts PENDING /
 * PROCESSING only), so "summary says nothing + list failed" is the state where staying silent
 * loses the rows entirely.
 */
export function resolveConnectorOrphanBannerState(
  input: ConnectorOrphanBannerInput,
): ConnectorOrphanBannerState {
  const showSummary = (input.summary?.totalOrphans ?? 0) > 0
  const showRows = input.rowCount > 0
  const showLoadFailure = input.loadFailed
  // A truncated list whose reported total is stale/short must still read as truncated; the count
  // is a second query and can lag the page read.
  const effectiveTotal = Math.max(input.totalStrandedRows, input.rowCount + (input.hasMore ? 1 : 0))
  const hidden = effectiveTotal - input.rowCount
  const truncated = showRows && input.hasMore && hidden > 0
  return {
    render: showSummary || showRows || showLoadFailure,
    showSummary,
    showRows,
    showLoadFailure,
    truncated,
    rowsSummary: !showRows
      ? null
      : truncated
        ? `Showing the oldest ${input.rowCount} of ${effectiveTotal} stranded row(s) — ${hidden} more are not listed here.`
        : `Showing all ${input.rowCount} stranded row(s), oldest first.`,
  }
}
