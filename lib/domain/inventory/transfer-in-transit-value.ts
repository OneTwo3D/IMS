import { Prisma, type PrismaClient } from '@/app/generated/prisma/client'
import { addMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * STOCK IN TRANSIT, VALUED TRANSFER BY TRANSFER (ACC-M12).
 *
 * A transfer posts nothing to the ledger: the units stay in the Inventory GL for the whole journey. But the moment they
 * are dispatched they leave the source warehouse's stock level and cost layers, and until a receipt puts them into the
 * destination they are in NO inventory snapshot row. So on any day a transfer is dispatched and not fully received, the
 * snapshot is short of the GL by exactly the value of those units.
 *
 * WHY NOT TRANSFER_OUT MINUS TRANSFER_IN GLOBALLY (the approach #1027 backed out). A sum over all history filtered on
 * one reference type never clears for a WMS receipt, which writes its TRANSFER_IN under the ASN map (or a
 * WMS_RECEIPT_RECONCILIATION under the ASN line map, for a stock-sync alignment) rather than under the transfer; and it
 * drifts for good after a landed-cost revaluation, because the receipt is valued from the REWRITTEN dispatch snapshot
 * while the dispatch movement keeps its dispatch-time value. This module measures each transfer on its own and says
 * where every leg comes from.
 *
 * IN TRANSIT (transfer T, instant X) =
 *     cost dispatched      TRANSFER_OUT movements of T created before X
 *   + revaluations         landed-cost revaluations capitalised for T's units while they were in transit, before X
 *                          (stock_transfer_transit_revaluations: a mirror of the DR Inventory the GL took then)
 *   - cost received        every receipt of T created before X, by EVERY path:
 *       . TRANSFER_IN under ('StockTransfer', T)                 manual full and partial receipts, and the
 *                                                                cancel-dispatch restore to the source
 *       . TRANSFER_IN under ('WmsAsnMap', asn)                   WMS booked-in webhook; the ASN map links to T by
 *                                                                wms_asn_maps.sourceType = STOCK_TRANSFER, sourceId = T
 *       . WMS_RECEIPT_RECONCILIATION under ('WmsAsnLineMap', l)  stock-sync alignment credit; the line map links to
 *                                                                T through stock_transfer_lines (zero-qty audit markers
 *                                                                carry no value and add nothing)
 * All three legs are the values BOOKED on the movements (and mirrored revaluation rows), so a landed-cost revaluation
 * that reached the in-transit units is in the receipt's value (the snapshot it rewrote) and in the revaluation leg, and
 * the two cancel. The GL treats such a revaluation as DR Inventory at revaluation time (capitaliseInTransitResidue);
 * the revaluation leg is that same amount, at that same moment.
 *
 * AS OF X, NOT AS OF NOW: every leg is filtered on its own timestamp, so a transfer dispatched before X and received
 * after X is in transit at X, and one received before X is not.
 *
 * A transfer already CLOSED (RECEIVED or CANCELLED, completedAt before X) is never in transit, whatever its legs sum to:
 * a leftover there is a genuine receipt-valuation variance (a short snapshot priced at zero) that belongs on the
 * reconciliation as a gap, not parked on the in-transit line for ever.
 */
export type InTransitTransferValue = {
  transferId: string
  valueBase: Decimal
  /** False when a dispatch or receipt movement of this transfer carries no value (pre-valuation history): the figure is a floor. */
  reliable: boolean
}

type InTransitRow = {
  transferId: string
  value: string | number | null
  nullValueMovements: bigint | number | string
}

export type InTransitValueClient = Pick<PrismaClient, '$queryRaw'>

/** Below this a transfer's net is rounding noise left by 6dp movement values, not stock. */
const IN_TRANSIT_NOISE = new Prisma.Decimal('0.000001')

/**
 * The transfers in transit at `asOf` with their value. Returns null when the client cannot run a raw query (an injected
 * test double), so the caller can tell "not measured" from "nothing in transit".
 */
export async function loadInTransitTransferValues(
  client: unknown,
  asOf: Date,
): Promise<InTransitTransferValue[] | null> {
  if (!client || typeof (client as { $queryRaw?: unknown }).$queryRaw !== 'function') return null
  const rows = await (client as InTransitValueClient).$queryRaw<InTransitRow[]>(Prisma.sql`
    WITH dispatched AS (
      SELECT m."referenceId" AS "transferId",
             COALESCE(SUM(m."totalValueBase"), 0) AS value,
             COUNT(*) FILTER (WHERE m."totalValueBase" IS NULL) AS nulls
        FROM stock_movements m
       WHERE m.type = 'TRANSFER_OUT'::"StockMovementType"
         AND m."referenceType" = 'StockTransfer'
         AND m."createdAt" < ${asOf}
       GROUP BY m."referenceId"
    ),
    receipts AS (
      SELECT r."transferId", COALESCE(SUM(r.value), 0) AS value, COUNT(*) FILTER (WHERE r.value IS NULL) AS nulls
        FROM (
          SELECT m."referenceId" AS "transferId", m."totalValueBase" AS value
            FROM stock_movements m
           WHERE m.type = 'TRANSFER_IN'::"StockMovementType"
             AND m."referenceType" = 'StockTransfer'
             AND m."createdAt" < ${asOf}
          UNION ALL
          SELECT am."sourceId", m."totalValueBase"
            FROM stock_movements m
            JOIN wms_asn_maps am ON am.id = m."referenceId"
           WHERE m.type = 'TRANSFER_IN'::"StockMovementType"
             AND m."referenceType" = 'WmsAsnMap'
             AND am."sourceType" = 'STOCK_TRANSFER'::"WmsAsnSourceType"
             AND m."createdAt" < ${asOf}
          UNION ALL
          SELECT stl."transferId", m."totalValueBase"
            FROM stock_movements m
            JOIN wms_asn_line_maps lm ON lm.id = m."referenceId"
            JOIN stock_transfer_lines stl ON stl.id = lm."sourceLineId"
           WHERE m.type = 'WMS_RECEIPT_RECONCILIATION'::"StockMovementType"
             AND m."referenceType" = 'WmsAsnLineMap'
             AND m.qty > 0
             AND lm."sourceType" = 'STOCK_TRANSFER_LINE'::"WmsAsnSourceType"
             AND m."createdAt" < ${asOf}
        ) r
       GROUP BY r."transferId"
    ),
    revalued AS (
      SELECT stl."transferId", COALESCE(SUM(v."deltaBase"), 0) AS value
        FROM stock_transfer_transit_revaluations v
        JOIN stock_transfer_lines stl ON stl.id = v."transferLineId"
       WHERE v."effectiveAt" < ${asOf}
       GROUP BY stl."transferId"
    )
    SELECT d."transferId" AS "transferId",
           (d.value + COALESCE(rv.value, 0) - COALESCE(r.value, 0))::text AS value,
           (d.nulls + COALESCE(r.nulls, 0)) AS "nullValueMovements"
      FROM dispatched d
      JOIN stock_transfers st ON st.id = d."transferId"
      LEFT JOIN receipts r ON r."transferId" = d."transferId"
      LEFT JOIN revalued rv ON rv."transferId" = d."transferId"
     WHERE NOT (st.status IN ('RECEIVED'::"StockTransferStatus", 'CANCELLED'::"StockTransferStatus")
                AND st."completedAt" IS NOT NULL AND st."completedAt" < ${asOf})
     ORDER BY d."transferId"
  `)
  const result: InTransitTransferValue[] = []
  for (const row of rows) {
    const value = roundQuantity(toDecimal(row.value ?? 0), 6)
    if (value.abs().lt(IN_TRANSIT_NOISE)) continue
    result.push({ transferId: row.transferId, valueBase: value, reliable: Number(row.nullValueMovements) === 0 })
  }
  return result
}

/** The in-transit total, to the 6dp the snapshot carries. */
export function sumInTransitValue(values: ReadonlyArray<Pick<InTransitTransferValue, 'valueBase'>>): Decimal {
  return roundQuantity(values.reduce((sum, row) => addMoney(sum, row.valueBase), toDecimal(0)), 6)
}

export type TransitRevaluationEntry = {
  costLayerId: string
  transferLineId: string
  qty: string
  unitDelta: string
  delta: string
}

/**
 * Mirror, durably, the share of a landed-cost revaluation that was capitalised to Inventory for units still in transit
 * (capitaliseInTransitResidue's entries), at the moment the GL took it. Written in the revaluation's own transaction, so the
 * mirror and the journal amount are both committed or both rolled back. Signed: a cost decrease is a negative row.
 */
export async function recordTransferTransitRevaluations(
  tx: Prisma.TransactionClient,
  entries: ReadonlyArray<TransitRevaluationEntry>,
  effectiveAt: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return
  await tx.stockTransferTransitRevaluation.createMany({
    data: entries.map((entry) => ({
      transferLineId: entry.transferLineId,
      costLayerId: entry.costLayerId,
      qty: entry.qty,
      unitDelta: entry.unitDelta,
      deltaBase: entry.delta,
      effectiveAt,
    })),
  })
}
