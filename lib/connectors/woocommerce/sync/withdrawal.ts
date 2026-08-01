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
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'
import type { WcFullOrder } from './types'

/** Settings keys, so a store that renames the plugin's statuses can follow. */
export const WDRAW_SUBMITTED_STATUS_KEY = 'wc_withdrawal_submitted_status'
export const WDRAW_APPROVED_STATUS_KEY = 'wc_withdrawal_approved_status'

/** WebToffee's defaults. WooCommerce reports statuses without the `wc-` prefix. */
export const DEFAULT_WDRAW_SUBMITTED_STATUS = 'pending-wdraw'
export const DEFAULT_WDRAW_APPROVED_STATUS = 'withdrawn'

export type WithdrawalOutcome =
  | { kind: 'not-a-withdrawal' }
  | { kind: 'submitted'; handled: true }
  | { kind: 'approved'; handled: true }
  | { kind: 'already-held'; handled: true }
  | { kind: 'rejected-held'; handled: true }

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
): WithdrawalOutcome['kind'] {
  const status = normaliseStatus(wcStatus)
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
  order: { id: string; status: string; externalOrderNumber: string | null; withdrawalHoldAt: Date | null },
): Promise<WithdrawalOutcome> {
  const statuses = await getWithdrawalStatuses()
  const kind = classifyWithdrawalStatus(wcOrder.status, statuses, Boolean(order.withdrawalHoldAt))

  if (kind === 'already-held') return { kind, handled: true }

  if (kind === 'submitted') {
    await applyWithdrawalHold(order.id, wcOrder)
    return { kind, handled: true }
  }

  if (kind === 'approved') {
    await applyWithdrawalApproval(order.id, wcOrder)
    return { kind, handled: true }
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
    return { kind, handled: true }
  }

  return { kind: 'not-a-withdrawal' }
}

async function applyWithdrawalHold(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')

  // Mark the hold BEFORE the transition. If the transition succeeds and this
  // write had not happened, the very next inbound status would look like an
  // ordinary hold and release it.
  await db.salesOrder.update({ where: { id: orderId }, data: { withdrawalHoldAt: new Date() } })

  const result = await applySalesOrderStatusTransition(orderId, 'ON_HOLD' as never, undefined, {
    pushStatusToWooCommerce: false,
    internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS,
  })

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: result.success ? 'wc_withdrawal_hold_applied' : 'wc_withdrawal_hold_failed',
    tag: 'sync',
    level: result.success ? 'INFO' : 'WARNING',
    description: result.success
      ? 'Customer filed an EU withdrawal request — order placed ON HOLD; the WMS push sweep will pull it back from the warehouse.'
      : `Customer filed an EU withdrawal request but the IMS hold could not be applied: ${result.error}. The order is NOT stopped.`,
    metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status },
    resolveUser: false,
  })
}

async function applyWithdrawalApproval(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')

  const result = await applySalesOrderStatusTransition(orderId, 'CANCELLED' as never, undefined, {
    pushStatusToWooCommerce: false,
    internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS,
  })

  // Clear the marker only on success. Clearing it regardless would drop the
  // release block while the order was still ON_HOLD and uncancelled.
  if (result.success) {
    await db.salesOrder.update({ where: { id: orderId }, data: { withdrawalHoldAt: null } })
  }

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: result.success ? 'wc_withdrawal_approved' : 'wc_withdrawal_approval_failed',
    tag: 'sync',
    level: result.success ? 'INFO' : 'WARNING',
    description: result.success
      ? 'EU withdrawal request approved — order cancelled; the WMS push sweep will cancel it at the warehouse.'
      : `EU withdrawal request approved but the IMS cancellation failed: ${result.error}. The order is NOT cancelled.`,
    metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status },
    resolveUser: false,
  })
}
