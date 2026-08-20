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
import { useStepUpReauth, isFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import {
  settleAccountingSyncRow,
  type SettleAccountingSyncRowInput,
  type SettleAccountingSyncRowResult,
} from '@/app/actions/accounting-settlement'

/**
 * o3d-nf9i + o3d-osl8 item 2 — the operator's end of the ONE settlement mechanism.
 *
 * DELIBERATELY MINIMAL. o3d-osl8's own scope note records that growing an operator-workflow tail is
 * what sank PR #590, so this is a statement of fact and nothing else: which outcome you verified,
 * and — for POSTED — the external document id you read in the accounting system. No queues, no
 * assignment, no notes-and-comments, no bulk mode.
 *
 * THE WORDING IS THE HONEST ONE, and that is a requirement rather than a style choice. The system
 * CANNOT determine this: a FAILED row does not prove nothing posted (o3d-ju8t — the remote call is
 * made before the result is written back), and a PROCESSING claim on a retired connector cannot be
 * checked from here at all. So this dialog never says "this did not post"; it records that the
 * OPERATOR says so, with their name and the time against it.
 *
 * WHAT MAKES THE ASSERTION SAFE TO OFFER AT ALL is o3d-e2mz's attempt fence, and the control's whole
 * job on this side is to carry `attemptRevision` back unchanged. The operator judged ONE attempt;
 * the server refuses the decision if the row has since moved to another. A row with no attempt
 * revision cannot be fenced, so the control is DISABLED with the reason rather than offering a
 * button whose only possible answer is a refusal.
 */
type SettleSyncRowProps = {
  syncLogId: string
  /** The status the operator is being SHOWN — passed straight back as half of the fence. */
  status: string
  /**
   * The attempt the operator is being SHOWN — the other half. Passed back rather than re-read,
   * because a value the server re-reads for itself cannot detect that the row moved between the
   * operator forming a judgement and the write landing. That is the entire point of the fence.
   */
  attemptRevision: number
  type: string
  referenceType: string
  referenceId: string
  /** Whether this row admits an assertion at all — status, type and attempt all permitting. */
  settleable: boolean
  /** Why not. Rendered in place of the control: a silently absent button reads as "nothing to do". */
  notSettleableReason: string | null
  /** What the operator should know before asserting. Facts, not a recommendation. */
  caveat: string | null
  onSettled: () => void
}

/**
 * The trigger, and NOTHING that needs a session.
 *
 * The dialog is a separate component MOUNTED ONLY WHILE IT IS OPEN, which is not a cosmetic split:
 * `useStepUpReauth` calls next-auth's `useSession`, which throws outside a <SessionProvider>. This
 * control renders inside the /sync server render (the stranded-row table in the connector-orphan
 * banner), where there is no provider — so a hook at this level took the whole page down, in every
 * one of the page's own render tests. Mounting it with the dialog also means one `useSession`
 * subscription while a dialog is open rather than one per row in a fifty-row table.
 */
export function SettleSyncRowControl(props: SettleSyncRowProps) {
  const { status, attemptRevision, settleable, notSettleableReason } = props
  const [open, setOpen] = useState(false)

  // Stated, never silently omitted. A reader who can SEE a stuck row and is shown no control has no
  // way to tell "this is fine" from "this cannot be fixed from here", and the second is the truth.
  if (!settleable) {
    return (
      <span className="text-[11px] opacity-70" title={notSettleableReason ?? undefined}>
        not settleable
      </span>
    )
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        title={`Settle this row — record what actually happened in the accounting system (attempt ${attemptRevision}, currently ${status})`}
        onClick={() => setOpen(true)}
      >
        <Gavel className="h-3 w-3" />
      </Button>
      {open && <SettleSyncRowDialog {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function SettleSyncRowDialog({
  syncLogId,
  status,
  attemptRevision,
  type,
  referenceType,
  referenceId,
  caveat,
  onSettled,
  onClose,
}: SettleSyncRowProps & { onClose: () => void }) {
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [outcome, setOutcome] = useState<'POSTED' | 'NOT_POSTED' | null>(null)
  const [externalId, setExternalId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!outcome) return
    setBusy(true)
    setError(null)
    const input: SettleAccountingSyncRowInput = outcome === 'POSTED'
      ? { observedStatus: status, observedAttemptRevision: attemptRevision, outcome: 'POSTED', externalTransactionId: externalId.trim() }
      : { observedStatus: status, observedAttemptRevision: attemptRevision, outcome: 'NOT_POSTED', reason: reason.trim() }
    const run = (): Promise<SettleAccountingSyncRowResult> => settleAccountingSyncRow(syncLogId, input)
    // `finally`, not a plain `setBusy(false)` on the happy path. The action can REJECT rather than
    // return a result — a server-side throw arrives here as a rejected promise — and without this
    // the dialog would sit spinning forever with both buttons disabled and no explanation, which is
    // precisely how the unhandled P2002 on the POSTED branch used to present. The action now
    // translates the collisions it knows about into results, but the client must not depend on the
    // server having thought of every throw.
    try {
      let result = await run()
      // requireFreshPermission('sync'): a ledger-affecting assertion needs a recently re-verified
      // session, so a stale one is re-authed in place and the action retried ONCE.
      if (isFreshAuthFailure(result) && (await promptReauth())) result = await run()
      if (result.success) {
        onClose()
        onSettled()
      } else {
        setError(result.error ?? 'Could not settle this row.')
      }
    } catch {
      // Deliberately does NOT promise nothing happened: an unexpected throw cannot tell us that.
      setError('The server did not return a result for this settlement. Reload and check the row before trying again.')
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
            <DialogTitle>Settle sync row</DialogTitle>
            <DialogDescription>
              {type.replace(/_/g, ' ')} for {referenceType} {referenceId} — currently {status}, attempt {attemptRevision}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">
              IMS cannot tell whether this reached the accounting system: the remote call is made before the
              result is written back, so a failed or stuck row may or may not have posted a real document.
              Check the accounting system, then record what you found. This is your assertion — it is logged
              against your account, and it applies to attempt {attemptRevision} only: if the row has moved on
              since this page was rendered, it will be refused rather than applied to a different attempt.
            </p>
            {caveat && <p className="text-xs font-medium">{caveat}</p>}
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
                  from the ambiguous-retry set, so the remaining attempt can be re-driven. If a document turns
                  up after all, the connector records its id on this row anyway and the order stays blocked —
                  evidence outranks an assertion.
                </p>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
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
