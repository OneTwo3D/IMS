'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { deleteSyncedPurchaseBill, deleteSyncedSalesInvoice, resumeSyncedDocumentDelete } from '@/app/actions/accounting-document-delete'
import type { DocumentDeleteUiState } from '@/lib/domain/accounting/document-delete-service'

/**
 * The Delete control for a synced invoice or bill (o3d-ngmt.21). Shows nothing when the state says so (switch off, no permission, never
 * pushed); a button and a confirm dialog when the document is eligible; and the reason, in place of the button, when it is not.
 */
export function DeleteSyncedDocument({ kind, documentId, state }: { kind: 'SALES_INVOICE' | 'PURCHASE_BILL'; documentId: string; state: DocumentDeleteUiState | undefined }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isPending, startTransition] = useTransition()
  if (!state || !state.show) return null
  const what = kind === 'SALES_INVOICE' ? 'invoice' : 'bill'

  if (!state.eligible) {
    const resume = () => {
      setError('')
      startTransition(async () => {
        const result = await resumeSyncedDocumentDelete(kind, documentId)
        if (result.success) { setNotice(result.notice ?? 'Resumed.'); router.refresh() } else setError(result.error ?? 'Could not resume.')
      })
    }
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground max-w-xl" data-testid="delete-synced-document-reason">{state.review ? state.reason : `Cannot delete: ${state.reason}`}</p>
        {state.review && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={resume} disabled={isPending}>Resume</Button>}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        {notice && <p className="text-xs text-muted-foreground max-w-xl">{notice}</p>}
      </div>
    )
  }

  const confirm = () => {
    setError('')
    startTransition(async () => {
      const result = kind === 'SALES_INVOICE' ? await deleteSyncedSalesInvoice(documentId) : await deleteSyncedPurchaseBill(documentId)
      if (result.success) {
        setNotice(result.notice ?? 'Delete queued.')
        setOpen(false)
        router.refresh()
      } else {
        setError(result.error ?? `Could not delete the ${what}.`)
      }
    })
  }

  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" className="h-7 text-xs text-destructive" onClick={() => { setError(''); setOpen(true) }} disabled={isPending}>
        <Trash2 className="h-3 w-3 mr-1" />Delete {what}
      </Button>
      {notice && <p className="text-xs text-muted-foreground max-w-xl">{notice}</p>}
      <Dialog open={open} onOpenChange={(next) => { if (!isPending) setOpen(next) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {state.label}?</DialogTitle>
            <DialogDescription>
              This deletes the {what} in IMS and in Xero together. In Xero its number is changed first (a random suffix is added) so the original number is free for a replacement, then the document is deleted, or voided if it has been authorised. IMS is updated when Xero confirms. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
            <Button variant="destructive" onClick={confirm} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}Delete {what}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
