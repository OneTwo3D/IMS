/**
 * THE READ HALF OF refreshDiscountSplitCodes (discount-tax-split.ts): the current accounting tax code of every rate a discount split names. Shared by the finalisation check, the invoice build and the
 * refund, so all three derive a group's code from the rate as it is NOW, as the goods lines do, never from the snapshot the draft was saved with.
 */
import type { db } from '@/lib/db'
import { refreshDiscountSplitCodes, type DiscountTaxSplitEntry } from '@/lib/domain/sales/discount-tax-split'

export async function refreshedDiscountSplit(reader: Pick<typeof db, 'taxRate'>, split: ReadonlyArray<DiscountTaxSplitEntry>): Promise<DiscountTaxSplitEntry[]> {
  const ids = [...new Set(split.map((entry) => entry.taxRateId).filter((id): id is string => id !== null))]
  if (ids.length === 0) return [...split]
  const rows = await reader.taxRate.findMany({ where: { id: { in: ids } }, select: { id: true, accountingTaxType: true } })
  return refreshDiscountSplitCodes(split, new Map(rows.map((row) => [row.id, row.accountingTaxType] as const)))
}
