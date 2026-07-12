'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  approveHsCodeProposal,
  rejectHsCodeProposal,
  proposeHsCodeForProduct,
  type HsProposalRow,
} from '@/app/actions/hs-proposals'

type Props = { productId: string; proposal: HsProposalRow | null }

function bandVariant(band: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (band === 'high') return 'default'
  if (band === 'medium') return 'secondary'
  return 'destructive'
}

export function HsProposalPanel({ productId, proposal }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [code, setCode] = useState(proposal?.proposedHsCode ?? '')
  const [error, setError] = useState('')

  function run(action: () => Promise<{ success: boolean; error?: string } | unknown>) {
    setError('')
    startTransition(async () => {
      const result = (await action()) as { success?: boolean; error?: string } | null
      if (result && result.success === false) {
        setError(result.error ?? 'Action failed.')
        return
      }
      router.refresh()
    })
  }

  if (!proposal) {
    return (
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          No HS-code proposal for this product. It is classified automatically, or you can run it now.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => run(() => proposeHsCodeForProduct(productId, true))}
        >
          {isPending ? 'Classifying…' : 'Classify'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={bandVariant(proposal.band)}>
          {proposal.band} · {proposal.confidence}
        </Badge>
        {!proposal.declarable && <Badge variant="destructive">not declarable</Badge>}
        <span className="text-xs text-muted-foreground">source: {proposal.source}</span>
        {proposal.flags.map((f) => (
          <Badge key={f} variant="outline" className="text-xs">{f}</Badge>
        ))}
      </div>

      {proposal.reasoning && <p className="text-sm">{proposal.reasoning}</p>}

      <div className="space-y-1">
        <Label htmlFor="hs-panel-code">Proposed HS / CN code (8 digits)</Label>
        <Input
          id="hs-panel-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="font-mono max-w-xs"
          placeholder="e.g. 85011099"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => run(() => approveHsCodeProposal({ proposalId: proposal.id, hsCode: code.trim() }))}
        >
          {isPending ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={isPending}
          onClick={() => run(() => rejectHsCodeProposal({ proposalId: proposal.id }))}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => run(() => proposeHsCodeForProduct(productId, true))}
        >
          Re-classify
        </Button>
      </div>
    </div>
  )
}
