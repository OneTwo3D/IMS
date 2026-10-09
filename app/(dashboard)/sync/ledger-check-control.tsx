'use client'

import { useEffect, useState } from 'react'
import { ClipboardCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useStepUpReauth, isFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { previewLedgerCheck, recordLedgerCheck } from '@/app/actions/accounting-ledger-check'
import type { LedgerCheckPreview } from '@/lib/domain/accounting/operator-ledger-check-record'
import { LEDGER_CHECK_CONTROL_NAME } from '@/lib/domain/accounting/operator-ledger-check-offer'

/**
 * o3d-llyw (owner decision C4) — "Checked the ledger": the operator's end of the operator ledger check.
 *
 * A receipt is held back because an earlier attempt on its order cannot be ruled out against a ledger
 * settlement IMS cannot read. This dialog shows EXACTLY those settlements (by ledger id), what the earlier
 * attempt sent, and the receipts the check could be for; the operator opens each settlement in Xero and,
 * only if none is that attempt's payment nor a hand-entered copy of the receipt, records the check. The
 * server reads the ledger again and refuses if it no longer shows the same settlements.
 *
 * THE WORDING IS AN ASSERTION, never a statement about the ledger: IMS cannot read those settlements,
 * which is the whole reason this exists. Mounted only while open, like the settlement dialog, because
 * `useStepUpReauth` needs a session provider the server-rendered table does not have.
 */
export function LedgerCheckControl(props: { syncLogId: string; onRecorded: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        title={`${LEDGER_CHECK_CONTROL_NAME}: record that you opened the unreadable ledger settlements holding a receipt back`}
        onClick={() => setOpen(true)}
      >
        <ClipboardCheck className="h-3 w-3" />
      </Button>
      {open && <LedgerCheckDialog {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function LedgerCheckDialog({ syncLogId, onRecorded, onClose }: { syncLogId: string; onRecorded: () => void; onClose: () => void }) {
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [preview, setPreview] = useState<LedgerCheckPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [paymentId, setPaymentId] = useState<string>('')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    previewLedgerCheck(syncLogId)
      .then((result) => {
        if (cancelled) return
        if (result.ok) setPreview(result)
        else setError(result.error)
      })
      .catch(() => { if (!cancelled) setError('The ledger could not be read for this entry. Nothing was recorded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [syncLogId])

  async function submit() {
    if (!preview || !paymentId || !confirmed) return
    setBusy(true)
    setError(null)
    const run = () => recordLedgerCheck({
      syncLogId,
      paymentId,
      recordIds: preview.records.map((record) => record.id),
      note: note.trim() || null,
      confirmed,
    })
    try {
      let result = await run()
      if (isFreshAuthFailure(result) && (await promptReauth())) result = await run()
      if ('ok' in result && result.ok) {
        setDone(result.message)
        onRecorded()
      } else if ('ok' in result) {
        setError(result.error)
      } else {
        setError('Your session needs to be re-verified before a ledger check can be recorded.')
      }
    } catch {
      setError('The server did not return a result. Reload and look at the entry before trying again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {stepUpDialog}
      <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{LEDGER_CHECK_CONTROL_NAME}</DialogTitle>
            <DialogDescription>Entry {syncLogId}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {loading && <p className="text-xs text-muted-foreground"><Loader2 className="inline h-3 w-3 mr-1 animate-spin" />Reading the ledger…</p>}
            {preview && (
              <>
                <p className="text-xs text-muted-foreground">
                  A receipt on this order is held back because IMS cannot rule out {preview.attemptLabel} against the
                  settlement{preview.records.length === 1 ? '' : 's'} below: Xero reports {preview.records.length === 1 ? 'it' : 'them'} with
                  a figure or date IMS cannot read. Open each one on document {preview.ledgerDocumentId} in Xero.
                </p>
                <ul className="text-xs list-disc pl-5">
                  {preview.records.map((record) => (
                    <li key={record.id}>
                      <span className="font-mono">{record.id}</span>
                      {record.unreadableAmount ? ` — stated ${record.unreadableAmount}` : ''}
                      {record.date ? ` — dated ${record.date}` : ' — no readable date'}
                      {record.reference ? ` — reference "${record.reference}"` : ''}
                    </li>
                  ))}
                </ul>
                <div className="space-y-1">
                  <Label className="text-xs">The receipt this check is for</Label>
                  {preview.receipts.map((receipt) => (
                    <label key={receipt.id} className="flex items-center gap-2 text-xs">
                      <input type="radio" name="ledger-check-receipt" value={receipt.id} checked={paymentId === receipt.id} onChange={() => setPaymentId(receipt.id)} />
                      {receipt.currency} {receipt.amount} paid {receipt.paidAt}{receipt.method ? ` (${receipt.method})` : ''} — {receipt.id}
                    </label>
                  ))}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ledger-check-note" className="text-xs">What you looked at (optional)</Label>
                  <Input id="ledger-check-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. opened each payment in the Xero org" />
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
                  <span>
                    I opened every settlement listed above in Xero. None of them is the payment that earlier attempt made,
                    and none is a payment for the chosen receipt that was already entered by hand. This is my assertion and
                    is logged against my account; it covers only these settlement ids, lapses if Xero is reconnected, and a
                    settlement that appears later holds the receipt again.
                  </span>
                </label>
                <p className="text-[11px] text-muted-foreground">
                  If one of them IS that attempt&apos;s payment, do not record a check: settle the entry as posted instead.
                </p>
              </>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {done && <p className="text-xs font-medium">{done}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{done ? 'Close' : 'Cancel'}</Button>
            <Button size="sm" onClick={submit} disabled={busy || !!done || !preview || !paymentId || !confirmed}>
              {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Record check
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
