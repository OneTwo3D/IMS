'use client'

import { useState, useTransition, useEffect } from 'react'
import Link from 'next/link'
import type { SoRow, SoStatus } from '@/app/actions/sales'
import { getSalesOrders } from '@/app/actions/sales'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import { ChevronRight, Search, Settings2, Filter } from 'lucide-react'
import { countryName } from '@/lib/countries'

const STATUS_LABELS: Record<SoStatus, string> = {
  DRAFT: 'Draft',
  PENDING_PAYMENT: 'Pending Payment',
  ON_HOLD: 'On Hold',
  PROCESSING: 'Processing',
  ALLOCATED: 'Allocated',
  PICKING: 'Picking',
  PACKING: 'Packing',
  SHIPPED: 'Shipped',
  COMPLETED: 'Completed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Part. Refunded',
}

const STATUS_CLASS: Record<SoStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200',
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  ON_HOLD: 'bg-muted text-muted-foreground border-muted',
  PROCESSING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  ALLOCATED: 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900 dark:text-cyan-200',
  PICKING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PACKING: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200',
  COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  DELIVERED: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-200',
  CANCELLED: 'text-destructive border-destructive/30',
  REFUNDED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
}

const FILTER_STATUSES: SoStatus[] = ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED']

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

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColKey = 'order' | 'customer' | 'status' | 'total' | 'warehouse' | 'created' | 'items'
  | 'source' | 'country' | 'payment' | 'shipping' | 'orderDate' | 'shippedDate'
  | 'deliveredDate' | 'invoiceStatus' | 'stockStatus' | 'cogs' | 'profit'

type ColDef = { key: ColKey; label: string; align?: 'right' }

const ALL_COLUMNS: ColDef[] = [
  { key: 'order', label: 'Order' },
  { key: 'customer', label: 'Customer' },
  { key: 'status', label: 'Status' },
  { key: 'total', label: 'Total', align: 'right' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'created', label: 'Created' },
  { key: 'items', label: 'Items' },
  { key: 'source', label: 'Source' },
  { key: 'country', label: 'Country' },
  { key: 'payment', label: 'Payment' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'orderDate', label: 'Order Date' },
  { key: 'shippedDate', label: 'Shipped' },
  { key: 'deliveredDate', label: 'Delivered' },
  { key: 'invoiceStatus', label: 'Invoice' },
  { key: 'stockStatus', label: 'Stock Status' },
  { key: 'cogs', label: 'COGS', align: 'right' },
  { key: 'profit', label: 'Profit %', align: 'right' },
]

const DEFAULT_VISIBLE: ColKey[] = ['order', 'customer', 'status', 'total', 'warehouse', 'created', 'items']
const FIXED_COLS: ColKey[] = ['order']
const LS_KEY = 'so-list-cols'

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

function invoiceStatus(so: SoRow): { label: string; cls: string } {
  if (so.status === 'REFUNDED') return { label: 'Refunded', cls: 'bg-red-100 text-red-800' }
  if (so.status === 'PARTIALLY_REFUNDED') return { label: 'Part. Refunded', cls: 'bg-orange-100 text-orange-800' }
  if (so.paidAt) return { label: 'Paid', cls: 'bg-green-100 text-green-800' }
  if (so.invoiceNumber) return { label: 'Invoiced', cls: 'bg-purple-100 text-purple-800' }
  return { label: 'Pending', cls: 'bg-gray-100 text-gray-800' }
}

function stockStatus(status: SoStatus): string {
  switch (status) {
    case 'DRAFT': case 'ON_HOLD': return '—'
    case 'PENDING_PAYMENT': return 'Awaiting Payment'
    case 'PROCESSING': return 'Unallocated'
    case 'ALLOCATED': case 'PICKING': case 'PACKING': return 'Allocated'
    case 'SHIPPED': return 'Shipped'
    case 'COMPLETED': case 'DELIVERED': return 'Fulfilled'
    default: return '—'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = { initialOrders: SoRow[]; currencySymbols?: Record<string, string> }

const COMPLETED_STATUSES: SoStatus[] = ['COMPLETED', 'DELIVERED']

export function SoListClient({ initialOrders, currencySymbols = {} }: Props) {
  const sym = (code: string) => currencySymbols[code] ?? (code === 'GBP' ? '£' : code)
  const [search, setSearch] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<SoStatus>>(new Set())
  const [completedOrders, setCompletedOrders] = useState<SoRow[] | null>(null)
  const [fetching, startFetch] = useTransition()

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<ColKey[]>(loadCols)
  const [showColPicker, setShowColPicker] = useState(false)
  const [pickerDraft, setPickerDraft] = useState<Set<ColKey>>(new Set(visibleCols))
  const colSet = new Set(visibleCols)

  // Persist to localStorage on change
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

  function toggleStatus(s: SoStatus) {
    setStatusFilters((prev) => {
      const n = new Set(prev)
      if (n.has(s)) n.delete(s); else n.add(s)
      return n
    })
    // Lazy-fetch completed/delivered on first request
    if (COMPLETED_STATUSES.includes(s) && completedOrders === null) {
      startFetch(async () => {
        const all = await getSalesOrders(200, { includeCompleted: true })
        setCompletedOrders(all.filter((o) => COMPLETED_STATUSES.includes(o.status as SoStatus)))
      })
    }
  }

  const needsCompleted = COMPLETED_STATUSES.some((s) => statusFilters.has(s))
  const orders = needsCompleted && statusFilters.size > 0
    ? [...initialOrders, ...(completedOrders ?? [])].filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i)
    : initialOrders

  const filtered = orders.filter((so) => {
    if (statusFilters.size > 0 && !statusFilters.has(so.status)) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (so.wcOrderNumber ?? '').toLowerCase().includes(q) ||
        (so.customerName ?? '').toLowerCase().includes(q) ||
        (so.customerEmail ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  // ---------------------------------------------------------------------------
  // Cell renderers
  // ---------------------------------------------------------------------------

  function renderCell(key: ColKey, so: SoRow) {
    switch (key) {
      case 'order':
        return (
          <TableCell key={key} className="font-mono text-xs font-medium">
            <Link href={`/sales/${so.id}`} className="hover:underline">
              {so.wcOrderNumber ?? so.id.slice(0, 8)}
            </Link>
          </TableCell>
        )
      case 'customer':
        return (
          <TableCell key={key}>
            <div>{so.customerName ?? '—'}</div>
            {so.customerEmail && <div className="text-xs text-muted-foreground">{so.customerEmail}</div>}
          </TableCell>
        )
      case 'status':
        return (
          <TableCell key={key}>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[so.status]}`}>
              {STATUS_LABELS[so.status]}
            </span>
          </TableCell>
        )
      case 'total':
        return (
          <TableCell key={key} className="text-right tabular-nums">
            <span className="font-semibold">{so.totalForeign.toFixed(2)}{sym(so.currency)}</span>
            {so.currency !== 'GBP' && (
              <span className="text-muted-foreground text-xs font-normal ml-1">(£{so.totalGbp.toFixed(2)})</span>
            )}
          </TableCell>
        )
      case 'warehouse':
        return <TableCell key={key} className="text-muted-foreground text-xs">{so.shipFromWarehouseName ?? '—'}</TableCell>
      case 'created':
        return <TableCell key={key} className="text-muted-foreground text-xs">{timeAgo(so.createdAt)}</TableCell>
      case 'items':
        return <TableCell key={key} className="text-muted-foreground text-xs">{so.lineCount}</TableCell>
      case 'source':
        return (
          <TableCell key={key} className="text-xs">
            {so.wcOrderId
              ? /* eslint-disable-next-line @next/next/no-img-element */
              <img src="/images/woocommerce.svg" alt="WC" className="h-3.5 w-auto" title="WooCommerce" />
              : <span className="text-muted-foreground">Manual</span>}
          </TableCell>
        )
      case 'country':
        return (
          <TableCell key={key} className="text-xs">
            {so.shippingCountryCode ? (
              <span className="inline-flex items-center gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://flagcdn.com/16x12/${so.shippingCountryCode.toLowerCase()}.png`}
                  alt={so.shippingCountryCode}
                  className="h-3 w-4 object-cover"
                />
                <span className="text-muted-foreground">{countryName(so.shippingCountryCode)}</span>
              </span>
            ) : '—'}
          </TableCell>
        )
      case 'payment':
        return <TableCell key={key} className="text-muted-foreground text-xs">{so.paymentMethodTitle ?? '—'}</TableCell>
      case 'shipping':
        return <TableCell key={key} className="text-muted-foreground text-xs">{so.shippingService ?? '—'}</TableCell>
      case 'orderDate':
        return <TableCell key={key} className="text-muted-foreground text-xs">{fmtDate(so.wcCreatedAt ?? so.createdAt)}</TableCell>
      case 'shippedDate':
        return <TableCell key={key} className="text-muted-foreground text-xs">{fmtDate(so.shippedAt)}</TableCell>
      case 'deliveredDate':
        return (
          <TableCell key={key} className="text-muted-foreground text-xs">
            {so.status === 'DELIVERED' || so.status === 'COMPLETED' ? 'Yes' : '—'}
          </TableCell>
        )
      case 'invoiceStatus': {
        const inv = invoiceStatus(so)
        return (
          <TableCell key={key}>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${inv.cls}`}>
              {inv.label}
            </span>
          </TableCell>
        )
      }
      case 'stockStatus':
        return <TableCell key={key} className="text-muted-foreground text-xs">{stockStatus(so.status)}</TableCell>
      case 'cogs':
        return (
          <TableCell key={key} className="text-right tabular-nums text-xs">
            {so.cogsGbp != null ? `£${so.cogsGbp.toFixed(2)}` : '—'}
          </TableCell>
        )
      case 'profit': {
        const pct = so.profitMarginPercent
        return (
          <TableCell key={key} className={`text-right tabular-nums text-xs ${pct != null ? (pct >= 0 ? 'text-green-600' : 'text-red-600') : 'text-muted-foreground'}`}>
            {pct != null ? `${pct.toFixed(1)}%` : '—'}
          </TableCell>
        )
      }
    }
  }

  // Visible column defs (preserving order)
  const visCols = ALL_COLUMNS.filter((c) => colSet.has(c.key))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 text-xs" />}>
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            {statusFilters.size === 0 ? 'All Statuses' : statusFilters.size === 1 ? STATUS_LABELS[[...statusFilters][0]] : `${statusFilters.size} statuses`}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FILTER_STATUSES.map((s) => (
              <DropdownMenuCheckboxItem key={s} checked={statusFilters.has(s)} onCheckedChange={() => toggleStatus(s)}>
                {STATUS_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" className="h-8" onClick={openColPicker} title="Column settings">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>

      {fetching && completedOrders === null ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading orders…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No sales orders found.</p>
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
            {filtered.map((so) => (
              <TableRow key={so.id}>
                {visCols.map((c) => renderCell(c.key, so))}
                <TableCell>
                  <Link href={`/sales/${so.id}`}>
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
