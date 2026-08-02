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
    // Record the ordinary status as HANDLED (o3d-6x66). Without this the last
    // handled status stays on the submitted slug forever, so a customer who
    // submits AGAIN compares equal, the generation never advances, and an
    // operator holding the old generation can release the newer request. The
    // hold itself is deliberately retained; only the marker moves on.
    await db.salesOrder.update({
      where: { id: order.id },
      data: { withdrawalLastWcStatus: normaliseStatus(wcOrder.status) },
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
        status: true, withdrawalHoldAt: true, withdrawalApprovedAt: true, withdrawalLastWcStatus: true,
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
  const claim = await withOrderLock(orderId, async (current, tx) => {
    // Is this a genuinely NEW customer submission, or a redelivery of the one
    // we already handled? The retained `withdrawalHoldAt` cannot tell us: a
    // rejection deliberately leaves it in place, so a customer who submits
    // again lands on an order that is ALREADY held and marked. The handled
    // status can: it only reads `submitted` once the slug has moved away and
    // back. (o3d-6x66, Codex r1)
    const isNewSubmission = current.withdrawalLastWcStatus !== incomingStatus
    if (isNewSubmission) {
      await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          withdrawalHoldGeneration: { increment: 1 },
          withdrawalLastWcStatus: incomingStatus,
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
export async function isWcOrderLinked(externalOrderId: string): Promise<boolean> {
  const link = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { id: true },
  })
  return Boolean(link)
}

export async function reconcileSuppressionAfterImport(wcOrder: WcFullOrder): Promise<void> {
  const externalOrderId = String(wcOrder.id)
  const suppressed = await db.wcWithdrawalSuppression.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { wcStatus: true },
  })
  if (!suppressed) return

  const link = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { orderId: true },
  })
  if (!link?.orderId) return

  await logActivity({
    entityType: 'SYNC', action: 'wc_withdrawal_suppression_raced_import', tag: 'sync', level: 'WARNING',
    description:
      `WooCommerce order #${wcOrder.number} was imported at the same moment a withdrawal request was `
      + `recorded for it ("${suppressed.wcStatus}"). Applying the hold to the order that was just created.`,
    metadata: { externalOrderId: wcOrder.id, suppressedStatus: suppressed.wcStatus },
    resolveUser: false,
  })
  await applyWithdrawalHold(link.orderId, wcOrder)
}

export async function shouldSkipUnlinkedWithdrawalImport(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'>,
): Promise<boolean> {
  const { submitted, approved } = await getWithdrawalStatuses()
  const status = normaliseStatus(wcOrder.status)
  const externalOrderId = String(wcOrder.id)

  const existing = await db.shoppingOrderLink.findUnique({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    select: { id: true },
  })
  if (existing) return false

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
    if (!suppressed) return false
    return resolveSuppression(wcOrder, externalOrderId, suppressed.wcStatus)
  }

  // Remember the refusal durably, so a stale ordinary payload arriving later
  // cannot import the order behind our back.
  await db.wcWithdrawalSuppression.upsert({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
    create: { connector: 'woocommerce', externalOrderId, wcStatus: status },
    update: { wcStatus: status, lastCheckedAt: new Date() },
  })

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
  return true
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
async function resolveSuppression(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'>,
  externalOrderId: string,
  suppressedStatus: string,
): Promise<boolean> {
  const { submitted, approved } = await getWithdrawalStatuses()
  let live: string | null = null
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
    if (!error && data && typeof data === 'object' && 'status' in data) {
      live = normaliseStatus((data as { status?: unknown }).status)
    }
  } catch {
    live = null
  }

  if (!live) {
    // Fail CLOSED on the import, but do NOT let the refusal be silent and
    // final: record the attempt so the recheck is visible and an operator has
    // something to act on. The caller turns this into a RETRYABLE outcome, so
    // the inbox redelivers rather than consuming the only ordinary event and
    // stranding the order unimported. (o3d-d82p, Codex r1)
    await db.wcWithdrawalSuppression.update({
      where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
      data: { lastCheckedAt: new Date() },
    }).catch(() => {})
    await logActivity({
      entityType: 'SYNC', action: 'wc_withdrawal_suppression_unresolved', tag: 'sync', level: 'WARNING',
      description:
        `WooCommerce order #${wcOrder.number} arrived with status "${wcOrder.status}" but was previously `
        + `refused as a withdrawal ("${suppressedStatus}"). The live status could not be read, so the import `
        + 'is still refused — importing could allocate stock for a withdrawn order.',
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status, suppressedStatus },
      resolveUser: true,
    })
    throw new WithdrawalSuppressionUnresolved(externalOrderId)
  }

  if (live === submitted || live === approved) return true // still withdrawn

  // The request was rejected: the storefront has genuinely moved on. Let it
  // import, and forget the refusal.
  await db.wcWithdrawalSuppression.delete({
    where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId } },
  }).catch(() => {})
  await logActivity({
    entityType: 'SYNC', action: 'wc_withdrawal_suppression_cleared', tag: 'sync', level: 'INFO',
    description:
      `WooCommerce order #${wcOrder.number} was previously refused as a withdrawal ("${suppressedStatus}"), `
      + `but its live status is now "${live}" — the request was rejected. Importing normally.`,
    metadata: { externalOrderId: wcOrder.id, liveStatus: live, suppressedStatus },
    resolveUser: false,
  })
  return false
}
