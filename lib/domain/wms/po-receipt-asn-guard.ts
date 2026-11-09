/**
 * A MANUAL PURCHASE-ORDER RECEIPT IS REFUSED FOR A LINE THAT STILL HAS A LIVE WAREHOUSE ASN.
 *
 * THE AMBIGUITY. Once a PO line has an open ASN, a manual receipt of N units for that line cannot be told apart from
 * "the same N units the warehouse will later book": the book-in reconciliation treats a manual receipt made after the
 * ASN was sized as part of the manual-receipt pool, so it adds no stock for those units. If the operator in fact
 * received DIFFERENT units of the same SKU into the same warehouse, the stock for them is silently never added. A cap
 * rule was considered and rejected (it turns the first case into overstated stock). The ruling is to refuse: the
 * operator books the goods in through the ASN.
 *
 * WHAT COUNTS AS LIVE, per PO line (the line has a WmsAsnLineMap row whose ASN header has closedAt NULL and is):
 *   - CREATE_IN_FLIGHT, OPEN or PARTIALLY_BOOKED_IN; or
 *   - BOOKED_IN while closedAt is still null: the creator maps an ASN the warehouse had ALREADY received straight to BOOKED_IN and
 *     leaves it open while the local receipt reconciliation is still owed; a manual receipt now would be the double entry; or
 *   - CREATE_PENDING that has been CLAIMED before (remoteCreateAttemptedAt set): the creator demotes a stale CREATE_IN_FLIGHT row
 *     back to CREATE_PENDING when its push may have been accepted but not verified, so the warehouse may already hold the ASN. It
 *     stays blocking until the creator reconciles it (finalizes it to OPEN, adopts the remote ASN, or retires it with closedAt).
 *
 * CREATE_IN_FLIGHT counts because the remote ASN may already exist: the finalizer adopts it when the create returns.
 *
 * A NEVER-CLAIMED CREATE_PENDING DELIBERATELY DOES NOT. It is an unclaimed local reservation: no request has been made, no remote
 * ASN exists, and nothing the warehouse could book is waiting on it. The creators already treat it as "not open" (a PO with only
 * a pending reservation may create an ASN). Counting it would let a reservation that is stuck, or that the creator abandoned before
 * sending, refuse manual receipts for as long as the row lives. A reservation that is claimed afterwards is sized against the units
 * already received by hand (manualQtyBaseline), which is the existing, correct path.
 *
 * A closed ASN (closedAt set: fully booked in, retired or discarded) never counts: the goods are booked or the reservation is gone.
 *
 * LOCKING. Callers read this UNDER the purchase_orders row lock (the transaction in receivePurchaseOrder). The global
 * lock order is PARENT -> ASN header -> ASN lines (lib/domain/wms/transfer-asn-lock-order.ts), the booked-in service
 * and both ASN creators take the PO first, so holding the PO row makes this read race-free against them with no ASN
 * lock of its own - and taking one here would invert the order. A pre-transaction read exists only for a friendlier
 * early message; the in-transaction one is authoritative.
 */

import type { Prisma } from '@/app/generated/prisma/client'

export const MANUAL_RECEIPT_BLOCKING_ASN_STATUSES = ['CREATE_IN_FLIGHT', 'OPEN', 'PARTIALLY_BOOKED_IN', 'BOOKED_IN'] as const

export type LiveAsnBlock = {
  poLineId: string
  sku: string
  externalAsnId: string
  status: string
}

export class ManualReceiptRefusedByLiveAsnError extends Error {
  override readonly name = 'ManualReceiptRefusedByLiveAsnError'
  constructor(message: string, readonly blocks: LiveAsnBlock[]) {
    super(message)
  }
}

type AsnLineReader = Pick<Prisma.TransactionClient, 'wmsAsnLineMap'>

export async function findLiveAsnBlocks(client: AsnLineReader, poLineIds: readonly string[]): Promise<LiveAsnBlock[]> {
  const ids = [...new Set(poLineIds)]
  if (ids.length === 0) return []
  const rows = await client.wmsAsnLineMap.findMany({
    where: {
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: { in: ids },
      asn: {
        closedAt: null,
        OR: [
          { status: { in: [...MANUAL_RECEIPT_BLOCKING_ASN_STATUSES] } },
          { status: 'CREATE_PENDING', remoteCreateAttemptedAt: { not: null } },
        ],
      },
    },
    select: { sourceLineId: true, sku: true, asn: { select: { externalAsnId: true, status: true } } },
    orderBy: [{ sourceLineId: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map((row) => ({
    poLineId: row.sourceLineId,
    sku: row.sku,
    externalAsnId: row.asn.externalAsnId,
    status: row.asn.status,
  }))
}

export function liveAsnRefusalMessage(poReference: string, blocks: readonly LiveAsnBlock[]): string {
  const bySku = new Map<string, LiveAsnBlock[]>()
  for (const block of blocks) bySku.set(block.sku, [...(bySku.get(block.sku) ?? []), block])
  const parts = [...bySku.entries()].map(([sku, list]) => (
    `${sku} (ASN ${list.map((b) => `${b.externalAsnId}, ${b.status}`).join('; ')})`
  ))
  return `Cannot receive by hand on ${poReference}: ${parts.join(', ')} ${parts.length === 1 ? 'has' : 'have'} an open warehouse ASN. `
    + 'Book these goods in through the ASN (use Recheck booked-in once the warehouse has booked them) so the stock is added once. '
    + 'Lines without an open ASN can still be received here.'
}

export async function assertNoLiveAsnForReceipt(
  client: AsnLineReader,
  poReference: string,
  poLineIds: readonly string[],
): Promise<void> {
  const blocks = await findLiveAsnBlocks(client, poLineIds)
  if (blocks.length > 0) throw new ManualReceiptRefusedByLiveAsnError(liveAsnRefusalMessage(poReference, blocks), blocks)
}
