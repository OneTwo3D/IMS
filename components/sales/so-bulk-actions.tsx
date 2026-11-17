'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Printer, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { bulkAdvanceSalesOrders, bulkAllocateSalesOrders } from '@/app/actions/sales-bulk'
import { BULK_ORDER_CAP, type BulkRowOutcome, type BulkRunResult } from '@/lib/domain/sales/bulk-actions'

const OUTCOME_LABEL: Record<BulkRowOutcome, string> = { done: 'Done', skipped: 'Skipped', failed: 'Failed' }
const OUTCOME_CLASS: Record<BulkRowOutcome, string> = {
  done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

type Panel = { title: string; result: BulkRunResult }

/**
 * The selection bar of the sales-order list: the count, the three bulk actions and the per-order
 * result panel. The server actions do the work (one order at a time); this only drives them.
 */
export function SoBulkActionBar({ selectedIds, onClear }: { selectedIds: string[]; onClear: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [panel, setPanel] = useState<Panel | null>(null)
  const count = selectedIds.length
  const overCap = count > BULK_ORDER_CAP

  function run(title: string, action: (ids: string[]) => Promise<BulkRunResult>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return
    setPanel(null)
    startTransition(async () => {
      try {
        const result = await action(selectedIds)
        setPanel({ title, result })
        if (result.ok) router.refresh()
      } catch {
        setPanel({ title, result: { ok: false, error: 'The bulk action could not be completed. Refresh the list to see which orders changed, then try again.' } })
      }
    })
  }

  function printSlips() {
    window.open(`/api/packing-slips?ids=${selectedIds.map(encodeURIComponent).join(',')}`, '_blank')
  }

  return (
    <div className="space-y-2">
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2" role="region" aria-label="Bulk actions">
          <span className="text-sm font-medium" aria-live="polite">{count} selected</span>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={isPending || overCap} onClick={() => run('Allocate stock', bulkAllocateSalesOrders)}>
            Allocate
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={isPending || overCap}
            onClick={() => run('Advance status', bulkAdvanceSalesOrders, `Move ${count} selected order${count === 1 ? '' : 's'} one step forward? Orders that cannot advance are skipped and reported.`)}
          >
            Advance status
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={isPending || overCap} onClick={printSlips}>
            <Printer className="h-3.5 w-3.5 mr-1" />
            Print packing slips
          </Button>
          {isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Running" />}
          {overCap && <span className="text-xs text-destructive">At most {BULK_ORDER_CAP} orders at a time.</span>}
          <Button size="sm" variant="ghost" className="ml-auto h-8 text-xs" disabled={isPending} onClick={onClear}>Clear selection</Button>
        </div>
      )}
      {panel && <ResultPanel panel={panel} onDismiss={() => setPanel(null)} />}
    </div>
  )
}

function ResultPanel({ panel, onDismiss }: { panel: Panel; onDismiss: () => void }) {
  const { result } = panel
  return (
    <div className="rounded-md border bg-card p-3 text-sm" role="status">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">
          {panel.title}
          {result.ok && `: ${result.counts.done} done, ${result.counts.skipped} skipped, ${result.counts.failed} failed`}
        </p>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onDismiss} aria-label="Dismiss results"><X className="h-4 w-4" /></Button>
      </div>
      {!result.ok ? (
        <p className="mt-1 text-destructive">{result.error}</p>
      ) : (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {result.results.map((r) => (
            <li key={r.id} className="flex items-start gap-2">
              <span className={`mt-0.5 inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_CLASS[r.outcome]}`}>{OUTCOME_LABEL[r.outcome]}</span>
              <span className="font-mono text-xs pt-0.5">{r.orderNumber}</span>
              <span className="text-xs text-muted-foreground pt-0.5">{r.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
