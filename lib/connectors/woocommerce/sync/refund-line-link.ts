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
