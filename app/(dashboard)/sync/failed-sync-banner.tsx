'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RetryAllFailedDialog } from './retry-all-failed-dialog'
import { accountingRetryDuplicateCaution } from '@/lib/domain/accounting/idempotency-retention'
import type { FailedAccountingSyncSummary } from '@/app/actions/accounting-sync'

const CONNECTOR_LABELS: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks' }

/**
 * audit-6vq0: a prominent admin alert when accounting sync rows have exhausted
 * their retries and gone FAILED. The sync-log table already lists them with
 * per-row + Retry-All controls; this surfaces the count at the top of the page
 * (next to the connector-orphan banner) so an admin notices without scrolling,
 * and offers a "Retry all failed" (behind a confirmation dialog).
 */
export function FailedSyncBanner({ summary }: { summary: FailedAccountingSyncSummary }) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // The server summary is the source of truth: router.refresh() re-fetches it
  // after a retry, so the banner hides (or shows the remainder) on its own.
  if (summary.failedCount === 0) return null
  const connectorLabel = summary.connector ? (CONNECTOR_LABELS[summary.connector] ?? summary.connector) : 'the accounting connector'
  // o3d-wahn: the connector's idempotency key does NOT protect this button. Xero keeps one for six
  // minutes and a row is only FAILED after its automatic retries are exhausted, so by the time this
  // control exists the key has expired and a re-post is a new request. Stated here rather than
  // enforced, because refusing every aged row would remove the only remedy the operator has.
  const duplicateCaution = accountingRetryDuplicateCaution(summary.connector)

  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-2 min-w-0">
          <p className="font-medium">
            {summary.failedCount} accounting sync row(s) failed after exhausting retries on {connectorLabel}.
            They will not post to the ledger until re-queued. Review the errors in the sync log below, then
            re-queue them once the cause is resolved.
          </p>
          {duplicateCaution && <p className="text-xs">{duplicateCaution}</p>}
          {message && <p className="text-xs" role="alert">{message}</p>}
          <Button variant="outline" size="sm" onClick={() => { setMessage(null); setDialogOpen(true) }}>
            <RotateCcw className="h-3 w-3 mr-1" />
            Retry all failed…
          </Button>
          <RetryAllFailedDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            connector={summary.connector}
            onDone={(text) => { setMessage(text); router.refresh() }}
          />
        </div>
      </div>
    </div>
  )
}
