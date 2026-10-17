import type { Prisma } from '@/app/generated/prisma/client'

/**
 * ONE PREDICATE FOR "MAY THE PUSH SWEEP CREATE A WAREHOUSE ORDER FOR THIS SALES ORDER?"
 *
 * THE DEFECT CLASS: a predicate with several readers, hand-copied. `createCandidates` is the only
 * query that actually selects orders for the create pass, and four other places have needed to
 * agree with it — the revalidation promote, the ambiguous-create promote, the HELD release, and
 * the exception inbox's missing-order re-push. Each was written by hand from the one before, and
 * the last one written copied only three of the six fences: it checked status, `paidAt` and
 * `refundStatus` and forgot the warehouse binding and both withdrawal fences.
 *
 * WHAT THAT COST. `repushMissingWmsOrder` probed the warehouse successfully, reset the link to
 * PENDING_CREATE, RESOLVED the discrepancy and returned success — for an order whose binding had
 * since been disabled, or which had moved to an unbound warehouse. `createCandidates` then never
 * selected it, so nothing re-created it and nothing ever said so again: MISSING_IN_WMS only scans
 * settled links and NOT_PUSHED only scans actively bound warehouses, so the order was invisible to
 * both. The operator was told it worked.
 *
 * So the fences live here, once, as a Prisma where-clause fragment that every reader spreads. A
 * new fence is added in one place and is enforced by every reader by construction — which is the
 * only version of this that a review cannot be wrong about.
 *
 * WHY A WHERE-CLAUSE RATHER THAN A FUNCTION OVER A LOADED ORDER. Because the readers are queries.
 * `createCandidates` selects thousands of rows by it; the inbox evaluates it for a page of drift
 * findings; the re-push action evaluates it for one order INSIDE its reset transaction, under the
 * row lock, so the decision the page rendered is re-proved at the instant of the write. Sharing
 * the SQL is what makes those the same decision instead of three that agree today.
 */

/** The lifecycle statuses the create pass will push from. */
export const WMS_CREATE_READY_STATUSES = ['PROCESSING', 'ALLOCATED'] as const

/**
 * Every ORDER-side fence, warehouse binding aside.
 *
 * Split out because the HELD release pass reads a link that already names its warehouse and has no
 * bound-warehouse list in hand, while the create/promote queries filter on one. Both must carry
 * everything else.
 *
 * - status/paidAt/refundStatus — a ready, paid, not-fully-refunded order is what fulfilment means.
 * - withdrawalHoldAt (o3d-e1yb) — the customer has asked to withdraw. Written BEFORE the ON_HOLD
 *   transition, so it also covers the window where the marker landed and the transition failed.
 * - withdrawalApprovedAt — a DIRECT approval records only the approval fact until its cancellation
 *   finishes, so the hold alone would let the order be pushed in between.
 */
export const WMS_CREATE_ELIGIBLE_ORDER_FENCES = {
  status: { in: [...WMS_CREATE_READY_STATUSES] },
  paidAt: { not: null },
  refundStatus: { not: 'FULL' },
  withdrawalHoldAt: null,
  withdrawalApprovedAt: null,
} satisfies Prisma.SalesOrderWhereInput

/**
 * The complete create predicate: the fences above AND an ACTIVELY BOUND ship-from warehouse.
 *
 * The binding is not decoration. `createCandidates` filters `shipFromWarehouseId in
 * boundWarehouseIds`, where the ids come from `activeBindings` — bindings that are themselves
 * active on an active connection. An order whose binding was disabled, or which moved to a
 * warehouse this connector has none for, is not a create candidate and never will be until
 * somebody rebinds it.
 */
export function wmsCreateEligibleOrderWhere(boundWarehouseIds: readonly string[], paidNotBefore?: Date | null): Prisma.SalesOrderWhereInput {
  return {
    ...WMS_CREATE_ELIGIBLE_ORDER_FENCES,
    // The producer-side floor (see wmsCreateObligationFloor): once the destination is live an order paid before the live-from instant
    // belongs to the writer that owned it then and IMS can never create it. No floor: the legacy predicate, exactly.
    ...(paidNotBefore ? { paidAt: { not: null, gte: paidNotBefore } } : {}),
    shipFromWarehouseId: { in: [...boundWarehouseIds] },
  }
}

/** The same floor as {@link wmsCreateEligibleOrderWhere}, as a decision on one loaded order: true when IMS may NOT create (or re-queue) it. */
export function wmsPaidBeforeCreateFloor(paidAt: Date | null | undefined, paidNotBefore: Date | null | undefined): boolean {
  if (!paidNotBefore) return false
  return !paidAt || paidAt.getTime() < paidNotBefore.getTime()
}

/**
 * Why an order is not create-eligible, for the operator who pressed a button that refused.
 *
 * Deliberately does NOT try to name which fence failed. The decision is made by the database, in
 * one query, at the instant of the write; re-deriving the reason in TypeScript would be a second
 * reader of exactly the kind this module exists to remove, and it would be the one that lies.
 */
export function wmsCreateIneligibleRefusal(reference: string): string {
  return (
    `The WMS push sweep will not select order ${reference} for a create, so re-queueing it would resolve the `
    + 'finding while nothing ever re-created the order. It has to be paid and ready (Processing/Allocated), not '
    + 'fully refunded, free of a customer withdrawal request, and shipping from a warehouse with an ACTIVE '
    + 'binding to the live WMS connector. Fix whichever of those is not true — most often a disabled warehouse '
    + 'binding or a ship-from warehouse the connector has none for — and the control becomes available. The '
    + 'finding stays open meanwhile.'
  )
}

/**
 * The disposition shown for an order IMS can never create because it was paid before the destination's live-from instant (the bridge
 * owns it). It is a display state only: no push link is written for it. See wmsCreateObligationFloor.
 */
export const WMS_PRE_CUTOVER_PUSH_STATE = 'PRE_CUTOVER'
export const WMS_PRE_CUTOVER_NOTICE = 'Paid before the live-from instant: this order belongs to the bridge and IMS will not create it in the warehouse.'

/**
 * Whether a push link should be DISPLAYED as pre-cutover rather than queued: the create query now excludes the order, so "Queued" would
 * be a promise nothing keeps. Only a never-attempted queue entry (no attempts, no warehouse id): anything else carries history the
 * operator needs to see as it is. No floor (switch off, or not live): never.
 */
export function wmsPushIsPreCutover(
  link: { state: string; attempts: number; externalOrderId: string | null },
  order: { paidAt: Date | null | undefined },
  paidNotBefore: Date | null | undefined,
): boolean {
  return link.state === 'PENDING_CREATE' && link.attempts === 0 && link.externalOrderId === null && wmsPaidBeforeCreateFloor(order.paidAt, paidNotBefore)
}
