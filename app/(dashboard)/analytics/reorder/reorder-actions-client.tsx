'use client'

import { useCallback, useEffect, useMemo, useRef, useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Hammer, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useReorderSelection } from '@/lib/analytics/reorder-selection-context'
import { sumSelectedField } from '@/lib/analytics/reorder-selection'
import { createReorderPOs, createReorderMOs, type ReorderActionFilters } from '@/app/actions/forecasting'

type ReorderToolbarRow = { productId: string; productType: string; suggestedReorderQty: number }

const isBom = (productType: string) => productType === 'BOM'

function splitIds(subset: readonly ReorderToolbarRow[]): { purchasedIds: string[]; bomIds: string[] } {
  return {
    purchasedIds: subset.filter((r) => !isBom(r.productType)).map((r) => r.productId),
    bomIds: subset.filter((r) => isBom(r.productType)).map((r) => r.productId),
  }
}

// Don't fire shortcuts while the operator is interacting with a form/interactive
// control (typing in a filter, or focused on a button/link/checkbox that already
// handles the key) — avoids hijacking text entry and double-firing generate.
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || tag === 'BUTTON' || tag === 'A'
    || target.isContentEditable || target.getAttribute('role') === 'button'
}

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
  rows: ReorderToolbarRow[]
  filters: ReorderActionFilters
}) {
  const router = useRouter()
  const { selected, selectedVisibleCount, toggleAll, clear, clearedByNavigationAt } = useReorderSelection()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string>('')
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)
  const [dismissedClearCount, setDismissedClearCount] = useState(0)
  const navNotice = clearedByNavigationAt > dismissedClearCount

  const hasSelection = selectedVisibleCount > 0
  // Act on the ticked rows when there's a selection, otherwise on every visible row.
  const { purchasedIds, bomIds } = useMemo(
    () => splitIds(hasSelection ? rows.filter((r) => selected.has(r.productId)) : rows),
    [rows, selected, hasSelection],
  )
  const hasVisibleRows = rows.length > 0
  const selectedQtyTotal = useMemo(
    () => sumSelectedField(rows, selected, (r) => r.suggestedReorderQty),
    [rows, selected],
  )

  // Synchronous re-entry guard so a second Enter (which bypasses the button's
  // disabled state) can't submit a duplicate generation while one is in flight.
  const inFlightRef = useRef(false)

  const runGeneration = useCallback((purchased: string[], bom: string[]) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
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
      } finally {
        inFlightRef.current = false
      }
    })
  }, [filters, clear, router, startTransition])

  const handleClick = useCallback(() => {
    if (hasSelection) {
      runGeneration(purchasedIds, bomIds)
    } else {
      // Act-on-all fallback — confirm first so a full-page generate is deliberate.
      setConfirmAllOpen(true)
    }
  }, [hasSelection, runGeneration, purchasedIds, bomIds])

  const confirmActOnAll = () => {
    setConfirmAllOpen(false)
    const all = splitIds(rows)
    runGeneration(all.purchasedIds, all.bomIds)
  }

  // Latest-ref so the once-bound keydown listener always calls the current
  // handler without closing over stale selection state.
  const handleClickRef = useRef(handleClick)
  useEffect(() => { handleClickRef.current = handleClick }, [handleClick])

  // Keyboard shortcuts: `a` toggles all visible rows, `Enter` runs generate
  // (which opens the act-on-all confirm when nothing is selected). Ignored while
  // focused on a form/interactive control or with a modifier held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Let the confirm dialog own the keyboard while it's open.
      if (confirmAllOpen || e.metaKey || e.ctrlKey || e.altKey || isInteractiveTarget(e.target)) return
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        toggleAll()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleClickRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleAll, confirmAllOpen])

  // Auto-dismiss the "selection cleared" notice ~4s after it appears. Visibility
  // is derived (navNotice); the effect only sets state inside the timer callback.
  useEffect(() => {
    if (!navNotice) return
    const timer = setTimeout(() => setDismissedClearCount(clearedByNavigationAt), 4000)
    return () => clearTimeout(timer)
  }, [navNotice, clearedByNavigationAt])

  const summary = hasSelection
    ? `${selectedVisibleCount} selected — ${purchasedIds.length} purchased, ${bomIds.length} manufactured · Σ suggested qty ${selectedQtyTotal.toLocaleString()}`
    : hasVisibleRows
      ? `${rows.length} rows in current view — tick rows to scope, or generate for all visible`
      : 'No rows match the current filters'

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3 text-sm">
      <span className="text-muted-foreground">{summary}</span>
      <span className="hidden text-[11px] text-muted-foreground/70 sm:inline" aria-hidden>
        <kbd className="rounded border px-1">a</kbd> all · <kbd className="rounded border px-1">↵</kbd> generate
      </span>
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
      {navNotice && (
        <span className="w-full text-xs text-amber-700" role="status">Selection cleared on filter / page change.</span>
      )}
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
