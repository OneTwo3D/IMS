'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Inbox, Loader2, RotateCcw } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { replayWmsOrderPush } from '@/app/actions/wms-order-push'
import {
  clearPennyMismatchFlag,
  replayDeadReceiptEvent,
  replayOutboxException,
  retryRefundSyncPark,
  type ExceptionInboxData,
} from '@/app/actions/sync-exceptions'

type Props = {
  data: ExceptionInboxData
}

/**
 * q66in.4.2: the exception inbox. Every section is a terminal failure state
 * that previously required knowing exactly where to look (or had no surface at
 * all). Each row keeps its original payload + idempotency key on replay.
 */
export function ExceptionsClient({ data }: Props) {
  const router = useRouter()
  const formatDateTime = useFormatDateTime()
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function withStepUp<T extends MaybeFreshAuthFailure>(run: () => Promise<T>): Promise<T> {
    const result = await run()
    if (isFreshAuthFailure(result) && (await promptReauth())) {
      return run()
    }
    return result
  }

  function runAction(action: () => Promise<MaybeFreshAuthFailure>, successMessage: string) {
    setError('')
    setNotice('')
    startTransition(async () => {
      const result = await withStepUp(action)
      if (isFreshAuthFailure(result)) {
        setError('Fresh sign-in required for replay actions.')
        return
      }
      if (!result || result.success !== true) {
        setError(typeof result?.error === 'string' ? result.error : 'The action failed.')
        return
      }
      setNotice(successMessage)
      router.refresh()
    })
  }

  const empty = data.summary.total === 0

  return (
    <div className="space-y-4">
      {stepUpDialog}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="h-5 w-5" />
            Sync Exceptions
          </h1>
          <p className="text-sm text-muted-foreground">
            Dead-lettered and parked sync work across all connectors. Replays re-attempt the original work — payloads and idempotency keys are preserved.
          </p>
        </div>
        <Link href="/sync" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeft className="h-4 w-4 mr-1" />Back to Integrations
        </Link>
      </div>

      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700 flex items-center gap-1"><CheckCircle2 className="h-4 w-4" />{notice}</p> : null}

      {empty ? (
        <Card className="p-8 text-center text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
          No open sync exceptions — every queue is clean.
        </Card>
      ) : null}

      {data.wmsPushDeadLetters.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WMS order pushes — dead-lettered (${data.wmsPushDeadLetters.length})`}
            detail="These orders never reached the warehouse (or a hold/cancel conflicted). They will not fulfil until replayed or resolved."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Connector</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Last attempt</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.wmsPushDeadLetters.map((row) => (
                <TableRow key={row.orderId}>
                  <TableCell>
                    <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                  </TableCell>
                  <TableCell className="text-xs">{row.connector}</TableCell>
                  <TableCell className="text-xs">{row.attempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.lastAttemptAt ? formatDateTime(row.lastAttemptAt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(() => replayWmsOrderPush(row.orderId), `Re-queued the WMS push for ${row.orderNumber ?? row.orderId}.`)}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />Replay
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.outboxFailures.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`Integration outbox — permanently failed rows (${data.outboxFailures.length})`}
            detail="Accounting posts, WooCommerce stock pushes, booked-in events and landed-cost journals that exhausted their retries. Replay resets the row with its original payload and restarts its retry ladder."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[900px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Connector / operation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.outboxFailures.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs font-mono">{row.connector}/{row.operation}</TableCell>
                  <TableCell className="text-xs">Permanent</TableCell>
                  <TableCell className="text-xs">{row.attempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(() => replayOutboxException(row.id), 'Outbox row re-queued.')}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />Replay
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.deadReceiptEvents.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WMS receipt events — dead-lettered (${data.deadReceiptEvents.length})`}
            detail="Booked-in webhooks that exhausted their retries. Their goods-in has NOT been applied; replay re-queues the original event for the webhook sweeper."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>ASN</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Dead-lettered</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.deadReceiptEvents.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs font-mono">{row.connector} · {row.externalEventId}</TableCell>
                  <TableCell className="text-xs">{row.externalAsnId ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.processingAttempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.deadLetteredAt ? formatDateTime(row.deadLetteredAt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(() => replayDeadReceiptEvent(row.id), 'Receipt event re-queued for the sweeper.')}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />Replay
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.refundSyncParks.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WooCommerce refunds — parked (${data.refundSyncParks.length})`}
            detail="Refunds that could not be applied (usually an amount mismatch). The refund/restock/credit-note has NOT posted. Retry re-fetches the order's refunds fresh from WooCommerce."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>WC refund</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Parked</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.refundSyncParks.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.orderId
                      ? <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.externalRefundId ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.status}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.errorMessage ?? ''}>{row.errorMessage ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(async () => {
                        const result = await retryRefundSyncPark(row.id)
                        if ('success' in result && result.success && !result.synced) {
                          return { success: false, error: 'Retried, but the refund still did not apply — the amount mismatch likely persists in WooCommerce.' }
                        }
                        return result
                      }, 'Refund re-synced and applied.')}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.stuckDispatches.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`Dispatch reconciliation — stuck orders (${data.stuckDispatches.length})`}
            detail="The WMS despatched these orders but IMS could not reconcile them (typically no IMS stock to consume). They re-error on every sweep until the stock position is fixed on the order."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[700px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>WMS order</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Last sweep</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.stuckDispatches.map((row, index) => (
                <TableRow key={row.orderId ?? index}>
                  <TableCell>
                    {row.orderId
                      ? <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.externalOrderNumber ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[380px] truncate" title={row.reason ?? ''}>{row.reason ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.jobFinishedAt ? formatDateTime(row.jobFinishedAt) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.pennyMismatches.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WMS pushes — order-total mismatches (${data.pennyMismatches.length})`}
            detail="Advisory: these orders pushed successfully but the IMS and WMS totals drifted by more than a penny. Review the order, then clear the flag."
          />
          <Table containerClassName="rounded-lg border" className="min-w-[640px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>WMS order</TableHead>
                <TableHead>Drift</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.pennyMismatches.map((row) => (
                <TableRow key={row.orderId}>
                  <TableCell>
                    <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.externalOrderNumber ?? '—'}</TableCell>
                  <TableCell className="text-xs">{(row.totalMismatchPence / 100).toLocaleString(undefined, { style: 'currency', currency: 'GBP' })}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(() => clearPennyMismatchFlag(row.orderId), 'Mismatch flag cleared.')}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />Clear
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {isPending ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Working…</p> : null}
    </div>
  )
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}
