'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { submitSupplierQuote, type SupplierPoRow, type SupplierRfqLine } from '@/app/actions/supplier-portal'

type Props = {
  po: SupplierPoRow
  lines: SupplierRfqLine[]
}

export function SupplierRfqClient({ po, lines }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [supplierRef, setSupplierRef] = useState('')
  const [expectedDelivery, setExpectedDelivery] = useState('')
  const [shippingCost, setShippingCost] = useState('')
  const [shippingMethod, setShippingMethod] = useState('')
  const [quoteLines, setQuoteLines] = useState(
    lines.map((l) => ({ lineId: l.id, qty: l.qty, unitPrice: 0 })),
  )

  function updateLine(lineId: string, field: 'qty' | 'unitPrice', value: number) {
    setQuoteLines((prev) => prev.map((l) => l.lineId === lineId ? { ...l, [field]: value } : l))
  }

  function handleSubmit() {
    setError('')
    if (!supplierRef.trim()) { setError('Please enter your PO/reference number'); return }

    startTransition(async () => {
      const result = await submitSupplierQuote(po.id, {
        lines: quoteLines,
        supplierRef: supplierRef.trim(),
        expectedDelivery,
        shippingCost: parseFloat(shippingCost) || 0,
        shippingMethod: shippingMethod.trim(),
      })
      if (result.success) {
        setSuccess(true)
        router.refresh()
      } else {
        setError(result.error ?? 'Failed')
      }
    })
  }

  if (success) {
    return (
      <div className="rounded-md border p-8 text-center space-y-3">
        <h2 className="text-lg font-semibold text-green-700">Quote Submitted</h2>
        <p className="text-sm text-muted-foreground">Your quote for {po.reference} has been submitted. The buyer will review it.</p>
        <Button variant="outline" onClick={() => router.push('/supplier/rfqs')}>Back to RFQs</Button>
      </div>
    )
  }

  const canQuote = po.status === 'RFQ_SENT' || po.status === 'DRAFT'

  return (
    <div className="space-y-6">
      {/* Line items */}
      <div className="rounded-md border">
        <div className="px-4 py-2 bg-muted/50 border-b">
          <h2 className="text-sm font-medium">Items Requested</h2>
        </div>
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead className="px-4 text-xs">Product</TableHead>
              <TableHead className="px-4 text-xs">SKU</TableHead>
              <TableHead className="px-4 text-xs text-right w-24">Qty Requested</TableHead>
              {canQuote && <>
                <TableHead className="px-4 text-xs text-right w-24">Your Qty</TableHead>
                <TableHead className="px-4 text-xs text-right w-28">Unit Price ({po.currency})</TableHead>
                <TableHead className="px-4 text-xs text-right w-24">Line Total</TableHead>
              </>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const ql = quoteLines[i]
              const lineTotal = (ql?.qty ?? 0) * (ql?.unitPrice ?? 0)
              return (
                <TableRow key={l.id}>
                  <TableCell className="px-4">{l.productName}</TableCell>
                  <TableCell className="px-4 font-mono text-xs text-muted-foreground">{l.productSku}</TableCell>
                  <TableCell className="px-4 text-right tabular-nums">{l.qty}</TableCell>
                  {canQuote && <>
                    <TableCell className="px-4">
                      <Input type="number" min={0} value={ql?.qty ?? l.qty} onChange={(e) => updateLine(l.id, 'qty', Number(e.target.value))} className="h-7 w-20 text-xs text-right font-mono ml-auto" />
                    </TableCell>
                    <TableCell className="px-4">
                      <Input type="number" min={0} step={0.01} value={ql?.unitPrice || ''} onChange={(e) => updateLine(l.id, 'unitPrice', Number(e.target.value))} placeholder="0.00" className="h-7 w-24 text-xs text-right font-mono ml-auto" />
                    </TableCell>
                    <TableCell className="px-4 text-right font-mono text-xs">{lineTotal > 0 ? lineTotal.toFixed(2) : '—'}</TableCell>
                  </>}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* Quote details */}
      {canQuote && (
        <div className="rounded-md border p-4 space-y-4">
          <h2 className="text-sm font-medium">Your Quote Details</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Your PO / Reference Number *</Label>
              <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} placeholder="e.g. INV-12345" className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Estimated Delivery Date</Label>
              <Input type="date" value={expectedDelivery} onChange={(e) => setExpectedDelivery(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Shipping Cost ({po.currency})</Label>
              <Input type="number" min={0} step={0.01} value={shippingCost} onChange={(e) => setShippingCost(e.target.value)} placeholder="0.00" className="h-9 text-sm font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Shipping Method</Label>
              <Input value={shippingMethod} onChange={(e) => setShippingMethod(e.target.value)} placeholder="e.g. DHL Express, Sea Freight" className="h-9 text-sm" />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end">
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Submit Quote
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
