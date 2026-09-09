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
import { boundSuffix, combineNetLinearFigureBounds, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'

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
// What a bounded figure on this page is allowed to say (o3d-la3n)
// ---------------------------------------------------------------------------

/**
 * EVERY `≤` ON THIS PAGE COMES FROM A `DerivedFigureBound`, AND FROM NOWHERE ELSE.
 *
 * Until o3d-la3n the fourteen marked figures here — four table cells, four footers, four colour
 * rules, the summary cards and the CSV's two bound columns — each derived their own mark, twelve of
 * them from `…RefundBasisComplete` and two from `netLinearFigureBound` over
 * `refundsGrossBasis + refundsUnknownBasis`. Both derivations print `≤` for a product credited
 * +£120 and −£120 on the gross basis: the boolean cannot say anything else, and the signed sum is
 * zero, which is not negative. The true figure in that case can sit £120 ABOVE the published one.
 *
 * The producer now classifies once, from the unrounded entries, and publishes the verdict. These
 * strings are the only thing left for the page to decide.
 */
const BOUND_TITLE = 'Upper bound: some of this product\u2019s refunds in this FY are on the gross basis or have no proven basis, so they are not subtracted here'
const BOUND_TITLE_SUMMARY = 'Upper bound: refunds on the gross basis or with no proven basis are not subtracted here'
const INDETERMINATE_TITLE = 'Direction not established: this product\u2019s unsubtracted credit includes a NEGATIVE entry, so the true figure may be either side of this one. The figure is shown; the relation is not claimed.'
const INDETERMINATE_TITLE_SUMMARY = 'Direction not established: the credit these totals could not subtract includes a NEGATIVE entry, so the true figure may be either side of this one. The figure is shown; the relation is not claimed.'

function boundTitle(bound: DerivedFigureBound, summary = false): string | undefined {
  if (bound === 'exact') return undefined
  if (bound === 'indeterminate') return summary ? INDETERMINATE_TITLE_SUMMARY : INDETERMINATE_TITLE
  return summary ? BOUND_TITLE_SUMMARY : BOUND_TITLE
}

/** The bound colour replaces any colouring that would read as a profit/loss verdict. */
function boundTone(bound: DerivedFigureBound): string {
  return bound === 'exact' ? '' : 'text-orange-600'
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColKey = 'sku' | 'name' | 'type' | 'lifecycleStatus' | 'totalStock'
  | 'salesPrice' | 'salePrice' | 'latestCogs' | 'unitMarginPct'
  | 'currentFyRevenue' | 'currentFyRefundsGrossBasis' | 'currentFyRefundsUnknownBasis' | 'currentFyCogs' | 'currentFyProfit' | 'currentFyQtySold'
  | 'previousFyRevenue' | 'previousFyRefundsGrossBasis' | 'previousFyRefundsUnknownBasis' | 'previousFyCogs' | 'previousFyProfit' | 'previousFyQtySold'

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
  // o3d-iigc: refund value the ex-VAT revenue above cannot absorb. Opt-in columns, so the default
  // view stays as it was for the overwhelming majority of products that have neither.
  { key: 'currentFyRefundsGrossBasis', label: 'Refunds (gross)', shortLabel: 'Refunds gross-basis (Current)', align: 'right', group: 'current' },
  { key: 'currentFyRefundsUnknownBasis', label: 'Refunds (basis ?)', shortLabel: 'Refunds basis unknown (Current)', align: 'right', group: 'current' },
  { key: 'currentFyCogs', label: 'COGS', shortLabel: 'COGS (Current)', align: 'right', group: 'current' },
  { key: 'currentFyProfit', label: 'Profit', shortLabel: 'Profit (Current)', align: 'right', group: 'current' },
  { key: 'currentFyQtySold', label: 'Qty', shortLabel: 'Qty (Current)', align: 'right', group: 'current' },
  { key: 'previousFyRevenue', label: 'Revenue', shortLabel: 'Revenue (Previous)', align: 'right', group: 'previous' },
  { key: 'previousFyRefundsGrossBasis', label: 'Refunds (gross)', shortLabel: 'Refunds gross-basis (Previous)', align: 'right', group: 'previous' },
  { key: 'previousFyRefundsUnknownBasis', label: 'Refunds (basis ?)', shortLabel: 'Refunds basis unknown (Previous)', align: 'right', group: 'previous' },
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
      currentFyRefundsGrossBasis: filtered.reduce((s, r) => s + r.currentFyRefundsGrossBasis, 0),
      currentFyRefundsUnknownBasis: filtered.reduce((s, r) => s + r.currentFyRefundsUnknownBasis, 0),
      // o3d-la3n: the SUBTOTAL'S OWN VERDICT, combined from the rows' published markers through the
      // shared rule. It is deliberately NOT `filtered.every(r => r.currentFyRefundBasisComplete)`:
      // that boolean has two values and this figure needs three. The row-level positive parts are
      // never published, so re-forming the signed sum here is not discouraged, it is impossible.
      currentFyRevenueBound: combineNetLinearFigureBounds(filtered.map((r) => r.currentFyRevenueBound)),
      currentFyCogs: filtered.reduce((s, r) => s + r.currentFyCogs, 0),
      currentFyProfit: filtered.reduce((s, r) => s + r.currentFyProfit, 0),
      previousFyRevenue: filtered.reduce((s, r) => s + r.previousFyRevenue, 0),
      previousFyRefundsGrossBasis: filtered.reduce((s, r) => s + r.previousFyRefundsGrossBasis, 0),
      previousFyRefundsUnknownBasis: filtered.reduce((s, r) => s + r.previousFyRefundsUnknownBasis, 0),
      previousFyRevenueBound: combineNetLinearFigureBounds(filtered.map((r) => r.previousFyRevenueBound)),
      previousFyCogs: filtered.reduce((s, r) => s + r.previousFyCogs, 0),
      previousFyProfit: filtered.reduce((s, r) => s + r.previousFyProfit, 0),
    }
  }, [filtered])

  // CSV export (all filtered rows, not just current page)
  function handleExport() {
    // o3d-iigc round 4: this page has NO server export route — this browser-built file IS its only
    // export, and it carried the same defect the analytics route did: ONE bound column, named after
    // Revenue, standing in front of a Profit column that is equally bounded and said nothing. Each
    // bounded figure now carries its own verdict immediately to its right, in the same vocabulary
    // the server CSV uses ('exact' / 'upper' / 'indeterminate'), so the two files read alike.
    // `Margin %` here is unitMarginPct — list price against latest COGS — which no refund touches,
    // so it is deliberately NOT marked.
    const header = ['SKU', 'Name', 'Type', 'Status', 'Stock', 'List Price', 'Sale Price', 'Latest COGS', 'Unit Margin', 'Margin %',
      `Revenue (${summary.fyLabel})`, `Revenue bound (${summary.fyLabel})`, `Refunds gross-basis (${summary.fyLabel})`, `Refunds basis unknown (${summary.fyLabel})`, `COGS (${summary.fyLabel})`, `Profit (${summary.fyLabel})`, `Profit bound (${summary.fyLabel})`, `Qty (${summary.fyLabel})`,
      `Revenue (${summary.prevFyLabel})`, `Revenue bound (${summary.prevFyLabel})`, `Refunds gross-basis (${summary.prevFyLabel})`, `Refunds basis unknown (${summary.prevFyLabel})`, `COGS (${summary.prevFyLabel})`, `Profit (${summary.prevFyLabel})`, `Profit bound (${summary.prevFyLabel})`, `Qty (${summary.prevFyLabel})`]
    const csvRows = filtered.map((r) => {
      // o3d-la3n: the PRODUCER'S verdict, not a re-derivation. These two columns were classified
      // here from `refundsGrossBasis + refundsUnknownBasis` — a SIGNED sum, one file downstream of
      // the entries and already rounded to two places by the time it arrived.
      const currentBound = r.currentFyRevenueBound
      const previousBound = r.previousFyRevenueBound
      return [
        r.sku, `"${r.name.replace(/"/g, '""')}"`, r.type, r.lifecycleStatus, r.totalStock,
        r.salesPrice ?? '', r.salePrice ?? '', r.latestCogs ?? '', r.unitMargin ?? '', r.unitMarginPct ?? '',
        r.currentFyRevenue, currentBound, r.currentFyRefundsGrossBasis, r.currentFyRefundsUnknownBasis, r.currentFyCogs, r.currentFyProfit, currentBound, r.currentFyQtySold,
        r.previousFyRevenue, previousBound, r.previousFyRefundsGrossBasis, r.previousFyRefundsUnknownBasis, r.previousFyCogs, r.previousFyProfit, previousBound, r.previousFyQtySold,
      ]
    })
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
      // o3d-iigc/o3d-la3n: where the FY refunds could not all be placed on the net basis this
      // figure is bounded — marked with the PRODUCER'S verdict, which can also say `?`.
      case 'currentFyRevenue': return <span className={`tabular-nums text-xs font-mono font-medium ${boundTone(r.currentFyRevenueBound)}`} title={boundTitle(r.currentFyRevenueBound)}>{r.currentFyRevenue > 0 ? fmtBase(r.currentFyRevenue) : '—'}{boundSuffix(r.currentFyRevenueBound)}</span>
      case 'currentFyRefundsGrossBasis': return <span className="tabular-nums text-xs font-mono text-orange-600" title="Refund value recorded on the GROSS basis — not comparable with this row's ex-VAT revenue, so it is excluded from it">{r.currentFyRefundsGrossBasis > 0 ? fmtBase(r.currentFyRefundsGrossBasis) : '—'}</span>
      case 'currentFyRefundsUnknownBasis': return <span className="tabular-nums text-xs font-mono text-orange-600" title="Refund value whose basis was never proved — excluded from revenue rather than guessed at">{r.currentFyRefundsUnknownBasis > 0 ? fmtBase(r.currentFyRefundsUnknownBasis) : '—'}</span>
      case 'currentFyCogs': return <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.currentFyCogs > 0 ? fmtBase(r.currentFyCogs) : '—'}</span>
      case 'currentFyProfit': return (
        <span className={`tabular-nums text-xs font-mono ${r.currentFyRevenueBound !== 'exact' ? 'text-orange-600' : r.currentFyProfit > 0 ? 'text-green-600' : r.currentFyProfit < 0 ? 'text-destructive' : ''}`} title={boundTitle(r.currentFyRevenueBound)}>
          {r.currentFyRevenue > 0 || r.currentFyCogs > 0 ? fmtBase(r.currentFyProfit) : '—'}{boundSuffix(r.currentFyRevenueBound)}
        </span>
      )
      case 'currentFyQtySold': return <span className="tabular-nums text-xs">{r.currentFyQtySold > 0 ? r.currentFyQtySold : '—'}</span>
      case 'previousFyRevenue': return <span className={`tabular-nums text-xs font-mono ${boundTone(r.previousFyRevenueBound)}`} title={boundTitle(r.previousFyRevenueBound)}>{r.previousFyRevenue > 0 ? fmtBase(r.previousFyRevenue) : '—'}{boundSuffix(r.previousFyRevenueBound)}</span>
      case 'previousFyRefundsGrossBasis': return <span className="tabular-nums text-xs font-mono text-orange-600" title="Refund value recorded on the GROSS basis — not comparable with this row's ex-VAT revenue, so it is excluded from it">{r.previousFyRefundsGrossBasis > 0 ? fmtBase(r.previousFyRefundsGrossBasis) : '—'}</span>
      case 'previousFyRefundsUnknownBasis': return <span className="tabular-nums text-xs font-mono text-orange-600" title="Refund value whose basis was never proved — excluded from revenue rather than guessed at">{r.previousFyRefundsUnknownBasis > 0 ? fmtBase(r.previousFyRefundsUnknownBasis) : '—'}</span>
      case 'previousFyCogs': return <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.previousFyCogs > 0 ? fmtBase(r.previousFyCogs) : '—'}</span>
      case 'previousFyProfit': return (
        <span className={`tabular-nums text-xs font-mono ${r.previousFyRevenueBound !== 'exact' ? 'text-orange-600' : r.previousFyProfit > 0 ? 'text-green-600' : r.previousFyProfit < 0 ? 'text-destructive' : ''}`} title={boundTitle(r.previousFyRevenueBound)}>
          {r.previousFyRevenue > 0 || r.previousFyCogs > 0 ? fmtBase(r.previousFyProfit) : '—'}{boundSuffix(r.previousFyRevenueBound)}
        </span>
      )
      case 'previousFyQtySold': return <span className="tabular-nums text-xs">{r.previousFyQtySold > 0 ? r.previousFyQtySold : '—'}</span>
    }
  }

  // Footer totals mapping
  const FOOTER_COLS: Partial<Record<ColKey, (s: typeof filteredSummary) => string>> = {
    currentFyRevenue: (s) => `${fmtBase(s.currentFyRevenue)}${boundSuffix(s.currentFyRevenueBound)}`,
    currentFyRefundsGrossBasis: (s) => fmtBase(s.currentFyRefundsGrossBasis),
    currentFyRefundsUnknownBasis: (s) => fmtBase(s.currentFyRefundsUnknownBasis),
    currentFyCogs: (s) => fmtBase(s.currentFyCogs),
    currentFyProfit: (s) => `${fmtBase(s.currentFyProfit)}${boundSuffix(s.currentFyRevenueBound)}`,
    previousFyRevenue: (s) => `${fmtBase(s.previousFyRevenue)}${boundSuffix(s.previousFyRevenueBound)}`,
    previousFyRefundsGrossBasis: (s) => fmtBase(s.previousFyRefundsGrossBasis),
    previousFyRefundsUnknownBasis: (s) => fmtBase(s.previousFyRefundsUnknownBasis),
    previousFyCogs: (s) => fmtBase(s.previousFyCogs),
    previousFyProfit: (s) => `${fmtBase(s.previousFyProfit)}${boundSuffix(s.previousFyRevenueBound)}`,
  }

  const FOOTER_TONE: Partial<Record<ColKey, (s: typeof filteredSummary) => string>> = {
    currentFyCogs: () => 'text-muted-foreground',
    previousFyCogs: () => 'text-muted-foreground',
    currentFyRefundsGrossBasis: () => 'text-orange-600',
    currentFyRefundsUnknownBasis: () => 'text-orange-600',
    previousFyRefundsGrossBasis: () => 'text-orange-600',
    previousFyRefundsUnknownBasis: () => 'text-orange-600',
    // o3d-iigc: an upper-bounded total is not a profit/loss verdict, so it does not get the
    // green/red treatment that would read as one.
    currentFyRevenue: (s) => boundTone(s.currentFyRevenueBound),
    previousFyRevenue: (s) => boundTone(s.previousFyRevenueBound),
    currentFyProfit: (s) => s.currentFyRevenueBound !== 'exact' ? 'text-orange-600' : s.currentFyProfit >= 0 ? 'text-green-600' : 'text-destructive',
    previousFyProfit: (s) => s.previousFyRevenueBound !== 'exact' ? 'text-orange-600' : s.previousFyProfit >= 0 ? 'text-green-600' : 'text-destructive',
  }

  /**
   * ONE CARD, SIX USES — the four bounded ones were four hand-written copies of the same three
   * ternaries off `…RefundBasisComplete`, which is exactly the shape that let o3d-7jfq fix one
   * reader of this rule and leave five behind (o3d-la3n).
   */
  function FyCard({ period, label, value, bound = 'exact', verdictTone = false, unplaced }: {
    period: string
    label: string
    value: number
    /** The producer's verdict for this figure. Omitted where no refund can move it (COGS). */
    bound?: DerivedFigureBound
    /** Colour the figure green/red as a profit verdict — dropped the moment it is not exact. */
    verdictTone?: boolean
    /** The two published bucket columns, shown underneath as how loose the bound is. */
    unplaced?: { gross: number; unknown: number }
  }) {
    const marked = bound !== 'exact'
    const title = boundTitle(bound, true)
    // o3d-la3n: the two bucket columns are the WIDTH of the bound only while no unplaced entry was
    // negative — which is exactly when the verdict is `upper`. Where it is `indeterminate`, +£120
    // and −£120 of gross-basis credit have already cancelled into the £0.00 this line would print,
    // and "£0.00 not subtracted" beside a figure that may be £120 out is the same defect wearing a
    // number.
    const widthKnown = bound === 'upper'
    return (
      <div className="rounded-md border p-3">
        <p className="text-[11px] text-muted-foreground">{period}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        <p
          className={`text-lg font-bold ${marked ? 'text-orange-600' : verdictTone ? (value >= 0 ? 'text-green-600' : 'text-destructive') : ''}`}
          title={title}
        >{fmtBase(value)}{boundSuffix(bound)}</p>
        {marked && unplaced && (
          <p className="text-[11px] text-orange-600 mt-0.5" title={title}>
            {widthKnown
              ? <>Not subtracted: {fmtBase(unplaced.gross)} gross &middot; {fmtBase(unplaced.unknown)} basis ?</>
              : 'Direction not established \u2014 some credit these totals could not subtract is negative'}
          </p>
        )}
      </div>
    )
  }

  const activeCols = ALL_COLUMNS.filter((c) => colSet.has(c.key))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
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
        <FyCard
          period={summary.fyLabel} label="Revenue" value={filteredSummary.currentFyRevenue}
          bound={filteredSummary.currentFyRevenueBound}
          unplaced={{ gross: filteredSummary.currentFyRefundsGrossBasis, unknown: filteredSummary.currentFyRefundsUnknownBasis }}
        />
        <FyCard period={summary.fyLabel} label="COGS" value={filteredSummary.currentFyCogs} />
        <FyCard
          period={summary.fyLabel} label="Profit" value={filteredSummary.currentFyProfit}
          bound={filteredSummary.currentFyRevenueBound} verdictTone
        />
        <FyCard
          period={summary.prevFyLabel} label="Revenue" value={filteredSummary.previousFyRevenue}
          bound={filteredSummary.previousFyRevenueBound}
          unplaced={{ gross: filteredSummary.previousFyRefundsGrossBasis, unknown: filteredSummary.previousFyRefundsUnknownBasis }}
        />
        <FyCard period={summary.prevFyLabel} label="COGS" value={filteredSummary.previousFyCogs} />
        <FyCard
          period={summary.prevFyLabel} label="Profit" value={filteredSummary.previousFyProfit}
          bound={filteredSummary.previousFyRevenueBound} verdictTone
        />
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
