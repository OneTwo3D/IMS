'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Hammer, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createReorderPOs, createReorderMOs, type ReorderActionFilters } from '@/app/actions/forecasting'

/**
 * Bulk-generate draft POs + MOs for every row currently visible in the
 * Reorder Planning report. The operator scopes via the existing filters
 * (supplier, category, warehouse, product type) — whatever the filters
 * leave on the page is what the buttons act on.
 *
 * Splits selection by productType: BOM rows route to createReorderMOs
 * (one draft Manufacturing Order per product), non-BOM rows route to
 * createReorderPOs (grouped into one draft Purchase Order per supplier).
 */
export function ReorderActionsToolbar({
  rows,
  filters,
}: {
  rows: Array<{ productId: string; productType: string }>
  filters: ReorderActionFilters
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string>('')

  const purchasedIds = rows.filter((r) => r.productType !== 'BOM').map((r) => r.productId)
  const bomIds = rows.filter((r) => r.productType === 'BOM').map((r) => r.productId)
  const hasRows = purchasedIds.length > 0 || bomIds.length > 0

  const handleGenerate = () => {
    setMessage('')
    startTransition(async () => {
      const parts: string[] = []
      try {
        if (purchasedIds.length > 0) {
          const result = await createReorderPOs(purchasedIds, { filters })
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
        if (bomIds.length > 0) {
          const result = await createReorderMOs(bomIds, { filters })
          const skipped = result.skipped ?? []
          const skipNote = result.success && skipped.length > 0
            ? ` (skipped ${skipped.length}: ${skipped.map((s) => `${s.sku} — ${s.reason.replace(/_/g, ' ')}`).join(', ')})`
            : ''
          parts.push(result.success
            ? `${result.moCount} draft MO${result.moCount === 1 ? '' : 's'}${skipNote}`
            : `MO generation failed: ${result.error ?? 'unknown error'}`)
        }
        setMessage(parts.length > 0 ? `Created ${parts.join(' · ')}` : 'Nothing to generate')
        router.refresh()
      } catch (error) {
        setMessage(`Generation failed: ${String(error)}`)
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3 text-sm">
      <span className="text-muted-foreground">
        {hasRows
          ? `${rows.length} rows in current view — ${purchasedIds.length} purchased, ${bomIds.length} manufactured`
          : 'No rows match the current filters'}
      </span>
      <Button
        size="sm"
        className="ml-auto"
        onClick={handleGenerate}
        disabled={pending || !hasRows}
      >
        <ShoppingCart className="mr-1 h-4 w-4" />
        <Hammer className="mr-2 h-4 w-4" />
        {pending ? 'Generating…' : 'Generate POs + draft MOs for visible rows'}
      </Button>
      {message && <span className="w-full text-xs text-muted-foreground">{message}</span>}
    </div>
  )
}
