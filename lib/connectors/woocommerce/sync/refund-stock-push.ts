/**
 * Which products a just-applied WooCommerce refund asks the storefront stock to be corrected for.
 *
 * WooCommerce raises its own stock for a refunded line inside the refund request, before IMS hears of
 * it. IMS is the stock master: with refund-returns-in-transit on, the units are not yet back, so the
 * level WooCommerce now shows is wrong until they arrive. The caller force-pushes IMS's absolute level
 * for exactly these products once the refund is in IMS (see handleOrderWebhook).
 *
 * Only refund lines that carry a quantity count: a money-only refund restocks nothing on the store.
 * Read-only; the push itself is the existing stock job behind the producer seam and the outbound hold.
 */

import { db } from '@/lib/db'

export async function productIdsForAppliedWcRefunds(
  externalOrderId: number,
  externalRefundIds: readonly number[],
): Promise<string[]> {
  if (externalRefundIds.length === 0) return []
  const lines = await db.salesOrderRefundLine.findMany({
    where: {
      qty: { gt: 0 },
      productId: { not: null },
      refund: {
        externalRefundId: { in: [...externalRefundIds] },
        order: { shoppingLinks: { some: { connector: 'woocommerce', externalOrderId: String(externalOrderId) } } },
      },
    },
    select: { productId: true },
  })
  return [...new Set(lines.flatMap((line) => (line.productId ? [line.productId] : [])))]
}
