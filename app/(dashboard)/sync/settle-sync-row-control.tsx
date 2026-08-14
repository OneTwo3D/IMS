'use client'

import { useState } from 'react'
import { Loader2, Gavel } from 'lucide-react'
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
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { settleAccountingSyncRow } from '@/app/actions/accounting-settlement'

/**
 * o3d-nf9i + o3d-osl8 — the operator's end of the ONE settlement mechanism.
 *
 * DELIBERATELY MINIMAL. o3d-osl8's own scope note records that growing an operator-workflow
 * tail is what sank PR #590, so this is a statement of fact and nothing else: which outcome
 * you verified, and — for POSTED — the external document id you read in the accounting system.
 * No queues, no assignment, no notes-and-comments, no bulk mode.
 *
 * The wording is the honest one: the system CANNOT determine this. A FAILED row does not prove
 * nothing posted (o3d-ju8t), and a PROCESSING claim on a retired connector cannot be checked
 * from here at all (o3d-sref). The operator has to go and look.
 */
export function SettleSyncRowControl({
  syncLogId,
  status,
  type,
  referenceType,
  referenceId,
  onSettled,
}: {
  syncLogId: string
  /** The status the operator is being SHOWN — passed straight back as the CAS fence. */
  status: string
  type: string
  referenceType: string
  referenceId: string
  onSettled: () => void
}) {
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<'POSTED' | 'NOT_POSTED' | null>(null)
  const [externalId, setExternalId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setOutcome(null)
    setExternalId('')
    setReason('')
    setError(null)
    setBusy(false)
  }

  async function submit() {
    if (!outcome) return
    setBusy(true)
    setError(null)
    const input = outcome === 'POSTED'
      ? { observedStatus: status, outcome: 'POSTED' as const, externalTransactionId: externalId.trim() }
      : { observedStatus: status, outcome: 'NOT_POSTED' as const, reason: reason.trim() }
    const run = () => settleAccountingSyncRow(syncLogId, input) as Promise<MaybeFreshAuthFailure & { success: boolean; error?: string }>
    let result = await run()
    // requireFreshPermission('sync'): a ledger-affecting assertion needs a recently re-verified
    // session, so a stale one is re-authed in place and the action retried ONCE.
    if (isFreshAuthFailure(result) && (await promptReauth())) result = await run()
    setBusy(false)
    if (result.success) {
      setOpen(false)
      reset()
      onSettled()
    } else {
      setError(result.error ?? 'Could not settle this row.')
    }
  }

  return (
    <>
      {stepUpDialog}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        title="Settle this row — record what actually happened in the accounting system"
        onClick={() => { reset(); setOpen(true) }}
      >
        <Gavel className="h-3 w-3" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) reset() }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settle sync row</DialogTitle>
            <DialogDescription>
              {type.replace(/_/g, ' ')} for {referenceType} {referenceId} — currently {status}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">
              IMS cannot tell whether this reached the accounting system: the remote call is made before the
              result is written back, so a failed or stuck row may or may not have posted a real document.
              Check the accounting system, then record what you found. This is your assertion — it is logged
              against your account and it is not reversible from here.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={outcome === 'POSTED' ? 'default' : 'outline'}
                onClick={() => setOutcome('POSTED')}
              >
                It DID post
              </Button>
              <Button
                type="button"
                size="sm"
                variant={outcome === 'NOT_POSTED' ? 'default' : 'outline'}
                onClick={() => setOutcome('NOT_POSTED')}
              >
                It did NOT post
              </Button>
            </div>
            {outcome === 'POSTED' && (
              <div className="space-y-1">
                <Label htmlFor="settle-external-id" className="text-xs">External document id</Label>
                <Input
                  id="settle-external-id"
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  placeholder="e.g. the Xero invoice / payment id"
                />
                <p className="text-[11px] text-muted-foreground">
                  Required. Without it the row records a post that nothing can be reconciled against — and the
                  order stays blocked from deletion either way.
                </p>
              </div>
            )}
            {outcome === 'NOT_POSTED' && (
              <div className="space-y-1">
                <Label htmlFor="settle-reason" className="text-xs">What you checked (optional)</Label>
                <Input
                  id="settle-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. no matching document in the Xero org"
                />
                <p className="text-[11px] text-muted-foreground">
                  The row is CANCELLED with no external id. For a payment or allocation this also removes it
                  from the ambiguous-retry set, so the remaining attempt can be re-driven.
                </p>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              onClick={submit}
              disabled={busy || !outcome || (outcome === 'POSTED' && externalId.trim().length === 0)}
            >
              {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Record this
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
