'use client'

import { useState, useMemo, useEffect } from 'react'
import { Target, ArrowUp, ArrowDown, TrendingUp, TrendingDown, Minus, Download, Settings2, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatMoney } from '@/lib/utils'
import type { ProfitabilityRow, ProfitabilitySummary } from '@/app/actions/product-profitability'

type Props = {
  data: { rows: ProfitabilityRow[]; summary: ProfitabilitySummary }
}

type Band = 'all' | 'within' | 'above' | 'below' | 'no-data'
type SortDir = 'asc' | 'desc'

const LIFECYCLE_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'EOL', label: 'End of Life' },
  { value: 'ARCHIVED', label: 'Archived' },
] as const

const PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColKey = 'sku' | 'name' | 'type' | 'lifecycleStatus' | 'totalStock'
  | 'salesPrice' | 'salePrice' | 'latestCogs' | 'unitMarginPct'
  | 'currentFyRevenue' | 'currentFyCogs' | 'currentFyProfit' | 'currentFyQtySold'
  | 'previousFyRevenue' | 'previousFyCogs' | 'previousFyProfit' | 'previousFyQtySold'

type ColDef = { key: ColKey; label: string; shortLabel?: string; align?: 'right'; group?: string }

const ALL_COLUMNS: ColDef[] = [
  { key: 'sku', label: 'SKU' },
  { key: 'name', label: 'Product' },
  { key: 'type', label: 'Type' },
  { key: 'lifecycleStatus', label: 'Status' },
  { key: 'totalStock', label: 'Stock', align: 'right' },
  { key: 'salesPrice', label: 'List Price', align: 'right' },
  { key: 'salePrice', label: 'Sale Price', align: 'right' },
  { key: 'latestCogs', label: 'Latest COGS', align: 'right' },
  { key: 'unitMarginPct', label: 'Margin %', align: 'right' },
  { key: 'currentFyRevenue', label: 'Revenue', shortLabel: 'Revenue (Current)', align: 'right', group: 'current' },
  { key: 'currentFyCogs', label: 'COGS', shortLabel: 'COGS (Current)', align: 'right', group: 'current' },
  { key: 'currentFyProfit', label: 'Profit', shortLabel: 'Profit (Current)', align: 'right', group: 'current' },
  { key: 'currentFyQtySold', label: 'Qty', shortLabel: 'Qty (Current)', align: 'right', group: 'current' },
  { key: 'previousFyRevenue', label: 'Revenue', shortLabel: 'Revenue (Previous)', align: 'right', group: 'previous' },
  { key: 'previousFyCogs', label: 'COGS', shortLabel: 'COGS (Previous)', align: 'right', group: 'previous' },
  { key: 'previousFyProfit', label: 'Profit', shortLabel: 'Profit (Previous)', align: 'right', group: 'previous' },
  { key: 'previousFyQtySold', label: 'Qty', shortLabel: 'Qty (Previous)', align: 'right', group: 'previous' },
]

const DEFAULT_VISIBLE: ColKey[] = [
  'sku', 'name', 'lifecycleStatus', 'totalStock', 'unitMarginPct',
  'currentFyRevenue', 'currentFyProfit', 'currentFyQtySold',
]
const FIXED_COLS: ColKey[] = ['sku']
const LS_KEY = 'pp-report-cols'

function loadCols(): ColKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      const valid = new Set(ALL_COLUMNS.map((c) => c.key))
      const filtered = arr.filter((k) => valid.has(k as ColKey)) as ColKey[]
      if (filtered.length > 0) return filtered
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function ProductProfitabilityClient({ data }: Props) {
  const { rows, summary } = data
  const baseCurrency = useBaseCurrency()
  const fmtBase = (v: number) => formatMoney(v, baseCurrency.symbol, baseCurrency.symbolPosition)

  // Profitability target
  const [targetPct, setTargetPct] = useState(30)
  const [tolerancePct, setTolerancePct] = useState(5)

  // Filters
  const [band, setBand] = useState<Band>('all')
  const [lifecycleFilter, setLifecycleFilter] = useState<Set<string>>(new Set(['ACTIVE']))
  const [hideOutOfStock, setHideOutOfStock] = useState(false)

  // Sort
  const [sortCol, setSortCol] = useState<string>('currentFyRevenue')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Pagination
  const [page, setPage] = useState(0)

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<ColKey[]>(loadCols)
  const [showColPicker, setShowColPicker] = useState(false)
  const [pickerDraft, setPickerDraft] = useState<Set<ColKey>>(new Set(visibleCols))
  const colSet = new Set(visibleCols)

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(visibleCols)) } catch { /* ignore */ }
  }, [visibleCols])

  function openColPicker() {
    setPickerDraft(new Set(visibleCols))
    setShowColPicker(true)
  }

  function applyColPicker() {
    const ordered = ALL_COLUMNS.map((c) => c.key).filter((k) => pickerDraft.has(k))
    setVisibleCols(ordered)
    setShowColPicker(false)
  }

  function togglePickerCol(key: ColKey) {
    setPickerDraft((prev) => {
      const n = new Set(prev)
      if (FIXED_COLS.includes(key)) return n
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })
  }

  function handleSort(key: string) {
    if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(key); setSortDir('desc') }
  }

  function toggleLifecycle(value: string) {
    setLifecycleFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
    setPage(0)
  }

  // Classify each row into a band
  function getBand(row: ProfitabilityRow): Band {
    if (row.unitMarginPct == null) return 'no-data'
    const lower = targetPct - tolerancePct
    const upper = targetPct + tolerancePct
    if (row.unitMarginPct >= lower && row.unitMarginPct <= upper) return 'within'
    if (row.unitMarginPct > upper) return 'above'
    return 'below'
  }

  // Filter + sort
  const filtered = useMemo(() => {
    let result = rows.filter((r) => {
      if (lifecycleFilter.size > 0 && !lifecycleFilter.has(r.lifecycleStatus)) return false
      if (hideOutOfStock && r.totalStock <= 0) return false
      if (band !== 'all' && getBand(r) !== band) return false
      return true
    })

    result = [...result].sort((a, b) => {
      const va = getVal(a, sortCol)
      const vb = getVal(b, sortCol)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })

    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, band, lifecycleFilter, hideOutOfStock, sortCol, sortDir, targetPct, tolerancePct])

  // Reset page when filters change
  useEffect(() => { setPage(0) }, [band, hideOutOfStock, targetPct, tolerancePct, sortCol, sortDir])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageStart = safePage * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filtered.length)
  const pageRows = filtered.slice(pageStart, pageEnd)

  // Band counts (always computed on lifecycle+stock-filtered set, ignoring band filter)
  const bandCounts = useMemo(() => {
    const base = rows.filter((r) => {
      if (lifecycleFilter.size > 0 && !lifecycleFilter.has(r.lifecycleStatus)) return false
      if (hideOutOfStock && r.totalStock <= 0) return false
      return true
    })
    const counts = { all: base.length, within: 0, above: 0, below: 0, 'no-data': 0 }
    for (const r of base) {
      const b = getBand(r)
      counts[b]++
    }
    return counts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, lifecycleFilter, hideOutOfStock, targetPct, tolerancePct])

  // Filtered summary (across ALL filtered rows, not just current page)
  const filteredSummary = useMemo(() => {
    return {
      currentFyRevenue: filtered.reduce((s, r) => s + r.currentFyRevenue, 0),
      currentFyCogs: filtered.reduce((s, r) => s + r.currentFyCogs, 0),
      currentFyProfit: filtered.reduce((s, r) => s + r.currentFyProfit, 0),
      previousFyRevenue: filtered.reduce((s, r) => s + r.previousFyRevenue, 0),
      previousFyCogs: filtered.reduce((s, r) => s + r.previousFyCogs, 0),
      previousFyProfit: filtered.reduce((s, r) => s + r.previousFyProfit, 0),
    }
  }, [filtered])

  // CSV export (all filtered rows, not just current page)
  function handleExport() {
    const header = ['SKU', 'Name', 'Type', 'Status', 'Stock', 'List Price', 'Sale Price', 'Latest COGS', 'Unit Margin', 'Margin %',
      `Revenue (${summary.fyLabel})`, `COGS (${summary.fyLabel})`, `Profit (${summary.fyLabel})`, `Qty (${summary.fyLabel})`,
      `Revenue (${summary.prevFyLabel})`, `COGS (${summary.prevFyLabel})`, `Profit (${summary.prevFyLabel})`, `Qty (${summary.prevFyLabel})`]
    const csvRows = filtered.map((r) => [
      r.sku, `"${r.name.replace(/"/g, '""')}"`, r.type, r.lifecycleStatus, r.totalStock,
      r.salesPrice ?? '', r.salePrice ?? '', r.latestCogs ?? '', r.unitMargin ?? '', r.unitMarginPct ?? '',
      r.currentFyRevenue, r.currentFyCogs, r.currentFyProfit, r.currentFyQtySold,
      r.previousFyRevenue, r.previousFyCogs, r.previousFyProfit, r.previousFyQtySold,
    ])
    const csv = [header.join(','), ...csvRows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'product-profitability.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  // Build column label with FY period for grouped columns
  function colLabel(col: ColDef): string {
    if (col.group === 'current') return `${col.label} (${summary.fyLabel})`
    if (col.group === 'previous') return `${col.label} (${summary.prevFyLabel})`
    if (col.key === 'salesPrice' || col.key === 'salePrice' || col.key === 'latestCogs') return `${col.label} (${baseCurrency.code})`
    return col.label
  }

  // Column header
  function ColHeader({ colKey, label, align }: { colKey: string; label: string; align?: 'right' | 'left' }) {
    return (
      <TableHead
        className={`text-xs cursor-pointer hover:text-foreground select-none whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
        onClick={() => handleSort(colKey)}
      >
        <span className="inline-flex items-center gap-0.5">
          {label}
          {sortCol === colKey && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
        </span>
      </TableHead>
    )
  }

  function MarginBadge({ row }: { row: ProfitabilityRow }) {
    if (row.unitMarginPct == null) return <span className="text-xs text-muted-foreground">—</span>
    const b = getBand(row)
    const cls = b === 'above' ? 'bg-green-100 text-green-700'
      : b === 'below' ? 'bg-red-100 text-red-700'
      : b === 'within' ? 'bg-blue-100 text-blue-700'
      : 'bg-gray-100 text-gray-500'
    return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${cls}`}>{row.unitMarginPct}%</span>
  }

  // Render cell content for a given column key
  function renderCell(r: ProfitabilityRow, key: ColKey) {
    switch (key) {
      case 'sku': return <ProductLink productId={r.productId} sku={r.sku} name="" />
      case 'name': return <span className="text-xs truncate max-w-48 block">{r.name}</span>
      case 'type': return <span className="text-xs">{r.type}</span>
      case 'lifecycleStatus': return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
          r.lifecycleStatus === 'ACTIVE' ? 'bg-green-100 text-green-700'
          : r.lifecycleStatus === 'ARCHIVED' ? 'bg-gray-100 text-gray-500'
          : 'bg-orange-100 text-orange-700'
        }`}>{r.lifecycleStatus}</span>
      )
      case 'totalStock': return <span className={`tabular-nums text-xs ${r.totalStock <= 0 ? 'text-destructive' : ''}`}>{r.totalStock}</span>
      case 'salesPrice': return <span className="tabular-nums text-xs font-mono">{r.salesPrice != null ? fmtBase(r.salesPrice) : '—'}</span>
      case 'salePrice': return <span className="tabular-nums text-xs font-mono">{r.salePrice != null ? fmtBase(r.salePrice) : '—'}</span>
      case 'latestCogs': return <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.latestCogs != null ? fmtBase(r.latestCogs) : '—'}</span>
      case 'unitMarginPct': return <MarginBadge row={r} />
      case 'currentFyRevenue': return <span className="tabular-nums text-xs font-mono font-medium">{r.currentFyRevenue > 0 ? fmtBase(r.currentFyRevenue) : '—'}</span>
      case 'currentFyCogs': return <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.currentFyCogs > 0 ? fmtBase(r.currentFyCogs) : '—'}</span>
      case 'currentFyProfit': return (
        <span className={`tabular-nums text-xs font-mono ${r.currentFyProfit > 0 ? 'text-green-600' : r.currentFyProfit < 0 ? 'text-destructive' : ''}`}>
          {r.currentFyRevenue > 0 || r.currentFyCogs > 0 ? fmtBase(r.currentFyProfit) : '—'}
        </span>
      )
      case 'currentFyQtySold': return <span className="tabular-nums text-xs">{r.currentFyQtySold > 0 ? r.currentFyQtySold : '—'}</span>
      case 'previousFyRevenue': return <span className="tabular-nums text-xs font-mono">{r.previousFyRevenue > 0 ? fmtBase(r.previousFyRevenue) : '—'}</span>
      case 'previousFyCogs': return <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.previousFyCogs > 0 ? fmtBase(r.previousFyCogs) : '—'}</span>
      case 'previousFyProfit': return (
        <span className={`tabular-nums text-xs font-mono ${r.previousFyProfit > 0 ? 'text-green-600' : r.previousFyProfit < 0 ? 'text-destructive' : ''}`}>
          {r.previousFyRevenue > 0 || r.previousFyCogs > 0 ? fmtBase(r.previousFyProfit) : '—'}
        </span>
      )
      case 'previousFyQtySold': return <span className="tabular-nums text-xs">{r.previousFyQtySold > 0 ? r.previousFyQtySold : '—'}</span>
    }
  }

  // Footer totals mapping
  const FOOTER_COLS: Partial<Record<ColKey, (s: typeof filteredSummary) => string>> = {
    currentFyRevenue: (s) => fmtBase(s.currentFyRevenue),
    currentFyCogs: (s) => fmtBase(s.currentFyCogs),
    currentFyProfit: (s) => fmtBase(s.currentFyProfit),
    previousFyRevenue: (s) => fmtBase(s.previousFyRevenue),
    previousFyCogs: (s) => fmtBase(s.previousFyCogs),
    previousFyProfit: (s) => fmtBase(s.previousFyProfit),
  }

  const FOOTER_TONE: Partial<Record<ColKey, (s: typeof filteredSummary) => string>> = {
    currentFyCogs: () => 'text-muted-foreground',
    previousFyCogs: () => 'text-muted-foreground',
    currentFyProfit: (s) => s.currentFyProfit >= 0 ? 'text-green-600' : 'text-destructive',
    previousFyProfit: (s) => s.previousFyProfit >= 0 ? 'text-green-600' : 'text-destructive',
  }

  const activeCols = ALL_COLUMNS.filter((c) => colSet.has(c.key))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Product Profitability</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8" onClick={openColPicker} title="Column settings">
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleExport}>
            <Download className="h-3 w-3 mr-1" />Export CSV
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.fyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Revenue</p>
          <p className="text-lg font-bold">{fmtBase(filteredSummary.currentFyRevenue)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.fyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">COGS</p>
          <p className="text-lg font-bold">{fmtBase(filteredSummary.currentFyCogs)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.fyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Profit</p>
          <p className={`text-lg font-bold ${filteredSummary.currentFyProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>{fmtBase(filteredSummary.currentFyProfit)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.prevFyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Revenue</p>
          <p className="text-lg font-bold">{fmtBase(filteredSummary.previousFyRevenue)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.prevFyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">COGS</p>
          <p className="text-lg font-bold">{fmtBase(filteredSummary.previousFyCogs)}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-[11px] text-muted-foreground">{summary.prevFyLabel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Profit</p>
          <p className={`text-lg font-bold ${filteredSummary.previousFyProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>{fmtBase(filteredSummary.previousFyProfit)}</p>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex flex-wrap items-end gap-4 rounded-md border p-3 bg-muted/30">
        {/* Profitability target */}
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><Target className="h-3 w-3" />Target Margin %</Label>
            <Input
              type="number" min={0} max={100} step={1}
              value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))}
              className="h-8 w-20 text-xs tabular-nums"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tolerance &plusmn;%</Label>
            <Input
              type="number" min={0} max={50} step={1}
              value={tolerancePct} onChange={(e) => setTolerancePct(Number(e.target.value))}
              className="h-8 w-20 text-xs tabular-nums"
            />
          </div>
          <span className="text-[11px] text-muted-foreground pb-1.5">
            Range: {targetPct - tolerancePct}% – {targetPct + tolerancePct}%
          </span>
        </div>

        <div className="h-8 w-px bg-border" />

        {/* Lifecycle filter */}
        <div className="space-y-1">
          <Label className="text-xs">Product Status</Label>
          <div className="flex gap-1">
            {LIFECYCLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleLifecycle(opt.value)}
                className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
                  lifecycleFilter.has(opt.value)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-input hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-8 w-px bg-border" />

        {/* Out of stock toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer pb-1">
          <input
            type="checkbox"
            checked={hideOutOfStock}
            onChange={(e) => { setHideOutOfStock(e.target.checked); setPage(0) }}
            className="rounded border-input"
          />
          <span className="text-xs">Hide out of stock</span>
        </label>
      </div>

      {/* Band tabs */}
      <div className="flex gap-1 border-b">
        {([
          { key: 'all' as Band, label: 'All Products', icon: null },
          { key: 'above' as Band, label: 'Above Target', icon: TrendingUp },
          { key: 'within' as Band, label: 'Within Target', icon: Minus },
          { key: 'below' as Band, label: 'Below Target', icon: TrendingDown },
          { key: 'no-data' as Band, label: 'No Data', icon: null },
        ]).map((t) => {
          const active = band === t.key
          const Icon = t.icon
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setBand(t.key); setPage(0) }}
              className={`shrink-0 flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {t.label}
              <span className={`ml-1 text-[10px] rounded-full px-1.5 py-0.5 ${active ? 'bg-primary/10' : 'bg-muted'}`}>
                {bandCounts[t.key]}
              </span>
            </button>
          )
        })}
      </div>

      {/* Data table */}
      <div className="rounded-md border">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs text-muted-foreground">
            {filtered.length > 0
              ? `${pageStart + 1}–${pageEnd} of ${filtered.length} products`
              : `0 of ${rows.length} products`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground px-1">
                {safePage + 1} / {totalPages}
              </span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        <Table containerClassName="max-h-[calc(100vh-20rem)]">
          <TableHeader className="bg-muted/50 [&_th]:bg-muted/95">
            <TableRow>
              {activeCols.map((col) => (
                <ColHeader key={col.key} colKey={col.key} label={colLabel(col)} align={col.align} />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {pageRows.map((r) => (
              <TableRow key={r.productId}>
                {activeCols.map((col) => (
                  <TableCell key={col.key} className={col.align === 'right' ? 'text-right' : ''}>
                    {renderCell(r, col.key)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <tfoot className="border-t bg-muted/30 text-sm font-medium">
            <tr>
              {activeCols.map((col, i) => {
                const fn = FOOTER_COLS[col.key]
                if (i === 0) return <td key={col.key} className="px-3 py-2"><span>Totals</span></td>
                if (!fn) return <td key={col.key} />
                const tone = FOOTER_TONE[col.key]
                return (
                  <td key={col.key} className="px-3 py-2 text-right">
                    <span className={`tabular-nums font-mono ${tone ? tone(filteredSummary) : ''}`}>
                      {fn(filteredSummary)}
                    </span>
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </Table>
        {filtered.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No products match the current filters.</p>}
        {/* Bottom pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-t">
            <span className="text-xs text-muted-foreground">
              {pageStart + 1}–{pageEnd} of {filtered.length}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground px-1">
                {safePage + 1} / {totalPages}
              </span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Column picker dialog */}
      <Dialog open={showColPicker} onOpenChange={setShowColPicker}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Visible Columns</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-1 py-2">
            {ALL_COLUMNS.map((c) => {
              const fixed = FIXED_COLS.includes(c.key)
              const checked = pickerDraft.has(c.key)
              return (
                <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={fixed}
                    onChange={() => togglePickerCol(c.key)}
                    className="accent-primary h-3.5 w-3.5"
                  />
                  <span className={fixed ? 'text-muted-foreground' : ''}>{c.shortLabel ?? c.label}</span>
                </label>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setPickerDraft(new Set(DEFAULT_VISIBLE)); }}>Reset</Button>
            <Button variant="outline" size="sm" onClick={() => setShowColPicker(false)}>Cancel</Button>
            <Button size="sm" onClick={applyColPicker}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVal(row: any, field: string): string | number | null {
  const v = row[field]
  return v === undefined ? null : v
}
