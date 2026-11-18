import { db } from '@/lib/db'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * The base-currency value of stock that has LEFT a source warehouse on a transfer and has not yet landed, as of a cutoff instant.
 *
 * A dispatched transfer takes its stock (and cost layers) out of the source warehouse at dispatch, so the inventory snapshot and the
 * cost-layer valuation no longer hold it. The GL has no entry for the move (it is one Inventory account, and the only journal is the
 * revaluation of a landed-cost change), so the value stays in Inventory until the stock lands. A comparison of the snapshot with the GL
 * that does not add this value back reports a gap that is not a misstatement.
 *
 * Read from the stock-movement ledger, which is the one place every route is written: TRANSFER_OUT at dispatch, TRANSFER_IN at a full
 * receive, a partial receive, a WMS book-in, or the compensating restore of a cancelled dispatch. Outstanding value is therefore
 * Σ TRANSFER_OUT − Σ TRANSFER_IN over `referenceType = 'StockTransfer'` movements recorded before the cutoff. A movement with no
 * value (a pre-valuation historical row) contributes nothing on either side.
 */
export async function loadInTransitTransferValueBase(
  cutoffExclusive: Date,
  client: { stockMovement: { aggregate: (args: never) => Promise<{ _sum: { totalValueBase: unknown } }> } } = db as never,
): Promise<Decimal> {
  const sumFor = async (type: 'TRANSFER_OUT' | 'TRANSFER_IN') => {
    const result = await client.stockMovement.aggregate({
      _sum: { totalValueBase: true },
      where: { type, referenceType: 'StockTransfer', createdAt: { lt: cutoffExclusive } },
    } as never)
    return toDecimal((result._sum.totalValueBase as never) ?? 0)
  }
  const [out, received] = await Promise.all([sumFor('TRANSFER_OUT'), sumFor('TRANSFER_IN')])
  const outstanding = out.sub(received)
  // A receipt can never exceed what was dispatched; a negative net is bookkeeping noise, not stock owed to the GL.
  return outstanding.isNegative() ? toDecimal(0) : outstanding
}
