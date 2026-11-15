'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { markWmsOperatorTaskDoneAction, type WmsOperatorTaskPage } from '@/app/actions/wms-operator-tasks'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'

/**
 * Queries a person has to raise in the warehouse's own system. IMS writes no comment to a warehouse order (the warehouse's staff do not read
 * them, and the API cannot raise a query), so each of these is the text to paste into a new query. Done records who and when.
 */
export function WmsOperatorTasksSection({ data }: { data: WmsOperatorTaskPage }) {
  const { rows, total, page, pageSize } = data
  const router = useRouter()
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  if (total === 0) return null

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
    } catch {
      setError('The text could not be copied. Select it and copy it by hand.')
    }
  }

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
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{`Raise a Mintsoft query (${total})`}</h2>
        <p className="text-xs text-muted-foreground">
          IMS no longer writes notes on warehouse orders: the warehouse does not read them and a query cannot be raised from IMS. For each task, raise a query in Mintsoft with the text below, then press Done.
          Your name and the time are recorded. A partial-removal task is checked first: Done is refused until every listed line is gone from the warehouse order.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      <div className="space-y-3">
        {rows.map((task) => (
          <div key={task.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="space-y-0.5">
                <div className="font-medium">{`Raise a Mintsoft query for order ${task.warehouseOrder}`}</div>
                <div className="text-xs text-muted-foreground">
                  {`${task.reasonLabel}. IMS order `}
                  <Link className="underline underline-offset-2" href={`/sales/${task.orderId}`}>{task.orderNumber}</Link>
                  {`. Raised ${task.createdAt.slice(0, 10)}.`}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(task.id, task.queryText)}>{copied === task.id ? 'Copied' : 'Copy text'}</Button>
                <Button size="sm" disabled={isPending} onClick={() => done(task.id)}>Done</Button>
              </div>
            </div>
            <p className="rounded bg-muted p-2 text-sm select-all">{task.queryText}</p>
          </div>
        ))}
      </div>
      {total > pageSize && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{`Tasks ${page * pageSize + 1} to ${Math.min(total, (page + 1) * pageSize)} of ${total}`}</span>
          <span className="flex gap-3">
            {page > 0 && <Link href={`?wqPage=${page - 1}`}>Previous</Link>}
            {(page + 1) * pageSize < total && <Link href={`?wqPage=${page + 1}`}>Next</Link>}
          </span>
        </div>
      )}
      {stepUpDialog}
    </Card>
  )
}
