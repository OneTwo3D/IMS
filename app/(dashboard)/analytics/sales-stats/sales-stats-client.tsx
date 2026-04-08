'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Settings2, Save, Loader2, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import { saveView, deleteView, type SalesStatRow, type SalesStatSummary, type ShipmentRow, type DetailRow, type InvoiceRow, type RefundRow, type CustomerAgingRow, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'products' | 'shipments' | 'details' | 'invoices' | 'refunds' | 'aging'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'
type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }

type Props = {
  productStats: { rows: SalesStatRow[]; summary: SalesStatSummary }
  shipments: ShipmentRow[]
  details: DetailRow[]
  invoices: InvoiceRow[]
  refunds: RefundRow[]
  aging: CustomerAgingRow[]
  savedViews: SavedView[]
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'details', label: 'Details' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'aging', label: 'Customer Aging' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// ---------------------------------------------------------------------------
// Field definitions per tab
// ---------------------------------------------------------------------------
const PRODUCT_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'name', label: 'Product Name', type: 'text' },
  { key: 'type', label: 'Product Type', type: 'select', options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'active', label: 'Active', type: 'select', options: ['true', 'false'] },
  { key: 'qtySold', label: 'Qty Sold', type: 'number' },
  { key: 'qtyRefunded', label: 'Qty Refunded', type: 'number' },
  { key: 'netQty', label: 'Net Qty', type: 'number' },
  { key: 'grossRevenue', label: 'Gross Revenue (£)', type: 'number' },
  { key: 'discounts', label: 'Discounts (£)', type: 'number' },
  { key: 'refunds', label: 'Refunds (£)', type: 'number' },
  { key: 'netRevenue', label: 'Net Revenue (£)', type: 'number' },
  { key: 'cogs', label: 'COGS (£)', type: 'number' },
  { key: 'grossProfit', label: 'Gross Profit (£)', type: 'number' },
  { key: 'marginPct', label: 'Margin %', type: 'number' },
  { key: 'orderCount', label: 'Order Count', type: 'number' },
  { key: 'avgOrderValue', label: 'Avg Order Value (£)', type: 'number' },
  { key: 'salesPrice', label: 'Sales Price (£)', type: 'number' },
  { key: 'weight', label: 'Weight (kg)', type: 'number' },
  { key: 'currentStock', label: 'Qty on Hand', type: 'number' },
  { key: 'reservedQty', label: 'Qty Allocated', type: 'number' },
  { key: 'availableStock', label: 'Qty Available', type: 'number' },
]

const SHIPMENT_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' },
  { key: 'orderNumber', label: 'Order', type: 'text' },
  { key: 'trackingNumber', label: 'Tracking', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text' },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'shippingService', label: 'Service', type: 'text' },
  { key: 'shippedAt', label: 'Date', type: 'text' },
  { key: 'warehouse', label: 'Warehouse', type: 'text' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' },
]

const DETAIL_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'] },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' },
  { key: 'createdAt', label: 'Created', type: 'text' },
  { key: 'orderNumber', label: 'Order', type: 'text' },
  { key: 'type', label: 'Product Type', type: 'text' },
  { key: 'customerEmail', label: 'Email', type: 'text' },
]

const INVOICE_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' },
  { key: 'orderNumber', label: 'Order', type: 'text' },
  { key: 'invoiceNumber', label: 'Invoice #', type: 'text' },
  { key: 'invoicedAt', label: 'Date', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text' },
  { key: 'status', label: 'Status', type: 'select', options: ['Paid', 'Unpaid'] },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' },
  { key: 'balance', label: 'Balance (£)', type: 'number' },
]

const REFUND_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' },
  { key: 'orderNumber', label: 'Order', type: 'text' },
  { key: 'creditNoteNumber', label: 'Credit Note', type: 'text' },
  { key: 'refundedAt', label: 'Date', type: 'text' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text' },
  { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' },
  { key: 'pctOfSale', label: '% of Sale', type: 'number' },
  { key: 'reason', label: 'Reason', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
]

const AGING_FIELDS: FieldDef[] = [
  { key: 'orderNumber', label: 'Order', type: 'text' },
  { key: 'customerName', label: 'Customer', type: 'text' },
  { key: 'salesRep', label: 'Sales Rep', type: 'text' },
  { key: 'warehouse', label: 'Warehouse', type: 'text' },
  { key: 'createdAt', label: 'Date', type: 'text' },
  { key: 'salesTotal', label: 'Sales (£)', type: 'number' },
  { key: 'refundsTotal', label: 'Refunds (£)', type: 'number' },
  { key: 'netTotal', label: 'Net Total (£)', type: 'number' },
  { key: 'dueAmount', label: 'Due (£)', type: 'number' },
  { key: 'avgDso', label: 'Avg DSO', type: 'number' },
  { key: 'overdue0_30', label: '0-30d (£)', type: 'number' },
  { key: 'overdue31_60', label: '31-60d (£)', type: 'number' },
  { key: 'overdue61_90', label: '61-90d (£)', type: 'number' },
  { key: 'overdue91plus', label: '91d+ (£)', type: 'number' },
]

const TAB_FIELDS: Record<Tab, FieldDef[]> = {
  products: PRODUCT_FIELDS,
  shipments: SHIPMENT_FIELDS,
  details: DETAIL_FIELDS,
  invoices: INVOICE_FIELDS,
  refunds: REFUND_FIELDS,
  aging: AGING_FIELDS,
}

const DEFAULT_COLS: Record<Tab, string[]> = {
  products: ['sku', 'name', 'qtySold', 'netQty', 'grossRevenue', 'discounts', 'netRevenue', 'cogs', 'grossProfit', 'marginPct', 'orderCount'],
  shipments: ['productName', 'orderNumber', 'trackingNumber', 'sku', 'barcode', 'customerName', 'salesRep', 'qty', 'shippingService', 'shippedAt'],
  details: ['productName', 'sku', 'barcode', 'customerName', 'salesRep', 'status', 'qty', 'totalGbp', 'createdAt'],
  invoices: ['productName', 'orderNumber', 'invoiceNumber', 'invoicedAt', 'sku', 'customerName', 'salesRep', 'status', 'totalGbp'],
  refunds: ['productName', 'orderNumber', 'creditNoteNumber', 'refundedAt', 'salesRep', 'qty', 'totalGbp', 'pctOfSale', 'reason'],
  aging: ['orderNumber', 'customerName', 'salesRep', 'warehouse', 'createdAt', 'salesTotal', 'refundsTotal', 'netTotal', 'dueAmount', 'avgDso', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus'],
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------
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

function getOperators(fields: FieldDef[], fieldKey: string) {
  const f = fields.find((pf) => pf.key === fieldKey)
  if (f?.type === 'number') return NUMBER_OPERATORS
  if (f?.type === 'select') return SELECT_OPERATORS
  return TEXT_OPERATORS
}

function getFieldOptions(fields: FieldDef[], fieldKey: string) {
  return fields.find((pf) => pf.key === fieldKey)?.options
}

function applyFilter(value: string | number | null | boolean | undefined, rule: FilterRule): boolean {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVal(row: any, field: string): string | number | null {
  const v = row[field]
  return v === undefined ? null : v
}

// ---------------------------------------------------------------------------
// Filter Dialog
// ---------------------------------------------------------------------------
function FilterDialog({ fields, rules, onApply, onClose }: { fields: FieldDef[]; rules: FilterRule[]; onApply: (rules: FilterRule[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<FilterRule[]>(rules.length ? [...rules] : [])

  function addRule() { setLocal((prev) => [...prev, { id: makeId(), field: fields[0].key, operator: 'contains', value: '' }]) }
  function removeRule(id: string) { setLocal((prev) => prev.filter((r) => r.id !== id)) }
  function updateRule(id: string, updates: Partial<FilterRule>) {
    setLocal((prev) => prev.map((r) => r.id === id ? { ...r, ...updates } : r))
  }

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl">
      <DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
      <div className="space-y-3 min-h-[200px]">
        {local.map((rule) => {
          const ops = getOperators(fields, rule.field)
          const options = getFieldOptions(fields, rule.field)
          return (
            <div key={rule.id} className="flex items-center gap-2">
              <select value={rule.field} onChange={(e) => { const f = e.target.value; const newOps = getOperators(fields, f); updateRule(rule.id, { field: f, operator: newOps[0].value, value: '' }) }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">
                {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
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
function ColumnPickerDialog({ fields, visible, onApply, onClose }: { fields: FieldDef[]; visible: string[]; onApply: (cols: string[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Set<string>>(new Set(visible))
  function toggle(key: string) { setLocal((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n }) }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
      <DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {fields.map((f) => (
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
// Cell renderer helpers
// ---------------------------------------------------------------------------
function StatusBadge({ status }: { status: string }) {
  const cls = status === 'COMPLETED' || status === 'SHIPPED' ? 'bg-green-100 text-green-700'
    : status === 'REFUNDED' ? 'bg-red-100 text-red-700'
    : status === 'CANCELLED' ? 'bg-gray-100 text-gray-700'
    : status === 'Paid' ? 'bg-green-100 text-green-700'
    : status === 'Unpaid' ? 'bg-orange-100 text-orange-700'
    : 'bg-blue-100 text-blue-700'
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{status}</span>
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function SalesStatsClient({ productStats, shipments, details, invoices, refunds, aging, savedViews }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [visibleColsMap, setVisibleColsMap] = useState<Record<Tab, string[]>>({ ...DEFAULT_COLS })
  const [showFilterDialog, setShowFilterDialog] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showSaveView, setShowSaveView] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const { rows, summary } = productStats
  const fields = TAB_FIELDS[tab]
  const visibleCols = visibleColsMap[tab]

  function setVisibleCols(cols: string[]) {
    setVisibleColsMap((prev) => ({ ...prev, [tab]: cols }))
  }

  function handleSort(key: string) {
    if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(key); setSortDir('desc') }
  }

  function handleTabChange(t: Tab) {
    setTab(t); setFilterRules([]); setSortCol(null)
  }

  function loadView(view: SavedView) {
    const t = view.tab as Tab
    setTab(t)
    setVisibleColsMap((prev) => ({ ...prev, [t]: view.columns }))
    setFilterRules(view.filters.map((f) => ({ ...f, id: makeId() })))
  }

  function handleDeleteView(viewId: string) {
    startTransition(async () => { await deleteView(viewId); router.refresh() })
  }

  // Generic filter + sort for any tab data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function filterAndSort<T extends Record<string, any>>(data: T[]): T[] {
    let result = data
    for (const rule of filterRules) {
      if (!rule.value) continue
      result = result.filter((row) => applyFilter(getVal(row, rule.field), rule))
    }
    if (sortCol) {
      result = [...result].sort((a, b) => {
        const va = getVal(a, sortCol) ?? 0
        const vb = getVal(b, sortCol) ?? 0
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return result
  }

  // Filtered data per tab
  const filteredProducts = useMemo(() => filterAndSort(rows), [rows, filterRules, sortCol, sortDir])
  const filteredShipments = useMemo(() => filterAndSort(shipments), [shipments, filterRules, sortCol, sortDir])
  const filteredDetails = useMemo(() => filterAndSort(details), [details, filterRules, sortCol, sortDir])
  const filteredInvoices = useMemo(() => filterAndSort(invoices), [invoices, filterRules, sortCol, sortDir])
  const filteredRefunds = useMemo(() => filterAndSort(refunds), [refunds, filterRules, sortCol, sortDir])
  const filteredAging = useMemo(() => filterAndSort(aging), [aging, filterRules, sortCol, sortDir])

  // Column header renderer
  function ColHeader({ colKey, label, align }: { colKey: string; label: string; align?: 'right' | 'left' }) {
    return (
      <th className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
        onClick={() => handleSort(colKey)}>
        <span className="inline-flex items-center gap-0.5">{label}{sortCol === colKey && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</span>
      </th>
    )
  }

  // Product tab column renderers (special formatting)
  const productColRenderers: Record<string, { label: string; align: 'left' | 'right'; render: (r: SalesStatRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
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
    currentStock: { label: 'On Hand', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.currentStock}</span> },
    reservedQty: { label: 'Allocated', align: 'right', render: (r) => <span className={`tabular-nums text-xs ${r.reservedQty > 0 ? 'text-orange-600' : 'text-muted-foreground'}`}>{r.reservedQty > 0 ? r.reservedQty : '—'}</span> },
    availableStock: { label: 'Available', align: 'right', render: (r) => <span className={`tabular-nums text-xs font-medium ${r.availableStock <= 0 ? 'text-destructive' : ''}`}>{r.availableStock}</span> },
  }

  // Generic cell renderer for non-product tabs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderCell(row: any, key: string, tabKey: Tab): React.ReactNode {
    const v = row[key]

    // Special renderers by tab + key
    if (tabKey === 'shipments') {
      if (key === 'productName') return row.productId ? <ProductLink productId={row.productId} sku="" name={row.productName} /> : <span className="truncate max-w-40 block text-xs">{row.productName}</span>
      if (key === 'orderNumber') return <Link href={`/sales/${row.orderId}`} className="hover:underline font-mono text-xs">{row.orderNumber}</Link>
      if (key === 'shippedAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'qty') return <span className="tabular-nums text-xs">{v}</span>
    }
    if (tabKey === 'details') {
      if (key === 'productName') return row.productId ? <ProductLink productId={row.productId} sku="" name={row.productName} /> : <span className="truncate max-w-40 block text-xs">{row.productName}</span>
      if (key === 'orderNumber') return <Link href={`/sales/${row.orderId}`} className="hover:underline font-mono text-xs">{row.orderNumber}</Link>
      if (key === 'status') return <StatusBadge status={v} />
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'qty') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'createdAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
    }
    if (tabKey === 'invoices') {
      if (key === 'productName') return row.productId ? <ProductLink productId={row.productId} sku="" name={row.productName} /> : <span className="truncate max-w-40 block text-xs">{row.productName}</span>
      if (key === 'orderNumber') return <Link href={`/sales/${row.orderId}`} className="hover:underline font-mono text-xs">{row.orderNumber}</Link>
      if (key === 'invoicedAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'status') return row.paidAt ? <StatusBadge status="Paid" /> : <StatusBadge status="Unpaid" />
      if (key === 'totalGbp' || key === 'balance') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'qty') return <span className="tabular-nums text-xs">{v}</span>
    }
    if (tabKey === 'refunds') {
      if (key === 'productName') return row.productId ? <ProductLink productId={row.productId} sku="" name={row.productName} /> : <span className="truncate max-w-40 block text-xs">{row.productName}</span>
      if (key === 'orderNumber') return <Link href={`/sales/${row.orderId}`} className="hover:underline font-mono text-xs">{row.orderNumber}</Link>
      if (key === 'refundedAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono text-destructive">{fmtGbp(v)}</span>
      if (key === 'pctOfSale') return <span className="tabular-nums text-xs text-muted-foreground">{v}%</span>
      if (key === 'qty') return <span className="tabular-nums text-xs">{v}</span>
    }
    if (tabKey === 'aging') {
      if (key === 'orderNumber') return <Link href={`/sales/${row.orderId}`} className="hover:underline font-mono text-xs">{row.orderNumber}</Link>
      if (key === 'createdAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'salesTotal' || key === 'netTotal') return <span className="tabular-nums text-xs font-mono font-medium">{fmtGbp(v)}</span>
      if (key === 'refundsTotal') return <span className="tabular-nums text-xs font-mono text-orange-600">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'dueAmount') return <span className={`tabular-nums text-xs font-mono ${v > 0.01 ? 'text-orange-600 font-medium' : ''}`}>{v > 0.01 ? fmtGbp(v) : '—'}</span>
      if (key === 'avgDso') return <span className="tabular-nums text-xs text-muted-foreground">{v > 0 ? `${v}d` : '—'}</span>
      if (key === 'overdue0_30') return <span className="tabular-nums text-xs font-mono">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue31_60') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-orange-600' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue61_90') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-orange-600 font-medium' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue91plus') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-destructive font-medium' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
    }

    // Default
    if (v == null) return <span className="text-xs text-muted-foreground">—</span>
    if (typeof v === 'number') return <span className="tabular-nums text-xs">{v}</span>
    return <span className="text-xs">{String(v)}</span>
  }

  function isRightAligned(key: string): boolean {
    const f = fields.find((fd) => fd.key === key)
    if (f?.type === 'number') return true
    if (['totalGbp', 'balance', 'qty', 'salesTotal', 'refundsTotal', 'netTotal', 'dueAmount', 'avgDso', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus', 'pctOfSale'].includes(key)) return true
    return false
  }

  // Generic table for non-product tabs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function GenericTable({ data, tabKey, emptyMsg }: { data: any[]; tabKey: Tab; emptyMsg: string }) {
    const cols = visibleColsMap[tabKey]
    return (
      <div className="rounded-md border overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs text-muted-foreground">{data.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                {cols.map((key) => {
                  const f = TAB_FIELDS[tabKey].find((fd) => fd.key === key)
                  if (!f) return null
                  return <ColHeader key={key} colKey={key} label={f.label} align={isRightAligned(key) ? 'right' : 'left'} />
                })}
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((row, i) => (
                <tr key={row.id ?? row.orderId ?? row.receiptLineId ?? i} className="hover:bg-muted/30">
                  {cols.map((key) => (
                    <td key={key} className={`px-3 py-2 ${isRightAligned(key) ? 'text-right' : ''}`}>{renderCell(row, key, tabKey)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">{emptyMsg}</p>}
      </div>
    )
  }

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
            onClick={() => handleTabChange(t.key)}>{t.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 pb-1">
          {savedViews.length > 0 && (
            <select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue="">
              <option value="" disabled>Saved Views…</option>
              {savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilterDialog(true)}>
            <Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}>
            <Settings2 className="h-3 w-3 mr-0.5" />Columns
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}>
            <Save className="h-3 w-3 mr-0.5" />Save View
          </Button>
          <a href={`/api/export/analytics?type=${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted">
            <Download className="h-3 w-3" />CSV
          </a>
        </div>
      </div>

      {/* Products tab with dynamic columns + footer */}
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
                    const col = productColRenderers[key]
                    if (!col) return null
                    return <ColHeader key={key} colKey={key} label={col.label} align={col.align === 'right' ? 'right' : 'left'} />
                  })}
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredProducts.map((r) => (
                  <tr key={r.productId} className="hover:bg-muted/30">
                    {visibleCols.map((key) => {
                      const col = productColRenderers[key]
                      if (!col) return null
                      return <td key={key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>{col.render(r)}</td>
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-muted/30 text-sm font-medium">
                <tr>
                  {visibleCols.map((key) => {
                    const col = productColRenderers[key]
                    if (!col) return null
                    return <td key={key} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}>{col.footer?.() ?? ''}</td>
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Other tabs — generic filterable/sortable tables */}
      {tab === 'shipments' && <GenericTable data={filteredShipments} tabKey="shipments" emptyMsg="No shipments found." />}
      {tab === 'details' && <GenericTable data={filteredDetails} tabKey="details" emptyMsg="No details found." />}
      {tab === 'invoices' && <GenericTable data={filteredInvoices} tabKey="invoices" emptyMsg="No invoices found." />}
      {tab === 'refunds' && <GenericTable data={filteredRefunds} tabKey="refunds" emptyMsg="No refunds found." />}
      {tab === 'aging' && <GenericTable data={filteredAging} tabKey="aging" emptyMsg="No invoice data found." />}

      {/* Dialogs */}
      {showFilterDialog && <FilterDialog fields={fields} rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilterDialog(false)} />}
      {showColPicker && <ColumnPickerDialog fields={fields} visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
