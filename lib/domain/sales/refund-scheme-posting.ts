/**
 * THE POSTING TYPE A REFUND LINE ON AN EU IOSS / VOEC / DDP SCHEME ORDER POSTS ON, resolved once when the refund is created and snapshotted on the refund line (`SalesOrderRefundLine.postingTaxType`)
 * beside the tax identity (`accountingTaxType`) the refund already snapshots. `accountingTaxType` is the charged rate's own code and is NOT what a scheme credit note sends (Xero would add VAT on it); the credit note sends this.
 *
 * Read from the ORDER's write-once regime stamp (lib/domain/accounting/eu-vat-regime-stamp.ts), never re-derived: a SCHEME stamp's basis records the zero-rated posting type the invoice was posted on (`scheme.schemePostingTaxType`), and that is what is snapshotted. An order with no stamp, or one stamped "decided, not on the scheme", has nothing to snapshot.
 * A scheme order whose stamp records none (written before it was kept) snapshots NULL, and the credit note is then a refused row posted by hand rather than guessed.
 */
import type { Prisma } from '@/app/generated/prisma/client'

export type SchemePostingSnapshot =
  /** Not a scheme order (unstamped, or stamped outside the scheme): nothing is snapshotted. */
  | { scheme: false }
  /** A scheme order. `postingTaxType` is NULL when it cannot be established. */
  | { scheme: true; regime: string; postingTaxType: string | null }

export async function resolveSchemePostingSnapshot(
  client: Pick<Prisma.TransactionClient, 'salesOrder'>,
  orderId: string,
): Promise<SchemePostingSnapshot> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: { euVatRegime: true, euVatRegimeStampedAt: true, euVatRegimeBasis: true },
  })
  if (!order || order.euVatRegimeStampedAt === null || order.euVatRegime === null) return { scheme: false }
  // The type the INVOICE was posted on, as recorded with the write-once stamp: never the rate's current mapping, which can have moved to another 0% type since. A stamp written before the type was kept has none: NULL, and the credit note is then posted by hand.
  const basis = order.euVatRegimeBasis as { scheme?: { schemePostingTaxType?: unknown } } | null
  const recorded = typeof basis?.scheme?.schemePostingTaxType === 'string' ? basis.scheme.schemePostingTaxType.trim() : ''
  return { scheme: true, regime: order.euVatRegime, postingTaxType: recorded === '' ? null : recorded }
}
