'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Package, Truck, PackageCheck, Ban, Undo2, ChevronDown, ChevronRight, Loader2, FileText, Mail, Copy, Trash2, ExternalLink, CreditCard, Pencil, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  updateSalesOrderStatus, createRefund, cloneSalesOrder, deleteSalesOrder,
  markSalesOrderPaid, updateSalesOrderNotes, generateInvoiceNumber,
  addPayment, deletePayment,
  type SoDetail, type SoStatus, type PaymentRow,
} from '@/app/actions/sales'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { StockLevelEntry } from '@/app/actions/stock'
import { ProductLink } from '@/components/inventory/product-link'

type Warehouse = { id: string; code: string; name: string }
type Props = { order: SoDetail; warehouses: Warehouse[]; currencies: CurrencyRow[]; wcUrl?: string; stockLevels: Record<string, Record<string, StockLevelEntry>> }

const STATUS_LABELS: Record<SoStatus, string> = {
  PENDING: 'Pending', PROCESSING: 'Processing', PICKING: 'Picking', PACKED: 'Packed',
  SHIPPED: 'Shipped', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Part. Refunded', ON_HOLD: 'On Hold',
}
const STATUS_CLASS: Record<SoStatus, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  PROCESSING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PICKING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  PACKED: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200',
  COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  CANCELLED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  REFUNDED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
  ON_HOLD: 'bg-muted text-muted-foreground border-muted',
}
const STATUS_FLOW: Record<string, { label: string; icon: typeof Truck; target: SoStatus }[]> = {
  PENDING: [{ label: 'Process', icon: Package, target: 'PROCESSING' }],
  PROCESSING: [{ label: 'Start Picking', icon: Package, target: 'PICKING' }],
  PICKING: [{ label: 'Mark Packed', icon: PackageCheck, target: 'PACKED' }],
  PACKED: [{ label: 'Ship', icon: Truck, target: 'SHIPPED' }],
  SHIPPED: [{ label: 'Complete', icon: PackageCheck, target: 'COMPLETED' }],
}

// Optional columns for the line items table
type OptCol = 'cogs' | 'margin' | 'marginPct' | 'qtyOnHand' | 'qtyReturned' | 'qtyCancelled' | 'qtyShipped'
const OPT_COLUMNS: { key: OptCol; label: string }[] = [
  { key: 'cogs', label: 'COGS (£)' },
  { key: 'margin', label: 'Margin (£)' },
  { key: 'marginPct', label: 'Margin %' },
  { key: 'qtyOnHand', label: 'Qty on Hand' },
  { key: 'qtyReturned', label: 'Qty Returned' },
  { key: 'qtyCancelled', label: 'Qty Cancelled' },
  { key: 'qtyShipped', label: 'Qty Shipped' },
]

// ---------------------------------------------------------------------------
// Ship dialog
// ---------------------------------------------------------------------------
function ShipDialog({ order, warehouses, onClose }: { order: SoDetail; warehouses: Warehouse[]; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [tracking, setTracking] = useState('')
  const [whId, setWhId] = useState(order.shipFromWarehouseId ?? warehouses[0]?.id ?? '')
  const [error, setError] = useState('')
  function handleShip() {
    setError('')
    if (!whId) { setError('Select a warehouse'); return }
    startTransition(async () => {
      const result = await updateSalesOrderStatus(order.id, 'SHIPPED', { trackingNumber: tracking || undefined, shipFromWarehouseId: whId })
      if (result.success) { router.refresh(); onClose() } else setError(result.error ?? 'Failed')
    })
  }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
      <DialogHeader><DialogTitle>Ship Order</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5"><Label>Ship From Warehouse *</Label>
          <select value={whId} onChange={(e) => setWhId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
            {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
          </select></div>
        <div className="space-y-1.5"><Label>Tracking Number</Label>
          <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Optional" className="h-9 text-sm" /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleShip} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm Shipment</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  )
}

// ---------------------------------------------------------------------------
// Refund dialog
// ---------------------------------------------------------------------------
function RefundDialog({ order, warehouses, sym, onClose }: { order: SoDetail; warehouses: Warehouse[]; sym: string; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [returnWhId, setReturnWhId] = useState(warehouses[0]?.id ?? '')
  const [refundLines, setRefundLines] = useState(order.lines.map((l) => ({ ...l, qtyRefund: 0, refundAmount: 0 })))
  const [error, setError] = useState('')
  const totalRefund = refundLines.reduce((s, l) => s + l.refundAmount, 0)
  function handleConfirm() {
    setError('')
    const toRefund = refundLines.filter((l) => l.qtyRefund > 0)
    if (!toRefund.length) { setError('Select at least one line'); return }
    if (!reason.trim()) { setError('Reason is required'); return }
    startTransition(async () => {
      const result = await createRefund(order.id, toRefund.map((l) => ({ productId: l.productId, description: l.description, qty: l.qtyRefund, totalGbp: l.refundAmount / (order.fxRateToGbp || 1) })), reason, returnWhId || undefined)
      if (result.success) { router.refresh(); onClose() } else setError(result.error ?? 'Failed')
    })
  }
  return (
    <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Process Refund</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Reason *</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer request" className="h-9 text-sm" /></div>
          <div className="space-y-1.5"><Label>Return to Warehouse</Label>
            <select value={returnWhId} onChange={(e) => setReturnWhId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No stock return</option>
              {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.code} — {w.name}</option>))}
            </select></div>
        </div>
        <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="border-b bg-muted/50"><tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Ordered</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Refund Qty</th>
          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-28">Amount ({sym})</th>
        </tr></thead><tbody className="divide-y">
          {refundLines.map((l) => (<tr key={l.id}>
            <td className="px-3 py-2">{l.productId ? <ProductLink productId={l.productId} sku={l.sku} name={l.description} /> : l.description}</td>
            <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
            <td className="px-3 py-2"><Input type="number" min={0} max={l.qty} step={1} value={l.qtyRefund} onChange={(e) => { const q = Number(e.target.value) || 0; setRefundLines((p) => p.map((rl) => rl.id === l.id ? { ...rl, qtyRefund: q, refundAmount: q * l.unitPriceForeign } : rl)) }} className="h-7 text-sm text-right w-24 ml-auto font-mono" /></td>
            <td className="px-3 py-2 text-right font-mono text-xs">{l.refundAmount.toFixed(2)}{sym}</td>
          </tr>))}
        </tbody></table></div>
        <div className="flex justify-end text-sm font-medium">Total: {totalRefund.toFixed(2)}{sym}</div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button onClick={handleConfirm} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm Refund</Button>
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
function PaymentDialog({ orderId, refundId, creditNoteNumber, currency, onClose }: { orderId: string; refundId?: string; creditNoteNumber?: string; currency: string; onClose: () => void }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [amount, setAmount] = useState('')
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
        <div className="grid grid-cols-2 gap-3">
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
// Main detail
// ---------------------------------------------------------------------------
export function SoDetailClient({ order: so, warehouses, currencies, wcUrl, stockLevels }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showShip, setShowShip] = useState(false)
  const [showRefund, setShowRefund] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [showRefunds, setShowRefunds] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [showPayment, setShowPayment] = useState<{ refundId?: string; creditNoteNumber?: string } | null>(null)
  const [visibleCols, setVisibleCols] = useState<Set<OptCol>>(new Set())
  const [error, setError] = useState('')

  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const sym = symbolMap[so.currency] ?? so.currency

  const nextActions = STATUS_FLOW[so.status] ?? []
  const canCancel = ['PENDING', 'PROCESSING', 'PICKING', 'PACKED', 'ON_HOLD'].includes(so.status)
  const canDelete = so.status === 'PENDING'
  const canRefund = ['SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED'].includes(so.status)

  function handleStatusChange(target: SoStatus) {
    if (target === 'SHIPPED') { setShowShip(true); return }
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

  function handleMarkPaid() {
    startTransition(async () => {
      const result = await markSalesOrderPaid(so.id)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleGenerateInvoice() {
    startTransition(async () => {
      const result = await generateInvoiceNumber(so.id)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function toggleCol(col: OptCol) {
    setVisibleCols((prev) => { const n = new Set(prev); n.has(col) ? n.delete(col) : n.add(col); return n })
  }

  function getMailtoLink() {
    if (!so.customerEmail) return null
    const subject = encodeURIComponent(`Order ${so.wcOrderNumber ?? so.id.slice(0, 8)}`)
    const body = encodeURIComponent(`Dear ${so.customerName ?? 'Customer'},\n\nPlease find attached your order confirmation.\n\nKind regards`)
    return `mailto:${so.customerEmail}?subject=${subject}&body=${body}`
  }

  function getInvoiceMailtoLink() {
    if (!so.customerEmail || !so.invoiceNumber) return null
    const subject = encodeURIComponent(`Invoice ${so.invoiceNumber}`)
    const body = encodeURIComponent(`Dear ${so.customerName ?? 'Customer'},\n\nPlease find attached your invoice ${so.invoiceNumber}.\n\nKind regards`)
    return `mailto:${so.customerEmail}?subject=${subject}&body=${body}`
  }

  // COGS per line (approximate from totalGbp)
  const fxRate = so.fxRateToGbp || 1

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Status + Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_CLASS[so.status]}`}>
          {STATUS_LABELS[so.status]}
        </span>
        {so.paidAt && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200">
            Paid
          </span>
        )}
        {so.invoiceNumber && (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200">
            {so.invoiceNumber}
          </span>
        )}

        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {/* PDF & Email */}
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/sales-order/${so.id}`, '_blank')}>
            <FileText className="h-4 w-4 mr-1" />Order PDF
          </Button>
          {so.invoiceNumber && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
              <FileText className="h-4 w-4 mr-1" />Invoice PDF
            </Button>
          )}
          {so.customerEmail && (
            <Button variant="outline" size="sm" onClick={() => { const l = getMailtoLink(); if (l) window.location.href = l }}>
              <Mail className="h-4 w-4 mr-1" />Email
            </Button>
          )}
          {so.invoiceNumber && so.customerEmail && (
            <Button variant="outline" size="sm" onClick={() => { const l = getInvoiceMailtoLink(); if (l) window.location.href = l }}>
              <Mail className="h-4 w-4 mr-1" />Email Invoice
            </Button>
          )}

          <span className="w-px h-5 bg-border mx-0.5" />

          {/* Workflow */}
          {nextActions.map((a) => (
            <Button key={a.target} size="sm" onClick={() => handleStatusChange(a.target)} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <a.icon className="h-4 w-4 mr-1" />}
              {a.label}
            </Button>
          ))}

          {/* Mark Paid */}
          <Button variant="outline" size="sm" onClick={handleMarkPaid} disabled={isPending}>
            <CreditCard className="h-4 w-4 mr-1" />{so.paidAt ? 'Unpaid' : 'Mark Paid'}
          </Button>

          {/* Invoice */}
          {!so.invoiceNumber && (
            <Button variant="outline" size="sm" onClick={handleGenerateInvoice} disabled={isPending}>
              <FileText className="h-4 w-4 mr-1" />Generate Invoice
            </Button>
          )}

          {canRefund && (
            <Button variant="outline" size="sm" onClick={() => setShowRefund(true)} disabled={isPending}>
              <Undo2 className="h-4 w-4 mr-1" />Refund
            </Button>
          )}

          <span className="w-px h-5 bg-border mx-0.5" />

          {/* Clone / Notes / Delete / WC */}
          <Button variant="outline" size="sm" onClick={handleClone} disabled={isPending}>
            <Copy className="h-4 w-4 mr-1" />Clone
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowNotes(true)}>
            <Pencil className="h-4 w-4 mr-1" />Notes
          </Button>
          {so.wcOrderId && wcUrl && (
            <Button variant="outline" size="sm" onClick={() => window.open(`${wcUrl}/wp-admin/post.php?post=${so.wcOrderId}&action=edit`, '_blank')}>
              <ExternalLink className="h-4 w-4 mr-1" />WooCommerce
            </Button>
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
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Header info */}
      <div className="rounded-md border p-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">Customer</span>
          <p className="font-medium">{so.customerName ?? '—'}</p>
          {so.customerEmail && <p className="text-xs text-muted-foreground">{so.customerEmail}</p>}
        </div>
        <div>
          <span className="text-muted-foreground">Shipping Address</span>
          {so.shippingAddress ? (
            <p className="text-xs mt-0.5">{(() => { const a = so.shippingAddress as Record<string, string>; return [a.line1, a.line2, a.city, a.county, a.postcode, a.country].filter(Boolean).join(', ') || '—' })()}</p>
          ) : <p className="text-muted-foreground">—</p>}
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
        {so.expectedDelivery && <div><span className="text-muted-foreground">Expected Delivery</span><p className="font-medium">{new Date(so.expectedDelivery).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>}
        {so.salesRep && <div><span className="text-muted-foreground">Sales Rep</span><p className="font-medium">{so.salesRep}</p></div>}
        {so.trackingNumber && <div><span className="text-muted-foreground">Tracking</span><p className="font-medium font-mono text-xs">{so.trackingNumber}</p></div>}
        {so.shippedAt && <div><span className="text-muted-foreground">Shipped</span><p className="font-medium">{new Date(so.shippedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>}
        {so.notes && <div className="col-span-2"><span className="text-muted-foreground">Customer Notes</span><p className="mt-0.5 whitespace-pre-wrap">{so.notes}</p></div>}
        {so.internalNotes && <div className="col-span-2"><span className="text-muted-foreground">Private Notes</span><p className="mt-0.5 whitespace-pre-wrap text-muted-foreground italic">{so.internalNotes}</p></div>}
      </div>

      {/* Lines table */}
      <div className="rounded-md border overflow-hidden">
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
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/30">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">Qty</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-28">Unit Price ({sym})</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-24">Discount</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-28">Total ({sym})</th>
              {visibleCols.has('cogs') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-20">COGS (£)</th>}
              {visibleCols.has('margin') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-20">Margin (£)</th>}
              {visibleCols.has('marginPct') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">Margin %</th>}
              {visibleCols.has('qtyShipped') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">Shipped</th>}
              {visibleCols.has('qtyReturned') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">Returned</th>}
              {visibleCols.has('qtyCancelled') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">Cancelled</th>}
              {visibleCols.has('qtyOnHand') && <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-16">On Hand</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {so.lines.map((line) => {
              const cogs = line.cogsGbp ?? 0
              const revenueGbp = line.totalGbp
              const margin = revenueGbp - cogs
              const marginPct = revenueGbp > 0 ? (margin / revenueGbp) * 100 : 0
              const shipped = ['SHIPPED', 'COMPLETED'].includes(so.status) ? line.qty : 0
              const cancelled = so.status === 'CANCELLED' ? line.qty : 0
              const returned = so.refunds?.reduce((s, r) => s + r.lines.filter((rl) => rl.productId === line.productId).reduce((s2, rl) => s2 + rl.qty, 0), 0) ?? 0
              return (
                <tr key={line.id}>
                  <td className="px-4 py-2">{line.productId ? <ProductLink productId={line.productId} sku={line.sku} name={line.description} /> : <span className="text-sm">{line.description}</span>}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{line.qty}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{line.unitPriceForeign.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-xs text-destructive">{line.discountAmount > 0 ? (line.discountStr ?? `-${line.discountAmount.toFixed(2)}`) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{line.totalForeign.toFixed(2)}{sym}</td>
                  {visibleCols.has('cogs') && <td className="px-4 py-2 text-right tabular-nums font-mono text-xs text-muted-foreground">{cogs > 0 ? `£${cogs.toFixed(2)}` : '—'}</td>}
                  {visibleCols.has('margin') && <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{cogs > 0 ? `£${margin.toFixed(2)}` : '—'}</td>}
                  {visibleCols.has('marginPct') && <td className="px-4 py-2 text-right tabular-nums text-xs">{cogs > 0 ? `${marginPct.toFixed(1)}%` : '—'}</td>}
                  {visibleCols.has('qtyShipped') && <td className="px-4 py-2 text-right tabular-nums text-xs">{shipped > 0 ? shipped : '—'}</td>}
                  {visibleCols.has('qtyReturned') && <td className="px-4 py-2 text-right tabular-nums text-xs text-orange-600">{returned > 0 ? returned : '—'}</td>}
                  {visibleCols.has('qtyCancelled') && <td className="px-4 py-2 text-right tabular-nums text-xs text-destructive">{cancelled > 0 ? cancelled : '—'}</td>}
                  {visibleCols.has('qtyOnHand') && (() => {
                if (!line.productId) return <td className="px-4 py-2 text-right text-xs text-muted-foreground">—</td>
                const whId = so.shipFromWarehouseId
                if (whId) {
                  const entry = stockLevels[line.productId]?.[whId]
                  const avail = entry ? entry.available : 0
                  return <td className={`px-4 py-2 text-right tabular-nums text-xs ${avail < line.qty ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>{avail}</td>
                }
                // No warehouse selected — show total across all
                const entries = stockLevels[line.productId] ?? {}
                const total = Object.values(entries).reduce((s, e) => s + e.available, 0)
                return <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{total}</td>
              })()}
                </tr>
              )
            })}
          </tbody>
          <tfoot className="border-t bg-muted/30 text-sm">
            <tr><td colSpan={4} className="px-4 py-1.5 text-right text-muted-foreground">Subtotal</td><td className="px-4 py-1.5 text-right tabular-nums font-mono">{so.subtotalForeign.toFixed(2)}{sym}</td></tr>
            {so.discountAmount > 0 && <tr><td colSpan={4} className="px-4 py-1.5 text-right text-destructive">Order Discount{so.discountStr ? ` (${so.discountStr})` : ''}</td><td className="px-4 py-1.5 text-right tabular-nums font-mono text-destructive">-{so.discountAmount.toFixed(2)}{sym}</td></tr>}
            {so.shippingForeign > 0 && <tr><td colSpan={4} className="px-4 py-1.5 text-right text-muted-foreground">Shipping{so.shippingService ? ` (${so.shippingService})` : ''}</td><td className="px-4 py-1.5 text-right tabular-nums font-mono">{so.shippingForeign.toFixed(2)}{sym}</td></tr>}
            {so.taxForeign > 0 && <tr><td colSpan={4} className="px-4 py-1.5 text-right text-muted-foreground">{so.taxRateName ?? 'Tax'}{so.taxRatePercent != null ? ` (${(so.taxRatePercent * 100).toFixed(0)}%)` : ''}</td><td className="px-4 py-1.5 text-right tabular-nums font-mono">{so.taxForeign.toFixed(2)}{sym}</td></tr>}
            <tr className="border-t"><td colSpan={4} className="px-4 py-2 text-right font-medium text-muted-foreground">Total</td><td className="px-4 py-2 text-right tabular-nums font-mono"><span className="font-semibold">{so.totalForeign.toFixed(2)}{sym}</span>{so.currency !== 'GBP' && <span className="text-muted-foreground font-normal text-xs ml-1">(£{so.totalGbp.toFixed(2)})</span>}</td></tr>
          </tfoot>
        </table>
      </div>

      {/* Invoice */}
      {so.invoiceNumber && (
        <div className="rounded-md border overflow-hidden">
          <div className="px-4 py-2 bg-muted/50 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Invoice {so.invoiceNumber}
              {so.paidAt && <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200">Paid</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowInvoice(true)}>
                View Details
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
                <FileText className="h-3 w-3 mr-1" />PDF
              </Button>
              {so.customerEmail && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { const l = getInvoiceMailtoLink(); if (l) window.location.href = l }}>
                  <Mail className="h-3 w-3 mr-1" />Email
                </Button>
              )}
            </div>
          </div>
          <div className="px-4 py-3 text-sm grid grid-cols-4 gap-4">
            <div>
              <span className="text-muted-foreground text-xs">Invoice Date</span>
              <p className="font-medium">{so.invoicedAt ? new Date(so.invoicedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Total</span>
              <p className="font-medium font-mono">{so.totalForeign.toFixed(2)}{sym}</p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Paid</span>
              <p className="font-medium font-mono">
                {(() => { const invPayments = so.payments.filter((p) => !p.refundId); const paid = invPayments.reduce((s, p) => s + p.amount, 0); return `${paid.toFixed(2)}${sym}` })()}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground text-xs">Balance</span>
              <p className={`font-medium font-mono ${(() => { const paid = so.payments.filter((p) => !p.refundId).reduce((s, p) => s + p.amount, 0); return so.totalForeign - paid > 0.01 ? 'text-destructive' : 'text-green-600' })()}`}>
                {(() => { const paid = so.payments.filter((p) => !p.refundId).reduce((s, p) => s + p.amount, 0); const bal = so.totalForeign - paid; return bal > 0.01 ? `${bal.toFixed(2)}${sym} due` : 'Settled' })()}
              </p>
            </div>
          </div>
          {/* Invoice payments */}
          {so.payments.filter((p) => !p.refundId).length > 0 && (
            <div className="border-t px-4 py-2 space-y-1">
              {so.payments.filter((p) => !p.refundId).map((p) => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    {p.method && <span className="text-muted-foreground">{p.method}</span>}
                    {p.reference && <span className="font-mono text-muted-foreground">{p.reference}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{p.amount.toFixed(2)}{sym}</span>
                    <button type="button" onClick={() => { if (confirm('Delete this payment?')) startTransition(async () => { await deletePayment(p.id, so.id); router.refresh() }) }} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="border-t px-4 py-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowPayment({})}>
              <CreditCard className="h-3 w-3 mr-1" />Add Payment
            </Button>
          </div>
        </div>
      )}

      {/* Refunds */}
      {so.refunds.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <button type="button" className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 text-sm font-medium" onClick={() => setShowRefunds((v) => !v)}>
            <span>Refunds ({so.refunds.length})</span>
            {showRefunds ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showRefunds && <div className="divide-y">{so.refunds.map((r) => (
            <div key={r.id} className="px-4 py-3 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {r.creditNoteNumber && <span className="font-mono text-xs font-medium">{r.creditNoteNumber}</span>}
                  <span className="text-muted-foreground text-xs">{new Date(r.refundedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                <span className="font-mono font-medium text-destructive">-{r.totalForeign.toFixed(2)}{sym}</span>
              </div>
              {r.reason && <p className="text-xs"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>}
              <table className="w-full text-xs"><tbody className="divide-y">{r.lines.map((rl) => (
                <tr key={rl.id}><td className="py-1 pr-4">{rl.description}</td><td className="py-1 pr-4 text-right tabular-nums">{rl.qty}</td><td className="py-1 text-right font-mono">£{rl.totalGbp.toFixed(2)}</td></tr>
              ))}</tbody></table>
              {/* Credit note payments */}
              {r.payments.length > 0 && (
                <div className="space-y-1 pt-1 border-t">
                  {r.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                        {p.method && <span className="text-muted-foreground">{p.method}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono">{p.amount.toFixed(2)}{sym}</span>
                        <button type="button" onClick={() => { if (confirm('Delete?')) startTransition(async () => { await deletePayment(p.id, so.id); router.refresh() }) }} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Button variant="outline" size="sm" className="h-6 text-xs mt-1" onClick={() => setShowPayment({ refundId: r.id, creditNoteNumber: r.creditNoteNumber ?? undefined })}>
                <CreditCard className="h-3 w-3 mr-1" />Add Payment
              </Button>
            </div>
          ))}</div>}
        </div>
      )}

      {/* Dialogs */}
      {showShip && <ShipDialog order={so} warehouses={warehouses} onClose={() => setShowShip(false)} />}
      {showRefund && <RefundDialog order={so} warehouses={warehouses} sym={sym} onClose={() => setShowRefund(false)} />}
      {showNotes && <NotesDialog order={so} onClose={() => setShowNotes(false)} />}
      {showPayment && <PaymentDialog orderId={so.id} refundId={showPayment.refundId} creditNoteNumber={showPayment.creditNoteNumber} currency={so.currency} onClose={() => setShowPayment(null)} />}

      {/* Invoice detail dialog */}
      {showInvoice && so.invoiceNumber && (
        <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Invoice {so.invoiceNumber}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {/* Invoice header */}
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground text-xs">Invoice Number</span>
                <p className="font-medium font-mono">{so.invoiceNumber}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Invoice Date</span>
                <p className="font-medium">{so.invoicedAt ? new Date(so.invoicedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Status</span>
                <p className="font-medium">{so.paidAt ? `Paid ${new Date(so.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Unpaid'}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Customer</span>
                <p className="font-medium">{so.customerName ?? '—'}</p>
              </div>
              <div className="col-span-2">
                <span className="text-muted-foreground text-xs">Billing Address</span>
                <p className="text-xs mt-0.5">{so.billingAddress ? (() => { const a = so.billingAddress as Record<string, string>; return [a.line1, a.line2, a.city, a.county, a.postcode, a.country].filter(Boolean).join(', ') || '—' })() : '—'}</p>
              </div>
            </div>

            {/* Line items */}
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Description</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Qty</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Unit Price</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Discount</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-20">Tax</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Total ({sym})</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {so.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-2">{line.description}{line.sku ? ` (${line.sku})` : ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.qty}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{line.unitPriceForeign.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-destructive">{line.discountAmount > 0 ? `-${line.discountAmount.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{line.taxForeign > 0 ? line.taxForeign.toFixed(2) : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{line.totalForeign.toFixed(2)}{sym}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t bg-muted/30 text-sm">
                  <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">Subtotal</td><td className="px-3 py-1.5 text-right font-mono">{so.subtotalForeign.toFixed(2)}{sym}</td></tr>
                  {so.discountAmount > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-destructive">Discount</td><td className="px-3 py-1.5 text-right font-mono text-destructive">-{so.discountAmount.toFixed(2)}{sym}</td></tr>}
                  {so.shippingForeign > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">Shipping</td><td className="px-3 py-1.5 text-right font-mono">{so.shippingForeign.toFixed(2)}{sym}</td></tr>}
                  {so.taxForeign > 0 && <tr><td colSpan={5} className="px-3 py-1.5 text-right text-muted-foreground">{so.taxRateName ?? 'Tax'}{so.taxRatePercent != null ? ` (${(so.taxRatePercent * 100).toFixed(0)}%)` : ''}</td><td className="px-3 py-1.5 text-right font-mono">{so.taxForeign.toFixed(2)}{sym}</td></tr>}
                  <tr className="border-t"><td colSpan={5} className="px-3 py-2 text-right font-medium">Total</td><td className="px-3 py-2 text-right font-mono font-semibold">{so.totalForeign.toFixed(2)}{sym}{so.currency !== 'GBP' && <span className="text-muted-foreground font-normal text-xs ml-1">(£{so.totalGbp.toFixed(2)})</span>}</td></tr>
                </tfoot>
              </table>
            </div>

            {/* Refund credit notes */}
            {so.refunds.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">Credit Notes</h3>
                {so.refunds.map((r) => (
                  <div key={r.id} className="rounded-md border p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {r.creditNoteNumber && <span className="font-mono text-xs font-medium">{r.creditNoteNumber}</span>}
                        <span className="text-muted-foreground text-xs">{new Date(r.refundedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                      <span className="font-mono font-medium text-destructive">-{r.totalForeign.toFixed(2)}{sym}</span>
                    </div>
                    {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
                    {r.lines.map((rl) => (
                      <div key={rl.id} className="flex justify-between text-xs pl-3">
                        <span>{rl.description} x {rl.qty}</span>
                        <span className="font-mono text-destructive">-£{rl.totalGbp.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvoice(false)}>Close</Button>
            <Button variant="outline" onClick={() => window.open(`/api/invoice/${so.id}`, '_blank')}>
              <FileText className="h-4 w-4 mr-1" />Print / Download PDF
            </Button>
            {so.customerEmail && (
              <Button variant="outline" onClick={() => { const l = getInvoiceMailtoLink(); if (l) window.location.href = l }}>
                <Mail className="h-4 w-4 mr-1" />Email to Customer
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
