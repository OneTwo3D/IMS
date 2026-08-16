'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Inbox, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
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
  replayDeadWebhookEvent,
  replayOutboxException,
  replayStuckDispatch,
  repushMissingWmsOrder,
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
            title={`WMS order pushes — dead-lettered (${data.summary.wmsPushDeadLetters})`}
            detail="These orders never reached the warehouse (or a hold/cancel conflicted). They will not fulfil until replayed or resolved."
            shown={data.wmsPushDeadLetters.length}
            total={data.summary.wmsPushDeadLetters}
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
            title={`Integration outbox — permanently failed rows (${data.summary.outboxFailures})`}
            detail="Accounting posts, WooCommerce stock pushes, booked-in events and landed-cost journals that exhausted their retries. Replay resets the row with its original payload and restarts its retry ladder."
            shown={data.outboxFailures.length}
            total={data.summary.outboxFailures}
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
            title={`WMS inbound events — dead-lettered (${data.summary.deadReceiptEvents})`}
            detail="Booked-in and order/inventory webhooks that exhausted their retries. Their effect has NOT been applied; replay re-queues the original event for the webhook sweeper."
            shown={data.deadReceiptEvents.length}
            total={data.summary.deadReceiptEvents}
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>ASN / type</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Dead-lettered</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.deadReceiptEvents.map((row) => (
                <TableRow key={`${row.kind}-${row.id}`}>
                  <TableCell className="text-xs font-mono">{row.connector} · {row.externalEventId}</TableCell>
                  <TableCell className="text-xs">{row.kind}</TableCell>
                  <TableCell className="text-xs">{row.reference ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.processingAttempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate" title={row.lastError ?? ''}>{row.lastError ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.deadLetteredAt ? formatDateTime(row.deadLetteredAt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(
                        () => (row.kind === 'booked-in' ? replayDeadReceiptEvent(row.id) : replayDeadWebhookEvent(row.id)),
                        'Event re-queued for the sweeper.',
                      )}
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
            title={`WooCommerce refunds — parked (${data.summary.refundSyncParks})`}
            detail="Refunds that could not be applied (usually an amount mismatch). The refund/restock/credit-note has NOT posted. Retry re-fetches the order's refunds fresh from WooCommerce."
            shown={data.refundSyncParks.length}
            total={data.summary.refundSyncParks}
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
            title={`Dispatch reconciliation — dead-lettered orders (${data.summary.stuckDispatches})`}
            detail="The WMS despatched these orders but IMS could not reconcile them (typically no IMS stock to consume). After repeated failures the sweep stops retrying; fix the order's stock position, then replay."
            shown={data.stuckDispatches.length}
            total={data.summary.stuckDispatches}
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>WMS order</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Held since</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.stuckDispatches.map((row) => (
                <TableRow key={row.orderId}>
                  <TableCell>
                    <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.externalOrderNumber ?? '—'}</TableCell>
                  <TableCell className="text-xs">
                    {row.kind === 'unresolved' ? (
                      <span title="The WMS answered, but its record could not be read as a dispatch state. Quarantined so it stops holding the inbound sync back.">
                        Unreadable record
                      </span>
                    ) : (
                      <span title="The reconcile kept failing (transport, or applying it to IMS).">Dead-lettered</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{row.failureCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.reason ?? ''}>{row.reason ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.deadLetteredAt ? formatDateTime(row.deadLetteredAt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => runAction(() => replayStuckDispatch(row.orderId), 'Dispatch reconciliation re-queued for the next sweep.')}
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

      {data.orderReconcileDrift.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`Order reconciliation — drift (${data.summary.orderReconcileDrift})`}
            detail="Findings from the latest scheduled IMS-vs-WMS order reconciliation. NOT_PUSHED: eligible order never reached the WMS (check the push cron). MISSING_IN_WMS: the WMS lost the order — re-push it. ACTIVE_AFTER_CANCEL: a cancelled order is still live in the WMS and may ship — cancel it there."
            shown={data.orderReconcileDrift.length}
            total={data.summary.orderReconcileDrift}
          />
          <Table containerClassName="rounded-lg border" className="min-w-[860px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>WMS order</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Found</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.orderReconcileDrift.map((row, index) => (
                <TableRow key={`${row.orderId}-${row.category}-${index}`}>
                  <TableCell>
                    <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.externalOrderNumber ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.category.replaceAll('_', ' ').toLowerCase()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.detail ?? ''}>{row.detail ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.foundAt ? formatDateTime(row.foundAt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    {row.category === 'MISSING_IN_WMS' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() => runAction(() => repushMissingWmsOrder(row.orderId), 'Order re-queued for the next push sweep.')}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />Re-push
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.pennyMismatches.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WMS pushes — order-total mismatches (${data.summary.pennyMismatches})`}
            detail="Advisory: these orders pushed successfully but the IMS and WMS totals drifted by more than a penny. Review the order, then clear the flag."
            shown={data.pennyMismatches.length}
            total={data.summary.pennyMismatches}
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

      {data.productStructureConflicts.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WooCommerce products — structure conflicts (${data.summary.productStructureConflicts})`}
            detail="The WooCommerce product sync refused to overwrite IMS-owned structure (bundle/BOM composition, a variable parent's children, a variant's parent), so the WooCommerce objects listed here exist nowhere in IMS — orders for those SKUs will import without a product or an allocation. Decide which side is right, then fix it in IMS or in WooCommerce; there is nothing to acknowledge, the next sync clears the row by itself. The product reconcile does not move past a conflicted product, so it retries automatically."
            shown={data.productStructureConflicts.length}
            total={data.summary.productStructureConflicts}
          />
          <Table containerClassName="rounded-lg border" className="min-w-[860px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>IMS product</TableHead>
                <TableHead>IMS type</TableHead>
                <TableHead>WooCommerce id</TableHead>
                <TableHead>Conflict</TableHead>
                <TableHead>Found</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.productStructureConflicts.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.productId ? (
                      <Link className="underline underline-offset-2" href={`/inventory/${row.productId}`}>
                        {row.sku ?? row.productId}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                    {row.productName ? <div className="text-xs text-muted-foreground">{row.productName}</div> : null}
                  </TableCell>
                  <TableCell className="text-xs">{row.productType ?? '—'}</TableCell>
                  <TableCell className="text-xs font-mono">{row.externalProductId ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[420px]" title={row.detail ?? ''}>{row.detail ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.foundAt)}</TableCell>
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

function SectionHeading({ title, detail, shown, total }: { title: string; detail: string; shown?: number; total?: number }) {
  const capped = shown != null && total != null && total > shown
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">
        {detail}
        {capped ? ` Showing the ${shown} most recent of ${total}.` : ''}
      </p>
    </div>
  )
}
