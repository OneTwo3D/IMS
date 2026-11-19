'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getCustomerTimeline } from '@/app/actions/customer-identity'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import type { TimelineEvent, TimelineKind, TimelinePage } from '@/lib/domain/crm/timeline'

const KIND_LABEL: Record<TimelineKind, string> = {
  ORDER_PLACED: 'Order placed',
  ORDER_CANCELLED: 'Order cancelled',
  INVOICE: 'Invoice issued',
  PAYMENT: 'Payment received',
  CREDIT_NOTE: 'Credit note / refund',
  REFUND_PAYMENT: 'Refund paid',
  RETURN_EXPECTED: 'Return expected',
  WAREHOUSE_RETURN: 'Warehouse return',
}

export function CustomerTimeline({ customerId, initial, showPersonScope }: { customerId: string; initial: TimelinePage; showPersonScope: boolean }) {
  const formatDateTime = useFormatDateTime()
  const [scope, setScope] = useState<'person' | 'customer'>('person')
  const [events, setEvents] = useState<TimelineEvent[]>(initial.events)
  const [next, setNext] = useState<string | null>(initial.nextCursor)
  const [pending, startTransition] = useTransition()

  function load(nextScope: 'person' | 'customer', cursor: string | null, append: boolean) {
    startTransition(async () => {
      const page = await getCustomerTimeline(customerId, { scope: nextScope, cursor })
      if (!page) return
      setEvents((prev) => (append ? [...prev, ...page.events] : page.events))
      setNext(page.nextCursor)
      setScope(nextScope)
    })
  }

  return (
    <Card className="p-5 max-w-5xl" data-testid="customer-timeline">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Timeline</h2>
        {showPersonScope && (
          <div className="flex gap-1 text-xs">
            <Button variant={scope === 'person' ? 'default' : 'outline'} size="sm" className="h-7" disabled={pending} onClick={() => load('person', null, false)}>Whole person</Button>
            <Button variant={scope === 'customer' ? 'default' : 'outline'} size="sm" className="h-7" disabled={pending} onClick={() => load('customer', null, false)}>This record only</Button>
          </div>
        )}
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Nothing has happened for this customer yet.</p>
      ) : (
        <Table className="min-w-[600px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="px-4 text-xs">When</TableHead>
              <TableHead className="px-4 text-xs">What</TableHead>
              <TableHead className="px-4 text-xs">Order</TableHead>
              <TableHead className="px-4 text-xs">Reference</TableHead>
              <TableHead className="px-4 text-xs text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e) => (
              <TableRow key={e.key}>
                <TableCell className="px-4 text-xs text-muted-foreground">{formatDateTime(e.at, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</TableCell>
                <TableCell className="px-4 text-sm">{KIND_LABEL[e.kind]}{e.status && <span className="ml-1 text-xs text-muted-foreground">({e.status.toLowerCase().replace(/_/g, ' ')})</span>}</TableCell>
                <TableCell className="px-4 text-sm"><Link href={`/sales/${e.orderId}`} className="text-primary hover:underline" target="_blank">{e.orderNumber}</Link></TableCell>
                <TableCell className="px-4 text-xs text-muted-foreground">{e.reference ?? ''}</TableCell>
                <TableCell className="px-4 text-xs text-right tabular-nums">{e.amount !== null ? `${e.currency ?? ''} ${Number(e.amount).toFixed(2)}`.trim() : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next && (
        <div className="mt-3 text-center">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => load(scope, next, true)}>
            {pending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Load older
          </Button>
        </div>
      )}
    </Card>
  )
}
