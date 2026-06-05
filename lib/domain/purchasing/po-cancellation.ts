import type { Prisma } from '@/app/generated/prisma/client'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'
import { buildStockMovementValueFields } from '@/lib/domain/inventory/stock-movement-value'

type TxClient = Prisma.TransactionClient

type PurchaseOrderCostLayerRow = {
  id: string
  poLineId: string | null
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

export type PurchaseOrderCostLayerReversal = {
  costLayerId: string
  poLineId: string
  productId: string
  warehouseId: string
  qty: string
  unitCostBase: string
  totalValueBase: string
}

export type ReversePurchaseOrderCostLayersResult = {
  reversedLayers: PurchaseOrderCostLayerReversal[]
  productIds: string[]
  totalReversalValueBase: Decimal
}

export function assertPurchaseOrderCancellationHasNoInvoices(invoiceCount: number): void {
  if (invoiceCount > 0) {
    throw new Error('Cannot cancel a purchase order after supplier invoices have been recorded. Create a supplier credit or bill reversal instead.')
  }
}

export async function reversePurchaseOrderCostLayersForCancellation(
  tx: TxClient,
  params: {
    poId: string
    poReference: string
    poLineIds: string[]
  },
): Promise<ReversePurchaseOrderCostLayersResult> {
  if (params.poLineIds.length === 0) {
    return { reversedLayers: [], productIds: [], totalReversalValueBase: toDecimal(0) }
  }

  const layers = await tx.$queryRaw<PurchaseOrderCostLayerRow[]>`
    SELECT id, "poLineId", "productId", "warehouseId", "remainingQty", "unitCostBase"
    FROM "cost_layers"
    WHERE "poLineId" = ANY(${params.poLineIds}::text[])
      AND "remainingQty" > 0
    ORDER BY "receivedAt" ASC, id ASC
    FOR UPDATE
  `

  const reversedLayers: PurchaseOrderCostLayerReversal[] = []
  const productIds = new Set<string>()
  let totalReversalValueBase = toDecimal(0)

  for (const layer of layers) {
    if (!layer.poLineId) continue
    const qty = roundQuantity(layer.remainingQty, 4)
    if (qty.lte(0)) continue

    await tx.$queryRaw`
      SELECT "productId", "warehouseId"
      FROM "stock_levels"
      WHERE "productId" = ${layer.productId}
        AND "warehouseId" = ${layer.warehouseId}
      FOR UPDATE
    `
    const stockLevel = await tx.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: layer.productId, warehouseId: layer.warehouseId } },
      select: { quantity: true, reservedQty: true },
    })
    const quantity = toDecimal(stockLevel?.quantity ?? 0)
    const reservedQty = toDecimal(stockLevel?.reservedQty ?? 0)
    if (quantity.lt(qty)) {
      throw new Error(
        `Cannot cancel PO ${params.poReference}: cost layer ${layer.id} has ${qty.toString()} remaining but only ${quantity.toString()} stock is on hand`,
      )
    }
    if (subtractMoney(quantity, qty).lt(reservedQty)) {
      throw new Error(
        `Cannot cancel PO ${params.poReference}: cost layer ${layer.id} stock is reserved and cannot be reversed automatically`,
      )
    }

    const unitCostBase = toDecimal(layer.unitCostBase)
    const totalValueBase = roundQuantity(multiplyMoney(qty, unitCostBase), 6)
    const movement = await tx.stockMovement.create({
      data: {
        type: 'PURCHASE_REVERSAL',
        productId: layer.productId,
        fromWarehouseId: layer.warehouseId,
        qty: qty.toNumber(),
        ...buildStockMovementValueFields({ qty, unitCostBase }),
        note: `Reverse remaining receipt layer ${layer.id} on cancelled PO ${params.poReference}`,
        referenceType: 'PurchaseOrder',
        referenceId: params.poId,
        idempotencyKey: `purchase-order-cancel:${params.poId}:cost-layer:${layer.id}`,
      },
      select: { id: true },
    })
    await tx.cogsEntry.create({
      data: {
        costLayerId: layer.id,
        movementId: movement.id,
        qty: qty.toNumber(),
        unitCostBase: unitCostBase.toNumber(),
        totalCostBase: totalValueBase.toNumber(),
      },
    })
    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: layer.productId, warehouseId: layer.warehouseId } },
      data: { quantity: { decrement: qty.toNumber() } },
    })
    await tx.costLayer.update({
      where: { id: layer.id },
      data: { remainingQty: 0 },
    })

    productIds.add(layer.productId)
    totalReversalValueBase = addMoney(totalReversalValueBase, totalValueBase)
    reversedLayers.push({
      costLayerId: layer.id,
      poLineId: layer.poLineId,
      productId: layer.productId,
      warehouseId: layer.warehouseId,
      qty: qty.toString(),
      unitCostBase: roundQuantity(unitCostBase, 6).toString(),
      totalValueBase: totalValueBase.toString(),
    })
  }

  return {
    reversedLayers,
    productIds: [...productIds],
    totalReversalValueBase,
  }
}
