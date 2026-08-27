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
  addPayment, deletePayment, reverseLedgerPayment, releaseWithdrawalHold,
  type SoDetail, type SoStatus,
} from '@/app/actions/sales'
import { sendSalesOrderEmail, sendInvoiceEmail } from '@/app/actions/email'
import {
  autoAllocateOrder, getOrderAllocations, getOrderShipments,
  deallocateOrder, confirmAllocations, updateAllocation, addAllocation,
  discardCancelledOrderShipments, reopenShipmentForRepackAction,
  updateShipmentStatus, updateShipmentTracking,
  type AllocationRow, type FulfillmentRequirementRow, type ShipmentRow,
} from '@/app/actions/allocation'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { RejectedAccountingDocumentUpdateWarning } from '@/lib/domain/accounting/rejected-sync-warnings'
import type { ProductType } from '@/app/generated/prisma/client'
import type { StockLevelEntry } from '@/lib/domain/inventory/stock-level-map'
import { isStockTrackedProductType } from '@/lib/domain/inventory/backorder-policy'
import { resolveSalesOrderDeleteBlock } from '@/lib/domain/sales/order-delete-affordance'
import { repackControlsFor } from '@/lib/domain/sales/repack-recovery-affordance'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { useStepUpReauth, isFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
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
  CANCELLED: 'Cancelled',
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
            <Label htmlFor="payment-amount">Amount ({currency}) *</Label>
            <Input id="payment-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payment-date">Date</Label>
            <Input id="payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="h-9" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payment-method">Method</Label>
          <select id="payment-method" value={method} onChange={(e) => setMethod(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
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
          <Label htmlFor="payment-reference">Reference / Transaction ID</Label>
          <Input id="payment-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payment-notes">Notes</Label>
          <Input id="payment-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="h-9" />
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

  // Find backordered lines (not fully allocated for remaining qty).
  //
  // o3d-4kfh: an OrderAllocation row covers its committed shipment lines as well as the
  // outstanding demand — dispatch retains the row, and the allocator rewrites it to cover the
  // commitments again. So the row quantity has to be netted by the SAME committed set that
  // `remaining` below is netted by, or a line whose allocation is entirely consumed by a picked
  // shipment reads as fully covered and its genuine backorder is never shown.
  const rawAllocatedByLine = calculateClientCoverageByLine(
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
    const allocated = Math.max(0, (rawAllocatedByLine.get(l.id) ?? 0) - committed)
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
          {/*
            o3d-0i5y r3: PICKING and PACKING are here because they are where a SHORT order is LEFT.
            Since r1 an order whose shipments all despatched while it still owed quantity is not
            promoted to SHIPPED — it keeps the pre-shipment status it had — and the warning it raises
            tells the operator to "allocate and ship the remainder". These two buttons ARE that
            remedy, so gating them to PROCESSING/ALLOCATED made the instruction impossible to follow
            from the very states the hold produces. The panel itself only renders when quantity is
            genuinely outstanding (see showAllocations), so this does not offer re-allocation on an
            order that is merely mid-pick and fully covered.
          */}
          {['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'].includes(status) && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleReAllocate} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              {allocations.length > 0 ? 'Re-Allocate' : 'Auto-Allocate'}
            </Button>
          )}
          {allocations.length > 0 && ['ALLOCATED', 'PICKING', 'PACKING'].includes(status) && (
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
  shipments, carriers, deliveryTrackingEnabled, orderId, orderStatus, onRefresh,
}: {
  shipments: ShipmentRow[]
  carriers: string[]
  deliveryTrackingEnabled: boolean
  orderId: string
  /** o3d-4kfh r6: a CANCELLED order gets the discard repair instead of the forward actions. */
  orderStatus: string
  onRefresh: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [shipDialogId, setShipDialogId] = useState<string | null>(null)
  const [editingShipmentId, setEditingShipmentId] = useState<string | null>(null)
  const [tracking, setTracking] = useState('')
  const [service, setService] = useState('')
  const [error, setError] = useState('')
  // o3d-2k5: the reopen can SUCCEED and still leave work outstanding (the re-allocation refused, or
  // did not complete). That is not an error and must not be shown as one — but it must be shown.
  const [warning, setWarning] = useState('')

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

  // o3d-2k5: the exit the packed-before-refund dispatch refusal names. Reverts the shipment to a
  // PENDING draft and re-nets the order's allocations, so the Stock Allocation panel's "Create
  // Shipments" button can rebuild it to what actually remains. That panel reappears because a
  // PENDING shipment is excluded from `committedByLine`, so the order reads as unfulfilled again. The units still have to come out of the box in the warehouse — the
  // confirmation says so, because nothing in the data can do that part.
  function handleReopenForRepack(shipmentId: string, status: string) {
    if (!window.confirm(
      `This shipment is ${SHIPMENT_STATUS_LABELS[status] ?? status.toLowerCase()} — the goods have been picked`
      + `${status === 'PACKED' ? ' and packed' : ''} in the warehouse.\n\n`
      + 'Reopening turns it back into a pending draft and re-nets the order against refunds, so it can be '
      + 'rebuilt to what remains. Any tracking number is kept on the draft.\n\n'
      + 'Physically unpack the parcel before rebuilding. Continue?',
    )) return
    setError('')
    setWarning('')
    startTransition(async () => {
      const result = await reopenShipmentForRepackAction(shipmentId)
      if (!result.success) { setError(result.error ?? 'Failed'); return }
      if (result.warning) setWarning(result.warning)
      onRefresh()
    })
  }

  /**
   * o3d-2k5r r4 — the RESUME, which the action already implemented and no control could reach.
   *
   * Same action, deliberately: it treats an already-pending draft as a resume point and runs the
   * re-allocation and refund-backstop resolution against it. Nothing is reverted here and nothing
   * physical is implied, so the confirmation says what is actually about to happen rather than
   * repeating the reopen's "unpack the parcel first".
   */
  function handleFinishRepackRecovery(shipmentId: string) {
    if (!window.confirm(
      'This order was left part-way through a repack recovery: the shipment was reopened, but the '
      + 'order was never re-netted against the refund and the refunded units are still reserved.\n\n'
      + 'Finishing it re-nets the order and releases that reservation. Nothing is unpacked and no '
      + 'shipment is changed — rebuild the draft with "Create Shipments" afterwards.\n\nContinue?',
    )) return
    setError('')
    setWarning('')
    startTransition(async () => {
      const result = await reopenShipmentForRepackAction(shipmentId)
      if (!result.success) { setError(result.error ?? 'Failed'); return }
      if (result.warning) setWarning(result.warning)
      onRefresh()
    })
  }

  // o3d-4kfh r6 (finding 4): the exit the component-graph refusal names. Dispatching a cancelled
  // order's shipment is refused (it would ship goods for a cancelled sale) and CANCELLED has no
  // transition to CANCELLED, so before this there was no way to clear the blocker at all.
  function handleDiscardCancelledShipments() {
    setError('')
    startTransition(async () => {
      const result = await discardCancelledOrderShipments(orderId)
      if (result.success) onRefresh()
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

  const isCancelledOrder = orderStatus === 'CANCELLED'
  const discardableCount = isCancelledOrder
    ? shipments.filter((shipment) => shipment.status !== 'SHIPPED').length
    : 0

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {warning && (
        <p className="text-sm text-amber-700 dark:text-amber-400 rounded-md border border-amber-300 dark:border-amber-800 px-3 py-2">
          {warning}
        </p>
      )}
      {discardableCount > 0 && (
        <div className="rounded-md border border-destructive/40 px-4 py-2 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            This order is cancelled but still has {discardableCount} non-dispatched shipment(s). They
            cannot be picked, packed or dispatched, and they block component-graph edits for the
            products on this order. Discarding deletes them; already-dispatched shipments are kept
            (reverse those with a refund).
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive shrink-0"
            onClick={handleDiscardCancelledShipments}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Discard shipments
          </Button>
        </div>
      )}
      {shipments.map((s) => {
        // A cancelled order's shipments have no forward action: the transition is refused server-side.
        const nextAction = isCancelledOrder ? undefined : SHIPMENT_FLOW[s.status]
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
{/* o3d-2k5 / o3d-2k5r r4: which control renders in which state is decided by
                    repack-recovery-affordance.ts, not by conditions written out here — that is the
                    thing that was wrong (the resume point had no control at all) and it has to be
                    assertable without a browser. Reopen acts on a COMMITTED shipment; Finish repack
                    recovery acts on a DRAFT whose order still owes the recovery's netting and refund
                    backstop. They are mutually exclusive by construction. */}
                {(() => {
                  const controls = repackControlsFor({
                    shipmentStatus: s.status,
                    orderStatus: orderStatus,
                    recoveryOutstanding: s.repackRecoveryOutstanding,
                    orderHasCommittedShipment: s.orderHasCommittedShipment,
                  })
                  return (
                    <>
                      {controls.includes('reopen') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleReopenForRepack(s.id, s.status)}
                          disabled={isPending}
                        >
                          {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                          Reopen for repack
                        </Button>
                      )}
                      {controls.includes('finish-recovery') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleFinishRepackRecovery(s.id)}
                          disabled={isPending}
                        >
                          {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                          Finish repack recovery
                        </Button>
                      )}
                    </>
                  )
                })()}
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
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  /**
   * o3d-1vuv: a refusal from deletePayment, shown NEXT TO the receipt it refused rather than in the
   * page-level error line far above the payments block. A refusal whose remedy is a button is
   * useless if the operator cannot see both at once — and until this change the result of
   * deletePayment was DISCARDED entirely, so the refusal would not have appeared anywhere at all.
   */
  const [paymentRefusal, setPaymentRefusal] = useState<{ paymentId: string; message: string; code?: string } | null>(null)
  // o3d-1vuv: the payment reference an operator read off the invoice in the accounting system, for a
  // registration that failed without recording one. IMS asks about THAT payment; it does not take the
  // typing of it as a claim that anything was reversed.
  const [assertedPaymentReference, setAssertedPaymentReference] = useState('')
  // WHICH receipt is being resolved this way, held separately from the refusal CODE on purpose: the
  // code changes with every answer the ledger gives ("that payment is on another invoice", "it is
  // still AUTHORISED"), and a field that vanished on the first correctable mistake would put the
  // operator straight back into the dead end this whole path exists to remove.
  const [undecidedAttempt, setUndecidedAttempt] = useState<string | null>(null)
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
  // o3d-0zy: predict the o3d-5r8 delete refusal instead of letting the operator walk into it. Every
  // non-draft order queues a sales invoice, so with accounting sync on, Delete on a PENDING_PAYMENT
  // order always refuses and Cancel is the actual path. Disabled-with-a-reason rather than hidden:
  // other blockers (WMS push link, daily batch, refunds) are still only known to the server.
  const deleteBlock = resolveSalesOrderDeleteBlock({
    status: so.status,
    accountingInvoiceId: so.accountingInvoiceId ?? null,
    accountingSyncEnabled,
  })
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

  // Show allocation panel when PROCESSING/ALLOCATED/PICKING/PACKING AND (no shipments OR unfulfilled
  // lines remain).
  //
  // o3d-0i5y r3: PICKING/PACKING were added because they are the states a SHORT order is HELD in.
  // The whole panel was hidden there, so an order that despatched everything raised against it while
  // still owing quantity had no allocate button, no create-shipments button and no route forward at
  // all — the r1 warning told the operator to ship the remainder from a screen that did not exist.
  // `hasUnfulfilledLines` is what keeps this narrow: an order simply being picked, with every line
  // covered by a committed shipment, shows nothing new.
  const showAllocations = ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'].includes(so.status) && (!hasShipments || hasUnfulfilledLines)
  // o3d-4kfh r6 (Codex finding 4): CANCELLED is in the list too, but ONLY so the operator can see
  // and discard shipments that are still sitting on a cancelled order. A cancelled order normally
  // has none — `cancelSalesOrderFulfillmentState` deletes them in the same transaction as the
  // cancel — but if one is there it blocks component-graph edits, it can no longer be advanced or
  // dispatched, and hiding it left the refusal naming a repair the operator could not reach.
  const showShipments = ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'].includes(so.status) && hasShipments

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
    // Belt and braces with the disabled button: the server refuses anyway, but there is no reason to
    // send a request whose answer we already have.
    if (deleteBlock) { setError(deleteBlock.reason); return }
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

  // GREEN MEANS THE LEDGER AGREES (o3d-lgo.15). Everything above is IMS's own view of the money: a
  // "Paid" badge said only that IMS was told it arrived. Registering the receipt against the accounting
  // invoice is a separate sync that can fail, be cancelled, or never be queued at all — and this badge
  // was an unconditional green over all three, so IMS claimed a settlement the ledger had no record of
  // and nothing anywhere said so.
  const settlement = so.settlement
  const settlementSuffix =
    settlement.status === 'AWAITING_LEDGER' ? ' · awaiting ledger'
    : settlement.status === 'LEDGER_REJECTED' ? ' · LEDGER REJECTED'
    : settlement.status === 'NOT_SENT' ? ' · NOT SENT TO LEDGER'
    : settlement.status === 'PARTIALLY_SETTLED' ? ' · PART PAID IN LEDGER'
    : settlement.status === 'LEDGER_UNMATCHED' ? ' · PAID IN LEDGER ONLY'
    // Not "rejected" and not "not sent": an attempt was made and what the ledger did with it was
    // never recorded. Naming it as either of the other two sends someone to the wrong place.
    : settlement.status === 'LEDGER_UNDECIDED' ? ' · LEDGER OUTCOME UNKNOWN'
    : settlement.status === 'OVER_SETTLED' ? ' · OVER-PAID IN LEDGER'
    // o3d-nf9i r3: an operator's assertion is not the ledger's word. Shown as its own state so the
    // badge never reads the same as a confirmed settlement.
    : settlement.status === 'ASSERTED_UNVERIFIED' ? ' · ASSERTED, NOT VERIFIED'
    : ''
  // Neither badge above can speak for an order with no local payment rows, so the verdict needs its own
  // chip whenever there is something to say: a disagreement, or a payment still on its way.
  const standaloneSettlement =
    !isPaid && !isPartiallyPaid && (settlement.discrepancy || settlement.status === 'AWAITING_LEDGER')
  const settlementTone =
    settlement.discrepancy
      ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200'
      : settlement.status === 'AWAITING_LEDGER'
      ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200'
      : 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200'

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
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-medium ${settlementTone}`}
            title={settlement.detail}
          >
            {settlement.discrepancy && <AlertTriangle className="h-3.5 w-3.5" />}
            Paid{settlementSuffix}
          </span>
        )}
        {isPartiallyPaid && (
          <span
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-medium bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200"
            title={settlement.detail}
          >
            {settlement.discrepancy && <AlertTriangle className="h-3.5 w-3.5" />}
            Part. Paid{settlementSuffix}
          </span>
        )}
        {standaloneSettlement && (
          /*
            THE VERDICT WHEN NEITHER BADGE ABOVE RENDERS. Both are derived from LOCAL payment rows, and an
            imported paid order has none — WooCommerce sets paidAt and the receipt is registered straight
            from the invoice follow-up. So the most common paid order in the system showed no badge, and
            with it no settlement state: a rejected or unsent payment on exactly those orders would have
            been invisible, which is the thing this whole change exists to prevent (Codex, PR #582 round 7).
            LEDGER_UNMATCHED lands here too — nothing is paid locally, by definition.
          */
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-medium ${settlementTone}`}
            title={settlement.detail}
          >
            {settlement.discrepancy && <AlertTriangle className="h-3.5 w-3.5" />}
            {settlement.status === 'LEDGER_UNMATCHED' ? 'PAID IN LEDGER ONLY'
              // NOT prefixed "Paid": nothing here is paid, and the whole point of the state is that
              // nobody can say what the ledger holds.
              : settlement.status === 'LEDGER_UNDECIDED' ? 'LEDGER OUTCOME UNKNOWN'
              : `Paid${settlementSuffix}`}
          </span>
        )}

        {/* o3d-e1yb [wdraw]: a hold placed by an EU withdrawal request. It blocks
            the inbound storefront status sync AND the WMS release pass, so
            without this control the order stays held forever once the customer's
            request is rejected. Deliberately an operator decision: releasing
            re-pushes the goods to the warehouse. */}
        {so.withdrawalHoldAt && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm font-medium text-amber-700 dark:text-amber-400"
            title={`The customer filed an EU right-of-withdrawal request on ${new Date(so.withdrawalHoldAt).toLocaleString()}. This order will not be sent to or released back to the warehouse until the hold is released.`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Withdrawal hold
          </span>
        )}

        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {/* Withdrawal hold release — before the workflow actions, because
              while it is set the workflow cannot move the order anyway. */}
          {so.withdrawalHoldAt && hasPermission(currentUserRole, 'sales.process') && (
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => {
                if (!confirm(
                  'Release the withdrawal hold?\n\n'
                  + 'Only do this if the customer\u2019s withdrawal request was rejected or resolved. '
                  + 'The order stays On Hold; moving it back to Processing then re-sends it to the warehouse.',
                )) return
                setError('')
                startTransition(async () => {
                  // The request THIS PAGE showed, so a newer withdrawal filed since it was drawn is
                  // refused rather than silently cleared (o3d-rbyg r4).
                  const res = await releaseWithdrawalHold(so.id, { generation: so.withdrawalHoldGeneration })
                  if (!res.success) { setError(res.error ?? 'Could not release the withdrawal hold'); return }
                  router.refresh()
                })
              }}
            >
              Release withdrawal hold
            </Button>
          )}

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
            // The title lives on the wrapper, not the button: a disabled button swallows pointer
            // events in several browsers and would never show its own tooltip.
            <span title={deleteBlock?.reason} className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
                disabled={isPending || deleteBlock !== null}
              >
                <Trash2 className="h-4 w-4 mr-1" />Delete
              </Button>
            </span>
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
      {/* o3d-1vuv: reverseLedgerPayment takes a FRESH session, so the step-up prompt has to be mounted. */}
      {stepUpDialog}

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
          orderId={so.id}
          orderStatus={so.status}
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
              {isPaid && <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${settlementTone}`} title={settlement.detail}>{settlement.discrepancy && <AlertTriangle className="h-3 w-3" />}Paid{settlementSuffix}</span>}
              {isPartiallyPaid && <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200" title={settlement.detail}>{settlement.discrepancy && <AlertTriangle className="h-3 w-3" />}Part. Paid{settlementSuffix}</span>}
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
          {settlement.discrepancy && (
            /* The whole point: say what the LEDGER thinks, in words someone can act on. The Balance
               figure below is IMS's own arithmetic and will happily read "Settled" while the accounting
               invoice is still outstanding — that gap is exactly what this line names. */
            <p className="px-4 pt-2 text-[11px] text-red-700 dark:text-red-300">{settlement.detail}</p>
          )}
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
                  <div key={p.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{formatDateTime(p.paidAt, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                        {p.method && <span className="text-muted-foreground">{p.method}</span>}
                        {p.reference && <span className="font-mono text-muted-foreground">{p.reference}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{money(p.amount)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (!confirm('Delete this payment?')) return
                            setPaymentRefusal(null)
                            setUndecidedAttempt(null)
                            startTransition(async () => {
                              // o3d-1vuv: the result used to be DISCARDED, so a refusal — and before
                              // this change, the "reverse this in the ledger by hand" warning — reached
                              // nobody. It is now shown against the receipt it refused.
                              const result = await deletePayment(p.id, so.id)
                              if (result.success) { router.refresh(); return }
                              setPaymentRefusal({ paymentId: p.id, message: result.error ?? 'Failed to delete the payment.', code: result.code })
                              setUndecidedAttempt(result.code === 'registration_attempt_undecided' ? p.id : null)
                            })
                          }}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    {paymentRefusal?.paymentId === p.id && (
                      <div className="rounded border border-destructive/40 bg-destructive/5 p-2 space-y-2">
                        <p className="text-xs text-destructive whitespace-pre-line">{paymentRefusal.message}</p>
                        {paymentRefusal.code === 'ledger_holds_payment' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs"
                            disabled={isPending}
                            onClick={() => startTransition(async () => {
                              // IMS asks the accounting system whether the payment is really gone; it
                              // does NOT take this click as a claim that it is. A refusal here names
                              // what the ledger actually said.
                              const run = () => reverseLedgerPayment(p.id, so.id)
                              let result = await run()
                              if (isFreshAuthFailure(result) && await promptReauth()) result = await run()
                              if (isFreshAuthFailure(result)) {
                                setPaymentRefusal({ paymentId: p.id, message: 'Sign in again to confirm a ledger reversal.' })
                                return
                              }
                              if (result.success) { setPaymentRefusal(null); router.refresh(); return }
                              setPaymentRefusal({ paymentId: p.id, message: result.error, code: result.code })
                            })}
                          >
                            {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Undo2 className="h-3 w-3 mr-1" />}
                            I have reversed it — check and delete
                          </Button>
                        )}
                        {undecidedAttempt === p.id && (
                          /*
                            THE UNDECIDED ATTEMPT'S WAY OUT. Round 1 showed no control here at all,
                            on the grounds that there is nothing to check — true of IMS acting alone,
                            and it left the "a payment IS there" half of the remedy walking back into
                            this same refusal. The missing fact is WHICH payment, and the operator is
                            looking at it. So they may name it, and naming it decides nothing: IMS
                            asks the accounting system about that payment and requires it to be on
                            this invoice, on an invoice in this receipt's own currency — an amount in
                            another currency is a different quantity of a different thing — for
                            exactly this amount, and gone; and requires that no payment for that same
                            amount is still standing on the invoice, since the amount cannot tell two
                            of them apart. No reference, no button.
                          */
                          <div className="space-y-2">
                            <label className="block text-[11px] text-muted-foreground" htmlFor={`asserted-ref-${p.id}`}>
                              Payment reference from the accounting system (the payment you reversed on this invoice)
                            </label>
                            <input
                              id={`asserted-ref-${p.id}`}
                              type="text"
                              value={assertedPaymentReference}
                              onChange={(e) => setAssertedPaymentReference(e.target.value)}
                              placeholder="e.g. 2f1c9b3e-0d4a-4e7b-9c2f-8a6d5e4b3c21"
                              className="w-full rounded border bg-background px-2 py-1 text-xs font-mono"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs"
                              disabled={isPending || assertedPaymentReference.trim().length === 0}
                              onClick={() => startTransition(async () => {
                                const reference = assertedPaymentReference.trim()
                                const run = () => reverseLedgerPayment(p.id, so.id, reference)
                                let result = await run()
                                if (isFreshAuthFailure(result) && await promptReauth()) result = await run()
                                if (isFreshAuthFailure(result)) {
                                  setPaymentRefusal({ paymentId: p.id, message: 'Sign in again to confirm a ledger reversal.', code: paymentRefusal.code })
                                  return
                                }
                                if (result.success) {
                                  setPaymentRefusal(null)
                                  setAssertedPaymentReference('')
                                  setUndecidedAttempt(null)
                                  router.refresh()
                                  return
                                }
                                // The refusal is REPLACED by whatever the ledger said — "that payment
                                // is on another invoice", "it is still AUTHORISED" — and the field is
                                // kept, because the next thing the operator does is correct it.
                                setPaymentRefusal({ paymentId: p.id, message: result.error, code: result.code })
                              })}
                            >
                              {isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Undo2 className="h-3 w-3 mr-1" />}
                              Check that payment and delete
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
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
                        <button
                          type="button"
                          onClick={() => {
                            if (!confirm('Delete?')) return
                            setError('')
                            startTransition(async () => {
                              // A credit-note receipt settles a CREDIT NOTE, not this invoice, so it
                              // has no INVOICE_PAYMENT registration and never hits the ledger-hold
                              // refusal. It can still fail, and the failure used to be discarded.
                              const result = await deletePayment(p.id, so.id)
                              if (result.success) { router.refresh(); return }
                              setError(result.error ?? 'Failed to delete the payment.')
                            })
                          }}
                          className="text-muted-foreground hover:text-destructive"
                        ><Trash2 className="h-3 w-3" /></button>
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
                <p className="font-medium">
                  {isPaid ? 'Paid' : isPartiallyPaid ? 'Partially Paid' : 'Unpaid'}
                  {settlementSuffix}
                </p>
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
