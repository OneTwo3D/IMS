'use client'

import { useState, useTransition, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { X, Plus, Pencil, Truck, PackageCheck, Ban, Undo2, ChevronDown, ChevronRight, Loader2, FileText, Mail, Receipt, Upload, Ship, ExternalLink, CreditCard, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  advancePoStatus,
  updatePoTracking,
  cancelPurchaseOrder,
  receivePurchaseOrder,
  returnPurchaseOrder,
  createInvoice,
  updateFreightPoCosts,
  markBillPaid,
  getBillPaymentAccounts,
  type PoDetail,
  type PoStatus,
  type InvoiceRow,
} from '@/app/actions/purchase-orders'
import type {
  MintsoftCreatePurchaseOrderAsnInput,
  MintsoftPurchaseOrderAsnState,
} from '@/app/actions/mintsoft-sync'
import { createMintsoftPurchaseOrderAsn } from '@/app/actions/mintsoft-sync'
import { getTrackingUrl } from '@/lib/tracking'
import type { AccountingBankAccount } from '@/lib/accounting'
import type { SupplierRow } from '@/app/actions/suppliers'
import type { ProductRow } from '@/app/actions/products'
import type { CurrencyRow } from '@/app/actions/currencies'
import type { TaxRateRow, PurchaseUnitRow } from '@/app/actions/settings'
import { ProductLink } from '@/components/inventory/product-link'
import { ProductThumb } from '@/components/inventory/product-thumb'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { formatMoney } from '@/lib/utils'
import { PoFormDialog } from '../po-form'

type Warehouse = { id: string; code: string; name: string }

type Props = {
  po: PoDetail
  suppliers: SupplierRow[]
  products: ProductRow[]
  warehouses: Warehouse[]
  currencies: CurrencyRow[]
  taxRates: TaxRateRow[]
  purchaseUnits: PurchaseUnitRow[]
  carriers: string[]
  companyHomeCountry?: string | null
  accountingAvailable: boolean
  accountingBillUrlTemplate: string
  mintsoftAsnState: MintsoftPurchaseOrderAsnState
}

const STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Draft',
  RFQ_SENT: 'RFQ Sent',
  QUOTE_RECEIVED: 'Quote Received',
  PO_SENT: 'PO Sent',
  SHIPPED: 'Shipped',
  PARTIALLY_RECEIVED: 'Partially Received',
  RECEIVED: 'Received',
  CLOSED: 'Closed',
  INVOICED: 'Invoiced',
  PARTIALLY_RETURNED: 'Partially Returned',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
}

const STATUS_CLASS: Record<PoStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground border-muted',
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
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Product</TableHead>
                <TableHead className="text-xs text-right w-16">Ordered</TableHead>
                <TableHead className="text-xs text-right w-20">Received</TableHead>
                <TableHead className="text-xs text-right w-20">Remaining</TableHead>
                <TableHead className="text-xs text-right w-24">Receive Now</TableHead>
                <TableHead className="text-xs">Warehouse</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receiptLines.map((l) => (
                <TableRow key={l.poLineId}>
                  <TableCell>
                    <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{l.qtyOrdered}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{l.qtyAlreadyReceived}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.qtyRemaining}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={l.qtyRemaining}
                      step={1}
                      value={l.qtyToReceive}
                      onChange={(e) => updateLine(l.poLineId, 'qtyToReceive', Number(e.target.value))}
                      className="h-7 text-sm text-right w-24 ml-auto font-mono"
                    />
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

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

          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Product</TableHead>
                <TableHead className="text-xs text-right w-20">Received</TableHead>
                <TableHead className="text-xs text-right w-20">Returned</TableHead>
                <TableHead className="text-xs text-right w-24">Returnable</TableHead>
                <TableHead className="text-xs text-right w-24">Return Now</TableHead>
                <TableHead className="text-xs">From Warehouse</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {returnLines.map((l) => (
                <TableRow key={l.poLineId}>
                  <TableCell>
                    <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{l.qtyReceived}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{l.qtyAlreadyReturned > 0 ? l.qtyAlreadyReturned : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{l.netReturnable}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={l.netReturnable}
                      step={1}
                      value={l.qtyToReturn}
                      onChange={(e) => updateLine(l.poLineId, 'qtyToReturn', Number(e.target.value))}
                      className="h-7 text-sm text-right w-24 ml-auto font-mono"
                    />
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

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

function MintsoftAsnDialog({
  po,
  onClose,
}: {
  po: PoDetail
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [packagingType, setPackagingType] = useState<NonNullable<MintsoftCreatePurchaseOrderAsnInput['packagingType']>>('PARCEL')
  const [packageCount, setPackageCount] = useState('1')
  const [eta, setEta] = useState(po.expectedDelivery?.slice(0, 10) ?? '')
  const [supplierReference, setSupplierReference] = useState(po.supplierRef ?? '')
  const [carrier, setCarrier] = useState('')
  const [autoCallback, setAutoCallback] = useState(true)
  const [error, setError] = useState('')

  const outstandingLines = po.lines.filter((line) => line.qtyToReceive > 0)

  function handleConfirm() {
    setError('')

    const parsedPackageCount = Number.parseInt(packageCount, 10)
    if (!Number.isFinite(parsedPackageCount) || parsedPackageCount <= 0) {
      setError('Enter a valid package count.')
      return
    }

    startTransition(async () => {
      const result = await createMintsoftPurchaseOrderAsn(po.id, {
        packagingType,
        packageCount: parsedPackageCount,
        eta: eta || null,
        supplierReference: supplierReference || null,
        carrier: carrier || null,
        autoCallback,
      } satisfies MintsoftCreatePurchaseOrderAsnInput)

      if (result.success) {
        router.refresh()
        onClose()
        return
      }

      setError(result.error ?? 'Failed to create Mintsoft ASN')
    })
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !isPending) onClose()
    }}>
      <DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create Mintsoft ASN</DialogTitle>
          <DialogDescription>
            Mintsoft will receive the PO&apos;s outstanding quantities in base stock units. The callback can be disabled if this warehouse is not ready to process booked-in webhooks yet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Product</TableHead>
                <TableHead className="text-xs text-right w-32">Outstanding Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outstandingLines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{line.qtyToReceive}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mintsoftPackagingType">Packaging Type</Label>
              <Select
                id="mintsoftPackagingType"
                value={packagingType}
                onChange={(event) => setPackagingType(event.target.value as typeof packagingType)}
                className="h-9 rounded-md px-3"
              >
                <option value="PARCEL">Parcel</option>
                <option value="PALLET">Pallet</option>
                <option value="CONTAINER">Container</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mintsoftPackageCount">Package Count</Label>
              <Input
                id="mintsoftPackageCount"
                type="number"
                min={1}
                step={1}
                value={packageCount}
                onChange={(event) => setPackageCount(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mintsoftEta">ETA</Label>
              <Input
                id="mintsoftEta"
                type="date"
                value={eta}
                onChange={(event) => setEta(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mintsoftCarrier">Carrier</Label>
              <Input
                id="mintsoftCarrier"
                value={carrier}
                onChange={(event) => setCarrier(event.target.value)}
                placeholder="e.g. DPD, DHL Freight"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="mintsoftSupplierReference">Supplier Reference</Label>
              <Input
                id="mintsoftSupplierReference"
                value={supplierReference}
                onChange={(event) => setSupplierReference(event.target.value)}
                placeholder="Optional supplier or shipment reference"
              />
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={autoCallback}
              onChange={(event) => setAutoCallback(event.target.checked)}
            />
            <span>
              <span className="font-medium">Enable booked-in callback</span>
              <span className="block text-muted-foreground">
                When enabled, Mintsoft will call back into IMS when the ASN is booked in so the PO receipt can be reconciled automatically.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Mintsoft ASN
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
  qty: number
  qtyReceived: number
  alreadyBilled: number
  remaining: number
  unitCostForeign: number
  selected: boolean
  qtyBilled: number
  /** Effective per-line VAT rate (0..1). Falls back to PO-level rate when
   *  the line has no override. */
  taxRatePercent: number
}

type BillCostLineState = {
  costLineId: string
  originalDescription: string
  description: string
  amountForeign: number
  vatable: boolean
  remaining: number
  selected: boolean
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
  const baseCurrency = useBaseCurrency()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [step, setStep] = useState<1 | 2>(1)
  const [error, setError] = useState('')

  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const billSym = symbolMap[po.currency] ?? po.currency
  const billSymPos = positionMap[po.currency] ?? 'PREFIX'
  const billMoney = (n: number) => formatMoney(n, billSym, billSymPos)

  // All PO lines with remaining qty are billable — even if goods haven't been
  // received yet. Default quantity to the already-received amount when there
  // is one, otherwise default to the full ordered qty so the supplier can be
  // billed ahead of (or independently from) receiving — capped at remaining.
  const [billLines, setBillLines] = useState<BillLineState[]>(
    po.lines
      .filter((l) => l.qty - l.qtyBilled > 0)
      .map((l) => {
        const remaining = l.qty - l.qtyBilled
        const preferred = l.qtyReceived > 0 ? l.qtyReceived : l.qty
        const qtyBilled = Math.min(preferred, remaining)
        return {
          poLineId: l.id,
          productId: l.productId,
          sku: l.sku,
          productName: l.productName,
          qty: l.qty,
          qtyReceived: l.qtyReceived,
          alreadyBilled: l.qtyBilled,
          remaining,
          unitCostForeign: l.unitCostForeign,
          selected: true,
          qtyBilled,
          // Per-line tax rate: use the saved per-line rate when set (mixed-VAT
          // order), otherwise fall back to the order-level PO rate.
          taxRatePercent: l.taxRatePercent ?? po.taxRatePercent ?? 0,
        }
      }),
  )

  const [billCostLines, setBillCostLines] = useState<BillCostLineState[]>(
    po.freightCostLines
      .filter((c) => c.amountForeign - c.amountBilled > 0)
      .map((c) => {
        const remaining = c.amountForeign - c.amountBilled
        return {
          costLineId: c.id,
          originalDescription: c.description,
          description: c.description,
          amountForeign: remaining,
          vatable: c.vatable,
          remaining,
          selected: false,
        }
      }),
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
  const selectedCostLines = billCostLines.filter((l) => l.selected && l.amountForeign > 0)
  // `unitCostForeign` on a PO line is always NET, so the net line total is
  // just qty * unitCost. VAT is computed per line off its effective rate so
  // mixed-VAT bills render a correct breakdown.
  const productSubtotal = selectedLines.reduce((s, l) => s + l.qtyBilled * l.unitCostForeign, 0)
  const costSubtotal = selectedCostLines.reduce((s, l) => s + l.amountForeign, 0)
  const subtotal = productSubtotal + costSubtotal
  const poRate = po.taxRatePercent ?? 0
  const vatTotal =
    selectedLines.reduce((s, l) => s + l.qtyBilled * l.unitCostForeign * l.taxRatePercent, 0)
    + selectedCostLines.reduce((s, l) => s + (l.vatable ? l.amountForeign * poRate : 0), 0)
  const grandTotal = subtotal + vatTotal
  // Build a grouped VAT breakdown so mixed-rate bills show one row per rate.
  const vatByRate = new Map<number, number>()
  for (const l of selectedLines) {
    if (l.taxRatePercent <= 0) continue
    const lineVat = l.qtyBilled * l.unitCostForeign * l.taxRatePercent
    vatByRate.set(l.taxRatePercent, (vatByRate.get(l.taxRatePercent) ?? 0) + lineVat)
  }
  for (const l of selectedCostLines) {
    if (!l.vatable || poRate <= 0) continue
    const lineVat = l.amountForeign * poRate
    vatByRate.set(poRate, (vatByRate.get(poRate) ?? 0) + lineVat)
  }
  const vatBreakdown = Array.from(vatByRate.entries()).sort((a, b) => b[0] - a[0])

  const hasAnySelection = selectedLines.length > 0 || selectedCostLines.length > 0

  function toggleLine(poLineId: string) {
    setBillLines((prev) => prev.map((l) => l.poLineId === poLineId ? { ...l, selected: !l.selected } : l))
  }

  function toggleAll(checked: boolean) {
    setBillLines((prev) => prev.map((l) => ({ ...l, selected: checked })))
    setBillCostLines((prev) => prev.map((l) => ({ ...l, selected: checked })))
  }

  function toggleCostLine(costLineId: string) {
    setBillCostLines((prev) => prev.map((l) => l.costLineId === costLineId ? { ...l, selected: !l.selected } : l))
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
    if (!hasAnySelection) { setError('Select at least one line'); return }
    if (!invoiceDate) { setError('Invoice date is required'); return }

    startTransition(async () => {
      const result = await createInvoice(po.id, {
        invoiceNumber: invoiceNumber || undefined,
        invoiceDate,
        dueDate: dueDate || undefined,
        notes: notes || undefined,
        supplierInvoiceUrl: supplierInvoiceUrl || undefined,
        lines: [
          ...selectedLines.map((l) => ({
            kind: 'product' as const,
            poLineId: l.poLineId,
            qtyBilled: l.qtyBilled,
            unitCostForeign: l.unitCostForeign,
          })),
          ...selectedCostLines.map((l) => ({
            kind: 'cost' as const,
            costLineId: l.costLineId,
            description: l.description,
            amountForeign: l.amountForeign,
          })),
        ],
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
      <DialogContent showCloseButton={false} className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? 'Create Bill — Select Items' : 'Create Bill — Review & Confirm'}
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Select the line items to include in this bill:</p>
            {billLines.length > 0 && (
              <Table className="rounded-md border min-w-[500px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={billLines.every((l) => l.selected) && billCostLines.every((l) => l.selected)}
                        onChange={(e) => toggleAll(e.target.checked)}
                        className="rounded border-input"
                      />
                    </TableHead>
                    <TableHead className="text-xs">Product</TableHead>
                    <TableHead className="text-xs text-right w-28">Remaining / Received</TableHead>
                    <TableHead className="text-xs text-right w-32">Unit Cost ({billSym})</TableHead>
                    <TableHead className="text-xs text-right w-28">Total ({billSym})</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billLines.map((l) => (
                    <TableRow key={l.poLineId} className={l.selected ? '' : 'opacity-40'}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={l.selected}
                          onChange={() => toggleLine(l.poLineId)}
                          className="rounded border-input"
                        />
                      </TableCell>
                      <TableCell>
                        <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.remaining}
                        <span className="text-muted-foreground"> / {l.qtyReceived}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{l.unitCostForeign.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{billMoney(l.qtyBilled * l.unitCostForeign)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {billCostLines.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Additional Costs</p>
                <Table className="rounded-md border">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs text-right w-32">Remaining ({billSym})</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billCostLines.map((l) => (
                      <TableRow key={l.costLineId} className={l.selected ? '' : 'opacity-40'}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={l.selected}
                            onChange={() => toggleCostLine(l.costLineId)}
                            className="rounded border-input"
                          />
                        </TableCell>
                        <TableCell>{l.originalDescription}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{billMoney(l.remaining)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {/* Invoice details */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
            {selectedLines.length > 0 && (
              <Table className="rounded-md border">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Product</TableHead>
                    <TableHead className="text-xs text-right w-24">Qty to Bill</TableHead>
                    <TableHead className="text-xs text-right w-32">Unit Cost ({billSym})</TableHead>
                    <TableHead className="text-xs text-right w-28">Total ({billSym})</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedLines.map((l) => (
                    <TableRow key={l.poLineId}>
                      <TableCell>
                        <ProductLink productId={l.productId} sku={l.sku} name={l.productName} />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number" min={0} max={l.remaining} step={1}
                          value={l.qtyBilled}
                          onChange={(e) => setBillLines((prev) => prev.map((bl) => bl.poLineId === l.poLineId ? { ...bl, qtyBilled: Number(e.target.value) || 0 } : bl))}
                          className="h-7 text-sm text-right w-24 ml-auto font-mono"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number" min={0} step={0.01}
                          value={l.unitCostForeign}
                          onChange={(e) => setBillLines((prev) => prev.map((bl) => bl.poLineId === l.poLineId ? { ...bl, unitCostForeign: Number(e.target.value) || 0 } : bl))}
                          className="h-7 text-sm text-right w-32 ml-auto font-mono"
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{billMoney(l.qtyBilled * l.unitCostForeign)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {selectedCostLines.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Additional Costs</p>
                <Table className="rounded-md border">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs text-right w-32">Amount ({billSym})</TableHead>
                      <TableHead className="text-xs text-right w-28">Total ({billSym})</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedCostLines.map((l) => (
                      <TableRow key={l.costLineId}>
                        <TableCell>
                          <Input
                            value={l.description}
                            onChange={(e) => setBillCostLines((prev) => prev.map((cl) => cl.costLineId === l.costLineId ? { ...cl, description: e.target.value } : cl))}
                            className="h-7 text-sm"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number" min={0} max={l.remaining} step={0.01}
                            value={l.amountForeign}
                            onChange={(e) => setBillCostLines((prev) => prev.map((cl) => cl.costLineId === l.costLineId ? { ...cl, amountForeign: Number(e.target.value) || 0 } : cl))}
                            className="h-7 text-sm text-right w-32 ml-auto font-mono"
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{billMoney(l.amountForeign)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Totals */}
            <div className="flex justify-end text-sm">
              <div className="min-w-56 space-y-1">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-mono">{billMoney(subtotal)}</span>
                </div>
                {vatBreakdown.length === 0 ? (
                  <div className="flex justify-between text-muted-foreground">
                    <span>VAT</span>
                    <span className="font-mono">{billMoney(0)}</span>
                  </div>
                ) : (
                  vatBreakdown.map(([rate, amount]) => (
                    <div key={rate} className="flex justify-between text-muted-foreground">
                      <span>VAT @ {(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 1)}%</span>
                      <span className="font-mono">{billMoney(amount)}</span>
                    </div>
                  ))
                )}
                <div className="flex justify-between font-medium border-t pt-1">
                  <span>Total</span>
                  <span className="font-mono">{billMoney(grandTotal)}</span>
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
            <Button onClick={() => { if (!hasAnySelection) { setError('Select at least one line'); return }; setError(''); setStep(2) }}>
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
// Pay Bill dialog — mark a supplier bill as paid and push payment to the accounting connector
// ---------------------------------------------------------------------------

function PayBillDialog({
  po,
  invoice,
  onClose,
}: {
  po: PoDetail
  invoice: InvoiceRow
  onClose: () => void
}) {
  const baseCurrency = useBaseCurrency()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [accounts, setAccounts] = useState<AccountingBankAccount[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [bankAccountId, setBankAccountId] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [reference, setReference] = useState(invoice.invoiceNumber ?? '')

  const sym = po.currency === baseCurrency.code ? baseCurrency.symbol : po.currency
  const symPos = po.currency === baseCurrency.code ? baseCurrency.symbolPosition : 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)

  // Load bank accounts on mount
  useEffect(() => {
    let cancelled = false
    getBillPaymentAccounts()
      .then((list) => {
        if (cancelled) return
        setAccounts(list)
        if (list.length > 0) setBankAccountId(list[0].id)
        setLoadingAccounts(false)
      })
      .catch(() => {
        if (cancelled) return
        setError('Failed to load bank accounts. Make sure the accounting chart of accounts has been synced.')
        setLoadingAccounts(false)
      })
    return () => { cancelled = true }
  }, [])

  const handleSubmit = () => {
    setError('')
    if (!bankAccountId) { setError('Select a bank account'); return }
    if (!paymentDate) { setError('Payment date is required'); return }

    startTransition(async () => {
      const result = await markBillPaid(invoice.id, {
        bankAccountId,
        paymentDate,
        reference: reference || undefined,
      })
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed to mark bill as paid')
      }
    })
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark Bill as Paid</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3 bg-muted/30 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bill</span>
              <span className="font-medium">{invoice.invoiceNumber ?? '(no number)'}</span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-mono font-medium">{money(invoice.totalForeign)}</span>
            </div>
          </div>

          <div>
            <Label htmlFor="bank-account" className="text-xs">Bank Account</Label>
            {loadingAccounts ? (
              <div className="text-xs text-muted-foreground py-2">Loading accounts...</div>
            ) : accounts.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">
                No bank accounts found. Sync your accounting chart of accounts first.
              </div>
            ) : (
              <select
                id="bank-account"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code ? `${a.code} — ${a.name}` : a.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <Label htmlFor="payment-date" className="text-xs">Payment Date</Label>
            <Input
              id="payment-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="h-9 text-sm"
            />
          </div>

          <div>
            <Label htmlFor="payment-ref" className="text-xs">Reference (optional)</Label>
            <Input
              id="payment-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Payment reference"
              className="h-9 text-sm"
            />
          </div>

          {!invoice.accountingInvoiceId && (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/30 p-2 text-xs text-yellow-800 dark:text-yellow-200">
              This bill has not yet been synced to your accounting system. The payment will be
              recorded locally only — no external payment will be posted.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-700 dark:text-red-200">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending || loadingAccounts || !bankAccountId}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
            Mark Paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const baseCurrency = useBaseCurrency()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')

  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const fSym = symbolMap[po.currency] ?? po.currency
  const fSymPos = positionMap[po.currency] ?? 'PREFIX'
  const fMoney = (n: number) => formatMoney(n, fSym, fSymPos)

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
      <DialogContent showCloseButton={false} className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Landed Costs — {po.reference}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Update cost amounts to reflect actual charges. Linked primary PO line costs and COGS will be recalculated automatically.
          </p>

          <div className="space-y-2">
            {costLines.map((cl) => (
              <div key={cl.key} className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Description"
                  value={cl.description}
                  onChange={(e) => setCostLines((p) => p.map((c) => c.key === cl.key ? { ...c, description: e.target.value } : c))}
                  className="flex-1 min-w-[140px] h-8 text-sm"
                />
                <div className="flex items-center gap-2">
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
            <span>Total: {fMoney(subtotal)}</span>
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
// Ship dialog — enter carrier + tracking number
// ---------------------------------------------------------------------------

function ShipDialog({
  poId,
  carriers,
  initialProvider,
  initialTracking,
  editMode,
  onClose,
}: {
  poId: string
  carriers: string[]
  initialProvider?: string | null
  initialTracking?: string | null
  editMode?: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [provider, setProvider] = useState(initialProvider ?? '')
  const [tracking, setTracking] = useState(initialTracking ?? '')
  const [error, setError] = useState('')

  function handleConfirm() {
    setError('')
    startTransition(async () => {
      const result = editMode
        ? await updatePoTracking(poId, { shippingProvider: provider || undefined, trackingNumber: tracking || undefined })
        : await advancePoStatus(poId, 'SHIPPED', { shippingProvider: provider || undefined, trackingNumber: tracking || undefined })
      if (result.success) {
        router.refresh()
        onClose()
      } else {
        setError(result.error ?? 'Failed')
      }
    })
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editMode ? 'Edit Tracking Info' : 'Mark as Shipped'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="shipProvider">Carrier / Shipping Provider</Label>
            <select
              id="shipProvider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              <option value="">Select carrier…</option>
              {carriers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shipTracking">Tracking Number</Label>
            <Input
              id="shipTracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="e.g. 1Z999AA10123456784"
              className="h-9 text-sm font-mono"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {editMode ? 'Save' : 'Mark Shipped'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main detail component
// ---------------------------------------------------------------------------

export function PoDetailClient({ po: initialPo, suppliers, products, warehouses, currencies, taxRates, purchaseUnits, carriers, companyHomeCountry, accountingAvailable, accountingBillUrlTemplate, mintsoftAsnState }: Props) {
  const baseCurrency = useBaseCurrency()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const po = initialPo

  // Currency symbol + position lookup
  const symbolMap: Record<string, string> = { [baseCurrency.code]: baseCurrency.symbol }
  const positionMap: Record<string, 'PREFIX' | 'POSTFIX'> = { [baseCurrency.code]: baseCurrency.symbolPosition }
  for (const c of currencies) {
    symbolMap[c.code] = c.symbol
    positionMap[c.code] = c.symbolPosition
  }
  const sym = symbolMap[po.currency] ?? po.currency
  const symPos = positionMap[po.currency] ?? 'PREFIX'
  const money = (n: number) => formatMoney(n, sym, symPos)
  const baseMoney = (n: number) => formatMoney(n, baseCurrency.symbol, baseCurrency.symbolPosition)

  const [editing, setEditing] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [showReturn, setShowReturn] = useState(false)
  const [showBill, setShowBill] = useState(false)
  const [showShip, setShowShip] = useState(false)
  const [showMintsoftAsn, setShowMintsoftAsn] = useState(false)
  const [showEditTracking, setShowEditTracking] = useState(false)
  const [showEditFreight, setShowEditFreight] = useState(false)
  const [showReceipts, setShowReceipts] = useState(false)
  const [showReturns, setShowReturns] = useState(false)
  const [showInvoices, setShowInvoices] = useState(false)
  const [payBillFor, setPayBillFor] = useState<InvoiceRow | null>(null)
  const [error, setError] = useState('')

  const canEdit = po.status === 'DRAFT'
  const canRfq = po.status === 'DRAFT' || po.status === 'RFQ_SENT'
  const canAdvanceToQuoteReceived = po.status === 'RFQ_SENT'
  const canAdvanceToOrdered = po.status === 'DRAFT' || po.status === 'QUOTE_RECEIVED'
  const canShip = po.status === 'PO_SENT'
  const canReceive = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(po.status)
  const canReturn = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED'].includes(po.status)
  const canClose = po.status === 'RECEIVED'
  const hasBillableProduct = po.lines.some((l) => l.qty - l.qtyBilled > 0)
  const hasBillableCost = po.freightCostLines.some((c) => c.amountForeign - c.amountBilled > 0)
  const hasBillableItems = hasBillableProduct || hasBillableCost
  const canBill = ['PO_SENT', 'SHIPPED', 'RFQ_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'PARTIALLY_RETURNED'].includes(po.status) && hasBillableItems
  const canCancel = po.status === 'DRAFT'
  const hasRemaining = po.lines.some((l) => l.qtyToReceive > 0)
  const hasReturnable = po.lines.some((l) => l.qtyReceived - l.qtyReturned > 0)

  function handleAdvanceToOrdered() {
    setError('')
    startTransition(async () => {
      const result = await advancePoStatus(po.id, 'PO_SENT')
      if (result.success) router.refresh()
      else setError(result.error ?? 'Failed')
    })
  }

  function handleAdvanceToQuoteReceived() {
    setError('')
    startTransition(async () => {
      const result = await advancePoStatus(po.id, 'QUOTE_RECEIVED')
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

  function handleClose() {
    if (!confirm('Close this purchase order? This is a terminal status.')) return
    setError('')
    startTransition(async () => {
      const result = await advancePoStatus(po.id, 'CLOSED')
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
          {canAdvanceToQuoteReceived && !editing && (
            <Button variant="secondary" size="sm" onClick={handleAdvanceToQuoteReceived} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
              Quote Received
            </Button>
          )}
          {canAdvanceToOrdered && !editing && (
            <Button size="sm" onClick={handleAdvanceToOrdered} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Truck className="h-4 w-4 mr-1" />}
              Confirm &amp; Send PO
            </Button>
          )}
          {canShip && !editing && (
            <Button variant="secondary" size="sm" onClick={() => setShowShip(true)} disabled={isPending}>
              <Ship className="h-4 w-4 mr-1" />Mark Shipped
            </Button>
          )}
          {canReceive && hasRemaining && (
            <Button size="sm" onClick={() => setShowReceive(true)} disabled={isPending}>
              <PackageCheck className="h-4 w-4 mr-1" />Receive Goods
            </Button>
          )}
          {mintsoftAsnState.pluginEnabled && mintsoftAsnState.canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowMintsoftAsn(true)}
              disabled={isPending || !mintsoftAsnState.canCreate}
              title={mintsoftAsnState.canCreate ? undefined : (mintsoftAsnState.blockedReason ?? undefined)}
            >
              <Upload className="h-4 w-4 mr-1" />Create Mintsoft ASN
            </Button>
          )}
          {canReturn && hasReturnable && (
            <Button variant="outline" size="sm" onClick={() => setShowReturn(true)} disabled={isPending}>
              <Undo2 className="h-4 w-4 mr-1" />Return Items
            </Button>
          )}
          {accountingAvailable && canBill && (
            <Button variant="outline" size="sm" onClick={() => setShowBill(true)} disabled={isPending}>
              <Receipt className="h-4 w-4 mr-1" />Create Bill
            </Button>
          )}
          {po.type === 'FREIGHT' && po.status !== 'CANCELLED' && (
            <Button variant="outline" size="sm" onClick={() => setShowEditFreight(true)} disabled={isPending}>
              <Pencil className="h-4 w-4 mr-1" />Edit Costs
            </Button>
          )}
          {canClose && !editing && (
            <Button variant="secondary" size="sm" onClick={handleClose} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
              Close PO
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
      <div className="rounded-md border p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Supplier</span>
            <p className="font-medium">
              {po.supplierId ? (
                <Link
                  href={`/purchase-orders/suppliers?edit=${po.supplierId}`}
                  target="_blank"
                  className="hover:underline decoration-muted-foreground underline-offset-2"
                >
                  {po.supplierName}
                </Link>
              ) : (
                po.supplierName
              )}
            </p>
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
              {po.currency !== baseCurrency.code && <span className="text-muted-foreground ml-1 text-xs">1 {baseCurrency.code} = {po.fxRateToBase} {sym}</span>}
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
          {(po.shippingProvider || po.trackingNumber) && (
            <div className="col-span-2">
              <span className="text-muted-foreground flex items-center gap-1">
                Tracking
                {['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status) && (
                  <button onClick={() => setShowEditTracking(true)} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </span>
              <p className="font-medium flex items-center gap-2">
                {po.shippingProvider && <span>{po.shippingProvider}</span>}
                {po.trackingNumber && (() => {
                  const url = getTrackingUrl(po.shippingProvider, po.trackingNumber)
                  return url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                      {po.trackingNumber}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="font-mono text-xs">{po.trackingNumber}</span>
                  )
                })()}
              </p>
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

      {/* Edit dialog — reuses the New PO dialog in edit mode */}
      {editing && (
        <PoFormDialog
          suppliers={suppliers}
          products={products}
          warehouses={warehouses}
          currencies={currencies}
          taxRates={taxRates}
          purchaseUnits={purchaseUnits}
          companyHomeCountry={companyHomeCountry}
          existingPo={po}
          onClose={() => { setEditing(false); router.refresh() }}
        />
      )}

      {(mintsoftAsnState.pluginEnabled || mintsoftAsnState.existingAsns.length > 0) && (
        <div className="rounded-md border p-4 space-y-3">
          <div>
            <div>
              <h2 className="text-sm font-medium">Mintsoft ASN</h2>
              <p className="text-sm text-muted-foreground">
                Destination warehouse: {mintsoftAsnState.destinationWarehouseCode ?? '—'}
                {mintsoftAsnState.bindingExternalWarehouseId ? ` · Mintsoft warehouse ${mintsoftAsnState.bindingExternalWarehouseId}` : ''}
              </p>
            </div>
          </div>

          {!mintsoftAsnState.canCreate && mintsoftAsnState.blockedReason && (
            <p className="text-sm text-muted-foreground">{mintsoftAsnState.blockedReason}</p>
          )}

          {mintsoftAsnState.existingAsns.length > 0 ? (
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">External ASN</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">Lines</TableHead>
                  <TableHead className="text-xs text-right">Expected</TableHead>
                  <TableHead className="text-xs text-right">Received</TableHead>
                  <TableHead className="text-xs">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mintsoftAsnState.existingAsns.map((asn) => (
                  <TableRow key={asn.id}>
                    <TableCell className="font-mono text-xs font-medium">{asn.externalAsnId}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{asn.status}</div>
                      <div className="text-muted-foreground">
                        {asn.closedAt ? `Closed ${new Date(asn.closedAt).toLocaleDateString('en-GB')}` : 'Open'}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{asn.lineCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{asn.totalExpectedQty}</TableCell>
                    <TableCell className="text-right tabular-nums">{asn.totalReceivedQty}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(asn.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No Mintsoft ASN has been created for this purchase order yet.</p>
          )}
        </div>
      )}

      {/* Lines table */}
      <div className="rounded-md border">
          <div className="border-b px-4 py-2 bg-muted/50">
            <h2 className="text-sm font-medium">Order Lines</h2>
          </div>
          <Table className="min-w-[800px]">
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="w-12 px-2" />
                <TableHead className="px-4 text-xs">Product</TableHead>
                <TableHead className="px-4 text-xs text-right w-44">Qty</TableHead>
                <TableHead className="px-4 text-xs text-right w-32">
                  Unit Cost ({sym})
                </TableHead>
                {po.lines.some((l) => l.discountAmount > 0) && (
                  <TableHead className="px-4 text-xs text-right w-24">Discount</TableHead>
                )}
                {po.currency !== baseCurrency.code && (
                  <TableHead className="px-4 text-xs text-right w-28">Unit Cost (£)</TableHead>
                )}
                {po.totalLandedCostBase > 0 && (
                  <TableHead className="px-4 text-xs text-right w-28">Gross Cost (£)</TableHead>
                )}
                <TableHead className="px-4 text-xs text-right w-28">Total ({sym})</TableHead>
                <TableHead className="px-4 text-xs text-right w-20">Received</TableHead>
                <TableHead className="px-4 text-xs text-right w-20">Returned</TableHead>
                <TableHead className="px-4 text-xs text-right w-20">On Hand</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.lines.map((line) => (
                <TableRow key={line.id} className={line.qtyRemaining === 0 && line.qtyReturned === 0 ? 'opacity-60' : ''}>
                  <TableCell className="w-12 px-2 py-1">
                    <ProductThumb productId={line.productId} imageUrl={line.imageUrl} name={line.productName} />
                  </TableCell>
                  <TableCell className="px-4">
                    <ProductLink productId={line.productId} sku={line.sku} name={line.productName} />
                  </TableCell>
                  <TableCell className="px-4 text-right tabular-nums whitespace-nowrap">
                    {line.purchaseUnitQty != null ? (
                      <span>
                        <span>{line.purchaseUnitQty} {line.purchaseUnitName}</span>
                        <span className="text-muted-foreground text-xs ml-1">({line.qty} {line.purchaseUnitStockName ?? 'pcs'})</span>
                      </span>
                    ) : line.qty}
                  </TableCell>
                  <TableCell className="px-4 text-right tabular-nums font-mono text-xs">{line.unitCostForeign.toFixed(2)}</TableCell>
                  {po.lines.some((l) => l.discountAmount > 0) && (
                    <TableCell className="px-4 text-right tabular-nums font-mono text-xs text-destructive">
                      {line.discountAmount > 0 ? (line.discountStr ?? formatMoney(-line.discountAmount, sym)) : '—'}
                    </TableCell>
                  )}
                  {po.currency !== baseCurrency.code && (
                    <TableCell className="px-4 text-right tabular-nums font-mono text-xs text-muted-foreground">
                      {baseMoney(line.unitCostBase)}
                    </TableCell>
                  )}
                  {po.totalLandedCostBase > 0 && (
                    <TableCell className="px-4 text-right tabular-nums font-mono text-xs font-medium">
                      {baseMoney(line.grossUnitCostBase)}
                    </TableCell>
                  )}
                  <TableCell className="px-4 text-right tabular-nums font-mono text-xs">
                    {money(line.totalForeign)}
                    {line.taxRatePercent != null && po.taxRatePercent != null && Math.abs(line.taxRatePercent - po.taxRatePercent) > 0.0001 && (
                      <span className="ml-1 inline-flex items-center rounded-sm border border-amber-300 bg-amber-50 px-1 py-0 text-[10px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                        {(line.taxRatePercent * 100).toFixed(line.taxRatePercent * 100 % 1 === 0 ? 0 : 1)}%
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 text-right tabular-nums text-green-700 dark:text-green-400">{line.qtyReceived > 0 ? line.qtyReceived : '—'}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums text-orange-600 dark:text-orange-400">{line.qtyReturned > 0 ? line.qtyReturned : '—'}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums">{line.qtyRemaining > 0 ? line.qtyRemaining : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot className="border-t bg-muted/30 text-sm">
              {(() => {
                const hasDiscountCol = po.lines.some((l) => l.discountAmount > 0)
                const labelSpan = 3 + (hasDiscountCol ? 1 : 0) + (po.currency !== baseCurrency.code ? 1 : 0) + (po.totalLandedCostBase > 0 ? 1 : 0)
                // Total discount = sum of line discounts + order-level
                // discount. The stored `subtotalForeign` is already
                // post-discount; we surface the breakdown for clarity.
                const totalLineDiscounts = po.lines.reduce((s, l) => s + l.discountAmount, 0)
                const totalAllDiscounts = totalLineDiscounts + po.orderDiscountForeign
                return <>
                  <tr>
                    <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">Subtotal</td>
                    <td className="px-4 py-1.5 text-right tabular-nums font-mono">{money(po.subtotalForeign)}</td>
                    <td colSpan={3} />
                  </tr>
                  {totalAllDiscounts > 0 && (
                    <tr>
                      <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-destructive">
                        Total Discount
                        {totalLineDiscounts > 0 && po.orderDiscountForeign > 0
                          ? ` (lines: ${money(totalLineDiscounts)} + order: ${money(po.orderDiscountForeign)})`
                          : po.orderDiscountForeign > 0
                          ? ' (order)'
                          : ' (lines)'}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums font-mono text-destructive">−{money(totalAllDiscounts)}</td>
                      <td colSpan={3} />
                    </tr>
                  )}
                  {po.taxForeign > 0 && (
                    <tr>
                      <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">{po.taxRateName ?? 'VAT'}{po.taxRatePercent != null ? ` (${(po.taxRatePercent * 100).toFixed(0)}%)` : ''}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums font-mono">{money(po.taxForeign)}</td>
                      <td colSpan={3} />
                    </tr>
                  )}
                  {po.directFreightForeign > 0 && (
                    <tr>
                      <td colSpan={labelSpan} className="px-4 py-1.5 text-right text-muted-foreground">Additional Costs</td>
                      <td className="px-4 py-1.5 text-right tabular-nums font-mono">{money(po.directFreightForeign)}</td>
                      <td colSpan={3} />
                    </tr>
                  )}
                  <tr className="border-t">
                    <td colSpan={labelSpan} className="px-4 py-2 text-right font-medium text-muted-foreground">Total</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">
                      <span className="font-semibold">{money(po.totalForeign)}</span>
                      {po.currency !== baseCurrency.code && (
                        <span className="text-muted-foreground font-normal text-xs ml-1">({baseMoney(po.totalBase)})</span>
                      )}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </>
              })()}
            </tfoot>
          </Table>
        </div>

      {/* Receipts */}
      {/* Linked Freight / Landed Cost POs */}
      {po.linkedFreightPos.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <div className="px-4 py-2 bg-muted/50 text-sm font-medium flex items-center gap-2">
            <Ship className="h-4 w-4 text-muted-foreground" />
            Linked Landed Cost POs ({po.linkedFreightPos.length})
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              Total landed cost: {baseMoney(po.totalLandedCostBase)}
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
                    <span className="font-mono font-medium">{baseMoney(fl.freightPo.totalBase)}</span>
                    <span className="text-muted-foreground">({fl.method})</span>
                  </div>
                </div>
                {fl.freightPo.costLines.map((cl, i) => (
                  <div key={i} className="flex items-center justify-between text-xs text-muted-foreground pl-4">
                    <span>{cl.description}</span>
                    <span className="font-mono">{baseMoney(cl.amountBase)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Linked Primary POs (shown on FREIGHT POs) */}
      {po.linkedPrimaryPos.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
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
                  <span className="font-mono font-medium">{baseMoney(pp.totalBase)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {po.receipts.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
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
                  <Table className="text-xs">
                    <TableBody>
                      {r.lines.map((rl) => (
                        <TableRow key={rl.id}>
                          <TableCell className="py-1 pr-4">
                            <ProductLink productId={rl.productId} sku={rl.sku} name={rl.productName} />
                          </TableCell>
                          <TableCell className="py-1 pr-4 text-right tabular-nums">{rl.qtyReceived}</TableCell>
                          <TableCell className="py-1 text-muted-foreground">{rl.warehouseName ?? rl.warehouseId ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Returns history */}
      {po.returns.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
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
                  <Table className="text-xs">
                    <TableBody>
                      {r.lines.map((rl) => (
                        <TableRow key={rl.id}>
                          <TableCell className="py-1 pr-4">
                            <ProductLink productId={rl.productId} sku={rl.sku} name={rl.productName} />
                          </TableCell>
                          <TableCell className="py-1 pr-4 text-right tabular-nums">{rl.qtyReturned}</TableCell>
                          <TableCell className="py-1 text-muted-foreground">{rl.warehouseId ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Ship dialog */}
      {showShip && (
        <ShipDialog poId={po.id} carriers={carriers} onClose={() => setShowShip(false)} />
      )}

      {/* Edit tracking dialog */}
      {showEditTracking && (
        <ShipDialog poId={po.id} carriers={carriers} initialProvider={po.shippingProvider} initialTracking={po.trackingNumber} editMode onClose={() => setShowEditTracking(false)} />
      )}

      {/* Receive dialog */}
      {showReceive && (
        <ReceiveDialog po={po} warehouses={warehouses} onClose={() => setShowReceive(false)} />
      )}

      {/* Mintsoft ASN dialog */}
      {showMintsoftAsn && (
        <MintsoftAsnDialog po={po} onClose={() => setShowMintsoftAsn(false)} />
      )}

      {/* Return dialog */}
      {showReturn && (
        <ReturnDialog po={po} warehouses={warehouses} onClose={() => setShowReturn(false)} />
      )}

      {/* Bill dialog */}
      {accountingAvailable && showBill && (
        <BillDialog po={po} currencies={currencies} onClose={() => setShowBill(false)} />
      )}

      {/* Pay Bill dialog */}
      {accountingAvailable && payBillFor && (
        <PayBillDialog po={po} invoice={payBillFor} onClose={() => setPayBillFor(null)} />
      )}

      {/* Edit Freight Costs dialog */}
      {showEditFreight && (
        <EditFreightCostsDialog po={po} currencies={currencies} onClose={() => setShowEditFreight(false)} />
      )}

      {/* Invoices / Bills history */}
      {accountingAvailable && po.invoices.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
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
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {inv.invoiceNumber ?? 'No invoice number'}
                      </span>
                      {inv.paidAt && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800">
                          <CheckCircle2 className="h-3 w-3" />
                          Paid
                          {inv.paymentAccountName && ` · ${inv.paymentAccountName}`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{new Date(inv.invoiceDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      <span className="font-mono font-medium text-foreground">{money(inv.totalForeign)}</span>
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
                      {inv.accountingInvoiceId && (
                        <a
                          href={accountingBillUrlTemplate.replace('{id}', inv.accountingInvoiceId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" />Accounting
                        </a>
                      )}
                      {!inv.paidAt && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => setPayBillFor(inv)}
                          disabled={isPending}
                        >
                          <CreditCard className="h-3 w-3 mr-1" />
                          Mark Paid
                        </Button>
                      )}
                    </div>
                  </div>
                  {inv.paidAt && (
                    <p className="text-[11px] text-muted-foreground">
                      Paid {new Date(inv.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {inv.paymentReference ? ` · ref ${inv.paymentReference}` : ''}
                    </p>
                  )}
                  {inv.notes && <p className="text-muted-foreground text-xs">{inv.notes}</p>}
                  <Table className="text-xs">
                    <TableBody>
                      {inv.lines.map((il) => (
                        <TableRow key={il.id}>
                          <TableCell className="py-1 pr-4">
                            {il.poLineId ? (
                              <ProductLink productId={il.productId} sku={il.sku} name={il.productName} />
                            ) : (
                              <span>{il.description}</span>
                            )}
                          </TableCell>
                          <TableCell className="py-1 pr-4 text-right tabular-nums">{il.poLineId ? il.qtyBilled : ''}</TableCell>
                          <TableCell className="py-1 text-right font-mono">{money(il.totalForeign)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
