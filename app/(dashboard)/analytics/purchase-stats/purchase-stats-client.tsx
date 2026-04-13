'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Filter, X, Plus, ArrowUp, ArrowDown, Download, Settings2, Save, Loader2, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ProductLink } from '@/components/inventory/product-link'
import type { PurchaseProductRow, ReceivedGoodsRow, BillRow, SupplierAgingRow, PurchaseDetailRow } from '@/app/actions/purchase-stats'
import { saveView, type SavedView } from '@/app/actions/sales-stats'

type Tab = 'products' | 'received' | 'bills' | 'aging' | 'details'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'
type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }
type Props = { products: PurchaseProductRow[]; received: ReceivedGoodsRow[]; bills: BillRow[]; aging: SupplierAgingRow[]; details: PurchaseDetailRow[]; savedViews: SavedView[] }

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' }, { key: 'received', label: 'Received Goods' },
  { key: 'bills', label: 'Bills' }, { key: 'aging', label: 'Supplier Aging' }, { key: 'details', label: 'Details' },
]

function fmtGbp(v: number): string { return `£${v.toFixed(2)}` }
function fmtDate(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function makeId() { return Math.random().toString(36).slice(2, 8) }

// ---------------------------------------------------------------------------
// Field definitions per tab
// ---------------------------------------------------------------------------
const PRODUCT_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product Name', type: 'text' },
  { key: 'type', label: 'Product Type', type: 'select', options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'barcode', label: 'Barcode', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'qtyOrdered', label: 'Qty Ordered', type: 'number' }, { key: 'qtyReceived', label: 'Qty Received', type: 'number' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' }, { key: 'avgUnitCostGbp', label: 'Avg Unit Cost', type: 'number' },
  { key: 'incomingQty', label: 'Incoming', type: 'number' }, { key: 'poCount', label: 'PO Count', type: 'number' },
  { key: 'createdAt', label: 'Created At', type: 'text' }, { key: 'landedCostGbp', label: 'Landed Cost (£)', type: 'number' },
  { key: 'netQty', label: 'Net Qty', type: 'number' }, { key: 'stockUnit', label: 'Unit', type: 'text' },
  { key: 'supplierCount', label: 'Suppliers', type: 'number' }, { key: 'qtyReturned', label: 'Qty Returned', type: 'number' },
]

const RECEIVED_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' }, { key: 'poReference', label: 'PO', type: 'text' },
  { key: 'supplierName', label: 'Supplier', type: 'text' }, { key: 'grnReference', label: 'GRN', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'warehouseCode', label: 'Warehouse', type: 'text' },
  { key: 'qtyReceived', label: 'Qty', type: 'number' }, { key: 'status', label: 'Status', type: 'text' },
  { key: 'totalGbp', label: 'Amount (£)', type: 'number' }, { key: 'landedUnitCostGbp', label: 'Landed Cost', type: 'number' },
  { key: 'unitCostGbp', label: 'Unit Cost (£)', type: 'number' }, { key: 'receivedAt', label: 'Received', type: 'text' },
]

const BILL_FIELDS: FieldDef[] = [
  { key: 'poReference', label: 'PO', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'invoiceNumber', label: 'Bill #', type: 'text' }, { key: 'productName', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'qtyBilled', label: 'Qty', type: 'number' },
  { key: 'invoiceDate', label: 'Date', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
  { key: 'totalForeign', label: 'Foreign', type: 'number' }, { key: 'totalGbp', label: 'Amount (£)', type: 'number' },
  { key: 'supplierInvoiceUrl', label: 'PDF', type: 'text' },
]

const AGING_FIELDS: FieldDef[] = [
  { key: 'supplierName', label: 'Supplier', type: 'text' }, { key: 'grossAmount', label: 'Gross Amount', type: 'number' },
  { key: 'discounts', label: 'Discounts', type: 'number' }, { key: 'refunds', label: 'Refunds', type: 'number' },
  { key: 'netAmount', label: 'Net Amount', type: 'number' }, { key: 'landedCosts', label: 'Landed Costs', type: 'number' },
  { key: 'tax', label: 'Tax', type: 'number' }, { key: 'totalAmount', label: 'Total', type: 'number' },
  { key: 'billedAmount', label: 'Billed', type: 'number' }, { key: 'dueAmount', label: 'Due', type: 'number' },
  { key: 'overdue0_30', label: '0-30d', type: 'number' }, { key: 'overdue31_60', label: '31-60d', type: 'number' },
  { key: 'overdue61_90', label: '61-90d', type: 'number' }, { key: 'overdue91plus', label: '91d+', type: 'number' },
]

const DETAIL_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' }, { key: 'reference', label: 'PO', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' }, { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'totalGbp', label: 'Total (£)', type: 'number' }, { key: 'createdAt', label: 'Created', type: 'text' },
  { key: 'currency', label: 'Currency', type: 'text' }, { key: 'unitCostForeign', label: 'Unit Cost (Foreign)', type: 'number' },
  { key: 'totalForeign', label: 'Total (Foreign)', type: 'number' },
]

const TAB_FIELDS: Record<Tab, FieldDef[]> = {
  products: PRODUCT_FIELDS,
  received: RECEIVED_FIELDS,
  bills: BILL_FIELDS,
  aging: AGING_FIELDS,
  details: DETAIL_FIELDS,
}

const DEFAULT_COLS: Record<Tab, string[]> = {
  products: ['sku', 'name', 'type', 'barcode', 'supplierName', 'qtyOrdered', 'qtyReceived', 'totalGbp', 'avgUnitCostGbp', 'incomingQty', 'poCount', 'createdAt'],
  received: ['productName', 'poReference', 'supplierName', 'grnReference', 'sku', 'warehouseCode', 'qtyReceived', 'status', 'totalGbp', 'landedUnitCostGbp', 'unitCostGbp', 'receivedAt'],
  bills: ['poReference', 'supplierName', 'invoiceNumber', 'productName', 'sku', 'qtyBilled', 'invoiceDate', 'status', 'totalForeign', 'totalGbp', 'supplierInvoiceUrl'],
  aging: ['supplierName', 'grossAmount', 'discounts', 'refunds', 'netAmount', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'dueAmount', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus'],
  details: ['productName', 'reference', 'sku', 'barcode', 'type', 'supplierName', 'status', 'qty', 'totalGbp', 'createdAt'],
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------
const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]

function getOps(fields: FieldDef[], k: string) { const f = fields.find((p) => p.key === k); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(fields: FieldDef[], k: string) { return fields.find((p) => p.key === k)?.options }
function applyF(val: unknown, r: FilterRule): boolean { const v = String(val ?? '').toLowerCase(); const rv = r.value.toLowerCase(); switch (r.operator) { case 'contains': return v.includes(rv); case 'equals': case 'is': return v === rv; case 'is_not': return v !== rv; case '>': return Number(val) > Number(r.value); case '>=': return Number(val) >= Number(r.value); case '<': return Number(val) < Number(r.value); case '<=': return Number(val) <= Number(r.value); case '=': return Number(val) === Number(r.value); default: return true } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVal(row: any, field: string): string | number | null {
  const v = row[field]
  return v === undefined ? null : v
}

function FilterDialog({ fields, rules, onApply, onClose }: { fields: FieldDef[]; rules: FilterRule[]; onApply: (r: FilterRule[]) => void; onClose: () => void }) {
  const [l, setL] = useState<FilterRule[]>(rules.length ? [...rules] : [])
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-xl sm:max-w-xl"><DialogHeader><DialogTitle>Filters</DialogTitle></DialogHeader>
    <div className="space-y-3 min-h-[200px]">{l.map((r) => (<div key={r.id} className="flex items-center gap-2">
      <select value={r.field} onChange={(e) => { const f = e.target.value; setL((p) => p.map((x) => x.id === r.id ? { ...x, field: f, operator: getOps(fields, f)[0].value, value: '' } : x)) }} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40">{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      <select value={r.operator} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, operator: e.target.value } : x))} className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32">{getOps(fields, r.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      {getOpts(fields, r.field) ? <select value={r.value} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, value: e.target.value } : x))} className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs"><option value="">Select…</option>{getOpts(fields, r.field)!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : <Input value={r.value} onChange={(e) => setL((p) => p.map((x) => x.id === r.id ? { ...x, value: e.target.value } : x))} placeholder="Value" className="flex-1 h-8 text-xs" />}
      <button type="button" onClick={() => setL((p) => p.filter((x) => x.id !== r.id))} className="text-destructive"><X className="h-4 w-4" /></button>
    </div>))}
      <button type="button" onClick={() => setL((p) => [...p, { id: makeId(), field: fields[0].key, operator: 'contains', value: '' }])} className="w-full flex items-center justify-center gap-1 rounded-md border border-dashed border-input py-2 text-xs text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" />Add Filter</button>
    </div><DialogFooter><Button variant="outline" onClick={() => { onApply([]); onClose() }}>Reset</Button><Button onClick={() => { onApply(l.filter((r) => r.value)); onClose() }}>Apply</Button></DialogFooter>
  </DialogContent></Dialog>)
}

function ColumnPickerDialog({ fields, visible, onApply, onClose }: { fields: FieldDef[]; visible: string[]; onApply: (c: string[]) => void; onClose: () => void }) {
  const [s, setS] = useState<Set<string>>(new Set(visible))
  return (<Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm"><DialogHeader><DialogTitle>Columns</DialogTitle></DialogHeader>
    <div className="space-y-1 max-h-80 overflow-y-auto">{fields.map((f) => (<label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-2 py-1"><input type="checkbox" checked={s.has(f.key)} onChange={() => setS((p) => { const n = new Set(p); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n })} className="rounded border-input" />{f.label}</label>))}</div>
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
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [showFilter, setShowFilter] = useState(false); const [showColPicker, setShowColPicker] = useState(false); const [showSaveView, setShowSaveView] = useState(false)
  const [visibleColsMap, setVisibleColsMap] = useState<Record<Tab, string[]>>({ ...DEFAULT_COLS })
  const [sortCol, setSortCol] = useState<string | null>('totalGbp'); const [sortDir, setSortDir] = useState<SortDir>('desc')

  const fields = TAB_FIELDS[tab]
  const visibleCols = visibleColsMap[tab]

  function setVisibleCols(cols: string[]) {
    setVisibleColsMap((prev) => ({ ...prev, [tab]: cols }))
  }

  function handleSort(k: string) { if (sortCol === k) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(k); setSortDir('desc') } }

  function handleTabChange(t: Tab) {
    setTab(t); setFilterRules([]); setSortCol(null)
  }

  function loadView(v: SavedView) {
    const t = v.tab.replace('po_', '') as Tab
    setTab(t)
    setVisibleColsMap((prev) => ({ ...prev, [t]: v.columns }))
    setFilterRules(v.filters.map((f) => ({ ...f, id: makeId() })))
  }

  // Generic filter + sort for any tab data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function filterAndSort<T extends Record<string, any>>(data: T[]): T[] {
    let result = data
    for (const rule of filterRules) {
      if (!rule.value) continue
      result = result.filter((row) => applyF(getVal(row, rule.field), rule))
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

  const fp = filterAndSort(products)
  const filteredReceived = filterAndSort(received)
  const filteredBills = filterAndSort(bills)
  const filteredAging = filterAndSort(aging)
  const filteredDetails = filterAndSort(details)

  const SI = ({ c }: { c: string }) => sortCol === c ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />) : null

  const totalSpend = products.reduce((s, r) => s + r.totalGbp, 0)
  const totalLanded = products.reduce((s, r) => s + r.landedCostGbp, 0)
  const totalOrdered = products.reduce((s, r) => s + r.qtyOrdered, 0)
  const totalReceived = products.reduce((s, r) => s + r.qtyReceived, 0)

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

  // Column header component
  function ColHeader({ colKey, label, align }: { colKey: string; label: string; align?: 'right' | 'left' }) {
    return (
      <TableHead className={`text-xs cursor-pointer hover:text-foreground select-none ${align === 'right' ? 'text-right' : 'text-left'}`}
        onClick={() => handleSort(colKey)}>
        <span className="inline-flex items-center gap-0.5">{label} <SI c={colKey} /></span>
      </TableHead>
    )
  }

  function isRightAligned(key: string): boolean {
    const f = fields.find((fd) => fd.key === key)
    if (f?.type === 'number') return true
    if (['totalGbp', 'totalForeign', 'qtyReceived', 'qtyBilled', 'unitCostGbp', 'landedUnitCostGbp', 'grossAmount', 'discounts', 'refunds', 'netAmount', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'dueAmount', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus', 'qty', 'unitCostForeign'].includes(key)) return true
    return false
  }

  // Generic cell renderer for non-product tabs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderCell(row: any, key: string, tabKey: Tab): React.ReactNode {
    const v = row[key]

    if (tabKey === 'received') {
      if (key === 'productName') return <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />
      if (key === 'poReference') return <Link href={`/purchase-orders/${row.poId}`} className="hover:underline font-mono text-xs">{row.poReference}</Link>
      if (key === 'status') return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 border-green-200">{v}</span>
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'landedUnitCostGbp') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'unitCostGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'qtyReceived') return <span className="tabular-nums text-xs font-medium">{v}</span>
      if (key === 'receivedAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
    }
    if (tabKey === 'bills') {
      if (key === 'productName') return <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />
      if (key === 'poReference') return <Link href={`/purchase-orders/${row.poId}`} className="hover:underline font-mono text-xs">{row.poReference}</Link>
      if (key === 'status') return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{v}</span>
      if (key === 'totalForeign') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{Number(v).toFixed(2)}</span>
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'invoiceDate') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'qtyBilled') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'supplierInvoiceUrl') return v ? <a href={`/api${v}`} target="_blank" rel="noopener" className="text-blue-600 hover:underline text-xs flex items-center gap-0.5"><FileText className="h-3 w-3" />View</a> : null
    }
    if (tabKey === 'aging') {
      if (key === 'grossAmount' || key === 'netAmount' || key === 'totalAmount') return <span className="tabular-nums text-xs font-mono font-medium">{fmtGbp(v)}</span>
      if (key === 'discounts') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'refunds') return <span className="tabular-nums text-xs font-mono text-orange-600">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'landedCosts' || key === 'tax') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'billedAmount') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'dueAmount') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-destructive font-medium' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue0_30') return <span className="tabular-nums text-xs font-mono">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue31_60') return <span className="tabular-nums text-xs font-mono">{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue61_90') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-orange-600' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'overdue91plus') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-destructive font-medium' : ''}`}>{v > 0 ? fmtGbp(v) : '—'}</span>
      if (key === 'supplierName') return <span className="font-medium whitespace-nowrap text-xs">{v}</span>
    }
    if (tabKey === 'details') {
      if (key === 'productName') return <ProductLink productId={row.lineProductId} sku={row.sku} name={row.productName} />
      if (key === 'reference') return <Link href={`/purchase-orders/${row.poId}`} className="hover:underline font-mono text-xs">{row.reference}</Link>
      if (key === 'status') return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{v}</span>
      if (key === 'totalGbp') return <span className="tabular-nums text-xs font-mono">{fmtGbp(v)}</span>
      if (key === 'qty') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'createdAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
    }

    // Default
    if (v == null) return <span className="text-xs text-muted-foreground">—</span>
    if (typeof v === 'number') return <span className="tabular-nums text-xs">{v}</span>
    return <span className="text-xs">{String(v)}</span>
  }

  // Render helper for non-product tabs (not a component — avoids re-creation during render)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderGenericTable(data: any[], tabKey: Tab, emptyMsg: string) {
    const cols = visibleColsMap[tabKey]
    return (
      <div className="rounded-md border">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs text-muted-foreground">{data.length} rows</span>
        </div>
        <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-20rem)]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {cols.map((key) => {
                const f = TAB_FIELDS[tabKey].find((fd) => fd.key === key)
                if (!f) return null
                return <ColHeader key={key} colKey={key} label={f.label} align={isRightAligned(key) ? 'right' : 'left'} />
              })}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {data.map((row, i) => (
              <TableRow key={row.id ?? row.receiptLineId ?? row.invoiceLineId ?? row.supplierId ?? `${row.poId}-${row.lineProductId}-${i}`}>
                {cols.map((key) => (
                  <TableCell key={key} className={isRightAligned(key) ? 'text-right' : ''}>{renderCell(row, key, tabKey)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data.length === 0 && <p className="text-center text-sm text-muted-foreground py-8">{emptyMsg}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Purchase Statistics</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Spend</p><p className="text-xl font-bold">{fmtGbp(totalSpend)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Landed Cost</p><p className="text-xl font-bold">{fmtGbp(totalLanded)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Ordered</p><p className="text-xl font-bold">{totalOrdered}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Received</p><p className="text-xl font-bold">{totalReceived}</p></div>
      </div>

      <div className="border-b">
        <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden">
          {TABS.map((t) => (<button key={t.key} type="button" className={`shrink-0 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => handleTabChange(t.key)}>{t.label}</button>))}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pb-1 pl-2">
            {savedViews.filter((v) => v.tab.startsWith('po_')).length > 0 && (<select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue=""><option value="" disabled>Saved Views…</option>{savedViews.filter((v) => v.tab.startsWith('po_')).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>)}
            <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}><Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}><Settings2 className="h-3 w-3 mr-0.5" />Columns</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}><Save className="h-3 w-3 mr-0.5" />Save View</Button>
            <a href={`/api/export/analytics?type=po_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted"><Download className="h-3 w-3" />CSV</a>
          </div>
        </div>
      </div>

      {/* Products */}
      {tab === 'products' && (<div className="rounded-md border">
        <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{fp.length} of {products.length} products</div>
        <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {visibleCols.map((k) => { const c = colR[k]; return c ? <ColHeader key={k} colKey={k} label={c.label} align={c.align === 'right' ? 'right' : 'left'} /> : null })}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {fp.map((r) => (
              <TableRow key={r.productId}>
                {visibleCols.map((k) => { const c = colR[k]; return c ? <TableCell key={k} className={c.align === 'right' ? 'text-right' : ''}>{c.render(r)}</TableCell> : null })}
              </TableRow>
            ))}
          </TableBody>
          <tfoot className="border-t bg-muted/30 font-medium text-sm">
            <tr>
              {visibleCols.map((k) => { const c = colR[k]; return <td key={k} className={`px-3 py-2 ${c?.align === 'right' ? 'text-right' : ''}`}>{c?.footer?.() ?? ''}</td> })}
            </tr>
          </tfoot>
        </Table>
      </div>)}

      {/* Other tabs — generic filterable/sortable tables */}
      {tab === 'received' && renderGenericTable(filteredReceived, 'received', 'No receipts.')}
      {tab === 'bills' && renderGenericTable(filteredBills, 'bills', 'No bills.')}
      {tab === 'aging' && renderGenericTable(filteredAging, 'aging', 'No data.')}
      {tab === 'details' && renderGenericTable(filteredDetails, 'details', 'No POs.')}

      {showFilter && <FilterDialog fields={fields} rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog fields={fields} visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {showSaveView && <SaveViewDialog tab={tab} columns={visibleCols} filters={filterRules} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
