'use client'

import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, PackageSearch, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { bulkAdjustStock, type BulkAdjustLine } from '@/app/actions/stock'
import type { ProductRow } from '@/app/actions/products'
import type { AdjustmentReasonOption } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  warehouses: Warehouse[]
  products: ProductRow[]
  reasons: AdjustmentReasonOption[]
  onClose: () => void
}

// The dialog tracks lines by their own stable `key`; the wire-level lineId is
// derived from it at submit time (see handleSave), so it's omitted here. qty is held
// as a raw input string (qtyInput) so a half-typed value like "-" or "1." isn't
// coerced to 0 mid-type (vzlk-2b); it's parsed on save. note is a per-line free-text
// field (vzlk-2a).
type AdjLine = Omit<BulkAdjustLine, 'lineId' | 'qty' | 'note'> & {
  key: number
  productSku: string
  productName: string
  qtyInput: string
  note: string
}

export function BulkAdjustmentDialog({ warehouses, products, reasons, onClose }: Props) {
  const router = useRouter()
  const [lines, setLines] = useState<AdjLine[]>([])
  const [nextKey, setNextKey] = useState(0)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  // vzlk-2c: active option for keyboard navigation of the product-search combobox.
  const [activeIndex, setActiveIndex] = useState(-1)
  const listboxId = 'bulk-adjust-product-listbox'
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ success?: boolean; count?: number; message?: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // 0tr0: stable idempotency token for this bulk submission (see handleSave).
  const idempotencyTokenRef = useRef<string | null>(null)

  const defaultWarehouseId = warehouses[0]?.id ?? ''

  const searchResults = search.trim().length >= 1
    ? products
        .filter((p) =>
          p.sku.toLowerCase().includes(search.toLowerCase()) ||
          p.name.toLowerCase().includes(search.toLowerCase())
        )
        .filter((p) => !lines.some((l) => l.productId === p.id))
        .slice(0, 8)
    : []

  function addProduct(p: ProductRow) {
    setLines((prev) => [
      ...prev,
      { key: nextKey, productId: p.id, productSku: p.sku, productName: p.name, warehouseId: defaultWarehouseId, reasonId: reasons[0]?.id ?? '', qtyInput: '', note: '' },
    ])
    setNextKey((k) => k + 1)
    setSearch('')
    setActiveIndex(-1)
    searchRef.current?.focus()
  }

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    // Escape clears the search regardless of whether there are matches (also closes
    // the "No products found" state).
    if (e.key === 'Escape') {
      setActiveIndex(-1)
      setSearch('')
      return
    }
    if (searchResults.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % searchResults.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? searchResults.length - 1 : i - 1))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      addProduct(searchResults[activeIndex])
    }
  }

  function updateLine<K extends keyof AdjLine>(key: number, field: K, value: AdjLine[K]) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
  }

  async function handleSave() {
    // vzlk-2b: parse each line's raw qty string here; a non-numeric or zero draft is
    // simply not a valid adjustment line.
    const valid = lines
      .map((l) => ({ ...l, qty: Number(l.qtyInput) }))
      .filter((l) => Number.isFinite(l.qty) && l.qty !== 0)
    if (valid.length === 0) { setResult({ message: 'Enter a non-zero quantity for at least one product.' }); return }
    setSaving(true)
    setResult(null)
    // 0tr0: reuse a stable idempotency token across retries of this batch so the
    // server dedups a double-submit line-for-line; reset only on confirmed success.
    if (!idempotencyTokenRef.current) {
      idempotencyTokenRef.current = crypto.randomUUID()
    }
    const res = await bulkAdjustStock(
      // tllm: send each line's stable dialog key as lineId so the server keys it by a
      // retry-stable identity, not array position.
      valid.map(({ key, productId, warehouseId, reasonId, qty, unitCostBase, note }) => ({
        lineId: String(key), productId, warehouseId, reasonId, qty, unitCostBase,
        note: note.trim() || null,
      })),
      idempotencyTokenRef.current,
    )
    setSaving(false)
    setResult(res)
    if (res.success) {
      idempotencyTokenRef.current = null
      router.refresh()
      setTimeout(() => onClose(), 1000)
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New Stock Adjustment</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Product search */}
          <div className="space-y-1.5">
            <Label className="text-sm">Add Products</Label>
            <div className="relative">
              <Input
                ref={searchRef}
                placeholder="Search by SKU or name…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setActiveIndex(-1) }}
                onKeyDown={onSearchKeyDown}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                autoComplete="off"
                role="combobox"
                aria-expanded={searchFocused && searchResults.length > 0}
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeIndex >= 0 ? `bulk-adjust-opt-${searchResults[activeIndex]?.id}` : undefined}
              />
              {searchFocused && searchResults.length > 0 && (
                <div id={listboxId} role="listbox" aria-label="Product search results" className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg overflow-hidden">
                  {searchResults.map((p, i) => (
                    <button
                      key={p.id}
                      id={`bulk-adjust-opt-${p.id}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      type="button"
                      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-3 border-b border-border/50 last:border-0 ${i === activeIndex ? 'bg-muted' : 'hover:bg-muted'}`}
                      onMouseDown={() => addProduct(p)}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <span className="font-mono font-medium text-xs w-28 shrink-0 truncate">{p.sku}</span>
                      <span className="text-muted-foreground truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {searchFocused && search.trim().length >= 1 && searchResults.length === 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg px-3 py-2 text-sm text-muted-foreground">No products found.</div>
              )}
            </div>
          </div>

          {/* Lines table */}
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground gap-2">
              <PackageSearch className="h-8 w-8 opacity-30" />
              <p className="text-sm">Search for products above to add them to this adjustment.</p>
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-x-auto">
              <div className="min-w-[640px]">
              <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b border-border">
                <span>Product</span>
                <span>Warehouse</span>
                <span>Reason</span>
                <span>Note</span>
                <span className="w-28 text-right">Qty (+ / −)</span>
                <span className="w-24 text-right">Unit cost</span>
                <span className="w-8" />
              </div>
              {lines.map((line) => {
                const qtyNum = Number(line.qtyInput)
                return (
                <div key={line.key} className="grid grid-cols-[2fr_1fr_1fr_1.5fr_auto_auto_auto] gap-3 px-3 py-2.5 items-center border-b border-border/50 last:border-0 hover:bg-muted/20">
                  <div className="min-w-0">
                    <ProductLink productId={line.productId} sku={line.productSku} name={line.productName} />
                  </div>
                  <Select value={line.warehouseId} onChange={(e) => updateLine(line.key, 'warehouseId', e.target.value)} aria-label="Warehouse" className="h-8 text-xs">
                    {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
                  </Select>
                  {reasons.length > 0 ? (
                    <Select value={line.reasonId} onChange={(e) => updateLine(line.key, 'reasonId', e.target.value)} aria-label="Reason" className="h-8 text-xs">
                      <option value="">— No reason —</option>
                      {reasons.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                    </Select>
                  ) : (
                    <span className="text-xs text-muted-foreground italic"><a href="/settings" className="underline">Add reasons</a></span>
                  )}
                  <Input
                    value={line.note}
                    onChange={(e) => updateLine(line.key, 'note', e.target.value)}
                    placeholder="Optional note"
                    aria-label="Note"
                    className="h-8 text-xs"
                  />
                  <Input
                    type="number" step="any" inputMode="decimal"
                    value={line.qtyInput}
                    onChange={(e) => updateLine(line.key, 'qtyInput', e.target.value)}
                    placeholder="0"
                    aria-label="Quantity to add or remove"
                    className={`h-8 w-28 text-right text-sm font-mono ${qtyNum > 0 ? 'text-green-700 dark:text-green-400' : qtyNum < 0 ? 'text-destructive' : ''}`}
                  />
                  <Input
                    type="number" step="any" min="0"
                    value={line.unitCostBase == null ? '' : line.unitCostBase}
                    onChange={(e) => updateLine(line.key, 'unitCostBase', e.target.value === '' ? null : (Number(e.target.value) || 0))}
                    placeholder="avg"
                    aria-label="Unit cost (base currency)"
                    title="Unit cost (base currency). Required for a positive line when the product has no existing cost; 0 for samples."
                    className="h-8 w-24 text-right text-sm font-mono"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))} aria-label={`Remove ${line.productSku}`} className="h-8 w-8 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                )
              })}
              </div>
            </div>
          )}

          {result?.success && <p className="text-sm text-green-600 font-medium">{result.count} adjustment{result.count !== 1 ? 's' : ''} saved.</p>}
          {result?.message && <p className="text-sm text-destructive">{result.message}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {/* 0tr0: stay disabled once saved — the dialog lingers ~1s before close and
              the token is cleared on success, so a click in that window would mint a
              fresh token and double-book the whole batch. */}
          <Button onClick={handleSave} disabled={saving || lines.length === 0 || !!result?.success}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save Adjustments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
