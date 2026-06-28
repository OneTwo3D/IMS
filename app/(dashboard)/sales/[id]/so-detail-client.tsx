'use client'

import { useState, useTransition, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Package, Truck, PackageCheck, Ban, Undo2, ChevronDown, ChevronRight, Loader2, FileText, Mail, Copy, Trash2, ExternalLink, CreditCard, Pencil, Settings2, Warehouse, AlertTriangle, Clock, EllipsisVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WmsOrderStatusChip } from '@/components/sales/wms-order-status-chip'
import type { WmsOrderStatusView } from '@/app/actions/wms-order-status'
import { WmsOrderPushChip } from '@/components/sales/wms-order-push-chip'
import type { WmsOrderPushStateView } from '@/app/actions/wms-order-push'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import {
  updateSalesOrderStatus, createRefund, retryRefundAccounting, cloneSalesOrder, deleteSalesOrder,
  updateSalesOrderNotes, generateInvoiceNumber,
  addPayment, deletePayment,
  type SoDetail, type SoStatus,
} from '@/app/actions/sales'
import { sendSalesOrderEmail, sendInvoiceEmail } from '@/app/actions/email'
import {
  autoAllocateOrder, getOrderAllocations, getOrderShipments,
  deallocateOrder, confirmAllocations, updateAllocation, addAllocation,
  updateShipmentStatus, updateShipmentTracking,
  type AllocationRow, type FulfillmentRequirementRow, type ShipmentRow,
} from '@/app/actions/allocation'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { RejectedAccountingDocumentUpdateWarning } from '@/lib/domain/accounting/rejected-sync-warnings'
import type { ProductType } from '@/app/generated/prisma/client'
import type { StockLevelEntry } from '@/lib/domain/inventory/stock-level-map'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { hasPermission } from '@/lib/permissions'
import { formatMoney } from '@/lib/utils'
import { getTrackingUrl } from '@/lib/tracking'
import { countryName, formatCountryDisplay } from '@/lib/countries'

type WarehouseInfo = { id: string; code: string; name: string }

// Client-side display helper. Server allocation paths use Decimal coverage in
// lib/products/fulfillment-coverage.ts; this keeps Prisma Decimal out of the
// browser bundle for already-serialized UI quantities.
function calculateClientCoverageByLine(
  requirementsByLine: Map<string, FulfillmentRequirementRow['requirements']>,
  rows: Array<{ lineId: string; productId: string; qty: number }>,
): Map<string, number> {
  const quantitiesByLine = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const lineQuantities = quantitiesByLine.get(row.lineId) ?? new Map<string, number>()
    lineQuantities.set(row.productId, (lineQuantities.get(row.productId) ?? 0) + row.qty)
    quantitiesByLine.set(row.lineId, lineQuantities)
  }

  const coverageByLine = new Map<string, number>()
  for (const [lineId, requirements] of requirementsByLine) {
    let coverage = Number.POSITIVE_INFINITY
    let hasRequirement = false
    const quantities = quantitiesByLine.get(lineId) ?? new Map<string, number>()
    for (const requirement of requirements) {
      if (!Number.isFinite(requirement.factor) || requirement.factor <= 0) {
        coverage = 0
        hasRequirement = true
        break
      }
      hasRequirement = true
      coverage = Math.min(coverage, (quantities.get(requirement.productId) ?? 0) / requirement.factor)
    }
    coverageByLine.set(lineId, hasRequirement && Number.isFinite(coverage) ? Math.max(0, coverage) : 0)
  }

  return coverageByLine
}
type AllocationPanelLine = {
  id: string
  productId: string | null
  sku: string
  description: string
  imageUrl: string | null
  productType: ProductType | null
  oversellAllowed: boolean
  qty: number
}
type Props = {
  order: SoDetail
  warehouses: WarehouseInfo[]
  currencies: CurrencyRow[]
  externalOrderLinks?: Array<{ label: string; url: string }>
  wmsOrderStatus?: WmsOrderStatusView | null
  wmsPushState?: WmsOrderPushStateView | null
  stockLevels: Record<string, Record<string, StockLevelEntry>>
  initialAllocations: AllocationRow[]
  initialShipments: ShipmentRow[]
  fulfillmentRequirements: FulfillmentRequirementRow[]
  carriers: string[]
  deliveryTrackingEnabled: boolean
  accountingAvailable: boolean
  accountingInvoiceUrlTemplate: string
  accountingSyncEnabled: boolean
  currentUserRole: string
  rejectedAccountingSyncs: RejectedAccountingDocumentUpdateWarning[]
  /** audit-H2: order is fully paid but its trigger won't auto-generate an invoice. */
  paidWithoutInvoice: boolean
}

const STATUS_LABELS: Record<SoStatus, string> = {
  DRAFT: 'Draft', PENDING_PAYMENT: 'Pending Payment', ON_HOLD: 'On Hold',
  PROCESSING: 'Processing', ALLOCATED: 'Allocated', PICKING: 'Picking', PACKING: 'Packing',
  SHIPPED: 'Shipped', COMPLETED: 'Completed', DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Part. Refunded',
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
  CANCELLED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  REFUNDED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
}
// Status flow for orders WITH shipments (shipment-level picking/packing/shipping)
const STATUS_FLOW_SHIPMENTS: Record<string, { label: string; icon: typeof Truck; target: SoStatus }[]> = {
  DRAFT: [{ label: 'Process', icon: Package, target: 'PROCESSING' }],
  PENDING_PAYMENT: [{ label: 'Process', icon: Package, target: 'PROCESSING' }],
  PROCESSING: [{ label: 'Allocate', icon: Package, target: 'ALLOCATED' }],
  SHIPPED: [{ label: 'Complete', icon: PackageCheck, target: 'COMPLETED' }],
  COMPLETED: [{ label: 'Delivered', icon: PackageCheck, target: 'DELIVERED' }],
}

// Optional columns for the line items table
type OptCol = 'cogs' | 'margin' | 'marginPct' | 'qtyOnHand' | 'qtyReturned' | 'qtyCancelled' | 'qtyShipped'
const OPT_COLUMNS: { key: OptCol; label: string }[] = [
  { key: 'cogs', label: 'COGS' },
  { key: 'margin', label: 'Margin' },
  { key: 'marginPct', label: 'Margin %' },
  { key: 'qtyOnHand', label: 'Qty on Hand' },
  { key: 'qtyReturned', label: 'Qty Returned' },
  { key: 'qtyCancelled', label: 'Qty Cancelled' },
  { key: 'qtyShipped', label: 'Qty Shipped' },
]

const ACCOUNTING_SYNC_TYPE_LABEL: Record<RejectedAccountingDocumentUpdateWarning['type'], string> = {
  SALES_INVOICE_UPDATE: 'sales invoice update',
  PURCHASE_INVOICE_UPDATE: 'purchase invoice update',
}

// ---------------------------------------------------------------------------
// Refund dialog
// ---------------------------------------------------------------------------
function RefundDialog({ order, warehouses, sym, onClose }: { order: SoDetail; warehouses: WarehouseInfo[]; sym: string; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [returnWhId, setReturnWhId] = useState(warehouses[0]?.id ?? '')
  const [refundLines, setRefundLines] = useState(order.lines.map((l) => ({ ...l, qtyRefund: 0, refundAmount: 0 })))
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const totalRefund = refundLines.reduce((s, l) => s + l.refundAmount, 0)
  function handleConfirm() {
    setError('')
    setWarning('')
    const toRefund = refundLines.filter((l) => l.qtyRefund > 0)
    if (!toRefund.length) { setError('Select at least one line'); return }
    if (!reason.trim()) { setError('Reason is required'); return }
    startTransition(async () => {
      const result = await createRefund(order.id, toRefund.map((l) => ({
        lineId: l.id,
        productId: l.productId,
        description: l.description,
        qty: l.qtyRefund,
        totalForeign: l.refundAmount,
        totalBase: l.refundAmount / (order.fxRateToBase || 1),
      })), reason, returnWhId || undefined)
      if (result.success) {
        router.refresh()
        if (result.warning) {
          setWarning(result.warning)
        } else {
          onClose()
        }
      } else setError(result.error ?? 'Failed')
    })
  }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
      <DialogHeader><DialogTitle>Process Refund</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Reason *</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer request" className="h-9 text-sm" /></div>
          <div className="space-y-1.5"><Label>Return to Warehouse</Label>
            <select value={returnWhId} onChange={(e) => setReturnWhId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No stock return</option>
              {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
            </select></div>
        </div>
        <Table className="rounded-md border"><TableHeader className="bg-muted/50"><TableRow>
          <TableHead className="text-xs">Product</TableHead>
          <TableHead className="text-xs text-right w-16">Ordered</TableHead>
          <TableHead className="text-xs text-right w-24">Refund Qty</TableHead>
          <TableHead className="text-xs text-right w-28">Amount ({sym})</TableHead>
        </TableRow></TableHeader><TableBody>
          {refundLines.map((l) => (<TableRow key={l.id}>
            <TableCell>{l.productId ? <ProductLink productId={l.productId} sku={l.sku} name={l.description} /> : l.description}</TableCell>
            <TableCell className="text-right tabular-nums">{l.qty}</TableCell>
            <TableCell><Input type="number" min={0} max={l.qty} step={1} value={l.qtyRefund} onChange={(e) => { const q = Number(e.target.value) || 0; setRefundLines((p) => p.map((rl) => rl.id === l.id ? { ...rl, qtyRefund: q, refundAmount: q * l.unitPriceForeign } : rl)) }} className="h-7 text-sm text-right w-24 ml-auto font-mono" /></TableCell>
            <TableCell className="text-right font-mono text-xs">{formatMoney(l.refundAmount, sym)}</TableCell>
          </TableRow>))}
        </TableBody></Table>
        <div className="flex justify-end text-sm font-medium">Total: {formatMoney(totalRefund, sym)}</div>
        {warning && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>{warning ? 'Close' : 'Cancel'}</Button>
        {!warning && (
          <Button type="button" onClick={handleConfirm} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm Refund</Button>
        )}
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Notes edit dialog
// ---------------------------------------------------------------------------
function NotesDialog({ order, onClose }: { order: SoDetail; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [notes, setNotes] = useState(order.notes ?? '')
  const [internal, setInternal] = useState(order.internalNotes ?? '')
  const [error, setError] = useState('')
  function handleSave() {
    startTransition(async () => {
      const r = await updateSalesOrderNotes(order.id, notes, internal)
      if (r.success) { router.refresh(); onClose() } else setError(r.error ?? 'Failed')
    })
  }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-lg sm:max-w-lg">
      <DialogHeader><DialogTitle>Edit Notes</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5"><Label>Customer Notes (visible on order/invoice)</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="text-sm resize-none" /></div>
        <div className="space-y-1.5"><Label>Private Notes (internal only)</Label>
          <Textarea value={internal} onChange={(e) => setInternal(e.target.value)} rows={3} className="text-sm resize-none" /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleSave} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Notes</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Add Payment dialog
// ---------------------------------------------------------------------------
function PaymentDialog({ orderId, refundId, creditNoteNumber, currency, defaultAmount, onClose }: { orderId: string; refundId?: string; creditNoteNumber?: string; currency: string; defaultAmount?: number; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [amount, setAmount] = useState(defaultAmount != null && defaultAmount > 0 ? defaultAmount.toFixed(2) : '')
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState('')

  function handleSave() {
    setError('')
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid amount'); return }
    startTransition(async () => {
      const r = await addPayment({ orderId, refundId, amount: amt, currency, method: method || undefined, reference: reference || undefined, notes: notes || undefined, paidAt: paidAt || undefined })
      if (r.success) { router.refresh(); onClose() } else setError(r.error ?? 'Failed')
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
      <DialogHeader><DialogTitle>Add Payment{creditNoteNumber ? ` — ${creditNoteNumber}` : ''}</DialogTitle></DialogHeader>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Amount ({currency}) *</Label>
            <Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="h-9" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Method</Label>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Select…</option>
            <option value="Bank Transfer">Bank Transfer</option>
            <option value="Card">Card</option>
            <option value="Cash">Cash</option>
            <option value="PayPal">PayPal</option>
            <option value="Stripe">Stripe</option>
            <option value="Direct Debit">Direct Debit</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Reference / Transaction ID</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="h-9" />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleSave} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Record Payment</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Allocation Panel
// ---------------------------------------------------------------------------
function AllocationPanel({
  orderId, allocations, lines, warehouses, status, shipments, requirementsByLine, refundedByLine, onRefresh,
}: {
  orderId: string
  allocations: AllocationRow[]
  lines: AllocationPanelLine[]
  warehouses: WarehouseInfo[]
  status: SoStatus
  shipments: ShipmentRow[]
  requirementsByLine: Map<string, FulfillmentRequirementRow['requirements']>
  refundedByLine: Map<string, number>
  onRefresh: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editWhId, setEditWhId] = useState('')
  const [editQty, setEditQty] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showAddLine, setShowAddLine] = useState<string | null>(null) // lineId
  const [addWhId, setAddWhId] = useState('')
  const [addQty, setAddQty] = useState('')

  // Group allocations by warehouse
  const byWarehouse = new Map<string, { code: string; name: string; allocs: AllocationRow[] }>()
  for (const a of allocations) {
    const group = byWarehouse.get(a.warehouseId) ?? { code: a.warehouseCode, name: a.warehouseName, allocs: [] }
    group.allocs.push(a)
    byWarehouse.set(a.warehouseId, group)
  }

  // Compute qty already committed in non-PENDING shipments
  const shipmentCommittedByLine = calculateClientCoverageByLine(
    requirementsByLine,
    shipments
      .filter((shipment) => shipment.status !== 'PENDING')
      .flatMap((shipment) => shipment.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
      }))),
  )

  // Find backordered lines (not fully allocated for remaining qty)
  const allocatedByLine = calculateClientCoverageByLine(
    requirementsByLine,
    allocations.map((allocation) => ({
      lineId: allocation.lineId,
      productId: allocation.productId,
      qty: allocation.qty,
    })),
  )
  const backorderLines = lines.flatMap((l) => {
    if (!l.productId) return []
    const requiresStock = !l.productType || isStockTrackedProductType(l.productType)
    if (!requiresStock) return []
    const committed = shipmentCommittedByLine.get(l.id) ?? 0
    const refunded = refundedByLine.get(l.id) ?? 0
    const remaining = Math.max(0, l.qty - committed - refunded)
    if (remaining <= 0) return []
    const allocated = allocatedByLine.get(l.id) ?? 0
    const short = remaining - allocated
    if (short <= 0.0001) return []
    return [{ ...l, committed, remaining, allocated, short, backorderEligible: l.oversellAllowed }]
  })

  const visibleNotice = backorderLines.length > 0 ? notice : ''

  function handleDeallocate() {
    setError('')
    setNotice('')
    startTransition(async () => {
      const result = await deallocateOrder(orderId)
      if (result.success) onRefresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleReAllocate() {
    setError('')
    setNotice('')
    startTransition(async () => {
      const result = await autoAllocateOrder(orderId)
      if (result.success) {
        if ((result.unallocatedQty ?? 0) > 0) {
          setNotice(`${result.unallocatedQty} unit(s) remain unallocated; ${result.backorderLineCount ?? 0} line(s) are backorder eligible.`)
        }
        onRefresh()
      } else {
        if ((result.allocationCount ?? 0) > 0) onRefresh()
        setError(result.error ?? 'Failed')
      }
    })
  }

  function handleSaveEdit(allocId: string) {
    setError('')
    setNotice('')
    const qty = parseFloat(editQty)
    if (isNaN(qty) || qty < 0) { setError('Invalid quantity'); return }
    startTransition(async () => {
      const result = await updateAllocation(allocId, editWhId, qty)
      if (result.success) { setEditingId(null); onRefresh() }
      else setError(result.error ?? 'Failed')
    })
  }

  function handleAddAllocation(lineId: string, productId: string) {
    setError('')
    setNotice('')
    const qty = parseFloat(addQty)
    if (isNaN(qty) || qty <= 0) { setError('Invalid quantity'); return }
    startTransition(async () => {
      const result = await addAllocation(orderId, lineId, productId, addWhId, qty)
      if (result.success) { setShowAddLine(null); setAddQty(''); onRefresh() }
      else setError(result.error ?? 'Failed')
    })
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <div className="border-b px-4 py-2 bg-muted/50 flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Warehouse className="h-4 w-4 text-muted-foreground" />
          Stock Allocation
        </h2>
        <div className="flex items-center gap-1.5">
          {['PROCESSING', 'ALLOCATED'].includes(status) && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleReAllocate} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              {allocations.length > 0 ? 'Re-Allocate' : 'Auto-Allocate'}
            </Button>
          )}
          {allocations.length > 0 && status === 'ALLOCATED' && (
            <Button size="sm" className="h-7 text-xs" onClick={() => {
              startTransition(async () => {
                const result = await confirmAllocations(orderId)
                if (result.success) onRefresh()
                else setError(result.error ?? 'Failed')
              })
            }} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Create Shipments
            </Button>
          )}
          {allocations.length > 0 && (
            <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={handleDeallocate} disabled={isPending}>
              Deallocate
            </Button>
          )}
        </div>
      </div>

      {error && <p className="px-4 py-2 text-sm text-destructive">{error}</p>}
      {visibleNotice && <p className="px-4 py-2 text-sm text-muted-foreground">{visibleNotice}</p>}

      {allocations.length === 0 && backorderLines.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          No allocations yet. Click &ldquo;Allocate&rdquo; to auto-assign stock from warehouses.
        </div>
      )}

      {/* Allocated items grouped by warehouse */}
      {[...byWarehouse.entries()].map(([whId, { code, name, allocs }]) => (
        <div key={whId} className="border-b last:border-b-0">
          <div className="px-4 py-2 bg-muted/20 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium font-mono">{code}</span>
              <span className="text-muted-foreground">—</span>
              <span className="text-muted-foreground">{name}</span>
            </div>
            <span className="text-xs text-muted-foreground">{allocs.length} item(s)</span>
          </div>
          <div className="divide-y">
            {allocs.map((a) => {
              const isEditing = editingId === a.id
              const lineRequirements = requirementsByLine.get(a.lineId) ?? []
              const factor = lineRequirements.find((row) => row.productId === a.productId)?.factor ?? 1
              const isComponentDrivenLine = lineRequirements.length !== 1
                || lineRequirements[0]?.productId !== a.productId
                || Math.abs((lineRequirements[0]?.factor ?? 1) - 1) > 0.000001
              const covered = factor > 0 ? a.qty / factor : 0
              return (
                <div key={a.id} className="px-4 py-2.5 flex items-center gap-3">
                  {a.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={a.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <ProductLink productId={a.productId} sku={a.productSku} name={a.productName} />
                    {a.lineSku && a.lineSku !== a.productSku && (
                      <p className="text-xs text-muted-foreground">For sales line {a.lineSku}</p>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <select value={editWhId} onChange={(e) => setEditWhId(e.target.value)} className="h-7 rounded border border-input bg-background px-2 text-xs">
                        {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code}</option>))}
                      </select>
                      <Input type="number" min={0} step={1} value={editQty} onChange={(e) => setEditQty(e.target.value)} className="h-7 w-16 text-xs text-right font-mono" />
                      <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveEdit(a.id)} disabled={isPending}>Save</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingId(null)}>×</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        Component qty <span className="font-mono font-medium text-foreground">{a.qty}</span>
                        {factor > 0 && (
                          <span> · Covers <span className="font-mono font-medium text-foreground">{covered}</span> / {a.lineQty}</span>
                        )}
                      </span>
                      {isComponentDrivenLine && (
                        <span className="text-xs text-muted-foreground">
                          Use Deallocate/Re-Allocate to rebalance bundle components
                        </span>
                      )}
                      {['PROCESSING', 'ALLOCATED'].includes(status) && !isComponentDrivenLine && (
                        <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setEditingId(a.id); setEditWhId(a.warehouseId); setEditQty(String(a.qty)) }}>
                          Change
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Backorder items */}
      {backorderLines.length > 0 && (
        <div className="border-t">
          <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-950/30 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-600" />
            <span className="text-sm font-medium text-yellow-800 dark:text-yellow-200">Backorder</span>
          </div>
          <div className="divide-y">
            {backorderLines.map((l) => {
              const isAdding = showAddLine === l.id
              return (
                <div key={l.id} className="px-4 py-2.5 flex items-center gap-3">
                  {l.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={l.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {l.productId ? <ProductLink productId={l.productId} sku={l.sku} name={l.description} /> : <span className="text-sm">{l.description}</span>}
                  </div>
                  {isAdding ? (
                    <div className="flex items-center gap-2">
                      <select value={addWhId} onChange={(e) => setAddWhId(e.target.value)} className="h-7 rounded border border-input bg-background px-2 text-xs">
                        <option value="">Warehouse…</option>
                        {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code}</option>))}
                      </select>
                      <Input type="number" min={1} step={1} value={addQty} onChange={(e) => setAddQty(e.target.value)} placeholder={String(l.short)} className="h-7 w-16 text-xs text-right font-mono" />
                      <Button size="sm" className="h-7 text-xs" onClick={() => l.productId && handleAddAllocation(l.id, l.productId)} disabled={isPending || !addWhId}>Add</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddLine(null)}>×</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        Short <span className="font-mono font-medium text-destructive">{l.short}</span> of {l.remaining}
                      </span>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${l.backorderEligible ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                        {l.backorderEligible ? (l.productType === 'KIT' ? 'Backorder (component-limited)' : 'Backorder') : 'Unallocated'}
                      </span>
                      {['PROCESSING', 'ALLOCATED'].includes(status) && l.productId && (
                        <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setShowAddLine(l.id); setAddWhId(warehouses[0]?.id ?? ''); setAddQty(String(l.short)) }}>
                          Allocate
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shipments Panel
// ---------------------------------------------------------------------------

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending', PICKING: 'Picking', PACKED: 'Packed', SHIPPED: 'Shipped',
}
const SHIPMENT_STATUS_CLASS: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  PICKING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PACKED: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  SHIPPED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
}
const SHIPMENT_FLOW: Record<string, { label: string; target: string }> = {
  PENDING: { label: 'Start Picking', target: 'PICKING' },
  PICKING: { label: 'Mark Packed', target: 'PACKED' },
  PACKED: { label: 'Ship', target: 'SHIPPED' },
}


function ShipmentsPanel({
  shipments, carriers, deliveryTrackingEnabled, onRefresh,
}: {
  shipments: ShipmentRow[]
  carriers: string[]
  deliveryTrackingEnabled: boolean
  onRefresh: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [shipDialogId, setShipDialogId] = useState<string | null>(null)
  const [editingShipmentId, setEditingShipmentId] = useState<string | null>(null)
  const [tracking, setTracking] = useState('')
  const [service, setService] = useState('')
  const [error, setError] = useState('')

  function handleAdvance(shipmentId: string, target: string) {
    if (target === 'SHIPPED') {
      setShipDialogId(shipmentId)
      setEditingShipmentId(null)
      setTracking('')
      setService('')
      return
    }
    setError('')
    startTransition(async () => {
      const result = await updateShipmentStatus(shipmentId, target)
      if (result.success) onRefresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleShip(shipmentId: string) {
    setError('')
    startTransition(async () => {
      const result = editingShipmentId === shipmentId
        ? await updateShipmentTracking(shipmentId, {
            trackingNumber: tracking || undefined,
            shippingService: service || undefined,
          })
        : await updateShipmentStatus(shipmentId, 'SHIPPED', {
            trackingNumber: tracking || undefined,
            shippingService: service || undefined,
          })
      if (result.success) { setShipDialogId(null); setEditingShipmentId(null); onRefresh() }
      else setError(result.error ?? 'Failed')
    })
  }

  function handleEditTracking(shipment: ShipmentRow) {
    setError('')
    setShipDialogId(shipment.id)
    setEditingShipmentId(shipment.id)
    setTracking(shipment.trackingNumber ?? '')
    setService(shipment.shippingService ?? '')
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {shipments.map((s) => {
        const nextAction = SHIPMENT_FLOW[s.status]
        return (
          <div key={s.id} className="rounded-md border overflow-x-auto">
            <div className="px-4 py-2 bg-muted/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Shipment from <span className="font-mono">{s.warehouseCode}</span></span>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${SHIPMENT_STATUS_CLASS[s.status] ?? ''}`}>
                  {SHIPMENT_STATUS_LABELS[s.status] ?? s.status}
                </span>
                {s.trackingNumber && (() => {
                  const url = deliveryTrackingEnabled ? getTrackingUrl(s.shippingService, s.trackingNumber) : null
                  return url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-mono text-primary hover:underline">
                      <ExternalLink className="h-3 w-3" />#{s.trackingNumber}
                    </a>
                  ) : (
                    <span className="text-xs font-mono text-muted-foreground">#{s.trackingNumber}</span>
                  )
                })()}
              </div>
              <div className="flex items-center gap-1.5">
                {nextAction && s.status !== 'SHIPPED' && (
                  <Button size="sm" className="h-7 text-xs" onClick={() => handleAdvance(s.id, nextAction.target)} disabled={isPending}>
                    {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    {nextAction.label}
                  </Button>
                )}
                {s.status === 'SHIPPED' && (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleEditTracking(s)} disabled={isPending}>
                    Edit Tracking
                  </Button>
                )}
              </div>
            </div>
            <div className="divide-y">
              {s.lines.map((l) => (
                <div key={l.id} className="px-4 py-2 flex items-center gap-3">
                  {l.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={l.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <ProductLink productId={l.productId} sku={l.productSku} name={l.productName} />
                    {l.lineSku && l.lineSku !== l.productSku && (
                      <p className="text-xs text-muted-foreground">For sales line {l.lineSku}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">Qty: <span className="font-mono font-medium text-foreground">{l.qty}</span></span>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* Ship dialog */}
      {shipDialogId && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
            <DialogHeader><DialogTitle>{editingShipmentId === shipDialogId ? 'Edit Tracking' : 'Ship Parcel'}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Carrier</Label>
                <select value={service} onChange={(e) => setService(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">Select carrier...</option>
                  {carriers.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Tracking Number</Label>
                <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Optional" className="h-9 text-sm font-mono" />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShipDialogId(null); setEditingShipmentId(null) }} disabled={isPending}>Cancel</Button>
              <Button onClick={() => handleShip(shipDialogId)} disabled={isPending}>
                {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{editingShipmentId === shipDialogId ? 'Save Tracking' : 'Confirm Shipment'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main detail
// ---------------------------------------------------------------------------
export function SoDetailClient({ order: so, warehouses, currencies, externalOrderLinks, wmsOrderStatus, wmsPushState, stockLevels, initialAllocations, initialShipments, fulfillmentRequirements, carriers, deliveryTrackingEnabled, accountingAvailable, accountingInvoiceUrlTemplate, accountingSyncEnabled, currentUserRole, rejectedAccountingSyncs, paidWithoutInvoice }: Props) {
  const baseCurrency = useBaseCurrency()
  const formatDateTime = useFormatDateTime()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showRefund, setShowRefund] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [showRefunds, setShowRefunds] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [showPayment, setShowPayment] = useState<{ refundId?: string; creditNoteNumber?: string } | null>(null)
  const [visibleCols, setVisibleCols] = useState<Set<OptCol>>(new Set())
  const [error, setError] = useState('')
  const [allocations, setAllocations] = useState<AllocationRow[]>(initialAllocations)
  const [shipments, setShipments] = useState<ShipmentRow[]>(initialShipments)
  const requirementsByLine = new Map(fulfillmentRequirements.map((row) => [row.lineId, row.requirements]))

  // Sync client state from server props when router.refresh() delivers fresh data.
  // This eliminates the race between refreshAllocations() and router.refresh() —
  // whichever completes last, state ends up correct.
  useEffect(() => { setAllocations(initialAllocations) }, [initialAllocations])
  useEffect(() => { setShipments(initialShipments) }, [initialShipments])

  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const sym = symbolMap[so.currency] ?? so.currency
  const symPos = positionMap[so.currency] ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)
  const baseMoney = (n: number) => formatMoney(n, baseCurrency.symbol, baseCurrency.symbolPosition)

  // VAT display helpers. All *Foreign totals on SalesOrder are stored NET.
  // When the order was entered with tax-inclusive prices we display gross
  // values (net * (1 + rate)) throughout the table so the figures match
  // what the user typed in. discountAmount is stored in the raw input
  // convention (gross when inclVat), matching the WC importer.
  const vatRate = so.taxRatePercent ?? 0
  const inclVat = so.pricesIncludeVat && vatRate > 0
  const toGross = (net: number) => inclVat ? net * (1 + vatRate) : net
  // Refund/credit-note amounts are always shown tax-inclusive (like the order's
  // grand total), since refund line totals are stored net regardless of inclVat.
  const grossWithVat = (net: number) => vatRate > 0 ? net * (1 + vatRate) : net
  const subtotalDisplay = toGross(so.subtotalForeign)
  const shippingDisplay = toGross(so.shippingForeign)
  const discountDisplay = so.discountAmount // already gross in inclVat mode

  const hasShipments = shipments.length > 0
  // Filter out Delivered action if delivery tracking is not enabled
  const nextActions = (STATUS_FLOW_SHIPMENTS[so.status] ?? []).filter((a) => a.target !== 'DELIVERED' || deliveryTrackingEnabled)
  const canCancel = ['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'].includes(so.status)
  const canDelete = ['DRAFT', 'PENDING_PAYMENT'].includes(so.status)
  // Refund is allowed once shipped, or to top up an already partially-refunded order.
  // Reads the orthogonal refundStatus so it keeps working once a partial refund no
  // longer forces the lifecycle status to PARTIALLY_REFUNDED (epic stage 3).
  const canRefund = (['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(so.status) && so.refundStatus !== 'FULL') || so.refundStatus === 'PARTIAL'
  const canRetryRefundAccounting = hasPermission(currentUserRole, 'sales.refund')

  // Compute qty already committed in non-PENDING shipments for partial fulfillment
  const committedByLine = calculateClientCoverageByLine(
    requirementsByLine,
    shipments
      .filter((shipment) => shipment.status !== 'PENDING')
      .flatMap((shipment) => shipment.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: line.qty,
      }))),
  )
  // Refunded quantities are no longer outstanding demand — exclude them from the
  // "unfulfilled" check and the allocation panel's remaining/backorder math so a
  // refunded line isn't offered for allocation.
  const refundedByLine = new Map<string, number>()
  for (const refund of so.refunds) {
    for (const rl of refund.lines) {
      if (!rl.salesOrderLineId || rl.qty <= 0) continue
      refundedByLine.set(rl.salesOrderLineId, (refundedByLine.get(rl.salesOrderLineId) ?? 0) + rl.qty)
    }
  }
  const hasUnfulfilledLines = so.lines.some((l) => {
    if (!l.productId) return false
    const committed = committedByLine.get(l.id) ?? 0
    const refunded = refundedByLine.get(l.id) ?? 0
    return committed + refunded < l.qty
  })

  // Show allocation panel when PROCESSING/ALLOCATED AND (no shipments OR unfulfilled lines remain)
  const showAllocations = ['PROCESSING', 'ALLOCATED'].includes(so.status) && (!hasShipments || hasUnfulfilledLines)
  const showShipments = ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED'].includes(so.status) && hasShipments

  const refreshAllocations = useCallback(() => {
    getOrderAllocations(so.id).then(setAllocations)
    getOrderShipments(so.id).then(setShipments)
  }, [so.id])

  function handleStatusChange(target: SoStatus) {
    if (target === 'ALLOCATED') {
      setError('')
      startTransition(async () => {
        const result = await autoAllocateOrder(so.id)
        if (result.success) { refreshAllocations(); router.refresh() }
        else {
          if ((result.allocationCount ?? 0) > 0) refreshAllocations()
          setError(result.error ?? 'Failed')
        }
      })
      return
    }
    setError('')
    startTransition(async () => {
      const result = await updateSalesOrderStatus(so.id, target)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleCancel() {
    if (!confirm('Cancel this order?')) return
    setError('')
    startTransition(async () => {
      const result = await updateSalesOrderStatus(so.id, 'CANCELLED')
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleClone() {
    startTransition(async () => {
      const result = await cloneSalesOrder(so.id)
      if (result.success && result.newId) { router.push(`/sales/${result.newId}`) }
      else setError(result.error ?? 'Failed')
    })
  }

  function handleDelete() {
    if (!confirm('Permanently delete this order?')) return
    startTransition(async () => {
      const result = await deleteSalesOrder(so.id)
      if (result.success) router.push('/sales')
      else setError(result.error ?? 'Failed')
    })
  }

  // Derive paid status from invoice payments (no manual toggle)
  const invoicePayments = so.payments.filter((p) => !p.refundId)
  const totalPaid = invoicePayments.reduce((s, p) => s + p.amount, 0)
  const invoiceBalance = so.totalForeign - totalPaid
  const isPaid = so.invoiceNumber != null && invoiceBalance <= 0.01
  const isPartiallyPaid = so.invoiceNumber != null && totalPaid > 0.01 && invoiceBalance > 0.01

  function handleGenerateInvoice() {
    startTransition(async () => {
      const result = await generateInvoiceNumber(so.id)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleRetryRefundAccounting(refundId: string) {
    setError('')
    startTransition(async () => {
      const result = await retryRefundAccounting(refundId)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed to retry refund accounting')
    })
  }

  function toggleCol(col: OptCol) {
    setVisibleCols((prev) => { const n = new Set(prev); if (n.has(col)) n.delete(col); else n.add(col); return n })
  }

  function handleEmailOrder() {
    setError('')
    startTransition(async () => {
      const result = await sendSalesOrderEmail(so.id)
      if (result.success) { setError(''); alert('Order confirmation sent to ' + so.customerEmail) }
      else setError(result.error ?? 'Failed to send email')
    })
  }

  function handleEmailInvoice() {
    setError('')
    startTransition(async () => {
      const result = await sendInvoiceEmail(so.id)
      if (result.success) { setError(''); alert('Invoice sent to ' + so.customerEmail) }
      else setError(result.error ?? 'Failed to send email')
    })
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Status + Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_CLASS[so.status]}`}>
          {STATUS_LABELS[so.status]}
        </span>
        {so.refundStatus !== 'NONE' && (
          <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${
            so.refundStatus === 'FULL'
              ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200'
              : 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200'
          }`}>
            {so.refundStatus === 'FULL' ? 'Fully refunded' : 'Partially refunded'}
          </span>
        )}
        {isPaid && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200">
            Paid
          </span>
        )}
        {isPartiallyPaid && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200">
            Part. Paid
          </span>
        )}

        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {/* Workflow */}
          {nextActions.map((a) => (
            <Button key={a.target} size="sm" onClick={() => handleStatusChange(a.target)} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <a.icon className="h-4 w-4 mr-1" />}
              {a.label}
            </Button>
          ))}

          {/* Invoice. audit-H2: when the order is paid without an invoice on a
              manual/unset trigger (paidWithoutInvoice), show ONLY the amber chip
              — suppress the plain generate button and the pending-sync chip so
              there is a single, unambiguous affordance. */}
          {accountingAvailable && !so.invoiceNumber && !accountingSyncEnabled && !paidWithoutInvoice && (
            <Button variant="outline" size="sm" onClick={handleGenerateInvoice} disabled={isPending}>
              <FileText className="h-4 w-4 mr-1" />Generate Invoice
            </Button>
          )}
          {accountingAvailable && accountingSyncEnabled && !so.invoiceNumber && !so.accountingInvoiceId && so.status !== 'DRAFT' && !paidWithoutInvoice && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" />Invoice pending sync</span>
          )}
          {paidWithoutInvoice && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="h-3 w-3" /> Paid without invoice —{' '}
              <button type="button" onClick={handleGenerateInvoice} disabled={isPending} className="underline hover:no-underline disabled:opacity-50">
                generate now
              </button>
            </span>
          )}
          {/* audit-M-o2c: the paid→unpaid mismatch from deleting a payment on an
              advanced-status order is recorded as a payment_status_mismatch WARNING
              activity log (the durable, accurate signal). A read-time chip on
              `!paidAt` alone can't tell "shipped on credit, never paid" from
              "was paid then unpaid", so it isn't shown here; the existing
              Paid / Part. Paid indicators cover the payment state. */}

          {canRefund && (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowRefund(true)} disabled={isPending}>
              <Undo2 className="h-4 w-4 mr-1" />Refund
            </Button>
          )}

          <span className="w-px h-5 bg-border mx-0.5" />

          {/* Notes / Delete / WC */}
          <Button variant="outline" size="sm" onClick={() => setShowNotes(true)}>
            <Pencil className="h-4 w-4 mr-1" />Notes
          </Button>
          {externalOrderLinks?.map((link) => (
            <Button key={link.url} variant="outline" size="sm" onClick={() => window.open(link.url, '_blank')}>
              <ExternalLink className="h-4 w-4 mr-1" />{link.label}
            </Button>
          ))}
          {wmsOrderStatus && (
            <span className="inline-flex items-center self-center">
              <WmsOrderStatusChip status={wmsOrderStatus} />
            </span>
          )}
          {wmsPushState && (
            <span className="inline-flex items-center self-center">
              <WmsOrderPushChip orderId={so.id} push={wmsPushState} />
            </span>
          )}
          {canCancel && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={handleCancel} disabled={isPending}>
              <Ban className="h-4 w-4 mr-1" />Cancel
            </Button>
          )}
          {canDelete && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={handleDelete} disabled={isPending}>
              <Trash2 className="h-4 w-4 mr-1" />Delete
            </Button>
          )}

          {/* More actions dropdown (PDF, Email, Clone) */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <EllipsisVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => window.open(`/api/sales-order/${so.id}`, '_blank')}>
                <FileText className="h-4 w-4 mr-1.5" />Order PDF
              </DropdownMenuItem>
              {accountingAvailable && so.invoiceNumber && (
                <DropdownMenuItem onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
                  <FileText className="h-4 w-4 mr-1.5" />Invoice PDF
                </DropdownMenuItem>
              )}
              {['PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED'].includes(so.status) && (
                <DropdownMenuItem onClick={() => window.open(`/api/packing-slip/${so.id}`, '_blank')}>
                  <Package className="h-4 w-4 mr-1.5" />Packing Slip
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {so.customerEmail && (
                <DropdownMenuItem onClick={handleEmailOrder} disabled={isPending}>
                  <Mail className="h-4 w-4 mr-1.5" />Email Order
                </DropdownMenuItem>
              )}
              {accountingAvailable && so.invoiceNumber && so.customerEmail && (
                <DropdownMenuItem onClick={handleEmailInvoice} disabled={isPending}>
                  <Mail className="h-4 w-4 mr-1.5" />Email Invoice
                </DropdownMenuItem>
              )}
              {so.customerEmail && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={handleClone} disabled={isPending}>
                <Copy className="h-4 w-4 mr-1.5" />Clone
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {rejectedAccountingSyncs.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2">
              <p className="font-medium">Accounting rejected the latest invoice update. Review the message, correct the document in IMS or accounting, then retry the failed sync from the sync dashboard.</p>
              <ul className="space-y-1 text-xs">
                {rejectedAccountingSyncs.map((sync) => (
                  <li key={sync.id}>
                    <span className="font-medium uppercase">{sync.connector}</span>
                    {' '}
                    {ACCOUNTING_SYNC_TYPE_LABEL[sync.type]} failed on {formatDateTime(sync.createdAt)}
                    {sync.retryCount > 0 ? ` after ${sync.retryCount} retries` : ''}: {sync.errorMessage}
                  </li>
                ))}
              </ul>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Header info */}
      <div className="rounded-md border p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">Customer</span>
          <p className="font-medium">{so.customerName ?? '—'}</p>
          {so.customerEmail && <p className="text-xs text-muted-foreground">{so.customerEmail}</p>}
        </div>
        <div>
          <span className="text-muted-foreground">Shipping Address</span>
          {so.shippingAddress ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <p className="text-xs mt-0.5 flex items-center gap-1 flex-wrap">{(() => { const a = so.shippingAddress as Record<string, string>; const parts = [...[a.line1, a.line2, a.city, a.county, a.postcode].filter(Boolean)]; const countryStr = a.country ? countryName(so.shippingCountryCode) : ''; if (countryStr) parts.push(countryStr); return parts.join(', ') || '—' })()}{so.shippingCountryCode && <img src={`https://flagcdn.com/16x12/${so.shippingCountryCode.toLowerCase()}.png`} alt={so.shippingCountryCode} className="h-3 w-4 object-cover inline-block" />}</p>
          ) : <p className="text-muted-foreground">—</p>}
        </div>
        <div>
          <span className="text-muted-foreground">Source</span>
          <p className="font-medium">{so.sourceLabel}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Ship From</span>
          <p className="font-medium">{so.shipFromWarehouseName ?? '—'}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Shipping Service</span>
          <p className="font-medium">{so.shippingService ?? '—'}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Currency</span>
          <p className="font-medium">{so.currency} ({sym})</p>
        </div>
        {so.paymentMethodTitle && (
          <div>
            <span className="text-muted-foreground">Payment</span>
            <p className="font-medium">{so.paymentMethodTitle}</p>
          </div>
        )}
        <div>
          <span className="text-muted-foreground">Order Date</span>
          <p className="font-medium">{formatDateTime(so.externalOrderDate ?? so.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}{', '}{formatDateTime(so.externalOrderDate ?? so.createdAt, { hour: '2-digit', minute: '2-digit' })}</p>
        </div>
        {so.expectedDelivery && <div><span className="text-muted-foreground">Expected Delivery</span><p className="font-medium">{formatDateTime(so.expectedDelivery, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>}
        {so.salesRep && <div><span className="text-muted-foreground">Sales Rep</span><p className="font-medium">{so.salesRep}</p></div>}
        {so.trackingNumber && <div><span className="text-muted-foreground">Tracking</span>{(() => {
          const url = deliveryTrackingEnabled ? getTrackingUrl(so.shippingService, so.trackingNumber) : null
          return url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-medium font-mono text-xs text-primary hover:underline">
              <ExternalLink className="h-3 w-3" />{so.trackingNumber}
            </a>
          ) : <p className="font-medium font-mono text-xs">{so.trackingNumber}</p>
        })()}</div>}
        {so.shippedAt && <div><span className="text-muted-foreground">Shipped</span><p className="font-medium">{formatDateTime(so.shippedAt, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>}
        <div>
          <span className="text-muted-foreground">COGS</span>
          <p className="font-medium font-mono">{so.cogsBase != null ? baseMoney(so.cogsBase) : '—'}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Margin</span>
          <p className={`font-medium font-mono ${so.profitMarginPercent != null ? (so.profitMarginPercent >= 0 ? 'text-green-600' : 'text-red-600') : ''}`}>
            {so.profitMarginPercent != null ? `${so.profitMarginPercent.toFixed(1)}%` : '—'}
          </p>
        </div>
        {so.notes && <div className="col-span-2"><span className="text-muted-foreground">Customer Notes</span><p className="mt-0.5 whitespace-pre-wrap">{so.notes}</p></div>}
        {so.internalNotes && <div className="col-span-2"><span className="text-muted-foreground">Private Notes</span><p className="mt-0.5 whitespace-pre-wrap text-muted-foreground italic">{so.internalNotes}</p></div>}
      </div>

      {/* Lines table */}
      <div className="rounded-md border">
        <div className="border-b px-4 py-2 bg-muted/50 flex items-center justify-between">
          <h2 className="text-sm font-medium">Line Items</h2>
          <div className="relative">
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setShowColPicker((v) => !v)}>
              <Settings2 className="h-3.5 w-3.5 mr-1" />Columns
            </Button>
            {showColPicker && (
              <div className="absolute right-0 top-8 z-20 bg-popover border rounded-md shadow-md p-2 space-y-1 w-44">
                {OPT_COLUMNS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted rounded px-1 py-0.5">
                    <input type="checkbox" checked={visibleCols.has(c.key)} onChange={() => toggleCol(c.key)} className="rounded border-input" />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <Table className="min-w-[700px]">
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead className="w-12 px-2" />
              <TableHead className="px-4 text-xs">Product</TableHead>
              <TableHead className="px-4 text-xs text-right w-16">Qty</TableHead>
              <TableHead className="px-4 text-xs text-right w-28">Unit Price ({sym})</TableHead>
              <TableHead className="px-4 text-xs text-right w-24">Discount</TableHead>
              {vatRate > 0 && <TableHead className="px-4 text-xs text-right w-20">VAT ({sym})</TableHead>}
              <TableHead className="px-4 text-xs text-right w-28">Total ({sym})</TableHead>
              {visibleCols.has('cogs') && <TableHead className="px-4 text-xs text-right w-20">COGS ({baseCurrency.code})</TableHead>}
              {visibleCols.has('margin') && <TableHead className="px-4 text-xs text-right w-20">Margin ({baseCurrency.code})</TableHead>}
              {visibleCols.has('marginPct') && <TableHead className="px-4 text-xs text-right w-16">Margin %</TableHead>}
              {visibleCols.has('qtyShipped') && <TableHead className="px-4 text-xs text-right w-16">Shipped</TableHead>}
              {visibleCols.has('qtyReturned') && <TableHead className="px-4 text-xs text-right w-16">Returned</TableHead>}
              {visibleCols.has('qtyCancelled') && <TableHead className="px-4 text-xs text-right w-16">Cancelled</TableHead>}
              {visibleCols.has('qtyOnHand') && <TableHead className="px-4 text-xs text-right w-16">On Hand</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {so.lines.map((line) => {
              const cogs = line.cogsBase ?? 0
              const revenueBase = line.totalBase
              const margin = revenueBase - cogs
              const marginPct = revenueBase > 0 ? (margin / revenueBase) * 100 : 0
              const shipped = ['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(so.status) ? line.qty : 0
              const cancelled = so.status === 'CANCELLED' ? line.qty : 0
              const returned = so.refunds?.reduce((s, r) => s + r.lines.filter((rl) => rl.productId === line.productId).reduce((s2, rl) => s2 + rl.qty, 0), 0) ?? 0
              // In inclVat mode the stored totalForeign is NET — display gross
              // (user-entered) values so Unit Price, VAT and Total all line up.
              const lineTotalDisplay = toGross(line.totalForeign)
              return (
                <TableRow key={line.id}>
                  <TableCell className="w-12 px-2 py-1">
                    {line.productId && <ProductThumb productId={line.productId} imageUrl={line.imageUrl} name={line.description} />}
                  </TableCell>
                  <TableCell className="px-4">{line.productId ? <ProductLink productId={line.productId} sku={line.sku} name={line.description} /> : <span className="text-sm">{line.description}</span>}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums">{line.qty}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums font-mono text-xs">{formatMoney(line.unitPriceForeign, sym)}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums font-mono text-xs text-destructive">{line.discountAmount > 0 ? (line.discountStr ?? formatMoney(-line.discountAmount, sym)) : '—'}</TableCell>
                  {vatRate > 0 && (
                    <TableCell className="px-4 text-right tabular-nums font-mono text-xs text-muted-foreground">
                      {formatMoney(line.taxForeign, sym)}
                      {line.taxRatePercent != null && Math.abs(line.taxRatePercent - vatRate) > 0.0001 && (
                        <span className="ml-1 inline-flex items-center rounded-sm border border-amber-300 bg-amber-50 px-1 py-0 text-[10px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                          {(line.taxRatePercent * 100).toFixed(line.taxRatePercent * 100 % 1 === 0 ? 0 : 1)}%
                        </span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="px-4 text-right tabular-nums font-mono text-xs">{formatMoney(lineTotalDisplay, sym)}</TableCell>
                  {visibleCols.has('cogs') && <TableCell className="px-4 text-right tabular-nums font-mono text-xs text-muted-foreground">{cogs > 0 ? baseMoney(cogs) : '—'}</TableCell>}
                  {visibleCols.has('margin') && <TableCell className="px-4 text-right tabular-nums font-mono text-xs">{cogs > 0 ? baseMoney(margin) : '—'}</TableCell>}
                  {visibleCols.has('marginPct') && <TableCell className="px-4 text-right tabular-nums text-xs">{cogs > 0 ? `${marginPct.toFixed(1)}%` : '—'}</TableCell>}
                  {visibleCols.has('qtyShipped') && <TableCell className="px-4 text-right tabular-nums text-xs">{shipped > 0 ? shipped : '—'}</TableCell>}
                  {visibleCols.has('qtyReturned') && <TableCell className="px-4 text-right tabular-nums text-xs text-orange-600">{returned > 0 ? returned : '—'}</TableCell>}
                  {visibleCols.has('qtyCancelled') && <TableCell className="px-4 text-right tabular-nums text-xs text-destructive">{cancelled > 0 ? cancelled : '—'}</TableCell>}
                  {visibleCols.has('qtyOnHand') && (() => {
                if (!line.productId) return <TableCell className="px-4 text-right text-xs text-muted-foreground">—</TableCell>
                const whId = so.shipFromWarehouseId
                if (whId) {
                  const entry = stockLevels[line.productId]?.[whId]
                  const avail = entry ? entry.available : 0
                  return <TableCell className={`px-4 text-right tabular-nums text-xs ${avail < line.qty ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>{avail}</TableCell>
                }
                // No warehouse selected — show total across all
                const entries = stockLevels[line.productId] ?? {}
                const total = Object.values(entries).reduce((s, e) => s + e.available, 0)
                return <TableCell className="px-4 text-right tabular-nums text-xs text-muted-foreground">{total}</TableCell>
              })()}
                </TableRow>
              )
            })}
          </TableBody>
          <tfoot className="border-t bg-muted/30 text-sm">
            {(() => {
              // Align totals under the Total column. Base cols before Total =
              // img + Product + Qty + Unit Price + Discount (+ VAT) = 5 or 6.
              // Add optional columns after Total into the right-hand span.
              const labelSpan = 5 + (vatRate > 0 ? 1 : 0)
              const rightSpan = 1
                + (visibleCols.has('cogs') ? 1 : 0)
                + (visibleCols.has('margin') ? 1 : 0)
                + (visibleCols.has('marginPct') ? 1 : 0)
                + (visibleCols.has('qtyShipped') ? 1 : 0)
                + (visibleCols.has('qtyReturned') ? 1 : 0)
                + (visibleCols.has('qtyCancelled') ? 1 : 0)
                + (visibleCols.has('qtyOnHand') ? 1 : 0)
              return <>
                <tr>
                  <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">Subtotal</td>
                  <td colSpan={rightSpan} className="px-4 py-1.5 text-right tabular-nums font-mono">{money(subtotalDisplay)}</td>
                </tr>
                {so.discountAmount > 0 && (
                  <tr>
                    <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-destructive">Order Discount</td>
                    <td colSpan={rightSpan} className="px-4 py-1.5 text-right tabular-nums font-mono text-destructive">{money(-discountDisplay)}</td>
                  </tr>
                )}
                {so.shippingForeign > 0 && (
                  <tr>
                    <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">Shipping{so.shippingService ? ` (${so.shippingService})` : ''}</td>
                    <td colSpan={rightSpan} className="px-4 py-1.5 text-right tabular-nums font-mono">{money(shippingDisplay)}</td>
                  </tr>
                )}
                {so.taxForeign > 0 && (
                  <tr>
                    <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">{so.taxRateName ?? 'Tax'}{so.taxRatePercent != null ? ` (${(so.taxRatePercent * 100).toFixed(0)}%)` : ''}</td>
                    <td colSpan={rightSpan} className="px-4 py-1.5 text-right tabular-nums font-mono">{money(so.taxForeign)}</td>
                  </tr>
                )}
                <tr className="border-t">
                  <td colSpan={labelSpan} className="px-4 py-2 text-right font-medium text-muted-foreground">Total</td>
                  <td colSpan={rightSpan} className="px-4 py-2 text-right tabular-nums font-mono">
                    <span className="font-semibold">{money(so.totalForeign)}</span>
                    {so.currency !== baseCurrency.code && <span className="text-muted-foreground font-normal text-xs ml-1">({baseMoney(so.totalBase)})</span>}
                  </td>
                </tr>
              </>
            })()}
          </tfoot>
        </Table>
      </div>

      {/* Allocation Panel */}
      {showAllocations && (
        <AllocationPanel
          orderId={so.id}
          allocations={allocations}
          lines={so.lines}
          warehouses={warehouses}
          status={so.status}
          shipments={shipments}
          requirementsByLine={requirementsByLine}
          refundedByLine={refundedByLine}
          onRefresh={() => { refreshAllocations(); router.refresh() }}
        />
      )}

      {/* Shipments Panel */}
      {showShipments && (
        <ShipmentsPanel
          shipments={shipments}
          carriers={carriers}
          deliveryTrackingEnabled={deliveryTrackingEnabled}
          onRefresh={() => { refreshAllocations(); router.refresh() }}
        />
      )}

      {/* Invoice */}
      {accountingAvailable && so.invoiceNumber && (
        <div className="rounded-md border overflow-x-auto">
          <div className="px-4 py-2 bg-muted/50 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Invoice {so.invoiceNumber}
              {isPaid && <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200">Paid</span>}
              {isPartiallyPaid && <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200">Part. Paid</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowInvoice(true)}>
                View Details
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
                <FileText className="h-3 w-3 mr-1" />PDF
              </Button>
              {so.customerEmail && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleEmailInvoice} disabled={isPending}>
                  <Mail className="h-3 w-3 mr-1" />Email
                </Button>
              )}
              {so.accountingInvoiceId && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(accountingInvoiceUrlTemplate.replace('{id}', so.accountingInvoiceId!), '_blank')}>
                  <ExternalLink className="h-3 w-3 mr-1" />Accounting
                </Button>
              )}
            </div>
          </div>
          <div className="px-4 py-3 text-sm grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-muted-foreground text-xs">Invoice Date</span>
              <p className="font-medium">{so.invoicedAt ? formatDateTime(so.invoicedAt, { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Total</span>
              <p className="font-medium font-mono">{money(so.totalForeign)}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Paid</span>
              <p className="font-medium font-mono">
                {(() => { const invPayments = so.payments.filter((p) => !p.refundId); const paid = invPayments.reduce((s, p) => s + p.amount, 0); return money(paid) })()}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Balance</span>
              <p className={`font-medium font-mono ${(() => { const paid = so.payments.filter((p) => !p.refundId).reduce((s, p) => s + p.amount, 0); return so.totalForeign - paid > 0.01 ? 'text-destructive' : 'text-green-600' })()}`}>
                {(() => { const paid = so.payments.filter((p) => !p.refundId).reduce((s, p) => s + p.amount, 0); const bal = so.totalForeign - paid; return bal > 0.01 ? `${money(bal)} due` : 'Settled' })()}
              </p>
            </div>
          </div>
          {/* Invoice payments */}
          <div className="border-t px-4 py-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Payments</h3>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowPayment({})}>
                <CreditCard className="h-3 w-3 mr-1" />Add Payment
              </Button>
            </div>
            {so.payments.filter((p) => !p.refundId).length > 0 && (
              <div className="mt-2 space-y-1">
                {so.payments.filter((p) => !p.refundId).map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{formatDateTime(p.paidAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      {p.method && <span className="text-muted-foreground">{p.method}</span>}
                      {p.reference && <span className="font-mono text-muted-foreground">{p.reference}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{money(p.amount)}</span>
                      <button type="button" onClick={() => { if (confirm('Delete this payment?')) startTransition(async () => { await deletePayment(p.id, so.id); router.refresh() }) }} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Refunds */}
      {so.refunds.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <button type="button" className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 text-sm font-medium" onClick={() => setShowRefunds((v) => !v)}>
            <span>Refunds ({so.refunds.length})</span>
            {showRefunds ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showRefunds && <div className="divide-y">{so.refunds.map((r) => (
            <div key={r.id} className="px-4 py-3 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {r.creditNoteNumber && <span className="font-mono text-xs font-medium">{r.creditNoteNumber}</span>}
                  <span className="text-muted-foreground text-xs">{formatDateTime(r.refundedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                <span className="font-mono font-medium text-destructive">-{money(grossWithVat(r.totalForeign))}</span>
              </div>
              {r.reason && <p className="text-xs"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>}
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="py-1 pr-4 text-xs">Item</TableHead>
                    <TableHead className="py-1 pr-4 text-xs text-right">Qty</TableHead>
                    <TableHead className="py-1 pr-4 text-xs text-right">Unit Price</TableHead>
                    {vatRate > 0 && <TableHead className="py-1 pr-4 text-xs text-right">VAT</TableHead>}
                    <TableHead className="py-1 text-xs text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>{r.lines.map((rl) => (
                  <TableRow key={rl.id}>
                    <TableCell className="py-1 pr-4">{rl.description}</TableCell>
                    <TableCell className="py-1 pr-4 text-right tabular-nums">{rl.qty > 0 ? rl.qty : '—'}</TableCell>
                    <TableCell className="py-1 pr-4 text-right font-mono tabular-nums">{rl.qty > 0 ? money(rl.unitPriceForeign) : '—'}</TableCell>
                    {vatRate > 0 && <TableCell className="py-1 pr-4 text-right font-mono tabular-nums text-muted-foreground">{money(rl.totalForeign * vatRate)}</TableCell>}
                    <TableCell className="py-1 text-right font-mono tabular-nums">{money(toGross(rl.totalForeign))}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
              {/* Credit note payments */}
              {accountingAvailable && r.payments.length > 0 && (
                <div className="space-y-1 pt-1 border-t">
                  {r.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{formatDateTime(p.paidAt, { day: 'numeric', month: 'short' })}</span>
                        {p.method && <span className="text-muted-foreground">{p.method}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono">{money(p.amount)}</span>
                        <button type="button" onClick={() => { if (confirm('Delete?')) startTransition(async () => { await deletePayment(p.id, so.id); router.refresh() }) }} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {accountingAvailable && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setShowPayment({ refundId: r.id, creditNoteNumber: r.creditNoteNumber ?? undefined })}>
                    <CreditCard className="h-3 w-3 mr-1" />Add Payment
                  </Button>
                  {canRetryRefundAccounting && r.accountingRetryRequired && (
                    <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => handleRetryRefundAccounting(r.id)} disabled={isPending}>
                      {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Undo2 className="h-3 w-3 mr-1" />}
                      Retry Accounting
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}</div>}
        </div>
      )}

      {/* Dialogs */}
      {showRefund && <RefundDialog order={so} warehouses={warehouses} sym={sym} onClose={() => setShowRefund(false)} />}
      {showNotes && <NotesDialog order={so} onClose={() => setShowNotes(false)} />}
      {accountingAvailable && showPayment && <PaymentDialog orderId={so.id} refundId={showPayment.refundId} creditNoteNumber={showPayment.creditNoteNumber} currency={so.currency} defaultAmount={!showPayment.refundId ? (invoiceBalance > 0.01 ? invoiceBalance : undefined) : undefined} onClose={() => setShowPayment(null)} />}

      {/* Invoice detail dialog */}
      {accountingAvailable && showInvoice && so.invoiceNumber && (
        <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
          <DialogHeader><DialogTitle>Invoice {so.invoiceNumber}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {/* Invoice header */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground text-xs">Invoice Number</span>
                <p className="font-medium font-mono">{so.invoiceNumber}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Invoice Date</span>
                <p className="font-medium">{so.invoicedAt ? formatDateTime(so.invoicedAt, { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Status</span>
                <p className="font-medium">{isPaid ? 'Paid' : isPartiallyPaid ? 'Partially Paid' : 'Unpaid'}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Customer</span>
                <p className="font-medium">{so.customerName ?? '—'}</p>
              </div>
              <div className="sm:col-span-2">
                <span className="text-muted-foreground text-xs">Billing Address</span>
                <p className="text-xs mt-0.5">{so.billingAddress ? (() => { const a = so.billingAddress as Record<string, string>; return [a.line1, a.line2, a.city, a.county, a.postcode, formatCountryDisplay(a.country)].filter(Boolean).join(', ') || '—' })() : '—'}</p>
              </div>
            </div>

            {/* Line items */}
            <Table containerClassName="rounded-md border overflow-x-auto" className="min-w-[500px]">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Description</TableHead>
                  <TableHead className="text-xs text-right w-16">Qty</TableHead>
                  <TableHead className="text-xs text-right w-24">Unit Price</TableHead>
                  <TableHead className="text-xs text-right w-20">Discount</TableHead>
                  <TableHead className="text-xs text-right w-20">Tax</TableHead>
                  <TableHead className="text-xs text-right w-24">Total ({sym})</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {so.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      {line.productId ? (
                        <ProductLink productId={line.productId} sku={line.sku} name={line.description} skuClassName="font-mono text-xs text-muted-foreground" />
                      ) : (
                        <>{line.description}{line.sku ? ` (${line.sku})` : ''}</>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{line.qty}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{line.unitPriceForeign.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-destructive">{line.discountAmount > 0 ? `-${line.discountAmount.toFixed(2)}` : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{line.taxForeign > 0 ? line.taxForeign.toFixed(2) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{money(line.totalForeign)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <tfoot className="border-t bg-muted/30 text-sm">
                <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">Subtotal</td><td className="px-3 py-1.5 text-right font-mono">{money(so.subtotalForeign)}</td></tr>
                {so.discountAmount > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-destructive">Discount</td><td className="px-3 py-1.5 text-right font-mono text-destructive">-{money(so.discountAmount)}</td></tr>}
                {so.shippingForeign > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">Shipping</td><td className="px-3 py-1.5 text-right font-mono">{money(so.shippingForeign)}</td></tr>}
                {so.taxForeign > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">{so.taxRateName ?? 'Tax'}{so.taxRatePercent != null ? ` (${(so.taxRatePercent * 100).toFixed(0)}%)` : ''}</td><td className="px-3 py-1.5 text-right font-mono">{money(so.taxForeign)}</td></tr>}
                <tr className="border-t"><td colSpan={5} className="px-3 py-2 text-right font-medium">Total</td><td className="px-3 py-2 text-right font-mono font-semibold">{money(so.totalForeign)}{so.currency !== baseCurrency.code && <span className="text-muted-foreground font-normal text-xs ml-1">({baseMoney(so.totalBase)})</span>}</td></tr>
              </tfoot>
            </Table>

            {/* Refund credit notes */}
            {so.refunds.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Credit Notes</h3>
                {so.refunds.map((r) => (
                  <div key={r.id} className="rounded-md border p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {r.creditNoteNumber && <span className="font-mono text-xs font-medium">{r.creditNoteNumber}</span>}
                        <span className="text-muted-foreground text-xs">{formatDateTime(r.refundedAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                      <span className="font-mono font-medium text-destructive">-{money(r.totalForeign)}</span>
                    </div>
                    {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
                    {r.lines.map((rl) => (
                      <div key={rl.id} className="flex justify-between text-xs pl-3">
                        <span>{rl.description} x {rl.qty}</span>
                        <span className="font-mono text-destructive">-{baseMoney(rl.totalBase)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowInvoice(false)}>Close</Button>
            <Button variant="outline" onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
              <FileText className="h-4 w-4 mr-1" />PDF
            </Button>
            {so.customerEmail && (
              <Button variant="outline" onClick={handleEmailInvoice} disabled={isPending}>
                {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}Email
              </Button>
            )}
            {canRefund && (
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => { setShowInvoice(false); setShowRefund(true) }}>
                <Undo2 className="h-4 w-4 mr-1" />Credit / Refund
              </Button>
            )}
          </DialogFooter>
        </DialogContent></Dialog>
      )}
    </div>
  )
}
