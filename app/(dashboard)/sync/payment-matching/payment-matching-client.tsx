'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { setPaymentMatchingMode, type PaymentMatchingOverview } from '@/app/actions/payment-matching'

const MODES = [
  { value: 'off', label: 'Off', help: 'Nothing is looked at or posted.' },
  { value: 'shadow', label: 'Shadow', help: 'IMS works out what it would post and lists it here. Nothing is sent to Xero.' },
  { value: 'live', label: 'Live', help: 'IMS registers each matched payment against its open Xero invoice.' },
] as const

const STATUS_LABEL = {
  WOULD_POST: 'Would post',
  UNMATCHED: 'Not matched',
  BLOCKED: 'Held back',
  CLAIMED: 'Being registered',
  REGISTERED: 'Registered',
  FAILED: 'Failed, will retry',
} as const

export function PaymentMatchingClient({ overview }: { overview: PaymentMatchingOverview }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const { mode, counts, rows, total } = overview
  const change = (next: string) => {
    setError(null)
    start(async () => {
      const res = await setPaymentMatchingMode(next)
      if (!res.success) setError(res.error ?? 'Could not change the mode.')
    })
  }
  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div>
          <h1 className="text-lg font-semibold">Payment matching</h1>
          <p className="text-sm text-muted-foreground">
            Customer payments recorded in IMS that were never registered in Xero are matched to the open Xero invoice by payment method and currency, using the payment account map in Settings &gt; Xero.
            IMS never guesses a bank account, never pays more than the amount still open, and never moves a payment out of a locked Xero period.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Matching mode">
          {MODES.map((m) => (
            <Button key={m.value} size="sm" variant={mode === m.value ? 'default' : 'outline'} disabled={pending || mode === m.value} onClick={() => change(m.value)} title={m.help}>
              {m.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{MODES.find((m) => m.value === mode)?.help} Only an administrator can change the mode.</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          {`Would post ${counts.WOULD_POST} · Not matched ${counts.UNMATCHED} · Held back ${counts.BLOCKED} · Being registered ${counts.CLAIMED} · Failed ${counts.FAILED} · Registered ${counts.REGISTERED}`}
        </p>
      </Card>
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">{`Results (${total})`}</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to show. Results appear here once the mode is shadow or live and a sweep has run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3">Order</th>
                  <th className="py-1 pr-3">Result</th>
                  <th className="py-1 pr-3">Payment</th>
                  <th className="py-1 pr-3">Still open on invoice</th>
                  <th className="py-1 pr-3">Bank account</th>
                  <th className="py-1 pr-3">Xero invoice</th>
                  <th className="py-1 pr-3">Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t align-top">
                    <td className="py-1 pr-3"><Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderReference}</Link></td>
                    <td className="py-1 pr-3">{STATUS_LABEL[row.status]}</td>
                    <td className="py-1 pr-3">{`${row.currency} ${row.amount}${row.paymentDate ? ` on ${row.paymentDate}` : ''}`}</td>
                    <td className="py-1 pr-3">{row.amountDue === null ? 'unknown' : `${row.currency} ${row.amountDue}`}</td>
                    <td className="py-1 pr-3">{row.bankAccountId ?? 'none mapped'}</td>
                    <td className="py-1 pr-3">{row.accountingInvoiceId ?? 'none'}</td>
                    <td className="py-1 pr-3 text-xs">
                      {row.reasonText}
                      {row.detail && <div className="text-muted-foreground">{row.detail}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > rows.length && <p className="text-xs text-muted-foreground">{`Showing the first ${rows.length} of ${total}.`}</p>}
      </Card>
    </div>
  )
}
