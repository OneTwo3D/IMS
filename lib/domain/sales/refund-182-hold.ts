/**
 * THE FIRST-N HOLD ON A RATE-182 SCHEME CREDIT NOTE (owner ruling 2026-11-09). A refund whose VAT the EAS compliance plugin booked on WooCommerce rate 182, on an order stamped as an IOSS/VOEC/DDP scheme order, is posted to the stamped VAT account, but the first
 * `eu_vat_refund182_hold_threshold` (default 10) credit notes are held: queued as a refused row (never sent) for a person to review in Xero and settle on /sync.
 *
 * NO STAMP AND NO COUNT WITHOUT THE ROW. One transaction takes the counter's row lock, reads the threshold and the count, and, while the count is below the threshold, calls `enqueueHeldRow` (the caller's idempotent enqueue of the REFUSED credit-note row, made on its own connection while the lock is held).
 * Only when that reports the row queued does the same transaction increment the count and stamp the refund (`eas182_held_at`) and commit; if it does not, or throws, the transaction rolls back and nothing is counted. A crash between the enqueue and the commit leaves a refused,
 * never-sent row and no stamp, and the retry (same idempotency key) finds that row. Two refunds racing at count 9 of 10 queue behind the counter's lock, so exactly one holds.
 *
 * A HELD DECISION IS PERMANENT. A refund already stamped is held again on every later treatment, whatever the Sales Invoices switch says now and whatever the count is, WITHOUT being counted again (`eas182_held_at` is set once). It never posts automatically; a person settles the row.
 * A threshold or count that is not a whole number is not guessed: the credit note is held, and nothing is counted. A threshold of 0 holds nothing and writes nothing.
 */
import { db } from '@/lib/db'
import { EU_VAT_REFUND_HELD_COUNT_SETTING, EU_VAT_REFUND_HOLD_THRESHOLD_SETTING, parseCountSetting, refundHoldThreshold } from '@/lib/domain/accounting/eu-vat-settings'

/** What the caller's enqueue of the refused row answered (the accounting facade's outcome, passed through untouched). */
export type HeldRowEnqueue = { queued: boolean }

export type Refund182HoldDecision<T extends HeldRowEnqueue> =
  | { held: false }
  /** The row was queued and (for `newlyHeld`) the count and the stamp committed with it. `threshold` is null when the stored threshold or count is not a whole number. */
  | { held: true; queued: true; newlyHeld: boolean; heldNumber: number; threshold: number | null; outcome: T }
  /** The row could not be queued: nothing was stamped or counted. `outcome` is what the enqueue said, for the caller's obligation ledger. */
  | { held: true; queued: false; outcome: T }

class RowNotQueued<T> extends Error {
  constructor(readonly outcome: T) { super('the held credit-note row was not queued') }
}

export async function decideRefund182Hold<T extends HeldRowEnqueue>(refundId: string, enqueueHeldRow: (place: { heldNumber: number; threshold: number | null }) => Promise<T>): Promise<Refund182HoldDecision<T>> {
  const heldAtOf = async (client: Pick<typeof db, '$queryRaw'>): Promise<Date | null> => {
    const rows = await client.$queryRaw<Array<{ held: Date | null }>>`SELECT eas182_held_at AS held FROM sales_order_refunds WHERE id = ${refundId}`
    if (rows.length === 0) throw new Error('the refund to hold could not be found')
    return rows[0]!.held
  }
  const placeOf = async (client: Pick<typeof db, '$queryRaw'>): Promise<number> => Number((await client.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM sales_order_refunds WHERE eas182_held_at IS NOT NULL AND eas182_held_at <= (SELECT eas182_held_at FROM sales_order_refunds WHERE id = ${refundId})`)[0]?.n ?? 0)
  const thresholdOf = async (client: typeof db): Promise<number | null> => refundHoldThreshold((await client.setting.findUnique({ where: { key: EU_VAT_REFUND_HOLD_THRESHOLD_SETTING }, select: { value: true } }))?.value)

  // Already held: held again, never counted again, and the (idempotent) refused row is enqueued again in case the first attempt never got it queued.
  const alreadyHeld = async (threshold: number | null): Promise<Refund182HoldDecision<T>> => {
    const outcome = await enqueueHeldRow({ heldNumber: await placeOf(db), threshold })
    return outcome.queued ? { held: true, queued: true, newlyHeld: false, heldNumber: await placeOf(db), threshold, outcome } : { held: true, queued: false, outcome }
  }
  if ((await heldAtOf(db)) !== null) return alreadyHeld(await thresholdOf(db))
  const preThreshold = await thresholdOf(db)
  if (preThreshold === 0) return { held: false }

  try {
    return await db.$transaction(async (tx) => {
      // The counter's row lock serialises every hold decision.
      await tx.$executeRaw`INSERT INTO settings (key, value, "updatedAt") VALUES (${EU_VAT_REFUND_HELD_COUNT_SETTING}, '0', now()) ON CONFLICT (key) DO NOTHING`
      const stored = (await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM settings WHERE key = ${EU_VAT_REFUND_HELD_COUNT_SETTING} FOR UPDATE`)[0]?.value
      // Re-read under the lock: a concurrent treatment of this same refund may have held it, and the threshold may have changed.
      if ((await heldAtOf(tx as unknown as typeof db)) !== null) return await alreadyHeld(await thresholdOf(db))
      const threshold = await thresholdOf(tx as unknown as typeof db)
      if (threshold === 0) return { held: false as const }
      const count = parseCountSetting(stored)
      const countable = threshold !== null && count.state !== 'invalid'
      const held = count.state === 'ok' ? count.value : 0
      if (countable && held >= threshold) return { held: false as const }
      const heldNumber = countable ? held + 1 : (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) + 1 AS n FROM sales_order_refunds WHERE eas182_held_at IS NOT NULL`).map((row) => Number(row.n))[0] ?? 1
      const outcome = await enqueueHeldRow({ heldNumber, threshold: countable ? threshold : null })
      if (!outcome.queued) throw new RowNotQueued(outcome)
      if (countable) await tx.$executeRaw`UPDATE settings SET value = ${String(held + 1)}, "updatedAt" = now() WHERE key = ${EU_VAT_REFUND_HELD_COUNT_SETTING}`
      await tx.$executeRaw`UPDATE sales_order_refunds SET eas182_held_at = now() WHERE id = ${refundId}`
      return { held: true as const, queued: true as const, newlyHeld: true, heldNumber, threshold: countable ? threshold : null, outcome }
    }, { timeout: 60_000, maxWait: 60_000 })
  } catch (error) {
    if (error instanceof RowNotQueued) return { held: true, queued: false, outcome: error.outcome as T }
    throw error
  }
}
