/**
 * THE ORDER-KEYED ERASURE OBLIGATION: a durable "this storefront order was anonymised by WooCommerce" for an order IMS does not hold yet.
 *
 * WHY IT EXISTS. A marked delivery for an order IMS does not hold is acknowledged or dropped on several routes (the initial-import-pending
 * acknowledgement, a status or currency refusal, a withdrawal skip). The initial import, a refusal drain or a retry may already hold an older
 * read of that order, fetched BEFORE the anonymisation, and create the identifiable order afterwards; WooCommerce does not reliably redeliver
 * and the modified_after cursor may already be past the anonymisation. So the acknowledgement leaves a row here, and the create path (under
 * the first-import lock) creates the order ALREADY ERASED when it finds an open row, retiring it in the same transaction. The update path
 * retires it after erasing a held order. Ids only: no personal data.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

const CONNECTOR = 'woocommerce'

/** Record (idempotently, re-opening a retired row) that this storefront order was anonymised and IMS does not hold it. */
export async function recordWcErasureObligation(externalOrderId: number | string): Promise<void> {
  const id = String(externalOrderId)
  await db.storefrontOrderErasureObligation.upsert({
    where: { connector_externalOrderId: { connector: CONNECTOR, externalOrderId: id } },
    create: { connector: CONNECTOR, externalOrderId: id },
    update: { retiredAt: null },
  })
}

/** Whether an open obligation exists for this storefront order. Read under the first-import lock. */
export async function hasOpenWcErasureObligation(externalOrderId: number | string, client: Prisma.TransactionClient | typeof db = db): Promise<boolean> {
  const row = await client.storefrontOrderErasureObligation.findUnique({
    where: { connector_externalOrderId: { connector: CONNECTOR, externalOrderId: String(externalOrderId) } },
    select: { retiredAt: true },
  })
  return row !== null && row.retiredAt === null
}

/** Retire the obligation (a no-op when there is none or it is already retired). */
export async function retireWcErasureObligation(externalOrderId: number | string, client: Prisma.TransactionClient | typeof db = db): Promise<void> {
  await client.storefrontOrderErasureObligation.updateMany({
    where: { connector: CONNECTOR, externalOrderId: String(externalOrderId), retiredAt: null },
    data: { retiredAt: new Date() },
  })
}
