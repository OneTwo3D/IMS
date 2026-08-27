import {
  assertTransition,
  canTransition,
  type ShipmentStatus,
  type WorkflowTransitions,
} from './status-types'

/**
 * THE SHIPMENT LIFECYCLE IS FORWARD-ONLY, AND THAT IS THE PRODUCT GAP FILED AS o3d-q8r6.
 *
 * Once a shipment is PICKING or PACKED there is no way to undo it short of cancelling the WHOLE
 * order (`cancelSalesOrderFulfillmentState`, which deletes the PENDING/PICKING/PACKED shipments in
 * the same transaction as the allocation release). A mis-picked or mis-packed shipment therefore
 * cannot be corrected in place: the operator can dispatch something they know is wrong, or lose
 * everything else on the order. Four refusal sites now name this gap as the remedy they cannot
 * offer — the deallocation refusal, the component-graph edit blockers, the committed-shipment
 * delete blocker, and the o3d-339 packed-before-refund dispatch message, which already tells an
 * operator to "unpack or cancel this shipment" and names a button that does not exist.
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
 * (4) WHO MAY DO IT? — OWNER DECISION, and it cannot be inferred. `updateShipmentStatus` requires
 *     `sales.process`, which the WAREHOUSE role holds (lib/permissions.ts), so a reverse edge added
 *     to this map is available to warehouse staff for free. Whether unpacking should instead be
 *     manager-gated is a business call: there is no `sales.unpack` permission today, and adding one
 *     changes the RBAC matrix for every role. Both shapes are buildable; nothing in the code prefers
 *     one.
 *
 * Until (4) is answered this map stays forward-only. o3d-2k5 (rebuild a PACKED shipment after a
 * partial refund) is deferred under o3d-q8r6 for the same reason: all three shapes it could take
 * land on these decisions.
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
