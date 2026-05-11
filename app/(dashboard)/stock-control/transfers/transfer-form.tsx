'use client'

import { useRef, useState } from 'react'
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
import { createTransfer, type TransferRow } from '@/app/actions/transfers'
import { ProductLink } from '@/components/inventory/product-link'
import type { ProductRow } from '@/app/actions/products'
import type { StockLevelEntry } from '@/lib/domain/inventory/stock-level-map'

type Warehouse = { id: string; code: string; name: string }
type StockLevels = Record<string, Record<string, StockLevelEntry>>

type Props = {
  warehouses: Warehouse[]
  products: ProductRow[]
  stockLevels: StockLevels
  onCreated: (t: TransferRow) => void
  onClose: () => void
}

type Line = {
  key: number
  productId: string
  sku: string
  productName: string
  qty: number
}

function StockCell({ entry, dim }: { entry: StockLevelEntry; dim?: boolean }) {
  const available = entry.available
  const total = entry.total
  return (
    <span className={`font-mono text-xs text-right ${dim ? 'text-muted-foreground' : available <= 0 ? 'text-destructive' : 'text-foreground'}`}>
      {total}
      {total !== available
        ? <span className="text-muted-foreground"> ({available})</span>
        : null}
    </span>
  )
}

export function TransferFormDialog({ warehouses, products, stockLevels, onCreated, onClose }: Props) {
  const [fromId, setFromId] = useState(warehouses[0]?.id ?? '')
  const [toId, setToId] = useState(warehouses[1]?.id ?? warehouses[0]?.id ?? '')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [nextKey, setNextKey] = useState(0)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  function stockAt(productId: string, warehouseId: string): StockLevelEntry {
    return stockLevels[productId]?.[warehouseId] ?? { total: 0, available: 0 }
  }

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
    setLines((prev) => [...prev, { key: nextKey, productId: p.id, sku: p.sku, productName: p.name, qty: 0 }])
    setNextKey((k) => k + 1)
    setSearch('')
    searchRef.current?.focus()
  }

  async function handleSave() {
    setError(null)
    const valid = lines.filter((l) => l.qty > 0)
    if (valid.length === 0) { setError('Add at least one product with a quantity greater than zero.'); return }
    if (fromId === toId) { setError('Source and destination warehouses must be different.'); return }
    setSaving(true)
    const res = await createTransfer(fromId, toId, valid, notes)
    setSaving(false)
    if (res.success && res.transfer) {
      onCreated(res.transfer)
      onClose()
    } else {
      setError(res.message ?? 'Failed to create transfer.')
    }
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New Stock Transfer</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Warehouse selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">From Warehouse</Label>
              <Select value={fromId} onChange={(e) => setFromId(e.target.value)} className="h-9">
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">To Warehouse</Label>
              <Select value={toId} onChange={(e) => setToId(e.target.value)} className="h-9">
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </Select>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-sm">Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. monthly restock" className="h-9" />
          </div>

          {/* Product search */}
          <div className="space-y-1.5">
            <Label className="text-sm">Add Products</Label>
            <div className="relative">
              <Input
                ref={searchRef}
                placeholder="Search by SKU or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                autoComplete="off"
              />
              {searchFocused && searchResults.length > 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg overflow-hidden">
                  {searchResults.map((p) => (
                    <button
                      key={p.id} type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-3 border-b border-border/50 last:border-0"
                      onMouseDown={() => addProduct(p)}
                    >
                      <span className="font-mono font-medium text-xs w-28 shrink-0 truncate">{p.sku}</span>
                      <span className="text-muted-foreground truncate flex-1">{p.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0 font-mono">
                        {(() => { const s = stockAt(p.id, fromId); return s.total === s.available ? s.total : `${s.total} (${s.available})` })()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchFocused && search.trim().length >= 1 && searchResults.length === 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg px-3 py-2 text-sm text-muted-foreground">
                  No products found.
                </div>
              )}
            </div>
          </div>

          {/* Lines */}
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground gap-2">
              <PackageSearch className="h-8 w-8 opacity-30" />
              <p className="text-sm">Search for products above to add them to this transfer.</p>
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-x-auto">
              <div className="min-w-[500px]">
              <div className="grid grid-cols-[2fr_1fr_1fr_auto_auto] gap-3 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b border-border">
                <span>Product</span>
                <span className="text-right">From {warehouses.find((w) => w.id === fromId)?.code ?? ''}</span>
                <span className="text-right">To {warehouses.find((w) => w.id === toId)?.code ?? ''}</span>
                <span className="w-24 text-right">Transfer Qty</span>
                <span className="w-8" />
              </div>
              {lines.map((line) => {
                const from = stockAt(line.productId, fromId)
                const to = stockAt(line.productId, toId)
                return (
                  <div key={line.key} className="grid grid-cols-[2fr_1fr_1fr_auto_auto] gap-3 px-3 py-2.5 items-center border-b border-border/50 last:border-0">
                    <div className="min-w-0">
                      <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                    </div>
                    <StockCell entry={from} />
                    <StockCell entry={to} dim />
                    <Input
                      type="number" min="1" step="1"
                      value={line.qty === 0 ? '' : line.qty}
                      onChange={(e) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l))}
                      placeholder="0"
                      className={`h-8 w-24 text-right text-sm font-mono ${line.qty > from.available && from.available > 0 ? 'border-destructive text-destructive' : ''}`}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))} className="h-8 w-8 text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || lines.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save as Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
