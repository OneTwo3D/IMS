import {
  assertTransition,
  canTransition,
  type ShipmentStatus,
  type WorkflowTransitions,
} from './status-types'

/**
 * THE SHIPMENT LIFECYCLE IS FORWARD-ONLY, AND THAT IS THE PRODUCT GAP FILED AS o3d-q8r6.
 *
 * THIS MAP is forward-only. Getting a PICKING/PACKED shipment back to a draft is done by ONE
 * dedicated operation, `reopenShipmentForRepack` (lib/domain/sales/shipment-service.ts, o3d-2k5),
 * and NOT by an edge here — see decision (4) below for why. Everything this comment says about the
 * map remains true; what has changed is that the four refusal sites which used to name a gap now
 * name that operation: the deallocation refusal, the component-graph edit blockers, the
 * committed-shipment delete blocker, and the o3d-339 packed-before-refund dispatch message (which
 * used to say "unpack or cancel this shipment" and named a button that did not exist).
 *
 * o3d-q8r6 lists FOUR DECISIONS a fix has to make. THREE OF THEM THE CODE ALREADY DECIDES, and are
 * recorded here so whoever builds this does not re-derive them — one of them WRONGLY, because the
 * issue text states it backwards. The fourth is a business call and is not ours.
 *
 * (1) REVERT TO PENDING, OR DELETE? — REVERT. Decided by two facts.
 *
 *     `confirmSalesOrderShipments` only ever REPLACES PENDING shipments (it treats PACKED as
 *     committed), and `reconcilePendingShipments` already knows how to retire an unbacked draft and
 *     report the label it was carrying. So a reverse edge PACKED -> PENDING makes the entire rebuild
 *     path work with no new write protocol at all, whereas a per-shipment delete is a new one.
 *
 *     And the hardest sub-question — what happens to a JOURNALED shipment — DOES NOT ARISE. Group B
 *     stages `status: 'SHIPPED', shipmentJournalDate: null` (lib/connectors/xero/daily-sync.ts), so
 *     a PICKING or PACKED shipment can never carry a journal date. Nothing in scope has been posted.
 *     A revert also PRESERVES `trackingNumber`/`shippingService` — a purchased label with a real
 *     carrier record behind it — where a delete destroys the row that holds them.
 *
 *     SHIPPED remains terminal and is NOT part of this. A dispatch is reversed by a refund or a
 *     return, which relieve cost basis through the rows a rollback would delete.
 *
 * (2) WHAT HAPPENS TO PICK/PACK WORK ALREADY RECORDED? — NOTHING, BECAUSE NOTHING IS RECORDED.
 *     PICKING and PACKED are pure status flips. `Shipment` carries status, tracking, service,
 *     shippedAt and the accounting columns; `ShipmentLine` carries qty and a `costLayerSnapshot`
 *     that is written at DISPATCH. There is no pick record, no per-line picked quantity, no operator
 *     attribution beyond the activity log, and `ShipmentLine.stockMovements` only exist once the
 *     shipment has shipped. The un-picking is an instruction to a human, not a data operation.
 *
 * (3) DOES REVERTING RE-RESERVE STOCK? — NO, AND IT MUST NOT. The issue text says "it must, or the
 *     order becomes under-backed"; that is backwards, and building it would double-count the
 *     reservation. `reservedQty` is decremented EXCLUSIVELY on the transition to SHIPPED
 *     (`RESERVATION_RELEASING_SHIPMENT_STATUS`), and the `OrderAllocation` row is retained through
 *     pick and pack — so a PICKING/PACKED line is committed demand AND live reservation at the same
 *     time, and a live reservation is `qty − SHIPPED`. A PACKED shipment has released nothing, so
 *     there is nothing to put back.
 *
 *     What the revert DOES move is the demand netting: `allocateSalesOrder` nets NON-PENDING
 *     shipments out of demand and re-adds them to the persisted row, so the reverted quantity
 *     simply moves from the committed half of the whole-claim contract to the outstanding half. The
 *     row total is unchanged by construction, and therefore so is `reservedQty`. Any implementation
 *     that touches `reservedQty` on this edge is wrong.
 *
 * (4) WHO MAY DO IT? — ANSWERED, at `sales.process`, and answered OUTSIDE this map (o3d-2k5).
 *
 *     The two shapes were: a reverse edge here, reachable from `updateShipmentStatus` and therefore
 *     available to every `sales.process` holder (which the WAREHOUSE role has); or a new
 *     manager-gated `sales.unpack` permission, which changes the RBAC matrix for every role.
 *
 *     What settled it was not the permission at all but the WRITE PROTOCOL. Reverting a shipment is
 *     only half an operation: the order must then be re-allocated with the NARROW
 *     `refuseIfCommittedShipmentsExist` (which is only passable BECAUSE the revert removed the last
 *     committed shipment) and the deferred refund-reservation-release backstop rows resolved inside
 *     that same transaction. An edge in this map is reachable without either, so it would let a
 *     caller perform one third of a recovery and leave the order with an un-netted draft and a
 *     backstop row still deferred. `reopenShipmentForRepack` + `reopenShipmentForRepackAction` are
 *     therefore the only door, and this map stays forward-only for every generic caller.
 *
 *     The permission is `sales.process` — the one that already moves a shipment through pick, pack
 *     and DISPATCH. Reopening is strictly less consequential than the dispatch that permission
 *     already allows (a dispatch writes stock movements and COGS and is undone only by a refund or
 *     a return), so withholding the undo from the person trusted with the do is not a defensible
 *     line. If the owner wants it manager-gated after all, it is one `requirePermission` call in
 *     `reopenShipmentForRepackAction` — precisely because there is no edge here to widen it.
 */
export const SHIPMENT_TRANSITIONS = {
  PENDING: ['PICKING'],
  PICKING: ['PACKED'],
  PACKED: ['SHIPPED'],
  SHIPPED: [],
} as const satisfies WorkflowTransitions<ShipmentStatus>

export function canTransitionShipment(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  return canTransition(SHIPMENT_TRANSITIONS, from, to)
}

export function assertShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): void {
  assertTransition('shipment', SHIPMENT_TRANSITIONS, from, to)
}
