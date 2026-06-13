'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { retryFailedAccountingSync } from '@/app/actions/accounting-sync'
import type { FailedAccountingSyncSummary } from '@/app/actions/accounting-sync'

const CONNECTOR_LABELS: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks' }

/**
 * audit-6vq0: a prominent admin alert when accounting sync rows have exhausted
 * their retries and gone FAILED. The sync-log table already lists them with
 * per-row + Retry-All controls; this surfaces the count at the top of the page
 * (next to the connector-orphan banner) so an admin notices without scrolling,
 * and offers a one-click "Retry all failed".
 */
export function FailedSyncBanner({ summary }: { summary: FailedAccountingSyncSummary }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  // The server summary is the source of truth: router.refresh() re-fetches it
  // after a retry, so the banner hides (or shows the remainder) on its own.
  if (summary.failedCount === 0) return null
  const connectorLabel = summary.connector ? (CONNECTOR_LABELS[summary.connector] ?? summary.connector) : 'the accounting connector'

  function retryAll() {
    setMessage(null)
    startTransition(async () => {
      const res = await retryFailedAccountingSync()
      if (res.success) {
        setMessage(`Re-queued ${res.reset} failed row(s) — they will retry on the next sync.`)
        router.refresh()
      } else {
        setMessage(res.error ?? 'Failed to re-queue the failed rows.')
      }
    })
  }

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
          {message && <p className="text-xs" role="alert">{message}</p>}
          <Button variant="outline" size="sm" onClick={retryAll} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RotateCcw className="h-3 w-3 mr-1" />}
            Retry all failed
          </Button>
        </div>
      </div>
    </div>
  )
}
