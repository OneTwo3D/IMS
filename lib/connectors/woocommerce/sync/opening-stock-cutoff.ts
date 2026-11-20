import { db } from '@/lib/db'
import { OPENING_STOCK_CUTOFF_FACT } from '@/lib/first-load/opening-stock-cutoff'

/**
 * The instant the opening stock was extracted (the first-load manifest's `stockExtractedAt`), as the first-load apply recorded it: see `lib/first-load/opening-stock-cutoff.ts`.
 * `null` ONLY when it is genuinely absent. A read error or a malformed value THROWS, so the caller fails and is retried instead of misclassifying an order for good.
 */
export async function readOpeningStockCutoff(): Promise<Date | null> {
  // A READ ERROR THROWS, so the import fails retryably. Returning null here would read as "no instant on record" and classify a post-cut-off order historical for good.
  const row = await db.firstLoadApplyRun.findFirst({ select: { facts: true } })
  const facts = row?.facts
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null
  const value = (facts as Record<string, unknown>)[OPENING_STOCK_CUTOFF_FACT]
  if (value === undefined) return null
  const at = typeof value === 'string' ? new Date(value) : null
  if (at === null || Number.isNaN(at.getTime())) throw new Error(`the recorded opening-stock instant (${OPENING_STOCK_CUTOFF_FACT}) is not a readable date`)
  return at
}
