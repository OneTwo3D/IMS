/**
 * THE POSTING TYPE A REFUND LINE ON AN EU IOSS / VOEC / DDP SCHEME ORDER POSTS ON, resolved once when the refund is created and snapshotted on the refund line (`SalesOrderRefundLine.postingTaxType`)
 * beside the tax identity (`accountingTaxType`) the refund already snapshots. `accountingTaxType` is the charged rate's own code and is NOT what a scheme credit note sends (Xero would add VAT on it); the credit note sends this.
 *
 * Read from the ORDER's write-once regime stamp (lib/domain/accounting/eu-vat-regime-stamp.ts), never re-derived: a SCHEME stamp's basis names the IMS rates the regime was decided on, and the posting type is
 * the one `schemePostingTaxType` those rates carry (the resolver already refused an order whose rates carry more than one). An order with no stamp, or one stamped "decided, not on the scheme", has nothing to snapshot.
 * A scheme order whose basis names no usable posting type snapshots NULL, and the credit note then refuses by name rather than guessing.
 */
import type { Prisma } from '@/app/generated/prisma/client'

export type SchemePostingSnapshot =
  /** Not a scheme order (unstamped, or stamped outside the scheme): nothing is snapshotted. */
  | { scheme: false }
  /** A scheme order. `postingTaxType` is NULL when it cannot be established. */
  | { scheme: true; regime: string; postingTaxType: string | null }

export async function resolveSchemePostingSnapshot(
  client: Pick<Prisma.TransactionClient, 'salesOrder' | 'taxRate'>,
  orderId: string,
): Promise<SchemePostingSnapshot> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: { euVatRegime: true, euVatRegimeStampedAt: true, euVatRegimeBasis: true },
  })
  if (!order || order.euVatRegimeStampedAt === null || order.euVatRegime === null) return { scheme: false }
  const basis = order.euVatRegimeBasis as { scheme?: { imsRateIds?: unknown } } | null
  const ids = Array.isArray(basis?.scheme?.imsRateIds) ? (basis!.scheme!.imsRateIds as unknown[]).filter((id): id is string => typeof id === 'string') : []
  if (ids.length === 0) return { scheme: true, regime: order.euVatRegime, postingTaxType: null }
  const rates = await client.taxRate.findMany({ where: { id: { in: ids } }, select: { schemePostingTaxType: true } })
  const types = new Set(rates.map((rate) => (rate.schemePostingTaxType ?? '').trim()))
  const only = types.size === 1 ? [...types][0]! : ''
  return { scheme: true, regime: order.euVatRegime, postingTaxType: only === '' ? null : only }
}
