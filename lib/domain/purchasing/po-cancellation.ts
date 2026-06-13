import type { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
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
import { cogsEntryDataFromConsumed } from '@/lib/cost-layers'

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

// ---------------------------------------------------------------------------
// Already-consumed cost on cancellation (audit-H8)
//
// reversePurchaseOrderCostLayersForCancellation only reverses the remaining
// (still-on-hand) quantity of each cost layer. Units already consumed — sold,
// used in production, written off — keep their COGS sourced from the now-cancelled
// PO. Inventory reconciles, but the P&L silently carries cost from a cancelled
// receipt. This summarises that consumed portion (receivedQty − remainingQty)
// so the cancellation can flag it for finance review. Read BEFORE the reversal
// runs, so the about-to-be-reversed remaining quantity is not mistaken for
// consumption.
// ---------------------------------------------------------------------------

export type PurchaseOrderConsumedCostLayer = {
  costLayerId: string
  poLineId: string | null
  productId: string
  consumedQty: string
  unitCostBase: string
  consumedValueBase: string
}

export type PurchaseOrderConsumedCostSummary = {
  consumedQty: string
  consumedValueBase: string
  layers: PurchaseOrderConsumedCostLayer[]
}

type ConsumedCostLayerRow = {
  id: string
  poLineId: string | null
  productId: string
  receivedQty: DecimalInput
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

export function summarizeConsumedCostLayers(rows: ConsumedCostLayerRow[]): PurchaseOrderConsumedCostSummary {
  let consumedQty = toDecimal(0)
  let consumedValueBase = toDecimal(0)
  const layers: PurchaseOrderConsumedCostLayer[] = []

  for (const row of rows) {
    const consumed = subtractMoney(row.receivedQty, row.remainingQty)
    if (consumed.lte(0)) continue
    const unitCostBase = toDecimal(row.unitCostBase)
    const valueBase = roundQuantity(multiplyMoney(consumed, unitCostBase), 6)
    consumedQty = addMoney(consumedQty, consumed)
    consumedValueBase = addMoney(consumedValueBase, valueBase)
    layers.push({
      costLayerId: row.id,
      poLineId: row.poLineId,
      productId: row.productId,
      consumedQty: roundQuantity(consumed, 4).toString(),
      unitCostBase: roundQuantity(unitCostBase, 6).toString(),
      consumedValueBase: valueBase.toString(),
    })
  }

  return {
    consumedQty: roundQuantity(consumedQty, 4).toString(),
    consumedValueBase: roundQuantity(consumedValueBase, 2).toString(),
    layers,
  }
}

export async function readPurchaseOrderConsumedCostForCancellation(
  tx: TxClient,
  poLineIds: string[],
): Promise<PurchaseOrderConsumedCostSummary> {
  if (poLineIds.length === 0) {
    return { consumedQty: '0', consumedValueBase: '0', layers: [] }
  }
  // No FOR UPDATE: the consumed (remainingQty < receivedQty) portion of a layer
  // is immutable, and this runs in the same tx immediately before the reversal
  // locks the remaining>0 layers. ORDER BY only gives the metadata layer list a
  // stable order; it does not affect the summed totals.
  const rows = await tx.$queryRaw<ConsumedCostLayerRow[]>`
    SELECT id, "poLineId", "productId", "receivedQty", "remainingQty", "unitCostBase"
    FROM "cost_layers"
    WHERE "poLineId" = ANY(${poLineIds}::text[])
      AND "receivedQty" > "remainingQty"
    ORDER BY "receivedAt" ASC, id ASC
  `
  return summarizeConsumedCostLayers(rows)
}

export function assertPurchaseOrderCancellationHasNoInvoices(invoiceCount: number): void {
  if (invoiceCount > 0) {
    throw new Error('Cannot cancel a purchase order after supplier invoices have been recorded. Create a supplier credit or bill reversal instead.')
  }
}

export function isPurchaseOrderCancellationNoop(status: PurchaseOrderStatus): boolean {
  return status === 'CANCELLED'
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
      data: cogsEntryDataFromConsumed(movement.id, {
        costLayerId: layer.id,
        qty,
        unitCostBase,
      }),
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
