'use client'

import { useState, useEffect, useTransition, useMemo, useRef } from 'react'
import Link from 'next/link'
import { ArrowRightLeft, ChevronDown, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { getProductStockFlow } from '@/app/actions/stock'
import type { StockFlowRow } from '@/app/actions/stock'
import { useFormatDateTime } from '@/components/providers/timezone-provider'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_TYPES = [
  'PURCHASE_RECEIPT',
  'SALE_DISPATCH',
  'RETURN_INBOUND',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'PRODUCTION_IN',
  'PRODUCTION_OUT',
  'KIT_ASSEMBLY_IN',
  'KIT_ASSEMBLY_OUT',
  'OPENING_STOCK',
] as const

const TYPE_LABELS: Record<string, string> = {
  PURCHASE_RECEIPT: 'Purchase Receipt',
  SALE_DISPATCH: 'Sale Dispatch',
  RETURN_INBOUND: 'Return Inbound',
  TRANSFER_OUT: 'Transfer Out',
  TRANSFER_IN: 'Transfer In',
  ADJUSTMENT: 'Adjustment',
  PRODUCTION_IN: 'Production In',
  PRODUCTION_OUT: 'Production Out',
  KIT_ASSEMBLY_IN: 'Kit Assembly In',
  KIT_ASSEMBLY_OUT: 'Kit Assembly Out',
  OPENING_STOCK: 'Opening Stock',
}

const REFERENCE_URLS: Record<string, string> = {
  PurchaseOrder: '/purchase-orders/',
  SalesOrder: '/sales/',
  StockTransfer: '/stock-control/transfers',
  ProductionOrder: '/manufacturing/',
}

// ---------------------------------------------------------------------------
// StockFlowButton (exported)
// ---------------------------------------------------------------------------

export function StockFlowButton({ productId, iconOnly }: { productId: string; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {iconOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="Stock Flow"
          onClick={() => setOpen(true)}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
          Stock Flow
        </Button>
      )}
      {open && <StockFlowDialog productId={productId} onClose={() => setOpen(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// StockFlowDialog (internal)
// ---------------------------------------------------------------------------

function StockFlowDialog({ productId, onClose }: { productId: string; onClose: () => void }) {
  const formatDateTime = useFormatDateTime()
  const [rows, setRows] = useState<StockFlowRow[]>([])
  const [loading, startTransition] = useTransition()
  const [loaded, setLoaded] = useState(false)

  // Filters (client-side)
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(ALL_TYPES))
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  useEffect(() => {
    startTransition(async () => {
      const data = await getProductStockFlow(productId)
      setRows(data)
      setLoaded(true)
    })
  }, [productId])

  // Pagination
  const PAGE_SIZE = 50
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!activeTypes.has(r.type)) return false
      if (dateFrom && r.createdAt < dateFrom) return false
      if (dateTo && r.createdAt > dateTo + 'T23:59:59.999Z') return false
      return true
    })
  }, [rows, activeTypes, dateFrom, dateTo])

  // (page is reset in filter change handlers below)

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function toggleType(type: string) {
    setActiveTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
    setPage(0)
  }

  function clearFilters() {
    setActiveTypes(new Set(ALL_TYPES))
    setDateFrom('')
    setDateTo('')
    setPage(0)
  }

  const hasFilters = activeTypes.size < ALL_TYPES.length || dateFrom || dateTo

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[95vw] sm:max-w-5xl lg:max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Stock Flow</DialogTitle>
          <DialogDescription>Chronological history of all stock movements for this product.</DialogDescription>
        </DialogHeader>

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <TypeMultiSelect activeTypes={activeTypes} onToggle={toggleType} />
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(0) }}
            className="w-36 h-7 text-xs"
            aria-label="Date from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(0) }}
            className="w-36 h-7 text-xs"
            aria-label="Date to"
          />
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="text-xs text-primary hover:underline">
              Clear
            </button>
          )}
        </div>

        {/* Table */}
        {loading && !loaded ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading movements…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {rows.length === 0 ? 'No stock movements recorded.' : 'No movements match the current filters.'}
          </p>
        ) : (
          <Table containerClassName="max-h-[55vh]">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDateTime(r.createdAt, { day: 'numeric', month: 'short', year: '2-digit' })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs font-normal whitespace-nowrap">
                      {TYPE_LABELS[r.type] ?? r.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    <WarehouseDisplay from={r.fromWarehouse} to={r.toWarehouse} type={r.type} />
                  </TableCell>
                  <TableCell className={`text-right font-mono text-sm font-medium ${r.signedQty >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {r.signedQty >= 0 ? '+' : ''}{r.signedQty.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    <ReferenceLink referenceType={r.referenceType} referenceId={r.referenceId} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate" title={r.note ?? undefined}>
                    {r.note ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pagination */}
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{filtered.length} movements — page {page + 1} of {totalPages}</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// TypeMultiSelect
// ---------------------------------------------------------------------------

function TypeMultiSelect({ activeTypes, onToggle }: { activeTypes: Set<string>; onToggle: (type: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const allSelected = activeTypes.size === ALL_TYPES.length
  const noneSelected = activeTypes.size === 0
  const label = allSelected ? 'All types' : noneSelected ? 'No types' : `${activeTypes.size} type${activeTypes.size !== 1 ? 's' : ''}`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 h-7 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        {label}
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-52 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          <button
            type="button"
            onClick={() => {
              if (allSelected) {
                ALL_TYPES.forEach((t) => { if (activeTypes.has(t)) onToggle(t) })
              } else {
                ALL_TYPES.forEach((t) => { if (!activeTypes.has(t)) onToggle(t) })
              }
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors"
          >
            <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${allSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-input'}`}>
              {allSelected && <Check className="h-2.5 w-2.5" />}
            </span>
            Select all
          </button>
          <div className="my-1 h-px bg-border" />
          {ALL_TYPES.map((t) => {
            const checked = activeTypes.has(t)
            return (
              <button
                key={t}
                type="button"
                onClick={() => onToggle(t)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input'}`}>
                  {checked && <Check className="h-2.5 w-2.5" />}
                </span>
                {TYPE_LABELS[t]}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function WarehouseDisplay({ from, to, type }: { from: string | null; to: string | null; type: string }) {
  const isTransfer = type === 'TRANSFER_IN' || type === 'TRANSFER_OUT'
  if (isTransfer && from && to) return <>{from} → {to}</>
  return <>{to ?? from ?? '—'}</>
}

function ReferenceLink({ referenceType, referenceId }: { referenceType: string | null; referenceId: string | null }) {
  if (!referenceType || !referenceId) return <span className="text-muted-foreground">—</span>

  const basePath = REFERENCE_URLS[referenceType]
  if (!basePath) return <span>{referenceType}</span>

  // StockTransfer links to the list page (no individual detail page)
  const href = referenceType === 'StockTransfer' ? basePath : `${basePath}${referenceId}`

  return (
    <Link href={href} target="_blank" className="text-primary hover:underline whitespace-nowrap">
      {referenceType.replace(/([A-Z])/g, ' $1').trim()}
    </Link>
  )
}
