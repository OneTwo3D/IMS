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
import { normaliseWcOrderStatus } from '../order-status-filter'
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

/**
 * Re-exported from the shared filter module so the withdrawal statuses and the
 * operator's `wc_sync_order_statuses` selection can never be normalised by two
 * different rules and then compared to each other.
 */
export const normaliseStatus = normaliseWcOrderStatus

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

/**
 * How long a RETIRED suppression keeps fencing fulfilment.
 *
 * Deleting outright ended the fence at the same instant as the decision to end
 * it, so a resubmission landing between the final live read and the delete —
 * with its webhook missed — left a warehouse-eligible order carrying neither
 * marker nor row (Codex r16). Retirement is a soft delete instead: the WMS
 * create claim keeps fencing, and the sweep keeps re-verifying, until the
 * grace elapses.
 */
const SUPPRESSION_RETIRE_GRACE_MS = 30 * 60_000

/**
 * How long a by-ID WooCommerce read may vouch for a retired suppression.
 *
 * Short on purpose: it is the window between proving the order is not
 * withdrawn and actually pushing it to the warehouse.
 */
const SUPPRESSION_SAFE_WINDOW_MS = 2 * 60_000

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
  scanned: number; imported: number; stillWithdrawn: number; unresolved: number; notAdmitted: number
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
    select: { externalOrderId: true, retiredAt: true },
  })

  const result = { scanned: rows.length, imported: 0, stillWithdrawn: 0, unresolved: 0, notAdmitted: 0 }
  const { importWcOrder } = await import('./order-import')
  const { resolveWcOrderCreateAdmission } = await import('./order-admission')
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

    // A RETIRED row is inside its fence grace: it exists only so a
    // resubmission that landed around the retirement decision is still caught.
    // Re-verify against the live status we just read, and revive it if the
    // storefront now says withdrawn. It must not be re-imported every pass.
    if (row.retiredAt) {
      const revived = await recordWithdrawalSuppressionIfWithdrawn(live)
      if (revived) { result.stillWithdrawn++; continue }

      // Not withdrawn — and the row is NOT deleted. Any external read followed
      // by a local delete is time-of-check-to-time-of-use: the customer can
      // resubmit between the two, and if that webhook is missed the fence is
      // gone for good (Codex r18). So retired rows persist, and the decision
      // that actually matters — may this order be pushed? — is taken next to
      // the push instead, by verifyWithdrawalFenceForPush.
      continue
    }

    try {
      // o3d-tj6v r4: THIS PATH IS AN IMPORT TOO, and round 3 left it outside the boundary it had
      // just built. The sweep reads the order by ID — no `?status=` query, no cursor — so nothing
      // upstream has filtered it, and an order whose withdrawal was rejected back into a status the
      // operator excluded was created here regardless of the selection. Same resolver the webhook
      // uses, so the two ingress paths that create UNHELD orders without asking WooCommerce for a
      // status cannot disagree about which orders IMS takes on.
      //
      // The tombstone is NOT resolved on this path: `admitCreate: false` withholds only the create,
      // and the row stays as the durable retry signal (it has already been rotated to the back of
      // the queue by the lastCheckedAt stamp above). Tick the status and the next sweep imports it.
      const admission = await resolveWcOrderCreateAdmission(live)
      const guarded = await importWcOrderGuarded(
        live,
        () => importWcOrder(live, { admitCreate: admission.admitted }),
      )
      if (guarded.outcome === 'skipped-withdrawal') result.stillWithdrawn++
      else if (guarded.outcome === 'unresolved') result.unresolved++
      else if (guarded.outcome === 'imported' && guarded.result.skipped === 'status_not_admitted') result.notAdmitted++
      else if (guarded.result.success && !guarded.compensationFailed) result.imported++
      else result.unresolved++
    } catch (e) {
      result.unresolved++
      console.error(`[wc-withdrawal-sweep] ${row.externalOrderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/**
 * May this order be pushed to the warehouse, as far as WooCommerce withdrawals
 * are concerned? Called by the WMS create sweep BEFORE it claims the order.
 *
 * Fails CLOSED. This is the fulfilment boundary: the IMS markers describe what
 * IMS has been told, and a withdrawal the storefront knows about but no webhook
 * delivered is exactly the case that ships goods a customer asked to withdraw.
 *
 * - no suppression row at all -> nothing to check
 * - a LIVE (unretired) row -> refuse outright
 * - a RETIRED row -> refuse unless a by-ID read within the last
 *   SUPPRESSION_SAFE_WINDOW_MS proved the storefront is not withdrawn. The read
 *   happens here, moments before the push, rather than being cached in a
 *   deleted row minutes or hours earlier.
 */
export async function verifyWithdrawalFenceForPush(salesOrderId: string): Promise<boolean> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { orderId: salesOrderId, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link) return true // not a WooCommerce order
  const externalOrderId = link.externalOrderId

  const row = await db.wcWithdrawalSuppression.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { retiredAt: true },
  })
  if (!row) return true
  if (!row.retiredAt) return false

  // No TTL shortcut. A time window is a reusable cache: once one worker stamped
  // it, any other attempt could skip the live read for the rest of it, and a
  // resubmission inside that window stayed pushable (Codex r19). Every attempt
  // takes its own read and mints its own single-use proof.
  const live = await readLiveWcOrder(externalOrderId)
  if (!live) return false // unreadable: refuse rather than guess

  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(live.status)
  if (status === submitted || status === approved) {
    // Withdrawn again, and no webhook told us. Revive the fence.
    await recordWithdrawalSuppressionIfWithdrawn(live)
    return false
  }

  await db.wcWithdrawalSuppression.updateMany({
    where: { connector: 'woocommerce', externalOrderId, retiredAt: row.retiredAt },
    data: {
      pushProofToken: randomUUID(),
      verifiedSafeUntil: new Date(Date.now() + SUPPRESSION_SAFE_WINDOW_MS),
    },
  })
  return true
}

/**
 * o3d-rbyg: how many orders one screening read may ask about.
 *
 * The response is a SUBSET of what was asked for (it is filtered to the two withdrawal statuses),
 * so with `per_page` set to the same number a chunk can never be truncated and the read needs no
 * paging of its own. Raising the chunk without raising `per_page` would silently reintroduce it.
 */
const WC_WITHDRAWAL_SCREEN_CHUNK = 100

/**
 * o3d-rbyg part 1: which of these orders does the STOREFRONT currently consider withdrawn?
 *
 * verifyWithdrawalFenceForPush answers "may this order be pushed" only for orders that already
 * have a withdrawal history — with no suppression row it returns true without asking anyone. So a
 * FIRST withdrawal whose webhook was missed leaves no row and no IMS marker, and the create sweep
 * pushes the order before the poll or the daily reconcile notices. That gap is the one this closes.
 *
 * BATCHED, not per order. A by-ID read before every create would add an API call to the hot path
 * for every order the shop ever ships. Instead the whole candidate batch is screened in ONE
 * request, filtered server-side to the two withdrawal slugs, so the answer costs a single call per
 * sweep and comes back as a positive list of the orders that are actually withdrawn.
 *
 * IT WRITES THE TOMBSTONE, which is the durable half. Skipping the push once would only defer the
 * problem to the next sweep; recording the suppression is what makes the order stay fenced —
 * including through a later WooCommerce outage, when nothing can be read at all.
 *
 * WHAT AN UNREADABLE STOREFRONT MEANS HERE, deliberately: the chunk is skipped and its orders are
 * left to the fence they already had. This is the one place in the withdrawal code that does NOT
 * fail closed, and the reason is that it is not adjudicating evidence — it is an EXTRA read for
 * orders about which nothing is known either way. Failing closed here would convert any
 * WooCommerce outage into a total halt of warehouse fulfilment for every order in the shop, which
 * is a far larger failure than the one being prevented; orders that DO have a suppression row are
 * unaffected and keep failing closed in verifyWithdrawalFenceForPush.
 */
export async function screenLiveWithdrawalsForPush(
  salesOrderIds: string[],
): Promise<ReadonlySet<string>> {
  return (await screenLiveWithdrawals(salesOrderIds)).withdrawn
}

/**
 * The same screen, reporting WHAT IT COULD NOT READ (o3d-rbyg round 2).
 *
 * `screenLiveWithdrawalsForPush` deliberately swallows an unreadable chunk, and for the push that
 * is right — see above. But a caller that is SCANNING, rather than deciding one push, needs the
 * difference: a rotating scan that treats an unread slice as a clean slice advances its cursor past
 * orders nobody looked at, and will not come back to them for a whole rotation. That caller holds
 * its cursor on `unreadableChunks > 0` instead.
 */
export async function screenLiveWithdrawals(
  salesOrderIds: string[],
): Promise<{ withdrawn: ReadonlySet<string>; unreadableChunks: number }> {
  const withdrawn = new Set<string>()
  let unreadableChunks = 0
  if (salesOrderIds.length === 0) return { withdrawn, unreadableChunks }

  const links = await db.shoppingOrderLink.findMany({
    where: { orderId: { in: salesOrderIds }, connector: 'woocommerce' },
    select: { orderId: true, externalOrderId: true },
  })
  // No WooCommerce orders in this batch — spend no API call at all. The push sweep is
  // connector-agnostic and most of its batches may have nothing to do with WooCommerce.
  if (links.length === 0) return { withdrawn, unreadableChunks }

  const salesOrderIdsByExternal = new Map<string, string[]>()
  for (const link of links) {
    const existing = salesOrderIdsByExternal.get(link.externalOrderId)
    if (existing) existing.push(link.orderId)
    else salesOrderIdsByExternal.set(link.externalOrderId, [link.orderId])
  }

  const { submitted, approved } = await getWithdrawalStatuses()
  // A Set, so a shop that has configured BOTH slugs to the same value sends one value rather than
  // a duplicate pair.
  const statusFilter = [...new Set([submitted, approved])].join(',')
  const { wcFetch } = await import('../api')
  const externalIds = [...salesOrderIdsByExternal.keys()]

  for (let offset = 0; offset < externalIds.length; offset += WC_WITHDRAWAL_SCREEN_CHUNK) {
    const chunk = externalIds.slice(offset, offset + WC_WITHDRAWAL_SCREEN_CHUNK)
    const { data, error } = await wcFetch('/orders', {
      include: chunk.join(','),
      status: statusFilter,
      per_page: String(WC_WITHDRAWAL_SCREEN_CHUNK),
    })
    if (error || !Array.isArray(data)) {
      unreadableChunks += 1
      console.error(
        `[wc-withdrawal-screen] could not screen ${chunk.length} order(s) against WooCommerce: `
        + `${error ?? 'unexpected (non-list) response'} — those orders keep the fence they already had`,
      )
      continue
    }
    for (const entry of data) {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || !('status' in entry)) continue
      const live = entry as WcFullOrder
      // Re-check the status locally rather than trusting the filter to have been applied: an
      // ignored `status` param would otherwise return the whole order list and mark every
      // candidate withdrawn, which would halt fulfilment shop-wide.
      const recorded = await recordWithdrawalSuppressionIfWithdrawn(live)
      if (!recorded) continue
      for (const orderId of salesOrderIdsByExternal.get(String(live.id)) ?? []) withdrawn.add(orderId)
    }
  }

  return { withdrawn, unreadableChunks }
}

/**
 * o3d-rbyg: the durable withdrawal evidence for a batch of orders, read LOCALLY.
 *
 * Two independent signals, either of which is enough:
 *   - the IMS markers (`withdrawalHoldAt` / `withdrawalApprovedAt`) — what IMS was told;
 *   - a STANDING WooCommerce suppression tombstone — what the storefront was observed to say,
 *     written by the push sweep's screen and by the withdrawal ingress, and retired only after the
 *     storefront has reported the request rejected across a whole quiescence window.
 *
 * The tombstone half is what makes this work when the webhook that sets the markers was the thing
 * that went missing — which is the premise of the entire fence.
 *
 * ONE definition, called by both the dispatch sweep's screen and the exception inbox (round 2). The
 * inbox has to say WHY a link is parked, and a second hand-copied version of this query is exactly
 * how the screen and the screen's own explanation drift apart.
 */
export async function screenLocalWithdrawalEvidence(
  salesOrderIds: string[],
): Promise<ReadonlySet<string>> {
  const withdrawn = new Set<string>()
  const unique = [...new Set(salesOrderIds.filter(Boolean))]
  if (unique.length === 0) return withdrawn
  const CHUNK = 200
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const marked = await db.salesOrder.findMany({
      where: {
        id: { in: chunk },
        OR: [{ withdrawalHoldAt: { not: null } }, { withdrawalApprovedAt: { not: null } }],
      },
      select: { id: true },
    })
    for (const row of marked) withdrawn.add(row.id)

    // The tombstone side. Joined through the storefront link because the suppression row is keyed
    // by the WooCommerce order id, not by ours.
    const links = await db.shoppingOrderLink.findMany({
      where: { orderId: { in: chunk }, connector: 'woocommerce' },
      select: { orderId: true, externalOrderId: true },
    })
    if (links.length === 0) continue
    const standing = await db.wcWithdrawalSuppression.findMany({
      where: {
        connector: 'woocommerce',
        externalOrderId: { in: [...new Set(links.map((link) => link.externalOrderId))] },
        retiredAt: null,
      },
      select: { externalOrderId: true },
    })
    const standingIds = new Set(standing.map((row) => row.externalOrderId))
    for (const link of links) if (standingIds.has(link.externalOrderId)) withdrawn.add(link.orderId)
  }
  return withdrawn
}

/**
 * o3d-rbyg round 2, Codex finding 1: MAKE A MISSED WITHDRAWAL LOCALLY KNOWN, BEFORE DISPATCH ACTS.
 *
 * The dispatch sweep's withdrawal screen is deliberately LOCAL — markers or a standing tombstone,
 * never a storefront call — because it runs over every active link on every tick, and a batched
 * remote screen there would let a WooCommerce outage interfere with dispatch reconciliation for the
 * whole shop. That argument is sound, and it is exactly why a withdrawal IMS has never heard of is
 * invisible to it: an order withdrawn AFTER it was pushed, with its webhook missed, carries no
 * marker, and no tombstone either, because the push screen that writes tombstones only ever looks
 * at orders it is ABOUT to push.
 *
 * So the storefront read moves OFF the dispatch tick rather than onto it. This pass rotates a
 * bounded slice of the DISPATCH-ELIGIBLE set past WooCommerce on its own schedule, and turns what
 * it finds into ordinary local evidence: the batch screen writes the durable tombstone, and the
 * ordinary withdrawal machinery then applies the hold (or the confirmed approval), so the markers
 * land, the order goes ON_HOLD, and the WMS hold pass pulls it back. Every fence that already
 * exists — the dispatch screen, the push fence, the manual shipment guard — sees it from then on
 * without any of them asking the storefront anything.
 *
 * IT CANNOT FAIL INTO THE DISPATCH PATH. It lives in the WooCommerce withdrawal cron, behind the
 * same kill switches as the rest of the connector; if WooCommerce is down this pass reports it and
 * makes no progress, and the dispatch sweep keeps reconciling on local evidence exactly as before.
 *
 * THE BOUND IS THE ROTATION, and it is not zero. With `limit` links per run and the job's interval
 * T, every dispatch-eligible link is screened at least once per ceil(eligible / limit) runs — twice
 * that in the worst case for a link created just behind the cursor. A withdrawal filed AND
 * despatched by the warehouse inside that window is still fulfilled: that residue is the price of
 * keeping WooCommerce out of the dispatch path, and it is stated here rather than left implied.
 *
 * o3d-rbyg r4 (Codex r3 finding 3) — AND THE BOUND IS NOW ACTUALLY ENFORCED.
 *
 * Round 3 claimed that bound and did not have it. The rotation advanced `id > cursor` and wrapped to
 * the front only when that query came back EMPTY — and link ids ascend, so every newly created link
 * lands ahead of the cursor. On a shop that keeps taking orders the slice ahead never empties, the
 * wrap never fires, and the links BEHIND the cursor — the long-lived ones: parked, dead-lettered,
 * stuck awaiting a despatch that never comes, which are exactly the links a withdrawal is most
 * likely to be filed against — are screened once and then never again. Not "screened late": never.
 * A bound that new arrivals keep resetting is not a bound.
 *
 * So a rotation now has an END, fixed when it STARTS. The stored state is a pair — the id the
 * rotation runs up to, and how far through it we are — and the slice is `cursor < id <= bound`.
 * Links created after the rotation began sort above `bound` and simply belong to the NEXT rotation;
 * they cannot extend this one. When the slice empties the rotation is complete: the cursor resets,
 * a fresh bound is taken from the set as it stands now, and the front of the set is screened again
 * in the same run. The worst case is therefore back to what round 3 wrote down — ceil(eligible at
 * rotation start / limit) runs — and it no longer depends on the arrival rate.
 *
 * The cursor is the link id, not a timestamp, and it is HELD when a chunk could not be read — an
 * unread slice must not be skipped for a whole rotation on the strength of an outage.
 */
export const WDRAW_DISPATCH_RECON_CURSOR_KEY = 'wc_withdrawal_dispatch_recon_cursor'
export const WDRAW_DISPATCH_RECON_LIMIT = 100

/**
 * The rotation's position AND its end, stored as one row so they cannot describe different
 * rotations. A bare string is the round-3 format (a cursor with no bound): it is read as "a rotation
 * whose end was never recorded", which starts a fresh one rather than inventing a bound for it.
 */
export type WdrawRotationState = { cursor: string; bound: string | null }

export function parseWdrawRotationState(raw: string | null | undefined): WdrawRotationState {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { cursor: '', bound: null }
  if (!trimmed.startsWith('{')) return { cursor: trimmed, bound: null }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const cursor = typeof parsed.c === 'string' ? parsed.c : ''
    const bound = typeof parsed.b === 'string' && parsed.b ? parsed.b : null
    return { cursor, bound }
  } catch {
    // Unreadable state starts a rotation rather than skipping one: re-screening is cheap, and a
    // silently skipped rotation is the defect this whole change is about.
    return { cursor: '', bound: null }
  }
}

export function serialiseWdrawRotationState(state: WdrawRotationState): string {
  return JSON.stringify({ c: state.cursor, b: state.bound ?? '' })
}

export async function sweepDispatchEligibleWithdrawals(limit = WDRAW_DISPATCH_RECON_LIMIT): Promise<{
  scanned: number
  withdrawn: number
  applied: number
  retracted: number
  unresolved: number
  wrapped: boolean
  skipped?: string
}> {
  const result = { scanned: 0, withdrawn: 0, applied: 0, retracted: 0, unresolved: 0, wrapped: false }
  // One API call per run: the screen chunks at WC_WITHDRAWAL_SCREEN_CHUNK, so a slice larger than
  // that buys nothing but a second round trip inside a job that is already rotating.
  const take = Math.min(Math.max(limit, 1), WC_WITHDRAWAL_SCREEN_CHUNK)

  // Dynamic, like the rest of this file's cross-module reads: the WMS side must not be pulled into
  // every module that imports a withdrawal helper.
  const [{ dispatchCandidateWhere }, { WMS_CONNECTOR_IDS }, { getIntegrationPluginState }] = await Promise.all([
    import('@/lib/domain/wms/dispatch-sweep'),
    import('@/lib/connectors/wms/types'),
    import('@/lib/integration-plugins'),
  ])
  const pluginState = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => pluginState[id])
  // No warehouse connector, no dispatch path to get ahead of.
  if (!connectorId) return { ...result, skipped: 'no active WMS connector' }

  // THE SWEEP'S OWN ELIGIBILITY, called rather than copied (the o3d-0gzr rule). Screening a set
  // that had drifted from the set that dispatches is the same defect as screening nothing.
  const where = dispatchCandidateWhere(connectorId)
  const select = { id: true, orderId: true } as const
  const cursorRow = await db.setting.findUnique({
    where: { key: WDRAW_DISPATCH_RECON_CURSOR_KEY },
    select: { value: true },
  })
  let { cursor, bound } = parseWdrawRotationState(cursorRow?.value)

  /** The highest eligible link id right now — the id a rotation starting here runs up to. */
  const currentBound = async (): Promise<string | null> => {
    const highest = await db.wmsOrderPushLink.findFirst({ where, orderBy: { id: 'desc' }, select: { id: true } })
    return highest?.id ?? null
  }

  // A rotation with no recorded end (a fresh installation, or the round-3 cursor format) gets one
  // fixed HERE, before any slice is read. Fixing it up front is the whole point: taken later it
  // would move with every order the shop takes, which is the defect.
  if (!bound) {
    bound = await currentBound()
    if (!bound) {
      // Nothing is dispatch-eligible at all. Clear any stale state and stop.
      if (cursorRow?.value) await saveDispatchReconCursor(serialiseWdrawRotationState({ cursor: '', bound: null }))
      return result
    }
    cursor = ''
  }

  let links = await db.wmsOrderPushLink.findMany({
    // `id <= bound` is what makes the rotation finite. Links created after it began sort ABOVE the
    // bound and belong to the next rotation; without this clause they keep the slice non-empty
    // forever and the tail behind the cursor is never screened again.
    where: { ...where, id: { gt: cursor, lte: bound } },
    orderBy: { id: 'asc' },
    take,
    select,
  })
  if (links.length === 0) {
    // The rotation is COMPLETE — not "there is nothing to do". Reset to the front, take a fresh
    // bound from the set as it stands now, and screen the front of it in this same run.
    result.wrapped = true
    cursor = ''
    bound = await currentBound()
    if (!bound) {
      if (cursorRow?.value) await saveDispatchReconCursor(serialiseWdrawRotationState({ cursor: '', bound: null }))
      return result
    }
    links = await db.wmsOrderPushLink.findMany({
      where: { ...where, id: { lte: bound } },
      orderBy: { id: 'asc' },
      take,
      select,
    })
  }
  if (links.length === 0) {
    await saveDispatchReconCursor(serialiseWdrawRotationState({ cursor: '', bound: null }))
    return result
  }
  result.scanned = links.length

  const { withdrawn, unreadableChunks } = await screenLiveWithdrawals(links.map((link) => link.orderId))
  result.withdrawn = withdrawn.size
  result.unresolved += unreadableChunks

  if (withdrawn.size > 0) {
    const { submitted, approved } = await getWithdrawalStatuses()
    const wcLinks = await db.shoppingOrderLink.findMany({
      where: { orderId: { in: [...withdrawn] }, connector: 'woocommerce' },
      select: { orderId: true, externalOrderId: true },
    })
    for (const wcLink of wcLinks) {
      // Re-read by ID rather than acting on the batch snapshot. The module's standing rule is that
      // a withdrawal decision is taken from the LIVE status, and this pass is no more entitled to
      // an exception than the tombstone resolver is.
      const live = await readLiveWcOrder(wcLink.externalOrderId)
      if (!live) {
        result.unresolved += 1
        continue
      }
      const status = normaliseStatus(live.status)
      if (status !== submitted && status !== approved) {
        // Rejected between the screen and this read. The tombstone the screen wrote STANDS — only
        // the quiescence protocol retires it — so nothing is done here and nothing is lost.
        result.retracted += 1
        continue
      }
      if (await applyWithdrawalToLinkedOrder(live)) result.applied += 1
      else result.unresolved += 1
    }
  }

  // A slice we could not read is a slice nobody has looked at: hold the cursor and screen it again
  // next run, rather than rotating past it and coming back in an hour. The BOUND is written with it
  // either way, so an outage cannot leave the position and the rotation it belongs to disagreeing.
  if (unreadableChunks === 0) {
    await saveDispatchReconCursor(serialiseWdrawRotationState({ cursor: links[links.length - 1].id, bound }))
  } else if (cursorRow?.value !== serialiseWdrawRotationState({ cursor, bound })) {
    await saveDispatchReconCursor(serialiseWdrawRotationState({ cursor, bound }))
  }
  return result
}

async function saveDispatchReconCursor(value: string): Promise<void> {
  await db.setting.upsert({
    where: { key: WDRAW_DISPATCH_RECON_CURSOR_KEY },
    create: { key: WDRAW_DISPATCH_RECON_CURSOR_KEY, value },
    update: { value },
  })
}

/**
 * o3d-rbyg parts 1+2: the live storefront withdrawal verdict for ONE order.
 *
 * `null` means the storefront could not be read — a genuinely different answer from "not
 * withdrawn", and callers must treat it as such rather than as a clean bill of health.
 *
 * An order with no WooCommerce link is reported not-withdrawn without any API call: there is no
 * storefront to ask, and no withdrawal can exist.
 *
 * Records the tombstone on a positive answer, for the same reason the batch screen does — the
 * durable fence is what survives the next outage, not this one read.
 */
export async function readLiveWithdrawalForOrder(
  salesOrderId: string,
): Promise<{ withdrawn: boolean; approved: boolean } | null> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { orderId: salesOrderId, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link) return { withdrawn: false, approved: false }

  const live = await readLiveWcOrder(link.externalOrderId)
  if (!live) return null

  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(live.status)
  if (status !== submitted && status !== approved) return { withdrawn: false, approved: false }

  await recordWithdrawalSuppressionIfWithdrawn(live)
  return { withdrawn: true, approved: status === approved }
}

/**
 * o3d-rbyg part 3: is there a STANDING withdrawal tombstone for this order?
 *
 * The durable half of the fence, read on its own. `screenLiveWithdrawalsForPush` and
 * `readLiveWithdrawalForOrder` both WRITE this row precisely so the order stays fenced when nothing
 * can be read at all — but a reader that only ever asks the storefront never benefits from it. This
 * is the read side, and it touches no API: an outage cannot make it answer differently.
 *
 * A row that is RETIRED does not stand. Retirement is not an ad-hoc judgement — it is only reached
 * after the storefront has reported the request rejected for a whole quiescence window, re-verified
 * by the by-ID sweep — so a retired row is the one case where "there was a withdrawal here once" is
 * genuinely spent. `verifyWithdrawalFenceForPush` takes its own live read past that point; this
 * reader deliberately does not, because its callers already have one.
 *
 * It reports only WHETHER a tombstone stands, never what to do about it — the rule this file states
 * at reconcileSuppressionAfterImport. The remembered `wcStatus` is a snapshot the WooCommerce inbox
 * guarantees no ordering for, so deciding "cancel" from it is exactly the mistake that was removed
 * there. A caller acting on a standing tombstone alone must therefore take the REVERSIBLE action.
 */
export async function readStandingWithdrawalTombstone(
  salesOrderId: string,
): Promise<{ standing: boolean }> {
  const link = await db.shoppingOrderLink.findFirst({
    where: { orderId: salesOrderId, connector: 'woocommerce' },
    select: { externalOrderId: true },
  })
  if (!link) return { standing: false } // not a WooCommerce order: no withdrawal can exist

  const row = await db.wcWithdrawalSuppression.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: link.externalOrderId } },
    select: { retiredAt: true },
  })
  return { standing: Boolean(row && !row.retiredAt) }
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

  await retireSuppression(externalOrderId, claim)
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
async function retireSuppression(externalOrderId: string, claim: SuppressionClaim): Promise<void> {
  const retired = await db.wcWithdrawalSuppression.updateMany({
    where: {
      connector: 'woocommerce', externalOrderId, claimToken: claim.token, revision: claim.revision,
    },
    data: { retiredAt: new Date(), claimToken: null, claimedAt: null },
  })
  if (retired.count === 0) await releaseSuppression(externalOrderId, claim.token)
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
      // Revive a retired row: a new withdrawal is live again.
      clearPendingSince: null, retiredAt: null,
      // Invalidate any proof in flight: it was taken before this request.
      pushProofToken: null, verifiedSafeUntil: null,
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

  if (result.success) await retireSuppression(externalOrderId, claim)
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
      select: { wcStatus: true, retiredAt: true },
    })
    // A RETIRED row still fences fulfilment, but it must not block the import
    // it was retired in order to allow.
    if (!suppressed || suppressed.retiredAt) return { suppress: false }
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
