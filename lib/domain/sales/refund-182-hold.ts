/**
 * THE FIRST-N HOLD ON A RATE-182 SCHEME CREDIT NOTE (owner ruling 2026-11-09). A refund whose VAT the EAS compliance plugin booked on WooCommerce rate 182, on an order stamped as an IOSS/VOEC/DDP scheme order, is posted to the stamped VAT account, but the first
 * `eu_vat_refund182_hold_threshold` (default 10) credit notes are held: queued as a refused row (never sent) for a person to review in Xero and settle on /sync.
 *
 * THE COUNT IS TAKEN UNDER A ROW LOCK. One transaction locks the refund, makes sure the counter row exists, locks it, reads the threshold and the count, and either increments the count and stamps the refund (`eas182_held_at`) or does neither. Two refunds racing at count 9 of 10 queue
 * behind the counter's lock, so exactly one reads 9 and holds; the other reads 10 and posts. The stamp makes it once per refund: an accounting retry of a held refund is held again WITHOUT being counted again, and a refund that posted is never held later. A threshold or count that is
 * not a whole number is not guessed: the credit note is held, and nothing is counted. A threshold of 0 holds nothing and writes nothing.
 */
import { db } from '@/lib/db'
import { EU_VAT_REFUND_HELD_COUNT_SETTING, EU_VAT_REFUND_HOLD_THRESHOLD_SETTING, parseCountSetting, refundHoldThreshold } from '@/lib/domain/accounting/eu-vat-settings'

export type Refund182HoldDecision =
  | { held: false }
  /** `heldNumber`: this credit note's place among the held ones (1 for the first). `threshold`: null when the stored threshold or count is not a whole number. */
  | { held: true; newlyHeld: boolean; heldNumber: number; threshold: number | null }

export async function decideRefund182Hold(refundId: string): Promise<Refund182HoldDecision> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ held: Date | null }>>`SELECT eas182_held_at AS held FROM sales_order_refunds WHERE id = ${refundId} FOR UPDATE`
    if (rows.length === 0) throw new Error('the refund to hold could not be found')
    const placeOf = async (): Promise<number> => Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM sales_order_refunds WHERE eas182_held_at IS NOT NULL AND eas182_held_at <= (SELECT eas182_held_at FROM sales_order_refunds WHERE id = ${refundId})`)[0]?.n ?? 0)
    const storedThreshold = (await tx.setting.findUnique({ where: { key: EU_VAT_REFUND_HOLD_THRESHOLD_SETTING }, select: { value: true } }))?.value
    const threshold = refundHoldThreshold(storedThreshold)
    // Already counted: held again, not counted again.
    if (rows[0]!.held !== null) return { held: true as const, newlyHeld: false, heldNumber: await placeOf(), threshold }
    if (threshold === 0) return { held: false as const }
    const stampHeld = async (): Promise<void> => { await tx.$executeRaw`UPDATE sales_order_refunds SET eas182_held_at = now() WHERE id = ${refundId}` }
    if (threshold === null) {
      await stampHeld()
      return { held: true as const, newlyHeld: true, heldNumber: await placeOf(), threshold: null }
    }
    await tx.$executeRaw`INSERT INTO settings (key, value, "updatedAt") VALUES (${EU_VAT_REFUND_HELD_COUNT_SETTING}, '0', now()) ON CONFLICT (key) DO NOTHING`
    const stored = (await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM settings WHERE key = ${EU_VAT_REFUND_HELD_COUNT_SETTING} FOR UPDATE`)[0]?.value
    const count = parseCountSetting(stored)
    if (count.state === 'invalid') {
      await stampHeld()
      return { held: true as const, newlyHeld: true, heldNumber: await placeOf(), threshold: null }
    }
    const held = count.state === 'ok' ? count.value : 0
    if (held >= threshold) return { held: false as const }
    await tx.$executeRaw`UPDATE settings SET value = ${String(held + 1)}, "updatedAt" = now() WHERE key = ${EU_VAT_REFUND_HELD_COUNT_SETTING}`
    await stampHeld()
    return { held: true as const, newlyHeld: true, heldNumber: held + 1, threshold }
  })
}
