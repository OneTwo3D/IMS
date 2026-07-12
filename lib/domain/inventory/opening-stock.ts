import type { Prisma } from '@/app/generated/prisma/client'
import { createCostLayer, lockStockLevelRow } from '@/lib/cost-layers'
import { buildStockMovementValueFields } from '@/lib/domain/inventory/stock-movement-value'
import type { AppliedStockAdjustment } from '@/lib/domain/inventory/stock-adjustment-apply'

// Internal, transaction-scoped opening-stock application. Lives in a plain
// (non-'use server') module ON PURPOSE so it is not exposed as a callable server
// action — it takes a Prisma transaction client and must only be invoked from
// within another (authorized) action's transaction, e.g. the openingstock CSV
// importer (see app/actions/import.ts, gated by validateImportFile).

export type ApplyOpeningStockInput = {
  tx: Prisma.TransactionClient
  productId: string
  warehouseId: string
  qty: number
  unitCostBase: number
  note?: string | null
}

export async function applyOpeningStock({
  tx,
  productId,
  warehouseId,
  qty,
  unitCostBase,
  note,
}: ApplyOpeningStockInput): Promise<AppliedStockAdjustment> {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Opening stock quantity must be greater than zero')
  }
  if (!Number.isFinite(unitCostBase) || unitCostBase < 0) {
    throw new Error('Opening stock unit cost must be zero or greater')
  }

  await lockStockLevelRow(tx, productId, warehouseId)
  const existingOpeningLayer = await tx.costLayer.findFirst({
    where: { productId, warehouseId, isOpeningStock: true },
    select: { id: true },
  })
  if (existingOpeningLayer) {
    throw new Error('Opening stock has already been applied for this product and warehouse')
  }

  const movement = await tx.stockMovement.create({
    data: {
      type: 'OPENING_STOCK',
      productId,
      toWarehouseId: warehouseId,
      qty,
      ...buildStockMovementValueFields({ qty, unitCostBase }),
      note: note || null,
    },
  })

  await tx.stockLevel.update({
    where: { productId_warehouseId: { productId, warehouseId } },
    data: {
      quantity: { increment: qty },
    },
  })

  await createCostLayer(tx, {
    productId,
    warehouseId,
    qty,
    unitCostBase,
    receivedAt: movement.createdAt,
    isOpeningStock: true,
    adjustmentMovementId: movement.id,
  })

  const [product, warehouse] = await Promise.all([
    tx.product.findUnique({ where: { id: productId }, select: { sku: true } }),
    tx.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } }),
  ])

  return {
    movementId: movement.id,
    productSku: product?.sku ?? productId,
    warehouseName: warehouse?.name ?? warehouseId,
  }
}
