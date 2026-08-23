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
import {
  SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED,
  SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED,
  SUPPLIER_BILLED_WITH_PAYMENT_MARKER_BASIS,
  SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS,
  SUPPLIER_BILLED_ROUNDING_RECONCILIATION,
} from '@/lib/domain/purchasing/supplier-payment-basis'
import { saveView, type SavedView } from '@/app/actions/sales-stats'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { formatMoney } from '@/lib/utils'
import { filterAndSortRows, presentColumns, presentColumnKeys, sanitiseSavedView, resolveSavedViewTab, ownedSavedViews, foreignSavedViewNotice } from '@/lib/analytics/table-filter-sort'
import { WITHHELD_CELL_TEXT, MEASURED_ZERO_CELL_TEXT, WITHHELD_HEADING_SUFFIX } from '@/lib/analytics/withheld-figure-cell'

type Tab = 'products' | 'received' | 'bills' | 'aging' | 'details'
type FilterRule = { id: string; field: string; operator: string; value: string }
type SortDir = 'asc' | 'desc'
type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }
type Props = { products: PurchaseProductRow[]; received: ReceivedGoodsRow[]; bills: BillRow[]; aging: SupplierAgingRow[]; details: PurchaseDetailRow[]; savedViews: SavedView[] }

const TABS: { key: Tab; label: string }[] = [
  { key: 'products', label: 'Products' }, { key: 'received', label: 'Received Goods' },
  { key: 'bills', label: 'Bills' }, { key: 'aging', label: 'Supplier Aging' }, { key: 'details', label: 'Details' },
]

function makeId() { return Math.random().toString(36).slice(2, 8) }

/**
 * o3d-8u4h round 2: A WITHHELD FIGURE, RENDERED SO A READER CAN TELL.
 *
 * It used to be an em dash — the same mark this table prints for a measured zero (`v > 0 ? … : '—'`
 * on Refunds, Tax, Landed Costs and every age band) — with the reason in a `title`. Two opposite
 * claims, one glyph, and the only thing separating them was a hover that a keyboard user, a
 * screenshot and a hurried reader all lack. The word is visible now; the tooltip and the qualified
 * column heading carry the reason, and the notice above the table carries it in full.
 */
function WithheldCell({ reason }: { reason: string }) {
  return <span data-withheld="true" className="text-xs italic text-muted-foreground" title={reason}>{WITHHELD_CELL_TEXT}</span>
}

/**
 * o3d-8u4h round 2: what a saved view could not bring with it, said out loud.
 *
 * A view saved before a column was renamed still names the old key, and a FILTER on a since-renamed
 * field rejects every row — so the operator used to get an empty report and no reason for it.
 */
function SavedViewNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div data-saved-view-notice="true" className="flex items-start gap-2 rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/20 px-3 py-2 text-xs text-orange-900 dark:text-orange-200">
      <span className="flex-1">{notice}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 text-orange-900/60 dark:text-orange-200/60 hover:text-orange-900 dark:hover:text-orange-200" aria-label="Dismiss">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field definitions per tab
// ---------------------------------------------------------------------------
const PRODUCT_FIELDS: FieldDef[] = [
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'name', label: 'Product Name', type: 'text' },
  { key: 'type', label: 'Product Type', type: 'select', options: ['SIMPLE', 'VARIANT', 'KIT', 'BOM'] },
  { key: 'barcode', label: 'Barcode', type: 'text' }, { key: 'mpn', label: 'MPN', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'qtyOrdered', label: 'Qty Ordered', type: 'number' }, { key: 'qtyReceived', label: 'Qty Received', type: 'number' },
  { key: 'totalBase', label: 'Total', type: 'number' }, { key: 'avgUnitCostBase', label: 'Avg Unit Cost', type: 'number' },
  { key: 'incomingQty', label: 'Incoming', type: 'number' }, { key: 'poCount', label: 'PO Count', type: 'number' },
  { key: 'createdAt', label: 'Created At', type: 'text' }, { key: 'landedCostBase', label: 'Landed Cost', type: 'number' },
  { key: 'netQty', label: 'Net Qty', type: 'number' }, { key: 'stockUnit', label: 'Unit', type: 'text' },
  { key: 'supplierCount', label: 'Suppliers', type: 'number' }, { key: 'qtyReturned', label: 'Qty Returned', type: 'number' },
]

const RECEIVED_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' }, { key: 'poReference', label: 'PO', type: 'text' },
  { key: 'supplierName', label: 'Supplier', type: 'text' }, { key: 'grnReference', label: 'GRN', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'warehouseCode', label: 'Warehouse', type: 'text' },
  { key: 'qtyReceived', label: 'Qty', type: 'number' }, { key: 'status', label: 'Status', type: 'text' },
  { key: 'totalBase', label: 'Amount', type: 'number' }, { key: 'landedUnitCostBase', label: 'Landed Cost', type: 'number' },
  { key: 'unitCostBase', label: 'Unit Cost', type: 'number' }, { key: 'receivedAt', label: 'Received', type: 'text' },
]

const BILL_FIELDS: FieldDef[] = [
  { key: 'poReference', label: 'PO', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'invoiceNumber', label: 'Bill #', type: 'text' }, { key: 'productName', label: 'Product', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'qtyBilled', label: 'Qty', type: 'number' },
  { key: 'invoiceDate', label: 'Date', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
  { key: 'totalForeign', label: 'Foreign', type: 'number' }, { key: 'totalBase', label: 'Amount', type: 'number' },
  { key: 'supplierInvoiceUrl', label: 'PDF', type: 'text' },
]

const AGING_FIELDS: FieldDef[] = [
  { key: 'supplierName', label: 'Supplier', type: 'text' }, { key: 'grossAmount', label: 'Gross Amount', type: 'number' },
  { key: 'discounts', label: `Discounts${WITHHELD_HEADING_SUFFIX}`, type: 'number' }, { key: 'refunds', label: 'Refunds', type: 'number' },
  { key: 'netAmount', label: 'Net Amount (ex-VAT)', type: 'number' }, { key: 'landedCosts', label: 'Landed Costs', type: 'number' },
  { key: 'tax', label: 'Tax', type: 'number' }, { key: 'totalAmount', label: 'Total', type: 'number' },
  { key: 'billedAmount', label: 'Billed', type: 'number' },
  // o3d-8u4h round 2: the two halves of Billed, grouped on THE RAW EVIDENCE — the bill carries a
  // payment marker (PurchaseInvoice.paidAt) or it does not. They were 'Settled'/'Unsettled', which
  // published a settlement the marker cannot prove: markBillPaid stamps it on a part-payment too.
  // Both are amounts BILLED and the headings say only that. Paid stays off this table entirely.
  { key: 'billedWithPaymentMarker', label: 'Billed w/ payment marker', type: 'number' },
  { key: 'billedWithoutPaymentMarker', label: 'Billed w/o payment marker', type: 'number' },
  // o3d-8u4h round 2: the heading carries the withholding, because a heading is read and a tooltip
  // is not. See lib/analytics/withheld-figure-cell.ts.
  { key: 'dueAmount', label: `Due${WITHHELD_HEADING_SUFFIX}`, type: 'number' },
  { key: 'billedWithoutPaymentMarker0_30', label: 'No marker 0-30d', type: 'number' }, { key: 'billedWithoutPaymentMarker31_60', label: 'No marker 31-60d', type: 'number' },
  { key: 'billedWithoutPaymentMarker61_90', label: 'No marker 61-90d', type: 'number' }, { key: 'billedWithoutPaymentMarker91plus', label: 'No marker 91d+', type: 'number' },
]

/**
 * o3d-8u4h round 2: THE REASONS, WHERE THEY ARE READ.
 *
 * These sentences were only in `title` attributes. A withheld figure that a reader cannot tell from
 * a measured zero is the defect the withholding was meant to fix, and a native tooltip reaches
 * neither a keyboard user, nor a screenshot, nor anyone reading quickly. They are rendered as a
 * persistent block above the table now, and the tooltips are kept as a bonus rather than as the
 * only channel.
 */
const AGING_NOTICES: { heading: string; body: string }[] = [
  { heading: `Discounts${WITHHELD_HEADING_SUFFIX}`, body: SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED },
  { heading: `Due${WITHHELD_HEADING_SUFFIX}`, body: SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED },
  { heading: 'Billed w/ payment marker', body: SUPPLIER_BILLED_WITH_PAYMENT_MARKER_BASIS },
  { heading: 'Billed w/o payment marker, and the four age bands', body: SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS },
  // o3d-8u4h round 3: the row asks to be added up, so how it was made to add up is on the page too.
  { heading: 'How the split adds up', body: SUPPLIER_BILLED_ROUNDING_RECONCILIATION },
]

const DETAIL_FIELDS: FieldDef[] = [
  { key: 'productName', label: 'Product', type: 'text' }, { key: 'reference', label: 'PO', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' }, { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'mpn', label: 'MPN', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' }, { key: 'supplierName', label: 'Supplier', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' }, { key: 'qty', label: 'Qty', type: 'number' },
  { key: 'totalBase', label: 'Total', type: 'number' }, { key: 'createdAt', label: 'Created', type: 'text' },
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

/**
 * o3d-8u4h round 3: the tabs THIS page owns, and the prefix its own saved views are stored under.
 * Derived from TAB_FIELDS so a retired tab cannot leave the ownership test out of date — and the
 * membership test matters on top of the prefix, because `po_<retired tab>` passes `startsWith`
 * and still indexes TAB_FIELDS with a key that is not there.
 */
const TAB_KEYS = Object.keys(TAB_FIELDS) as Tab[]
const SAVED_VIEW_TAB_PREFIX = 'po_'

const DEFAULT_COLS: Record<Tab, string[]> = {
  products: ['sku', 'name', 'type', 'barcode', 'mpn', 'supplierName', 'qtyOrdered', 'qtyReceived', 'totalBase', 'avgUnitCostBase', 'incomingQty', 'poCount', 'createdAt'],
  received: ['productName', 'poReference', 'supplierName', 'grnReference', 'sku', 'warehouseCode', 'qtyReceived', 'status', 'totalBase', 'landedUnitCostBase', 'unitCostBase', 'receivedAt'],
  bills: ['poReference', 'supplierName', 'invoiceNumber', 'productName', 'sku', 'qtyBilled', 'invoiceDate', 'status', 'totalForeign', 'totalBase', 'supplierInvoiceUrl'],
  aging: ['supplierName', 'grossAmount', 'discounts', 'refunds', 'netAmount', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'billedWithPaymentMarker', 'billedWithoutPaymentMarker', 'dueAmount', 'billedWithoutPaymentMarker0_30', 'billedWithoutPaymentMarker31_60', 'billedWithoutPaymentMarker61_90', 'billedWithoutPaymentMarker91plus'],
  details: ['productName', 'reference', 'sku', 'barcode', 'mpn', 'type', 'supplierName', 'status', 'qty', 'totalBase', 'createdAt'],
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------
const TEXT_OPS = [{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' }]
const NUM_OPS = [{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }, { value: '=', label: '=' }]
const SEL_OPS = [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]

function getOps(fields: FieldDef[], k: string) { const f = fields.find((p) => p.key === k); return f?.type === 'number' ? NUM_OPS : f?.type === 'select' ? SEL_OPS : TEXT_OPS }
function getOpts(fields: FieldDef[], k: string) { return fields.find((p) => p.key === k)?.options }
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
  const formatDateTime = useFormatDateTime()
  const fmtDate = (iso: string) => formatDateTime(iso, { day: 'numeric', month: 'short', year: 'numeric' })
  const baseCurrency = useBaseCurrency()
  const fmtBase = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  const moneyLabel = (label: string) => `${label} (${baseCurrency.code})`
  const [tab, setTab] = useState<Tab>('products')
  const [filterRules, setFilterRules] = useState<FilterRule[]>([])
  const [showFilter, setShowFilter] = useState(false); const [showColPicker, setShowColPicker] = useState(false); const [showSaveView, setShowSaveView] = useState(false)
  const [visibleColsMap, setVisibleColsMap] = useState<Record<Tab, string[]>>({ ...DEFAULT_COLS })
  const [sortCol, setSortCol] = useState<string | null>('totalBase'); const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [viewNotice, setViewNotice] = useState<string | null>(null)

  const fields = TAB_FIELDS[tab]
  const visibleCols = visibleColsMap[tab]
  // The saved views this page can actually load — the picker offers no other (o3d-8u4h round 3).
  const ownViews = ownedSavedViews(savedViews, SAVED_VIEW_TAB_PREFIX, TAB_KEYS)

  function setVisibleCols(cols: string[]) {
    setVisibleColsMap((prev) => ({ ...prev, [tab]: cols }))
  }

  function handleSort(k: string) { if (sortCol === k) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(k); setSortDir('desc') } }

  function handleTabChange(t: Tab) {
    setTab(t); setFilterRules([]); setSortCol(null); setViewNotice(null)
  }

  // o3d-8u4h round 2: A SAVED VIEW IS SANITISED ON THE WAY IN, COLUMNS AND FILTERS ALIKE.
  //
  // Round 1 filtered the COLUMNS at render and left the FILTERS untouched, which is the half that
  // silently empties the report: a rule on a field the rows no longer carry reads as an unknown for
  // every row, an unknown answers no numeric comparison, so the rule rejects every supplier. The
  // operator saw "0 rows" and nothing else. Dropped now, with a notice that names the field.
  function loadView(v: SavedView) {
    // o3d-8u4h round 3: RESOLVED, NOT STRIPPED. `replace('po_', '')` answered a key for any string
    // — a sales view, or a `po_` view naming a tab that has since been retired — and the result
    // then indexed TAB_FIELDS, which is `undefined` for both and crashes the page in
    // `sanitiseSavedView`. This page was already filtering its picker on the prefix; the prefix is
    // not the whole test.
    const t = resolveSavedViewTab(v.tab, SAVED_VIEW_TAB_PREFIX, TAB_KEYS)
    if (t === null) { setViewNotice(foreignSavedViewNotice(v.name, v.tab)); return }
    const clean = sanitiseSavedView({ name: v.name, columns: v.columns, filters: v.filters }, TAB_FIELDS[t])
    setTab(t)
    // COLUMNS ARE PUT INTO STATE VERBATIM, AND FILTERED AT EVERY RENDER PATH INSTEAD. Deliberate,
    // and the reason is that there must be exactly ONE rule about a key this tab cannot render.
    // Sanitising here as well would make the per-render-path filters unreachable — dead guards that
    // no test can exercise and the next reviewer has to take on trust — while the render paths are
    // where the invariant actually lives: header, body and totals row must read the SAME list. The
    // notice below still names the columns that will not appear, so the reader is told either way.
    setVisibleColsMap((prev) => ({ ...prev, [t]: v.columns }))
    setFilterRules(clean.filters.map((f) => ({ ...f, id: makeId() })))
    setSortCol(null)
    setViewNotice(clean.notice)
  }

  // Generic filter + sort for any tab data — shared with the sales and inventory stat pages, so a
  // supplier with NO established average lead time is not ordered as if it were the fastest
  // (o3d-iigc round 2).
  function filterAndSort<T extends object>(data: T[]): T[] {
    return filterAndSortRows(data, filterRules, sortCol, sortDir)
  }

  const fp = filterAndSort(products)
  const filteredReceived = filterAndSort(received)
  const filteredBills = filterAndSort(bills)
  const filteredAging = filterAndSort(aging)
  const filteredDetails = filterAndSort(details)

  const SI = ({ c }: { c: string }) => sortCol === c ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 inline" /> : <ArrowDown className="h-3 w-3 inline" />) : null

  const totalSpend = products.reduce((s, r) => s + r.totalBase, 0)
  const totalLanded = products.reduce((s, r) => s + r.landedCostBase, 0)
  const totalOrdered = products.reduce((s, r) => s + r.qtyOrdered, 0)
  const totalReceived = products.reduce((s, r) => s + r.qtyReceived, 0)

  const colR: Record<string, { label: string; align: string; render: (r: PurchaseProductRow) => React.ReactNode; footer?: () => React.ReactNode }> = {
    sku: { label: 'Product', align: 'left', render: (r) => <ProductLink productId={r.productId} sku={r.sku} name={r.name} />, footer: () => <span>Totals</span> },
    name: { label: 'Name', align: 'left', render: (r) => <span className="text-xs truncate max-w-32 block">{r.name}</span> },
    type: { label: 'Type', align: 'left', render: (r) => <span className="text-xs">{r.type}</span> },
    barcode: { label: 'Barcode', align: 'left', render: (r) => <span className="text-xs font-mono">{r.barcode ?? '—'}</span> },
    mpn: { label: 'MPN', align: 'left', render: (r) => <span className="text-xs font-mono">{r.mpn ?? '—'}</span> },
    supplierName: { label: 'Supplier', align: 'left', render: (r) => <span className="text-xs">{r.supplierName ?? '—'}</span> },
    stockUnit: { label: 'Unit', align: 'left', render: (r) => <span className="text-xs">{r.stockUnit}</span> },
    qtyOrdered: { label: 'Ordered', align: 'right', render: (r) => <span className="tabular-nums text-xs">{r.qtyOrdered}</span>, footer: () => <span className="tabular-nums">{totalOrdered}</span> },
    qtyReceived: { label: 'Received', align: 'right', render: (r) => <span className="tabular-nums text-xs text-green-600">{r.qtyReceived}</span>, footer: () => <span className="tabular-nums text-green-600">{totalReceived}</span> },
    qtyReturned: { label: 'Returned', align: 'right', render: (r) => <span className="tabular-nums text-xs text-orange-600">{r.qtyReturned > 0 ? r.qtyReturned : '—'}</span> },
    netQty: { label: 'Net Qty', align: 'right', render: (r) => <span className="tabular-nums text-xs font-medium">{r.netQty}</span> },
    totalBase: { label: moneyLabel('Total'), align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtBase(r.totalBase)}</span>, footer: () => <span className="tabular-nums font-mono">{fmtBase(totalSpend)}</span> },
    landedCostBase: { label: moneyLabel('Landed'), align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono text-muted-foreground">{r.landedCostBase > 0 ? fmtBase(r.landedCostBase) : '—'}</span>, footer: () => <span className="tabular-nums font-mono text-muted-foreground">{fmtBase(totalLanded)}</span> },
    avgUnitCostBase: { label: moneyLabel('Avg Cost'), align: 'right', render: (r) => <span className="tabular-nums text-xs font-mono">{fmtBase(r.avgUnitCostBase)}</span> },
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
    if (['totalBase', 'totalForeign', 'qtyReceived', 'qtyBilled', 'unitCostBase', 'landedUnitCostBase', 'grossAmount', 'discounts', 'refunds', 'netAmount', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'billedWithPaymentMarker', 'billedWithoutPaymentMarker', 'dueAmount', 'billedWithoutPaymentMarker0_30', 'billedWithoutPaymentMarker31_60', 'billedWithoutPaymentMarker61_90', 'billedWithoutPaymentMarker91plus', 'qty', 'unitCostForeign'].includes(key)) return true
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
      if (key === 'totalBase') return <span className="tabular-nums text-xs font-mono">{fmtBase(v)}</span>
      if (key === 'landedUnitCostBase') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{v > 0 ? fmtBase(v) : '—'}</span>
      if (key === 'unitCostBase') return <span className="tabular-nums text-xs font-mono">{fmtBase(v)}</span>
      if (key === 'qtyReceived') return <span className="tabular-nums text-xs font-medium">{v}</span>
      if (key === 'receivedAt') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
    }
    if (tabKey === 'bills') {
      if (key === 'productName') return <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />
      if (key === 'poReference') return <Link href={`/purchase-orders/${row.poId}`} className="hover:underline font-mono text-xs">{row.poReference}</Link>
      if (key === 'status') return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{v}</span>
      if (key === 'totalForeign') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{Number(v).toFixed(2)}</span>
      if (key === 'totalBase') return <span className="tabular-nums text-xs font-mono">{fmtBase(v)}</span>
      if (key === 'invoiceDate') return <span className="text-xs text-muted-foreground">{fmtDate(v)}</span>
      if (key === 'qtyBilled') return <span className="tabular-nums text-xs">{v}</span>
      if (key === 'supplierInvoiceUrl') return v ? <a href={`/api${v}`} target="_blank" rel="noopener" className="text-blue-600 hover:underline text-xs flex items-center gap-0.5"><FileText className="h-3 w-3" />View</a> : null
    }
    if (tabKey === 'aging') {
      if (key === 'grossAmount' || key === 'totalAmount') return <span className="tabular-nums text-xs font-mono font-medium" title="VAT-inclusive committed spend (goods + VAT + direct freight)">{fmtBase(v)}</span>
      // o3d-iigc round 2: WHICH total this is, on the figure itself — 'net' beside a Gross column
      // and a Tax column otherwise reads as either net-of-VAT or net-of-returns, and it is both.
      if (key === 'netAmount') return <span className="tabular-nums text-xs font-mono font-medium" title="Ex-VAT: the gross total less its own VAT, less returns valued at the ex-VAT line cost AFTER the order's header discount">{fmtBase(v)}</span>
      // o3d-8u4h: WITHHELD, AND THE CELL SAYS SO WHEN YOU ASK IT. `v > 0 ? … : '—'` used to render a
      // hardcoded 0 as a dash, which looked identical to this and meant the opposite: it claimed the
      // supplier gave no discount. A withheld figure is `null` now, and the tooltip carries the
      // reason rather than leaving the reader to guess which of the two dashes they are looking at.
      if (key === 'discounts') return v == null ? <WithheldCell reason={SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED} /> : <span className="tabular-nums text-xs font-mono text-muted-foreground">{fmtBase(v)}</span>
      // o3d-iigc round 4: this is the credit AS THE NET AMOUNT SUBTRACTS IT — scaled onto the order's
      // post-header-discount goods value — so the three columns a reader can see (Gross, Tax,
      // Refunds) still subtract to the Net Amount printed beside them.
      if (key === 'refunds') return <span className="tabular-nums text-xs font-mono text-orange-600" title="Return credit at the ex-VAT line cost, reduced by the order's header discount so it is on the same basis as the Net Amount it is subtracted from">{v > 0 ? fmtBase(v) : '—'}</span>
      if (key === 'landedCosts' || key === 'tax') return <span className="tabular-nums text-xs font-mono text-muted-foreground">{v > 0 ? fmtBase(v) : '—'}</span>
      if (key === 'billedAmount') return <span className="tabular-nums text-xs font-mono" title="VAT-inclusive value of every supplier bill on this supplier's committed POs, marked or not">{fmtBase(v)}</span>
      if (key === 'billedWithPaymentMarker') return <span className="tabular-nums text-xs font-mono text-muted-foreground" title={SUPPLIER_BILLED_WITH_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      if (key === 'billedWithoutPaymentMarker') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-destructive font-medium' : ''}`} title={SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      // o3d-8u4h: WITHHELD. This cell used to print the whole billed ledger in red, forever, under
      // the word "Due" — the report had no payment offset of any kind, so it was asserting that
      // every bill ever raised was still owed. Due is billed less paid; paid is not a quantity this
      // system holds. Unsettled (billed) beside it is what IS known, and is named for what it is.
      if (key === 'dueAmount') return v == null ? <WithheldCell reason={SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED} /> : <span className="tabular-nums text-xs font-mono text-muted-foreground">{fmtBase(v)}</span>
      if (key === 'billedWithoutPaymentMarker0_30') return <span className="tabular-nums text-xs font-mono" title={SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      if (key === 'billedWithoutPaymentMarker31_60') return <span className="tabular-nums text-xs font-mono" title={SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      if (key === 'billedWithoutPaymentMarker61_90') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-orange-600' : ''}`} title={SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      if (key === 'billedWithoutPaymentMarker91plus') return <span className={`tabular-nums text-xs font-mono ${v > 0 ? 'text-destructive font-medium' : ''}`} title={SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS}>{v > 0 ? fmtBase(v) : MEASURED_ZERO_CELL_TEXT}</span>
      if (key === 'supplierName') return <span className="font-medium whitespace-nowrap text-xs">{v}</span>
    }
    if (tabKey === 'details') {
      if (key === 'productName') return <ProductLink productId={row.lineProductId} sku={row.sku} name={row.productName} />
      if (key === 'reference') return <Link href={`/purchase-orders/${row.poId}`} className="hover:underline font-mono text-xs">{row.reference}</Link>
      if (key === 'status') return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted">{v}</span>
      if (key === 'totalBase') return <span className="tabular-nums text-xs font-mono">{fmtBase(v)}</span>
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
  function renderGenericTable(data: any[], tabKey: Tab, emptyMsg: string, notices?: { heading: string; body: string }[]) {
    // o3d-8u4h: ONLY THE COLUMNS THIS TAB STILL HAS. A saved view stores column keys verbatim, so a
    // view saved before the supplier-aging renames still asks for `overdue0_30`. The header skipped
    // the unknown key and the BODY still emitted a cell for it, so every column after it in that row
    // shifted one place left and its figures were read under the wrong heading.
    const cols = presentColumns(visibleColsMap[tabKey], TAB_FIELDS[tabKey])
    return (
      <div className="rounded-md border">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs text-muted-foreground">{data.length} rows</span>
        </div>
        {/* o3d-8u4h round 2: the reasons live HERE, on the page, not in a hover. */}
        {notices && notices.length > 0 && (
          <dl data-column-notices="true" className="px-3 py-2 border-b bg-muted/10 space-y-1 text-[11px] leading-snug text-muted-foreground">
            {notices.map((n) => (
              <div key={n.heading} className="sm:flex sm:gap-2">
                <dt className="font-medium text-foreground shrink-0">{n.heading}</dt>
                <dd>{n.body}</dd>
              </div>
            ))}
          </dl>
        )}
        <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-20rem)]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {cols.map((key) => {
                // `cols` was filtered against this same field list, so the lookup cannot miss; the
                // guard is the type narrowing, not a second, divergent skip rule.
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Spend</p><p className="text-xl font-bold">{fmtBase(totalSpend)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Landed Cost</p><p className="text-xl font-bold">{fmtBase(totalLanded)}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Ordered</p><p className="text-xl font-bold">{totalOrdered}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Qty Received</p><p className="text-xl font-bold">{totalReceived}</p></div>
      </div>

      <div className="border-b">
        <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden">
          {TABS.map((t) => (<button key={t.key} type="button" className={`shrink-0 px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => handleTabChange(t.key)}>{t.label}</button>))}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pb-1 pl-2">
            {/* The `find` searches the FULL list on purpose: an id this page does not own must
                reach loadView and be refused there with a sentence, not silently ignored. */}
            {ownViews.length > 0 && (<select onChange={(e) => { const v = savedViews.find((sv) => sv.id === e.target.value); if (v) loadView(v); e.target.value = '' }} className="h-7 rounded-md border border-input bg-background px-2 text-xs" defaultValue=""><option value="" disabled>Saved Views…</option>{ownViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>)}
            <Button variant={filterRules.length > 0 ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setShowFilter(true)}><Filter className="h-3 w-3 mr-0.5" />Filter{filterRules.length > 0 ? ` (${filterRules.length})` : ''}</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowColPicker(true)}><Settings2 className="h-3 w-3 mr-0.5" />Columns</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowSaveView(true)}><Save className="h-3 w-3 mr-0.5" />Save View</Button>
            <a href={`/api/export/analytics?type=po_${tab}`} className="inline-flex items-center gap-0.5 rounded-md border border-input bg-background px-2 h-7 text-xs font-medium hover:bg-muted"><Download className="h-3 w-3" />CSV</a>
          </div>
        </div>
      </div>

      {viewNotice && <SavedViewNotice notice={viewNotice} onDismiss={() => setViewNotice(null)} />}

      {/* Products. o3d-8u4h round 2: the same one-filter-then-loop shape as the generic tables. The
          header and body already skipped a key `colR` has no entry for — but the FOOTER emitted a
          <td> for it unconditionally, so a stale saved key gave the totals row one cell more than
          the table above it and shifted every total right of the gap. Filtered once, here. */}
      {tab === 'products' && (() => {
        const cols = presentColumnKeys(visibleCols, Object.keys(colR))
        return (<div className="rounded-md border">
        <div className="px-3 py-1.5 bg-muted/30 border-b text-xs text-muted-foreground">{fp.length} of {products.length} products</div>
        <Table className="min-w-[700px]" containerClassName="max-h-[calc(100vh-22rem)]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {cols.map((k) => { const c = colR[k]; return <ColHeader key={k} colKey={k} label={c.label} align={c.align === 'right' ? 'right' : 'left'} /> })}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {fp.map((r) => (
              <TableRow key={r.productId}>
                {cols.map((k) => { const c = colR[k]; return <TableCell key={k} className={c.align === 'right' ? 'text-right' : ''}>{c.render(r)}</TableCell> })}
              </TableRow>
            ))}
          </TableBody>
          <tfoot className="border-t bg-muted/30 font-medium text-sm">
            <tr>
              {cols.map((k) => { const c = colR[k]; return <td key={k} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''}`}>{c.footer?.() ?? ''}</td> })}
            </tr>
          </tfoot>
        </Table>
      </div>)
      })()}

      {/* Other tabs — generic filterable/sortable tables */}
      {tab === 'received' && renderGenericTable(filteredReceived, 'received', 'No receipts.')}
      {tab === 'bills' && renderGenericTable(filteredBills, 'bills', 'No bills.')}
      {tab === 'aging' && renderGenericTable(filteredAging, 'aging', 'No data.', AGING_NOTICES)}
      {tab === 'details' && renderGenericTable(filteredDetails, 'details', 'No POs.')}

      {showFilter && <FilterDialog fields={fields} rules={filterRules} onApply={setFilterRules} onClose={() => setShowFilter(false)} />}
      {showColPicker && <ColumnPickerDialog fields={fields} visible={visibleCols} onApply={setVisibleCols} onClose={() => setShowColPicker(false)} />}
      {/* o3d-8u4h round 2: validated on SAVE as well as on load — a view is only worth as much as
          the keys in it, and a key that was already dead should not be written back to the row. */}
      {showSaveView && <SaveViewDialog tab={tab} columns={presentColumns(visibleCols, fields)} filters={filterRules.filter((r) => fields.some((f) => f.key === r.field))} onClose={() => setShowSaveView(false)} />}
    </div>
  )
}
