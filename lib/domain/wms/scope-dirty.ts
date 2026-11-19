import type { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'

/**
 * MARK A WAREHOUSE ORDER'S SCOPE DIRTY, in the transaction that changed what it is made of.
 *
 * The part of an order a warehouse is sent (lib/domain/wms/mixed-scope.ts) is a function of the order's allocations and shipments. Every writer of an order
 * allocation or shipment line - and of a shipment's existence or status - calls this in the SAME transaction, so the WMS order push link is flagged
 * (`scopeDirtyAt`) the instant the inputs change and the amend pass re-derives the part from the committed state. A census test
 * (tests/wms-scope-dirty-census.test.ts) fails when a writer exists that does not call it, so a new writer cannot silently leave the warehouse holding a
 * stale part.
 *
 * An order with no push link has nothing to flag (the create pass reads the allocations itself). The write touches only that one row, under the order lock
 * the callers already hold; it never reads or writes the order, so it cannot change any other behaviour. It is cheap and unconditional: the flag
 * `wms_mixed_warehouse_push_enabled` decides whether anything READS the mark.
 */
export async function markWmsScopeDirtyInTx(tx: Prisma.TransactionClient | typeof db, orderId: string): Promise<void> {
  await tx.wmsOrderPushLink.updateMany({ where: { orderId }, data: { scopeDirtyAt: new Date() } })
}
