import type { Prisma } from '@/app/generated/prisma/client'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { addMoney, multiplyMoney, roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Stock that came back BEFORE its shipment was journaled (o3d-hqvrp.32).
 *
 * A refund that returns units of a shipment the daily batch has not journaled yet restocks them at the issued
 * cost, with a cost layer, but its accounting staging only reads JOURNALED shipments, so it records no COGS
 * reversal. Group B later journals the shipment's full COGS (DR COGS / CR Allocated Inventory) without knowing
 * the units came back, which would leave the returned layer with no Inventory debit and COGS overstated.
 *
 * So when Group B journals a shipment it also books, in the same journal, the reversal for the units of THAT
 * shipment that came back: DR Inventory / CR COGS. The refund records which shipments its returned units came
 * from and what they cost (`SalesOrderRefund.returnCostSplit`), so each shipment books only its own share, in
 * whichever batch run journals it, and the rest is booked by the runs that journal the other shipments. Net:
 * COGS = shipped - returned, and the Inventory debit equals the returned cost layers.
 *
 * A refund can span a journaled and an unjournaled shipment: staging then restocks the journaled units with their
 * COGS reversal, the fallback rows restock the rest, and `returnCostSplit` is rewritten to the fallback-restocked
 * shares only. Group B books each such share, less whatever a staged COGS reversal already covers for that shipment.
 *
 * Exactly once per (refund, shipment): the booking is recorded as a COGS sub-ledger row keyed
 * `unjournaledReturnKey`, in the same transaction as the journal. A share is capped by the shipment's own COGS,
 * so the reversal can never make a shipment's COGS negative.
 */
export function unjournaledReturnKey(refundId: string, shipmentId: string): string {
  return `refund-unjournaled-return:${refundId}:${shipmentId}`
}

export type UnjournaledReturnCredit = { orderId: string; refundId: string; shipmentId: string; amount: Decimal }

export async function loadUnjournaledReturnCredits(
  tx: Prisma.TransactionClient,
  batchShipments: ReadonlyArray<{ shipmentId: string; orderId: string; cogs: number }>,
): Promise<UnjournaledReturnCredit[]> {
  if (batchShipments.length === 0) return []
  const shipmentById = new Map(batchShipments.map((s) => [s.shipmentId, s]))
  const orderIds = [...new Set(batchShipments.map((s) => s.orderId))]
  const refunds = await tx.salesOrderRefund.findMany({
    where: { orderId: { in: orderIds }, deletedAt: null, returnWarehouseId: { not: null }, chargeback: false, returnInTransit: false, returnCostSplit: { not: null as never } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, orderId: true, returnCostSplit: true, lines: { select: { costLayerSnapshot: true } } },
  })
  if (refunds.length === 0) return []
  const refundIds = refunds.map((refund) => refund.id)
  const [movements, recorded] = await Promise.all([
    tx.stockMovement.findMany({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: refundIds } },
      select: { referenceId: true },
    }),
    tx.cogsSubledgerMovement.findMany({
      where: { idempotencyKey: { startsWith: 'refund-unjournaled-return:' }, sourceRef: { in: refundIds } },
      select: { idempotencyKey: true },
    }),
  ])
  const shipmentLines = await tx.shipmentLine.findMany({ where: { shipmentId: { in: batchShipments.map((s) => s.shipmentId) } }, select: { id: true, shipmentId: true } })
  const shipmentIdByLine = new Map(shipmentLines.map((line) => [line.id, line.shipmentId]))
  const done = new Set(recorded.map((row) => row.idempotencyKey))
  const returned = new Set(movements.map((movement) => movement.referenceId))

  const remaining = new Map(batchShipments.map((s) => [s.shipmentId, s.cogs]))
  const credits: UnjournaledReturnCredit[] = []
  for (const refund of refunds) {
    // Only a return that was actually applied from the fallback rows (no staged shipment-source snapshot).
    if (!returned.has(refund.id)) continue
    // What a staged COGS reversal already covers, per source shipment: only that part of a share is skipped.
    const stagedByShipment = new Map<string, Decimal>()
    for (const line of refund.lines) {
      for (const entry of parseCostLayerSnapshot(line.costLayerSnapshot)) {
        const shipmentId = entry.source === 'shipment' && entry.shipmentLineId ? shipmentIdByLine.get(entry.shipmentLineId) : undefined
        if (shipmentId) stagedByShipment.set(shipmentId, addMoney(stagedByShipment.get(shipmentId) ?? toDecimal(0), multiplyMoney(entry.qty, entry.unitCostBase)))
      }
    }
    const split = Array.isArray(refund.returnCostSplit) ? refund.returnCostSplit as Array<{ shipmentId?: string; valueBase?: string }> : []
    for (const part of split) {
      const shipment = part.shipmentId ? shipmentById.get(part.shipmentId) : undefined
      if (!shipment || shipment.orderId !== refund.orderId || !part.valueBase) continue
      if (done.has(unjournaledReturnKey(refund.id, shipment.shipmentId))) continue
      const cap = remaining.get(shipment.shipmentId) ?? 0
      const uncovered = toDecimal(part.valueBase).sub(stagedByShipment.get(shipment.shipmentId) ?? 0).toNumber()
      const amount = roundQuantity(Math.min(uncovered, cap), 6)
      if (amount.lte(0.005)) continue
      remaining.set(shipment.shipmentId, cap - amount.toNumber())
      credits.push({ orderId: refund.orderId, refundId: refund.id, shipmentId: shipment.shipmentId, amount })
    }
  }
  return credits
}
