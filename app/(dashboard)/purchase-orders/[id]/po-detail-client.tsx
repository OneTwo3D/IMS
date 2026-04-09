'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Plus, Pencil, Truck, PackageCheck, Ban, Undo2, ChevronDown, ChevronRight, Loader2, FileText, Mail, Receipt, Upload, Ship } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  advancePoStatus,
  cancelPurchaseOrder,
  receivePurchaseOrder,
  returnPurchaseOrder,
  createInvoice,
  updatePurchaseOrder,
  updateFreightPoCosts,
  getSupplierLastPrices,
  type PoDetail,
  type PoStatus,
  type PoLineRow,
} from '@/app/actions/purchase-orders'
import type { SupplierRow } from '@/app/actions/suppliers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow } from '@/app/actions/settings'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  po: PoDetail
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
}

const STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  RFQ_SENT: 'RFQ Sent',
  PO_SENT: 'PO Sent',
  PARTIALLY_RECEIVED: 'Partially Received',
  RECEIVED: 'Received',
  INVOICED: 'Invoiced',
  PARTIALLY_RETURNED: 'Partially Returned',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}

const STATUS_CLASS: Record<PoStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground border-muted',
  RFQ_SENT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-200',
  PO_SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 border-blue-200',
  PARTIALLY_RECEIVED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RECEIVED: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-200',
  INVOICED: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200',
  PARTIALLY_RETURNED: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200',
  RETURNED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200',
  CANCELLED: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 border-red-200',
}

// ---------------------------------------------------------------------------
// Receive Goods dialog
// ---------------------------------------------------------------------------

type ReceiveLineState = {
  poLineId: string
  productId: string
  sku: string
  productName: string
  qtyOrdered: number
  qtyAlreadyReceived: number
  qtyRemaining: number
  qtyToReceive: number
  warehouseId: string
}

function ReceiveDialog({
  po,
  warehouses,
  onClose,
}: {
  po: PoDetail
  warehouses: Warehouse[]
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [receiptNotes, setReceiptNotes] = useState('')
  const [error, setError] = useState('')

  const defaultWarehouseId = po.destinationWarehouseId ?? warehouses[0]?.id ?? ''

  const [receiptLines, setReceiptLines] = useState<ReceiveLineState[]>(
    po.lines
      .filter((l) => l.qtyToReceive > 0)
      .map((l) => ({
        poLineId: l.id,
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        qtyOrdered: l.qty,
        qtyAlreadyReceived: l.qtyReceived,
        qtyRemaining: l.qtyToReceive,
        qtyToReceive: l.qtyToReceive,
        warehouseId: defaultWarehouseId,
      })),
  )

  function updateLine(poLineId: string, field: 'qtyToReceive' | 'warehouseId', value: string | number) {
    setReceiptLines((prev) =>
      prev.map((l) => (l.poLineId === poLineId ? { ...l, [field]: value } : l)),
    )
  }

  function handleConfirm() {
    setError('')
    const toReceive = receiptLines.filter((l) => l.qtyToReceive > 0)
    if (!toReceive.length) { setError('Enter at least one quantity to receive'); return }
    if (toReceive.some((l) => !l.warehouseId)) { setError('Select a warehouse for each line'); return }
    if (toReceive.some((l) => l.qtyToReceive > l.qtyRemaining)) {
      setError('Cannot receive more than remaining quantity')
      return
    }

    startTransition(async () => {
      const result = await receivePurchaseOrder(
        po.id,
        toReceive.map((l) => ({
          poLineId: l.poLineId,
          qtyReceived: l.qtyToReceive,
          warehouseId: l.warehouseId,
        })),
        receiptNotes || undefined,
      )
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed to receive goods')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Receive Goods — {po.reference}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="pb-2 text-left font-medium">Product</th>
                  <th className="pb-2 text-right font-medium w-16">Ordered</th>
                  <th className="pb-2 text-right font-medium w-20">Received</th>
                  <th className="pb-2 text-right font-medium w-20">Remaining</th>
                  <th className="pb-2 text-right font-medium w-24">Receive Now</th>
                  <th className="pb-2 text-left font-medium pl-3">Warehouse</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {receiptLines.map((l) => (
                  <tr key={l.poLineId}>
                    <td className="py-2 pr-3">
                      <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{l.qtyOrdered}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{l.qtyAlreadyReceived}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.qtyRemaining}</td>
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        min={0}
                        max={l.qtyRemaining}
                        step={1}
                        value={l.qtyToReceive}
                        onChange={(e) => updateLine(l.poLineId, 'qtyToReceive', Number(e.target.value))}
                        className="h-7 text-sm text-right w-24 ml-auto font-mono"
                      />
                    </td>
                    <td className="py-2 pl-3">
                      <select
                        value={l.warehouseId}
                        onChange={(e) => updateLine(l.poLineId, 'warehouseId', e.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-36"
                      >
                        <option value="">Select…</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="receiptNotes">Receipt Notes</Label>
            <Textarea
              id="receiptNotes"
              value={receiptNotes}
              onChange={(e) => setReceiptNotes(e.target.value)}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Confirm Receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Return Items dialog
// ---------------------------------------------------------------------------

type ReturnLineState = {
  poLineId: string
  productId: string
  sku: string
  productName: string
  qtyReceived: number
  qtyAlreadyReturned: number
  netReturnable: number
  qtyToReturn: number
  warehouseId: string
}

function ReturnDialog({
  po,
  warehouses,
  onClose,
}: {
  po: PoDetail
  warehouses: Warehouse[]
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [returnNotes, setReturnNotes] = useState('')
  const [error, setError] = useState('')

  const defaultWarehouseId = po.destinationWarehouseId ?? warehouses[0]?.id ?? ''

  const [returnLines, setReturnLines] = useState<ReturnLineState[]>(
    po.lines
      .filter((l) => l.qtyReceived - l.qtyReturned > 0)
      .map((l) => ({
        poLineId: l.id,
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        qtyReceived: l.qtyReceived,
        qtyAlreadyReturned: l.qtyReturned,
        netReturnable: l.qtyReceived - l.qtyReturned,
        qtyToReturn: 0,
        warehouseId: defaultWarehouseId,
      })),
  )

  function updateLine(poLineId: string, field: 'qtyToReturn' | 'warehouseId', value: string | number) {
    setReturnLines((prev) =>
      prev.map((l) => (l.poLineId === poLineId ? { ...l, [field]: value } : l)),
    )
  }

  function handleConfirm() {
    setError('')
    if (!reason.trim()) { setError('Please enter a reason for the return'); return }
    const toReturn = returnLines.filter((l) => l.qtyToReturn > 0)
    if (!toReturn.length) { setError('Enter at least one quantity to return'); return }
    if (toReturn.some((l) => !l.warehouseId)) { setError('Select a warehouse for each line'); return }
    if (toReturn.some((l) => l.qtyToReturn > l.netReturnable)) {
      setError('Cannot return more than net received quantity')
      return
    }

    startTransition(async () => {
      const result = await returnPurchaseOrder(
        po.id,
        toReturn.map((l) => ({
          poLineId: l.poLineId,
          qtyReturned: l.qtyToReturn,
          warehouseId: l.warehouseId,
        })),
        reason,
        returnNotes || undefined,
      )
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed to process return')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return Items — {po.reference}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="returnReason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Input
              id="returnReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Wrong item, damaged, duplicate order…"
              className="h-9 text-sm"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="pb-2 text-left font-medium">Product</th>
                  <th className="pb-2 text-right font-medium w-20">Received</th>
                  <th className="pb-2 text-right font-medium w-20">Returned</th>
                  <th className="pb-2 text-right font-medium w-24">Returnable</th>
                  <th className="pb-2 text-right font-medium w-24">Return Now</th>
                  <th className="pb-2 text-left font-medium pl-3">From Warehouse</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {returnLines.map((l) => (
                  <tr key={l.poLineId}>
                    <td className="py-2 pr-3">
                      <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{l.qtyReceived}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{l.qtyAlreadyReturned > 0 ? l.qtyAlreadyReturned : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">{l.netReturnable}</td>
                    <td className="py-2 pr-3">
                      <Input
                        type="number"
                        min={0}
                        max={l.netReturnable}
                        step={1}
                        value={l.qtyToReturn}
                        onChange={(e) => updateLine(l.poLineId, 'qtyToReturn', Number(e.target.value))}
                        className="h-7 text-sm text-right w-24 ml-auto font-mono"
                      />
                    </td>
                    <td className="py-2 pl-3">
                      <select
                        value={l.warehouseId}
                        onChange={(e) => updateLine(l.poLineId, 'warehouseId', e.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-36"
                      >
                        <option value="">Select…</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="returnNotes">Additional Notes</Label>
            <Textarea
              id="returnNotes"
              value={returnNotes}
              onChange={(e) => setReturnNotes(e.target.value)}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Confirm Return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Bill / Invoice dialog
// ---------------------------------------------------------------------------

type BillLineState = {
  poLineId: string
  productId: string
  sku: string
  productName: string
  qtyReceived: number
  unitCostForeign: number
  selected: boolean
  qtyBilled: number
}

function BillDialog({
  po,
  currencies,
  onClose,
}: {
  po: PoDetail
  currencies: CurrencyRow[]
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [step, setStep] = useState<1 | 2>(1)
  const [error, setError] = useState('')

  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const billSym = symbolMap[po.currency] ?? po.currency

  const [billLines, setBillLines] = useState<BillLineState[]>(
    po.lines
      .filter((l) => l.qtyReceived > 0)
      .map((l) => ({
        poLineId: l.id,
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        qtyReceived: l.qtyReceived,
        unitCostForeign: l.unitCostForeign,
        selected: true,
        qtyBilled: l.qtyReceived,
      })),
  )

  // Step 2 fields
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [uploading, setUploading] = useState(false)
  const [supplierInvoiceUrl, setSupplierInvoiceUrl] = useState('')
  const [uploadName, setUploadName] = useState('')

  const selectedLines = billLines.filter((l) => l.selected && l.qtyBilled > 0)
  const subtotal = selectedLines.reduce((s, l) => s + l.qtyBilled * l.unitCostForeign, 0)

  function toggleLine(poLineId: string) {
    setBillLines((prev) => prev.map((l) => l.poLineId === poLineId ? { ...l, selected: !l.selected } : l))
  }

  function toggleAll(checked: boolean) {
    setBillLines((prev) => prev.map((l) => ({ ...l, selected: checked })))
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/upload/invoice', { method: 'POST', body: form })
    const data = await res.json()
    setUploading(false)
    if (data.url) {
      setSupplierInvoiceUrl(data.url)
      setUploadName(file.name)
    } else {
      setError(data.error ?? 'Upload failed')
    }
  }

  function handleConfirm() {
    setError('')
    if (!selectedLines.length) { setError('Select at least one line'); return }
    if (!invoiceDate) { setError('Invoice date is required'); return }

    startTransition(async () => {
      const result = await createInvoice(po.id, {
        invoiceNumber: invoiceNumber || undefined,
        invoiceDate,
        dueDate: dueDate || undefined,
        notes: notes || undefined,
        supplierInvoiceUrl: supplierInvoiceUrl || undefined,
        lines: selectedLines.map((l) => ({
          poLineId: l.poLineId,
          qtyBilled: l.qtyBilled,
          unitCostForeign: l.unitCostForeign,
        })),
      })
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed to create bill')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? 'Create Bill — Select Items' : 'Create Bill — Review & Confirm'}
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Select the line items to include in this bill:</p>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={billLines.every((l) => l.selected)}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="rounded border-input"
                      />
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Received</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-32">Unit Cost ({billSym})</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-28">Total ({billSym})</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {billLines.map((l) => (
                    <tr key={l.poLineId} className={l.selected ? '' : 'opacity-40'}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={l.selected}
                          onChange={() => toggleLine(l.poLineId)}
                          className="rounded border-input"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.qtyReceived}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{l.unitCostForeign.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{(l.qtyReceived * l.unitCostForeign).toFixed(2)}{billSym}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {/* Invoice details */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Invoice Number</Label>
                <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Supplier's invoice #" className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Date *</Label>
                <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Due Date</Label>
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-9 text-sm" />
              </div>
            </div>

            {/* Lines with editable qty */}
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-24">Qty to Bill</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-32">Unit Cost ({billSym})</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-28">Total ({billSym})</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {selectedLines.map((l) => (
                    <tr key={l.poLineId}>
                      <td className="px-3 py-2">
                        <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number" min={0} max={l.qtyReceived} step={1}
                          value={l.qtyBilled}
                          onChange={(e) => setBillLines((prev) => prev.map((bl) => bl.poLineId === l.poLineId ? { ...bl, qtyBilled: Number(e.target.value) || 0 } : bl))}
                          className="h-7 text-sm text-right w-24 ml-auto font-mono"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number" min={0} step={0.01}
                          value={l.unitCostForeign}
                          onChange={(e) => setBillLines((prev) => prev.map((bl) => bl.poLineId === l.poLineId ? { ...bl, unitCostForeign: Number(e.target.value) || 0 } : bl))}
                          className="h-7 text-sm text-right w-32 ml-auto font-mono"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{(l.qtyBilled * l.unitCostForeign).toFixed(2)}{billSym}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="flex justify-end text-sm">
              <div className="min-w-48 space-y-1">
                <div className="flex justify-between font-medium border-t pt-1">
                  <span>Total</span>
                  <span className="font-mono">{subtotal.toFixed(2)}{billSym}</span>
                </div>
              </div>
            </div>

            {/* Upload supplier invoice PDF */}
            <div className="space-y-1.5">
              <Label>Attach Supplier Invoice (PDF)</Label>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 h-9 text-sm cursor-pointer hover:bg-muted">
                  <Upload className="h-4 w-4 text-muted-foreground" />
                  {uploading ? 'Uploading…' : uploadName || 'Choose file'}
                  <input type="file" accept=".pdf" className="hidden" onChange={handleUpload} disabled={uploading} />
                </label>
                {supplierInvoiceUrl && (
                  <span className="text-xs text-green-600">Uploaded</span>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm resize-none" />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={step === 1 ? onClose : () => setStep(1)} disabled={isPending}>
            {step === 1 ? 'Cancel' : 'Back'}
          </Button>
          {step === 1 ? (
            <Button onClick={() => { if (!selectedLines.length) { setError('Select at least one line'); return }; setError(''); setStep(2) }}>
              Next
            </Button>
          ) : (
            <Button onClick={handleConfirm} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm Bill
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit form (inline, replaces lines section)
// ---------------------------------------------------------------------------

function EditPoForm({
  po,
  suppliers,
  products,
  warehouses,
  currencies,
  onDone,
}: {
  po: PoDetail
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  onDone: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')

  const [supplierId, setSupplierId] = useState(po.supplierId)
  const [currency, setCurrency] = useState(po.currency)
  const [fxRate, setFxRate] = useState(po.fxRateToGbp)
  const [destinationWarehouseId, setDestinationWarehouseId] = useState(po.destinationWarehouseId ?? '')
  const [supplierRef, setSupplierRef] = useState(po.supplierRef ?? '')
  const [expectedDelivery, setExpectedDelivery] = useState(
    po.expectedDelivery ? po.expectedDelivery.slice(0, 10) : '',
  )
  const [notes, setNotes] = useState(po.notes ?? '')
  const [internalNotes, setInternalNotes] = useState(po.internalNotes ?? '')

  type LineItem = { key: string; productId: string; sku: string; productName: string; qty: number; unitCostForeign: number }
  function makeKey() { return Math.random().toString(36).slice(2) }

  const [lines, setLines] = useState<LineItem[]>(
    po.lines.map((l) => ({
      key: makeKey(),
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      qty: l.qty,
      unitCostForeign: l.unitCostForeign,
    })),
  )

  const [productSearch, setProductSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [lastPrices, setLastPrices] = useState<Record<string, { lastUnitCost: number }>>({})

  const editSymbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) editSymbolMap[c.code] = c.symbol
  const editSym = editSymbolMap[currency] ?? currency

  const rateMap: Record<string, number> = { GBP: 1 }
  for (const c of currencies) {
    if (c.latestRate != null) rateMap[c.code] = c.latestRate
  }

  function setCurrencyAndRate(code: string) {
    setCurrency(code)
    if (code === 'GBP') setFxRate(1)
    else if (rateMap[code]) setFxRate(rateMap[code])
  }

  async function handleSupplierChange(id: string) {
    setSupplierId(id)
    const s = suppliers.find((sup) => sup.id === id)
    if (s) setCurrencyAndRate(s.currency)
    if (id) {
      const prices = await getSupplierLastPrices(id)
      setLastPrices(prices)
    }
  }

  function addProduct(p: ProductRow) {
    if (lines.some((l) => l.productId === p.id)) return
    const last = lastPrices[p.id]
    setLines((prev) => [
      ...prev,
      { key: makeKey(), productId: p.id, sku: p.sku, productName: p.name, qty: 1, unitCostForeign: last?.lastUnitCost ?? 0 },
    ])
    setProductSearch('')
    setShowSearch(false)
  }

  const filteredProducts = products.filter((p) => {
    if (!productSearch) return true
    const q = productSearch.toLowerCase()
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  }).slice(0, 20)

  const subtotalForeign = lines.reduce((s, l) => s + l.qty * l.unitCostForeign, 0)
  const subtotalGbp = subtotalForeign / fxRate

  function handleSave() {
    setError('')
    if (!supplierId) { setError('Please select a supplier'); return }
    if (!lines.length) { setError('Add at least one line'); return }

    startTransition(async () => {
      const result = await updatePurchaseOrder(po.id, {
        supplierId,
        currency,
        fxRateToGbp: fxRate,
        destinationWarehouseId: destinationWarehouseId || undefined,
        supplierRef: supplierRef || undefined,
        expectedDelivery: expectedDelivery || undefined,
        notes: notes || undefined,
        internalNotes: internalNotes || undefined,
        lines: lines.map((l, i) => ({
          productId: l.productId,
          sku: l.sku,
          productName: l.productName,
          qty: l.qty,
          unitCostForeign: l.unitCostForeign,
          sortOrder: i,
        })),
      })
      if (result.success) {
        router.refresh()
        onDone()
      } else {
        setError(result.error ?? 'Save failed')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Supplier</Label>
          <select
            value={supplierId}
            onChange={(e) => handleSupplierChange(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Currency / FX Rate</Label>
          <div className="flex gap-2">
            <select
              value={currency}
              onChange={(e) => setCurrencyAndRate(e.target.value)}
              className="w-28 h-9 rounded-md border border-input bg-background px-3 text-sm font-mono"
            >
              <option value="GBP">GBP £</option>
              {currencies.filter((c) => c.code !== 'GBP').map((c) => (
                <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>
              ))}
            </select>
            <div className="flex-1 relative">
              <span className="absolute left-3 top-2 text-xs text-muted-foreground">1 GBP =</span>
              <Input
                type="number" min="0.0001" step="0.0001"
                value={fxRate}
                onChange={(e) => setFxRate(Number(e.target.value) || 1)}
                className="pl-16 h-9 font-mono text-sm"
                disabled={currency === 'GBP'}
              />
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Destination Warehouse</Label>
          <select
            value={destinationWarehouseId}
            onChange={(e) => setDestinationWarehouseId(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Not specified</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Expected Delivery</Label>
          <Input type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} className="h-9 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label>Supplier Reference</Label>
          <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} className="h-9 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="text-sm resize-none" />
        </div>
        <div className="space-y-1.5">
          <Label>Internal Notes</Label>
          <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={2} className="text-sm resize-none" />
        </div>
      </div>

      {/* Lines */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">Lines</h3>
        {lines.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground text-xs">
                <th className="pb-2 text-left font-medium">Product</th>
                <th className="pb-2 text-right font-medium w-24">Qty</th>
                <th className="pb-2 text-right font-medium w-32">Unit Cost ({editSym})</th>
                <th className="pb-2 text-right font-medium w-28">Total ({editSym})</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line) => (
                <tr key={line.key}>
                  <td className="py-2 pr-3">
                    <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      type="number" min="0.0001" step="1"
                      value={line.qty}
                      onChange={(e) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, qty: Number(e.target.value) || 0 } : l))}
                      className="h-7 text-sm text-right w-24 ml-auto"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      type="number" min="0" step="0.01"
                      value={line.unitCostForeign}
                      onChange={(e) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, unitCostForeign: Number(e.target.value) || 0 } : l))}
                      className="h-7 text-sm text-right w-32 ml-auto font-mono"
                    />
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">
                    {(line.qty * line.unitCostForeign).toFixed(2)}{editSym}
                  </td>
                  <td className="py-2">
                    <button type="button" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))} className="text-muted-foreground hover:text-destructive">
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="relative">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search product to add…"
              value={productSearch}
              onChange={(e) => { setProductSearch(e.target.value); setShowSearch(true) }}
              onFocus={() => setShowSearch(true)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          {showSearch && productSearch && (
            <div className="absolute z-10 top-9 left-0 right-0 bg-popover border rounded-md shadow-md max-h-48 overflow-y-auto">
              {filteredProducts.filter((p) => !lines.some((l) => l.productId === p.id)).map((p) => (
                <button
                  key={p.id} type="button"
                  className="w-full flex items-center px-3 py-2 hover:bg-accent text-sm text-left gap-2"
                  onMouseDown={() => addProduct(p)}
                >
                  <span className="font-mono text-xs font-medium">{p.sku}</span>
                  <span className="text-muted-foreground">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <div className="flex justify-end pt-2 text-sm">
            <div className="space-y-1 min-w-48">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="font-mono">{subtotalForeign.toFixed(2)}{editSym}</span>
              </div>
              <div className="flex justify-between font-medium border-t pt-1">
                <span>Total</span>
                <span className="font-mono">
                  {subtotalForeign.toFixed(2)}{editSym}
                  {currency !== 'GBP' && (
                    <span className="text-muted-foreground font-normal text-xs ml-1">(£{subtotalGbp.toFixed(2)})</span>
                  )}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave} disabled={isPending} size="sm">
          {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save Changes
        </Button>
        <Button variant="outline" size="sm" onClick={onDone} disabled={isPending}>Discard</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Freight PO Costs dialog
// ---------------------------------------------------------------------------

type FreightCostEditLine = {
  key: string
  description: string
  amountForeign: number
  vatable: boolean
  distributionMethod: string
}

function EditFreightCostsDialog({
  po,
  currencies,
  onClose,
}: {
  po: PoDetail
  currencies: CurrencyRow[]
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')

  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const fSym = symbolMap[po.currency] ?? po.currency

  // Initialize from existing linked freight data (we get cost lines from linkedFreightPos)
  // For a FREIGHT type PO we need to fetch its own cost lines — but we don't have them directly
  // We'll use the PO's direct freight info and allow editing
  const [costLines, setCostLines] = useState<FreightCostEditLine[]>(() => {
    if (po.freightCostLines.length > 0) {
      return po.freightCostLines.map((cl) => ({
        key: Math.random().toString(36).slice(2),
        description: cl.description,
        amountForeign: cl.amountForeign,
        vatable: cl.vatable,
        distributionMethod: cl.distributionMethod,
      }))
    }
    if (po.directFreightForeign > 0) {
      return [{ key: Math.random().toString(36).slice(2), description: 'Freight / Shipping', amountForeign: po.directFreightForeign, vatable: false, distributionMethod: 'BY_VALUE' }]
    }
    return []
  })

  const subtotal = costLines.reduce((s, cl) => s + cl.amountForeign, 0)

  function handleSave() {
    setError('')
    if (!costLines.some((cl) => cl.amountForeign > 0)) { setError('Add at least one cost with an amount'); return }
    startTransition(async () => {
      const result = await updateFreightPoCosts(
        po.id,
        costLines.filter((cl) => cl.amountForeign > 0).map((cl) => ({
          description: cl.description,
          amountForeign: cl.amountForeign,
          vatable: cl.vatable,
          distributionMethod: cl.distributionMethod,
        })),
      )
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed to update costs')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Landed Costs — {po.reference}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Update cost amounts to reflect actual charges. Linked primary PO line costs and COGS will be recalculated automatically.
          </p>

          <div className="space-y-2">
            {costLines.map((cl) => (
              <div key={cl.key} className="flex items-center gap-2">
                <Input
                  placeholder="Description"
                  value={cl.description}
                  onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, description: e.target.value } : c))}
                  className="flex-1 h-8 text-sm"
                />
                <Input
                  type="number" min="0" step="0.01"
                  value={cl.amountForeign}
                  onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, amountForeign: Number(e.target.value) || 0 } : c))}
                  className="w-28 h-8 text-sm text-right font-mono"
                />
                <span className="text-xs text-muted-foreground w-8 shrink-0">{fSym}</span>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={cl.vatable}
                    onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, vatable: e.target.checked } : c))}
                    className="rounded border-input"
                  />
                  VAT
                </label>
                <select
                  value={cl.distributionMethod}
                  onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, distributionMethod: e.target.value } : c))}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs w-32 shrink-0"
                >
                  <option value="BY_VALUE">By Value</option>
                  <option value="BY_QUANTITY">By Quantity</option>
                  <option value="BY_WEIGHT">By Weight</option>
                  <option value="EQUAL_SPLIT">Equal Split</option>
                </select>
                <button type="button" onClick={() => setCostLines((p) => p.filter((c) => c.key !== cl.key))} className="text-muted-foreground hover:text-destructive shrink-0">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <Button
            variant="outline" size="sm"
            onClick={() => setCostLines((p) => [...p, { key: Math.random().toString(36).slice(2), description: '', amountForeign: 0, vatable: false, distributionMethod: 'BY_VALUE' }])}
          >
            <Plus className="h-3 w-3 mr-1" />Add Cost Line
          </Button>

          <div className="flex justify-end text-sm font-medium">
            <span>Total: {subtotal.toFixed(2)}{fSym}</span>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Update &amp; Recalculate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main detail component
// ---------------------------------------------------------------------------

export function PoDetailClient({ po: initialPo, suppliers, products, warehouses, currencies, taxRates }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const po = initialPo

  // Currency symbol lookup
  const symbolMap: Record<string, string> = { GBP: '£' }
  for (const c of currencies) symbolMap[c.code] = c.symbol
  const sym = symbolMap[po.currency] ?? po.currency

  const [editing, setEditing] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [showReturn, setShowReturn] = useState(false)
  const [showBill, setShowBill] = useState(false)
  const [showEditFreight, setShowEditFreight] = useState(false)
  const [showReceipts, setShowReceipts] = useState(false)
  const [showReturns, setShowReturns] = useState(false)
  const [showInvoices, setShowInvoices] = useState(false)
  const [error, setError] = useState('')

  const canEdit = po.status === 'DRAFT'
  const canRfq = po.status === 'DRAFT' || po.status === 'RFQ_SENT'
  const canAdvance = po.status === 'DRAFT'
  const canReceive = ['PO_SENT', 'RFQ_SENT', 'PARTIALLY_RECEIVED'].includes(po.status)
  const canReturn = ['PO_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED'].includes(po.status)
  const canBill = ['PO_SENT', 'RFQ_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_RETURNED'].includes(po.status)
  const canCancel = po.status === 'DRAFT'
  const hasRemaining = po.lines.some((l) => l.qtyToReceive > 0)
  const hasReturnable = po.lines.some((l) => l.qtyReceived - l.qtyReturned > 0)

  function handleAdvance() {
    setError('')
    startTransition(async () => {
      const result = await advancePoStatus(po.id, 'PO_SENT')
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleSendRfq() {
    setError('')
    startTransition(async () => {
      const result = await advancePoStatus(po.id, 'RFQ_SENT')
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function getRfqMailtoLink() {
    const email = supplier?.email
    if (!email) return null
    const subject = encodeURIComponent(`Request for Quotation — ${po.reference}`)
    const body = encodeURIComponent(
      `Dear ${supplier?.contactName || supplier?.name || 'Supplier'},\n\n` +
      `Please find attached our Request for Quotation ${po.reference}.\n\n` +
      `We would appreciate your best prices for the listed items, ` +
      `including lead time and shipping costs.\n\n` +
      `Kind regards`
    )
    return `mailto:${email}?subject=${subject}&body=${body}`
  }

  function handleCancel() {
    if (!confirm('Cancel this purchase order?')) return
    setError('')
    startTransition(async () => {
      const result = await cancelPurchaseOrder(po.id)
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  const supplier = suppliers.find((s) => s.id === po.supplierId)

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Status + Actions bar */}
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${STATUS_CLASS[po.status]}`}>
          {STATUS_LABELS[po.status]}
        </span>
        {po.isInvoiced && po.status !== 'INVOICED' && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border-purple-200">
            Invoiced
          </span>
        )}
        {po.isPartiallyReturned && po.status !== 'PARTIALLY_RETURNED' && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-200">
            Part. Returned
          </span>
        )}
        {po.isFullyReturned && po.status !== 'RETURNED' && (
          <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200">
            Returned
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-1" />Edit
            </Button>
          )}
          {canRfq && !editing && (
            <>
              <Button variant="outline" size="sm" onClick={() => window.open(`/api/rfq/${po.id}`, '_blank')}>
                <FileText className="h-4 w-4 mr-1" />RFQ PDF
              </Button>
              {supplier?.email && (
                <Button variant="outline" size="sm" onClick={() => { const link = getRfqMailtoLink(); if (link) window.location.href = link }}>
                  <Mail className="h-4 w-4 mr-1" />Email RFQ
                </Button>
              )}
              {po.status === 'DRAFT' && (
                <Button variant="secondary" size="sm" onClick={handleSendRfq} disabled={isPending}>
                  {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileText className="h-4 w-4 mr-1" />}
                  Mark RFQ Sent
                </Button>
              )}
            </>
          )}
          {canAdvance && !editing && (
            <Button size="sm" onClick={handleAdvance} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Truck className="h-4 w-4 mr-1" />}
              Confirm &amp; Send PO
            </Button>
          )}
          {canReceive && hasRemaining && (
            <Button size="sm" onClick={() => setShowReceive(true)} disabled={isPending}>
              <PackageCheck className="h-4 w-4 mr-1" />Receive Goods
            </Button>
          )}
          {canReturn && hasReturnable && (
            <Button variant="outline" size="sm" onClick={() => setShowReturn(true)} disabled={isPending}>
              <Undo2 className="h-4 w-4 mr-1" />Return Items
            </Button>
          )}
          {canBill && (
            <Button variant="outline" size="sm" onClick={() => setShowBill(true)} disabled={isPending}>
              <Receipt className="h-4 w-4 mr-1" />Create Bill
            </Button>
          )}
          {po.type === 'FREIGHT' && po.status !== 'CANCELLED' && (
            <Button variant="outline" size="sm" onClick={() => setShowEditFreight(true)} disabled={isPending}>
              <Pencil className="h-4 w-4 mr-1" />Edit Costs
            </Button>
          )}
          {canCancel && !editing && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={handleCancel} disabled={isPending}>
              <Ban className="h-4 w-4 mr-1" />Cancel PO
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Header info */}
      {!editing && (
        <div className="rounded-md border p-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Supplier</span>
            <p className="font-medium">{po.supplierName}</p>
            {supplier?.email && <p className="text-xs text-muted-foreground">{supplier.email}</p>}
          </div>
          <div>
            <span className="text-muted-foreground">Destination Warehouse</span>
            <p className="font-medium">{po.destinationWarehouseName ?? '—'}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Currency</span>
            <p className="font-medium">
              {po.currency} ({sym})
              {po.currency !== 'GBP' && <span className="text-muted-foreground ml-1 text-xs">1 GBP = {po.fxRateToGbp} {sym}</span>}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Expected Delivery</span>
            <p className="font-medium">
              {po.expectedDelivery
                ? new Date(po.expectedDelivery).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                : '—'}
            </p>
          </div>
          {po.supplierRef && (
            <div>
              <span className="text-muted-foreground">Supplier Reference</span>
              <p className="font-medium">{po.supplierRef}</p>
            </div>
          )}
          {po.notes && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Notes</span>
              <p className="mt-0.5 whitespace-pre-wrap">{po.notes}</p>
            </div>
          )}
          {po.internalNotes && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Internal Notes</span>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{po.internalNotes}</p>
            </div>
          )}
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="rounded-md border p-4">
          <EditPoForm
            po={po}
            suppliers={suppliers}
            products={products}
            warehouses={warehouses}
            currencies={currencies}
            onDone={() => { setEditing(false); router.refresh() }}
          />
        </div>
      )}

      {/* Lines table */}
      {!editing && (
        <div className="rounded-md border overflow-hidden">
          <div className="border-b px-4 py-2 bg-muted/50">
            <h2 className="text-sm font-medium">Order Lines</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="w-12 px-2 py-2" />
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Product</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-44">Qty</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-32">
                  Unit Cost ({sym})
                </th>
                {po.currency !== 'GBP' && (
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-28">Unit Cost (£)</th>
                )}
                {po.totalLandedCostGbp > 0 && (
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-28">Gross Cost (£)</th>
                )}
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-28">Total ({sym})</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-20">Received</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-20">Returned</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground w-20">On Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {po.lines.map((line) => (
                <tr key={line.id} className={line.qtyRemaining === 0 && line.qtyReturned === 0 ? 'opacity-60' : ''}>
                  <td className="w-12 px-2 py-1">
                    <ProductThumb productId={line.productId} imageUrl={line.imageUrl} name={line.productName} />
                  </td>
                  <td className="px-4 py-2">
                    <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                    {line.purchaseUnitQty != null ? (
                      <span>
                        <span>{line.purchaseUnitQty} {line.purchaseUnitName}</span>
                        <span className="text-muted-foreground text-xs ml-1">({line.qty} {line.purchaseUnitStockName ?? 'pcs'})</span>
                      </span>
                    ) : line.qty}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{line.unitCostForeign.toFixed(2)}</td>
                  {po.currency !== 'GBP' && (
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-xs text-muted-foreground">
                      £{line.unitCostGbp.toFixed(2)}
                    </td>
                  )}
                  {po.totalLandedCostGbp > 0 && (
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-xs font-medium">
                      £{line.grossUnitCostGbp.toFixed(2)}
                    </td>
                  )}
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">{line.totalForeign.toFixed(2)}{sym}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-green-700 dark:text-green-400">{line.qtyReceived > 0 ? line.qtyReceived : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-orange-600 dark:text-orange-400">{line.qtyReturned > 0 ? line.qtyReturned : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{line.qtyRemaining > 0 ? line.qtyRemaining : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30 text-sm">
              <tr>
                <td colSpan={3 + (po.currency !== 'GBP' ? 1 : 0) + (po.totalLandedCostGbp > 0 ? 1 : 0)} className="px-4 py-1.5 text-right text-muted-foreground">Subtotal</td>
                <td className="px-4 py-1.5 text-right tabular-nums font-mono">{po.subtotalForeign.toFixed(2)}{sym}</td>
                <td colSpan={3} />
              </tr>
              {po.taxForeign > 0 && (
                <tr>
                  <td colSpan={3 + (po.currency !== 'GBP' ? 1 : 0) + (po.totalLandedCostGbp > 0 ? 1 : 0)} className="px-4 py-1.5 text-right text-muted-foreground">{po.taxRateName ?? 'VAT'}{po.taxRatePercent != null ? ` (${(po.taxRatePercent * 100).toFixed(0)}%)` : ''}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums font-mono">{po.taxForeign.toFixed(2)}{sym}</td>
                  <td colSpan={3} />
                </tr>
              )}
              {po.directFreightForeign > 0 && (
                <tr>
                  <td colSpan={3 + (po.currency !== 'GBP' ? 1 : 0) + (po.totalLandedCostGbp > 0 ? 1 : 0)} className="px-4 py-1.5 text-right text-muted-foreground">Additional Costs</td>
                  <td className="px-4 py-1.5 text-right tabular-nums font-mono">{po.directFreightForeign.toFixed(2)}{sym}</td>
                  <td colSpan={3} />
                </tr>
              )}
              <tr className="border-t">
                <td colSpan={3 + (po.currency !== 'GBP' ? 1 : 0) + (po.totalLandedCostGbp > 0 ? 1 : 0)} className="px-4 py-2 text-right font-medium text-muted-foreground">Total</td>
                <td className="px-4 py-2 text-right tabular-nums font-mono">
                  <span className="font-semibold">{po.totalForeign.toFixed(2)}{sym}</span>
                  {po.currency !== 'GBP' && (
                    <span className="text-muted-foreground font-normal text-xs ml-1">(£{po.totalGbp.toFixed(2)})</span>
                  )}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Receipts */}
      {/* Linked Freight / Landed Cost POs */}
      {po.linkedFreightPos.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <div className="px-4 py-2 bg-muted/50 text-sm font-medium flex items-center gap-2">
            <Ship className="h-4 w-4 text-muted-foreground" />
            Linked Landed Cost POs ({po.linkedFreightPos.length})
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              Total landed cost: £{po.totalLandedCostGbp.toFixed(2)}
            </span>
          </div>
          <div className="divide-y">
            {po.linkedFreightPos.map((fl) => (
              <div key={fl.linkId} className="px-4 py-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <a href={`/purchase-orders/${fl.freightPo.id}`} className="font-mono text-xs font-medium hover:underline">
                    {fl.freightPo.reference}
                  </a>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-muted-foreground">{fl.freightPo.supplierName}</span>
                    <span className="font-mono font-medium">£{fl.freightPo.totalGbp.toFixed(2)}</span>
                    <span className="text-muted-foreground">({fl.method})</span>
                  </div>
                </div>
                {fl.freightPo.costLines.map((cl, i) => (
                  <div key={i} className="flex items-center justify-between text-xs text-muted-foreground pl-4">
                    <span>{cl.description}</span>
                    <span className="font-mono">£{cl.amountGbp.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Linked Primary POs (shown on FREIGHT POs) */}
      {po.linkedPrimaryPos.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <div className="px-4 py-2 bg-muted/50 text-sm font-medium flex items-center gap-2">
            <Ship className="h-4 w-4 text-muted-foreground" />
            Linked Primary POs ({po.linkedPrimaryPos.length})
          </div>
          <div className="divide-y">
            {po.linkedPrimaryPos.map((pp) => (
              <div key={pp.id} className="px-4 py-2 text-sm flex items-center justify-between">
                <a href={`/purchase-orders/${pp.id}`} className="font-mono text-xs font-medium hover:underline">
                  {pp.reference}
                </a>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{pp.supplierName}</span>
                  <span className="font-mono font-medium">£{pp.totalGbp.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {po.receipts.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 text-sm font-medium"
            onClick={() => setShowReceipts((v) => !v)}
          >
            <span>Receipts ({po.receipts.length})</span>
            {showReceipts ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showReceipts && (
            <div className="divide-y">
              {po.receipts.map((r) => (
                <div key={r.id} className="px-4 py-3 text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-medium">{r.reference ?? r.id}</span>
                    <span className="text-muted-foreground text-xs">
                      {new Date(r.receivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  {r.notes && <p className="text-muted-foreground text-xs">{r.notes}</p>}
                  <table className="w-full text-xs">
                    <tbody className="divide-y">
                      {r.lines.map((rl) => (
                        <tr key={rl.id}>
                          <td className="py-1 pr-4">
                            <ProductLink productId={rl.productId} sku={rl.sku} name={rl.productName} />
                          </td>
                          <td className="py-1 pr-4 text-right tabular-nums">{rl.qtyReceived}</td>
                          <td className="py-1 text-muted-foreground">{rl.warehouseName ?? rl.warehouseId ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Returns history */}
      {po.returns.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 text-sm font-medium"
            onClick={() => setShowReturns((v) => !v)}
          >
            <span>Returns ({po.returns.length})</span>
            {showReturns ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showReturns && (
            <div className="divide-y">
              {po.returns.map((r) => (
                <div key={r.id} className="px-4 py-3 text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-medium">{r.reference ?? r.id}</span>
                    <span className="text-muted-foreground text-xs">
                      {new Date(r.returnedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  {r.reason && (
                    <p className="text-xs">
                      <span className="text-muted-foreground">Reason: </span>
                      {r.reason}
                    </p>
                  )}
                  {r.notes && <p className="text-muted-foreground text-xs">{r.notes}</p>}
                  <table className="w-full text-xs">
                    <tbody className="divide-y">
                      {r.lines.map((rl) => (
                        <tr key={rl.id}>
                          <td className="py-1 pr-4">
                            <ProductLink productId={rl.productId} sku={rl.sku} name={rl.productName} />
                          </td>
                          <td className="py-1 pr-4 text-right tabular-nums">{rl.qtyReturned}</td>
                          <td className="py-1 text-muted-foreground">{rl.warehouseId ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Receive dialog */}
      {showReceive && (
        <ReceiveDialog po={po} warehouses={warehouses} onClose={() => setShowReceive(false)} />
      )}

      {/* Return dialog */}
      {showReturn && (
        <ReturnDialog po={po} warehouses={warehouses} onClose={() => setShowReturn(false)} />
      )}

      {/* Bill dialog */}
      {showBill && (
        <BillDialog po={po} currencies={currencies} onClose={() => setShowBill(false)} />
      )}

      {/* Edit Freight Costs dialog */}
      {showEditFreight && (
        <EditFreightCostsDialog po={po} currencies={currencies} onClose={() => setShowEditFreight(false)} />
      )}

      {/* Invoices / Bills history */}
      {po.invoices.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 text-sm font-medium"
            onClick={() => setShowInvoices((v) => !v)}
          >
            <span>Bills ({po.invoices.length})</span>
            {showInvoices ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showInvoices && (
            <div className="divide-y">
              {po.invoices.map((inv) => (
                <div key={inv.id} className="px-4 py-3 text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {inv.invoiceNumber ?? 'No invoice number'}
                    </span>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{new Date(inv.invoiceDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      <span className="font-mono font-medium text-foreground">{inv.totalForeign.toFixed(2)}{sym}</span>
                      {inv.supplierInvoiceUrl && (
                        <a
                          href={`/api${inv.supplierInvoiceUrl}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1"
                        >
                          <FileText className="h-3 w-3" />PDF
                        </a>
                      )}
                    </div>
                  </div>
                  {inv.notes && <p className="text-muted-foreground text-xs">{inv.notes}</p>}
                  <table className="w-full text-xs">
                    <tbody className="divide-y">
                      {inv.lines.map((il) => (
                        <tr key={il.id}>
                          <td className="py-1 pr-4">
                            <ProductLink productId={il.productId} sku={il.sku} name={il.productName} />
                          </td>
                          <td className="py-1 pr-4 text-right tabular-nums">{il.qtyBilled}</td>
                          <td className="py-1 text-right font-mono">{il.totalForeign.toFixed(2)}{sym}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
