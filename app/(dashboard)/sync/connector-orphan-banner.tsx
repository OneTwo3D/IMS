'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cancelOrphanedAccountingSyncRows } from '@/app/actions/accounting-sync'
import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'
import type { StrandedSyncRowsResult } from '@/lib/domain/accounting/stranded-sync-rows'
import { resolveConnectorOrphanBannerState } from '@/lib/domain/accounting/stranded-sync-visibility'
import { observeServerRender } from '@/lib/domain/accounting/server-render-marker'
import { SettleSyncRowControl } from './settle-sync-row-control'

const CONNECTOR_LABELS: Record<string, string> = { xero: 'Xero', quickbooks: 'QuickBooks' }

function connectorLabel(connector: string): string {
  return CONNECTOR_LABELS[connector] ?? connector
}

/**
 * What the banner is currently telling the operator about the last cancel attempt.
 *
 * A discriminated union rather than a formatted string (o3d-osl8 round 7, finding 3), because the
 * UNKNOWN case's wording depends on something that can change AFTER the message is set: whether the
 * refresh it asked for has actually landed. A string baked at catch time can only describe the
 * request; this can describe the outcome.
 */
type CancelOutcome =
  /** The action returned a typed `{ success: false }`. That path committed nothing, and says so. */
  | { kind: 'refused'; message: string }
  /**
   * The action REJECTED. Nothing here can tell a refusal from a lost reply, so nothing here may
   * claim either. `serverRenderedAtWhenRequested` is the render marker observed at the moment
   * `router.refresh()` was called — a STRICTLY GREATER marker means a newer server render has
   * arrived, which is a weaker fact than "the rows reflect the cancel" and is worded as such
   * (round 8, finding 4).
   */
  | { kind: 'unknown'; serverRenderedAtWhenRequested: number }

/**
 * audit-H4: warns when PENDING/PROCESSING accounting sync rows belong to a
 * connector that is no longer active (stranded by a connector switch). Lets the
 * operator bulk-cancel them so they stop accumulating silently.
 */
export function ConnectorOrphanBanner({
  summary,
  stranded = null,
  strandedLoadFailed = false,
  canCancel,
  serverRenderedAt,
}: {
  /**
   * NULLABLE on purpose. getCrossConnectorOrphanSummary() is fetched with .catch(() => null),
   * so a failure there must not take the stranded list down with it: those rows are the only
   * view of work stranded on a retired connector (o3d-osl8), and hiding them because an
   * unrelated aggregate query failed would silently remove the remedy this banner exists for.
   * When it is null the count paragraph and the per-connector cancel controls are simply absent
   * — there is no trustworthy total to act on — and the stranded list still renders.
   */
  summary: ConnectorOrphanSummary | null
  /**
   * o3d-osl8 item 1: the rows BEHIND the count. Every accounting log view is scoped to the
   * ACTIVE connector, so a row left on a retired one was previously visible only as the integer
   * above — and o3d-osl8 is explicit that "Do NOT present an aggregate count as a remedy" was
   * the specific criticism. Listing them with connector / type / reference / status / age / last
   * error is what makes them actionable at all.
   *
   * Each row now also carries a per-row REMEDY (o3d-osl8 item 2): the settlement control, which
   * records an operator's verified outcome for the attempt shown. Rows that cannot take one — a
   * DAILY_BATCH type, a PENDING row, or a row at attempt revision 0 — say so in place of the
   * control rather than silently omitting it. Null for a role without the `sync` permission (the
   * page does not fetch it) and also null when the fetch FAILED, which `strandedLoadFailed`
   * distinguishes.
   *
   * Carries `hasMore` / `total` because the list is truncated to the oldest N and nothing here
   * can clear the rows at the front of it.
   */
  stranded?: StrandedSyncRowsResult | null
  /**
   * The stranded-row read failed. Rendered as an explicit failure, NOT as an empty list: "we
   * could not look" and "there is nothing there" are opposite messages for the operator.
   */
  strandedLoadFailed?: boolean
  /**
   * o3d-osl8 round 5, finding 3. Whether this reader may actually run the cancel.
   *
   * REQUIRED, with no default, on purpose: a default would let a new call site inherit a guess,
   * and the guess this component made before was "everyone". `sync` is what gets a reader onto
   * this page; cancelOrphanedAccountingSyncRows is a destructive write and requires `settings`,
   * which MANAGER does not hold. Its gate throws a typed denial rather than returning
   * `{ success: false }`, and that throw happens outside the action's result-returning path — so
   * rendering the buttons for MANAGER produced a REJECTED action inside startTransition, with no
   * error line, no notice, and nothing in the UI to say why. The controls are therefore absent for
   * a reader who cannot use them, with the reason stated rather than left as a silent omission
   * (the rows themselves stay listed either way — reading them is what `sync` is for).
   */
  canCancel: boolean
  /**
   * o3d-osl8 round 7 finding 3, round 8 finding 4. A MONOTONIC marker of the server render that
   * produced the rows below. REQUIRED, and required for the same reason `canCancel` is: a default
   * would let a call site inherit a guess, and the only available guess ("it refreshed") is the lie
   * this exists to stop.
   *
   * The full reasoning — including why `!==` was not enough, and why genuine causality between this
   * marker and the cancel attempt is NOT achievable — lives with the source in
   * lib/domain/accounting/server-render-marker.ts. The short version: a greater marker proves a
   * newer render arrived, and nothing more, so the message below claims nothing more.
   */
  serverRenderedAt: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [outcome, setOutcome] = useState<CancelOutcome | null>(null)
  /**
   * o3d-sref: rows the cancel could not retire, because their claim had already been taken and a
   * request may have reached the connector. Shown HERE rather than only in the activity log — the
   * orphan count will not fall to zero for those rows, and a button that visibly does nothing with
   * no explanation reads as broken.
   */
  const [notice, setNotice] = useState<string | null>(null)

  // Every "is there anything to show" decision is the pure resolver's, so all of them can be
  // enumerated in one place rather than reached one page-state at a time.
  // The server summary is the source of truth: router.refresh() re-fetches it after a cancel, so
  // the banner hides (or shows the remainder) on its own.
  const strandedRows = stranded?.rows ?? []
  const bannerState = resolveConnectorOrphanBannerState({
    summary,
    rowCount: strandedRows.length,
    totalStrandedRows: stranded?.total ?? 0,
    hasMore: stranded?.hasMore ?? false,
    loadFailed: strandedLoadFailed,
  })
  if (!bannerState.render) return null

  // Derived at RENDER time, not at catch time: this is the whole mechanism. Strictly greater, not
  // merely different — a stale payload arriving late must not count as a refresh.
  const newerRenderArrived = outcome?.kind === 'unknown'
    && observeServerRender({ current: serverRenderedAt, whenRequested: outcome.serverRenderedAtWhenRequested }).newerRenderArrived

  function handleCancel(connector?: string) {
    setOutcome(null)
    setNotice(null)
    startTransition(async () => {
      // CATCH, unconditionally. Even with the controls hidden for a reader who cannot cancel, the
      // action can still REJECT rather than return: its permission gate throws (a stale session
      // whose role changed since this page rendered lands exactly here), the concurrency fence
      // throws to roll the transaction back, and any transport failure of the server action
      // rejects too. An uncaught rejection inside startTransition surfaces as a blank
      // non-response; the banner has an error line and it must be what the reader gets.
      //
      // Those three are NOT the same outcome, and the catch cannot distinguish them — see the
      // message below.
      try {
        const result = await cancelOrphanedAccountingSyncRows(connector)
        if (result.success) {
          const inFlight = result.inFlightNotCancelled ?? 0
          setNotice(inFlight > 0
            ? `${inFlight} row(s) could not be cancelled: their sync was already in flight when the `
              + `connector was switched off, so a request may have reached it and been lost. Check that `
              + `connector for the document(s) — these rows stay listed here, and continue to block `
              + `deleting their orders, until they are resolved.`
            : null)
          router.refresh()
        } else {
          setOutcome({ kind: 'refused', message: result.error ?? 'Failed to cancel orphaned rows.' })
        }
      } catch {
        // THE OUTCOME IS UNKNOWN, and saying anything stronger is a lie (o3d-osl8 round 6,
        // finding 3).
        //
        // This branch used to claim "nothing was cancelled". That is true of some of the things
        // that land here — the permission gate throwing, the concurrency fence rolling the
        // transaction back — and false of the rest: a server action can also fail in TRANSPORT,
        // and a reply lost after the server transaction committed arrives here identically. The
        // client cannot tell those apart, because a server action's error reaches it as an opaque
        // digest in production. Telling an operator that nothing was cancelled when rows may have
        // been is the worst available answer: it invites a confident retry against a state they
        // have not looked at.
        //
        // The guarantee of rollback belongs to the STRUCTURED refusals — the typed
        // `{ success: false }` results the action returns, handled above, which are only produced
        // on paths that committed nothing. This one gets "unknown".
        //
        // ROUND 7, FINDING 3. This branch used to add "The stranded rows below have been reloaded
        // from the server" — and then call router.refresh(). The claim preceded the act, and the
        // act cannot be verified from here: refresh() is void, may be served from cache, and may
        // fail. In the very scenario where the cancellation MAY have committed, that certified
        // stale rows as authoritative and invited a retry against them. So the marker in effect
        // when the refresh is REQUESTED is recorded here, and the wording below is decided at
        // render time by whether a strictly newer server payload has arrived.
        //
        // ROUND 8, FINDING 4. A newer payload is still not a payload read AFTER the cancel, and the
        // wording no longer implies it is.
        setOutcome({ kind: 'unknown', serverRenderedAtWhenRequested: serverRenderedAt })
        // Immediately, not on the next navigation: the list on screen was rendered before an
        // action that may have changed it.
        router.refresh()
      }
    })
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-2">
          {bannerState.showSummary && summary && (
            <p className="font-medium">
              {summary.totalOrphans} accounting sync row(s) are queued for a connector that is no longer active
              {summary.activeConnector ? ` (active: ${connectorLabel(summary.activeConnector)})` : ' (no accounting connector is enabled)'}.
              They will not be processed while that connector is inactive. Re-enable the connector to let them resume,
              {canCancel
                ? ' or cancel them below to permanently discard them. (Cancelling does not stop the document itself from syncing to the active connector later.)'
                : ' or ask an administrator to cancel them.'}
            </p>
          )}
          <ul className="space-y-1 text-xs">
            {(summary?.orphanGroups ?? []).map((group) => (
              <li key={group.connector} className="flex items-center gap-2">
                <span><span className="font-medium">{connectorLabel(group.connector)}</span>: {group.count} row(s)</span>
                {canCancel && (
                  <Button size="sm" variant="outline" className="h-6 text-xs" disabled={pending} onClick={() => handleCancel(group.connector)}>
                    {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel these'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canCancel && (summary?.orphanGroups.length ?? 0) > 1 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending} onClick={() => handleCancel()}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel all orphaned rows'}
            </Button>
          )}
          {/* Stated, not silently omitted: a missing button with no explanation reads as "there is
              nothing to do here", which is the opposite of the truth for a reader who can SEE the
              stranded rows below and cannot retire them. */}
          {!canCancel && (summary?.orphanGroups.length ?? 0) > 0 && (
            <p className="text-xs opacity-80">
              Cancelling these rows needs the <span className="font-medium">settings</span> permission, which your role
              does not have — ask an administrator. The rows themselves are listed below either way.
            </p>
          )}
          {outcome?.kind === 'refused' && <p className="text-xs text-destructive">{outcome.message}</p>}
          {outcome?.kind === 'unknown' && (
            <p className="text-xs text-destructive">
              The cancel request failed before it could report its outcome, so it is NOT known whether any rows were
              cancelled — the request may have been refused, or it may have completed and lost its reply.
              {newerRenderArrived
                // Observed, and deliberately NOT overclaimed (round 8, finding 4). What is known is
                // that a render newer than the one in effect when the refresh was requested has
                // arrived. What is NOT known — and cannot be, for an attempt whose reply was lost —
                // is whether that render happened after the cancel took effect.
                ? ' A NEWER server render of the rows below has since arrived. That is not proof they reflect this'
                  + ' attempt: a render already in flight when you pressed cancel arrives the same way, and a request'
                  + ' whose reply was lost can still commit after any render. Treat them as newer, not as'
                  + ' authoritative — check the activity log before retrying.'
                // The honest report of an unobservable completion.
                : ' A reload of the rows below was requested but has NOT been confirmed — it reports no completion, it can'
                  + ' be served from cache, and it can fail. Do NOT treat the rows below as authoritative: reload this page'
                  + ' yourself, and check the activity log, before retrying.'}
            </p>
          )}
          {notice && <p className="text-xs font-medium">{notice}</p>}
          {/* An explicit failure state. Silence here would read as "nothing is stranded", which
              is the opposite of what a failed read means. */}
          {bannerState.showLoadFailure && (
            <p className="text-xs font-medium text-destructive">
              The list of stranded sync rows could not be loaded, so it is not shown below. This does NOT mean there
              are none — any count above excludes rows that already failed, and those appear in no other view.
              Reload this page to try again.
            </p>
          )}
          {bannerState.showRows && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium">
                The rows themselves. {bannerState.rowsSummary} These do not appear in the sync log
                below — it only ever shows the ACTIVE connector. A stuck row keeps its order from being deleted, so
                each one needs either its connector re-enabling (which lets it resume) or the document checking in
                the accounting system it was queued for.
                {bannerState.truncated && ' The hidden rows stay hidden until the ones listed here are resolved.'}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-left opacity-70">
                    <tr>
                      <th className="pr-3 font-medium">Connector</th>
                      <th className="pr-3 font-medium">Type</th>
                      <th className="pr-3 font-medium">Reference</th>
                      <th className="pr-3 font-medium">Status</th>
                      <th className="pr-3 font-medium">Age</th>
                      <th className="pr-3 font-medium">Last error</th>
                      <th className="font-medium">Settle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strandedRows.map((row) => (
                      <tr key={row.id} className="align-top">
                        <td className="pr-3 py-0.5">{connectorLabel(row.connector)}</td>
                        <td className="pr-3 py-0.5 font-mono">{row.type.replace(/_/g, ' ')}</td>
                        <td className="pr-3 py-0.5 font-mono">
                          {row.referenceType}:{row.referenceId}
                          {/*
                            A stranded row that already carries an external id posted SOMETHING to
                            that connector before it stalled — the operator needs that token to find
                            the document, so it is shown rather than hidden behind the status.
                          */}
                          {row.externalTransactionId && (
                            <div className="opacity-70">posted as {row.externalTransactionId}</div>
                          )}
                        </td>
                        <td className="pr-3 py-0.5">
                          {row.status}
                          {/* The attempt the settlement control will name. Shown because the operator is
                              being asked to make a decision ABOUT it, and a refusal that says "this row
                              has moved on to attempt 4" is unreadable if attempt 3 was never on screen. */}
                          <div className="opacity-70">attempt {row.attemptRevision}</div>
                        </td>
                        <td className="pr-3 py-0.5 whitespace-nowrap">{row.ageDays}d</td>
                        <td className="pr-3 py-0.5 max-w-[24rem] break-words opacity-80">{row.errorMessage ?? '—'}</td>
                        <td className="py-0.5 whitespace-nowrap">
                          {/* o3d-osl8 item 2. The row's OWN remedy, next to the row — an aggregate
                              count with a bulk Cancel was the specific criticism, and a bulk cancel
                              cannot carry an assertion about one document anyway. */}
                          <SettleSyncRowControl
                            syncLogId={row.id}
                            status={row.status}
                            attemptRevision={row.attemptRevision}
                            type={row.type}
                            referenceType={row.referenceType}
                            referenceId={row.referenceId}
                            settleable={row.settleable}
                            notSettleableReason={row.notSettleableReason}
                            settleableOutcomes={row.settleableOutcomes}
                            caveat={row.settlementCaveat}
                            onSettled={() => router.refresh()}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
