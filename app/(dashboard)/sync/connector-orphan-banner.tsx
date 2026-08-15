'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cancelOrphanedAccountingSyncRows } from '@/app/actions/accounting-sync'
import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'
import type { StrandedSyncRowsResult } from '@/lib/domain/accounting/stranded-sync-rows'
import { resolveConnectorOrphanBannerState } from '@/lib/domain/accounting/stranded-sync-visibility'

const CONNECTOR_LABELS: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks' }

function connectorLabel(connector: string): string {
  return CONNECTOR_LABELS[connector] ?? connector
}

/**
 * audit-H4: warns when PENDING/PROCESSING accounting sync rows belong to a
 * connector that is no longer active (stranded by a connector switch). Lets the
 * operator bulk-cancel them so they stop accumulating silently.
 */
export function ConnectorOrphanBanner({
  summary,
  stranded = null,
  strandedLoadFailed = false,
}: {
  /**
   * NULLABLE on purpose. getCrossConnectorOrphanSummary() is fetched with .catch(() => null),
   * so a failure there must not take the stranded list down with it: those rows are the only
   * view of work stranded on a retired connector (o3d-osl8), and hiding them because an
   * unrelated aggregate query failed would silently remove the remedy this banner exists for.
   * When it is null the count paragraph and the per-connector cancel controls are simply absent
   * — there is no trustworthy total to act on — and the stranded list still renders.
   */
  summary: ConnectorOrphanSummary | null
  /**
   * o3d-osl8 item 1: the rows BEHIND the count. Every accounting log view is scoped to the
   * ACTIVE connector, so a row left on a retired one was previously visible only as the integer
   * above — and o3d-osl8 is explicit that "Do NOT present an aggregate count as a remedy" was
   * the specific criticism. Listing them with connector / type / reference / status / age / last
   * error is what makes them actionable at all.
   *
   * Read-only: there is no per-row control here, because there is no per-row remedy anywhere
   * yet (o3d-e2mz). Null for a role without the `sync` permission — the page does not fetch it —
   * and also null when the fetch FAILED, which `strandedLoadFailed` distinguishes.
   *
   * Carries `hasMore` / `total` because the list is truncated to the oldest N and nothing here
   * can clear the rows at the front of it.
   */
  stranded?: StrandedSyncRowsResult | null
  /**
   * The stranded-row read failed. Rendered as an explicit failure, NOT as an empty list: "we
   * could not look" and "there is nothing there" are opposite messages for the operator.
   */
  strandedLoadFailed?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  /**
   * o3d-sref: rows the cancel could not retire, because their claim had already been taken and a
   * request may have reached the connector. Shown HERE rather than only in the activity log — the
   * orphan count will not fall to zero for those rows, and a button that visibly does nothing with
   * no explanation reads as broken.
   */
  const [notice, setNotice] = useState<string | null>(null)

  // Every "is there anything to show" decision is the pure resolver's, so all of them can be
  // enumerated in one place rather than reached one page-state at a time.
  // The server summary is the source of truth: router.refresh() re-fetches it after a cancel, so
  // the banner hides (or shows the remainder) on its own.
  const strandedRows = stranded?.rows ?? []
  const bannerState = resolveConnectorOrphanBannerState({
    summary,
    rowCount: strandedRows.length,
    totalStrandedRows: stranded?.total ?? 0,
    hasMore: stranded?.hasMore ?? false,
    loadFailed: strandedLoadFailed,
  })
  if (!bannerState.render) return null

  function handleCancel(connector?: string) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await cancelOrphanedAccountingSyncRows(connector)
      if (result.success) {
        const inFlight = result.inFlightNotCancelled ?? 0
        setNotice(inFlight > 0
          ? `${inFlight} row(s) could not be cancelled: their sync was already in flight when the `
            + `connector was switched off, so a request may have reached it and been lost. Check that `
            + `connector for the document(s) — these rows stay listed here, and continue to block `
            + `deleting their orders, until they are resolved.`
          : null)
        router.refresh()
      } else {
        setError(result.error ?? 'Failed to cancel orphaned rows.')
      }
    })
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-2">
          {bannerState.showSummary && summary && (
            <p className="font-medium">
              {summary.totalOrphans} accounting sync row(s) are queued for a connector that is no longer active
              {summary.activeConnector ? ` (active: ${connectorLabel(summary.activeConnector)})` : ' (no accounting connector is enabled)'}.
              They will not be processed while that connector is inactive. Re-enable the connector to let them resume,
              or cancel them below to permanently discard them. (Cancelling does not stop the document itself from
              syncing to the active connector later.)
            </p>
          )}
          <ul className="space-y-1 text-xs">
            {(summary?.orphanGroups ?? []).map((group) => (
              <li key={group.connector} className="flex items-center gap-2">
                <span><span className="font-medium">{connectorLabel(group.connector)}</span>: {group.count} row(s)</span>
                <Button size="sm" variant="outline" className="h-6 text-xs" disabled={pending} onClick={() => handleCancel(group.connector)}>
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel these'}
                </Button>
              </li>
            ))}
          </ul>
          {(summary?.orphanGroups.length ?? 0) > 1 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => handleCancel()}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel all orphaned rows'}
            </Button>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {notice && <p className="text-xs font-medium">{notice}</p>}
          {/* An explicit failure state. Silence here would read as "nothing is stranded", which
              is the opposite of what a failed read means. */}
          {bannerState.showLoadFailure && (
            <p className="text-xs font-medium text-destructive">
              The list of stranded sync rows could not be loaded, so it is not shown below. This does NOT mean there
              are none — any count above excludes rows that already failed, and those appear in no other view.
              Reload this page to try again.
            </p>
          )}
          {bannerState.showRows && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium">
                The rows themselves. {bannerState.rowsSummary} These do not appear in the sync log
                below — it only ever shows the ACTIVE connector. A stuck row keeps its order from being deleted, so
                each one needs either its connector re-enabling (which lets it resume) or the document checking in
                the accounting system it was queued for.
                {bannerState.truncated && ' The hidden rows stay hidden until the ones listed here are resolved.'}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-left opacity-70">
                    <tr>
                      <th className="pr-3 font-medium">Connector</th>
                      <th className="pr-3 font-medium">Type</th>
                      <th className="pr-3 font-medium">Reference</th>
                      <th className="pr-3 font-medium">Status</th>
                      <th className="pr-3 font-medium">Age</th>
                      <th className="font-medium">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strandedRows.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="pr-3 py-0.5">{connectorLabel(row.connector)}</td>
                        <td className="pr-3 py-0.5 font-mono">{row.type.replace(/_/g, ' ')}</td>
                        <td className="pr-3 py-0.5 font-mono">
                          {row.referenceType}:{row.referenceId}
                          {/*
                            A stranded row that already carries an external id posted SOMETHING to
                            that connector before it stalled — the operator needs that token to find
                            the document, so it is shown rather than hidden behind the status.
                          */}
                          {row.externalTransactionId && (
                            <div className="opacity-70">posted as {row.externalTransactionId}</div>
                          )}
                        </td>
                        <td className="pr-3 py-0.5">{row.status}</td>
                        <td className="pr-3 py-0.5 whitespace-nowrap">{row.ageDays}d</td>
                        <td className="py-0.5 max-w-[24rem] break-words opacity-80">{row.errorMessage ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
