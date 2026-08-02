/**
 * EU right-of-withdrawal requests from WooCommerce (o3d-e1yb, [wdraw]).
 *
 * A customer files a withdrawal through the WebToffee EU Order Withdrawal
 * Button plugin, which moves the WooCommerce order between custom statuses:
 *
 *   submitted -> `wc-pending-wdraw`
 *   approved  -> `wc-withdrawn`
 *   rejected  -> back to whatever it was before (there is no "rejected" status)
 *
 * IMS needs almost no new machinery for this. The WMS push sweep already has
 * a HOLD pass (an ON_HOLD order is pulled back out of the WMS and parked
 * HELD, dead-lettering with an operator comment when the WMS order is past
 * NEW) and a CANCEL pass. So a withdrawal is expressed as an ordinary IMS
 * lifecycle transition and the existing, proven passes do the warehouse work:
 *
 *   submitted -> ON_HOLD    (hold pass pulls it back from the WMS)
 *   approved  -> CANCELLED  (cancel pass cancels it at the WMS)
 *
 * The ONE thing that needs new code is the rejection. A rejection returns the
 * WooCommerce order to its previous status, which maps to PROCESSING — and
 * the sweep's release pass re-pushes any HELD link whose order is back in a
 * ready status. That would silently return goods to the pick line off a
 * customer-facing status change. Automatic release is deliberately NOT
 * implemented — the same decision the standalone WooCommerce<->WMS sync
 * shipped with: a withdrawal hold is released by an operator, never by a
 * storefront status transition.
 *
 * `withdrawalHoldAt` on the sales order is what marks a hold as
 * withdrawal-originated. While it is set:
 *   - inbound WooCommerce status transitions are refused (they would release),
 *   - the sweep's release pass skips the link.
 */

import { randomUUID } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getSettingValues } from '@/lib/settings-store'
import { INTERNAL_STATUS_TRANSITION_AUTH_ONLY } from '@/lib/sales/status-transition-bypass'
import type { WcFullOrder } from './types'

/** Settings keys, so a store that renames the plugin's statuses can follow. */
export const WDRAW_SUBMITTED_STATUS_KEY = 'wc_withdrawal_submitted_status'
export const WDRAW_APPROVED_STATUS_KEY = 'wc_withdrawal_approved_status'

/** WebToffee's defaults. WooCommerce reports statuses without the `wc-` prefix. */
export const DEFAULT_WDRAW_SUBMITTED_STATUS = 'pending-wdraw'
export const DEFAULT_WDRAW_APPROVED_STATUS = 'withdrawn'

export type WithdrawalKind =
  | 'not-a-withdrawal'
  | 'submitted'
  | 'approved'
  | 'already-held'
  | 'rejected-held'
  /** The withdrawal was approved and the order cancelled. That is terminal:
   *  no later storefront status may move it. */
  | 'approved-terminal'

export type WithdrawalOutcome =
  | { kind: 'not-a-withdrawal' }
  // `handled` means the caller must not fall through to its status mapping.
  // `result` is the transition's own outcome and MUST be propagated: a
  // handled-but-failed withdrawal that acknowledged the webhook would leave
  // the order fulfillable with only a warning log, and no delivery would ever
  // retry it.
  | { kind: Exclude<WithdrawalKind, 'not-a-withdrawal'>; handled: true; result: TransitionResult }

export type TransitionResult = { success: boolean; error?: string; permanent?: boolean }

/** Lifecycle states where the goods have gone. A withdrawal is then a RETURN,
 *  not a hold or a cancellation, and forcing either would falsify the
 *  lifecycle against real dispatch evidence. */
const POST_DISPATCH: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

export function normaliseStatus(status: unknown): string {
  const s = String(status ?? '').trim().toLowerCase()
  // WooCommerce reports `processing`, but a setting may be entered as
  // `wc-processing`. NB startsWith + slice, never lstrip-style character
  // stripping, which would turn "withdrawn" into "ithdrawn".
  return s.startsWith('wc-') ? s.slice(3) : s
}

export async function getWithdrawalStatuses(): Promise<{ submitted: string; approved: string }> {
  const map = await getSettingValues([WDRAW_SUBMITTED_STATUS_KEY, WDRAW_APPROVED_STATUS_KEY])
  const submitted = normaliseStatus(map.get(WDRAW_SUBMITTED_STATUS_KEY) || DEFAULT_WDRAW_SUBMITTED_STATUS)
  const approved = normaliseStatus(map.get(WDRAW_APPROVED_STATUS_KEY) || DEFAULT_WDRAW_APPROVED_STATUS)
  return { submitted, approved }
}

/**
 * Handle the withdrawal aspect of an inbound WooCommerce order status.
 *
 * Returns `not-a-withdrawal` when the caller should carry on with its normal
 * status mapping; every other result means this function has taken
 * responsibility for the transition.
 */
/**
 * The whole decision, as a pure function — no database, no settings lookup.
 *
 * `hasHold` is whether the order already carries a withdrawal hold.
 */
export function classifyWithdrawalStatus(
  wcStatus: unknown,
  statuses: { submitted: string; approved: string },
  hasHold: boolean,
  wasApproved = false,
): WithdrawalKind {
  const status = normaliseStatus(wcStatus)
  // An approved withdrawal is TERMINAL and outranks everything below. The hold
  // marker is cleared once the order is cancelled, so without this a delayed
  // pre-approval `processing` delivery sees no marker, falls through to the
  // ordinary status mapping — which uses the FULL transition bypass — and
  // forces the cancelled order back to PROCESSING. Its WMS link then becomes
  // releasable and withdrawn goods go back to the warehouse.
  if (wasApproved && status !== normaliseStatus(statuses.approved)) return 'approved-terminal'
  // Approved is checked FIRST. If a store ever configured the two to the same
  // slug, cancelling is the safer reading of an ambiguous configuration than
  // holding — and it keeps the branch order independent of hasHold.
  if (status === normaliseStatus(statuses.approved)) return 'approved'
  if (status === normaliseStatus(statuses.submitted)) return hasHold ? 'already-held' : 'submitted'
  // Any OTHER status while a hold is in force is the rejection: the plugin has
  // put the order back where it was. Applying it would let the sweep's release
  // pass re-push the order.
  if (hasHold) return 'rejected-held'
  return 'not-a-withdrawal'
}

export async function handleWcWithdrawalStatus(
  wcOrder: WcFullOrder,
  order: {
    id: string
    status: string
    externalOrderNumber: string | null
    withdrawalHoldAt: Date | null
    withdrawalApprovedAt: Date | null
  },
): Promise<WithdrawalOutcome> {
  const statuses = await getWithdrawalStatuses()
  const kind = classifyWithdrawalStatus(
    wcOrder.status, statuses,
    Boolean(order.withdrawalHoldAt), Boolean(order.withdrawalApprovedAt),
  )

  if (kind === 'approved-terminal') {
    await note(order.id, wcOrder, 'wc_withdrawal_post_approval_status_ignored', 'INFO',
      `Ignored WooCommerce status "${wcOrder.status}" — this order's EU withdrawal request was `
      + 'approved and the order cancelled, so no later storefront status may move it.')
    return { kind, handled: true, result: { success: true } }
  }

  if (kind === 'already-held') {
    // NOT simply success. The marker is written before the transition, so a
    // hold whose ON_HOLD transition failed leaves exactly this state — and
    // treating it as done means no redelivery ever repairs the status. The
    // order would sit blocked from the warehouse (safe) but with a lifecycle
    // that lies about it, and nothing would say so. Re-run the hold, which is
    // idempotent: it re-reads under the lock and no-ops when already ON_HOLD.
    return { kind, handled: true, result: await applyWithdrawalHold(order.id, wcOrder) }
  }

  if (kind === 'submitted') {
    return { kind, handled: true, result: await applyWithdrawalHold(order.id, wcOrder) }
  }

  if (kind === 'approved') {
    // Approval is TERMINAL: it sets withdrawalApprovedAt, cancels the order,
    // and makes every later storefront status ignored. The inbox does not
    // guarantee ordering, so a delayed `withdrawn` payload can arrive after
    // WooCommerce has already rejected the request — and cancelling a valid
    // order on that basis is unrecoverable through this path. Confirm against
    // the live storefront first; one API call, only on approval events.
    // (Codex r10)
    return { kind, handled: true, result: await applyConfirmedWithdrawalApproval(order.id, wcOrder) }
  }

  if (kind === 'rejected-held') {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: order.id,
      action: 'wc_withdrawal_rejected_hold_retained',
      tag: 'sync',
      level: 'WARNING',
      description:
        `WooCommerce order #${order.externalOrderNumber ?? wcOrder.id} left withdrawal `
        + `(now "${wcOrder.status}"), so the request was rejected. The IMS hold has been `
        + `KEPT: releasing it would return the goods to the pick line off a customer-facing `
        + `status change. Release the order by hand once you are satisfied.`,
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status, withdrawalHoldAt: order.withdrawalHoldAt },
      resolveUser: false,
    })
    // Record the ordinary status as HANDLED (o3d-6x66). Without this the last
    // handled status stays on the submitted slug forever, so a customer who
    // submits AGAIN compares equal, the generation never advances, and an
    // operator holding the old generation can release the newer request. The
    // hold itself is deliberately retained; only the marker moves on.
    //
    // Under the ORDER LOCK and guarded by the event version: a delayed
    // rejection must not overwrite the marker a NEWER resubmission already
    // advanced, or the resubmission is silently un-recorded.
    const rejectionAt = wcEventTimestamp(wcOrder)
    await withOrderLock(order.id, async (current, tx) => {
      if (rejectionAt && current.withdrawalLastWcEventAt && rejectionAt <= current.withdrawalLastWcEventAt) {
        return // a newer event already landed; this rejection is stale
      }
      await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          withdrawalLastWcStatus: normaliseStatus(wcOrder.status),
          ...(rejectionAt ? { withdrawalLastWcEventAt: rejectionAt } : {}),
        },
      })
    })
    return { kind, handled: true, result: { success: true } }
  }

  return { kind: 'not-a-withdrawal' }
}

/**
 * Claim the order row and re-read its CURRENT state.
 *
 * The internal bypass disables the lifecycle state-machine guard, so nothing
 * else stops a delayed `submitted` delivery dragging a CANCELLED or genuinely
 * SHIPPED order backwards to ON_HOLD, or an older submission overwriting a
 * concurrent approval's CANCELLED. Serialising on the same row lock the WMS
 * create claim takes is what makes these mutually exclusive rather than
 * merely racing.
 */
type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

async function withOrderLock<T>(
  orderId: string,
  fn: (
    current: {
      status: string
      withdrawalHoldAt: Date | null
      withdrawalApprovedAt: Date | null
      withdrawalLastWcStatus: string | null
      withdrawalLastWcEventAt: Date | null
    },
    tx: TxClient,
  ) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    if (locked.length === 0) return null
    const current = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        status: true, withdrawalHoldAt: true, withdrawalApprovedAt: true,
        withdrawalLastWcStatus: true, withdrawalLastWcEventAt: true,
      },
    })
    if (!current) return null
    // `tx`, never the global client: a write to this row through `db` would
    // wait on the FOR UPDATE lock that this very transaction holds and cannot
    // release until the callback returns — a self-deadlock that stalls every
    // submitted withdrawal until the statement times out.
    return fn(current, tx)
  })
}

async function applyWithdrawalHold(orderId: string, wcOrder: WcFullOrder): Promise<TransitionResult> {
  const incomingStatus = normaliseStatus(wcOrder.status)
  const eventAt = wcEventTimestamp(wcOrder)
  const claim = await withOrderLock(orderId, async (current, tx) => {
    // Is this a genuinely NEW customer submission, or a redelivery of the one
    // we already handled? The retained `withdrawalHoldAt` cannot tell us: a
    // rejection deliberately leaves it in place, so a customer who submits
    // again lands on an order that is ALREADY held and marked. The handled
    // status can: it only reads `submitted` once the slug has moved away and
    // back. (o3d-6x66, Codex r1)
    // Two things make an event "new": the handled status moved, OR this
    // submitted event is strictly NEWER than the one we last handled. The
    // second case matters because the inbox does not guarantee per-order
    // ordering — a delayed rejection can still be in flight, so a resubmission
    // can arrive while the handled status still reads `submitted`. Comparing
    // status alone would treat it as a redelivery and never advance the
    // generation, leaving a stale operator release able to clear it.
    const isNewer = eventAt !== null
      && (current.withdrawalLastWcEventAt === null || eventAt > current.withdrawalLastWcEventAt)
    const isNewSubmission = current.withdrawalLastWcStatus !== incomingStatus || isNewer
    if (isNewSubmission) {
      await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          withdrawalHoldGeneration: { increment: 1 },
          withdrawalLastWcStatus: incomingStatus,
          ...(eventAt ? { withdrawalLastWcEventAt: eventAt } : {}),
        },
      })
    }
    if (POST_DISPATCH.has(current.status)) {
      return { skip: 'post-dispatch' as const, status: current.status, marker: current.withdrawalHoldAt }
    }
    if (current.status === 'CANCELLED') {
      return { skip: 'cancelled' as const, status: current.status, marker: current.withdrawalHoldAt }
    }
    // An existing marker is NOT a reason to stop: the transition may have
    // failed after it was written. Only an order already IN the target state
    // is genuinely nothing to do.
    if (current.withdrawalHoldAt && current.status === 'ON_HOLD') {
      return { skip: 'already-held' as const, status: current.status, marker: current.withdrawalHoldAt }
    }
    if (current.withdrawalHoldAt) return { skip: null, status: current.status, marker: current.withdrawalHoldAt }
    // Mark the hold INSIDE the lock and BEFORE the transition. If the
    // transition then fails the marker still blocks the WMS create and the
    // release pass, which is the safe direction.
    //
    // Only stamp it once: a repair run must not keep pushing the "held since"
    // timestamp forward, or the operator loses how long the order has been
    // stuck.
    if (!current.withdrawalHoldAt) {
      // heldSince is stamped once and never moved (an operator needs to see
      // how long the order has REALLY been held), so it cannot tell "the same
      // hold, repaired" from "a newer customer request". The generation can:
      // it advances only for a newly handled submission, and the operator
      // release compares it. (o3d-6x66)
      // The generation was already advanced above when this is a new
      // submission; here we only stamp when the hold began.
      await tx.salesOrder.update({
        where: { id: orderId },
        data: { withdrawalHoldAt: new Date() },
      })
    }
    return { skip: null, status: current.status, marker: current.withdrawalHoldAt }
  })

  if (claim === null) return { success: false, error: `Sales order ${orderId} not found`, permanent: true }

  if (claim.skip === 'post-dispatch') {
    // Clear any marker left by a racing earlier attempt. Leaving it makes every
    // later ordinary webhook (`completed`, `delivered`) classify as
    // rejected-held and short-circuit the status mapping, stranding the IMS
    // lifecycle behind the storefront until somebody notices.
    await clearStaleMarker(orderId, claim.marker)
    await note(orderId, wcOrder, 'wc_withdrawal_after_dispatch', 'WARNING',
      `Customer filed an EU withdrawal request, but the order is already ${claim.status}. `
      + 'The goods have gone, so this is a RETURN, not a hold — handle it as one. No IMS status change was made.')
    return { success: true }
  }
  if (claim.skip === 'cancelled') {
    await clearStaleMarker(orderId, claim.marker)
    await note(orderId, wcOrder, 'wc_withdrawal_already_cancelled', 'INFO',
      'Customer filed an EU withdrawal request on an order that is already cancelled — nothing to do.')
    return { success: true }
  }
  if (claim.skip === 'already-held') return { success: true }

  const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')
  // AUTH_ONLY, not the full bypass. The lifecycle state machine then runs
  // against the row the transition reads under its OWN lock, which is the only
  // place the check is not stale: our locked read has already committed by the
  // time we get here, so a concurrent approval could have cancelled the order
  // in between and the full bypass would happily overwrite that.
  //
  // Not `skipPermissionCheck` either — that is a plain boolean on a
  // module-wide `'use server'` export, so it crosses the RPC boundary and is
  // forgeable (o3d-43oz). A symbol cannot be serialized.
  const result = await applySalesOrderStatusTransition(orderId, 'ON_HOLD' as never, undefined, {
    pushStatusToWooCommerce: false,
    internalBypassToken: INTERNAL_STATUS_TRANSITION_AUTH_ONLY,
  })

  await note(orderId, wcOrder,
    result.success ? 'wc_withdrawal_hold_applied' : 'wc_withdrawal_hold_failed',
    result.success ? 'INFO' : 'WARNING',
    result.success
      ? 'Customer filed an EU withdrawal request — order placed ON HOLD; the WMS push sweep will pull it back from the warehouse.'
      : `Customer filed an EU withdrawal request but the IMS hold could not be applied: ${result.error}. `
        + 'The withdrawal marker IS set, so the order will not be pushed to the warehouse, but its status is wrong — this will be retried.')
  return result
}

async function applyWithdrawalApproval(orderId: string, wcOrder: WcFullOrder): Promise<TransitionResult> {
  // Decide AND record inside the lock.
  //
  // Recorded BEFORE the cancellation for the crash window: if the cancellation
  // then fails, the order is left uncancelled but PROTECTED, and a redelivered
  // approval — which the terminal guard deliberately lets through — retries it.
  const claim = await withOrderLock(orderId, async (current, tx) => {
    // Recorded for EVERY branch, and always inside the lock. The terminal
    // branches below release the lock and then return, so a fact written
    // afterwards leaves a window in which a delayed ordinary webhook can take
    // the lock and force PROCESSING through the full bypass.
    //
    // Safe for post-dispatch now that the locked guard permits whatever the
    // state machine permits from the current status: a return can still reach
    // COMPLETED/DELIVERED, only backward moves are refused.
    if (!current.withdrawalApprovedAt) {
      await tx.salesOrder.update({ where: { id: orderId }, data: { withdrawalApprovedAt: new Date() } })
    }
    return { status: current.status, marker: current.withdrawalHoldAt }
  })
  if (claim === null) return { success: false, error: `Sales order ${orderId} not found`, permanent: true }

  if (POST_DISPATCH.has(claim.status)) {
    await clearStaleMarker(orderId, claim.marker)
    await note(orderId, wcOrder, 'wc_withdrawal_approved_after_dispatch', 'WARNING',
      `EU withdrawal request approved, but the order is already ${claim.status}. `
      + 'Cancelling would falsify the lifecycle against real dispatch evidence — handle this as a RETURN.')
    return { success: true }
  }
  if (claim.status === 'CANCELLED') {
    // Already where we want it; the approval fact was recorded under the lock
    // above. Clear the hold so the order is not left blocked by one that no
    // longer means anything.
    await clearStaleMarker(orderId, claim.marker)
    return { success: true }
  }

  const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')
  // As above: AUTH_ONLY, so the state machine refuses a stale cancellation
  // against the live row rather than forcing it.
  const result = await applySalesOrderStatusTransition(orderId, 'CANCELLED' as never, undefined, {
    pushStatusToWooCommerce: false,
    internalBypassToken: INTERNAL_STATUS_TRANSITION_AUTH_ONLY,
  })

  // Clear the marker only on success. Clearing it regardless would drop the
  // create/release block while the order was still uncancelled.
  if (result.success) {
    await clearStaleMarker(orderId, claim.marker)
  }

  await note(orderId, wcOrder,
    result.success ? 'wc_withdrawal_approved' : 'wc_withdrawal_approval_failed',
    result.success ? 'INFO' : 'WARNING',
    result.success
      ? 'EU withdrawal request approved — order cancelled; the WMS push sweep will cancel it at the warehouse.'
      : `EU withdrawal request approved but the IMS cancellation failed: ${result.error}. The order is NOT cancelled; this will be retried.`)
  return result
}

/**
 * Drop a marker that has outlived its meaning, i.e. the order reached a
 * terminal state anyway. Leaving it set keeps blocking the WMS passes AND
 * makes every later ordinary webhook classify as `rejected-held`.
 */
async function clearStaleMarker(orderId: string, observed: Date | null): Promise<void> {
  if (!observed) return
  // Conditional on BOTH the marker value we saw under the lock and the order
  // still being terminal. An unconditional clear would wipe a NEWER
  // submission's marker, silently discarding a customer request that arrived
  // while we were deciding this one was stale — and the status predicate
  // covers the case where the order became fulfillable again in between.
  await db.salesOrder.updateMany({
    where: {
      id: orderId,
      withdrawalHoldAt: observed,
      status: { in: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] },
    },
    data: { withdrawalHoldAt: null },
  })
}

async function note(
  orderId: string,
  wcOrder: WcFullOrder,
  action: string,
  level: 'INFO' | 'WARNING',
  description: string,
): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action,
    tag: 'sync',
    level,
    description,
    metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status },
    resolveUser: false,
  })
}

/**
 * Should this WooCommerce payload be imported at all?
 *
 * An order in a withdrawal status that IMS has never seen must NOT be created
 * by the ordinary import path: with no status mapping for the custom slug,
 * importWcOrder creates it as PROCESSING, which allocates stock and can queue
 * its accounting invoice — for an order the customer has asked to withdraw.
 * A crash before the withdrawal handler runs then leaves it warehouse-eligible.
 *
 * Shared by EVERY ingestion path (both webhook topics, polling, reconcile),
 * because a missed `order.created` means the first event IMS ever sees for an
 * order can be a withdrawal update.
 *
 * Returns true when the caller should skip the import and surface it instead.
 */
/**
 * The live WooCommerce status of a suppressed order could not be read, so we
 * cannot tell whether the withdrawal still stands.
 *
 * Thrown rather than returned: "keep suppressing" and "we do not know" must
 * not be the same value to the caller. Returning `true` here would look like a
 * clean skip, the inbox would acknowledge the event, and if that was the only
 * ordinary event for the order it would never be imported at all.
 */
export class WithdrawalSuppressionUnresolved extends Error {
  constructor(public readonly externalOrderId: string) {
    super(`Could not read the live WooCommerce status for suppressed order ${externalOrderId}`)
    this.name = 'WithdrawalSuppressionUnresolved'
  }
}

/**
 * A suppression may have been written by a CONCURRENT worker between our
 * "is it suppressed?" check and the import that followed it (o3d-d82p).
 *
 * Deliberately a compensation rather than a lock. Holding a Prisma interactive
 * transaction across the import — the obvious fix — pins one pooled connection
 * purely to hold the lock while the import needs another, so enough concurrent
 * imports deadlock the pool against itself. Converging afterwards costs one
 * query on a path that only runs for orders we just created, and reaches the
 * same end state: the order exists but is held and marked, so the WMS sweep
 * will not touch it.
 *
 * Call after a SUCCESSFUL import of a previously unlinked order.
 */
/** `date_modified_gmt` as a Date, or null when WooCommerce sent nothing usable. */
function wcEventTimestamp(wcOrder: WcFullOrder): Date | null {
  const raw = wcOrder.date_modified_gmt || wcOrder.date_modified
  if (!raw) return null
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The ONE safe way to import a WooCommerce order that may be unlinked.
 *
 * Every ingress path — the two webhook topics, the poll, the pending-FX retry
 * queue and the initial import — has to do the same three things in the same
 * order, and each one that open-codes them is a way to lose a withdrawal.
 * The FX retry and the initial import each did exactly that: they imported a
 * possibly-stale snapshot with no suppression check and no compensation, so an
 * order withdrawn while it sat in the queue came back as a paid PROCESSING
 * order with no marker, and stayed warehouse-eligible until the next
 * reconciliation. That is not a millisecond window. (o3d-d82p, Codex r4)
 *
 * `suppressionHandled` tells the caller a withdrawal transition was just
 * applied, so it can skip synchronising the STALE payload's ordinary status
 * over the hold it just created — which would otherwise classify as
 * rejected-held and invite an operator to release a live withdrawal.
 */
export async function importWcOrderGuarded<R extends { success: boolean }>(
  wcOrder: WcFullOrder,
  runImport: () => Promise<R>,
): Promise<
  | { outcome: 'skipped-withdrawal' }
  | { outcome: 'unresolved' }
  | { outcome: 'imported'; result: R; suppressionHandled: boolean; compensationFailed: boolean }
> {
  let decision: SuppressionDecision
  try {
    decision = await shouldSkipUnlinkedWithdrawalImport(wcOrder)
  } catch (e) {
    if (e instanceof WithdrawalSuppressionUnresolved) return { outcome: 'unresolved' }
    throw e
  }
  if (decision.suppress) return { outcome: 'skipped-withdrawal' }

  const result = await runImport()

  // Hand the claim back — never consume it here (Codex r13).
  //
  // The resolver's "the request was rejected" read happened BEFORE the import.
  // If the customer resubmits or is approved while the import is running and
  // that webhook is missed, consuming on the strength of that pre-import read
  // deletes the only durable signal for a withdrawal that is now live again.
  //
  // So there is exactly ONE post-import decision point: reconcile below claims
  // the row itself, re-reads the live status, and either applies the
  // withdrawal or consumes the tombstone. Fresh truth, one place, no second
  // read to keep in step with the first.
  if (decision.pendingConsume) {
    await releaseSuppression(String(wcOrder.id), decision.pendingConsume.token)
  }

  // NOT gated on wasUnlinked. The tombstone is the durable record that a
  // withdrawal still needs applying, and it survives a failed transition — so
  // a redelivery, a later poll or the FX retry must all be able to finish the
  // job even though the order is linked by then. Gating on wasUnlinked made
  // the "retryable" failure consumed by one ineffective retry. (Codex r6)
  const compensation = result.success
    ? await reconcileSuppressionAfterImport(wcOrder)
    : { handled: false, failed: false }
  // Two separate facts. `suppressionHandled` says "do not sync the stale
  // ordinary status over what we just applied" and holds even on failure.
  // `compensationFailed` says the withdrawal transition did NOT land, so the
  // caller must make the delivery retryable — acknowledging it would leave the
  // IMS lifecycle wrong until an independent reconciliation.
  return {
    outcome: 'imported',
    result,
    suppressionHandled: compensation.handled,
    compensationFailed: compensation.failed,
  }
}

/**
 * Record the withdrawal tombstone for an order we are NOT importing.
 *
 * Split out so the initial-import gate can call it while it is dropping the
 * order webhook itself: the tombstone is what the initial-import loop consults,
 * so it has to exist even though nothing is being imported yet.
 */

/**
 * How long a withdrawal claim may be held before another worker may take it.
 * A crashed claimant must not pin a withdrawal forever; a live one must not be
 * overtaken mid-transition.
 */
const SUPPRESSION_LEASE_MS = 5 * 60_000

/**
 * How long a rejection must HOLD before the tombstone is retired.
 *
 * A single live read is not enough (Codex r14): a resubmission landing between
 * that read and the delete, whose webhook is then missed, is erased along with
 * the only durable signal — and the WMS create path checks only the IMS
 * markers, so its sweep could push the now-withdrawn order. Spanning two
 * by-ID sweep passes means a missed resubmission is found within minutes
 * instead of waiting for the daily reconciliation.
 */
const SUPPRESSION_QUIESCENCE_MS = 30 * 60_000

type SuppressionClaim = { token: string; wcStatus: string; revision: number }

/**
 * Take ownership of a withdrawal tombstone WITHOUT removing it (Codex r8).
 *
 * Claiming by DELETE was wrong twice over: the row stopped suppressing while
 * the claimant worked, and restoring it after a failure overwrote whatever a
 * concurrent worker had recorded in the meantime — so an acknowledged APPROVAL
 * could be replaced by an older `submitted` and later retried as a mere hold.
 *
 * Both the resolver and the compensation path must hold this BEFORE they make
 * any live-state or lifecycle decision, or the freshest decision does not
 * necessarily win: the resolver could observe a rejection while a compensation
 * was already cancelling on a stale approved tombstone.
 */
/**
 * Sweep withdrawal tombstones that nothing else will reach (o3d-d82p).
 *
 * Every other route to a tombstone depends on ANOTHER event arriving for that
 * order. But the poll queries only the operator-configured statuses plus
 * `completed` and the two withdrawal slugs — so an order whose withdrawal was
 * REJECTED back to, say, `pending` or `on-hold` under the default `processing`
 * configuration appears in no ingress at all, and its tombstone and its
 * unimported order sit there indefinitely.
 *
 * Fetches each suppressed order BY ID, so no status filter or modified cursor
 * can hide it. Unresolved reads stay put and are retried next run.
 */
export async function sweepWithdrawalSuppressions(limit = 50): Promise<{
  scanned: number; imported: number; stillWithdrawn: number; unresolved: number
}> {
  const staleBefore = new Date(Date.now() - SUPPRESSION_LEASE_MS)
  const rows = await db.wcWithdrawalSuppression.findMany({
    where: {
      connector: 'woocommerce',
      OR: [{ claimToken: null }, { claimedAt: { lt: staleBefore } }],
    },
    // Oldest-CHECKED first, not oldest-created (Codex r12). A fixed
    // createdAt prefix of rows that stay withdrawn or stay unreadable is
    // re-selected on every run forever, so nothing past the first batch is
    // ever looked at again. lastCheckedAt is stamped for EVERY outcome below,
    // so the queue always rotates.
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: Math.min(Math.max(limit, 1), 250),
    select: { externalOrderId: true },
  })

  const result = { scanned: rows.length, imported: 0, stillWithdrawn: 0, unresolved: 0 }
  const { importWcOrder } = await import('./order-import')
  for (const row of rows) {
    // Fetch the FULL order by id — no status filter, no modified cursor — then
    // put it through the ordinary guarded importer. Resolving the tombstone
    // without importing would delete the order's only durable retry signal and
    // strand it permanently: that is the whole scenario this sweep exists for.
    // Stamp the attempt BEFORE doing the work, so a row that throws or times
    // out still rotates to the back of the queue instead of blocking it.
    await db.wcWithdrawalSuppression.updateMany({
      where: { connector: 'woocommerce', externalOrderId: row.externalOrderId },
      data: { lastCheckedAt: new Date() },
    }).catch(() => {})

    const live = await readLiveWcOrder(row.externalOrderId)
    if (!live) {
      result.unresolved++
      continue
    }
    try {
      const guarded = await importWcOrderGuarded(live, () => importWcOrder(live))
      if (guarded.outcome === 'skipped-withdrawal') result.stillWithdrawn++
      else if (guarded.outcome === 'unresolved') result.unresolved++
      else if (guarded.result.success && !guarded.compensationFailed) result.imported++
      else result.unresolved++
    } catch (e) {
      result.unresolved++
      console.error(`[wc-withdrawal-sweep] ${row.externalOrderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** The live order, or null when it cannot be read. */
async function readLiveWcOrder(externalOrderId: string): Promise<WcFullOrder | null> {
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
    if (error || !data || typeof data !== 'object' || !('status' in data)) return null
    return data as WcFullOrder
  } catch {
    return null
  }
}

/** The live storefront status, or null when it cannot be read. */
async function readLiveWcStatus(externalOrderId: string): Promise<string | null> {
  const order = await readLiveWcOrder(externalOrderId)
  return order ? normaliseStatus(order.status) : null
}

async function claimSuppression(
  externalOrderId: string,
): Promise<SuppressionClaim | 'absent' | 'busy'> {
  const row = await db.wcWithdrawalSuppression.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { wcStatus: true, revision: true },
  })
  if (!row) return 'absent'

  const token = randomUUID()
  const staleBefore = new Date(Date.now() - SUPPRESSION_LEASE_MS)
  const claimed = await db.wcWithdrawalSuppression.updateMany({
    where: {
      connector: 'woocommerce',
      externalOrderId,
      revision: row.revision,
      OR: [{ claimToken: null }, { claimedAt: { lt: staleBefore } }],
    },
    data: { claimToken: token, claimedAt: new Date() },
  })
  // 'busy' is emphatically NOT 'absent'. Conflating them let a caller
  // acknowledge its delivery and sync a stale ordinary status while another
  // worker was still mid-transition — and if that worker then died, nothing
  // retried. (Codex r10)
  if (claimed.count === 0) return 'busy'
  return { token, wcStatus: row.wcStatus, revision: row.revision }
}

/**
 * Retire a tombstone whose rejection has HELD for the quiescence window.
 *
 * The first rejection observation only starts the clock and returns false —
 * the order still imports (it was rejected), but the durable signal survives so
 * the sweep keeps re-checking it. Returns true once the row is actually gone.
 */
async function retireIfQuiescent(externalOrderId: string, claim: SuppressionClaim): Promise<boolean> {
  const row = await db.wcWithdrawalSuppression.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { clearPendingSince: true },
  })
  const since = row?.clearPendingSince
  if (!since) {
    await db.wcWithdrawalSuppression.updateMany({
      where: { connector: 'woocommerce', externalOrderId, claimToken: claim.token },
      data: { clearPendingSince: new Date() },
    })
    return false
  }
  if (Date.now() - since.getTime() < SUPPRESSION_QUIESCENCE_MS) return false

  // One last live read immediately before the delete. Quiescence proves the
  // rejection is OLD, not that nothing arrived since the read that started this
  // pass — and once the row is gone there are no further by-ID checks.
  // (Codex r15.) The WMS create claim also fences on this row, so the residual
  // read-to-delete gap cannot dispatch an order even if it loses this check.
  const { submitted, approved } = await getWithdrawalStatuses()
  const finalLive = await readLiveWcStatus(externalOrderId)
  if (finalLive === null || finalLive === submitted || finalLive === approved) return false

  await consumeSuppression(externalOrderId, claim)
  return true
}

/** Give the claim back, leaving the row — and whatever status it now carries — intact. */
async function releaseSuppression(externalOrderId: string, token: string): Promise<void> {
  await db.wcWithdrawalSuppression.updateMany({
    where: { connector: 'woocommerce', externalOrderId, claimToken: token },
    data: { claimToken: null, claimedAt: null },
  })
}

/**
 * Retire a withdrawal we have finished with.
 *
 * Conditional on the revision as well as the token: if a NEWER withdrawal was
 * recorded while we held the claim, that is a different request and deleting it
 * would discard it. In that case the row simply stays, and the next ingress
 * path picks the new one up.
 */
async function consumeSuppression(externalOrderId: string, claim: SuppressionClaim): Promise<void> {
  const deleted = await db.wcWithdrawalSuppression.deleteMany({
    where: {
      connector: 'woocommerce', externalOrderId, claimToken: claim.token, revision: claim.revision,
    },
  })
  if (deleted.count === 0) await releaseSuppression(externalOrderId, claim.token)
}

export async function recordWithdrawalSuppressionIfWithdrawn(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'>,
): Promise<boolean> {
  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(wcOrder.status)
  if (status !== submitted && status !== approved) return false
  const externalOrderId = String(wcOrder.id)
  await db.wcWithdrawalSuppression.upsert({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    create: { connector: 'woocommerce', externalOrderId, wcStatus: status },
    // Deliberately does NOT clear an active lease. Doing so let an out-of-order
    // redelivery evict a worker mid-decision, and this function is given no
    // event version with which to prove it is newer. It does not need to: the
    // claimant decides from the LIVE storefront status, so it will act on
    // whatever is actually true — including this change. Bumping the revision
    // is enough, because consumeSuppression is conditional on it, so the
    // claimant releases rather than deleting a request it never evaluated.
    // clearPendingSince resets: a NEW withdrawal restarts the quiescence clock,
    // so a request recorded during a pending clear is never retired by it.
    update: {
      wcStatus: status, revision: { increment: 1 }, lastCheckedAt: new Date(),
      clearPendingSince: null,
    },
  })
  return true
}

/**
 * Apply a withdrawal to an order that is ALREADY linked, returning false when
 * there is nothing to do (not a withdrawal status, or no link yet).
 *
 * Used by the initial-import gate: an order imported earlier in the same
 * still-running job is linked, and that job never revisits it, so recording a
 * tombstone alone would leave a paid PROCESSING order fulfillable.
 */
/**
 * Apply a withdrawal APPROVAL only after confirming it against the live
 * storefront (Codex r10/r11).
 *
 * Approval is terminal: it sets withdrawalApprovedAt, cancels the order, and
 * makes every later storefront status ignored. The inbox does not guarantee
 * ordering, so a delayed `withdrawn` payload can arrive after WooCommerce has
 * already rejected the request — and cancelling a valid order on that basis is
 * unrecoverable through this path.
 *
 * Shared by EVERY approval site. A second, unconfirmed approval path is exactly
 * how this hole reopened after it was first closed.
 */
async function applyConfirmedWithdrawalApproval(
  orderId: string,
  wcOrder: WcFullOrder,
): Promise<TransitionResult> {
  const { approved } = await getWithdrawalStatuses()
  const live = await readLiveWcStatus(String(wcOrder.id))
  if (live === null) {
    // Fail closed on the CANCELLATION, not on the order: do not act, and do not
    // acknowledge either, so the delivery is retried.
    return {
      success: false,
      error: 'Could not confirm the withdrawal approval against WooCommerce; not cancelling on an unverified payload',
    }
  }
  if (live !== approved) {
    await note(orderId, wcOrder, 'wc_withdrawal_stale_approval_ignored', 'WARNING',
      `A withdrawal-approved event arrived for this order, but WooCommerce now reports "${live}" — `
      + 'the request was rejected after that event was sent. The order was NOT cancelled.')
    return { success: true }
  }
  return applyWithdrawalApproval(orderId, wcOrder)
}

export async function applyWithdrawalToLinkedOrder(
  wcOrder: WcFullOrder,
): Promise<boolean> {
  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(wcOrder.status)
  if (status !== submitted && status !== approved) return false

  const link = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(wcOrder.id) } },
    select: { orderId: true },
  })
  if (!link?.orderId) return false

  const result = status === approved
    ? await applyConfirmedWithdrawalApproval(link.orderId, wcOrder)
    : await applyWithdrawalHold(link.orderId, wcOrder)
  // A failure must not read as "handled": the caller falls back to the
  // tombstone, so the withdrawal is retried by the next ingress path.
  return result.success
}


/**
 * A withdrawal tombstone says only "this order needs checking" — never WHAT to
 * do about it (Codex r9).
 *
 * Earlier versions decided from the tombstone's remembered status, or from the
 * payload that happened to trigger the import. Both are snapshots, and the
 * WooCommerce inbox guarantees neither ordering nor uniqueness, so every round
 * of review found another interleaving where a stale snapshot outranked a
 * fresher one: an old approval cancelling a rejected order, a delayed
 * `submitted` downgrading an approval to a releasable hold. Fencing the lease
 * harder does not fix that — two workers reading DIFFERENT remembered statuses
 * can both be correctly serialized and still disagree.
 *
 * So the decision comes from the LIVE storefront status, read under the claim.
 * Both workers then see the same truth whoever wins, an evicted or expired
 * lease cannot produce a contradictory decision, and no ordering has to be
 * proved. It costs one API call, only for an order that already has a
 * tombstone.
 */
export async function reconcileSuppressionAfterImport(
  wcOrder: WcFullOrder,
): Promise<{ handled: boolean; failed: boolean }> {
  const externalOrderId = String(wcOrder.id)
  const link = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { orderId: true },
  })
  if (!link?.orderId) return { handled: false, failed: false }

  const claim = await claimSuppression(externalOrderId)
  if (claim === 'absent') return { handled: false, failed: false }
  if (claim === 'busy') {
    // Another worker owns this withdrawal and has NOT finished. Report it
    // unfinished so the caller retries and does not sync its stale status over
    // a transition that is still in flight.
    return { handled: true, failed: true }
  }

  const { submitted, approved } = await getWithdrawalStatuses()
  const live = await readLiveWcStatus(externalOrderId)
  if (!live) {
    // Fail closed: leave the tombstone standing so the next ingress path
    // retries, and tell the caller this is unfinished.
    await releaseSuppression(externalOrderId, claim.token)
    await logActivity({
      entityType: 'SYNC', action: 'wc_withdrawal_suppression_unresolved', tag: 'sync', level: 'WARNING',
      description:
        `WooCommerce order #${wcOrder.number} was imported while a withdrawal was recorded for it, but the `
        + 'live status could not be read, so nothing was applied. The order is live and possibly withdrawn.',
      metadata: { externalOrderId: wcOrder.id, suppressedStatus: claim.wcStatus },
      resolveUser: true,
    })
    return { handled: true, failed: true }
  }

  if (live !== submitted && live !== approved) {
    // The storefront says the request was rejected — but do NOT retire the row
    // on one observation. Start (or check) the quiescence clock instead; the
    // by-ID sweep re-verifies until it elapses, so a resubmission whose webhook
    // was missed is still caught while the tombstone exists to catch it.
    const retired = await retireIfQuiescent(externalOrderId, claim)
    if (!retired) await releaseSuppression(externalOrderId, claim.token)
    return { handled: false, failed: false }
  }

  const isApproval = live === approved
  // Already decided from the live status a moment ago, so no second read.
  const result = isApproval
    ? await applyWithdrawalApproval(link.orderId, wcOrder)
    : await applyWithdrawalHold(link.orderId, wcOrder)

  if (result.success) await consumeSuppression(externalOrderId, claim)
  else await releaseSuppression(externalOrderId, claim.token)

  await logActivity({
    entityType: 'SYNC', action: 'wc_withdrawal_suppression_raced_import', tag: 'sync',
    level: result.success ? 'WARNING' : 'ERROR',
    description:
      `WooCommerce order #${wcOrder.number} was imported at the same moment a withdrawal request was `
      + `recorded for it (live status "${live}"). `
      + (result.success
        ? `The ${isApproval ? 'cancellation' : 'hold'} was applied to the order that was just created.`
        : `Applying the ${isApproval ? 'cancellation' : 'hold'} FAILED (${result.error ?? 'unknown'}) — `
          + 'this order is live and withdrawn. Handle it by hand now.'),
    metadata: { externalOrderId: wcOrder.id, liveStatus: live, suppressedStatus: claim.wcStatus },
    resolveUser: !result.success,
  })

  return { handled: true, failed: !result.success }
}

export async function shouldSkipUnlinkedWithdrawalImport(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'>,
): Promise<SuppressionDecision> {
  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(wcOrder.status)
  const externalOrderId = String(wcOrder.id)

  const existing = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { id: true },
  })
  if (existing) return { suppress: false }

  const isWithdrawal = status === submitted || status === approved

  if (!isWithdrawal) {
    // o3d-d82p: the payload in front of us is an ORDINARY status — but the
    // inbox does not guarantee per-order ordering, so this can be a STALE
    // `order.created` arriving after we already refused a withdrawal for the
    // same order. Without the tombstone it would sail straight past this
    // guard and import the order as PROCESSING, allocating stock.
    const suppressed = await db.wcWithdrawalSuppression.findUnique({
      where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
      select: { wcStatus: true },
    })
    if (!suppressed) return { suppress: false }
    return resolveSuppression(wcOrder, externalOrderId)
  }

  // Remember the refusal durably, so a stale ordinary payload arriving later
  // cannot import the order behind our back.
  await recordWithdrawalSuppressionIfWithdrawn(wcOrder)

  await logActivity({
    entityType: 'SYNC',
    action: 'wc_withdrawal_order_not_imported',
    tag: 'sync',
    level: 'WARNING',
    description:
      `WooCommerce order #${wcOrder.number} is in withdrawal status "${wcOrder.status}" and has never `
      + 'been imported. It was NOT created, because importing it would allocate stock for an order the '
      + 'customer has asked to withdraw. Review it by hand.',
    metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status },
    resolveUser: false,
  })
  return { suppress: true }
}

/**
 * A suppressed order has turned up again carrying an ordinary status. Decide
 * from the LIVE storefront state, not from this possibly-stale payload.
 *
 * One extra API call, and only ever for an order we already refused — never on
 * the ordinary new-order path.
 *
 * Fails CLOSED: if the live status cannot be read we keep suppressing, because
 * importing would allocate stock for goods the customer may still have
 * withdrawn.
 */
type SuppressionDecision = { suppress: true } | { suppress: false; pendingConsume?: SuppressionClaim }

async function resolveSuppression(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'>,
  externalOrderId: string,
): Promise<SuppressionDecision> {
  // Claim BEFORE reading the live status. Deciding first and claiming after
  // only serializes the workers; it does not make the freshest decision win.
  const claim = await claimSuppression(externalOrderId)
  if (claim === 'absent') return { suppress: false }
  if (claim === 'busy') {
    // Another worker owns this withdrawal RIGHT NOW — but "owned" is not
    // "finished", and returning a clean skip would let the caller acknowledge
    // what may be the only ordinary event this order ever sends. If the owner
    // then dies, nothing retries. Treat it as unresolved so the delivery is
    // redelivered and the poll leaves it for the next pass. (Codex r9)
    throw new WithdrawalSuppressionUnresolved(externalOrderId)
  }

  const { submitted, approved } = await getWithdrawalStatuses()
  const live = await readLiveWcStatus(externalOrderId)

  if (!live) {
    await db.wcWithdrawalSuppression.updateMany({
      where: { connector: 'woocommerce', externalOrderId, claimToken: claim.token },
      data: { lastCheckedAt: new Date() },
    }).catch(() => {})
    await releaseSuppression(externalOrderId, claim.token)
    await logActivity({
      entityType: 'SYNC', action: 'wc_withdrawal_suppression_unresolved', tag: 'sync', level: 'WARNING',
      description:
        `WooCommerce order #${wcOrder.number} arrived with status "${wcOrder.status}" but was previously `
        + `refused as a withdrawal ("${claim.wcStatus}"). The live status could not be read, so the import `
        + 'is still refused — importing could allocate stock for a withdrawn order.',
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status, suppressedStatus: claim.wcStatus },
      resolveUser: true,
    })
    throw new WithdrawalSuppressionUnresolved(externalOrderId)
  }

  if (live === submitted || live === approved) {
    await releaseSuppression(externalOrderId, claim.token)
    return { suppress: true } // still withdrawn
  }

  // The request was rejected. Do NOT retire the tombstone here: the import has
  // not happened yet, and if it fails or throws the only durable retry signal
  // would already be gone — recreating the stranded-order failure for statuses
  // outside the poll filter. Hand the CLAIM back to the caller, which consumes
  // it after a successful import and releases it otherwise. (Codex r12)
  await logActivity({
    entityType: 'SYNC', action: 'wc_withdrawal_suppression_cleared', tag: 'sync', level: 'INFO',
    description:
      `WooCommerce order #${wcOrder.number} was previously refused as a withdrawal ("${claim.wcStatus}"), `
      + `but its live status is now "${live}" — the request was rejected. Importing normally.`,
    metadata: { externalOrderId: wcOrder.id, liveStatus: live, suppressedStatus: claim.wcStatus },
    resolveUser: false,
  })
  return { suppress: false, pendingConsume: claim }
}
