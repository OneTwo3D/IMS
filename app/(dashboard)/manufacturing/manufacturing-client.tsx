'use client'

import { useState, useTransition, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Plus, Download, Filter, ChevronLeft, ChevronRight,
  Factory, AlertTriangle, Loader2, Check, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'
import {
  getManufacturingOrders,
  getBomProducts,
  getWarehouses,
  getSuppliers,
  getMaxAssembly,
  getDisassemblyStock,
  getComponentStock,
  getLastManufacturer,
  createManufacturingOrder,
  type ManufacturingOrderRow,
  type BomProduct,
  type WarehouseOption,
  type SupplierOption,
} from '@/app/actions/manufacturing'

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  IN_PROGRESS: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  COMPLETED: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

const STATUS_OPTIONS = ['ALL', 'DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const
const TYPE_OPTIONS = ['ALL', 'ASSEMBLY', 'DISASSEMBLY'] as const

type Props = {
  initialRows: ManufacturingOrderRow[]
  initialTotal: number
}

export function ManufacturingClient({ initialRows, initialTotal }: Props) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [isPending, startTransition] = useTransition()
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [typeFilter, setTypeFilter] = useState<string>('ALL')
  const [page, setPage] = useState(1)
  const pageSize = 50
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false)

  const refresh = useCallback(
    (opts?: { p?: number; s?: string; st?: string; ty?: string }) => {
      const p = opts?.p ?? page
      const s = opts?.s ?? search
      const st = opts?.st ?? statusFilter
      const ty = opts?.ty ?? typeFilter
      startTransition(async () => {
        const result = await getManufacturingOrders({
          search: s || undefined,
          status: st !== 'ALL' ? (st as 'DRAFT') : undefined,
          orderType: ty !== 'ALL' ? (ty as 'ASSEMBLY') : undefined,
          page: p,
          pageSize,
        })
        setRows(result.rows)
        setTotal(result.total)
      })
    },
    [page, search, statusFilter, typeFilter],
  )

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
      refresh({ s: searchInput, p: 1 })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function handleStatusFilter(s: string) { setStatusFilter(s); setPage(1); refresh({ st: s, p: 1 }) }
  function handleTypeFilter(t: string) { setTypeFilter(t); setPage(1); refresh({ ty: t, p: 1 }) }
  function handlePage(p: number) { setPage(p); refresh({ p }) }

  function handleExport() {
    const header = 'Reference,Type,SKU,Product,Warehouse,Manufacturer,Planned,Produced,Status,Created'
    const csv = rows.map((r) =>
      [r.reference, r.orderType, r.productSku, `"${r.productName}"`, r.warehouseName, r.manufacturerName ?? '', r.qtyPlanned, r.qtyProduced, r.status, r.createdAt.slice(0, 10)].join(',')
    )
    const blob = new Blob([header + '\n' + csv.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `manufacturing-orders-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  function fmtDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Manufacturing</h1>
          <p className="text-sm text-muted-foreground mt-1">{total} order{total !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4 mr-1" />Export
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />New Order
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search orders..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className="pl-8 h-9" />
        </div>
        <div className="flex items-center gap-1">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {STATUS_OPTIONS.map((s) => (
            <Button key={s} variant={statusFilter === s ? 'secondary' : 'ghost'} size="sm" className="h-7 text-xs" onClick={() => handleStatusFilter(s)}>
              {s === 'ALL' ? 'All' : s.replace('_', ' ')}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {TYPE_OPTIONS.map((t) => (
            <Button key={t} variant={typeFilter === t ? 'secondary' : 'ghost'} size="sm" className="h-7 text-xs" onClick={() => handleTypeFilter(t)}>
              {t === 'ALL' ? 'All Types' : t.charAt(0) + t.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left font-medium px-3 py-2">Reference</th>
              <th className="text-left font-medium px-3 py-2">Type</th>
              <th className="w-12 px-2 py-2" />
              <th className="text-left font-medium px-3 py-2">Product</th>
              <th className="text-left font-medium px-3 py-2">Warehouse</th>
              <th className="text-left font-medium px-3 py-2">Manufacturer</th>
              <th className="text-right font-medium px-3 py-2">Planned</th>
              <th className="text-right font-medium px-3 py-2">Produced</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                  {isPending ? 'Loading...' : 'No manufacturing orders found.'}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => router.push(`/manufacturing/${r.id}`)}>
                  <td className="px-3 py-2 font-mono text-xs">{r.reference}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="text-xs font-normal">
                      {r.orderType === 'ASSEMBLY' ? 'Assembly' : 'Disassembly'}
                    </Badge>
                  </td>
                  <td className="w-12 px-2 py-1">
                    <ProductThumb productId={r.productId} imageUrl={r.productImageUrl} name={r.productName} />
                  </td>
                  <td className="px-3 py-2">
                    <ProductLink productId={r.productId} sku={r.productSku} name={r.productName} skuClassName="font-mono text-xs text-muted-foreground mr-1" />
                  </td>
                  <td className="px-3 py-2">{r.warehouseName}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.manufacturerName ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{r.qtyPlanned}</td>
                  <td className="px-3 py-2 text-right">{r.qtyProduced}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className={`text-xs font-normal ${STATUS_BADGE[r.status] ?? ''}`}>
                      {r.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{fmtDate(r.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isPending} onClick={() => handlePage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm px-2">{page} / {totalPages}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isPending} onClick={() => handlePage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <CreateOrderDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh({ p: 1 }) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create Order Dialog
// ---------------------------------------------------------------------------

function CreateOrderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Reference data
  const [bomProducts, setBomProducts] = useState<BomProduct[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [loading, setLoading] = useState(true)

  // Form state
  const [productSearch, setProductSearch] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<BomProduct | null>(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [manufacturerId, setManufacturerId] = useState('')
  const [orderType, setOrderType] = useState<'ASSEMBLY' | 'DISASSEMBLY'>('ASSEMBLY')
  const [qty, setQty] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [notes, setNotes] = useState('')

  // Computed stock info
  const [maxUnits, setMaxUnits] = useState<number | null>(null)
  const [componentStocks, setComponentStocks] = useState<{ componentId: string; available: number; needed: number }[]>([])
  const [loadingStock, setLoadingStock] = useState(false)

  // Load reference data
  useEffect(() => {
    Promise.all([getBomProducts(), getWarehouses(), getSuppliers()]).then(([p, w, s]) => {
      setBomProducts(p)
      setWarehouses(w)
      setSuppliers(s)
      setLoading(false)
    }).catch(() => { setLoading(false) })
  }, [])

  // When product or warehouse changes, recalculate stock
  useEffect(() => {
    if (!selectedProduct || !warehouseId) {
      setMaxUnits(null)
      setComponentStocks([])
      return
    }
    setLoadingStock(true)
    if (orderType === 'ASSEMBLY') {
      Promise.all([
        getMaxAssembly(selectedProduct.id, warehouseId),
        getComponentStock(selectedProduct.id, warehouseId),
      ]).then(([max, stocks]) => {
        setMaxUnits(max)
        setComponentStocks(stocks)
        setLoadingStock(false)
      }).catch(() => { setLoadingStock(false) })
    } else {
      getDisassemblyStock(selectedProduct.id, warehouseId).then((max) => {
        setMaxUnits(max)
        setComponentStocks([])
        setLoadingStock(false)
      }).catch(() => { setLoadingStock(false) })
    }
  }, [selectedProduct, warehouseId, orderType])

  // When product changes, preselect last manufacturer
  useEffect(() => {
    if (!selectedProduct) return
    getLastManufacturer(selectedProduct.id).then((id) => {
      if (id) setManufacturerId(id)
    }).catch(() => {})
  }, [selectedProduct])

  const filteredProducts = bomProducts.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  })

  const qtyNum = parseInt(qty) || 0
  const stockInsufficient = maxUnits !== null && qtyNum > maxUnits

  function handleCreate() {
    if (!selectedProduct || !warehouseId || qtyNum <= 0) return
    setError(null)
    startTransition(async () => {
      const result = await createManufacturingOrder({
        productId: selectedProduct.id,
        warehouseId,
        manufacturerId: manufacturerId || null,
        orderType,
        qtyPlanned: qtyNum,
        scheduledAt: scheduledAt || null,
        notes: notes || null,
      })
      if (result.success) {
        onCreated()
      } else {
        setError(result.error ?? 'Failed to create order.')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Factory className="h-5 w-5" />
            New Manufacturing Order
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Order type toggle */}
            <div className="space-y-1.5">
              <Label className="text-xs">Order Type</Label>
              <div className="flex gap-2">
                <Button
                  variant={orderType === 'ASSEMBLY' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setOrderType('ASSEMBLY')}
                >
                  Assembly
                </Button>
                <Button
                  variant={orderType === 'DISASSEMBLY' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setOrderType('DISASSEMBLY')}
                >
                  Disassembly
                </Button>
              </div>
            </div>

            {/* Product search */}
            <div className="space-y-1.5">
              <Label className="text-xs">Product (BOM)</Label>
              {selectedProduct ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <span className="font-mono text-xs text-muted-foreground mr-2">{selectedProduct.sku}</span>
                    <span className="text-sm">{selectedProduct.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">({selectedProduct.components.length} components)</span>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setSelectedProduct(null); setProductSearch(''); setMaxUnits(null) }}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by SKU or name..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="pl-8 h-9"
                      autoFocus
                    />
                  </div>
                  {productSearch && (
                    <div className="max-h-40 overflow-y-auto rounded-md border">
                      {filteredProducts.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">No BOM products found.</p>
                      ) : (
                        filteredProducts.slice(0, 20).map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => { setSelectedProduct(p); setProductSearch('') }}
                            className="flex items-center w-full px-3 py-1.5 text-left hover:bg-muted/50 text-sm"
                          >
                            <span className="font-mono text-xs text-muted-foreground w-28 shrink-0">{p.sku}</span>
                            <span>{p.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{p.components.length} parts</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Warehouse + Manufacturer */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Warehouse</Label>
                <select
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">Select warehouse...</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Manufacturer (optional)</Label>
                <select
                  value={manufacturerId}
                  onChange={(e) => setManufacturerId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">None / In-house</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Stock availability */}
            {selectedProduct && warehouseId && (
              <Card className="p-3">
                {loadingStock ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />Checking stock...
                  </div>
                ) : orderType === 'ASSEMBLY' ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">Component Availability</p>
                      <p className="text-sm font-semibold">
                        Max: <span className={maxUnits === 0 ? 'text-destructive' : 'text-green-600'}>{maxUnits}</span> units
                      </p>
                    </div>
                    <div className="space-y-1">
                      {selectedProduct.components.map((c) => {
                        const stock = componentStocks.find((s) => s.componentId === c.componentId)
                        const avail = stock?.available ?? 0
                        const needed = c.qty
                        const sufficient = avail >= needed
                        return (
                          <div key={c.componentId} className="flex items-center text-xs gap-2">
                            <span className={`w-3 h-3 rounded-full ${sufficient ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span className="font-mono text-muted-foreground w-24">{c.componentSku}</span>
                            <span className="flex-1">{c.componentName}</span>
                            <span className="text-muted-foreground">{avail} avail / {needed} per unit</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Available for Disassembly</p>
                    <p className="text-sm font-semibold">
                      <span className={maxUnits === 0 ? 'text-destructive' : 'text-green-600'}>{maxUnits}</span> units in stock
                    </p>
                  </div>
                )}

                {orderType === 'DISASSEMBLY' && selectedProduct && maxUnits !== null && maxUnits > 0 && (
                  <div className="mt-2 pt-2 border-t space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Components generated per unit:</p>
                    {selectedProduct.components.map((c) => (
                      <div key={c.componentId} className="flex items-center text-xs gap-2">
                        <span className="font-mono text-muted-foreground w-24">{c.componentSku}</span>
                        <span className="flex-1">{c.componentName}</span>
                        <span className="text-muted-foreground">{c.qty} per unit</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Quantity + Date */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Quantity</Label>
                <Input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="h-9"
                  placeholder="0"
                />
                {stockInsufficient && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Exceeds available stock ({maxUnits} max)
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Scheduled Date</Label>
                <Input
                  type="date"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Created</Label>
                <Input
                  value={new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  disabled
                  className="h-9 bg-muted"
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-9"
                placeholder="Optional notes..."
              />
            </div>

            {error && (
              <p className="text-sm text-destructive flex items-center gap-1">
                <X className="h-3 w-3" />{error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button
            onClick={handleCreate}
            disabled={isPending || !selectedProduct || !warehouseId || qtyNum <= 0}
          >
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Create Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
