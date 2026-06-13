'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cancelOrphanedAccountingSyncRows } from '@/app/actions/accounting-sync'
import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'

const CONNECTOR_LABELS: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks' }

function connectorLabel(connector: string): string {
  return CONNECTOR_LABELS[connector] ?? connector
}

/**
 * audit-H4: warns when PENDING/PROCESSING accounting sync rows belong to a
 * connector that is no longer active (stranded by a connector switch). Lets the
 * operator bulk-cancel them so they stop accumulating silently.
 */
export function ConnectorOrphanBanner({ summary }: { summary: ConnectorOrphanSummary }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The server summary is the source of truth: router.refresh() re-fetches it
  // after a cancel, so the banner hides (or shows the remainder) on its own.
  if (summary.totalOrphans === 0) return null

  function handleCancel(connector?: string) {
    setError(null)
    startTransition(async () => {
      const result = await cancelOrphanedAccountingSyncRows(connector)
      if (result.success) {
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
          <p className="font-medium">
            {summary.totalOrphans} accounting sync row(s) are queued for a connector that is no longer active
            {summary.activeConnector ? ` (active: ${connectorLabel(summary.activeConnector)})` : ' (no accounting connector is enabled)'}.
            They will not be processed while that connector is inactive. Re-enable the connector to let them resume,
            or cancel them below to permanently discard them. (Cancelling does not stop the document itself from
            syncing to the active connector later.)
          </p>
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
        </div>
      </div>
    </div>
  )
}
