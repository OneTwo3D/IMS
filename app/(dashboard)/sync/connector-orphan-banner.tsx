'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cancelOrphanedAccountingSyncRows } from '@/app/actions/accounting-sync'
import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'
import type { StrandedSyncRow } from '@/lib/domain/accounting/sync-row-settlement'
import { SettleSyncRowControl } from './settle-sync-row-control'

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
  stranded = [],
}: {
  summary: ConnectorOrphanSummary
  /**
   * o3d-osl8 item 1: the rows BEHIND the count. Every accounting log view is scoped to the
   * ACTIVE connector, so a row left on a retired one was previously visible only as the integer
   * above — and o3d-osl8 is explicit that "Do NOT present an aggregate count as a remedy" was
   * the specific criticism. Listing them with connector / type / reference / age is what makes
   * them actionable at all.
   */
  stranded?: StrandedSyncRow[]
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

  // The server summary is the source of truth: router.refresh() re-fetches it
  // after a cancel, so the banner hides (or shows the remainder) on its own.
  // The stranded list is checked too: it also covers FAILED rows on a retired connector, which
  // the PENDING/PROCESSING orphan count never counted and nothing else ever showed.
  if (summary.totalOrphans === 0 && stranded.length === 0) return null

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
          {summary.totalOrphans > 0 && (
            <p className="font-medium">
              {summary.totalOrphans} accounting sync row(s) are queued for a connector that is no longer active
              {summary.activeConnector ? ` (active: ${connectorLabel(summary.activeConnector)})` : ' (no accounting connector is enabled)'}.
              They will not be processed while that connector is inactive. Re-enable the connector to let them resume,
              or cancel them below to permanently discard them. (Cancelling does not stop the document itself from
              syncing to the active connector later.)
            </p>
          )}
          <ul className="space-y-1 text-xs">
            {summary.orphanGroups.map((group) => (
              <li key={group.connector} className="flex items-center gap-2">
                <span><span className="font-medium">{connectorLabel(group.connector)}</span>: {group.count} row(s)</span>
                <Button size="sm" variant="outline" className="h-6 text-xs" disabled={pending} onClick={() => handleCancel(group.connector)}>
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel these'}
                </Button>
              </li>
            ))}
          </ul>
          {summary.orphanGroups.length > 1 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => handleCancel()}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel all orphaned rows'}
            </Button>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {notice && <p className="text-xs font-medium">{notice}</p>}
          {stranded.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium">
                The rows themselves ({stranded.length} shown, oldest first). These are not visible in the sync log
                below — it only ever shows the ACTIVE connector. A stuck row keeps its order from being deleted, so
                each one needs either the connector re-enabling or a settlement: check the accounting system and
                record what is actually there.
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
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {stranded.map((row) => (
                      <tr key={row.id} className="align-middle">
                        <td className="pr-3 py-0.5">{connectorLabel(row.connector)}</td>
                        <td className="pr-3 py-0.5 font-mono">{row.type.replace(/_/g, ' ')}</td>
                        <td className="pr-3 py-0.5 font-mono">{row.referenceType}:{row.referenceId.slice(0, 8)}</td>
                        <td className="pr-3 py-0.5">{row.status}</td>
                        <td className="pr-3 py-0.5">{row.ageDays}d</td>
                        <td className="py-0.5">
                          {/*
                            Only FAILED, non-daily-batch rows can be settled. The others are still LISTED —
                            being visible is the whole of o3d-osl8 item 1 and does not depend on being
                            fixable from here — but they carry the reason instead of a control:
                              PENDING     nothing was sent, so there is nothing to assert; the sweeps own it.
                              PROCESSING  the claim may still be in flight and nothing can prove otherwise
                                          until it carries a generation (o3d-osl8).
                              DAILY_BATCH cancelling one races the batch recreator against the delete guard.
                            An omitted control with no explanation reads as "this row is fine", which is the
                            opposite of true.
                          */}
                          {row.settleable ? (
                            <SettleSyncRowControl
                              syncLogId={row.id}
                              status={row.status}
                              type={row.type}
                              referenceType={row.referenceType}
                              referenceId={row.referenceId}
                              onSettled={() => router.refresh()}
                            />
                          ) : (
                            <span className="cursor-help opacity-60" title={row.notSettleableReason ?? ''}>
                              not settleable
                            </span>
                          )}
                        </td>
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
