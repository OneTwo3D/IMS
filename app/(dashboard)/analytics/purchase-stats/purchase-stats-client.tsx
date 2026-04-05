'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Download, Settings2, Save, Loader2, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProductLink } from '@/components/inventory/product-link'
import type { PurchaseProductRow, ReceivedGoodsRow, BillRow, SupplierAgingRow, PurchaseDetailRow } from '@/app/actions/purchase-stats'
import { saveView, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'products' | 'received' | 'bills' | 'aging' | 'details'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'
type Props = { products: PurchaseProductRow[]; received: ReceivedGoodsRow[]; bills: BillRow[]; aging: SupplierAgingRow[]; details: PurchaseDetailRow[]; savedViews: SavedView[] }

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' }, { key: 'received', label: 'Received Goods' },
  { key: 'bills', label: 'Bills' }, { key: 'aging', label: 'Supplier Aging' }, { key: 'details', label: 'Details' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// Shared filter infrastructure
const PRODUCT_FIELDS = [
  { key: 'sku', label: 'SKU', type: 'text' as const }, { key: 'name', label: 'Product Name', type: 'text' as const },
  { key: 'type', label: 'Product Type', type: 'select' as const, options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'barcode', label: 'Barcode', type: 'text' as const }, { key: 'supplierName', label: 'Supplier', type: 'text' as const },
  { key: 'qtyOrdered', label: 'Qty Ordered', type: 'number' as const }, { key: 'qtyReceived', label: 'Qty Received', type: 'number' as const },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' as const }, { key: 'avgUnitCostGbp', label: 'Avg Unit Cost', type: 'number' as const },
  { key: 'incomingQty', label: 'Incoming', type: 'number' as const }, { key: 'poCount', label: 'PO Count', type: 'number' as const },
]
const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]
function getOps(k: string) { const f = PRODUCT_FIELDS.find((p) => p.key === k); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(k: string) { return PRODUCT_FIELDS.find((p) => p.key === k)?.options }
function applyF(val: unknown, r: FilterRule): boolean { const v = String(val ?? '').toLowerCase(); const rv = r.value.toLowerCase(); switch (r.operator) { case 'contains': return v.includes(rv); case 'equals': case 'is': return v === rv; case 'is_not': return v !== rv; case '>': return Number(val) > Number(r.value); case '>=': return Number(val) >= Number(r.value); case '<': return Number(val) < Number(r.value); case '<=': return Number(val) <= Number(r.value); case '=': return Number(val) === Number(r.value); default: return true } }

function FilterDialog({ rules, onApply, onClose }: { rules: FilterRule[]; onApply: (r: FilterRule[]) => void; onClose: () => void }) {
  const [l, setL] = useState<FilterRule[]>(rules.length ? [...rules] : [])
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl"><DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
    <div className="space-y-3 min-h-[200px]">{l.map((r) => (<div key={r.id} className="flex items-center gap-2">
      <select value={r.field} onChange={(e) => { const f = e.target.value; setL((p) => p.map((x) => x.id === r.id ? { ...x, field: f, operator: getOps(f)[0].value, value: '' } : x)) }} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">{PRODUCT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      <select value={r.operator} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, operator: e.target.value } : x))} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32">{getOps(r.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      {getOpts(r.field) ? <select value={r.value} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, value: e.target.value } : x))} className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs"><option value="">Select…</option>{getOpts(r.field)!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : <Input value={r.value} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, value: e.target.value } : x))} placeholder="Value" className="flex-1 h-8 text-xs" />}
      <button type="button" onClick={() => setL((p) => p.filter((x) => x.id !== r.id))} className="text-destructive"><X className="h-4 w-4" /></button>
    </div>))}
      <button type="button" onClick={() => setL((p) => [...p, { id: makeId(), field: 'sku', operator: 'contains', value: '' }])} className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" />Add Filter</button>
    </div><DialogFooter><Button variant="outline" onClick={() => { onApply([]); onClose() }}>Reset</Button><Button onClick={() => { onApply(l.filter((r) => r.value)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

function ColumnPickerDialog({ fields, visible, onApply, onClose }: { fields: { key: string; label: string }[]; visible: string[]; onApply: (c: string[]) => void; onClose: () => void }) {
  const [s, setS] = useState<Set<string>>(new Set(visible))
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
    <div className="space-y-1 max-h-80 overflow-y-auto">{fields.map((f) => (<label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1"><input type="checkbox" checked={s.has(f.key)} onChange={() => setS((p) => { const n = new Set(p); n.has(f.key) ? n.delete(f.key) : n.add(f.key); return n })} className="rounded border-input" />{f.label}</label>))}</div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => { onApply(Array.from(s)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

function SaveViewDialog({ tab, columns, filters, onClose }: { tab: string; columns: string[]; filters: FilterRule[]; onClose: () => void }) {
  const router = useRouter(); const [isPending, startTransition] = useTransition(); const [name, setName] = useState('')
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Save View</DialogTitle></DialogHeader>
    <div className="space-y-3"><div className="space-y-1.5"><Label>View Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" autoFocus /></div></div>
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button><Button onClick={() => { if (!name.trim()) return; startTransition(async () => { await saveView({ id: makeId(), name, tab: `po_${tab}`, columns, filters: filters.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }); router.refresh(); onClose() }) }} disabled={isPending || !name.trim()}>{isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save</Button></DialogFooter>
  </DialogContent></Dialog>)
}

export function PurchaseStatsClient({ products, received, bills, aging, details, savedViews }: Props) {
  const router = useRouter(); const [isPending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [showFilter, setShowFilter] = useState(false); const [showColPicker, setShowColPicker] = useState(false); const [showSaveView, setShowSaveView] = useState(false)
  const [visibleCols, setVisibleCols] = useState<string[]>(['sku', 'name', 'type', 'barcode', 'supplierName', 'qtyOrdered', 'qtyReceived', 'totalGbp', 'avgUnitCostGbp', 'incomingQty', 'poCount', 'createdAt'])
  const [sortCol, setSortCol] = useState<string | null>('totalGbp'); const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [search, setSearch] = useState(''); const sq = search.toLowerCase()

  function handleSort(k: string) { if (sortCol === k) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(k); setSortDir('desc') } }
  function loadView(v: SavedView) { setTab(v.tab.replace('po_', '') as Tab); setVisibleCols(v.columns); setFilterRules(v.filters.map((f) => ({ ...f, id: makeId() }))) }
  const SI = ({ c }: { c: string }) => sortCol === c ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />) : null
  const TH = ({ c, children, r: right }: { c: string; children: React.ReactNode; r?: boolean }) => (
    <th className={`px-3 py-2 text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`} onClick={() => handleSort(c)}>{children} <SI c={c} /></th>)

  const fp = useMemo(() => {
    let r = products; for (const rule of filterRules) { if (rule.value) r = r.filter((row) => applyF((row as Record<string, unknown>)[rule.field], rule)) }
    if (sortCol) r = [...r].sort((a, b) => { const va = (a as Record<string, unknown>)[sortCol] ?? 0; const vb = (b as Record<string, unknown>)[sortCol] ?? 0; const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)); return sortDir === 'asc' ? c : -c })
    return r
  }, [products, filterRules, sortCol, sortDir])

  const totalSpend = products.reduce((s, r) => s + r.totalGbp, 0)
  const totalLanded = products.reduce((s, r) => s + r.landedCostGbp, 0)
  const totalOrdered = products.reduce((s, r) => s + r.qtyOrdered, 0)
  const totalReceived = products.reduce((s, r) => s + r.qtyReceived, 0)

  const allCols = [...PRODUCT_FIELDS, { key: 'createdAt', label: 'Created At' }, { key: 'landedCostGbp', label: 'Landed Cost (£)' }, { key: 'netQty', label: 'Net Qty' }, { key: 'stockUnit', label: 'Unit' }, { key: 'supplierCount', label: 'Suppliers' }]
  const colR: Record<string, { label: string; align: string; render: (r: PurchaseProductRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
    sku: { label: 'Product', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />, footer: () => <span>Totals</span> },
    name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-32 block">{r.name}</span> },
    type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
    barcode: { label: 'Barcode', align: 'left', render: (r) => <span className="text-xs font-mono">{r.barcode ?? '—'}</span> },
    supplierName: { label: 'Supplier', align: 'left', render: (r) => <span className="text-xs">{r.supplierName ?? '—'}</span> },
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
    createdAt: { label: 'Created', align: 'left', render: (r) => <span className="text-xs text-muted-foreground">{r.createdAt ? fmtDate(r.createdAt) : '—'}</span> },
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Purchase Statistics</h1>
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Spend</p><p className="text-xl font-bold">{fmtGbp(totalSpend)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Landed Cost</p><p className="text-xl font-bold">{fmtGbp(totalLanded)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Ordered</p><p className="text-xl font-bold">{totalOrdered}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Received</p><p className="text-xl font-bold">{totalReceived}</p></div>
      </div>

      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (<button key={t.key} type="button" className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(t.key)}>{t.label}</button>))}
        <div className="ml-auto flex items-center gap-1.5 pb-1">
          {savedViews.filter((v) => v.tab.startsWith('po_')).length > 0 && (<select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue=""><option value="" disabled>Saved Views…</option>{savedViews.filter((v) => v.tab.startsWith('po_')).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>)}
          {tab === 'products' && (<><Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}><Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}><Settings2 className="h-3 w-3 mr-0.5" />Columns</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}><Save className="h-3 w-3 mr-0.5" />Save View</Button></>)}
          {tab !== 'products' && <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-7 text-xs w-48" />}
          <a href={`/api/export/analytics?type=po_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted"><Download className="h-3 w-3" />CSV</a>
        </div>
      </div>

      {/* Products */}
      {tab === 'products' && (<div className="rounded-md border overflow-hidden">
        <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{fp.length} of {products.length} products</div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          {visibleCols.map((k) => { const c = colR[k]; return c ? <TH key={k} c={k} r={c.align === 'right'}>{c.label}</TH> : null })}</tr></thead>
          <tbody className="divide-y">{fp.map((r) => (<tr key={r.productId} className="hover:bg-muted/30">
            {visibleCols.map((k) => { const c = colR[k]; return c ? <td key={k} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(r)}</td> : null })}</tr>))}
          </tbody><tfoot className="border-t bg-muted/30 font-medium text-sm"><tr>
            {visibleCols.map((k) => { const c = colR[k]; return <td key={k} className={`px-3 py-2 ${c?.align === 'right' ? 'text-right' : ''}`}>{c?.footer?.() ?? ''}</td> })}</tr></tfoot>
        </table></div></div>)}

      {/* Received Goods — line level */}
      {tab === 'received' && (<div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PO</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">GRN</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">SKU</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Warehouse</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Qty</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Amount (£)</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Landed Cost</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Unit Cost (£)</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Received</th>
      </tr></thead><tbody className="divide-y">
        {received.filter((r) => !sq || r.sku.toLowerCase().includes(sq) || r.supplierName.toLowerCase().includes(sq) || r.productName.toLowerCase().includes(sq)).map((r) => (
          <tr key={r.receiptLineId} className="hover:bg-muted/30">
            <td className="px-3 py-2"><ProductLink productId={r.productId} sku={r.sku} name={r.productName} /></td>
            <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${r.poId}`} className="hover:underline">{r.poReference}</Link></td>
            <td className="px-3 py-2 text-xs">{r.supplierName}</td>
            <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{r.grnReference ?? '—'}</td>
            <td className="px-3 py-2 text-xs font-mono">{r.sku}</td>
            <td className="px-3 py-2 text-xs">{r.warehouseCode ?? '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">{r.qtyReceived}</td>
            <td className="px-3 py-2"><span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 border-green-200">{r.status}</span></td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(r.totalGbp)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{r.landedUnitCostGbp > 0 ? fmtGbp(r.landedUnitCostGbp) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(r.unitCostGbp)}</td>
            <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(r.receivedAt)}</td>
          </tr>))}
      </tbody></table>{received.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No receipts.</p>}</div>)}

      {/* Bills — line level */}
      {tab === 'bills' && (<div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PO</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Bill #</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">SKU</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Qty</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Foreign</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Amount (£)</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PDF</th>
      </tr></thead><tbody className="divide-y">
        {bills.filter((b) => !sq || b.sku.toLowerCase().includes(sq) || b.supplierName.toLowerCase().includes(sq) || (b.invoiceNumber ?? '').toLowerCase().includes(sq)).map((b) => (
          <tr key={b.invoiceLineId} className="hover:bg-muted/30">
            <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${b.poId}`} className="hover:underline">{b.poReference}</Link></td>
            <td className="px-3 py-2 text-xs">{b.supplierName}</td>
            <td className="px-3 py-2 text-xs font-mono font-medium">{b.invoiceNumber ?? '—'}</td>
            <td className="px-3 py-2"><ProductLink productId={b.productId} sku={b.sku} name={b.productName} /></td>
            <td className="px-3 py-2 text-xs font-mono">{b.sku}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs">{b.qtyBilled}</td>
            <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(b.invoiceDate)}</td>
            <td className="px-3 py-2"><span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{b.status}</span></td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{b.totalForeign.toFixed(2)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(b.totalGbp)}</td>
            <td className="px-3 py-2">{b.supplierInvoiceUrl && <a href={`/api${b.supplierInvoiceUrl}`} target="_blank" rel="noopener" className="text-blue-600 hover:underline text-xs flex items-center gap-0.5"><FileText className="h-3 w-3" />View</a>}</td>
          </tr>))}
      </tbody></table>{bills.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No bills.</p>}</div>)}

      {/* Supplier Aging — with full buckets */}
      {tab === 'aging' && (<div className="rounded-md border overflow-hidden overflow-x-auto"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Gross Amount</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Discounts</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Refunds</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Net Amount</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Landed Costs</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Tax</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Billed</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Due</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">0-30d</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">31-60d</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">61-90d</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">91d+</th>
      </tr></thead><tbody className="divide-y">
        {aging.filter((a) => !sq || a.supplierName.toLowerCase().includes(sq)).map((a) => (
          <tr key={a.supplierId} className="hover:bg-muted/30">
            <td className="px-3 py-2 font-medium whitespace-nowrap">{a.supplierName}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.grossAmount)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{a.discounts > 0 ? fmtGbp(a.discounts) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-orange-600">{a.refunds > 0 ? fmtGbp(a.refunds) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.netAmount)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{a.landedCosts > 0 ? fmtGbp(a.landedCosts) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono text-muted-foreground">{a.tax > 0 ? fmtGbp(a.tax) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono font-medium">{fmtGbp(a.totalAmount)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(a.billedAmount)}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.dueAmount > 0 ? 'text-destructive font-medium' : ''}>{a.dueAmount > 0 ? fmtGbp(a.dueAmount) : '—'}</span></td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{a.overdue0_30 > 0 ? fmtGbp(a.overdue0_30) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{a.overdue31_60 > 0 ? fmtGbp(a.overdue31_60) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.overdue61_90 > 0 ? 'text-orange-600' : ''}>{a.overdue61_90 > 0 ? fmtGbp(a.overdue61_90) : '—'}</span></td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono"><span className={a.overdue91plus > 0 ? 'text-destructive font-medium' : ''}>{a.overdue91plus > 0 ? fmtGbp(a.overdue91plus) : '—'}</span></td>
          </tr>))}
      </tbody></table>{aging.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No data.</p>}</div>)}

      {/* Details — line level */}
      {tab === 'details' && (<div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">PO</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">SKU</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Barcode</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Qty</th>
        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total (£)</th>
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Created</th>
      </tr></thead><tbody className="divide-y">
        {details.filter((d) => !sq || d.sku.toLowerCase().includes(sq) || d.supplierName.toLowerCase().includes(sq) || d.reference.toLowerCase().includes(sq)).map((d, i) => (
          <tr key={`${d.poId}-${d.lineProductId}-${i}`} className="hover:bg-muted/30">
            <td className="px-3 py-2"><ProductLink productId={d.lineProductId} sku={d.sku} name={d.productName} /></td>
            <td className="px-3 py-2 font-mono text-xs"><Link href={`/purchase-orders/${d.poId}`} className="hover:underline">{d.reference}</Link></td>
            <td className="px-3 py-2 text-xs font-mono">{d.sku}</td>
            <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{d.barcode ?? '—'}</td>
            <td className="px-3 py-2 text-xs">{d.type}</td>
            <td className="px-3 py-2 text-xs">{d.supplierName}</td>
            <td className="px-3 py-2"><span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{d.status}</span></td>
            <td className="px-3 py-2 text-right tabular-nums text-xs">{d.qty}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs font-mono">{fmtGbp(d.totalGbp)}</td>
            <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(d.createdAt)}</td>
          </tr>))}
      </tbody></table>{details.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">No POs.</p>}</div>)}

      {showFilter && <FilterDialog rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog fields={allCols} visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
