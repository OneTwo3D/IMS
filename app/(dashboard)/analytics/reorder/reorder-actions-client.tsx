'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Hammer, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useReorderSelection } from '@/lib/analytics/reorder-selection-context'
import { createReorderPOs, createReorderMOs, type ReorderActionFilters } from '@/app/actions/forecasting'

/**
 * Generate draft POs + MOs for the Reorder Planning report.
 *
 * When the operator has ticked rows, the buttons act on that selection.
 * With nothing selected, they fall back to "all visible rows" (scoped by the
 * existing filters) behind a confirmation modal naming the row count.
 *
 * Splits by productType: BOM rows route to createReorderMOs (one draft MO per
 * product), non-BOM rows route to createReorderPOs (grouped into one draft PO
 * per supplier).
 */
export function ReorderActionsToolbar({
  rows,
  filters,
}: {
  rows: Array<{ productId: string; productType: string }>
  filters: ReorderActionFilters
}) {
  const router = useRouter()
  const { selected, selectedVisibleCount, clear } = useReorderSelection()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string>('')
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)

  const isBom = (productType: string) => productType === 'BOM'
  const splitIds = (subset: typeof rows) => ({
    purchasedIds: subset.filter((r) => !isBom(r.productType)).map((r) => r.productId),
    bomIds: subset.filter((r) => isBom(r.productType)).map((r) => r.productId),
  })

  const hasSelection = selectedVisibleCount > 0
  const selectedRows = rows.filter((r) => selected.has(r.productId))
  // Act on the ticked rows when there's a selection, otherwise on every visible row.
  const { purchasedIds, bomIds } = splitIds(hasSelection ? selectedRows : rows)
  const hasVisibleRows = rows.length > 0

  const runGeneration = (purchased: string[], bom: string[]) => {
    setMessage('')
    startTransition(async () => {
      const parts: string[] = []
      try {
        if (purchased.length > 0) {
          const result = await createReorderPOs(purchased, { filters })
          const notes: string[] = []
          if (result.success && (result.skippedSupplierCount ?? 0) > 0) notes.push(`${result.skippedSupplierCount} supplier(s) with a recent draft`)
          const skippedProducts = result.skippedProducts ?? []
          if (result.success && skippedProducts.length > 0) {
            notes.push(`${skippedProducts.length} product(s): ${skippedProducts.map((s) => `${s.sku ?? s.productId} — ${s.reason.replace(/_/g, ' ')}`).join(', ')}`)
          }
          const skipNote = notes.length > 0 ? ` (skipped ${notes.join('; ')})` : ''
          parts.push(result.success
            ? `${result.poCount} draft PO${result.poCount === 1 ? '' : 's'}${skipNote}`
            : `PO generation failed: ${result.error ?? 'unknown error'}`)
        }
        if (bom.length > 0) {
          const result = await createReorderMOs(bom, { filters })
          const skipped = result.skipped ?? []
          const skipNote = result.success && skipped.length > 0
            ? ` (skipped ${skipped.length}: ${skipped.map((s) => `${s.sku} — ${s.reason.replace(/_/g, ' ')}`).join(', ')})`
            : ''
          parts.push(result.success
            ? `${result.moCount} draft MO${result.moCount === 1 ? '' : 's'}${skipNote}`
            : `MO generation failed: ${result.error ?? 'unknown error'}`)
        }
        setMessage(parts.length > 0 ? `Created ${parts.join(' · ')}` : 'Nothing to generate')
        clear()
        router.refresh()
      } catch (error) {
        setMessage(`Generation failed: ${String(error)}`)
      }
    })
  }

  const handleClick = () => {
    if (hasSelection) {
      runGeneration(purchasedIds, bomIds)
    } else {
      // Act-on-all fallback — confirm first so a full-page generate is deliberate.
      setConfirmAllOpen(true)
    }
  }

  const confirmActOnAll = () => {
    setConfirmAllOpen(false)
    const all = splitIds(rows)
    runGeneration(all.purchasedIds, all.bomIds)
  }

  const summary = hasSelection
    ? `${selectedVisibleCount} selected — ${purchasedIds.length} purchased, ${bomIds.length} manufactured`
    : hasVisibleRows
      ? `${rows.length} rows in current view — tick rows to scope, or generate for all visible`
      : 'No rows match the current filters'

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3 text-sm">
      <span className="text-muted-foreground">{summary}</span>
      <Button
        size="sm"
        className="ml-auto"
        onClick={handleClick}
        disabled={pending || !hasVisibleRows}
      >
        <ShoppingCart className="mr-1 h-4 w-4" />
        <Hammer className="mr-2 h-4 w-4" />
        {pending
          ? 'Generating…'
          : hasSelection
            ? 'Generate from selection'
            : 'Generate POs + draft MOs for all visible rows'}
      </Button>
      {message && <span className="w-full text-xs text-muted-foreground">{message}</span>}

      <Dialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate for all visible rows?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            No rows are selected. This will create draft POs and MOs for all{' '}
            <span className="font-medium text-foreground">{rows.length}</span> row{rows.length === 1 ? '' : 's'}{' '}
            currently shown (scoped by the active filters). Tick individual rows first to generate for a subset instead.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmAllOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={confirmActOnAll}>Generate for all {rows.length}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
