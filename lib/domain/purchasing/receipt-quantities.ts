import { type Decimal, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

/**
 * mgyk: sum a receipt's qty per PO line (across warehouses). One PO line may be split
 * across several warehouse rows in a single receipt, so the outstanding-qty ceiling
 * must be checked against the SUMMED qty per line, not per individual row — otherwise
 * two rows for the same line can each pass while their total over-receives the line.
 *
 * Each row is rounded to the 6dp quantity-engine scale BEFORE summing, with the Decimal
 * engine (not JS floats): this matches exactly what the receipt write loop persists per
 * row (sum(round(row,6)), not round(sum(rows),6)), and a legitimate decimal split such
 * as 0.1 + 0.2 totals exactly 0.3 rather than 0.30000000000000004.
 */
export function sumReceiptQtyByPoLine(
  lines: Array<{ poLineId: string; qtyReceived: number }>,
): Map<string, Decimal> {
  const byLine = new Map<string, Decimal>()
  for (const line of lines) {
    const prev = byLine.get(line.poLineId) ?? toDecimal(0)
    byLine.set(line.poLineId, prev.plus(roundQuantity(line.qtyReceived, 6)))
  }
  return byLine
}
