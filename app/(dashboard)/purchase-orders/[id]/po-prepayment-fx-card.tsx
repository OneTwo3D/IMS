'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { readPurchaseOrderXeroPrepayment } from '@/app/actions/purchase-orders'
import { Button } from '@/components/ui/button'

import type { PurchaseOrderFxView } from '@/lib/domain/purchasing/purchase-receipt-fx'

export type PoPrepaymentFxView = PurchaseOrderFxView

const SOURCE_LABEL = { XERO_PREPAYMENT: 'Xero prepayment rate', FX_TABLE: 'Exchange-rate table rate' } as const

// Per-event FX rates for purchasing (o3d-hqvrp.51 step 2): the rate this foreign order's goods are received at, read from the supplier
// prepayment recorded in Xero (Spend Money > Prepayment, Reference = the PO number). Rendered only while the switch is on, for a foreign order.
export function PoPrepaymentFxCard({
  poId,
  poReference,
  currency,
  baseCurrency,
  fx,
  canRead,
}: {
  poId: string
  poReference: string
  currency: string
  baseCurrency: string
  fx: PoPrepaymentFxView | null
  canRead: boolean
}) {
  const lock = fx?.lock ?? null
  const receipts = fx?.receipts ?? []
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  function read() {
    setError('')
    setMessage('')
    startTransition(async () => {
      const res = await readPurchaseOrderXeroPrepayment(poId)
      if (!res.success) {
        setError(res.error ?? 'Could not read the Xero prepayment.')
        return
      }
      if (res.result?.status === 'none') {
        setMessage(`Xero holds no prepayment with the reference ${poReference}. Receipts will be valued at the exchange-rate table rate on the day.`)
      } else if (res.result?.status === 'locked') {
        const earlier = res.result.earlierTableRateReceipts
        setMessage(
          (res.result.changed ? 'Rate locked from the Xero prepayment.' : 'The Xero prepayment is unchanged.')
          + (earlier > 0 ? ` It applies to later receipts only: ${earlier} earlier receipt${earlier === 1 ? '' : 's'} keep the exchange-rate table rate.` : ''),
        )
      }
      router.refresh()
    })
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 text-sm font-medium">
        <span>Xero prepayment exchange rate</span>
        {canRead && (!lock || !lock.used) && (
          <Button size="sm" variant="outline" disabled={pending} onClick={read}>
            {pending ? 'Reading…' : 'Read from Xero'}
          </Button>
        )}
      </div>
      <div className="px-4 py-3 text-sm space-y-1">
        {lock ? (
          <p>
            Goods are received at <span className="font-medium tabular-nums">1 {baseCurrency} = {lock.rateToBase} {lock.currency}</span>, the rate of
            Xero prepayment {lock.xeroPrepaymentId} of {lock.prepaymentDate} ({lock.currency} {lock.prepaymentTotal}).
            {lock.used ? ' Receipts have been valued at it, so it is fixed.' : ' No receipt has used it yet.'}
          </p>
        ) : (
          <p className="text-muted-foreground">
            No prepayment read yet. Record the supplier payment in Xero as Spend Money &gt; Prepayment with the reference {poReference}; IMS reads it at
            the first receipt (or now, with Read from Xero). Without one, receipts use the exchange-rate table rate for {currency} on the day.
          </p>
        )}
        {fx && fx.tableRateReceiptCount > 0 && (
          <p className="text-amber-700 dark:text-amber-400">
            {fx.tableRateReceiptCount} receipt{fx.tableRateReceiptCount === 1 ? '' : 's'} valued at the exchange-rate table rate, not a Xero prepayment rate. A prepayment
            recorded now applies to later receipts only; these keep the table rate.
          </p>
        )}
        {receipts.length > 0 && (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Receipt</th>
                <th className="py-1 pr-3 font-medium">Received</th>
                <th className="py-1 pr-3 font-medium">Rate (1 {baseCurrency} = ... {currency})</th>
                <th className="py-1 font-medium">Valued at</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id} className="border-t">
                  <td className="py-1 pr-3 font-mono">{receipt.reference ?? receipt.id}</td>
                  <td className="py-1 pr-3 tabular-nums">{receipt.receivedAt.slice(0, 10)}</td>
                  <td className="py-1 pr-3 tabular-nums">{receipt.rateToBase ?? 'the order rate'}</td>
                  <td className="py-1">{receipt.source ? SOURCE_LABEL[receipt.source] : 'Order rate (before per-event rates)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {message && <p className="text-muted-foreground">{message}</p>}
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </div>
  )
}
