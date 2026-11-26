'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useRenderSync } from '@/lib/react/use-render-sync'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { getFailedAccountingSyncSummary, retryFailedAccountingSync } from '@/app/actions/accounting-sync'
import { accountingRetryDuplicateCaution } from '@/lib/domain/accounting/idempotency-retention'

import { ACCOUNTING_CONNECTORS } from '@/lib/connectors/accounting-registry'

// Labels come from the registry; a historical row may name a connector this build no longer
// registers, which falls back to the raw id.
function registeredConnectorLabel(connector: string): string {
  return ACCOUNTING_CONNECTORS.find((def) => def.id === connector)?.label ?? connector
}

/** Outcome sentence shared by every "Retry all failed" button, so a partial refusal never reads as success. */
export function describeRetryAllOutcome(result: { reset: number; refused?: number }): string {
  return result.refused
    ? `Re-queued ${result.reset} failed row(s). ${result.refused} row(s) were NOT re-queued — `
      + 'each has a recorded reason in the sync warnings. Either retrying them could post a '
      + 'second payment (check the ledger before acting), or another entry for the same '
      + 'document is already queued and they can be retried after it finishes.'
    : `Re-queued ${result.reset} failed row(s) — they will retry on the next sync.`
}

/**
 * Confirmation for "Retry all failed". It asks the server for the exact number of FAILED rows when
 * it opens, says how many rows will be re-queued, repeats the duplicate-document caution as body
 * text, and requires the operator to tick that they checked the accounting system. The count is sent
 * back with the request and the server refuses if it has changed.
 */
export function RetryAllFailedDialog({
  open,
  onOpenChange,
  connector,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connector: string | null
  onDone: (message: string, success: boolean) => void
}) {
  const [rowIds, setRowIds] = useState<string[] | null>(null)
  const count = rowIds === null ? null : rowIds.length
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Each time the dialog opens, start from a clean slate (set in the render that opens it), then load the summary.
  useRenderSync([open], () => {
    if (open) {
      setRowIds(null)
      setLoadError(null)
      setError(null)
    }
  })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getFailedAccountingSyncSummary()
      .then((summary) => { if (!cancelled) setRowIds(summary.failedRowIds ?? []) })
      .catch(() => { if (!cancelled) setLoadError('Could not load the number of failed rows. Close this dialog and try again.') })
    return () => { cancelled = true }
  }, [open])

  const label = connector ? registeredConnectorLabel(connector) : 'the accounting system'
  const caution = accountingRetryDuplicateCaution(connector)

  async function confirm() {
    if (rowIds === null) return
    setPending(true)
    setError(null)
    try {
      const result = await retryFailedAccountingSync(undefined, undefined, { confirmed: true, rowIds })
      if (result.success) {
        onOpenChange(false)
        onDone(describeRetryAllOutcome(result), true)
      } else {
        setError(result.error ?? 'Failed to re-queue the failed rows.')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Retry all failed rows"
      destructive
      confirmLabel={count === null ? 'Retry all failed' : `Retry ${count} failed row${count === 1 ? '' : 's'}`}
      acknowledgement={`I have checked ${label} and none of these documents already exist there.`}
      pending={pending || (count === null && !loadError)}
      error={error ?? loadError}
      onConfirm={() => { void confirm() }}
      description={
        <>
          {count === null && !loadError ? (
            <p className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Counting failed rows…</p>
          ) : count !== null ? (
            <p>
              <strong>{count} failed row{count === 1 ? '' : 's'}</strong> on {label} will be put back in the queue
              and re-sent on the next sync. Rows the system recognises as unsafe to repeat are skipped and reported.
            </p>
          ) : null}
          {caution ? <p>{caution}</p> : null}
        </>
      }
    />
  )
}
