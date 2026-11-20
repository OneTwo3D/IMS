import { db } from '@/lib/db'

/**
 * THE INSTANT THE OPENING STOCK WAS TAKEN (o3d-hqvrp.92).
 *
 * The first-load apply records it, once, on the run record's `facts`, just before it writes the first opening-stock row. Opening stock is a
 * quiescent snapshot, so every sale completed BEFORE this instant is already reflected in the quantities and cost layers it loaded; a sale
 * completed at or after it is not. The storefront order import uses it to decide which first-seen completed orders may consume stock: only
 * those completed at or after it. Nothing here guesses: a missing, unreadable or malformed instant reads as `null`, and the reader of a
 * `null` consumes nothing (fail closed).
 */
export const OPENING_STOCK_CUTOFF_FACT = 'openingStockCutoffAt'

export async function readOpeningStockCutoff(): Promise<Date | null> {
  try {
    const row = await db.firstLoadApplyRun.findFirst({ select: { facts: true } })
    const facts = row?.facts
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null
    const value = (facts as Record<string, unknown>)[OPENING_STOCK_CUTOFF_FACT]
    if (typeof value !== 'string') return null
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? null : at
  } catch {
    return null
  }
}
