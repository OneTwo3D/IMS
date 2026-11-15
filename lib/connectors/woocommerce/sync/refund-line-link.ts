/**
 * The ORDER line item a WooCommerce refund line refers to.
 *
 * WooCommerce records it as the `_refunded_item_id` meta on the refund line; the line's own `id` is a
 * fresh order-item id and matches nothing on our side. Falls back to `rl.id` so a store (or a stub)
 * that does not emit the meta still behaves as before rather than losing the link entirely.
 *
 * o3d-w00 (Codex r7 #3): its own module because TWO paths resolve the link now — the automatic sync,
 * and the exception inbox's hand-recording path, which reads the refunded QUANTITIES out of the parked
 * payload so a quarantine no longer loses them. Keeping it in refund-sync would make the inbox depend
 * on the whole sync (its WooCommerce client, its db reads), which in turn is what forces a test double
 * to stand in for this pure function and get it subtly wrong.
 */
import type { WcRefundLineItem } from './types'

export function refundedOrderLineId(rl: WcRefundLineItem): number {
  const meta = (rl.meta_data ?? []).find((m) => m.key === '_refunded_item_id')
  const id = Number(meta?.value)
  return Number.isFinite(id) && id > 0 ? id : rl.id
}

/** The part of a refunded WooCommerce fee line the match reads. */
export type WcRefundFeeLineLike = { name?: string | null; total?: string | number | null; total_tax?: string | number | null }

/** The part of an IMS order line the fee match reads. */
export type FeeMatchOrderLine = { id: string; productId: string | null; externalLineItemId: number | null; description: string; totalForeign?: unknown }

/**
 * The ORIGINAL ORDER FEE LINE each refunded WooCommerce fee line refers to (o3d-k26m.14).
 *
 * The importer stores a fee line with no WooCommerce item id (`mapWcFeeLines` sets `externalLineItemId: null`) and no product, so unlike a goods line it cannot be linked through `_refunded_item_id`. The link is the fee's NAME on a fee-shaped order line
 * (no product, no item id), and ONLY when exactly ONE fee-shaped line on the order has that name. Several same-named fees are never told apart, not even by amount (a partial refund of a larger fee can equal a smaller fee in full), so they are UNMATCHED.
 * A second refunded line naming the same fee in one refund is unmatched too. The caller parks an unmatched fee: a refunded fee is never dropped and never guessed at.
 * Returns, per input fee line (same order), the matched order line id or null.
 */
export function matchRefundedFeeLines(feeLines: readonly WcRefundFeeLineLike[], orderLines: readonly FeeMatchOrderLine[]): Array<string | null> {
  const used = new Set<string>()
  const name = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()
  const feeShaped = orderLines.filter((line) => line.productId === null && line.externalLineItemId === null)
  return feeLines.map((fee) => {
    const wanted = name(fee.name)
    if (wanted === '') return null
    const sameName = feeShaped.filter((line) => name(line.description) === wanted)
    if (sameName.length !== 1) return null
    const only = sameName[0]!
    if (used.has(only.id)) return null
    used.add(only.id)
    return only.id
  })
}
