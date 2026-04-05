'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Settings2, Save, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import { saveView, deleteView, type SalesStatRow, type SalesStatSummary, type ShipmentRow, type InvoiceRow, type RefundRow, type CustomerAgingRow, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'products' | 'shipments' | 'invoices' | 'refunds' | 'aging'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'

type Props = {
  productStats: { rows: SalesStatRow[]; summary: SalesStatSummary }
  shipments: ShipmentRow[]
  invoices: InvoiceRow[]
  refunds: RefundRow[]
  aging: CustomerAgingRow[]
  savedViews: SavedView[]
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'aging', label: 'Customer Aging' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// All filterable fields for the Products tab
const PRODUCT_FIELDS = [
  { key: 'sku', label: 'SKU', type: 'text' as const },
  { key: 'name', label: 'Product Name', type: 'text' as const },
  { key: 'type', label: 'Product Type', type: 'select' as const, options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' as const },
  { key: 'barcode', label: 'Barcode', type: 'text' as const },
  { key: 'active', label: 'Active', type: 'select' as const, options: ['true', 'false'] },
  { key: 'qtySold', label: 'Qty Sold', type: 'number' as const },
  { key: 'qtyRefunded', label: 'Qty Refunded', type: 'number' as const },
  { key: 'netQty', label: 'Net Qty', type: 'number' as const },
  { key: 'grossRevenue', label: 'Gross Revenue (£)', type: 'number' as const },
  { key: 'discounts', label: 'Discounts (£)', type: 'number' as const },
  { key: 'refunds', label: 'Refunds (£)', type: 'number' as const },
  { key: 'netRevenue', label: 'Net Revenue (£)', type: 'number' as const },
  { key: 'cogs', label: 'COGS (£)', type: 'number' as const },
  { key: 'grossProfit', label: 'Gross Profit (£)', type: 'number' as const },
  { key: 'marginPct', label: 'Margin %', type: 'number' as const },
  { key: 'orderCount', label: 'Order Count', type: 'number' as const },
  { key: 'avgOrderValue', label: 'Avg Order Value (£)', type: 'number' as const },
  { key: 'salesPrice', label: 'Sales Price (£)', type: 'number' as const },
  { key: 'weight', label: 'Weight (kg)', type: 'number' as const },
]

const TEXT_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'not_contains', label: 'does not contain' },
]

const NUMBER_OPERATORS = [
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
]

const SELECT_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
]

function getOperators(fieldKey: string) {
  const f = PRODUCT_FIELDS.find((pf) => pf.key === fieldKey)
  if (f?.type === 'number') return NUMBER_OPERATORS
  if (f?.type === 'select') return SELECT_OPERATORS
  return TEXT_OPERATORS
}

function getFieldOptions(fieldKey: string) {
  return PRODUCT_FIELDS.find((pf) => pf.key === fieldKey)?.options
}

function applyFilter(value: string | number | null | boolean, rule: FilterRule): boolean {
  const v = value == null ? '' : String(value).toLowerCase()
  const rv = rule.value.toLowerCase()
  switch (rule.operator) {
    case 'contains': return v.includes(rv)
    case 'equals': case 'is': return v === rv
    case 'starts_with': return v.startsWith(rv)
    case 'not_contains': return !v.includes(rv)
    case 'is_not': return v !== rv
    case '>': return Number(value) > Number(rule.value)
    case '>=': return Number(value) >= Number(rule.value)
    case '<': return Number(value) < Number(rule.value)
    case '<=': return Number(value) <= Number(rule.value)
    case '=': return Number(value) === Number(rule.value)
    case '!=': return Number(value) !== Number(rule.value)
    default: return true
  }
}

function getFieldValue(row: SalesStatRow, field: string): string | number | null | boolean {
  switch (field) {
    case 'sku': return row.sku
    case 'name': return row.name
    case 'type': return row.type
    case 'stockUnit': return row.stockUnit
    case 'barcode': return row.barcode
    case 'active': return String(row.active)
    case 'qtySold': return row.qtySold
    case 'qtyRefunded': return row.qtyRefunded
    case 'netQty': return row.netQty
    case 'grossRevenue': return row.grossRevenue
    case 'discounts': return row.discounts
    case 'refunds': return row.refunds
    case 'netRevenue': return row.netRevenue
    case 'cogs': return row.cogs
    case 'grossProfit': return row.grossProfit
    case 'marginPct': return row.marginPct
    case 'orderCount': return row.orderCount
    case 'avgOrderValue': return row.avgOrderValue
    case 'salesPrice': return row.salesPrice
    case 'weight': return row.weight
    default: return null
  }
}

// Default visible columns
const DEFAULT_COLS = ['sku', 'name', 'qtySold', 'netQty', 'grossRevenue', 'discounts', 'netRevenue', 'cogs', 'grossProfit', 'marginPct', 'orderCount']

// ---------------------------------------------------------------------------
// Filter Dialog
// ---------------------------------------------------------------------------
function FilterDialog({ rules, onApply, onClose }: { rules: FilterRule[]; onApply: (rules: FilterRule[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<FilterRule[]>(rules.length ? [...rules] : [])

  function addRule() { setLocal((prev) => [...prev, { id: makeId(), field: 'sku', operator: 'contains', value: '' }]) }
  function removeRule(id: string) { setLocal((prev) => prev.filter((r) => r.id !== id)) }
  function updateRule(id: string, updates: Partial<FilterRule>) {
    setLocal((prev) => prev.map((r) => r.id === id ? { ...r, ...updates } : r))
  }

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl">
      <DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
      <div className="space-y-3 min-h-[200px]">
        {local.map((rule) => {
          const ops = getOperators(rule.field)
          const options = getFieldOptions(rule.field)
          return (
            <div key={rule.id} className="flex items-center gap-2">
              <select value={rule.field} onChange={(e) => { const f = e.target.value; const newOps = getOperators(f); updateRule(rule.id, { field: f, operator: newOps[0].value, value: '' }) }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">
                {PRODUCT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <select value={rule.operator} onChange={(e) => updateRule(rule.id, { operator: e.target.value })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs w-36">
                {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {options ? (
                <select value={rule.value} onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="">Select…</option>
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <Input value={rule.value} onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                  placeholder="Value" className="flex-1 h-8 text-xs" />
              )}
              <button type="button" onClick={() => removeRule(rule.id)} className="text-destructive hover:text-destructive/80 shrink-0">
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
        <button type="button" onClick={addRule}
          className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
          <Plus className="h-3 w-3" />Add Filter
        </button>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => { onApply([]); onClose() }}>Reset</Button>
        <Button onClick={() => { onApply(local.filter((r) => r.value)); onClose() }}>Apply</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Column Picker Dialog
// ---------------------------------------------------------------------------
function ColumnPickerDialog({ visible, onApply, onClose }: { visible: string[]; onApply: (cols: string[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Set<string>>(new Set(visible))
  function toggle(key: string) { setLocal((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n }) }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
      <DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {PRODUCT_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1">
            <input type="checkbox" checked={local.has(f.key)} onChange={() => toggle(f.key)} className="rounded border-input" />
            {f.label}
          </label>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onApply(Array.from(local)); onClose() }}>Apply</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Save View Dialog
// ---------------------------------------------------------------------------
function SaveViewDialog({ tab, columns, filters, onClose }: { tab: string; columns: string[]; filters: FilterRule[]; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  function handleSave() {
    if (!name.trim()) return
    startTransition(async () => {
      await saveView({ id: makeId(), name, tab, columns, filters: filters.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) })
      router.refresh()
      onClose()
    })
  }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
      <DialogHeader><DialogTitle>Save View</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5"><Label>View Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Top Products by Margin" className="h-9" autoFocus /></div>
        <p className="text-xs text-muted-foreground">Saves the current tab, visible columns, and active filters.</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleSave} disabled={isPending || !name.trim()}>{isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function SalesStatsClient({ productStats, shipments, invoices, refunds, aging, savedViews }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_COLS)
  const [showFilterDialog, setShowFilterDialog] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showSaveView, setShowSaveView] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const { rows, summary } = productStats

  function handleSort(key: string) {
    if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(key); setSortDir('desc') }
  }

  function loadView(view: SavedView) {
    setTab(view.tab as Tab)
    setVisibleCols(view.columns)
    setFilterRules(view.filters.map((f) => ({ ...f, id: makeId() })))
  }

  function handleDeleteView(viewId: string) {
    startTransition(async () => { await deleteView(viewId); router.refresh() })
  }

  // Apply filters to product data
  const filteredProducts = useMemo(() => {
    let result = rows
    for (const rule of filterRules) {
      if (!rule.value) continue
      result = result.filter((row) => applyFilter(getFieldValue(row, rule.field), rule))
    }
    if (sortCol) {
      result = [...result].sort((a, b) => {
        const va = getFieldValue(a, sortCol) ?? 0
        const vb = getFieldValue(b, sortCol) ?? 0
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return result
  }, [rows, filterRules, sortCol, sortDir])

  // Build column renderers for visible columns only
  const colRenderers: Record<string, { label: string; align: string; render: (r: SalesStatRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
    sku: { label: 'SKU', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name="" />, footer: () => <span>Totals</span> },
    name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-40 block">{r.name}</span> },
    type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
    stockUnit: { label: 'Unit', align: 'left', render: (r) => <span className="text-xs">{r.stockUnit}</span> },
    barcode: { label: 'Barcode', align: 'left', render: (r) => <span className="text-xs font-mono">{r.barcode ?? '—'}</span> },
    active: { label: 'Active', align: 'left', render: (r) => <span className="text-xs">{r.active ? 'Yes' : 'No'}</span> },
    qtySold: { label: 'Sold', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.qtySold}</span>, footer: () => <span className="tabular-nums">{summary.totalQtySold}</span> },
    qtyRefunded: { label: 'Refunded', align: 'right', render: (r) => <span className="tabular-nums text-xs text-orange-600">{r.qtyRefunded > 0 ? r.qtyRefunded : '—'}</span> },
    netQty: { label: 'Net Qty', align: 'right', render: (r) => <span className="tabular-nums text-xs font-medium">{r.netQty}</span> },
    grossRevenue: { label: 'Gross Rev', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.grossRevenue)}</span>, footer: () => <span className="tabular-nums font-mono">{fmtGbp(summary.totalGrossRevenue)}</span> },
    discounts: { label: 'Discounts', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono text-destructive">{r.discounts > 0 ? fmtGbp(r.discounts) : '—'}</span>, footer: () => <span className="tabular-nums font-mono text-destructive">{fmtGbp(summary.totalDiscounts)}</span> },
    refunds: { label: 'Refunds', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono text-orange-600">{r.refunds > 0 ? fmtGbp(r.refunds) : '—'}</span>, footer: () => <span className="tabular-nums font-mono text-orange-600">{fmtGbp(summary.totalRefunds)}</span> },
    netRevenue: { label: 'Net Revenue', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono font-medium">{fmtGbp(r.netRevenue)}</span>, footer: () => <span className="tabular-nums font-mono">{fmtGbp(summary.totalNetRevenue)}</span> },
    cogs: { label: 'COGS', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.cogs > 0 ? fmtGbp(r.cogs) : '—'}</span>, footer: () => <span className="tabular-nums font-mono text-muted-foreground">{fmtGbp(summary.totalCogs)}</span> },
    grossProfit: { label: 'Profit', align: 'right', render: (r) => <span className={`tabular-nums text-xs font-mono ${r.grossProfit >= 0 ? 'text-green-600' : 'text-destructive'}`}>{fmtGbp(r.grossProfit)}</span>, footer: () => <span className="tabular-nums font-mono text-green-600">{fmtGbp(summary.totalGrossProfit)}</span> },
    marginPct: { label: 'Margin', align: 'right', render: (r) => <span className={`tabular-nums text-xs ${r.marginPct < 0 ? 'text-destructive' : ''}`}>{r.marginPct}%</span>, footer: () => <span className="tabular-nums">{summary.avgMarginPct}%</span> },
    orderCount: { label: 'Orders', align: 'right', render: (r) => <span className="tabular-nums text-xs text-muted-foreground">{r.orderCount}</span>, footer: () => <span className="tabular-nums text-muted-foreground">{summary.totalOrders}</span> },
    avgOrderValue: { label: 'Avg Order', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.avgOrderValue)}</span>, footer: () => <span className="tabular-nums font-mono">{fmtGbp(summary.avgOrderValue)}</span> },
    salesPrice: { label: 'List Price', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{r.salesPrice != null ? fmtGbp(r.salesPrice) : '—'}</span> },
    weight: { label: 'Weight', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.weight != null ? `${r.weight}kg` : '—'}</span> },
  }

  // Simple table renderers for other tabs (reuse existing patterns with search filter)
  const [otherSearch, setOtherSearch] = useState('')
  const oq = otherSearch.toLowerCase()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sales Statistics</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Net Revenue</p><p className="text-xl font-bold">{fmtGbp(summary.totalNetRevenue)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">COGS</p><p className="text-xl font-bold">{fmtGbp(summary.totalCogs)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Gross Profit</p><p className="text-xl font-bold text-green-600">{fmtGbp(summary.totalGrossProfit)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Avg Margin</p><p className="text-xl font-bold">{summary.avgMarginPct}%</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Orders / Qty</p><p className="text-xl font-bold">{summary.totalOrders} / {summary.totalQtySold}</p></div>
      </div>

      {/* Tabs + actions */}
      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.key} type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 pb-1">
          {/* Saved views dropdown */}
          {savedViews.length > 0 && (
            <select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue="">
              <option value="" disabled>Saved Views…</option>
              {savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          {tab === 'products' && (
            <>
              <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilterDialog(true)}>
                <Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}>
                <Settings2 className="h-3 w-3 mr-0.5" />Columns
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}>
                <Save className="h-3 w-3 mr-0.5" />Save View
              </Button>
            </>
          )}
          {tab !== 'products' && (
            <Input placeholder="Search…" value={otherSearch} onChange={(e) => setOtherSearch(e.target.value)} className="h-7 text-xs w-48" />
          )}
        </div>
      </div>

      {/* Products tab with dynamic columns */}
      {tab === 'products' && (
        <div className="rounded-md border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
            <span className="text-xs text-muted-foreground">{filteredProducts.length} of {rows.length} products</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50">
                <tr>
                  {visibleCols.map((key) => {
                    const col = colRenderers[key]
                    if (!col) return null
                    return (
                      <th key={key} className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                        onClick={() => handleSort(key)}>
                        <span className="inline-flex items-center gap-0.5">{col.label}{sortCol === key && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredProducts.map((r) => (
                  <tr key={r.productId} className="hover:bg-muted/30">
                    {visibleCols.map((key) => {
                      const col = colRenderers[key]
                      if (!col) return null
                      return <td key={key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>{col.render(r)}</td>
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-muted/30 text-sm font-medium">
                <tr>
                  {visibleCols.map((key) => {
                    const col = colRenderers[key]
                    if (!col) return null
                    return <td key={key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>{col.footer?.() ?? ''}</td>
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Other tabs — simple searchable tables */}
      {tab === 'shipments' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Shipped</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Service</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Tracking</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Warehouse</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
        </tr></thead><tbody className="divide-y">
          {shipments.filter((s) => !oq || s.orderNumber.toLowerCase().includes(oq) || s.customerName.toLowerCase().includes(oq)).map((s) => (
            <tr key={s.orderId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${s.orderId}`} className="hover:underline">{s.orderNumber}</Link></td>
              <td className="px-3 py-2 text-xs">{s.customerName}</td><td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(s.shippedAt)}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{s.shippingService ?? '—'}</td>
              <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{s.trackingNumber ?? '—'}</td>
              <td className="px-3 py-2 text-xs">{s.warehouse ?? '—'}</td>
              <td className="px-3 py-2 text-right text-xs font-mono">{fmtGbp(s.totalGbp)}</td>
            </tr>))}
        </tbody></table>{shipments.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No shipments found.</p>}</div>
      )}

      {tab === 'invoices' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Paid</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Balance</th>
        </tr></thead><tbody className="divide-y">
          {invoices.filter((i) => !oq || i.invoiceNumber.toLowerCase().includes(oq) || i.customerName.toLowerCase().includes(oq)).map((i) => (
            <tr key={i.orderId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs font-medium">{i.invoiceNumber}</td>
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${i.orderId}`} className="hover:underline">{i.orderNumber}</Link></td>
              <td className="px-3 py-2 text-xs">{i.customerName}</td><td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(i.invoicedAt)}</td>
              <td className="px-3 py-2 text-right text-xs font-mono">{fmtGbp(i.totalGbp)}</td>
              <td className="px-3 py-2 text-xs">{i.paidAt ? <span className="text-green-600">{fmtDate(i.paidAt)}</span> : <span className="text-orange-600">Unpaid</span>}</td>
              <td className="px-3 py-2 text-right text-xs font-mono"><span className={i.balance > 0.01 ? 'text-destructive font-medium' : 'text-green-600'}>{i.balance > 0.01 ? fmtGbp(i.balance) : 'Settled'}</span></td>
            </tr>))}
        </tbody></table>{invoices.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No invoices found.</p>}</div>
      )}

      {tab === 'refunds' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Credit Note</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Order</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th><th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Reason</th><th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Amount</th>
        </tr></thead><tbody className="divide-y">
          {refunds.filter((r) => !oq || (r.creditNoteNumber ?? '').toLowerCase().includes(oq) || r.customerName.toLowerCase().includes(oq)).map((r) => (
            <tr key={r.id} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs font-medium">{r.creditNoteNumber ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/sales/${r.orderId}`} className="hover:underline">{r.orderNumber}</Link></td>
              <td className="px-3 py-2 text-xs">{r.customerName}</td><td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.refundedAt)}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-40">{r.reason ?? '—'}</td>
              <td className="px-3 py-2 text-right text-xs font-mono text-destructive">{fmtGbp(r.totalGbp)}</td>
            </tr>))}
        </tbody></table>{refunds.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No refunds found.</p>}</div>
      )}

      {tab === 'aging' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Invoiced</th><th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Paid</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Outstanding</th><th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Overdue (30d+)</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Oldest Unpaid</th>
        </tr></thead><tbody className="divide-y">
          {aging.filter((a) => !oq || a.customerName.toLowerCase().includes(oq)).map((a) => (
            <tr key={a.customerId || a.customerName} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-medium">{a.customerName}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.totalInvoiced)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-green-600">{fmtGbp(a.totalPaid)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.outstanding > 0.01 ? 'text-orange-600 font-medium' : ''}>{a.outstanding > 0.01 ? fmtGbp(a.outstanding) : '—'}</span></td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.overdueAmount > 0 ? 'text-destructive font-medium' : ''}>{a.overdueAmount > 0 ? fmtGbp(a.overdueAmount) : '—'}</span></td>
              <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={a.oldestUnpaidDays > 60 ? 'text-destructive font-medium' : a.oldestUnpaidDays > 30 ? 'text-orange-600' : 'text-muted-foreground'}>{a.oldestUnpaidDays > 0 ? `${a.oldestUnpaidDays}d` : '—'}</span></td>
            </tr>))}
        </tbody></table>{aging.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No invoice data found.</p>}</div>
      )}

      {/* Dialogs */}
      {showFilterDialog && <FilterDialog rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilterDialog(false)} />}
      {showColPicker && <ColumnPickerDialog visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
