'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  getStockCountProductCategories,
  searchStockCountProducts,
  type StockCountProductRow,
} from '@/app/actions/stock-counts'
import { mergeSelection, type ProductStateFilter } from '@/lib/domain/inventory/stock-count-plan'

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'SIMPLE', label: 'Simple' },
  { value: 'VARIANT', label: 'Variant' },
  { value: 'BOM', label: 'Manufactured' },
]

/**
 * The selection window for a stock count's product list. Picks are held by product id, so they survive any change of
 * search text or filters. A product already on the count (`countId`) is marked and cannot be picked; the server
 * refuses a duplicate as well.
 */
export function ProductPickerDialog({
  title, confirmLabel, warehouseId, countId, onClose, onConfirm, busy = false, error = null,
}: {
  title: string
  confirmLabel: string
  warehouseId: string
  countId?: string
  onClose: () => void
  onConfirm: (productIds: string[]) => void
  busy?: boolean
  error?: string | null
}) {
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [state, setState] = useState<ProductStateFilter>('OPERATIONAL')
  const [categoryId, setCategoryId] = useState('')
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [rows, setRows] = useState<StockCountProductRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // Picked products, by id: held here, not derived from the rows, so they survive any search or filter change.
  const [picked, setPicked] = useState<string[]>([])
  const requestSeq = useRef(0)

  useEffect(() => { void getStockCountProductCategories().then(setCategories).catch(() => setCategories([])) }, [])

  useEffect(() => {
    const seq = ++requestSeq.current
    const handle = setTimeout(() => {
      setLoading(true)
      void searchStockCountProducts({ warehouseId, countId, query, types, state, categoryId: categoryId || null })
        .then((res) => {
          if (seq !== requestSeq.current) return // a newer search superseded this one
          setSearchError(res.message ?? null)
          setRows(res.rows)
          setTotal(res.total)
        })
        .catch(() => { if (seq === requestSeq.current) setSearchError('The product search failed. Try again.') })
        .finally(() => { if (seq === requestSeq.current) setLoading(false) })
    }, 250)
    return () => clearTimeout(handle)
  }, [warehouseId, countId, query, types, state, categoryId])

  const selectable = rows.filter((r) => !r.inCount)
  const allShownPicked = selectable.length > 0 && selectable.every((r) => picked.includes(r.id))

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? mergeSelection(cur, [], [id]) : mergeSelection(cur, [id], [])))
  }
  function toggleAllShown() {
    const ids = selectable.map((r) => r.id)
    setPicked((cur) => (allShownPicked ? mergeSelection(cur, [], ids) : mergeSelection(cur, ids, [])))
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input className="flex-1 min-w-48" placeholder="Search by product name or SKU" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
            <Select value={state} onChange={(e) => setState(e.target.value as ProductStateFilter)} className="w-40" aria-label="Product state">
              <option value="OPERATIONAL">Active products</option>
              <option value="ARCHIVED">Archived products</option>
              <option value="ALL">Active and archived</option>
            </Select>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-44" aria-label="Category">
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted-foreground">Product type</span>
            {TYPE_OPTIONS.map((t) => (
              <label key={t.value} className="flex items-center gap-1">
                <input type="checkbox" checked={types.includes(t.value)} onChange={() => setTypes((cur) => (cur.includes(t.value) ? cur.filter((x) => x !== t.value) : [...cur, t.value]))} />
                {t.label}
              </label>
            ))}
          </div>

          {searchError && <p className="text-sm text-destructive">{searchError}</p>}
          <div className="border border-border rounded-md overflow-auto max-h-[340px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 w-8">
                    <input type="checkbox" aria-label="Select all shown" checked={allShownPicked} disabled={selectable.length === 0} onChange={toggleAllShown} />
                  </th>
                  <th className="px-3 py-1.5">SKU</th>
                  <th className="px-3 py-1.5">Name</th>
                  <th className="px-3 py-1.5">Category</th>
                  <th className="px-3 py-1.5 text-right">On hand</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t border-border/50 ${r.inCount ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-1">
                      <input type="checkbox" aria-label={`Select ${r.sku}`} checked={r.inCount || picked.includes(r.id)} disabled={r.inCount} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="px-3 py-1 font-mono text-xs">{r.sku}</td>
                    <td className="px-3 py-1">
                      {r.name}
                      {r.inCount && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Already on this count</span>}
                      {r.lifecycleStatus === 'ARCHIVED' && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>}
                    </td>
                    <td className="px-3 py-1 text-xs text-muted-foreground">{r.categoryName ?? '—'}</td>
                    <td className="px-3 py-1 text-right font-mono text-xs">{r.onHand}</td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">No products match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            Showing {rows.length} of {total} matching products{total > rows.length ? '. Narrow the search to see the rest.' : '.'}
            Your picks are kept while you search and filter.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-sm">{picked.length} selected</span>
          {picked.length > 0 && <Button variant="ghost" size="sm" onClick={() => setPicked([])} disabled={busy}>Clear picks</Button>}
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => onConfirm(picked)} disabled={busy || picked.length === 0}>{busy ? 'Working…' : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
