'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { markWmsOperatorTaskDoneAction, type RefundDeleteTaskPage } from '@/app/actions/wms-operator-tasks'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'

/**
 * #1132 R2-LOW-6: refund deletes that need a person: a credit note Xero holds voided while the IMS refund still stands, or a void entry that gave
 * up. Not warehouse queries. Done records who and when and changes nothing in Xero, the warehouse or the refund.
 */
export function RefundDeleteTasksSection({ data }: { data: RefundDeleteTaskPage }) {
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
    <Card id="refund-delete-tasks" className="p-4 space-y-3 scroll-mt-4">
      <div>
        <h2 className="text-sm font-semibold">{`Refund deletes that need you (${total})`}</h2>
        <p className="text-xs text-muted-foreground">
          A refund being deleted that IMS could not finish on its own. Each task says what Xero holds and what to do. Pressing Done only records that
          you have dealt with it: it changes nothing in Xero, in the warehouse or on the refund. A task closes by itself when the refund is deleted.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <div className="space-y-3">
        {rows.map((task) => (
          <div key={task.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="space-y-0.5">
                <div className="font-medium">{task.reasonLabel}</div>
                <div className="text-xs text-muted-foreground">
                  {'IMS order '}
                  <Link className="underline underline-offset-2" href={`/sales/${task.orderId}`}>{task.orderNumber}</Link>
                  {`. Raised ${task.createdAt.slice(0, 10)}.`}
                </div>
              </div>
              <Button size="sm" disabled={isPending} onClick={() => done(task.id)}>Done</Button>
            </div>
            <p className="rounded bg-muted p-2 text-sm">{task.queryText}</p>
          </div>
        ))}
      </div>
      {total > pageSize && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{`Tasks ${page * pageSize + 1} to ${Math.min(total, (page + 1) * pageSize)} of ${total}`}</span>
          <span className="flex gap-3">
            {page > 0 && <Link href={`?rdPage=${page - 1}`}>Previous</Link>}
            {(page + 1) * pageSize < total && <Link href={`?rdPage=${page + 1}`}>Next</Link>}
          </span>
        </div>
      )}
      {stepUpDialog}
    </Card>
  )
}
