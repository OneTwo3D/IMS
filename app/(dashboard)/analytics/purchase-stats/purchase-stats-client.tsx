'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Download, Settings2, FileText, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import type { PurchaseProductRow, ReceivedGoodsRow, BillRow, SupplierAgingRow, PurchaseDetailRow } from '@/app/actions/purchase-stats'
import { saveView, deleteView, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'products' | 'received' | 'bills' | 'aging' | 'details'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'

type Props = {
  products: PurchaseProductRow[]
  received: ReceivedGoodsRow[]
  bills: BillRow[]
  aging: SupplierAgingRow[]
  details: PurchaseDetailRow[]
  savedViews: SavedView[]
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'received', label: 'Received Goods' },
  { key: 'bills', label: 'Bills' },
  { key: 'aging', label: 'Supplier Aging' },
  { key: 'details', label: 'Details' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// Filterable fields for Products tab
const PRODUCT_FIELDS = [
  { key: 'sku', label: 'SKU', type: 'text' as const },
  { key: 'name', label: 'Product Name', type: 'text' as const },
  { key: 'type', label: 'Product Type', type: 'select' as const, options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'stockUnit', label: 'Stock Unit', type: 'text' as const },
  { key: 'qtyOrdered', label: 'Qty Ordered', type: 'number' as const },
  { key: 'qtyReceived', label: 'Qty Received', type: 'number' as const },
  { key: 'qtyReturned', label: 'Qty Returned', type: 'number' as const },
  { key: 'netQty', label: 'Net Qty', type: 'number' as const },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' as const },
  { key: 'landedCostGbp', label: 'Landed Cost (£)', type: 'number' as const },
  { key: 'avgUnitCostGbp', label: 'Avg Unit Cost (£)', type: 'number' as const },
  { key: 'incomingQty', label: 'Stock Incoming', type: 'number' as const },
  { key: 'supplierCount', label: 'Suppliers', type: 'number' as const },
  { key: 'poCount', label: 'PO Count', type: 'number' as const },
]

const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }, { value: 'starts_with', label: 'starts with' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]

function getOps(key: string) { const f = PRODUCT_FIELDS.find((pf) => pf.key === key); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(key: string) { return PRODUCT_FIELDS.find((pf) => pf.key === key)?.options }

function applyFilter(val: string | number | null, rule: FilterRule): boolean {
  const v = String(val ?? '').toLowerCase()
  const rv = rule.value.toLowerCase()
  switch (rule.operator) {
    case 'contains': return v.includes(rv)
    case 'equals': case 'is': return v === rv
    case 'starts_with': return v.startsWith(rv)
    case 'is_not': return v !== rv
    case '>': return Number(val) > Number(rule.value)
    case '>=': return Number(val) >= Number(rule.value)
    case '<': return Number(val) < Number(rule.value)
    case '<=': return Number(val) <= Number(rule.value)
    case '=': return Number(val) === Number(rule.value)
    default: return true
  }
}

function getVal(row: PurchaseProductRow, key: string): string | number | null {
  return (row as Record<string, unknown>)[key] as string | number | null ?? null
}

// Filter Dialog
function FilterDialog({ rules, onApply, onClose }: { rules: FilterRule[]; onApply: (r: FilterRule[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<FilterRule[]>(rules.length ? [...rules] : [])
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl">
      <DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
      <div className="space-y-3 min-h-[200px]">
        {local.map((rule) => (
          <div key={rule.id} className="flex items-center gap-2">
            <select value={rule.field} onChange={(e) => { const f = e.target.value; setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, field: f, operator: getOps(f)[0].value, value: '' } : r)) }}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">
              {PRODUCT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select value={rule.operator} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, operator: e.target.value } : r))}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32">
              {getOps(rule.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {getOpts(rule.field) ? (
              <select value={rule.value} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r))}
                className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs">
                <option value="">Select…</option>
                {getOpts(rule.field)!.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <Input value={rule.value} onChange={(e) => setLocal((p) => p.map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r))} placeholder="Value" className="flex-1 h-8 text-xs" />
            )}
            <button type="button" onClick={() => setLocal((p) => p.filter((r) => r.id !== rule.id))} className="text-destructive"><X className="h-4 w-4" /></button>
          </div>
        ))}
        <button type="button" onClick={() => setLocal((p) => [...p, { id: makeId(), field: 'sku', operator: 'contains', value: '' }])}
          className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground">
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

// Column Picker
function ColumnPickerDialog({ visible, onApply, onClose }: { visible: string[]; onApply: (c: string[]) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Set<string>>(new Set(visible))
  function toggle(k: string) { setLocal((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n }) }
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
    <DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
    <div className="space-y-1 max-h-80 overflow-y-auto">{PRODUCT_FIELDS.map((f) => (
      <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1"><input type="checkbox" checked={local.has(f.key)} onChange={() => toggle(f.key)} className="rounded border-input" />{f.label}</label>
    ))}</div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => { onApply(Array.from(local)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

// Save View
function SaveViewDialog({ tab, columns, filters, onClose }: { tab: string; columns: string[]; filters: FilterRule[]; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  function handleSave() { if (!name.trim()) return; startTransition(async () => { await saveView({ id: makeId(), name, tab: `po_${tab}`, columns, filters: filters.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }); router.refresh(); onClose() }) }
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
    <DialogHeader><DialogTitle>Save View</DialogTitle></DialogHeader>
    <div className="space-y-3"><div className="space-y-1.5"><Label>View Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Top suppliers by spend" className="h-9" autoFocus /></div></div>
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button><Button onClick={handleSave} disabled={isPending || !name.trim()}>{isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save</Button></DialogFooter>
  </DialogContent></Dialog>)
}

const DEFAULT_PO_COLS = ['sku', 'name', 'type', 'qtyOrdered', 'qtyReceived', 'netQty', 'totalGbp', 'landedCostGbp', 'avgUnitCostGbp', 'incomingQty', 'supplierCount', 'poCount']

export function PurchaseStatsClient({ products, received, bills, aging, details, savedViews }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [showFilter, setShowFilter] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showSaveView, setShowSaveView] = useState(false)
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_PO_COLS)
  const [sortCol, setSortCol] = useState<string | null>('totalGbp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [search, setSearch] = useState('')

  function loadView(view: SavedView) { setTab(view.tab.replace('po_', '') as Tab); setVisibleCols(view.columns); setFilterRules(view.filters.map((f) => ({ ...f, id: makeId() }))) }
  const sq = search.toLowerCase()

  function handleSort(key: string) { if (sortCol === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(key); setSortDir('desc') } }
  function SortIcon({ col }: { col: string }) { if (sortCol !== col) return null; return sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" /> }

  const filteredProducts = useMemo(() => {
    let r = products
    for (const rule of filterRules) { if (rule.value) r = r.filter((row) => applyFilter(getVal(row, rule.field), rule)) }
    if (sortCol) r = [...r].sort((a, b) => { const va = getVal(a, sortCol) ?? 0; const vb = getVal(b, sortCol) ?? 0; const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)); return sortDir === 'asc' ? c : -c })
    return r
  }, [products, filterRules, sortCol, sortDir])

  // Summary
  const totalSpend = products.reduce((s, r) => s + r.totalGbp, 0)
  const totalLanded = products.reduce((s, r) => s + r.landedCostGbp, 0)
  const totalOrdered = products.reduce((s, r) => s + r.qtyOrdered, 0)
  const totalReceived = products.reduce((s, r) => s + r.qtyReceived, 0)

  const TH = ({ col, children, right }: { col: string; children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`} onClick={() => handleSort(col)}>
      {children} <SortIcon col={col} />
    </th>
  )

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Purchase Statistics</h1>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Spend</p><p className="text-xl font-bold">{fmtGbp(totalSpend)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Landed Cost</p><p className="text-xl font-bold">{fmtGbp(totalLanded)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Ordered</p><p className="text-xl font-bold">{totalOrdered}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Received</p><p className="text-xl font-bold">{totalReceived}</p></div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 pb-1">
          {savedViews.filter((v) => v.tab.startsWith('po_')).length > 0 && (
            <select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue="">
              <option value="" disabled>Saved Views…</option>
              {savedViews.filter((v) => v.tab.startsWith('po_')).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          {tab === 'products' && (
            <>
              <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}>
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
          {tab !== 'products' && <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 text-xs w-48" />}
          <a href={`/api/export/analytics?type=po_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted">
            <Download className="h-3 w-3" />CSV
          </a>
        </div>
      </div>

      {/* Products — dynamic columns */}
      {tab === 'products' && (() => {
        const colR: Record<string, { label: string; align: string; render: (r: PurchaseProductRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
          sku: { label: 'Product', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />, footer: () => <span>Totals</span> },
          name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-32 block">{r.name}</span> },
          type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
          stockUnit: { label: 'Unit', align: 'left', render: (r) => <span className="text-xs">{r.stockUnit}</span> },
          qtyOrdered: { label: 'Ordered', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.qtyOrdered}</span>, footer: () => <span className="tabular-nums">{totalOrdered}</span> },
          qtyReceived: { label: 'Received', align: 'right', render: (r) => <span className="tabular-nums text-xs text-green-600">{r.qtyReceived}</span>, footer: () => <span className="tabular-nums text-green-600">{totalReceived}</span> },
          qtyReturned: { label: 'Returned', align: 'right', render: (r) => <span className="tabular-nums text-xs text-orange-600">{r.qtyReturned > 0 ? r.qtyReturned : '—'}</span> },
          netQty: { label: 'Net Qty', align: 'right', render: (r) => <span className="tabular-nums text-xs font-medium">{r.netQty}</span> },
          totalGbp: { label: 'Total (£)', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.totalGbp)}</span>, footer: () => <span className="tabular-nums font-mono">{fmtGbp(totalSpend)}</span> },
          landedCostGbp: { label: 'Landed (£)', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.landedCostGbp > 0 ? fmtGbp(r.landedCostGbp) : '—'}</span>, footer: () => <span className="tabular-nums font-mono text-muted-foreground">{fmtGbp(totalLanded)}</span> },
          avgUnitCostGbp: { label: 'Avg Cost (£)', align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtGbp(r.avgUnitCostGbp)}</span> },
          incomingQty: { label: 'Incoming', align: 'right', render: (r) => <span className={`tabular-nums text-xs ${r.incomingQty > 0 ? 'text-blue-600 font-medium' : 'text-muted-foreground'}`}>{r.incomingQty > 0 ? r.incomingQty : '—'}</span> },
          supplierCount: { label: 'Suppliers', align: 'right', render: (r) => <span className="tabular-nums text-xs text-muted-foreground">{r.supplierCount}</span> },
          poCount: { label: 'POs', align: 'right', render: (r) => <span className="tabular-nums text-xs text-muted-foreground">{r.poCount}</span> },
        }
        return (
          <div className="rounded-md border overflow-hidden">
            <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{filteredProducts.length} of {products.length} products</div>
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
              {visibleCols.map((k) => { const c = colR[k]; return c ? <TH key={k} col={k} right={c.align === 'right'}>{c.label}</TH> : null })}
            </tr></thead><tbody className="divide-y">
              {filteredProducts.map((r) => (
                <tr key={r.productId} className="hover:bg-muted/30">
                  {visibleCols.map((k) => { const c = colR[k]; return c ? <td key={k} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(r)}</td> : null })}
                </tr>))}
            </tbody>
            <tfoot className="border-t bg-muted/30 font-medium text-sm"><tr>
              {visibleCols.map((k) => { const c = colR[k]; return <td key={k} className={`px-3 py-2 ${c?.align === 'right' ? 'text-right' : ''}`}>{c?.footer?.() ?? ''}</td> })}
            </tr></tfoot></table></div>
          </div>
        )
      })()}

      {/* Received Goods */}
      {tab === 'received' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PO Reference</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Received</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Warehouse</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Lines</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Qty</th>
        </tr></thead><tbody className="divide-y">
          {received.filter((r) => !sq || r.poReference.toLowerCase().includes(sq) || r.supplierName.toLowerCase().includes(sq)).map((r) => (
            <tr key={r.receiptId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${r.poId}`} className="hover:underline">{r.poReference}</Link></td>
              <td className="px-3 py-2 text-xs">{r.supplierName}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.receivedAt)}</td>
              <td className="px-3 py-2 text-xs">{r.warehouseCode ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.lineCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">{r.totalQty}</td>
            </tr>))}
        </tbody></table>{received.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No receipts found.</p>}</div>
      )}

      {/* Bills */}
      {tab === 'bills' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice #</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PO</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total (£)</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PDF</th>
        </tr></thead><tbody className="divide-y">
          {bills.filter((b) => !sq || (b.invoiceNumber ?? '').toLowerCase().includes(sq) || b.supplierName.toLowerCase().includes(sq)).map((b) => (
            <tr key={b.invoiceId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs font-medium">{b.invoiceNumber ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${b.poId}`} className="hover:underline">{b.poReference}</Link></td>
              <td className="px-3 py-2 text-xs">{b.supplierName}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(b.invoiceDate)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(b.totalGbp)}</td>
              <td className="px-3 py-2">{b.supplierInvoiceUrl && <a href={`/api${b.supplierInvoiceUrl}`} target="_blank" rel="noopener" className="text-blue-600 hover:underline text-xs flex items-center gap-0.5"><FileText className="h-3 w-3" />View</a>}</td>
            </tr>))}
        </tbody></table>{bills.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No bills found.</p>}</div>
      )}

      {/* Supplier Aging */}
      {tab === 'aging' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total Invoiced</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">POs</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Avg Lead Time</th>
        </tr></thead><tbody className="divide-y">
          {aging.filter((a) => !sq || a.supplierName.toLowerCase().includes(sq)).map((a) => (
            <tr key={a.supplierId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-medium">{a.supplierName}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.totalInvoiced)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{a.poCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{a.avgLeadTimeDays != null ? `${a.avgLeadTimeDays}d` : '—'}</td>
            </tr>))}
        </tbody></table>{aging.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No supplier data found.</p>}</div>
      )}

      {/* Details */}
      {tab === 'details' && (
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Reference</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Currency</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total (£)</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Lines</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Created</th>
        </tr></thead><tbody className="divide-y">
          {details.filter((d) => !sq || d.reference.toLowerCase().includes(sq) || d.supplierName.toLowerCase().includes(sq)).map((d) => (
            <tr key={d.poId} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${d.poId}`} className="hover:underline">{d.reference}</Link>{d.type === 'FREIGHT' && <span className="ml-1 text-[10px] bg-amber-100 text-amber-800 px-1 rounded">LC</span>}</td>
              <td className="px-3 py-2 text-xs">{d.type}</td>
              <td className="px-3 py-2 text-xs">{d.status}</td>
              <td className="px-3 py-2 text-xs">{d.supplierName}</td>
              <td className="px-3 py-2 text-xs font-mono">{d.currency}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{d.totalForeign.toFixed(2)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(d.totalGbp)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{d.lineCount}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(d.createdAt)}</td>
            </tr>))}
        </tbody></table>{details.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No purchase orders found.</p>}</div>
      )}

      {showFilter && <FilterDialog rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
