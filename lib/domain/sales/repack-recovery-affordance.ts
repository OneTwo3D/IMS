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
 *
 * AND HIDING *THAT* CONTROL WAS THE GUARD IN THE WRONG PLACE (o3d-2k5r r6, o3d-flxt).
 *
 * Withholding "Finish repack recovery" from a PENDING draft whose sibling is SHIPPED describes the
 * dead end AFTER the order is already in it. It is not how the order GETS there. The entry is one
 * step earlier and it is the OTHER button: with A=PACKED and B=SHIPPED, the reopen predicate looked
 * only at A's own status, so A rendered "Reopen for repack"; pressing it reverts A, the
 * re-allocation is refused because B is not PENDING, and that refusal DELIBERATELY COMMITS the
 * revert. One click later A is a draft that no control can finish and B is a dispatch that cannot
 * be reopened — a state the operator could not have been in before they pressed a button IMS
 * offered them.
 *
 * So the reopen carries the ORDER-LEVEL question too, and it is a DIFFERENT question from the
 * finish control's: not "does the order hold a commitment" (two packed shipments do, and that case
 * is recoverable — reopen the other one) but "does the order hold a commitment that can never be
 * reopened". While that is true, reverting anything is a one-way trip into the dead end, so no
 * reopen is offered on that order at all.
 *
 * THE PARTIAL COMMIT SURVIVES ONLY FOR REOPENABLE BLOCKERS. The refusal keeps the reopen because
 * with A and B both PACKED, rolling back would refuse A because of B and B because of A and neither
 * could ever go first — a real deadlock that only a partial commit breaks. That argument requires
 * the blocker to be reopenable. A SHIPPED blocker is not a deadlock, it is a wall: keeping the
 * revert buys no future step and costs the order its last recoverable state. The action therefore
 * re-checks this under the order lock and ABORTS instead (app/actions/allocation.ts), so the UI
 * predicate below and the write path refuse the same thing.
 */

/** The status a shipment holds while nothing has been committed to it. */
const UNCOMMITTED_SHIPMENT_STATUS = 'PENDING'
/** Committed but not dispatched — the states the ordinary reopen acts on. */
const REOPENABLE_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(['PICKING', 'PACKED'])

/**
 * Is this shipment a commitment that can NEVER be turned back into a draft (o3d-2k5r r6)?
 *
 * Today that is exactly SHIPPED — `reopenShipmentForRepack` refuses it because the goods have gone
 * and the cost has been relieved. It is written as "committed and not reopenable" rather than
 * `=== 'SHIPPED'` so that any status added to `ShipmentStatus` later is treated as a wall until
 * someone decides otherwise: the failure mode of guessing wrong in the other direction is an
 * operator being handed a button that strands their order.
 */
export function shipmentIsUnreopenableCommitment(status: string): boolean {
  return status !== UNCOMMITTED_SHIPMENT_STATUS && !REOPENABLE_SHIPMENT_STATUSES.has(status)
}

/**
 * The two ORDER-LEVEL facts both controls need, derived from one pass over the order's shipment
 * statuses. Exported so the page (`getOrderShipments`), the write path (`reopenShipmentForRepack`
 * and `reopenShipmentForRepackAction`) and the tests all ask the question the same way — the
 * defect this fixes was two surfaces answering the same question differently.
 */
export function summariseRepackBlockers(statuses: Iterable<string>): {
  orderHasCommittedShipment: boolean
  orderHasUnreopenableCommitment: boolean
} {
  let orderHasCommittedShipment = false
  let orderHasUnreopenableCommitment = false
  for (const status of statuses) {
    if (status !== UNCOMMITTED_SHIPMENT_STATUS) orderHasCommittedShipment = true
    if (shipmentIsUnreopenableCommitment(status)) orderHasUnreopenableCommitment = true
  }
  return { orderHasCommittedShipment, orderHasUnreopenableCommitment }
}

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
  /**
   * Does ANY shipment on this order hold a commitment that can never be reopened — in practice, a
   * DISPATCHED sibling (o3d-2k5r r6, o3d-flxt)?
   *
   * Order-scoped, and deliberately not "sibling-scoped": a SHIPPED shipment fails the reopenable
   * test on its own status anyway, so excluding self would only add a way for the two readings to
   * disagree. While this is true the order's recovery cannot be completed by any click, and — the
   * part that was missing — reverting one more shipment cannot help either, it can only convert a
   * still-committed shipment into a draft nothing will ever finish.
   */
  orderHasUnreopenableCommitment: boolean
}

/** A cancelled order takes the discard path instead: reopening would leave a draft on an order that
 *  will never be invoiced, and confirmSalesOrderShipments refuses to build for one anyway. */
function orderTakesTheDiscardPath(orderStatus: string): boolean {
  return orderStatus === 'CANCELLED'
}

export function repackReopenControlIsAvailable(input: RepackControlInput): boolean {
  if (orderTakesTheDiscardPath(input.orderStatus)) return false
  // THE GUARD BEFORE THE ACTION IT GUARDS (o3d-2k5r r6). Reverting this shipment while the order
  // holds a commitment nobody can ever reopen does not advance the recovery by one step — the
  // re-allocation is refused for the same reason it will be refused every time afterwards — and it
  // consumes the last state from which the order could still be dispatched as packed. Withholding
  // the FINISH control in that state describes the dead end; withholding this one is what keeps the
  // order out of it.
  if (input.orderHasUnreopenableCommitment) return false
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

/**
 * MAY THIS DISPATCH GO, GIVEN WHAT THE ORDER STILL OWES (o3d-2k5r r7, Codex)?
 *
 * The r6 round put the guard BEFORE the reopen and re-checked it under the order lock, so the
 * partial commit survives only while every blocker is reopenable. That is true at the instant the
 * recovery transaction commits — and only then. Nothing held the fact afterwards: with A reopened
 * to a draft and B still PACKED, the ordinary dispatch screen or a WMS status update could take the
 * order lock one millisecond later and dispatch B. The order is then A=PENDING / B=SHIPPED, which
 * is EXACTLY the state the narrowing exists to prevent — reached after the check instead of before
 * it. `reopenShipmentForRepackAction` re-run on A now aborts (B is unreopenable), the refund is
 * never netted into `OrderAllocation`, the reservation is never released, and the backstop row can
 * never resolve. The same wall is reachable with no reopen at all: pack A and B, take a refund,
 * dispatch B.
 *
 * A warning telling an operator not to dispatch is not an invariant, and a WMS despatch feed does
 * not read warnings. So the rule is enforced where the irreversible act happens, under the same
 * order lock — see `validateDispatchPreservesRepackRecovery` in shipment-service.
 *
 * TWO CONDITIONS, AND THE SECOND ONE IS WHAT KEEPS THIS NARROW.
 *
 *  - `recoveryOutstanding` — the same DURABLE evidence the "Finish repack recovery" control is
 *    gated on: an UNRESOLVED refund-reservation-release outbox row for one of this order's refunds.
 *    While it is false the order owes no recovery and a dispatch forecloses nothing, which is every
 *    ordinary dispatch in the system.
 *  - `orderHasUnreopenableCommitment` — if the order ALREADY holds a dispatched shipment, the
 *    recovery is already foreclosed. Refusing here would buy nothing and would strand goods that
 *    can still legitimately go out, on an order that now needs the o3d-339 reconciliation either
 *    way. A guard that outlives the thing it protects is just a wedge.
 *
 * So this refuses only the FIRST dispatch that would turn a recoverable order into an unrecoverable
 * one, and the remedy is always reachable from that state: no shipment is dispatched yet, so every
 * committed one can be reopened, the recovery run, and the shipment rebuilt and dispatched.
 */
export function dispatchForeclosesRepackRecovery(input: {
  recoveryOutstanding: boolean
  orderHasUnreopenableCommitment: boolean
}): boolean {
  if (!input.recoveryOutstanding) return false
  if (input.orderHasUnreopenableCommitment) return false
  return true
}
