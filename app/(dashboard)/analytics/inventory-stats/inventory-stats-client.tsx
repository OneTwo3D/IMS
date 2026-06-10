'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Filter, X, Plus, ArrowUp, ArrowDown, Download, Settings2, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ProductLink } from '@/components/inventory/product-link'
import type { StockOnHandRow, StockMovementRow, StockAllocationRow, ReorderRow } from '@/app/actions/inventory-stats'
import { saveView, type SavedView } from '@/app/actions/sales-stats'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatMoney } from '@/lib/utils'

type Tab = 'onhand' | 'movements' | 'allocations' | 'reorder'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'
type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }

type Props = {
  stockOnHand: StockOnHandRow[]
  movements: StockMovementRow[]
  allocations: StockAllocationRow[]
  reorder: ReorderRow[]
  savedViews: SavedView[]
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'onhand', label: 'Stock on Hand' },
  { key: 'movements', label: 'Stock Movement' },
  { key: 'allocations', label: 'Stock Allocations' },
  { key: 'reorder', label: 'Reorder Inventory' },
]

function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// ---------------------------------------------------------------------------
// Field definitions per tab
// ---------------------------------------------------------------------------
const ONHAND_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'name', label: 'Product Name', type: 'text' },
  { key: 'type', label: 'Product Type', type: 'select', options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'mpn', label: 'MPN', type: 'text' },
  { key: 'warehouseCode', label: 'Warehouse', type: 'text' },
  { key: 'lifecycleStatus', label: 'Status', type: 'select', options: ['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED'] },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'reservedQty', label: 'Reserved', type: 'number' },
  { key: 'available', label: 'Available', type: 'number' },
  { key: 'inventoryValue', label: 'Value', type: 'number' },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' },
]

const MOVEMENT_FIELDS: FieldDef[] = [
  { key: 'type', label: 'Type', type: 'select', options: ['PURCHASE_RECEIPT', 'WMS_RECEIPT_RECONCILIATION', 'SALE_DISPATCH', 'RETURN_INBOUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'PURCHASE_REVERSAL', 'PRODUCTION_IN', 'PRODUCTION_OUT', 'OPENING_STOCK'] },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'productName', label: 'Product Name', type: 'text' },
  { key: 'fromWarehouse', label: 'From Warehouse', type: 'text' },
  { key: 'toWarehouse', label: 'To Warehouse', type: 'text' },
  { key: 'qty', label: 'Quantity', type: 'number' },
  { key: 'unitCostBase', label: 'Unit Cost (Base)', type: 'number' },
  { key: 'totalValueBase', label: 'Value (Base)', type: 'number' },
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'createdAt', label: 'Date', type: 'text' },
]

const ALLOCATION_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'productName', label: 'Product Name', type: 'text' },
  { key: 'warehouseCode', label: 'Warehouse', type: 'text' },
  { key: 'totalStock', label: 'Total Stock', type: 'number' },
  { key: 'reservedQty', label: 'Reserved', type: 'number' },
  { key: 'available', label: 'Available', type: 'number' },
  { key: 'pendingOrders', label: 'Pending Orders', type: 'number' },
]

const REORDER_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'name', label: 'Product Name', type: 'text' },
  { key: 'currentStock', label: 'Current Stock', type: 'number' },
  { key: 'availableStock', label: 'Available', type: 'number' },
  { key: 'reorderPoint', label: 'Reorder Point', type: 'number' },
  { key: 'shortfall', label: 'Shortfall', type: 'number' },
  { key: 'avgDailyDemand', label: 'Daily Demand', type: 'number' },
  { key: 'daysUntilStockout', label: 'Days to S/O', type: 'number' },
  { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' },
]

const TAB_FIELDS: Record<Tab, FieldDef[]> = {
  onhand: ONHAND_FIELDS,
  movements: MOVEMENT_FIELDS,
  allocations: ALLOCATION_FIELDS,
  reorder: REORDER_FIELDS,
}

const DEFAULT_COLS: Record<Tab, string[]> = {
  onhand: ['sku', 'name', 'type', 'barcode', 'mpn', 'warehouseCode', 'quantity', 'reservedQty', 'available', 'inventoryValue', 'stockUnit'],
  movements: ['type', 'sku', 'productName', 'fromWarehouse', 'toWarehouse', 'qty', 'unitCostBase', 'totalValueBase', 'note', 'createdAt'],
  allocations: ['sku', 'productName', 'warehouseCode', 'totalStock', 'reservedQty', 'available', 'pendingOrders'],
  reorder: ['sku', 'name', 'currentStock', 'availableStock', 'reorderPoint', 'shortfall', 'avgDailyDemand', 'daysUntilStockout', 'supplierName'],
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------
const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }, { value: 'starts_with', label: 'starts with' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]

function getOps(fields: FieldDef[], key: string) { const f = fields.find((pf) => pf.key === key); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(fields: FieldDef[], key: string) { return fields.find((pf) => pf.key === key)?.options }

function applyFilter(val: string | number | null | boolean | undefined, rule: FilterRule): boolean {
  const v = val == null ? '' : String(val).toLowerCase(); const rv = rule.value.toLowerCase()
  switch (rule.operator) {
    case 'contains': return v.includes(rv); case 'equals': case 'is': return v === rv; case 'starts_with': return v.startsWith(rv); case 'is_not': return v !== rv
    case '>': return Number(val) > Number(rule.value); case '>=': return Number(val) >= Number(rule.value)
    case '<': return Number(val) < Number(rule.value); case '<=': return Number(val) <= Number(rule.value); case '=': return Number(val) === Number(rule.value)
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
function FilterDialog({ fields, rules, onApply, onClose }: { fields: FieldDef[]; rules: FilterRule[]; onApply: (r: FilterRule[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<FilterRule[]>(rules.length ? [...rules] : [])

  function addRule() { setLocal((prev) => [...prev, { id: makeId(), field: fields[0].key, operator: 'contains', value: '' }]) }
  function removeRule(id: string) { setLocal((prev) => prev.filter((r) => r.id !== id)) }
  function updateRule(id: string, updates: Partial<FilterRule>) {
    setLocal((prev) => prev.map((r) => r.id === id ? { ...r, ...updates } : r))
  }

  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl"><DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
    <div className="space-y-3 min-h-[200px]">
      {local.map((rule) => {
        const ops = getOps(fields, rule.field)
        const options = getOpts(fields, rule.field)
        return (
          <div key={rule.id} className="flex items-center gap-2">
            <select value={rule.field} onChange={(e) => { const f = e.target.value; const newOps = getOps(fields, f); updateRule(rule.id, { field: f, operator: newOps[0].value, value: '' }) }} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
            <select value={rule.operator} onChange={(e) => updateRule(rule.id, { operator: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32">
              {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            {options ? (<select value={rule.value} onChange={(e) => updateRule(rule.id, { value: e.target.value })} className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">Select…</option>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            ) : (<Input value={rule.value} onChange={(e) => updateRule(rule.id, { value: e.target.value })} placeholder="Value" className="flex-1 h-8 text-xs" />)}
            <button type="button" onClick={() => removeRule(rule.id)} className="text-destructive hover:text-destructive/80 shrink-0"><X className="h-4 w-4" /></button>
          </div>
        )
      })}
      <button type="button" onClick={addRule} className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"><Plus className="h-3 w-3" />Add Filter</button>
    </div>
    <DialogFooter><Button variant="outline" onClick={() => { onApply([]); onClose() }}>Reset</Button><Button onClick={() => { onApply(local.filter((r) => r.value)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

// ---------------------------------------------------------------------------
// Column Picker Dialog
// ---------------------------------------------------------------------------
function ColumnPickerDialog({ fields, visible, onApply, onClose }: { fields: FieldDef[]; visible: string[]; onApply: (c: string[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Set<string>>(new Set(visible))
  function toggle(key: string) { setLocal((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n }) }
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
    <div className="space-y-1 max-h-80 overflow-y-auto">{fields.map((f) => (
      <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1"><input type="checkbox" checked={local.has(f.key)} onChange={() => toggle(f.key)} className="rounded border-input" />{f.label}</label>
    ))}</div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => { onApply(Array.from(local)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

// ---------------------------------------------------------------------------
// Save View Dialog
// ---------------------------------------------------------------------------
function SaveViewDialog({ tab, columns, filters, onClose }: { tab: string; columns: string[]; filters: FilterRule[]; onClose: () => void }) {
  const router = useRouter(); const [isPending, startTransition] = useTransition(); const [name, setName] = useState('')
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Save View</DialogTitle></DialogHeader>
    <div className="space-y-3"><div className="space-y-1.5"><Label>View Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Low stock items" className="h-9" autoFocus /></div></div>
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button><Button onClick={() => { if (!name.trim()) return; startTransition(async () => { await saveView({ id: makeId(), name, tab: `inv_${tab}`, columns, filters: filters.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }); router.refresh(); onClose() }) }} disabled={isPending || !name.trim()}>{isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save</Button></DialogFooter>
  </DialogContent></Dialog>)
}

const MOVEMENT_LABELS: Record<string, string> = {
  PURCHASE_RECEIPT: 'Purchase Receipt', WMS_RECEIPT_RECONCILIATION: 'WMS Receipt Reconciliation', SALE_DISPATCH: 'Sale Dispatch', RETURN_INBOUND: 'Return Inbound',
  TRANSFER_OUT: 'Transfer Out', TRANSFER_IN: 'Transfer In', ADJUSTMENT: 'Adjustment', PURCHASE_REVERSAL: 'Purchase Reversal',
  PRODUCTION_IN: 'Production In', PRODUCTION_OUT: 'Production Out', OPENING_STOCK: 'Opening Stock',
}

export function InventoryStatsClient({ stockOnHand, movements, allocations, reorder, savedViews }: Props) {
  const baseCurrency = useBaseCurrency()
  const fmtBase = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  const [tab, setTab] = useState<Tab>('onhand')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [visibleColsMap, setVisibleColsMap] = useState<Record<Tab, string[]>>({ ...DEFAULT_COLS })
  const [showFilter, setShowFilter] = useState(false); const [showColPicker, setShowColPicker] = useState(false); const [showSaveView, setShowSaveView] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>('sku'); const [sortDir, setSortDir] = useState<SortDir>('asc')

  const fields = TAB_FIELDS[tab]
  const visibleCols = visibleColsMap[tab]

  function setVisibleCols(cols: string[]) {
    setVisibleColsMap((prev) => ({ ...prev, [tab]: cols }))
  }

  function handleSort(key: string) { if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(key); setSortDir('asc') } }

  function handleTabChange(t: Tab) {
    setTab(t); setFilterRules([]); setSortCol(null)
  }

  function loadView(v: SavedView) {
    const t = v.tab.replace('inv_', '') as Tab
    setTab(t)
    setVisibleColsMap((prev) => ({ ...prev, [t]: v.columns }))
    setFilterRules(v.filters.map((f) => ({ ...f, id: makeId() })))
  }

  function SortIcon({ col }: { col: string }) { return sortCol === col ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />) : null }
  const TH = ({ col, children, right }: { col: string; children: React.ReactNode; right?: boolean }) => (
    <TableHead className={`text-xs cursor-pointer hover:text-foreground select-none ${right ? 'text-right' : 'text-left'}`} onClick={() => handleSort(col)}>{children} <SortIcon col={col} /></TableHead>
  )

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
  const filteredOnHand = filterAndSort(stockOnHand)
  const filteredMovements = filterAndSort(movements)
  const filteredAllocations = filterAndSort(allocations)
  const filteredReorder = filterAndSort(reorder)

  const totalQty = stockOnHand.reduce((s, r) => s + r.quantity, 0)
  const totalReserved = stockOnHand.reduce((s, r) => s + r.reservedQty, 0)
  const totalAvailable = stockOnHand.reduce((s, r) => s + r.available, 0)
  const totalValue = stockOnHand.reduce((s, r) => s + r.inventoryValue, 0)

  // On-hand column renderers (special formatting with footer)
  const onhandColR: Record<string, { label: string; align: string; render: (r: StockOnHandRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
    sku: { label: 'Product', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />, footer: () => <span>Totals</span> },
    name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-32 block">{r.name}</span> },
    type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
    barcode: { label: 'Barcode', align: 'left', render: (r) => <span className="text-xs font-mono">{r.barcode ?? '—'}</span> },
    mpn: { label: 'MPN', align: 'left', render: (r) => <span className="text-xs font-mono">{r.mpn ?? '—'}</span> },
    warehouseCode: { label: 'Warehouse', align: 'left', render: (r) => <span className="text-xs font-medium">{r.warehouseCode}</span> },
    lifecycleStatus: { label: 'Status', align: 'left', render: (r) => <span className="text-xs">{r.lifecycleStatus}</span> },
    stockUnit: { label: 'Unit', align: 'left', render: (r) => <span className="text-xs">{r.stockUnit}</span> },
    quantity: { label: 'Quantity', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.quantity}</span>, footer: () => <span className="tabular-nums">{totalQty}</span> },
    reservedQty: { label: 'Reserved', align: 'right', render: (r) => <span className={`tabular-nums text-xs ${r.reservedQty > 0 ? 'text-orange-600' : 'text-muted-foreground'}`}>{r.reservedQty > 0 ? r.reservedQty : '—'}</span>, footer: () => <span className="tabular-nums text-orange-600">{totalReserved}</span> },
    available: { label: 'Available', align: 'right', render: (r) => <span className={`tabular-nums text-xs font-medium ${r.available <= 0 ? 'text-destructive' : ''}`}>{r.available}</span>, footer: () => <span className="tabular-nums">{totalAvailable}</span> },
    inventoryValue: { label: `Value (${baseCurrency.code})`, align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{r.inventoryValue > 0 ? fmtBase(r.inventoryValue) : '—'}</span>, footer: () => <span className="tabular-nums font-mono">{fmtBase(totalValue)}</span> },
  }

  // Generic cell renderer for non-onhand tabs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderCell(row: any, key: string, tabKey: Tab): React.ReactNode {
    const v = row[key]

    if (tabKey === 'movements') {
      if (key === 'type') return <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border bg-muted">{MOVEMENT_LABELS[v] ?? v}</span>
      if (key === 'sku') return <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />
      if (key === 'fromWarehouse' || key === 'toWarehouse') return <span className="text-xs font-mono">{v ?? '—'}</span>
      if (key === 'qty') return <span className="tabular-nums text-xs font-medium">{v}</span>
      if (key === 'unitCostBase' || key === 'totalValueBase') return <span className="tabular-nums text-xs font-mono">{v == null ? '—' : fmtBase(v)}</span>
      if (key === 'note') return <span className="text-xs text-muted-foreground truncate max-w-48 block">{v ?? '—'}</span>
      if (key === 'createdAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
    }

    if (tabKey === 'allocations') {
      if (key === 'sku') return <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />
      if (key === 'warehouseCode') return <span className="text-xs font-medium">{v}</span>
      if (key === 'totalStock') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'reservedQty') return <span className="tabular-nums text-xs text-orange-600 font-medium">{v}</span>
      if (key === 'available') return <span className={`tabular-nums text-xs ${v <= 0 ? 'text-destructive font-medium' : ''}`}>{v}</span>
      if (key === 'pendingOrders') return <span className="tabular-nums text-xs text-muted-foreground">{v}</span>
    }

    if (tabKey === 'reorder') {
      if (key === 'sku') return <ProductLink productId={row.productId} sku={row.sku} name={row.name} />
      if (key === 'currentStock') return <span className="tabular-nums text-xs">{v} {row.stockUnit}</span>
      if (key === 'availableStock') return <span className={`tabular-nums text-xs ${v <= 0 ? 'text-destructive font-bold' : ''}`}>{v}</span>
      if (key === 'reorderPoint') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'shortfall') return <span className="tabular-nums text-xs text-destructive font-medium">{v}</span>
      if (key === 'avgDailyDemand') return <span className="tabular-nums text-xs">{v.toFixed(1)}</span>
      if (key === 'daysUntilStockout') return <span className={`tabular-nums text-xs ${v <= 0 ? 'text-destructive font-bold' : v <= 14 ? 'text-orange-600 font-medium' : ''}`}>{v >= 999 ? '—' : `${v}d`}</span>
      if (key === 'supplierName') return <span className="text-xs text-muted-foreground">{v ?? '—'}</span>
    }

    // Default
    if (v == null) return <span className="text-xs text-muted-foreground">—</span>
    if (typeof v === 'number') return <span className="tabular-nums text-xs">{v}</span>
    return <span className="text-xs">{String(v)}</span>
  }

  // Determine alignment for a field
  function fieldAlign(key: string): 'left' | 'right' {
    const f = fields.find((fd) => fd.key === key)
    return f?.type === 'number' ? 'right' : 'left'
  }

  // Field label lookup
  function fieldLabel(key: string): string {
    return fields.find((fd) => fd.key === key)?.label ?? key
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inventory Report</h1>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Quantity</p><p className="text-xl font-bold">{totalQty.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Reserved</p><p className="text-xl font-bold text-orange-600">{totalReserved.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Available</p><p className="text-xl font-bold">{totalAvailable.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Inventory Value</p><p className="text-xl font-bold">{fmtBase(totalValue)}</p></div>
      </div>

      <div className="border-b">
        <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden">
          {TABS.map((t) => (<button key={t.key} type="button" className={`shrink-0 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => handleTabChange(t.key)}>{t.label}</button>))}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pb-1 pl-2">
            {savedViews.filter((v) => v.tab.startsWith('inv_')).length > 0 && (
              <select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue="">
                <option value="" disabled>Saved Views…</option>{savedViews.filter((v) => v.tab.startsWith('inv_')).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            )}
            <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}><Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}><Settings2 className="h-3 w-3 mr-0.5" />Columns</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}><Save className="h-3 w-3 mr-0.5" />Save View</Button>
            <a href={`/api/export/analytics?type=inv_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted"><Download className="h-3 w-3" />CSV</a>
          </div>
        </div>
      </div>

      {/* Stock on Hand */}
      {tab === 'onhand' && (
        <div className="rounded-md border">
          <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredOnHand.length} of {stockOnHand.length} rows</div>
          <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                {visibleCols.map((k) => { const c = onhandColR[k]; return c ? <TH key={k} col={k} right={c.align === 'right'}>{c.label}</TH> : null })}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {filteredOnHand.map((r) => (
                <TableRow key={`${r.productId}-${r.warehouseCode}`}>
                  {visibleCols.map((k) => { const c = onhandColR[k]; return c ? <TableCell key={k} className={c.align === 'right' ? 'text-right' : ''}>{c.render(r)}</TableCell> : null })}
                </TableRow>
              ))}
            </TableBody>
            <tfoot className="border-t bg-muted/30 font-medium text-sm">
              <tr>
                {visibleCols.map((k) => { const c = onhandColR[k]; return <td key={k} className={`px-3 py-2 ${c?.align === 'right' ? 'text-right' : ''}`}>{c?.footer?.() ?? ''}</td> })}
              </tr>
            </tfoot>
          </Table>
        </div>
      )}

      {/* Stock Movements */}
      {tab === 'movements' && (
        <div className="rounded-md border">
          <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredMovements.length} of {movements.length} rows</div>
          <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                {visibleCols.map((k) => <TH key={k} col={k} right={fieldAlign(k) === 'right'}>{fieldLabel(k)}</TH>)}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {filteredMovements.map((m) => (
                <TableRow key={m.id}>
                  {visibleCols.map((k) => <TableCell key={k} className={fieldAlign(k) === 'right' ? 'text-right' : ''}>{renderCell(m, k, 'movements')}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {movements.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No movements found.</p>}
        </div>
      )}

      {/* Allocations */}
      {tab === 'allocations' && (
        <div className="rounded-md border">
          <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredAllocations.length} of {allocations.length} rows</div>
          <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                {visibleCols.map((k) => <TH key={k} col={k} right={fieldAlign(k) === 'right'}>{fieldLabel(k)}</TH>)}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {filteredAllocations.map((a) => (
                <TableRow key={`${a.productId}-${a.warehouseCode}`}>
                  {visibleCols.map((k) => <TableCell key={k} className={fieldAlign(k) === 'right' ? 'text-right' : ''}>{renderCell(a, k, 'allocations')}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {allocations.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No allocations found.</p>}
        </div>
      )}

      {/* Reorder */}
      {tab === 'reorder' && (
        <div className="rounded-md border">
          <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredReorder.length} of {reorder.length} rows</div>
          <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
            <TableHeader className="bg-muted/50">
              <TableRow>
                {visibleCols.map((k) => <TH key={k} col={k} right={fieldAlign(k) === 'right'}>{fieldLabel(k)}</TH>)}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {filteredReorder.map((r) => (
                <TableRow key={r.productId} className={r.availableStock <= 0 ? 'bg-red-50 dark:bg-red-950/20' : ''}>
                  {visibleCols.map((k) => <TableCell key={k} className={fieldAlign(k) === 'right' ? 'text-right' : ''}>{renderCell(r, k, 'reorder')}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {reorder.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">All products above reorder point.</p>}
        </div>
      )}

      {showFilter && <FilterDialog fields={fields} rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog fields={fields} visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
