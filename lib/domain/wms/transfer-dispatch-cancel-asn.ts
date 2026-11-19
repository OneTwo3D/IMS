import type { Prisma } from '@/app/generated/prisma/client'
import { lockWmsAsnMaps } from '@/lib/domain/wms/transfer-asn-lock-order'
import { recordRefusedAction, resolveRefusedActions, REFUSED_ACTION_ENTITY_WMS_ASN, type RefusedActionResolution } from '@/lib/domain/refused-actions'
import { WMS_INBOUND_EVENT_PROCESSING_STATUS } from '@/lib/domain/wms/inbound-event-status'

/**
 * CANCELLING A TRANSFER'S DISPATCH CLOSES ITS ASN IN IMS (o3d-hqvrp.120).
 *
 * `cancelDispatchedTransfer` restores the goods to the source and ends the transfer, and used to leave the
 * transfer's ASN open. An open ASN keeps IMS counting its expected quantity as inbound (align-down for the SKU
 * stays held for ever, the overdue-ASN watchdog fires once) and a delivery the warehouse books anyway fails against
 * a cancelled parent. So the same transaction closes the ASN in IMS (`closedAt`, nothing else: no stock, cost or
 * journal moves).
 *
 * IMS WRITES NOTHING TO MINTSOFT. Mintsoft has no cancel route and the warehouse's staff read only queries raised in
 * their own system, so the caller records the ASN ids it closed in the activity log and tells the operator to ask the
 * warehouse to cancel them. This module only touches local rows.
 *
 * WHAT IT REFUSES. An ASN whose state says the warehouse may already hold or have booked goods against it: a create
 * that may have reached the warehouse (CREATE_IN_FLIGHT, or CREATE_PENDING that was claimed before) and BOOKED_IN
 * (a receipt reconciliation is still owed). The operator settles those first.
 *
 * EVIDENCE THAT THE WAREHOUSE HAS ALREADY ACTED blocks too (o3d-zz37l): units actually received on any ASN line (received, accounted via receipt or via snapshot above 0),
 * and a receipt event for it that is still pending, retrying or REQUIRES_REVIEW. The status and the callback time alone do not: a zero-quantity recheck sets both. Closing the ASN under any of those leaves a receipt that a later booked-in
 * run throws on (the transfer is CANCELLED) and dead-letters, losing the receipt.
 *
 * THE REQUEST TO THE WAREHOUSE IS A DURABLE TASK (o3d-zz37l). For every closed ASN that reached the warehouse, the same transaction records one
 * refused-action row (WMS_ASN_CANCEL_REQUEST, entity = the ASN map) with the copy-ready text. It is idempotent per ASN, stays on Sync > Exceptions
 * until an operator confirms the warehouse was asked (or the ASN is otherwise resolved), and ages into an alert like any other. The banner is kept.
 *
 * LOCKING. Step 3 of the global order (transfer-asn-lock-order.ts): the caller already holds the transfer row, and
 * must call this BEFORE taking the ASN line locks (step 4).
 */

export class TransferAsnBlocksDispatchCancelError extends Error {
  override readonly name = 'TransferAsnBlocksDispatchCancelError'
}

/** `reachedWarehouse` is false for a placeholder (CREATE_PENDING, never sent): the warehouse has no such ASN, so there is nothing to ask it to cancel. */
export type ClosedTransferAsn = { asnMapId: string; externalAsnId: string; reachedWarehouse?: boolean }

export async function closeTransferAsnsForDispatchCancel(
  tx: Prisma.TransactionClient,
  input: { transferId: string; transferReference: string; now: Date },
): Promise<ClosedTransferAsn[]> {
  const candidates = await tx.wmsAsnMap.findMany({
    where: { sourceType: 'STOCK_TRANSFER', sourceId: input.transferId, closedAt: null },
    select: { id: true },
  })
  if (candidates.length === 0) return []
  const ids = await lockWmsAsnMaps(tx, candidates.map((c) => c.id))

  // Re-read under the lock: the decision is made on the locked rows.
  const open = await tx.wmsAsnMap.findMany({
    where: { id: { in: ids }, closedAt: null },
    select: {
      id: true, connector: true, externalAsnId: true, status: true, remoteCreateAttemptedAt: true,
      lines: { select: { lastProcessedReceivedQty: true, qtyAccountedViaReceipt: true, qtyAccountedViaSnapshot: true } },
    },
    orderBy: { id: 'asc' },
  })
  const unresolvedEvents = open.length === 0 ? [] : await tx.wmsInboundReceiptEvent.findMany({
    where: {
      externalAsnId: { in: open.map((a) => a.externalAsnId) },
      processedAt: null,
      processingStatus: {
        in: [
          WMS_INBOUND_EVENT_PROCESSING_STATUS.pending,
          WMS_INBOUND_EVENT_PROCESSING_STATUS.pendingRetry,
          WMS_INBOUND_EVENT_PROCESSING_STATUS.failedRetry,
          WMS_INBOUND_EVENT_PROCESSING_STATUS.requiresReview,
        ],
      },
    },
    select: { connector: true, externalAsnId: true },
  })
  const hasUnresolvedEvent = (asn: { connector: string; externalAsnId: string }) =>
    unresolvedEvents.some((event) => event.externalAsnId === asn.externalAsnId && event.connector === asn.connector)
  // Units actually received are the evidence. PARTIALLY_BOOKED_IN and lastCallbackAt alone are NOT: a zero-quantity recheck, a callback with
  // QuantityBooked 0 and the post-maintenance pass all set both on an ASN that holds nothing, and a transfer ASN has no close-short path.
  const hasReceivedUnits = (asn: { lines?: ReadonlyArray<{ lastProcessedReceivedQty: unknown; qtyAccountedViaReceipt: unknown; qtyAccountedViaSnapshot: unknown }> }) =>
    (asn.lines ?? []).some((line) => Number(line.lastProcessedReceivedQty) > 0 || Number(line.qtyAccountedViaReceipt) > 0 || Number(line.qtyAccountedViaSnapshot) > 0)
  const blocking = open.filter((asn) => asn.status === 'CREATE_IN_FLIGHT'
    || asn.status === 'BOOKED_IN'
    || hasReceivedUnits(asn)
    || hasUnresolvedEvent(asn)
    || (asn.status === 'CREATE_PENDING' && asn.remoteCreateAttemptedAt !== null))
  if (blocking.length > 0) {
    throw new TransferAsnBlocksDispatchCancelError(
      `Cannot cancel the dispatch of ${input.transferReference}: warehouse ASN ${blocking.map((a) => `${a.externalAsnId} (${a.status})`).join(', ')} may already hold or have booked these goods. `
      + 'Do not cancel the dispatch yet: if the warehouse has received units, complete the transfer receipt for what arrived (use Recheck booked-in on the transfer so IMS books it in); if its create is still in flight or a receipt event is waiting, wait for it to settle or resolve that event under WMS inbound events, then cancel the dispatch.',
    )
  }

  if (open.length === 0) return []
  await tx.wmsAsnMap.updateMany({
    where: { id: { in: open.map((a) => a.id) }, closedAt: null },
    data: { closedAt: input.now, sloAlertedAt: null },
  })
  const closed = open.map((a) => ({ asnMapId: a.id, externalAsnId: a.externalAsnId, reachedWarehouse: a.status !== 'CREATE_PENDING' }))
  for (const asn of closed) {
    // A placeholder that never reached the warehouse has nothing to cancel there.
    if (asn.reachedWarehouse === false) continue
    await recordRefusedAction(tx, {
      entityType: REFUSED_ACTION_ENTITY_WMS_ASN,
      entityId: asn.asnMapId,
      action: 'WMS_ASN_CANCEL_REQUEST',
      gate: 'WMS_ASN_CANCEL_NOT_CONFIRMED',
      permanence: 'PERMANENT',
      severity: 'MEDIUM',
      intent: { orderNumber: input.transferReference, externalAsnId: asn.externalAsnId, transferId: input.transferId },
      detail: asnCancelRequestText(input.transferReference, asn.externalAsnId),
      now: input.now,
    })
  }
  return closed
}

/** The copy-ready query for one closed ASN. */
export function asnCancelRequestText(transferReference: string, externalAsnId: string): string {
  return `Please cancel ASN ${externalAsnId} (IMS transfer ${transferReference}). The transfer's dispatch was cancelled in IMS and the goods are back in the source warehouse: do not book anything in against it. IMS cannot cancel an ASN in the warehouse system.`
}

export function describeClosedTransferAsns(transferReference: string, closed: readonly ClosedTransferAsn[]): string | null {
  // A placeholder ASN that never reached the warehouse is closed locally and needs no request to anyone.
  const reached = closed.filter((a) => a.reachedWarehouse !== false)
  if (reached.length === 0) return null
  return `IMS closed warehouse ASN ${reached.map((a) => a.externalAsnId).join(', ')} for ${transferReference}. IMS cannot cancel it in the warehouse system: ask the warehouse to cancel it so they do not book these goods in.`
}

/**
 * Close the cancel request of one ASN: an operator confirmed the warehouse was asked, or the ASN is otherwise resolved. Idempotent; true when an open
 * request was closed.
 */
export async function resolveAsnCancelRequest(
  client: Pick<Prisma.TransactionClient, 'refusedAction'>,
  asnMapId: string,
  resolution: RefusedActionResolution = 'OPERATOR_CONFIRMED',
  now: Date = new Date(),
): Promise<boolean> {
  const count = await resolveRefusedActions(client, { entityType: REFUSED_ACTION_ENTITY_WMS_ASN, entityId: asnMapId, action: 'WMS_ASN_CANCEL_REQUEST' }, resolution, now)
  return count > 0
}
