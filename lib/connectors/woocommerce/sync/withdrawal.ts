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
    return { kind, handled: true, result: await applyWithdrawalApproval(order.id, wcOrder) }
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
    current: { status: string; withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null },
    tx: TxClient,
  ) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    if (locked.length === 0) return null
    const current = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { status: true, withdrawalHoldAt: true, withdrawalApprovedAt: true },
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
  const claim = await withOrderLock(orderId, async (current, tx) => {
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
      await tx.salesOrder.update({ where: { id: orderId }, data: { withdrawalHoldAt: new Date() } })
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
  // Record the approval INSIDE the lock and BEFORE the cancellation, the same
  // way the hold marker is written. If the cancellation then fails or the
  // process dies, the order is left uncancelled but PROTECTED: the terminal
  // guard refuses every ordinary status, so nothing can resurrect it, and a
  // redelivered approval (which the guard deliberately lets through) retries
  // the cancellation. Writing it AFTER left a window with neither marker.
  const claim = await withOrderLock(orderId, async (current, tx) => {
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
    // Already where we want it. Clear the hold so the order is not left
    // blocked by one that no longer means anything; the approval fact was
    // recorded under the lock above.
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
