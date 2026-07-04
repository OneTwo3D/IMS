'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  approveHsCodeProposal,
  rejectHsCodeProposal,
  type HsProposalRow,
} from '@/app/actions/hs-proposals'

type Props = { initialProposals: HsProposalRow[] }

function bandVariant(band: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (band === 'high') return 'default'
  if (band === 'medium') return 'secondary'
  return 'destructive'
}

export function HsReviewClient({ initialProposals }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<HsProposalRow | null>(null)
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  function openReview(row: HsProposalRow) {
    setSelected(row)
    setCode(row.proposedHsCode ?? '')
    setNote('')
    setError('')
  }

  function close() {
    setSelected(null)
    setError('')
  }

  function handleApprove() {
    if (!selected) return
    setError('')
    startTransition(async () => {
      const result = await approveHsCodeProposal({
        proposalId: selected.id,
        hsCode: code.trim(),
        reviewNote: note.trim() || undefined,
      })
      if (result.success) {
        close()
        router.refresh()
      } else {
        setError(result.error ?? 'Approval failed.')
      }
    })
  }

  function handleReject() {
    if (!selected) return
    setError('')
    startTransition(async () => {
      const result = await rejectHsCodeProposal({
        proposalId: selected.id,
        reviewNote: note.trim() || undefined,
      })
      if (result.success) {
        close()
        router.refresh()
      } else {
        setError(result.error ?? 'Rejection failed.')
      }
    })
  }

  if (initialProposals.length === 0) {
    return <p className="text-sm text-muted-foreground">No HS code proposals awaiting review.</p>
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Proposed code</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Flags</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialProposals.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-medium">{row.sku}</div>
                <div className="text-xs text-muted-foreground">{row.productName}</div>
              </TableCell>
              <TableCell>
                <span className="font-mono">{row.proposedHsCode ?? '—'}</span>
                {!row.declarable && (
                  <Badge variant="destructive" className="ml-2">not declarable</Badge>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={bandVariant(row.band)}>
                  {row.band} · {row.confidence}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.flags.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    row.flags.map((f) => (
                      <Badge key={f} variant="outline" className="text-xs">{f}</Badge>
                    ))
                  )}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.source}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" onClick={() => openReview(row)} disabled={isPending}>
                  Review
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review HS code — {selected?.sku}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{selected.productName}</p>
              <p className="text-sm">{selected.reasoning || 'No reasoning provided.'}</p>

              <div className="space-y-1">
                <Label htmlFor="hsCode">HS / CN code (8 digits)</Label>
                <Input
                  id="hsCode"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono"
                  placeholder="e.g. 85011099"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="note">Review note (optional)</Label>
                <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={isPending}>
              {isPending ? '…' : 'Reject'}
            </Button>
            <Button onClick={handleApprove} disabled={isPending}>
              {isPending ? 'Approving…' : 'Approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
