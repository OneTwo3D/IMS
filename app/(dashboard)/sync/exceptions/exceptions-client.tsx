'use client'

import { Fragment, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Inbox, Loader2, PackageCheck, RotateCcw, Split, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
  dismissWithdrawnDispatch,
  endHeldMaintenanceWindow,
  recordWithdrawnDespatch,
  runPostMaintenanceRecheckNow,
  replayDeadReceiptEvent,
  replayDeadWebhookEvent,
  replayOutboxException,
  isolateUnresolvedDriftCohort,
  replayStuckDispatch,
  retryUnresolvedDriftCohort,
  repushMissingWmsOrder,
  retryRefundSyncPark,
  recoverRefundSyncPark,
  type ExceptionInboxData,
  type RefundSyncParkRow,
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
  // o3d-51du: a bulk quarantine is not a one-click action. The first click arms
  // it and puts the affected orders under an explicit "these will be
  // quarantined" heading; only the second one writes.
  //
  // Keyed by the ELIGIBLE-set digest, not the connector (o3d-0gzr r2).
  // router.refresh() deliberately preserves useState, so a connector-keyed flag
  // stayed armed across a refresh — and the confirm button then rendered,
  // already armed, against whatever cohort came back. Keying it to the exact set
  // means any change to that set disarms it by construction.
  const [confirmingIsolate, setConfirmingIsolate] = useState<string | null>(null)
  // o3d-54p: which refund park (if any) has its recovery panel open. One at a time, and NEVER
  // pre-armed: the panel opens with no outcome chosen, so a stray click cannot assert anything.
  const [recoveringParkId, setRecoveringParkId] = useState<string | null>(null)

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
  // Bound once so the button can hand the action the hold THIS RENDER SAW, rather than the action
  // ending whatever hold happens to be recorded when the click lands (o3d-hl8l r6).
  const hold = data.maintenanceRecovery.hold

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

      {hold || data.maintenanceRecovery.recheckDueSince ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`Maintenance window (${data.summary.maintenanceRecovery})`}
            detail="While maintenance mode is on, inbound warehouse callbacks are refused with a 503 and NOTHING is written — the fence runs before the signature is verified, so a refused callback cannot leave a row. Recovery is by re-checking the ASNs afterwards, which is what these controls schedule and run."
            shown={data.summary.maintenanceRecovery}
            total={data.summary.maintenanceRecovery}
          />
          {hold ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-3 space-y-2">
              <p className="text-sm font-medium">
                Maintenance mode is HELD after a restore whose database backend could not be confirmed gone.
              </p>
              <p className="text-xs text-muted-foreground">
                Held {formatDateTime(hold.heldAt)} · backend pid{' '}
                <span className="font-mono">{hold.backendPid}</span>, started{' '}
                <span className="font-mono">{hold.backendStart}</span>
              </p>
              <p className="text-xs text-muted-foreground">{hold.reason}</p>
              <p className="text-xs text-muted-foreground">
                Ending the hold clears maintenance mode AND schedules a re-check of every open ASN, which is how the
                callbacks refused during the window are recovered. It refuses unless that backend is gone from
                pg_stat_activity at the moment you click — but the check only proves the backend has detached, not that
                the application is quiet. Take the application out of service first if it is not already.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => runAction(
                  // The hold THIS PAGE IS SHOWING, handed to the action so it can refuse if the row
                  // under the lock is a different restore's (o3d-hl8l r6). The action re-reads and
                  // compares; nothing here is trusted as a precondition.
                  () => endHeldMaintenanceWindow({
                    backendPid: hold.backendPid,
                    backendStart: hold.backendStart,
                    heldAt: hold.heldAt,
                  }),
                  'Ended the held maintenance window — a warehouse booked-in re-check is now due.',
                )}
              >
                <RotateCcw className="h-3 w-3 mr-1" />End the hold
              </Button>
            </div>
          ) : null}
          {data.maintenanceRecovery.recheckDueSince ? (
            <div className="rounded-lg border p-3 space-y-2">
              <p className="text-sm font-medium">
                A booked-in re-check is due for the maintenance window that ended{' '}
                {formatDateTime(data.maintenanceRecovery.recheckDueSince)}.
              </p>
              <p className="text-xs text-muted-foreground">
                The warehouse webhook sweeper drains this automatically about every five minutes. Run it here if that
                job is disabled or the scheduler is down. A re-check reconstructs the callback trigger and applies only
                what is still outstanding, so an ASN with nothing owed books nothing in.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => runAction(
                  runPostMaintenanceRecheckNow,
                  'Re-checked the open ASNs for the closed maintenance window.',
                )}
              >
                <RotateCcw className="h-3 w-3 mr-1" />Run the re-check now
              </Button>
            </div>
          ) : null}
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
                <Fragment key={row.id}>
                  <TableRow>
                    <TableCell>
                      {row.orderId
                        ? <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber ?? row.orderId}</Link>
                        : '—'}
                      {/* "id", not "#": this is the value the recovery panel asks for and the one the
                          REST path addresses, and it is not necessarily the order number WooCommerce
                          shows the customer. */}
                      {row.wcOrderId ? <span className="ml-2 text-[11px] text-muted-foreground font-mono">WC id {row.wcOrderId}</span> : null}
                    </TableCell>
                    <TableCell className="text-xs font-mono">{row.externalRefundId ?? '—'}</TableCell>
                    <TableCell className="text-xs">{row.status}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.errorMessage ?? ''}>{row.errorMessage ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.createdAt)}</TableCell>
                    <TableCell className="text-right space-x-1 whitespace-nowrap">
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
                      {/*
                        o3d-54p. Retry is the right first move and stays the default; this is the way
                        OUT of the park Retry can never resolve — one recorded against the WRONG
                        order, where every retry re-fetches an order that does not have this refund
                        and the true owner's refund create fails closed on the park forever.
                      */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isPending || !row.orderId || !row.externalRefundId}
                        title="This park is on the wrong order — check WooCommerce and move or dismiss it"
                        onClick={() => setRecoveringParkId(recoveringParkId === row.id ? null : row.id)}
                      >
                        <Split className="h-3 w-3 mr-1" />Wrong order
                      </Button>
                    </TableCell>
                  </TableRow>
                  {recoveringParkId === row.id ? (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/30">
                        <RecoverRefundParkPanel
                          row={row}
                          busy={isPending}
                          onCancel={() => setRecoveringParkId(null)}
                          onSubmit={(assertion) => {
                            setRecoveringParkId(null)
                            runAction(
                              () => recoverRefundSyncPark(row.id, { observedOrderId: row.orderId as string, ...assertion }),
                              assertion.outcome === 'REASSIGN'
                                ? 'WooCommerce confirmed the refund on that order; the park moved there and is retryable from its new order.'
                                : 'WooCommerce did not list that refund on this order; the park is dismissed and no longer blocks it.',
                            )
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.stuckDispatches.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`Dispatch reconciliation — dead-lettered orders (${data.summary.stuckDispatches})`}
            detail={
              'The WMS despatched these orders but IMS could not reconcile them (typically no IMS stock to consume). '
              + 'After repeated failures the sweep stops retrying; fix the order\u2019s stock position, then replay. '
              + 'Rows marked WITHDRAWAL STANDING are different: IMS refused to fulfil them because the customer asked to '
              + 'withdraw the order, so a replay would only refuse them again. If the warehouse had already despatched, '
              + 'record the despatch \u2014 IMS confirms it with the WMS first, then books the shipment, the stock and the '
              + 'despatch notification, and the request becomes a return.'
            }
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
                    {row.withdrawalStanding ? (
                      <span
                        className="font-medium"
                        title="A withdrawal stands against this order, so IMS refused to mark it shipped, relieve stock or email the customer. Replaying re-runs the same check and holds it back again."
                      >
                        Withdrawal standing
                      </span>
                    ) : row.kind === 'unresolved' ? (
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
                    <div className="flex justify-end gap-2">
                      {/*
                        o3d-rbyg round 2: the remedy a withheld withdrawal actually needs. A CANCELLED
                        order (an APPROVED withdrawal) cannot carry a shipment in IMS at all, so it is
                        offered Dismiss instead — clearing the row without pretending the goods came back.
                      */}
                      {row.withdrawalStanding ? (
                        row.orderStatus === 'CANCELLED' ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPending}
                            title="The order is cancelled, so IMS records no shipment for it. This clears the exception row; anything already despatched is handled as a return."
                            onClick={() => runAction(
                              () => dismissWithdrawnDispatch(row.orderId),
                              'Cleared. The order stays cancelled — handle anything already despatched as a return.',
                            )}
                          >
                            <XCircle className="h-3 w-3 mr-1" />Dismiss
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPending}
                            title="Confirms with the WMS that the goods have gone, releases the withdrawal hold, then books the shipment, the stock relief and the despatch notification."
                            onClick={() => runAction(
                              () => recordWithdrawnDespatch(row.orderId),
                              'Despatch recorded — the shipment, the stock relief and the despatch notification were applied.',
                            )}
                          >
                            <PackageCheck className="h-3 w-3 mr-1" />Record despatch
                          </Button>
                        )
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        title={row.withdrawalStanding
                          ? 'Only once the withdrawal itself is resolved — otherwise the sweep refuses this order again.'
                          : undefined}
                        onClick={() => runAction(() => replayStuckDispatch(row.orderId), 'Dispatch reconciliation re-queued for the next sweep.')}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />Replay
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data.unresolvedDrift.length > 0 ? (
        <Card className="p-4 space-y-3">
          <SectionHeading
            title={`WMS records unreadable — connector-wide (${data.summary.unresolvedDrift})`}
            detail={
              'The dispatch sweep could not read these orders from the WMS, and could not tell whether the '
              + 'ORDERS are broken or the CONNECTOR is: nothing else was readable to compare against. It will '
              + 'not isolate them on a guess — that would take the whole tenant out of sync for a fault one fix '
              + 'would clear — so inbound sync is held back until this is resolved. Fix the cause in the WMS '
              + 'then Retry; or, if these specific orders are genuinely broken, Isolate them so everything else '
              + 'resumes and each one appears above as a replayable row.'
            }
            shown={data.unresolvedDrift.length}
            total={data.summary.unresolvedDrift}
          />
          <Table containerClassName="rounded-lg border" className="min-w-[820px]">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Connector</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Unreadable since</TableHead>
                <TableHead>Passes</TableHead>
                <TableHead>What the WMS said</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.unresolvedDrift.map((row) => (
                <Fragment key={row.connector}>
                  <TableRow>
                    <TableCell className="text-xs font-medium">{row.connector}</TableCell>
                    <TableCell className="text-xs">
                      {row.linkCount}
                      {row.touched > 0 ? <span className="text-muted-foreground"> of {row.touched} checked</span> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.firstSeenAt ? formatDateTime(row.firstSeenAt) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{row.consecutivePasses}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[320px] truncate" title={row.reason ?? ''}>
                      {row.reason ?? '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() => runAction(
                          () => retryUnresolvedDriftCohort(row.connector, row.version),
                          'Cleared — the next sweep will re-check these orders.',
                        )}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />Retry
                      </Button>
                      {confirmingIsolate === row.eligibleVersion && row.eligibleCount > 0 ? (
                        <>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={isPending}
                            onClick={() => {
                              setConfirmingIsolate(null)
                              runAction(
                                () => isolateUnresolvedDriftCohort(row.connector, row.version, row.eligibleVersion),
                                'Isolated — inbound sync resumes, and each order is now replayable above.',
                              )
                            }}
                          >
                            Confirm — isolate {row.eligibleCount}
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => setConfirmingIsolate(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isPending}
                          onClick={() => setConfirmingIsolate(row.eligibleVersion)}
                          title={row.eligibleCount === 0 ? 'Nothing eligible to isolate' : undefined}
                        >
                          Isolate {row.eligibleCount}…
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {/*
                    o3d-51du: the orders Isolate would quarantine, on screen BEFORE
                    the click. Binding the action to a digest of the cohort only
                    guarantees the operator acts on the set the page showed them —
                    which means nothing while the page shows a bare count.
                  */}
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="pt-0 pb-3">
                      <div className="rounded-md border border-dashed bg-muted/20 p-2">
                        <p className="text-xs font-medium mb-1">
                          {confirmingIsolate === row.eligibleVersion
                            ? `These ${row.eligibleCount} order(s) will be quarantined:`
                            : `Orders Isolate would quarantine (${row.eligibleCount} of ${row.linkCount} in the cohort still eligible):`}
                        </p>
                        {row.eligibleCount > 0 ? (
                          <>
                            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground max-h-48 overflow-y-auto">
                              {row.orders.map((order) => (
                                <li key={order.linkId} className="font-mono">
                                  {order.orderNumber ?? '(no number)'}
                                  {order.externalOrderNumber ? (
                                    <span className="text-muted-foreground/70"> → {order.externalOrderNumber}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>

                            {row.eligibleCount > row.orders.length ? (
                              <p className="text-xs text-amber-600 mt-1">
                                Listing the first {row.orders.length} — Isolate quarantines all {row.eligibleCount}.
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            None of these orders is still eligible — they have resolved, shipped or been isolated
                            already. Isolate would do nothing.
                          </p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                </Fragment>
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


/**
 * o3d-54p — the operator's end of the cross-order refund-park recovery.
 *
 * DELIBERATELY MINIMAL, and deliberately NOT a recommendation. It offers exactly the two things an
 * operator can be right about, and prescribes neither:
 *
 *   REASSIGN  "WooCommerce refund N belongs to WooCommerce order X, not this one."
 *   DISMISS   "WooCommerce no longer has this refund on this order at all."
 *
 * NEITHER IS BELIEVED ON ITS OWN. The server asks WooCommerce, fresh, before it writes anything, and
 * refuses with the specific contradiction when the answer disagrees — a reassign whose named order
 * does not have the refund, or a dismissal of a park WooCommerce still confirms. So the wording here
 * says what IMS will CHECK, not what it will assume, because an operator who thinks this button
 * moves a refund on their say-so will use it where they should have used Retry.
 *
 * The panel opens with no outcome selected and the confirm button disabled. There is no default,
 * because a default here is a recommendation about somebody else's money.
 */
function RecoverRefundParkPanel({
  row,
  busy,
  onCancel,
  onSubmit,
}: {
  row: RefundSyncParkRow
  busy: boolean
  onCancel: () => void
  onSubmit: (assertion: { outcome: 'REASSIGN'; wcOrderId: number } | { outcome: 'DISMISS'; reason?: string }) => void
}) {
  const [outcome, setOutcome] = useState<'REASSIGN' | 'DISMISS' | null>(null)
  const [wcOrderId, setWcOrderId] = useState('')
  const [reason, setReason] = useState('')

  const parsedWcOrderId = Number(wcOrderId.trim())
  const wcOrderIdValid = wcOrderId.trim() !== '' && Number.isSafeInteger(parsedWcOrderId) && parsedWcOrderId > 0
  const canSubmit = !busy && (outcome === 'DISMISS' || (outcome === 'REASSIGN' && wcOrderIdValid))

  return (
    <div className="space-y-3 py-2 text-xs">
      <p className="text-muted-foreground max-w-3xl">
        A WooCommerce refund belongs to exactly one order. While refund{' '}
        <span className="font-mono">{row.externalRefundId}</span> is parked here, its real order cannot have
        it applied — the refund, the credit note and the restock are all refused — and neither order can be
        deleted. Open the refund in WooCommerce and read its parent order off the refund itself before
        choosing.
      </p>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input type="radio" name={`recover-${row.id}`} checked={outcome === 'REASSIGN'} onChange={() => setOutcome('REASSIGN')} />
          <span>It belongs to another WooCommerce order</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`recover-${row.id}`} checked={outcome === 'DISMISS'} onChange={() => setOutcome('DISMISS')} />
          <span>WooCommerce no longer has it on this order</span>
        </label>
      </div>

      {outcome === 'REASSIGN' ? (
        <div className="space-y-1 max-w-sm">
          {/*
            THE ID, NOT THE ORDER NUMBER. What is typed here is sent to WooCommerce verbatim as
            /orders/{value}/refunds, which addresses an order by its ID. On a plain store the two
            happen to be equal, so the wrong label costs nothing and reads as correct — but the
            moment a sequential-order-number plugin is in use they diverge, and then an operator who
            does what the label says supplies a number that addresses SOMEBODY ELSE'S order or no
            order at all. A refund reassigned onto the wrong order is the very fault this panel
            exists to repair. The nearest wrong answer is also the most visible one: the IMS order
            number in the row above this panel is not a WooCommerce id either.
          */}
          <label className="block text-muted-foreground" htmlFor={`wc-order-${row.id}`}>
            WooCommerce order ID that holds this refund
          </label>
          <Input
            id={`wc-order-${row.id}`}
            inputMode="numeric"
            value={wcOrderId}
            onChange={(event) => setWcOrderId(event.target.value)}
            placeholder={row.wcOrderId ? `not ${row.wcOrderId}` : 'e.g. 10432'}
          />
          <p className="text-muted-foreground">
            The ID, not the order number the customer sees — read it off the <span className="font-mono">id=</span>{' '}
            in the address bar while the order is open in WooCommerce, or off the refund&apos;s own{' '}
            <span className="font-mono">parent_id</span>. They are the same number on a plain store and
            different ones wherever order numbering is customised{row.wcOrderId ? <> — this park&apos;s own order is ID <span className="font-mono">{row.wcOrderId}</span></> : null}.
          </p>
          <p className="text-muted-foreground">
            IMS will ask WooCommerce which refunds that order actually has, right now, and refuse if this
            refund is not one of them. If it is, the park moves there as PENDING and becomes retryable from
            that order — the refund itself has still not been applied.
          </p>
        </div>
      ) : null}

      {outcome === 'DISMISS' ? (
        <div className="space-y-1 max-w-lg">
          <label className="block text-muted-foreground" htmlFor={`dismiss-reason-${row.id}`}>
            What you found (optional, recorded on the park)
          </label>
          <Input
            id={`dismiss-reason-${row.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. refund deleted in WooCommerce on 12 Aug"
          />
          <p className="text-muted-foreground">
            IMS will ask WooCommerce which refunds THIS order actually has, right now, and refuse if this
            refund is still one of them. Dismissing only removes a park WooCommerce contradicts — it does
            not apply the refund anywhere, so if the money did leave the business, reassign it instead
            wherever its real order is known.
          </p>
          {row.wcOrderId ? null : (
            <p className="text-destructive">
              This order has no WooCommerce link, so there is no order for IMS to ask about and a dismissal
              cannot be verified. Reassign it to the order that really holds the refund instead.
            </p>
          )}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          onClick={() => {
            if (outcome === 'REASSIGN' && wcOrderIdValid) onSubmit({ outcome: 'REASSIGN', wcOrderId: parsedWcOrderId })
            else if (outcome === 'DISMISS') onSubmit(reason.trim() ? { outcome: 'DISMISS', reason: reason.trim() } : { outcome: 'DISMISS' })
          }}
        >
          Check WooCommerce and recover
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
