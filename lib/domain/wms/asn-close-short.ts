import type { Prisma } from '@/app/generated/prisma/client'
import { lockPurchaseOrders, lockWmsAsnMaps } from '@/lib/domain/wms/transfer-asn-lock-order'
import { WMS_INBOUND_EVENT_PROCESSING_STATUS } from '@/lib/domain/wms/inbound-event-status'

/**
 * CLOSE A SHORT-DELIVERED PURCHASE-ORDER ASN (o3d-hqvrp.117).
 *
 * THE PROBLEM. IMS closed an ASN (`closedAt`) in exactly one place: when every line's `lastProcessedReceivedQty`
 * reached `expectedQty`. A supplier that ships less than the ASN expected left the ASN PARTIALLY_BOOKED_IN with
 * `closedAt` null for ever, and every "open ASN" reader then treated the missing units as still inbound: manual
 * receipt of the remainder was refused, a new ASN could not be created (the open one was returned), and align-down
 * for the SKU was held ("Open ASN lines still expect N inbound").
 *
 * WHY A PERSON DECIDES AND NOT THE MINTSOFT STATUS. DISCREPANCY, PARTIALLYBOOKED and BOOKEDIN-PARTIAL all map to
 * PARTIALLY_BOOKED_IN (asn-status.ts), and Mintsoft keeps booking in against an ASN in those statuses: none is a
 * terminal status the warehouse commits to, and Mintsoft has no cancel route. Closing automatically on one of them
 * would drop the later booking of the rest. "This delivery is over" is a business fact only the buyer knows, so it
 * is an operator action.
 *
 * WHAT CLOSING DOES. It sets `closedAt` (status stays PARTIALLY_BOOKED_IN, which is true of the warehouse). Every
 * "open ASN" reader filters on `closedAt IS NULL`, so the remainder is released at once: the PO line's outstanding
 * quantity (`qty - landed`) is unchanged and no longer blocked, so it can be received by hand or put on a new ASN,
 * and align-down stops counting it as pending. Nothing is booked, written off or journalled: what was received stays
 * received.
 *
 * WHAT IT REFUSES. Anything that is not a PARTIALLY_BOOKED_IN purchase-order ASN that is still open; and an ASN with
 * a booked-in event that is not yet processed, because closing under it would drop quantity the warehouse has
 * already booked in. Re-check the ASN first.
 *
 * LOCKING: parent (purchase order) -> ASN header, the global order in transfer-asn-lock-order.ts.
 */

export type CloseAsnShortResult =
  | {
      kind: 'closed'
      asnMapId: string
      externalAsnId: string
      purchaseOrderId: string
      shortLines: Array<{ sku: string; sourceLineId: string; expectedQty: number; receivedQty: number; shortQty: number }>
    }
  | { kind: 'refused'; error: string }

type CloseShortClient = Prisma.TransactionClient

export async function closeAsnShort(
  tx: CloseShortClient,
  input: { connector: string; externalAsnId: string; now: Date },
): Promise<CloseAsnShortResult> {
  const found = await tx.wmsAsnMap.findUnique({
    where: { connector_externalAsnId: { connector: input.connector, externalAsnId: input.externalAsnId } },
    select: { id: true, sourceType: true, sourceId: true },
  })
  if (!found) return { kind: 'refused', error: `ASN ${input.externalAsnId} is not known to IMS.` }
  if (found.sourceType !== 'PURCHASE_ORDER') {
    return { kind: 'refused', error: 'Only a purchase-order ASN can be closed short. A transfer ASN is settled on the transfer.' }
  }

  // PARENT first, then the ASN header.
  await lockPurchaseOrders(tx, [found.sourceId])
  await lockWmsAsnMaps(tx, [found.id])

  const asn = await tx.wmsAsnMap.findUnique({
    where: { id: found.id },
    select: {
      id: true,
      status: true,
      closedAt: true,
      lines: {
        select: { sku: true, sourceLineId: true, expectedQty: true, lastProcessedReceivedQty: true },
      },
    },
  })
  if (!asn) return { kind: 'refused', error: `ASN ${input.externalAsnId} is not known to IMS.` }
  if (asn.closedAt !== null) return { kind: 'refused', error: `ASN ${input.externalAsnId} is already closed.` }
  if (asn.status !== 'PARTIALLY_BOOKED_IN') {
    return {
      kind: 'refused',
      error: `ASN ${input.externalAsnId} is ${asn.status}. Only a partially booked-in ASN can be closed short.`,
    }
  }

  const unprocessed = await tx.wmsInboundReceiptEvent.count({
    where: {
      connector: input.connector,
      externalAsnId: input.externalAsnId,
      processingStatus: { not: WMS_INBOUND_EVENT_PROCESSING_STATUS.processed },
    },
  })
  if (unprocessed > 0) {
    return {
      kind: 'refused',
      error: `ASN ${input.externalAsnId} has ${unprocessed} booked-in event(s) not yet processed. Re-check the ASN and resolve them before closing it short.`,
    }
  }

  const shortLines = asn.lines
    .map((line) => {
      const expectedQty = Number(line.expectedQty)
      const receivedQty = Number(line.lastProcessedReceivedQty)
      return { sku: line.sku, sourceLineId: line.sourceLineId, expectedQty, receivedQty, shortQty: Math.max(0, expectedQty - receivedQty) }
    })
    .filter((line) => line.shortQty > 0)

  // Compare-and-set on the header: closed only if it is still the open, partially booked-in row read above.
  const updated = await tx.wmsAsnMap.updateMany({
    where: { id: asn.id, closedAt: null, status: 'PARTIALLY_BOOKED_IN' },
    data: { closedAt: input.now, sloAlertedAt: null },
  })
  if (updated.count !== 1) return { kind: 'refused', error: `ASN ${input.externalAsnId} changed while it was being closed. Try again.` }

  return {
    kind: 'closed',
    asnMapId: asn.id,
    externalAsnId: input.externalAsnId,
    purchaseOrderId: found.sourceId,
    shortLines,
  }
}
