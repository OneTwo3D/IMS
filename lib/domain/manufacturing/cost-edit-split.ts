import { Prisma } from '@/app/generated/prisma/client'

/**
 * How a retrospective manufacturing-cost edit on ONE output cost layer splits between the Inventory and COGS
 * legs of the MANUFACTURING_RECLASS journal (ACC-H14).
 *
 * The overhead credit side of that journal is the whole of the edit: receivedQty x unitDelta. The debit side has
 * to carry exactly the same amount, so it is split rather than summed from separately-derived pieces:
 *
 *   COGS leg      only the units that were SOLD: received - remaining - returned - transferred - used as a
 *                 component of a later production order - reversed out. A unit moved to another warehouse is not
 *                 COGS (transfers post nothing to the ledger, so it is still Inventory), and a unit that went
 *                 back to a customer is not COGS either. The old formula subtracted only the returned units,
 *                 so 6 of 10 units transferred away read as 6 sold and COGS was overstated by 6 x delta.
 *                 The part of the sold units' delta the SHIPMENT path posts itself (a COGS_REVERSAL / the daily
 *                 batch, `shipmentOwnedDelta`) is removed from this leg so it is not posted to COGS twice.
 *   Inventory leg EVERYTHING ELSE: total - COGS leg. That is on-hand units, units on a transfer or landed on a
 *                 destination layer, returned and re-used units, AND the shipment-owned part (the shipment
 *                 path debits COGS and CREDITS Inventory for it, so the reclass has to debit Inventory for it
 *                 for the two to net to a single debit to COGS). The old code dropped the shipment-owned part
 *                 from COGS and did not add it here, so any edit on an order with a journaled sold shipment
 *                 produced an unbalanced journal and was refused with a rounding message.
 *
 * Balanced by construction: cogsDelta + inventoryDelta === receivedQty x unitDelta.
 */
export function splitManufacturingRevaluation(input: {
  unitDelta: Prisma.Decimal
  receivedQty: Prisma.Decimal
  remainingQty: Prisma.Decimal
  returnedQty: Prisma.Decimal
  transferredQty: Prisma.Decimal
  manufacturingConsumedQty: Prisma.Decimal
  reversalConsumedQty: Prisma.Decimal
  /** COGS delta the shipment path already owns for this layer (refreshShipmentCogsForCostLayerChange). */
  shipmentOwnedDelta: Prisma.Decimal
}): { cogsDelta: Prisma.Decimal; inventoryDelta: Prisma.Decimal; soldQty: Prisma.Decimal } {
  const total = input.receivedQty.mul(input.unitDelta)
  const consumed = input.receivedQty.sub(input.remainingQty)
  const sold = Prisma.Decimal.max(
    new Prisma.Decimal(0),
    consumed
      .sub(input.returnedQty)
      .sub(input.transferredQty)
      .sub(input.manufacturingConsumedQty)
      .sub(input.reversalConsumedQty),
  )
  const cogsDelta = sold.mul(input.unitDelta).sub(input.shipmentOwnedDelta)
  return { cogsDelta, inventoryDelta: total.sub(cogsDelta), soldQty: sold }
}
