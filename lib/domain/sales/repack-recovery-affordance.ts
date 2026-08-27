/**
 * WHICH REPACK CONTROL RENDERS, AND IN WHICH STATE (o3d-2k5r r4).
 *
 * The recovery this branch shipped is re-runnable: called on a shipment that is ALREADY a pending
 * draft, `reopenShipmentForRepackAction` skips the revert and runs the re-allocation and the refund
 * backstop resolution alone. That is the documented way to finish a recovery the "another committed
 * shipment exists" refusal left half-open, and the way to heal an order stranded by the earlier
 * non-transactional shape.
 *
 * IT WAS UNREACHABLE. The only control that invoked the action rendered for PICKING or PACKED
 * shipments, and after a deliberate partial commit the shipment is PENDING. So the advertised
 * resume point could be reached by no sequence of clicks that exists — the "remedy that cannot be
 * performed" shape, in the UI rather than in an error string.
 *
 * TWO CONTROLS, TWO DIFFERENT ACTS. They are separated here, as functions, rather than left as
 * conditions inside JSX, because "which control renders in which state" is the thing that was wrong
 * and it has to be assertable without a browser:
 *
 *   REOPEN            a COMMITTED shipment (PICKING/PACKED) is reverted to a draft. Physical: the
 *                     parcel has to be unpacked.
 *   FINISH RECOVERY   a PENDING draft's ORDER still has recovery work outstanding. Nothing is
 *                     reverted and nothing physical is implied; the missing steps are the demand
 *                     re-netting and the deferred refund-reservation release.
 *
 * AND THE SECOND ONE IS GATED ON DURABLE EVIDENCE, not on "the shipment happens to be PENDING".
 * Every order with a draft has a PENDING shipment; almost none of them are mid-recovery. The
 * evidence is an UNRESOLVED refund-reservation-release outbox row for one of the order's refunds —
 * the exact row step 3 of the recovery resolves, committed inside the refund's own transaction, and
 * still PENDING/RETRYABLE_FAILED precisely while the release has not happened. It is true in both
 * cases the recovery exists for:
 *
 *   - the partial commit (reopen A, refused because B was committed; B is then DISPATCHED rather
 *     than reopened, so no later reopen will ever net the order), and
 *   - an order stranded by the earlier non-transactional shape, where the reopen committed and the
 *     allocation never ran.
 *
 * And it is FALSE once the recovery has run, so the control disappears rather than inviting an
 * operator to re-run a repair that is already done.
 *
 * Ordinary "Create Shipments" is NOT this control and cannot stand in for it: it rebuilds the draft
 * from the netted quantity without ever performing the allocation-and-backstop transaction, so the
 * stale reservation release stays outstanding.
 */

/** The status a shipment holds while nothing has been committed to it. */
const UNCOMMITTED_SHIPMENT_STATUS = 'PENDING'
/** Committed but not dispatched — the states the ordinary reopen acts on. */
const REOPENABLE_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(['PICKING', 'PACKED'])

export type RepackControlInput = {
  shipmentStatus: string
  orderStatus: string
  /**
   * Does DURABLE evidence say this ORDER still owes the recovery's second and third steps? Order-
   * scoped, not shipment-scoped: the outstanding work is the order's demand netting and its refund
   * backstop, and either can be finished from any draft on the order.
   */
  recoveryOutstanding: boolean
}

/** A cancelled order takes the discard path instead: reopening would leave a draft on an order that
 *  will never be invoiced, and confirmSalesOrderShipments refuses to build for one anyway. */
function orderTakesTheDiscardPath(orderStatus: string): boolean {
  return orderStatus === 'CANCELLED'
}

export function repackReopenControlIsAvailable(input: RepackControlInput): boolean {
  if (orderTakesTheDiscardPath(input.orderStatus)) return false
  return REOPENABLE_SHIPMENT_STATUSES.has(input.shipmentStatus)
}

export function repackRecoveryControlIsAvailable(input: RepackControlInput): boolean {
  if (orderTakesTheDiscardPath(input.orderStatus)) return false
  // ONLY a draft. On a committed shipment the reopen control is the right one, and offering both
  // would put two buttons that call the same action side by side with different promises.
  if (input.shipmentStatus !== UNCOMMITTED_SHIPMENT_STATUS) return false
  return input.recoveryOutstanding
}

/**
 * The two controls are MUTUALLY EXCLUSIVE by construction — one requires a committed shipment and
 * the other requires a draft. Exported so the exclusivity is asserted rather than assumed, since
 * the failure it guards against (both, or neither) is exactly what shipped.
 */
export function repackControlsFor(input: RepackControlInput): Array<'reopen' | 'finish-recovery'> {
  const controls: Array<'reopen' | 'finish-recovery'> = []
  if (repackReopenControlIsAvailable(input)) controls.push('reopen')
  if (repackRecoveryControlIsAvailable(input)) controls.push('finish-recovery')
  return controls
}
