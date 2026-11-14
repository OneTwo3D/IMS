/**
 * AN OPERATOR'S GIFT-CARD ANSWER FOR ONE ORDER LINE.
 *
 * The storefront plugin writes `_o3d_is_voucher` yes/no on every order line, but `unknown` on a custom line and on a line whose product was deleted, and IMS holds no product-level gift-card marker to settle it.
 * Once the cut-in is set such a line refuses its order for good (`gift_card_flag_missing`): re-importing re-reads the same `unknown`. This is the way out: an operator with the sync permission, freshly
 * authenticated, marks the line as a gift card or not, and the regime builder uses that answer for that line.
 *
 * WHAT AN ANSWER IS. One row per (connector, WooCommerce order id, WooCommerce line item id), carrying the answer, who gave it and when. It is keyed by the store's own ids, so it survives a re-import and needs no
 * local line. A changed answer overwrites the row (the activity log keeps every answer with its author).
 *
 * WHAT AN ANSWER IS NOT. It never overrides a readable `yes` or `no` from the plugin: it fills a gap, nothing more. An `unknown` line with no answer stays `unknown` and keeps refusing; there is no default.
 * An order whose regime is already stamped is decided for good, so no answer is taken for it (the stamp is write-once).
 */
import type { Prisma } from '@/app/generated/prisma/client'
import type { GoodsLineFact } from '@/lib/domain/accounting/eu-vat-regime'

export const GIFT_CARD_RESOLUTION_CONNECTOR = 'woocommerce'

export type GiftCardResolutionClient = Pick<Prisma.TransactionClient, 'euVatGiftCardLineResolution'>

/** The answers recorded for one order, by WooCommerce line item id. */
export async function loadGiftCardLineResolutions(client: Partial<GiftCardResolutionClient>, externalOrderId: string): Promise<Map<number, boolean>> {
  const delegate = client.euVatGiftCardLineResolution
  // A client that cannot read answers has none: the lines stay unknown and keep refusing (fail closed).
  if (!delegate) return new Map()
  const rows = await delegate.findMany({ where: { connector: GIFT_CARD_RESOLUTION_CONNECTOR, externalOrderId }, select: { externalLineItemId: true, isGiftCard: true } })
  return new Map(rows.map((row) => [row.externalLineItemId, row.isGiftCard]))
}

/** Pure: a line whose flag the plugin did not settle takes the operator's answer for it; every other line is returned as it is. */
export function applyGiftCardLineResolutions(lines: readonly GoodsLineFact[], answers: ReadonlyMap<number, boolean>): GoodsLineFact[] {
  if (answers.size === 0) return [...lines]
  return lines.map((line) => {
    if (line.lineId === undefined || (line.voucherStrict ?? 'unknown') !== 'unknown') return line
    const answer = answers.get(line.lineId)
    if (answer === undefined) return line
    const flag = answer ? 'yes' : 'no'
    return { ...line, voucher: flag, voucherStrict: flag }
  })
}
