'use client'

import { useRef, useState } from 'react'
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

type AdjLine = BulkAdjustLine & {
  key: number
  productSku: string
  productName: string
}

export function BulkAdjustmentDialog({ warehouses, products, reasons, onClose }: Props) {
  const router = useRouter()
  const [lines, setLines] = useState<AdjLine[]>([])
  const [nextKey, setNextKey] = useState(0)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
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
      { key: nextKey, productId: p.id, productSku: p.sku, productName: p.name, warehouseId: defaultWarehouseId, reasonId: reasons[0]?.id ?? '', qty: 0 },
    ])
    setNextKey((k) => k + 1)
    setSearch('')
    searchRef.current?.focus()
  }

  function updateLine<K extends keyof AdjLine>(key: number, field: K, value: AdjLine[K]) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)))
  }

  async function handleSave() {
    const valid = lines.filter((l) => l.qty !== 0)
    if (valid.length === 0) { setResult({ message: 'Enter a non-zero quantity for at least one product.' }); return }
    setSaving(true)
    setResult(null)
    // 0tr0: reuse a stable idempotency token across retries of this batch so the
    // server dedups a double-submit line-for-line; reset only on confirmed success.
    if (!idempotencyTokenRef.current) {
      idempotencyTokenRef.current = crypto.randomUUID()
    }
    const res = await bulkAdjustStock(
      valid.map(({ productId, warehouseId, reasonId, qty, unitCostBase }) => ({ productId, warehouseId, reasonId, qty, unitCostBase })),
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
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                autoComplete="off"
              />
              {searchFocused && searchResults.length > 0 && (
                <div className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg overflow-hidden">
                  {searchResults.map((p) => (
                    <button key={p.id} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-3 border-b border-border/50 last:border-0" onMouseDown={() => addProduct(p)}>
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
              <div className="min-w-[500px]">
              <div className="grid grid-cols-[2fr_1fr_1fr_auto_auto_auto] gap-3 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b border-border">
                <span>Product</span>
                <span>Warehouse</span>
                <span>Reason</span>
                <span className="w-28 text-right">Qty (+ / −)</span>
                <span className="w-24 text-right">Unit cost</span>
                <span className="w-8" />
              </div>
              {lines.map((line) => (
                <div key={line.key} className="grid grid-cols-[2fr_1fr_1fr_auto_auto_auto] gap-3 px-3 py-2.5 items-center border-b border-border/50 last:border-0 hover:bg-muted/20">
                  <div className="min-w-0">
                    <ProductLink productId={line.productId} sku={line.productSku} name={line.productName} />
                  </div>
                  <Select value={line.warehouseId} onChange={(e) => updateLine(line.key, 'warehouseId', e.target.value)} className="h-8 text-xs">
                    {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
                  </Select>
                  {reasons.length > 0 ? (
                    <Select value={line.reasonId} onChange={(e) => updateLine(line.key, 'reasonId', e.target.value)} className="h-8 text-xs">
                      <option value="">— No reason —</option>
                      {reasons.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
                    </Select>
                  ) : (
                    <span className="text-xs text-muted-foreground italic"><a href="/settings" className="underline">Add reasons</a></span>
                  )}
                  <Input
                    type="number" step="1"
                    value={line.qty === 0 ? '' : line.qty}
                    onChange={(e) => updateLine(line.key, 'qty', Number(e.target.value) || 0)}
                    placeholder="0"
                    className={`h-8 w-28 text-right text-sm font-mono ${line.qty > 0 ? 'text-green-700 dark:text-green-400' : line.qty < 0 ? 'text-destructive' : ''}`}
                  />
                  <Input
                    type="number" step="any" min="0"
                    value={line.unitCostBase == null ? '' : line.unitCostBase}
                    onChange={(e) => updateLine(line.key, 'unitCostBase', e.target.value === '' ? null : (Number(e.target.value) || 0))}
                    placeholder="avg"
                    title="Unit cost (base currency). Required for a positive line when the product has no existing cost; 0 for samples."
                    className="h-8 w-24 text-right text-sm font-mono"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))} className="h-8 w-8 text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              </div>
            </div>
          )}

          {result?.success && <p className="text-sm text-green-600 font-medium">{result.count} adjustment{result.count !== 1 ? 's' : ''} saved.</p>}
          {result?.message && <p className="text-sm text-destructive">{result.message}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || lines.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save Adjustments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
