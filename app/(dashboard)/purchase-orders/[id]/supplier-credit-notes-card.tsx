'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { recordSupplierFreightCreditNote, postSupplierCreditNote, type SupplierCreditNoteRow } from '@/app/actions/purchase-orders'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// audit-g5u2.5: record/post supplier credit notes against a (freight) PO and show
// the block-reason context — once a credit note is POSTED and fully offsets the
// bill, an invoiced freight PO becomes cancellable (g5u2.4).
export function SupplierCreditNotesCard({
  poId,
  currency,
  hasInvoices,
  creditNotes,
}: {
  poId: string
  currency: string
  hasInvoices: boolean
  creditNotes: SupplierCreditNoteRow[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Track WHICH action is in flight so posting one draft doesn't disable every
  // other row + the dialog (Codex review): 'record' for the dialog, or a credit
  // note id for its Post button.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [creditNoteNumber, setCreditNoteNumber] = useState('')
  const [error, setError] = useState('')

  // Nothing to show and nothing to do (no bill to credit) → render nothing.
  if (creditNotes.length === 0 && !hasInvoices) return null

  function submitRecord() {
    setError('')
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter a credit amount greater than 0.')
      return
    }
    setBusyId('record')
    startTransition(async () => {
      const res = await recordSupplierFreightCreditNote({
        poId,
        amountForeign: amt,
        reason: reason.trim() || undefined,
        creditNoteNumber: creditNoteNumber.trim() || undefined,
      })
      setBusyId(null)
      if (!res.success) {
        setError(res.error ?? 'Failed to record the credit note.')
        return
      }
      setOpen(false)
      setAmount('')
      setReason('')
      setCreditNoteNumber('')
      router.refresh()
    })
  }

  function post(id: string) {
    setError('')
    setBusyId(id)
    startTransition(async () => {
      const res = await postSupplierCreditNote(id)
      setBusyId(null)
      if (!res.success) {
        setError(res.error ?? 'Failed to post the credit note.')
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 text-sm font-medium">
        <span>Supplier credit notes ({creditNotes.length})</span>
        {hasInvoices && (
          <Button size="sm" variant="outline" onClick={() => { setError(''); setOpen(true) }}>
            <Plus className="h-4 w-4 mr-1" />Record credit note
          </Button>
        )}
      </div>

      {creditNotes.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No credit notes. Record one to offset a duplicate or over-charged supplier bill — once posted and fully offsetting the bill, an invoiced freight PO can be cancelled.
        </p>
      ) : (
        <div className="divide-y">
          {creditNotes.map((cn) => (
            <div key={cn.id} className="px-4 py-3 text-sm flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{cn.creditNoteNumber ?? cn.reference ?? 'Credit note'}</span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    cn.status === 'POSTED'
                      ? 'border-green-200 bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800'
                      : 'border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                  }`}
                >
                  {cn.status}
                </span>
                {cn.reason && <span className="text-muted-foreground truncate">· {cn.reason}</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-medium tabular-nums">{currency} {cn.amountForeign.toFixed(2)}</span>
                {cn.status === 'DRAFT' && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => post(cn.id)}>
                    {busyId === cn.id ? 'Posting…' : 'Post'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !open && <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p>}

      <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record supplier credit note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="cn-amount">Amount ({currency})</Label>
              <Input id="cn-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cn-number">Supplier credit note number (optional)</Label>
              <Input id="cn-number" value={creditNoteNumber} onChange={(e) => setCreditNoteNumber(e.target.value)} placeholder="e.g. CN-1234" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cn-reason">Reason (optional)</Label>
              <Input id="cn-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate freight bill" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={submitRecord} disabled={pending}>{busyId === 'record' ? 'Recording…' : 'Record (draft)'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
