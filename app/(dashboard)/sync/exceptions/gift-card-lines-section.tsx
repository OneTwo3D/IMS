'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { resolveGiftCardLineAction, type GiftCardOrderRow } from '@/app/actions/gift-card-line-resolution'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'

/**
 * Orders whose invoice is held because the store could not say whether a line is a gift card. Each line takes an explicit answer (there is no default and no pre-selected button): the answer is recorded with who gave it
 * and when, and used the next time the order is imported from WooCommerce.
 */
export function GiftCardLinesSection({ rows }: { rows: GiftCardOrderRow[] }) {
  const router = useRouter()
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  if (rows.length === 0) return null

  function answer(salesOrderId: string, lineId: number, isGiftCard: boolean) {
    setError('')
    setNotice('')
    startTransition(async () => {
      let result: MaybeFreshAuthFailure & { success?: boolean; error?: string; notice?: string } = await resolveGiftCardLineAction(salesOrderId, lineId, isGiftCard)
      if (isFreshAuthFailure(result) && (await promptReauth())) result = await resolveGiftCardLineAction(salesOrderId, lineId, isGiftCard)
      if (isFreshAuthFailure(result)) return setError('A fresh sign-in is needed to record this answer.')
      if (result.success !== true) return setError(result.error ?? 'The answer was not saved.')
      setNotice(result.notice ?? 'Saved.')
      router.refresh()
    })
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{`Gift card or not? Order lines the store could not settle (${rows.length})`}</h2>
        <p className="text-xs text-muted-foreground">
          These orders are held because the store did not say whether a line is a gift card (a custom line, or a product that has since been deleted). Mark each line, then re-import the order from WooCommerce.
          Your name and the time are recorded with the answer. A line the store did flag keeps the store&apos;s answer.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <div className="space-y-3">
        {rows.map((order) => (
          <div key={order.salesOrderId} className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium">Order {order.orderNumber}</div>
            {order.lines.map((line) => (
              <div key={line.externalLineItemId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <div>{line.description}{line.sku ? ` (${line.sku})` : ''}{line.quantity ? ` x ${line.quantity}` : ''}</div>
                  <div className="text-xs text-muted-foreground">
                    {line.answer === null ? 'No answer yet.' : `Marked ${line.answer ? 'a gift card' : 'not a gift card'}${line.answeredBy ? ` by ${line.answeredBy}` : ''}${line.answeredAt ? ` on ${line.answeredAt.slice(0, 10)}` : ''}.`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={isPending || line.answer === true} onClick={() => answer(order.salesOrderId, line.externalLineItemId, true)}>Gift card</Button>
                  <Button size="sm" variant="outline" disabled={isPending || line.answer === false} onClick={() => answer(order.salesOrderId, line.externalLineItemId, false)}>Not a gift card</Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {stepUpDialog}
    </Card>
  )
}
