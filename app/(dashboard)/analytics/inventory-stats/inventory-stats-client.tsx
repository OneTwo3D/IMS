'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Download, Settings2, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import type { StockOnHandRow, StockMovementRow, StockAllocationRow, ReorderRow } from '@/app/actions/inventory-stats'
import { saveView, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'onhand' | 'movements' | 'allocations' | 'reorder'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'

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

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

const ONHAND_FIELDS = [
  { key: 'sku', label: 'SKU', type: 'text' as const },
  { key: 'name', label: 'Product Name', type: 'text' as const },
  { key: 'type', label: 'Product Type', type: 'select' as const, options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'barcode', label: 'Barcode', type: 'text' as const },
  { key: 'warehouseCode', label: 'Warehouse', type: 'text' as const },
  { key: 'active', label: 'Active', type: 'select' as const, options: ['true', 'false'] },
  { key: 'quantity', label: 'Quantity', type: 'number' as const },
  { key: 'reservedQty', label: 'Reserved', type: 'number' as const },
  { key: 'available', label: 'Available', type: 'number' as const },
  { key: 'inventoryValue', label: 'Value (£)', type: 'number' as const },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' as const },
]

const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }, { value: 'starts_with', label: 'starts with' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]

function getOps(key: string) { const f = ONHAND_FIELDS.find((pf) => pf.key === key); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(key: string) { return ONHAND_FIELDS.find((pf) => pf.key === key)?.options }

function applyFilter(val: string | number | null | boolean, rule: FilterRule): boolean {
  const v = String(val ?? '').toLowerCase(); const rv = rule.value.toLowerCase()
  switch (rule.operator) {
    case 'contains': return v.includes(rv); case 'equals': case 'is': return v === rv; case 'starts_with': return v.startsWith(rv); case 'is_not': return v !== rv
    case '>': return Number(val) > Number(rule.value); case '>=': return Number(val) >= Number(rule.value)
    case '<': return Number(val) < Number(rule.value); case '<=': return Number(val) <= Number(rule.value); case '=': return Number(val) === Number(rule.value)
    default: return true
  }
}

function FilterDialog({ rules, onApply, onClose }: { rules: FilterRule[]; onApply: (r: FilterRule[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<FilterRule[]>(rules.length ? [...rules] : [])
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl"><DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
    <div className="space-y-3 min-h-[200px]">
      {local.map((rule) => (<div key={rule.id} className="flex items-center gap-2">
        <select value={rule.field} onChange={(e) => { const f = e.target.value; setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, field: f, operator: getOps(f)[0].value, value: '' } : r)) }} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">
          {ONHAND_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        <select value={rule.operator} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, operator: e.target.value } : r))} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32">
          {getOps(rule.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        {getOpts(rule.field) ? (<select value={rule.value} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r))} className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs">
          <option value="">Select…</option>{getOpts(rule.field)!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        ) : (<Input value={rule.value} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r))} placeholder="Value" className="flex-1 h-8 text-xs" />)}
        <button type="button" onClick={() => setLocal((p) => p.filter((r) => r.id !== rule.id))} className="text-destructive"><X className="h-4 w-4" /></button>
      </div>))}
      <button type="button" onClick={() => setLocal((p) => [...p, { id: makeId(), field: 'sku', operator: 'contains', value: '' }])} className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" />Add Filter</button>
    </div>
    <DialogFooter><Button variant="outline" onClick={() => { onApply([]); onClose() }}>Reset</Button><Button onClick={() => { onApply(local.filter((r) => r.value)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

function ColumnPickerDialog({ visible, onApply, onClose }: { visible: string[]; onApply: (c: string[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Set<string>>(new Set(visible))
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
    <div className="space-y-1 max-h-80 overflow-y-auto">{ONHAND_FIELDS.map((f) => (
      <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1"><input type="checkbox" checked={local.has(f.key)} onChange={() => setLocal((p) => { const n = new Set(p); n.has(f.key) ? n.delete(f.key) : n.add(f.key); return n })} className="rounded border-input" />{f.label}</label>
    ))}</div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => { onApply(Array.from(local)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

function SaveViewDialog({ tab, columns, filters, onClose }: { tab: string; columns: string[]; filters: FilterRule[]; onClose: () => void }) {
  const router = useRouter(); const [isPending, startTransition] = useTransition(); const [name, setName] = useState('')
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Save View</DialogTitle></DialogHeader>
    <div className="space-y-3"><div className="space-y-1.5"><Label>View Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Low stock items" className="h-9" autoFocus /></div></div>
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button><Button onClick={() => { if (!name.trim()) return; startTransition(async () => { await saveView({ id: makeId(), name, tab: `inv_${tab}`, columns, filters: filters.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }); router.refresh(); onClose() }) }} disabled={isPending || !name.trim()}>{isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save</Button></DialogFooter>
  </DialogContent></Dialog>)
}

const DEFAULT_COLS = ['sku', 'name', 'type', 'warehouseCode', 'quantity', 'reservedQty', 'available', 'inventoryValue', 'stockUnit']

const MOVEMENT_LABELS: Record<string, string> = {
  PURCHASE_RECEIPT: 'Purchase Receipt', SALE_DISPATCH: 'Sale Dispatch', RETURN_INBOUND: 'Return Inbound',
  TRANSFER_OUT: 'Transfer Out', TRANSFER_IN: 'Transfer In', ADJUSTMENT: 'Adjustment',
  PRODUCTION_IN: 'Production In', PRODUCTION_OUT: 'Production Out', OPENING_STOCK: 'Opening Stock',
}

export function InventoryStatsClient({ stockOnHand, movements, allocations, reorder, savedViews }: Props) {
  const router = useRouter(); const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('onhand')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_COLS)
  const [showFilter, setShowFilter] = useState(false); const [showColPicker, setShowColPicker] = useState(false); const [showSaveView, setShowSaveView] = useState(false)
  const [sortCol, setSortCol] = useState<string | null>('sku'); const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [search, setSearch] = useState('')
  const sq = search.toLowerCase()

  function handleSort(key: string) { if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(key); setSortDir('asc') } }
  function loadView(v: SavedView) { setTab(v.tab.replace('inv_', '') as Tab); setVisibleCols(v.columns); setFilterRules(v.filters.map((f) => ({ ...f, id: makeId() }))) }
  function SortIcon({ col }: { col: string }) { return sortCol === col ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />) : null }
  const TH = ({ col, children, right }: { col: string; children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`} onClick={() => handleSort(col)}>{children} <SortIcon col={col} /></th>
  )

  const filteredOnHand = useMemo(() => {
    let r = stockOnHand
    for (const rule of filterRules) { if (rule.value) r = r.filter((row) => applyFilter((row as Record<string, unknown>)[rule.field] as string | number | null, rule)) }
    if (sortCol) r = [...r].sort((a, b) => { const va = (a as Record<string, unknown>)[sortCol] ?? 0; const vb = (b as Record<string, unknown>)[sortCol] ?? 0; const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)); return sortDir === 'asc' ? c : -c })
    return r
  }, [stockOnHand, filterRules, sortCol, sortDir])

  const totalQty = stockOnHand.reduce((s, r) => s + r.quantity, 0)
  const totalReserved = stockOnHand.reduce((s, r) => s + r.reservedQty, 0)
  const totalAvailable = stockOnHand.reduce((s, r) => s + r.available, 0)
  const totalValue = stockOnHand.reduce((s, r) => s + r.inventoryValue, 0)

  const colR: Record<string, { label: string; align: string; render: (r: StockOnHandRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
    sku: { label: 'Product', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />, footer: () => <span>Totals</span> },
    name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-32 block">{r.name}</span> },
    type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
    barcode: { label: 'Barcode', align: 'left', render: (r) => <span className="text-xs font-mono">{r.barcode ?? '—'}</span> },
    warehouseCode: { label: 'Warehouse', align: 'left', render: (r) => <span className="text-xs font-medium">{r.warehouseCode}</span> },
    active: { label: 'Active', align: 'left', render: (r) => <span className="text-xs">{r.active ? 'Yes' : 'No'}</span> },
    stockUnit: { label: 'Unit', align: 'left', render: (r) => <span className="text-xs">{r.stockUnit}</span> },
    quantity: { label: 'Quantity', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.quantity}</span>, footer: () => <span className="tabular-nums">{totalQty}</span> },
    reservedQty: { label: 'Reserved', align: 'right', render: (r) => <span className={`tabular-nums text-xs ${r.reservedQty > 0 ? 'text-orange-600' : 'text-muted-foreground'}`}>{r.reservedQty > 0 ? r.reservedQty : '—'}</span>, footer: () => <span className="tabular-nums text-orange-600">{totalReserved}</span> },
    available: { label: 'Available', align: 'right', render: (r) => <span className={`tabular-nums text-xs font-medium ${r.available <= 0 ? 'text-destructive' : ''}`}>{r.available}</span>, footer: () => <span className="tabular-nums">{totalAvailable}</span> },
    inventoryValue: { label: 'Value (£)', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{r.inventoryValue > 0 ? fmtGbp(r.inventoryValue) : '—'}</span>, footer: () => <span className="tabular-nums font-mono">{fmtGbp(totalValue)}</span> },
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Inventory Report</h1>

      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Quantity</p><p className="text-xl font-bold">{totalQty.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Reserved</p><p className="text-xl font-bold text-orange-600">{totalReserved.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Available</p><p className="text-xl font-bold">{totalAvailable.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Inventory Value</p><p className="text-xl font-bold">{fmtGbp(totalValue)}</p></div>
      </div>

      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (<button key={t.key} type="button" className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(t.key)}>{t.label}</button>))}
        <div className="ml-auto flex items-center gap-1.5 pb-1">
          {savedViews.filter((v) => v.tab.startsWith('inv_')).length > 0 && (
            <select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue="">
              <option value="" disabled>Saved Views…</option>{savedViews.filter((v) => v.tab.startsWith('inv_')).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          )}
          {tab === 'onhand' && (<>
            <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}><Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}><Settings2 className="h-3 w-3 mr-0.5" />Columns</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}><Save className="h-3 w-3 mr-0.5" />Save View</Button>
          </>)}
          {tab !== 'onhand' && <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 text-xs w-48" />}
          <a href={`/api/export/analytics?type=inv_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted"><Download className="h-3 w-3" />CSV</a>
        </div>
      </div>

      {/* Stock on Hand */}
      {tab === 'onhand' && (
        <div className="rounded-md border overflow-hidden">
          <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredOnHand.length} of {stockOnHand.length} rows</div>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
            {visibleCols.map((k) => { const c = colR[k]; return c ? <TH key={k} col={k} right={c.align === 'right'}>{c.label}</TH> : null })}
          </tr></thead><tbody className="divide-y">
            {filteredOnHand.map((r, i) => (<tr key={`${r.productId}-${r.warehouseCode}`} className="hover:bg-muted/30">
              {visibleCols.map((k) => { const c = colR[k]; return c ? <td key={k} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(r)}</td> : null })}
            </tr>))}
          </tbody>
          <tfoot className="border-t bg-muted/30 font-medium text-sm"><tr>
            {visibleCols.map((k) => { const c = colR[k]; return <td key={k} className={`px-3 py-2 ${c?.align === 'right' ? 'text-right' : ''}`}>{c?.footer?.() ?? ''}</td> })}
          </tr></tfoot></table></div>
        </div>
      )}

      {/* Stock Movements */}
      {tab === 'movements' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">From</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">To</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Qty</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Note</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
        </tr></thead><tbody className="divide-y">
          {movements.filter((m) => !sq || m.sku.toLowerCase().includes(sq) || m.productName.toLowerCase().includes(sq) || m.type.toLowerCase().includes(sq)).map((m) => (
            <tr key={m.id} className="hover:bg-muted/30">
              <td className="px-3 py-2 text-xs"><span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border bg-muted">{MOVEMENT_LABELS[m.type] ?? m.type}</span></td>
              <td className="px-3 py-2"><ProductLink productId={m.productId} sku={m.sku} name={m.productName} /></td>
              <td className="px-3 py-2 text-xs font-mono">{m.fromWarehouse ?? '—'}</td>
              <td className="px-3 py-2 text-xs font-mono">{m.toWarehouse ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">{m.qty}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-48">{m.note ?? '—'}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(m.createdAt)}</td>
            </tr>))}
        </tbody></table>{movements.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No movements found.</p>}</div>
      )}

      {/* Allocations */}
      {tab === 'allocations' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Warehouse</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Stock</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Reserved</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Available</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Pending Orders</th>
        </tr></thead><tbody className="divide-y">
          {allocations.filter((a) => !sq || a.sku.toLowerCase().includes(sq) || a.productName.toLowerCase().includes(sq)).map((a) => (
            <tr key={`${a.productId}-${a.warehouseCode}`} className="hover:bg-muted/30">
              <td className="px-3 py-2"><ProductLink productId={a.productId} sku={a.sku} name={a.productName} /></td>
              <td className="px-3 py-2 text-xs font-medium">{a.warehouseCode}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{a.totalStock}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-orange-600 font-medium">{a.reservedQty}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={a.available <= 0 ? 'text-destructive font-medium' : ''}>{a.available}</span></td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{a.pendingOrders}</td>
            </tr>))}
        </tbody></table>{allocations.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No allocations found.</p>}</div>
      )}

      {/* Reorder */}
      {tab === 'reorder' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Current</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Available</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Reorder Point</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Shortfall</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Daily Demand</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Days to S/O</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
        </tr></thead><tbody className="divide-y">
          {reorder.filter((r) => !sq || r.sku.toLowerCase().includes(sq) || r.name.toLowerCase().includes(sq)).map((r) => (
            <tr key={r.productId} className={`hover:bg-muted/30 ${r.availableStock <= 0 ? 'bg-red-50 dark:bg-red-950/20' : ''}`}>
              <td className="px-3 py-2"><ProductLink productId={r.productId} sku={r.sku} name={r.name} /></td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.currentStock} {r.stockUnit}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={r.availableStock <= 0 ? 'text-destructive font-bold' : ''}>{r.availableStock}</span></td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.reorderPoint}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-destructive font-medium">{r.shortfall}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.avgDailyDemand.toFixed(1)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs"><span className={r.daysUntilStockout <= 0 ? 'text-destructive font-bold' : r.daysUntilStockout <= 14 ? 'text-orange-600 font-medium' : ''}>{r.daysUntilStockout >= 999 ? '—' : `${r.daysUntilStockout}d`}</span></td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.supplierName ?? '—'}</td>
            </tr>))}
        </tbody></table>{reorder.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">All products above reorder point.</p>}</div>
      )}

      {showFilter && <FilterDialog rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
