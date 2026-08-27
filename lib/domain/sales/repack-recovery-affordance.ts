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
 *   - the partial commit (reopen A, refused because B was committed), and
 *   - an order stranded by the earlier non-transactional shape, where the reopen committed and the
 *     allocation never ran.
 *
 * And it is FALSE once the recovery has run, so the control disappears rather than inviting an
 * operator to re-run a repair that is already done.
 *
 * Ordinary "Create Shipments" is NOT this control and cannot stand in for it: it rebuilds the draft
 * from the netted quantity without ever performing the allocation-and-backstop transaction, so the
 * stale reservation release stays outstanding.
 *
 * AND EVIDENCE ALONE IS STILL NOT THE ACTION'S PREDICATE (o3d-2k5r r5). The evidence says the ORDER
 * still owes the recovery. It does not say the recovery can RUN. `reopenShipmentForRepackAction`
 * calls `allocateSalesOrder` with `refuseIfCommittedShipmentsExist`, which refuses while ANY
 * shipment on the order is not a draft — so on the very state this control was added for (A
 * reopened, B still PACKED) the action re-allocates nothing, resolves no backstop row, and returns
 * `success: true` with a warning. A button that reports success for doing nothing is worse than one
 * that errors, and the r4 test asserted that state as the control's correct behaviour.
 *
 * So the control now carries the ORDER-LEVEL prerequisite the action enforces: no committed
 * shipment anywhere on the order. Until then the prerequisite ACTION is what renders — Reopen, on
 * the sibling shipment that is blocking it — and that is a control the operator can actually press.
 *
 * DISPATCHING THE SIBLING DOES NOT CLEAR IT, and the operator message that said it would was wrong.
 * `refuseIfCommittedShipmentsExist` matches every status that is not PENDING, and SHIPPED is one of
 * them; `reopenShipmentForRepack` refuses SHIPPED outright because the goods have gone and the cost
 * has been relieved. So an order whose blocking sibling is dispatched can no longer complete this
 * recovery by any click, and the honest answer is to offer no button rather than one that reports a
 * success it did not achieve. That order needs the shipment reconciliation of o3d-339; the backstop
 * row stays visible in the integration outbox until it is done.
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
  /**
   * Does ANY shipment on this order hold a commitment — that is, sit at a status other than PENDING
   * (o3d-2k5r r5)?
   *
   * The exact shape of `allocateSalesOrder`'s `refuseIfCommittedShipmentsExist` predicate
   * (`shipment.findFirst({ orderId, status: { not: 'PENDING' } })`), and order-scoped for the same
   * reason: the refusal is about the ORDER, so a per-shipment reading of it would be a different
   * question. While this is true the recovery cannot complete, whichever draft it is invoked from.
   */
  orderHasCommittedShipment: boolean
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
  // THE ACTION'S OWN PREREQUISITE. The re-allocation this control exists to run is refused while
  // the order holds any commitment, and a refused re-allocation still reports success — so without
  // this the control renders exactly where pressing it achieves nothing and says it worked.
  if (input.orderHasCommittedShipment) return false
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
