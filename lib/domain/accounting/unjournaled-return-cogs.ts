import type { Prisma } from '@/app/generated/prisma/client'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { addMoney, multiplyMoney, roundQuantity, subtractMoney, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Stock that came back BEFORE its shipment was journaled (o3d-hqvrp.32).
 *
 * A refund that returns units of a shipment the daily batch has not journaled yet restocks them at the issued
 * cost, with a cost layer, but its accounting staging only reads JOURNALED shipments, so it records no COGS
 * reversal. Group B later journals the shipment's full COGS (DR COGS / CR Allocated Inventory) without knowing
 * the units came back, which would leave the returned layer with no Inventory debit and COGS overstated.
 *
 * So when Group B journals a shipment it also books the reversal those refunds never could, in the same journal:
 * DR Inventory / CR COGS for the value the refund returned to stock that no staged COGS reversal already
 * covered. Net: COGS = shipped - returned, and the Inventory debit equals the returned cost layers.
 *
 * Idempotent per refund through its subledger row (`unjournaledReturnKey`), recorded in the same transaction as
 * the journal. Capped, per order, by the COGS this batch journals for that order, so a reversal can never make
 * the order's COGS negative; a refund that does not fit waits for a later batch, whole.
 */
export function unjournaledReturnKey(refundId: string): string {
  return `refund-unjournaled-return:${refundId}`
}

export type UnjournaledReturnCredit = { orderId: string; refundId: string; amount: Decimal }

export async function loadUnjournaledReturnCredits(
  tx: Prisma.TransactionClient,
  batchCogsByOrder: ReadonlyMap<string, number>,
): Promise<UnjournaledReturnCredit[]> {
  const orderIds = [...batchCogsByOrder.keys()]
  if (orderIds.length === 0) return []
  const refunds = await tx.salesOrderRefund.findMany({
    where: { orderId: { in: orderIds }, returnWarehouseId: { not: null }, chargeback: false, returnInTransit: false },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, orderId: true, lines: { select: { costLayerSnapshot: true } } },
  })
  if (refunds.length === 0) return []
  const refundIds = refunds.map((refund) => refund.id)
  const [movements, recorded] = await Promise.all([
    tx.stockMovement.findMany({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: refundIds } },
      select: { referenceId: true, totalValueBase: true },
    }),
    tx.cogsSubledgerMovement.findMany({
      where: { idempotencyKey: { in: refundIds.map(unjournaledReturnKey) } },
      select: { idempotencyKey: true },
    }),
  ])
  const done = new Set(recorded.map((row) => row.idempotencyKey))
  const returnedByRefund = new Map<string, Decimal>()
  for (const movement of movements) {
    if (!movement.referenceId || movement.totalValueBase == null) continue
    returnedByRefund.set(movement.referenceId, addMoney(returnedByRefund.get(movement.referenceId) ?? toDecimal(0), movement.totalValueBase))
  }

  const remainingCap = new Map(batchCogsByOrder)
  const credits: UnjournaledReturnCredit[] = []
  for (const refund of refunds) {
    if (done.has(unjournaledReturnKey(refund.id))) continue
    const returned = returnedByRefund.get(refund.id)
    if (!returned) continue
    // What a staged COGS reversal already covered: the shipment-source entries on the refund's own lines.
    let staged = toDecimal(0)
    for (const line of refund.lines) {
      for (const entry of parseCostLayerSnapshot(line.costLayerSnapshot)) {
        if (entry.source === 'shipment') staged = addMoney(staged, multiplyMoney(entry.qty, entry.unitCostBase))
      }
    }
    const amount = roundQuantity(subtractMoney(returned, staged), 6)
    if (amount.lte(0.005)) continue
    const cap = remainingCap.get(refund.orderId) ?? 0
    if (amount.gt(cap)) continue
    remainingCap.set(refund.orderId, cap - amount.toNumber())
    credits.push({ orderId: refund.orderId, refundId: refund.id, amount })
  }
  return credits
}
