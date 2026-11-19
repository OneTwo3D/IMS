'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2, Users, Building2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { mergeCustomersAction, unmergeCustomerAction, type CustomerIdentityView } from '@/app/actions/customer-identity'

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

  function run(action: () => Promise<{ success: boolean; error?: string }>) {
    setError('')
    startTransition(async () => {
      const result = await action()
      if (result.success) {
        setOther('')
        router.refresh()
      } else setError(result.error ?? 'The change failed')
    })
  }

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
            <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => unmergeCustomerAction(identity.customerId))}>
              {pending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Separate this customer
            </Button>
          )}
          <Input className="h-8 w-72 text-xs" placeholder="Customer id or page address to merge with" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Customer to merge with" />
          <Button size="sm" disabled={pending || customerIdFromInput(other) === ''} onClick={() => run(() => mergeCustomersAction(identity.customerId, customerIdFromInput(other)))}>
            Merge
          </Button>
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
                  <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={pending} onClick={() => run(() => mergeCustomersAction(identity.customerId, p.id))}>Merge as same person</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
