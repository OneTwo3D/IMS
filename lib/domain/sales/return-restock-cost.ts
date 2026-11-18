import type { Prisma } from '@/app/generated/prisma/client'
import { getAverageUnitCost, getHistoricalAverageUnitCost } from '@/lib/cost-layers'
import type { RefundReturnRow } from '@/lib/domain/sales/refund-service'

/**
 * Gives every unpriced row of a returns-inbox restock a unit cost, so the units enter stock with a cost layer.
 *
 * A row the refund's return expectation covered arrives priced (its own dispatch cost). Whatever no expectation
 * covers (an over-return, a legacy refund that already restocked, no refund at all) used to go in with no unit
 * cost: on-hand stock with no cost layer and a zero-value movement, which later sells at zero COGS. Such a row is
 * valued the way a manual stock addition is: the warehouse's current average layer cost, else the product's
 * historical average. With no cost basis anywhere the restock is refused, never booked at zero.
 */
export async function priceUnpricedReturnRows(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  rows: readonly RefundReturnRow[],
): Promise<RefundReturnRow[]> {
  const priced: RefundReturnRow[] = []
  for (const row of rows) {
    if (row.unitCostBase != null) {
      priced.push(row)
      continue
    }
    const warehouseAverage = await getAverageUnitCost(tx, row.productId, warehouseId)
    const unitCostBase = warehouseAverage > 0 ? warehouseAverage : await getHistoricalAverageUnitCost(tx, row.productId)
    if (!(unitCostBase > 0)) {
      throw new Error(
        'This returned item cannot be restocked because no unit cost could be derived for the product (it has no cost layers). Receive or adjust stock for it first so returned units carry a cost.',
      )
    }
    priced.push({ ...row, unitCostBase })
  }
  return priced
}
