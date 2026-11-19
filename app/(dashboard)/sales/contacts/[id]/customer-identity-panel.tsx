'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Users, Building2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { mergeCustomersAction, previewMergeAction, unmergeCustomerAction, type CustomerIdentityView, type MergePreview } from '@/app/actions/customer-identity'

/** Accepts a customer id or a pasted customer page address (/sales/contacts/<id>). */
export function customerIdFromInput(value: string): string {
  const trimmed = value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function CustomerIdentityPanel({ identity }: { identity: CustomerIdentityView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [other, setOther] = useState('')
  const merged = identity.members.length > 1

  // A merge or unmerge is made in two steps: the operator first sees WHO is affected (names and emails), then confirms. The server action refuses without the confirmation.
  const [preview, setPreview] = useState<Extract<MergePreview, { success: true }> | null>(null)
  const [confirmUnmerge, setConfirmUnmerge] = useState(false)

  function run(action: () => Promise<{ success: boolean; error?: string }>, after?: () => void) {
    setError('')
    startTransition(async () => {
      const result = await action()
      if (result.success) {
        setOther('')
        setPreview(null)
        setConfirmUnmerge(false)
        after?.()
        router.refresh()
      } else setError(result.error ?? 'The change failed')
    })
  }

  function startMerge(otherId: string) {
    setError('')
    setConfirmUnmerge(false)
    startTransition(async () => {
      const result = await previewMergeAction(identity.customerId, otherId)
      if (result.success) setPreview(result)
      else setError(result.error)
    })
  }

  const others = identity.members.filter((m) => m.id !== identity.customerId && !m.anonymised)
  const self = identity.members.find((m) => m.id === identity.customerId)

  return (
    <Card className="p-5 max-w-5xl space-y-4" data-testid="customer-identity">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2"><Users className="h-4 w-4" />Same person ({identity.members.length})</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Customer records with the same email (ignoring case, a +tag and Gmail dots) are shown together as one person. The original records are kept; nothing is deleted.
        </p>
      </div>
      <ul className="divide-y text-sm">
        {identity.members.map((m) => (
          <li key={m.id} className="py-1.5 flex items-center justify-between gap-3">
            <span>
              {m.id === identity.customerId ? <span className="font-medium">{m.fullName}</span> : <Link href={`/sales/contacts/${m.id}`} className="text-primary hover:underline">{m.fullName}</Link>}
              {m.email && <span className="ml-2 text-muted-foreground">{m.email}</span>}
              {m.anonymised && <span className="ml-2 text-xs text-orange-600">anonymised</span>}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{m.orderCount} order{m.orderCount === 1 ? '' : 's'}</span>
          </li>
        ))}
      </ul>
      {identity.truncated && <p className="text-xs text-amber-700">This person has more records than can be shown; the list is partial.</p>}
      {identity.canMerge && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {merged && (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => { setPreview(null); setConfirmUnmerge(true) }}>
              Separate this customer
            </Button>
          )}
          <Input className="h-8 w-72 text-xs" placeholder="Customer id or page address to merge with" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Customer to merge with" />
          <Button size="sm" disabled={pending || customerIdFromInput(other) === ''} onClick={() => startMerge(customerIdFromInput(other))}>
            {pending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Merge
          </Button>
        </div>
      )}
      {identity.canMerge && preview && (
        <div role="alertdialog" aria-label="Confirm merge" className="rounded-md border border-amber-500/50 p-3 space-y-2 text-sm" data-testid="merge-confirmation">
          <p className="font-medium">Merge these two customers as the same person?</p>
          <ul className="space-y-1">
            {[preview.a, preview.b].map((c) => (
              <li key={c.id}><strong>{c.fullName || c.id}</strong>{c.email && <span className="ml-2 text-muted-foreground">{c.email}</span>}{c.company && <span className="ml-2 text-muted-foreground">{c.company}</span>}<span className="ml-2 text-xs text-muted-foreground">{c.orderCount} order{c.orderCount === 1 ? '' : 's'}</span></li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">An erasure of either one will then anonymise both. You can separate them again later. Merging asks you to have signed in recently.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => mergeCustomersAction(identity.customerId, preview.b.id === identity.customerId ? preview.a.id : preview.b.id, true))}>Confirm merge</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setPreview(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {identity.canMerge && confirmUnmerge && (
        <div role="alertdialog" aria-label="Confirm separate" className="rounded-md border border-amber-500/50 p-3 space-y-2 text-sm" data-testid="unmerge-confirmation">
          <p className="font-medium">Separate <strong>{self?.fullName}</strong>{self?.email && <span className="text-muted-foreground"> ({self.email})</span>} from the same person?</p>
          <ul className="space-y-1">
            {others.map((m) => <li key={m.id}>{m.fullName || m.id}{m.email && <span className="ml-2 text-muted-foreground">{m.email}</span>}</li>)}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => unmergeCustomerAction(identity.customerId, true))}>Confirm separate</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmUnmerge(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}

      {(identity.company.peers.length > 0) && (
        <div className="border-t pt-3 space-y-2" data-testid="customer-company-group">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Building2 className="h-4 w-4" />Other customers at this company ({identity.company.peers.length}{identity.company.truncated ? '+' : ''})</h3>
          <p className="text-xs text-muted-foreground">
            Grouped by {[identity.company.nameKey && 'billing company name', identity.company.domain && `email domain ${identity.company.domain}`].filter(Boolean).join(' or ')}. Grouping is only a view; it does not merge anyone.
          </p>
          <ul className="divide-y text-sm">
            {identity.company.peers.map((p) => (
              <li key={p.id} className="py-1.5 flex items-center justify-between gap-3">
                <span>
                  <Link href={`/sales/contacts/${p.id}`} className="text-primary hover:underline">{p.fullName || p.id}</Link>
                  {p.email && <span className="ml-2 text-muted-foreground">{p.email}</span>}
                  {p.company && <span className="ml-2 text-muted-foreground">{p.company}</span>}
                </span>
                {identity.canMerge && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={pending} onClick={() => startMerge(p.id)}>Merge as same person</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
