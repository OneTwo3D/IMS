'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { PoRow, PoStatus } from '@/app/actions/purchase-orders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import { ChevronRight, Search, Settings2, Filter } from 'lucide-react'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  RFQ_SENT: 'RFQ Sent',
  QUOTE_RECEIVED: 'Quote Received',
  PO_SENT: 'Ordered',
  SHIPPED: 'Shipped',
  PARTIALLY_RECEIVED: 'Part. Received',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  INVOICED: 'Invoiced',
  PARTIALLY_RETURNED: 'Part. Returned',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}

const STATUS_CLASS: Record<PoStatus, string> = {
  DRAFT: 'text-muted-foreground',
  RFQ_SENT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-200',
  QUOTE_RECEIVED: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200 border-cyan-200',
  PO_SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-blue-200',
  SHIPPED: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 border-indigo-200',
  PARTIALLY_RECEIVED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RECEIVED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-200',
  CLOSED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 border-emerald-200',
  INVOICED: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200',
  PARTIALLY_RETURNED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RETURNED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200',
  CANCELLED: 'text-destructive',
}

const ALL_STATUSES: PoStatus[] = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColKey = 'reference' | 'supplier' | 'status' | 'total' | 'expected' | 'created' | 'lines'
  | 'type' | 'currency' | 'supplierRef' | 'warehouse' | 'subtotal' | 'tax' | 'freight'
  | 'discount' | 'landedCost' | 'invoiceStatus' | 'updated'

type ColDef = { key: ColKey; label: string; align?: 'right' }

const ALL_COLUMNS: ColDef[] = [
  { key: 'reference', label: 'Reference' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'status', label: 'Status' },
  { key: 'total', label: 'Total', align: 'right' },
  { key: 'expected', label: 'Expected' },
  { key: 'created', label: 'Created' },
  { key: 'lines', label: 'Lines' },
  { key: 'type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'supplierRef', label: 'Supplier Ref' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'subtotal', label: 'Subtotal', align: 'right' },
  { key: 'tax', label: 'Tax', align: 'right' },
  { key: 'freight', label: 'Freight', align: 'right' },
  { key: 'discount', label: 'Discount', align: 'right' },
  { key: 'landedCost', label: 'Landed Cost' },
  { key: 'invoiceStatus', label: 'Invoice' },
  { key: 'updated', label: 'Updated' },
]

const DEFAULT_VISIBLE: ColKey[] = ['reference', 'supplier', 'status', 'total', 'expected', 'created', 'lines']
const FIXED_COLS: ColKey[] = ['reference']
const LS_KEY = 'po-list-cols'

function loadCols(): ColKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as string[]
      const valid = ALL_COLUMNS.map((c) => c.key)
      const filtered = arr.filter((k) => valid.includes(k as ColKey)) as ColKey[]
      if (filtered.length > 0) return filtered
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

function invoiceStatusBadge(po: PoRow): { label: string; cls: string } | null {
  if (po.isInvoiced) return { label: `Invoiced (${po.invoiceCount})`, cls: 'bg-purple-100 text-purple-800' }
  if (po.status === 'RECEIVED') return { label: 'Awaiting Invoice', cls: 'bg-yellow-100 text-yellow-800' }
  if (po.status === 'PARTIALLY_RECEIVED') return { label: 'Partial', cls: 'bg-orange-100 text-orange-800' }
  return null
}

function landedCostLabel(method: string): string {
  switch (method) {
    case 'BY_VALUE': return 'By Value'
    case 'BY_WEIGHT': return 'By Weight'
    case 'BY_QTY': return 'By Qty'
    case 'EQUAL_SPLIT': return 'Equal'
    default: return method || '—'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = { initialPos: PoRow[]; currencySymbols?: Record<string, string> }

export function PoListClient({ initialPos, currencySymbols = {} }: Props) {
  const sym = (code: string) => currencySymbols[code] ?? (code === 'GBP' ? '£' : code)
  const [search, setSearch] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<PoStatus>>(new Set())
  const [invoicedFilter, setInvoicedFilter] = useState(false)
  const [returnedFilter, setReturnedFilter] = useState(false)

  function toggleStatus(s: PoStatus) {
    setStatusFilters((prev) => {
      const n = new Set(prev)
      if (n.has(s)) n.delete(s); else n.add(s)
      return n
    })
  }

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

  const filtered = initialPos.filter((po) => {
    if (statusFilters.size > 0 && !statusFilters.has(po.status)) return false
    if (invoicedFilter && !po.isInvoiced) return false
    if (returnedFilter && !(po.isPartiallyReturned || po.isFullyReturned)) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        po.reference.toLowerCase().includes(q) ||
        po.supplierName.toLowerCase().includes(q) ||
        (po.supplierRef ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  // ---------------------------------------------------------------------------
  // Cell renderers
  // ---------------------------------------------------------------------------

  function renderCell(key: ColKey, po: PoRow) {
    switch (key) {
      case 'reference':
        return (
          <TableCell key={key} className="font-mono text-xs font-medium">
            <Link href={`/purchase-orders/${po.id}`} className="hover:underline">
              {po.reference}
            </Link>
            {po.type === 'FREIGHT' && (
              <span className="ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                LC
              </span>
            )}
          </TableCell>
        )
      case 'supplier':
        return <TableCell key={key}>{po.supplierName}</TableCell>
      case 'status':
        return (
          <TableCell key={key}>
            <div className="flex flex-wrap gap-1">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[po.status]}`}>
                {STATUS_LABELS[po.status]}
              </span>
              {po.isInvoiced && po.status !== 'INVOICED' && (
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200">
                  Invoiced
                </span>
              )}
              {po.isPartiallyReturned && po.status !== 'PARTIALLY_RETURNED' && (
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200">
                  Part. Returned
                </span>
              )}
              {po.isFullyReturned && po.status !== 'RETURNED' && (
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200">
                  Returned
                </span>
              )}
            </div>
          </TableCell>
        )
      case 'total':
        return (
          <TableCell key={key} className="text-right tabular-nums">
            <span className="font-semibold">{po.totalForeign.toFixed(2)}{sym(po.currency)}</span>
            {po.currency !== 'GBP' && (
              <span className="text-muted-foreground text-xs font-normal ml-1">(£{po.totalGbp.toFixed(2)})</span>
            )}
          </TableCell>
        )
      case 'expected':
        return <TableCell key={key} className="text-muted-foreground text-xs">{fmtDate(po.expectedDelivery)}</TableCell>
      case 'created':
        return <TableCell key={key} className="text-muted-foreground text-xs">{timeAgo(po.createdAt)}</TableCell>
      case 'lines':
        return <TableCell key={key} className="text-muted-foreground text-xs">{po.lineCount}</TableCell>
      case 'type':
        return (
          <TableCell key={key} className="text-xs">
            {po.type === 'FREIGHT'
              ? <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Freight/LC</span>
              : <span className="text-muted-foreground">Goods</span>}
          </TableCell>
        )
      case 'currency':
        return <TableCell key={key} className="text-muted-foreground text-xs">{po.currency}</TableCell>
      case 'supplierRef':
        return <TableCell key={key} className="text-muted-foreground text-xs font-mono">{po.supplierRef ?? '—'}</TableCell>
      case 'warehouse':
        return <TableCell key={key} className="text-muted-foreground text-xs">{po.destinationWarehouseName ?? '—'}</TableCell>
      case 'subtotal':
        return <TableCell key={key} className="text-right tabular-nums text-xs">{po.subtotalForeign.toFixed(2)}{sym(po.currency)}</TableCell>
      case 'tax':
        return (
          <TableCell key={key} className="text-right tabular-nums text-xs">
            {po.taxForeign > 0 ? `${po.taxForeign.toFixed(2)}${sym(po.currency)}` : '—'}
          </TableCell>
        )
      case 'freight':
        return (
          <TableCell key={key} className="text-right tabular-nums text-xs">
            {po.directFreightForeign > 0 ? `${po.directFreightForeign.toFixed(2)}${sym(po.currency)}` : '—'}
          </TableCell>
        )
      case 'discount':
        return (
          <TableCell key={key} className="text-right tabular-nums text-xs text-destructive">
            {po.orderDiscountForeign > 0 ? `-${po.orderDiscountForeign.toFixed(2)}` : '—'}
          </TableCell>
        )
      case 'landedCost':
        return <TableCell key={key} className="text-muted-foreground text-xs">{landedCostLabel(po.landedCostMethod)}</TableCell>
      case 'invoiceStatus': {
        const inv = invoiceStatusBadge(po)
        return (
          <TableCell key={key}>
            {inv
              ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${inv.cls}`}>{inv.label}</span>
              : <span className="text-muted-foreground text-xs">—</span>}
          </TableCell>
        )
      }
      case 'updated':
        return <TableCell key={key} className="text-muted-foreground text-xs">{timeAgo(po.updatedAt)}</TableCell>
    }
  }

  const visCols = ALL_COLUMNS.filter((c) => colSet.has(c.key))

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search reference, supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 text-xs" />}>
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            {statusFilters.size === 0 && !invoicedFilter && !returnedFilter
              ? 'All Statuses'
              : [
                  statusFilters.size === 1 ? STATUS_LABELS[[...statusFilters][0]] : statusFilters.size > 1 ? `${statusFilters.size} statuses` : '',
                  invoicedFilter ? 'Invoiced' : '',
                  returnedFilter ? 'Returned' : '',
                ].filter(Boolean).join(' + ')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {ALL_STATUSES.map((s) => (
              <DropdownMenuCheckboxItem key={s} checked={statusFilters.has(s)} onCheckedChange={() => toggleStatus(s)}>
                {STATUS_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={invoicedFilter} onCheckedChange={(v) => setInvoicedFilter(!!v)}>
              Invoiced
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={returnedFilter} onCheckedChange={(v) => setReturnedFilter(!!v)}>
              Returned
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" className="h-8" onClick={openColPicker} title="Column settings">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No purchase orders found.</p>
      ) : (
        <Table containerClassName="max-h-[calc(100vh-16rem)] rounded-md border" className="min-w-[700px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {visCols.map((c) => (
                <TableHead key={c.key} className={c.align === 'right' ? 'text-right' : undefined}>
                  {c.label}
                </TableHead>
              ))}
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((po) => (
              <TableRow key={po.id}>
                {visCols.map((c) => renderCell(c.key, po))}
                <TableCell>
                  <Link href={`/purchase-orders/${po.id}`}>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

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
                  <span className={fixed ? 'text-muted-foreground' : ''}>{c.label}</span>
                </label>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowColPicker(false)}>Cancel</Button>
            <Button size="sm" onClick={applyColPicker}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
