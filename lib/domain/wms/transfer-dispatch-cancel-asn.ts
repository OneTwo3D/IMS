import type { Prisma } from '@/app/generated/prisma/client'
import { lockWmsAsnMaps } from '@/lib/domain/wms/transfer-asn-lock-order'

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
 * LOCKING. Step 3 of the global order (transfer-asn-lock-order.ts): the caller already holds the transfer row, and
 * must call this BEFORE taking the ASN line locks (step 4).
 */

export class TransferAsnBlocksDispatchCancelError extends Error {
  override readonly name = 'TransferAsnBlocksDispatchCancelError'
}

export type ClosedTransferAsn = { asnMapId: string; externalAsnId: string }

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
    select: { id: true, externalAsnId: true, status: true, remoteCreateAttemptedAt: true },
    orderBy: { id: 'asc' },
  })
  const blocking = open.filter((asn) => asn.status === 'CREATE_IN_FLIGHT'
    || asn.status === 'BOOKED_IN'
    || (asn.status === 'CREATE_PENDING' && asn.remoteCreateAttemptedAt !== null))
  if (blocking.length > 0) {
    throw new TransferAsnBlocksDispatchCancelError(
      `Cannot cancel the dispatch of ${input.transferReference}: warehouse ASN ${blocking.map((a) => `${a.externalAsnId} (${a.status})`).join(', ')} may already hold or have booked these goods. `
      + 'Reconcile the ASN first (use Recheck booked-in on the transfer once the warehouse has booked the goods in), then cancel the dispatch.',
    )
  }

  if (open.length === 0) return []
  await tx.wmsAsnMap.updateMany({
    where: { id: { in: open.map((a) => a.id) }, closedAt: null },
    data: { closedAt: input.now, sloAlertedAt: null },
  })
  return open.map((a) => ({ asnMapId: a.id, externalAsnId: a.externalAsnId }))
}

export function describeClosedTransferAsns(transferReference: string, closed: readonly ClosedTransferAsn[]): string | null {
  if (closed.length === 0) return null
  return `IMS closed warehouse ASN ${closed.map((a) => a.externalAsnId).join(', ')} for ${transferReference}. IMS cannot cancel it in the warehouse system: ask the warehouse to cancel it so they do not book these goods in.`
}
