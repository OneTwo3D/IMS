'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  createPeg, getPegCandidatesForSalesLine, removePeg,
  type PegCandidate, type SalesOrderPegRow,
} from '@/app/actions/pegging'

/** The "pegged" badge shown on a sales-order line that stock received on a purchase order is allocated to first. */
export function PeggedBadge({ title }: { title?: string }) {
  return (
    <span
      className="ml-2 inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-900 dark:text-sky-100"
      title={title ?? 'Stock received on the pegged purchase order is allocated to this line first'}
      data-pegged
    >
      Pegged
    </span>
  )
}

type PegLine = { id: string; productId: string | null; sku: string; description: string; qty: number }

/**
 * SO-to-PO pegging on a sales order: each line's live pegs, a "Peg to PO" picker listing the open purchase-order lines for the
 * line's product that still have unreceived, unpegged quantity, and a remove button. Allocation ordering only: IMS-internal.
 * `canPeg` is the same permission as manual allocation (sales.process).
 */
export function SoPegsCard({ lines, pegs, canPeg, pegOpen }: { lines: PegLine[]; pegs: SalesOrderPegRow[]; canPeg: boolean; pegOpen: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [pickerLine, setPickerLine] = useState<PegLine | null>(null)
  const [candidates, setCandidates] = useState<PegCandidate[] | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [qty, setQty] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pegged = new Map<string, SalesOrderPegRow[]>()
  for (const peg of pegs) pegged.set(peg.salesOrderLineId, [...(pegged.get(peg.salesOrderLineId) ?? []), peg])
  const pegLines = lines.filter((line) => line.productId && (pegged.has(line.id) || (canPeg && pegOpen)))
  if (pegLines.length === 0) return null

  function openPicker(line: PegLine) {
    setPickerLine(line); setCandidates(null); setSelected(''); setQty(''); setError(null)
    getPegCandidatesForSalesLine(line.id).then(setCandidates).catch(() => setError('Could not load purchase order lines'))
  }

  function submit() {
    if (!pickerLine) return
    const value = Number(qty)
    if (!selected) { setError('Choose a purchase order line'); return }
    if (!Number.isFinite(value) || value <= 0) { setError('Enter a quantity greater than zero'); return }
    startTransition(async () => {
      const result = await createPeg({ salesOrderLineId: pickerLine.id, purchaseOrderLineId: selected, qty: value })
      if (result.success) { setPickerLine(null); router.refresh() } else setError(result.error)
    })
  }

  function remove(pegId: string) {
    startTransition(async () => {
      const result = await removePeg(pegId)
      if (result.success) router.refresh(); else setError(result.error)
    })
  }

  return (
    <div className="rounded-lg border bg-card" data-peg-card>
      <div className="border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Pegged to purchase orders</h3>
        <p className="text-xs text-muted-foreground">Stock received on a pegged purchase order is allocated to this order first; any remainder follows the normal oldest-order-first rule. IMS-internal: nothing is sent anywhere.</p>
      </div>
      <div className="divide-y">
        {pegLines.map((line) => (
          <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
            <div>
              <span className="font-mono text-xs">{line.sku}</span> <span>{line.description}</span> <span className="text-muted-foreground">x {line.qty}</span>
              {(pegged.get(line.id) ?? []).map((peg) => (
                <div key={peg.id} className="mt-1 flex items-center gap-2 text-xs">
                  <PeggedBadge />
                  <span>
                    {peg.qty} on <Link href={`/purchase-orders/${peg.poId}`} className="underline underline-offset-2">{peg.poReference}</Link>
                    {' '}({peg.receivedQty} received, {peg.allocatedQty} allocated)
                  </span>
                  {canPeg && <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => remove(peg.id)}>Remove</Button>}
                </div>
              ))}
            </div>
            {canPeg && pegOpen && <Button type="button" variant="outline" size="sm" onClick={() => openPicker(line)}>Peg to PO</Button>}
          </div>
        ))}
      </div>
      {error && !pickerLine && <Alert variant="destructive" className="m-3"><AlertDescription>{error}</AlertDescription></Alert>}

      <Dialog open={pickerLine !== null} onOpenChange={(open) => { if (!open) setPickerLine(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Peg {pickerLine?.sku} to a purchase order</DialogTitle></DialogHeader>
          {candidates === null && <p className="text-sm text-muted-foreground">Loading open purchase order lines...</p>}
          {candidates !== null && candidates.length === 0 && <p className="text-sm text-muted-foreground">No open purchase order line for this product has unreceived, unpegged quantity.</p>}
          {candidates !== null && candidates.length > 0 && (
            <div className="space-y-2">
              {candidates.map((c) => (
                <label key={c.purchaseOrderLineId} className="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-muted">
                  <input type="radio" name="peg-po-line" checked={selected === c.purchaseOrderLineId} onChange={() => { setSelected(c.purchaseOrderLineId); setQty(String(Math.min(c.available, pickerLine?.qty ?? c.available))) }} />
                  <span className="font-mono text-xs">{c.poReference}</span>
                  <span>{c.supplierName ?? ''}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{c.available} unreceived{c.expectedDelivery ? `, due ${c.expectedDelivery.slice(0, 10)}` : ''}</span>
                </label>
              ))}
              <div className="space-y-1">
                <Label htmlFor="peg-qty" className="text-xs">Quantity to peg</Label>
                <Input id="peg-qty" type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} className="h-8 w-32 font-mono text-sm" />
              </div>
            </div>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPickerLine(null)}>Cancel</Button>
            <Button type="button" disabled={isPending || !selected} onClick={submit}>Peg</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
