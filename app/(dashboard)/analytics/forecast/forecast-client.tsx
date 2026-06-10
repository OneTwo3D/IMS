'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, ArrowUpDown, Settings2, ShoppingCart, Loader2, TrendingUp, TrendingDown, Package, Download, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'
import {
  saveForecastSettings, createReorderPOs,
  type ProductForecast, type ForecastSettings,
} from '@/app/actions/forecasting'
import type { HistoricalImportProgress } from '@/lib/connectors/woocommerce/orders'
import { importHistoricalSalesCsv } from '@/app/actions/wc-import'

type Props = { forecasts: ProductForecast[]; settings: ForecastSettings }

const URGENCY_CLASS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  low: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
  ok: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  overstock: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
}
const URGENCY_LABEL: Record<string, string> = { critical: 'Critical', low: 'Low Stock', ok: 'OK', overstock: 'Overstock' }
const ABC_CLASS: Record<string, string> = {
  A: 'bg-amber-100 text-amber-800 border-amber-200',
  B: 'bg-slate-100 text-slate-700 border-slate-200',
  C: 'bg-gray-100 text-gray-600 border-gray-200',
}
function SettingsDialog({ settings: initial, onClose }: { settings: ForecastSettings; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(initial)

  function handleSave() {
    startTransition(async () => {
      await saveForecastSettings(s)
      router.refresh()
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
      <DialogHeader><DialogTitle>Forecast Settings</DialogTitle></DialogHeader>
      <div className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <Label>Service Level (%)</Label>
          <Input type="number" min={80} max={99.9} step={0.5} value={s.serviceLevelPercent} onChange={(e) => setS({ ...s, serviceLevelPercent: Number(e.target.value) })} className="h-9" />
          <p className="text-xs text-muted-foreground">Higher = more safety stock. 95% is standard.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Default Lead Time (days)</Label>
          <Input type="number" min={1} max={365} value={s.defaultLeadTimeDays} onChange={(e) => setS({ ...s, defaultLeadTimeDays: Number(e.target.value) })} className="h-9" />
          <p className="text-xs text-muted-foreground">Used when no PO history is available for the supplier.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Review Period (days)</Label>
          <Input type="number" min={7} max={365} value={s.reviewPeriodDays} onChange={(e) => setS({ ...s, reviewPeriodDays: Number(e.target.value) })} className="h-9" />
          <p className="text-xs text-muted-foreground">How far back to look for sales data.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Reorder Quantity (weeks of supply)</Label>
          <Input type="number" min={1} max={52} value={s.reorderQtyWeeks} onChange={(e) => setS({ ...s, reorderQtyWeeks: Number(e.target.value) })} className="h-9" />
          <p className="text-xs text-muted-foreground">How many weeks of forecasted demand to order.</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleSave} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Training Data dialog
// ---------------------------------------------------------------------------
function TrainingDialog({ settings, onClose }: { settings: ForecastSettings; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [importingType, setImportingType] = useState<'wc' | 'csv' | null>(null)
  const [dateFrom, setDateFrom] = useState('2023-01-01')
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
  const [retentionMonths, setRetentionMonths] = useState(settings.retentionMonths)
  const [retentionSaved, setRetentionSaved] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)
  const [wcProgress, setWcProgress] = useState<HistoricalImportProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/import/historical-orders')
        const p: HistoricalImportProgress = await res.json()
        setWcProgress(p)
        if (p.status === 'done' || p.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setImportingType(null)
          setResult({ message: p.message, isError: p.status === 'error' })
          if (p.status === 'done') router.refresh()
        }
      } catch { /* ignore poll errors */ }
    }, 2000)
  }

  // Check if a WC import job is already running on mount
  useEffect(() => {
    fetch('/api/import/historical-orders').then((r) => r.json()).then((p: HistoricalImportProgress) => {
      if (p.status === 'running') {
        setImportingType('wc')
        setWcProgress(p)
        startPolling()
      }
    }).catch(() => {})

    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleWcImport() {
    setResult(null)
    setWcProgress(null)
    setImportingType('wc')
    try {
      const res = await fetch('/api/import/historical-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo }),
      })
      if (!res.ok) {
        setResult({ message: `Server error: ${res.status}`, isError: true })
        setImportingType(null)
        return
      }
      // Job started — begin polling
      startPolling()
    } catch (e) {
      setResult({ message: String(e), isError: true })
      setImportingType(null)
    }
  }

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null)
    setImportingType('csv')
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const r = await importHistoricalSalesCsv(fd)
      setResult({ message: r.message, isError: r.status === 'error' })
      setImportingType(null)
      if (r.status === 'done') router.refresh()
    })
  }

  const isWcRunning = importingType === 'wc'
  const isBusy = isPending || isWcRunning

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-lg sm:max-w-lg">
      <DialogHeader><DialogTitle>Import Historical Sales Data</DialogTitle></DialogHeader>
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Import historical sales data to improve forecast accuracy. This creates demand records
          from past orders without affecting current stock levels.
          The import runs in the background — you can close this dialog and continue working.
        </p>

        {/* WooCommerce import */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">From WooCommerce</h3>
          <p className="text-xs text-muted-foreground">
            Fetches completed orders from your WooCommerce store for the selected date range.
            Requires WC API credentials configured in Settings.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-sm" disabled={isWcRunning} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-sm" disabled={isWcRunning} />
            </div>
          </div>
          <Button size="sm" onClick={handleWcImport} disabled={isBusy}>
            {isWcRunning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Package className="h-3 w-3 mr-1" />}
            {isWcRunning ? 'Importing…' : 'Import from WooCommerce'}
          </Button>
          {isWcRunning && wcProgress && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{wcProgress.message}</p>
              {wcProgress.totalOrders > 0 && (
                <div className="w-full bg-muted rounded-full h-1.5">
                  <div
                    className="bg-primary h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.min(100, Math.round(((wcProgress.ordersProcessed + (wcProgress.ordersSkipped ?? 0)) / wcProgress.totalOrders) * 100))}%` }}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground tabular-nums">
                {wcProgress.ordersProcessed} imported, {wcProgress.movementsCreated} records created
                {wcProgress.ordersSkipped > 0 && <>, {wcProgress.ordersSkipped} already imported</>}
                {wcProgress.itemsSkipped > 0 && <>, {wcProgress.itemsSkipped} items skipped (no SKU match)</>}
              </p>
            </div>
          )}
        </div>

        {/* CSV import */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">From CSV</h3>
          <p className="text-xs text-muted-foreground">
            Upload a CSV with columns: <code className="text-[10px] bg-muted px-1 rounded">sku, qty, date</code> (date format: YYYY-MM-DD).
            One row per line item sold.
          </p>
          <label className={`inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-8 text-xs font-medium cursor-pointer ${isBusy ? 'opacity-50 pointer-events-none' : 'hover:bg-muted'}`}>
            {importingType === 'csv' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
            {importingType === 'csv' ? 'Uploading…' : 'Upload CSV'}
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} disabled={isBusy} />
          </label>
        </div>

        {/* Retention setting */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">Data Retention</h3>
          <p className="text-xs text-muted-foreground">
            Historical demand records older than this are automatically purged. Applies to all sources (WooCommerce and CSV).
          </p>
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Retention period (months)</Label>
              <Input type="number" min={1} max={120} value={retentionMonths} onChange={(e) => { setRetentionMonths(Number(e.target.value)); setRetentionSaved(false) }} className="h-8 text-sm w-24" />
            </div>
            <Button size="sm" variant="outline" disabled={isPending || retentionSaved} onClick={() => {
              startTransition(async () => {
                await saveForecastSettings({ ...settings, retentionMonths })
                setRetentionSaved(true)
                router.refresh()
              })
            }}>
              {retentionSaved ? 'Saved' : 'Save'}
            </Button>
          </div>
        </div>

        {result && (
          <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-green-600'}`}>{result.message}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
type SortField = 'sku' | 'abcClass' | 'urgency' | 'availableStock' | 'avgDailyDemand' | 'demandTrend' | 'avgLeadTimeDays' | 'reorderPoint' | 'safetyStock' | 'daysUntilStockout' | 'recommendedOrderQty' | 'supplierName'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 50

function SortHeader({ field, label, align, sortField, sortDir, onSort, className }: {
  field: SortField; label: string; align: 'left' | 'right'
  sortField: SortField; sortDir: SortDir; onSort: (f: SortField) => void; className?: string
}) {
  const active = sortField === field
  return (
    <TableHead className={`text-${align} text-xs ${className ?? ''}`}>
      <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => onSort(field)}>
        {label}
        {active ? (
          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </TableHead>
  )
}

function compareForecast(a: ProductForecast, b: ProductForecast, field: SortField, dir: SortDir): number {
  let cmp = 0
  switch (field) {
    case 'sku': cmp = a.sku.localeCompare(b.sku); break
    case 'abcClass': cmp = a.abcClass.localeCompare(b.abcClass); break
    case 'urgency': {
      const order = { critical: 0, low: 1, ok: 2, overstock: 3 }
      cmp = (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9); break
    }
    case 'supplierName': cmp = (a.supplierName ?? '').localeCompare(b.supplierName ?? ''); break
    default: cmp = (a[field] as number) - (b[field] as number)
  }
  return dir === 'asc' ? cmp : -cmp
}

export function ForecastClient({ forecasts, settings }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showSettings, setShowSettings] = useState(false)
  const [showTraining, setShowTraining] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<'all' | 'critical' | 'low' | 'ok' | 'overstock'>('all')
  const [abcFilter, setAbcFilter] = useState<'all' | 'A' | 'B' | 'C'>('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [sortField, setSortField] = useState<SortField>('daysUntilStockout')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(1)

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
    setPage(1)
  }

  const filtered = forecasts.filter((f) => {
    if (filter !== 'all' && f.urgency !== filter) return false
    if (abcFilter !== 'all' && f.abcClass !== abcFilter) return false
    if (supplierFilter !== 'all' && f.supplierId !== supplierFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return f.sku.toLowerCase().includes(q) || f.name.toLowerCase().includes(q) || (f.supplierName ?? '').toLowerCase().includes(q)
    }
    return true
  })

  const sorted = [...filtered].sort((a, b) => compareForecast(a, b, sortField, sortDir))
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const needsReorder = forecasts.filter((f) => f.urgency === 'critical' || f.urgency === 'low')
  const supplierOptions = Array.from(
    new Map(
      forecasts
        .filter((f) => f.supplierId && f.supplierName)
        .map((f) => [f.supplierId!, f.supplierName!]),
    ),
  ).sort((a, b) => a[1].localeCompare(b[1]))

  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function selectAllNeedingReorder() {
    setSelected(new Set(
      needsReorder
        .filter((f) => f.supplierId && (supplierFilter === 'all' || f.supplierId === supplierFilter))
        .map((f) => f.productId),
    ))
  }

  function handleCreatePOs() {
    if (selected.size === 0) { setError('Select at least one product'); return }
    if (supplierFilter === 'all') { setError('Choose one supplier before creating a draft PO'); return }
    setError('')
    startTransition(async () => {
      const result = await createReorderPOs(Array.from(selected), { supplierId: supplierFilter })
      if (result.success) {
        setSelected(new Set())
        router.refresh()
        setError(`Created ${result.poCount} draft PO(s)`)
      } else {
        setError(result.error ?? 'Failed')
      }
    })
  }

  // Summary stats
  const criticalCount = forecasts.filter((f) => f.urgency === 'critical').length
  const lowCount = forecasts.filter((f) => f.urgency === 'low').length
  const overstockCount = forecasts.filter((f) => f.urgency === 'overstock').length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <a href="/api/export/analytics?type=forecast" className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-8 text-sm font-medium hover:bg-muted">
            <Download className="h-4 w-4" />Export CSV
          </a>
          <Button variant="outline" size="sm" onClick={() => setShowTraining(true)}>
            <Package className="h-4 w-4 mr-1" />Training Data
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
            <Settings2 className="h-4 w-4 mr-1" />Settings
          </Button>
          {selected.size > 0 && (
            <Button size="sm" onClick={handleCreatePOs} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShoppingCart className="h-4 w-4 mr-1" />}
              Create POs ({selected.size})
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border p-3 text-center">
          <p className="text-2xl font-bold text-destructive">{criticalCount}</p>
          <p className="text-xs text-muted-foreground">Out of Stock</p>
        </div>
        <div className="rounded-md border p-3 text-center">
          <p className="text-2xl font-bold text-orange-600">{lowCount}</p>
          <p className="text-xs text-muted-foreground">Low Stock</p>
        </div>
        <div className="rounded-md border p-3 text-center">
          <p className="text-2xl font-bold text-blue-600">{overstockCount}</p>
          <p className="text-xs text-muted-foreground">Overstock</p>
        </div>
        <div className="rounded-md border p-3 text-center">
          <p className="text-2xl font-bold">{forecasts.length}</p>
          <p className="text-xs text-muted-foreground">Total Products</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search SKU, name, supplier…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="h-8 text-sm max-w-xs" />
        <div className="flex gap-1">
          {(['all', 'critical', 'low', 'ok', 'overstock'] as const).map((u) => (
            <Button key={u} variant={filter === u ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => { setFilter(u); setPage(1) }}>
              {u === 'all' ? 'All' : URGENCY_LABEL[u]}
            </Button>
          ))}
        </div>
        <span className="w-px h-5 bg-border" />
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          value={supplierFilter}
          onChange={(e) => { setSupplierFilter(e.target.value); setSelected(new Set()); setPage(1) }}
        >
          <option value="all">All suppliers</option>
          {supplierOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <span className="w-px h-5 bg-border" />
        <div className="flex gap-1">
          {(['all', 'A', 'B', 'C'] as const).map((c) => (
            <Button key={c} variant={abcFilter === c ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => { setAbcFilter(c); setPage(1) }}>
              {c === 'all' ? 'All ABC' : `Class ${c}`}
            </Button>
          ))}
        </div>
        {needsReorder.length > 0 && (
          <>
            <span className="w-px h-5 bg-border" />
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAllNeedingReorder}>
              Select all needing reorder ({needsReorder.filter((f) => f.supplierId && (supplierFilter === 'all' || f.supplierId === supplierFilter)).length})
            </Button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Table */}
      <Table className="rounded-md border min-w-[900px]" containerClassName="max-h-[calc(100vh-20rem)]">
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-12 px-2" />
            <SortHeader field="sku" label="Product" align="left" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
            <SortHeader field="abcClass" label="ABC" align="left" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-16" />
            <SortHeader field="urgency" label="Status" align="left" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="availableStock" label="Stock" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="avgDailyDemand" label="Daily Demand" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="demandTrend" label="Trend" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-16" />
            <SortHeader field="avgLeadTimeDays" label="Lead Time" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="reorderPoint" label="Reorder Pt" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="safetyStock" label="Safety" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="daysUntilStockout" label="Days to S/O" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-24" />
            <SortHeader field="recommendedOrderQty" label="Order Qty" align="right" sortField={sortField} sortDir={sortDir} onSort={toggleSort} className="w-20" />
            <SortHeader field="supplierName" label="Supplier" align="left" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y">
          {paged.map((f) => (
            <TableRow key={f.productId} className={f.urgency === 'critical' ? 'bg-red-50 dark:bg-red-950/20' : ''}>
              <TableCell>
                {f.supplierId && f.recommendedOrderQty > 0 && (
                  <input type="checkbox" checked={selected.has(f.productId)} onChange={() => toggleSelect(f.productId)} className="rounded border-input" />
                )}
              </TableCell>
              <TableCell className="w-12 px-2 py-1">
                <ProductThumb productId={f.productId} imageUrl={f.imageUrl} name={f.name} />
              </TableCell>
              <TableCell>
                <ProductLink productId={f.productId} sku={f.sku} name={f.name} />
              </TableCell>
              <TableCell>
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold border ${ABC_CLASS[f.abcClass]}`}>{f.abcClass}</span>
              </TableCell>
              <TableCell>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${URGENCY_CLASS[f.urgency]}`}>
                  {URGENCY_LABEL[f.urgency]}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs">
                <span className={f.availableStock <= 0 ? 'text-destructive font-medium' : ''}>
                  {f.availableStock} {f.stockUnit}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs">{f.avgDailyDemand.toFixed(1)}</TableCell>
              <TableCell className="text-right text-xs">
                {f.demandTrend > 5 ? (
                  <span className="text-green-600 flex items-center justify-end gap-0.5"><TrendingUp className="h-3 w-3" />{f.demandTrend.toFixed(0)}%</span>
                ) : f.demandTrend < -5 ? (
                  <span className="text-destructive flex items-center justify-end gap-0.5"><TrendingDown className="h-3 w-3" />{f.demandTrend.toFixed(0)}%</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs text-muted-foreground">{f.avgLeadTimeDays}d</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{f.reorderPoint}</TableCell>
              <TableCell className="text-right tabular-nums text-xs text-muted-foreground">{f.safetyStock}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">
                <span className={f.daysUntilStockout <= 0 ? 'text-destructive font-bold' : f.daysUntilStockout <= 14 ? 'text-orange-600 font-medium' : ''}>
                  {f.daysUntilStockout >= 999 ? '—' : `${f.daysUntilStockout}d`}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs font-medium">
                {f.recommendedOrderQty > 0 ? f.recommendedOrderQty : '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground truncate max-w-32">{f.supplierName ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No products match the current filters.</p>
      ) : totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground text-xs">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
              .reduce<(number | 'gap')[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('gap')
                acc.push(p)
                return acc
              }, [])
              .map((p, i) =>
                p === 'gap' ? (
                  <span key={`gap-${i}`} className="px-1 text-muted-foreground">…</span>
                ) : (
                  <Button key={p} variant={p === safePage ? 'default' : 'outline'} size="sm" className="h-7 w-7 text-xs p-0" onClick={() => setPage(p)}>
                    {p}
                  </Button>
                )
              )}
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} />}
      {showTraining && <TrainingDialog settings={settings} onClose={() => setShowTraining(false)} />}
    </div>
  )
}
