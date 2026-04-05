'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowDown, ArrowUp, Minus, Settings2, ShoppingCart, Loader2, TrendingUp, TrendingDown, Package, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import {
  saveForecastSettings, createReorderPOs,
  type ProductForecast, type ForecastSettings,
} from '@/app/actions/forecasting'
import { importHistoricalWcOrders, importHistoricalSalesCsv } from '@/app/actions/wc-import'

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
const TIER_LABEL: Record<string, string> = { new: 'New', established: 'Established', mature: 'Mature' }

function SettingsDialog({ settings: initial, onClose }: { settings: ForecastSettings; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [s, setS] = useState(initial)
  const [error, setError] = useState('')

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
        {error && <p className="text-destructive text-sm">{error}</p>}
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
function TrainingDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [dateFrom, setDateFrom] = useState('2023-01-01')
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)
  const fileRef = { current: null as HTMLInputElement | null }

  function handleWcImport() {
    setResult(null)
    startTransition(async () => {
      const r = await importHistoricalWcOrders(dateFrom, dateTo)
      setResult({ message: r.message, isError: r.status === 'error' })
      if (r.status === 'done') router.refresh()
    })
  }

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setResult(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const r = await importHistoricalSalesCsv(fd)
      setResult({ message: r.message, isError: r.status === 'error' })
      if (r.status === 'done') router.refresh()
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-lg sm:max-w-lg">
      <DialogHeader><DialogTitle>Import Historical Sales Data</DialogTitle></DialogHeader>
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Import historical sales data to improve forecast accuracy. This creates demand records
          from past orders without affecting current stock levels.
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
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>
          <Button size="sm" onClick={handleWcImport} disabled={isPending}>
            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Package className="h-3 w-3 mr-1" />}
            Import from WooCommerce
          </Button>
        </div>

        {/* CSV import */}
        <div className="rounded-md border p-3 space-y-3">
          <h3 className="font-medium">From CSV</h3>
          <p className="text-xs text-muted-foreground">
            Upload a CSV with columns: <code className="text-[10px] bg-muted px-1 rounded">sku, qty, date</code> (date format: YYYY-MM-DD).
            One row per line item sold.
          </p>
          <label className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 h-8 text-xs font-medium hover:bg-muted cursor-pointer">
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
            Upload CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} disabled={isPending} />
          </label>
        </div>

        {result && (
          <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-green-600'}`}>{result.message}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Close</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function ForecastClient({ forecasts, settings }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showSettings, setShowSettings] = useState(false)
  const [showTraining, setShowTraining] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<'all' | 'critical' | 'low' | 'ok' | 'overstock'>('all')
  const [abcFilter, setAbcFilter] = useState<'all' | 'A' | 'B' | 'C'>('all')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  const filtered = forecasts.filter((f) => {
    if (filter !== 'all' && f.urgency !== filter) return false
    if (abcFilter !== 'all' && f.abcClass !== abcFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return f.sku.toLowerCase().includes(q) || f.name.toLowerCase().includes(q) || (f.supplierName ?? '').toLowerCase().includes(q)
    }
    return true
  })

  const needsReorder = forecasts.filter((f) => f.urgency === 'critical' || f.urgency === 'low')

  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAllNeedingReorder() {
    setSelected(new Set(needsReorder.filter((f) => f.supplierId).map((f) => f.productId)))
  }

  function handleCreatePOs() {
    if (selected.size === 0) { setError('Select at least one product'); return }
    setError('')
    startTransition(async () => {
      const result = await createReorderPOs(Array.from(selected))
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
        <h1 className="text-2xl font-semibold">Reorder Forecast</h1>
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
      <div className="grid grid-cols-4 gap-3">
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
        <Input placeholder="Search SKU, name, supplier…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-sm max-w-xs" />
        <div className="flex gap-1">
          {(['all', 'critical', 'low', 'ok', 'overstock'] as const).map((u) => (
            <Button key={u} variant={filter === u ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setFilter(u)}>
              {u === 'all' ? 'All' : URGENCY_LABEL[u]}
            </Button>
          ))}
        </div>
        <span className="w-px h-5 bg-border" />
        <div className="flex gap-1">
          {(['all', 'A', 'B', 'C'] as const).map((c) => (
            <Button key={c} variant={abcFilter === c ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setAbcFilter(c)}>
              {c === 'all' ? 'All ABC' : `Class ${c}`}
            </Button>
          ))}
        </div>
        {needsReorder.length > 0 && (
          <>
            <span className="w-px h-5 bg-border" />
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAllNeedingReorder}>
              Select all needing reorder ({needsReorder.filter((f) => f.supplierId).length})
            </Button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Table */}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-16">ABC</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-20">Status</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Stock</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Daily Demand</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Trend</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Lead Time</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Reorder Pt</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Safety</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Days to S/O</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Order Qty</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((f) => (
              <tr key={f.productId} className={`hover:bg-muted/30 ${f.urgency === 'critical' ? 'bg-red-50 dark:bg-red-950/20' : ''}`}>
                <td className="px-3 py-2">
                  {f.supplierId && f.recommendedOrderQty > 0 && (
                    <input type="checkbox" checked={selected.has(f.productId)} onChange={() => toggleSelect(f.productId)} className="rounded border-input" />
                  )}
                </td>
                <td className="px-3 py-2">
                  <ProductLink productId={f.productId} sku={f.sku} name={f.name} />
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold border ${ABC_CLASS[f.abcClass]}`}>{f.abcClass}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${URGENCY_CLASS[f.urgency]}`}>
                    {URGENCY_LABEL[f.urgency]}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  <span className={f.availableStock <= 0 ? 'text-destructive font-medium' : ''}>
                    {f.availableStock} {f.stockUnit}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{f.avgDailyDemand.toFixed(1)}</td>
                <td className="px-3 py-2 text-right text-xs">
                  {f.demandTrend > 5 ? (
                    <span className="text-green-600 flex items-center justify-end gap-0.5"><TrendingUp className="h-3 w-3" />{f.demandTrend.toFixed(0)}%</span>
                  ) : f.demandTrend < -5 ? (
                    <span className="text-destructive flex items-center justify-end gap-0.5"><TrendingDown className="h-3 w-3" />{f.demandTrend.toFixed(0)}%</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{f.avgLeadTimeDays}d</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{f.reorderPoint}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{f.safetyStock}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  <span className={f.daysUntilStockout <= 0 ? 'text-destructive font-bold' : f.daysUntilStockout <= 14 ? 'text-orange-600 font-medium' : ''}>
                    {f.daysUntilStockout >= 999 ? '—' : `${f.daysUntilStockout}d`}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">
                  {f.recommendedOrderQty > 0 ? f.recommendedOrderQty : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-32">{f.supplierName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">No products match the current filters.</p>
      )}

      {showSettings && <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} />}
      {showTraining && <TrainingDialog onClose={() => setShowTraining(false)} />}
    </div>
  )
}
