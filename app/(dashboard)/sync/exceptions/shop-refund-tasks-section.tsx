'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { markWmsOperatorTaskDoneAction } from '@/app/actions/wms-operator-tasks'
import type { ShopRefundTaskPage } from '@/app/actions/shop-refund-tasks'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'

/**
 * Refunds a person has to make in WooCommerce. IMS recorded each refund and its credit note and wrote nothing to WooCommerce. When the refund is
 * made there and imported, IMS links it to the credit note and resolves the task by itself; Done is for a task that needs no refund there.
 */
export function ShopRefundTasksSection({ data }: { data: ShopRefundTaskPage }) {
  const { rows, total, page, pageSize } = data
  const router = useRouter()
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  if (total === 0) return null

  function done(id: string) {
    setError('')
    setNotice('')
    startTransition(async () => {
      let result: MaybeFreshAuthFailure & { success?: boolean; error?: string; notice?: string } = await markWmsOperatorTaskDoneAction(id)
      if (isFreshAuthFailure(result) && (await promptReauth())) result = await markWmsOperatorTaskDoneAction(id)
      if (isFreshAuthFailure(result)) return setError('A fresh sign-in is needed to mark this task done.')
      if (result.success !== true) return setError(result.error ?? 'The task was not marked done.')
      setNotice(result.notice ?? 'Marked done.')
      router.refresh()
    })
  }

  return (
    <Card id="shop-refund-tasks" className="p-4 space-y-3 scroll-mt-4">
      <div>
        <h2 className="text-sm font-semibold">{`Refund in WooCommerce (${total})`}</h2>
        <p className="text-xs text-muted-foreground">
          IMS recorded these refunds and credit notes and has written nothing to WooCommerce: no refund, no status change, no note. Refund the customer in WooCommerce for the amount shown.
          When that refund is imported, IMS lists it under parked refunds: it cannot tell it from a separate refund, because it writes no marker to WooCommerce. There, confirm that it settles the credit note (IMS links it, raises no second credit note and resolves this task) or record it as a separate refund.
          Press Done only if no refund is to be made there. Your name and the time are recorded.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <div className="space-y-3">
        {rows.map((task) => (
          <div key={task.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="space-y-0.5">
                <div className="font-medium">{`Refund ${task.amountText} in WooCommerce for order ${task.orderNumber}`}</div>
                <div className="text-xs text-muted-foreground">
                  {`${task.creditNoteNumber ? `Credit note ${task.creditNoteNumber}. ` : ''}IMS order `}
                  <Link className="underline underline-offset-2" href={`/sales/${task.orderId}`}>{task.orderNumber}</Link>
                  {`. Raised ${task.createdAt.slice(0, 10)}.`}
                </div>
              </div>
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => done(task.id)}>Done</Button>
            </div>
            <p className="rounded bg-muted p-2 text-sm">{task.queryText}</p>
          </div>
        ))}
      </div>
      {total > pageSize && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{`Tasks ${page * pageSize + 1} to ${Math.min(total, (page + 1) * pageSize)} of ${total}`}</span>
          <span className="flex gap-3">
            {page > 0 && <Link href={`?srPage=${page - 1}`}>Previous</Link>}
            {(page + 1) * pageSize < total && <Link href={`?srPage=${page + 1}`}>Next</Link>}
          </span>
        </div>
      )}
      {stepUpDialog}
    </Card>
  )
}
