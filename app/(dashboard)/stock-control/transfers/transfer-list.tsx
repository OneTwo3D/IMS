'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, X, Truck, PackageCheck, Ban } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { MobileRecordCard, MobileRecordField, MobileRecordList, ResponsiveTableLayout } from '@/components/ui/mobile-records'
import {
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  updateTransferDraft,
  type TransferRow,
  type TransferLine,
} from '@/app/actions/transfers'
import type { ProductRow } from '@/app/actions/products'
import type { StockLevelEntry } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'

const STATUS_LABEL: Record<TransferRow['status'], string> = {
  DRAFT: 'Draft',
  IN_TRANSIT: 'In Transit',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
}

const STATUS_CLASS: Record<TransferRow['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  IN_TRANSIT: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  RECEIVED: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

type Warehouse = { id: string; code: string; name: string }
type StockLevels = Record<string, Record<string, StockLevelEntry>>

function stockAt(stockLevels: StockLevels, productId: string, warehouseId: string): StockLevelEntry {
  return stockLevels[productId]?.[warehouseId] ?? { total: 0, available: 0 }
}

function StockCell({ entry, dim }: { entry: StockLevelEntry; dim?: boolean }) {
  const { total, available } = entry
  return (
    <span className={`font-mono text-xs text-right ${dim ? 'text-muted-foreground' : available <= 0 ? 'text-destructive' : 'text-foreground'}`}>
      {total}{total !== available ? <span className="text-muted-foreground"> ({available})</span> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Edit draft inline
// ---------------------------------------------------------------------------

function EditDraftForm({
  transfer,
  warehouses,
  products,
  stockLevels,
  onSaved,
  onCancel,
}: {
  transfer: TransferRow
  warehouses: Warehouse[]
  products: ProductRow[]
  stockLevels: StockLevels
  onSaved: (t: TransferRow) => void
  onCancel: () => void
}) {
  const [fromId, setFromId] = useState(transfer.fromWarehouseId)
  const [toId, setToId] = useState(transfer.toWarehouseId)
  const [notes, setNotes] = useState(transfer.notes ?? '')
  const [lines, setLines] = useState<(TransferLine & { key: number })[]>(
    transfer.lines.map((l, i) => ({ key: i, ...l }))
  )
  const [nextKey, setNextKey] = useState(transfer.lines.length)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const searchResults = search.trim().length >= 1
    ? products
        .filter((p) =>
          p.sku.toLowerCase().includes(search.toLowerCase()) ||
          p.name.toLowerCase().includes(search.toLowerCase())
        )
        .filter((p) => !lines.some((l) => l.productId === p.id))
        .slice(0, 8)
    : []

  function addProduct(p: ProductRow) {
    setLines((prev) => [...prev, { key: nextKey, productId: p.id, sku: p.sku, productName: p.name, qty: 0 }])
    setNextKey((k) => k + 1)
    setSearch('')
  }

  async function handleSave() {
    setError(null)
    const valid = lines.filter((l) => l.qty > 0)
    if (valid.length === 0) { setError('Add at least one product with qty > 0.'); return }
    if (fromId === toId) { setError('Warehouses must be different.'); return }
    setSaving(true)
    const res = await updateTransferDraft(transfer.id, fromId, toId, valid, notes)
    setSaving(false)
    if (res.success && res.transfer) { onSaved(res.transfer) }
    else { setError(res.message ?? 'Failed to save.') }
  }

  return (
    <div className="p-4 space-y-4 border-t border-border bg-muted/10">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
        <div>
          <p className="text-xs text-muted-foreground mb-1">From</p>
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)} className="h-8 text-xs">
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </Select>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">To</p>
          <Select value={toId} onChange={(e) => setToId(e.target.value)} className="h-8 text-xs">
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </Select>
        </div>
      </div>

      <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="h-8 text-sm max-w-lg" />

      {/* Product search */}
      <div className="relative max-w-md">
        <Input
          placeholder="Add product…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
          autoComplete="off"
          className="h-8 text-sm"
        />
        {searchFocused && searchResults.length > 0 && (
          <div className="absolute z-20 top-full mt-1 w-full bg-background border border-border rounded-lg shadow-lg overflow-hidden">
            {searchResults.map((p) => (
              <button key={p.id} type="button"
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-3 border-b border-border/50 last:border-0"
                onMouseDown={() => addProduct(p)}>
                <span className="font-mono text-xs w-24 shrink-0 truncate">{p.sku}</span>
                <span className="text-muted-foreground truncate text-xs flex-1">{p.name}</span>
                {(() => { const s = stockAt(stockLevels, p.id, fromId); return <span className="text-xs font-mono text-muted-foreground shrink-0">{s.total === s.available ? s.total : `${s.total} (${s.available})`}</span> })()}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lines */}
      {lines.length > 0 && (
        <div className="border border-border rounded-md overflow-x-auto">
          <div className="min-w-[500px]">
          <div className="grid grid-cols-[2fr_auto_auto_auto_auto] gap-2 px-3 py-1.5 bg-muted/30 text-xs font-medium text-muted-foreground border-b border-border">
            <span>Product</span>
            <span className="w-24 text-right">From {warehouses.find((w) => w.id === fromId)?.code ?? ''}</span>
            <span className="w-24 text-right">To {warehouses.find((w) => w.id === toId)?.code ?? ''}</span>
            <span className="w-16 text-right">Qty</span>
            <span className="w-6" />
          </div>
          {lines.map((line) => {
            const from = stockAt(stockLevels, line.productId, fromId)
            const to = stockAt(stockLevels, line.productId, toId)
            return (
              <div key={line.key} className="grid grid-cols-[2fr_auto_auto_auto_auto] gap-2 px-3 py-1.5 items-center border-b border-border/40 last:border-0">
                <div className="min-w-0">
                  <ProductLink productId={line.productId} sku={line.sku} name={line.productName} skuClassName="font-mono text-xs font-medium" />
                </div>
                <div className="w-24 text-right"><StockCell entry={from} /></div>
                <div className="w-24 text-right"><StockCell entry={to} dim /></div>
                <Input
                  type="number" min="1" step="1"
                  value={line.qty === 0 ? '' : line.qty}
                  onChange={(e) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l))}
                  placeholder="0"
                  className={`h-7 w-16 text-right text-xs font-mono ${line.qty > from.available && from.available > 0 ? 'border-destructive' : ''}`}
                />
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )
          })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single transfer row
// ---------------------------------------------------------------------------

function TransferCard({
  transfer: initial,
  warehouses,
  products,
  stockLevels,
  onUpdated,
}: {
  transfer: TransferRow
  warehouses: Warehouse[]
  products: ProductRow[]
  stockLevels: StockLevels
  onUpdated: (t: TransferRow) => void
}) {
  const imageMap = new Map(products.map((p) => [p.id, p.imageUrl]))
  const [transfer, setTransfer] = useState(initial)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleDispatch() {
    setActioning(true); setActionError(null)
    const res = await dispatchTransfer(transfer.id)
    setActioning(false)
    if (res.success) { setTransfer((t) => ({ ...t, status: 'IN_TRANSIT' })); onUpdated({ ...transfer, status: 'IN_TRANSIT' }) }
    else setActionError(res.message ?? 'Failed.')
  }

  async function handleReceive() {
    setActioning(true); setActionError(null)
    const res = await receiveTransfer(transfer.id)
    setActioning(false)
    if (res.success) { setTransfer((t) => ({ ...t, status: 'RECEIVED' })); onUpdated({ ...transfer, status: 'RECEIVED' }) }
    else setActionError(res.message ?? 'Failed.')
  }

  async function handleCancel() {
    setActioning(true); setActionError(null)
    const res = await cancelTransfer(transfer.id)
    setActioning(false)
    if (res.success) { setTransfer((t) => ({ ...t, status: 'CANCELLED' })); onUpdated({ ...transfer, status: 'CANCELLED' }) }
    else setActionError(res.message ?? 'Failed.')
  }

  const COL_COUNT = 6

  return (
    <>
      {/* Summary row */}
      <TableRow className="group cursor-pointer" onClick={() => { setExpanded((v) => !v); setEditing(false) }}>
        <TableCell className="font-mono text-xs font-medium whitespace-nowrap">{transfer.reference}</TableCell>
        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
          {transfer.fromWarehouseCode} → {transfer.toWarehouseCode}
          <span className="ml-2 text-xs">({transfer.lines.length} line{transfer.lines.length !== 1 ? 's' : ''})</span>
        </TableCell>
        <TableCell>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_CLASS[transfer.status]}`}>
            {STATUS_LABEL[transfer.status]}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(transfer.createdAt)}</TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            {transfer.status === 'DRAFT' && (
              <>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleDispatch} disabled={actioning}>
                  <Truck className="h-3 w-3" /> Dispatch
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100"
                  title="Edit" onClick={() => { setEditing((v) => !v); setExpanded(true) }}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  title="Cancel transfer" onClick={handleCancel} disabled={actioning}>
                  <Ban className="h-3 w-3" />
                </Button>
              </>
            )}
            {transfer.status === 'IN_TRANSIT' && (
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-950"
                onClick={handleReceive} disabled={actioning}>
                <PackageCheck className="h-3 w-3" /> Mark Received
              </Button>
            )}
            {actionError && <p className="text-xs text-destructive whitespace-nowrap">{actionError}</p>}
          </div>
        </TableCell>
        <TableCell className="w-8">
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </TableCell>
      </TableRow>

      {/* Expanded detail */}
      {expanded && !editing && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COL_COUNT} className="bg-muted/5 p-4">
            <div className="space-y-2">
              {transfer.notes && (
                <p className="text-xs text-muted-foreground italic">{transfer.notes}</p>
              )}
              <Table className="rounded-md border min-w-[400px]">
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead className="w-9 text-xs" />
                    <TableHead className="text-xs">Product</TableHead>
                    <TableHead className="text-xs text-right w-16">Qty</TableHead>
                    <TableHead className="text-xs text-right w-16">Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfer.lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="w-9 p-1.5 pl-3"><ProductThumb productId={line.productId} imageUrl={imageMap.get(line.productId) ?? null} name={line.productName} /></TableCell>
                      <TableCell className="p-1.5">
                        <ProductLink productId={line.productId} sku={line.sku} name={line.productName} skuClassName="font-mono text-xs font-medium" />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right w-16 p-1.5">{line.qty}</TableCell>
                      <TableCell className={`font-mono text-xs text-right w-16 p-1.5 ${line.qtyReceived >= line.qty ? 'text-green-600' : 'text-muted-foreground'}`}>
                        {line.qtyReceived}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {transfer.status === 'IN_TRANSIT' && (
                <p className="text-xs text-blue-600 dark:text-blue-400">
                  Stock has been booked out of <strong>{transfer.fromWarehouseCode}</strong> and is in transit to <strong>{transfer.toWarehouseCode}</strong>. Not available for sale.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}

      {/* Edit form */}
      {editing && transfer.status === 'DRAFT' && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COL_COUNT} className="p-0">
            <EditDraftForm
              transfer={transfer}
              warehouses={warehouses}
              products={products}
              stockLevels={stockLevels}
              onSaved={(updated) => { setTransfer(updated); onUpdated(updated); setEditing(false) }}
              onCancel={() => setEditing(false)}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type ListProps = {
  transfers: TransferRow[]
  warehouses: Warehouse[]
  products: ProductRow[]
  stockLevels: StockLevels
  onTransferUpdated: (t: TransferRow) => void
}

export function TransferList({ transfers, warehouses, products, stockLevels, onTransferUpdated }: ListProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (transfers.length === 0) {
    return (
      <Card className="px-4 py-8 flex items-center justify-center text-sm text-muted-foreground">
        No transfers yet. Create one with the button above.
      </Card>
    )
  }

  const visible = collapsed ? transfers.slice(0, 10) : transfers

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <h2 className="text-sm font-semibold">Transfer History</h2>
        {transfers.length > 10 && (
          <button type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed((v) => !v)}>
            {collapsed
              ? <><ChevronDown className="h-3.5 w-3.5" />Show all {transfers.length}</>
              : <><ChevronUp className="h-3.5 w-3.5" />Collapse</>}
          </button>
        )}
      </div>

      <ResponsiveTableLayout
        mobile={(
          <MobileRecordList className="p-3">
            {visible.map((transfer) => (
              <MobileTransferCard
                key={transfer.id}
                transfer={transfer}
                warehouses={warehouses}
                products={products}
                stockLevels={stockLevels}
                onUpdated={onTransferUpdated}
              />
            ))}
          </MobileRecordList>
        )}
        desktop={(
          <Table className="min-w-[700px]">
            <TableHeader className="bg-muted/20">
              <TableRow>
                <TableHead className="text-xs">Reference</TableHead>
                <TableHead className="text-xs">Route</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Actions</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((t) => (
                <TransferCard
                  key={t.id}
                  transfer={t}
                  warehouses={warehouses}
                  products={products}
                  stockLevels={stockLevels}
                  onUpdated={onTransferUpdated}
                />
              ))}
            </TableBody>
          </Table>
        )}
      />

      {collapsed && transfers.length > 10 && (
        <div className="px-4 py-2 text-center">
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground underline"
            onClick={() => setCollapsed(false)}>
            Show {transfers.length - 10} more…
          </button>
        </div>
      )}
    </Card>
  )
}

function MobileTransferCard({
  transfer: initial,
  warehouses,
  products,
  stockLevels,
  onUpdated,
}: {
  transfer: TransferRow
  warehouses: Warehouse[]
  products: ProductRow[]
  stockLevels: StockLevels
  onUpdated: (t: TransferRow) => void
}) {
  const imageMap = new Map(products.map((p) => [p.id, p.imageUrl]))
  const [transfer, setTransfer] = useState(initial)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [actioning, setActioning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleDispatch() {
    setActioning(true); setActionError(null)
    const res = await dispatchTransfer(transfer.id)
    setActioning(false)
    if (res.success) {
      const next = { ...transfer, status: 'IN_TRANSIT' as const }
      setTransfer(next)
      onUpdated(next)
    } else setActionError(res.message ?? 'Failed.')
  }

  async function handleReceive() {
    setActioning(true); setActionError(null)
    const res = await receiveTransfer(transfer.id)
    setActioning(false)
    if (res.success) {
      const next = { ...transfer, status: 'RECEIVED' as const }
      setTransfer(next)
      onUpdated(next)
    } else setActionError(res.message ?? 'Failed.')
  }

  async function handleCancel() {
    setActioning(true); setActionError(null)
    const res = await cancelTransfer(transfer.id)
    setActioning(false)
    if (res.success) {
      const next = { ...transfer, status: 'CANCELLED' as const }
      setTransfer(next)
      onUpdated(next)
    } else setActionError(res.message ?? 'Failed.')
  }

  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-medium">{transfer.reference}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {transfer.fromWarehouseCode} → {transfer.toWarehouseCode}
          </p>
        </div>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[transfer.status]}`}>
          {STATUS_LABEL[transfer.status]}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobileRecordField label="Date" value={formatDate(transfer.createdAt)} />
        <MobileRecordField label="Lines" value={`${transfer.lines.length}`} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {transfer.status === 'DRAFT' && (
          <>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={handleDispatch} disabled={actioning}>
              <Truck className="h-3 w-3" /> Dispatch
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => { setEditing((v) => !v); setExpanded(true) }}>
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive" onClick={handleCancel} disabled={actioning}>
              <Ban className="h-3 w-3" /> Cancel
            </Button>
          </>
        )}
        {transfer.status === 'IN_TRANSIT' && (
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-950" onClick={handleReceive} disabled={actioning}>
            <PackageCheck className="h-3 w-3" /> Mark Received
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setExpanded((v) => !v); if (editing) setEditing(false) }}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5 mr-1" /> : <ChevronDown className="h-3.5 w-3.5 mr-1" />}
          {expanded ? 'Hide Lines' : 'Show Lines'}
        </Button>
      </div>

      {actionError && <p className="mt-2 text-xs text-destructive">{actionError}</p>}

      {expanded && !editing && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {transfer.notes && <p className="text-xs text-muted-foreground italic">{transfer.notes}</p>}
          {transfer.lines.map((line) => (
            <div key={line.id} className="flex items-center gap-3 rounded-md bg-muted/40 px-2.5 py-2">
              <ProductThumb productId={line.productId} imageUrl={imageMap.get(line.productId) ?? null} name={line.productName} />
              <div className="min-w-0 flex-1">
                <ProductLink productId={line.productId} sku={line.sku} name={line.productName} skuClassName="font-mono text-xs font-medium" />
              </div>
              <div className="text-right text-xs font-mono">
                <div>{line.qty}</div>
                <div className={line.qtyReceived >= line.qty ? 'text-green-600' : 'text-muted-foreground'}>{line.qtyReceived} rec</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && transfer.status === 'DRAFT' && (
        <div className="mt-3 border-t border-border pt-3">
          <EditDraftForm
            transfer={transfer}
            warehouses={warehouses}
            products={products}
            stockLevels={stockLevels}
            onSaved={(updated) => { setTransfer(updated); onUpdated(updated); setEditing(false) }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </MobileRecordCard>
  )
}
