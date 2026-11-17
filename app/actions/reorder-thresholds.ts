'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { applyWarehouseReorderOverrides, describeOverrideConflict, type OverrideConflict, type OverrideRowInput } from '@/lib/domain/inventory/reorder-threshold-overrides'

export type WarehouseReorderThresholdRow = {
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  /** True when an active WMS binding exists. Overrides are allowed there too: they are planning-only. */
  wmsBound: boolean
  reorderPoint: string | null
  safetyStockQty: string | null
  reorderQty: string | null
}

export type WarehouseReorderThresholds = {
  productId: string
  stockUnit: string
  /** The Product values every blank cell inherits. Null = not set on the product. */
  inherited: { reorderPoint: string | null; safetyStockQty: string | null; reorderQty: string | null }
  warehouses: WarehouseReorderThresholdRow[]
}

const text = (value: { toString(): string } | null): string | null => (value == null ? null : value.toString())

export async function getWarehouseReorderThresholds(productId: string): Promise<WarehouseReorderThresholds | null> {
  await requirePermission('inventory')
  const [product, warehouses, levels] = await Promise.all([
    db.product.findUnique({
      where: { id: productId },
      select: { id: true, stockUnit: true, reorderPoint: true, safetyStockQty: true, reorderQty: true },
    }),
    db.warehouse.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, wmsBindings: { where: { active: true }, select: { id: true }, take: 1 } },
      orderBy: { code: 'asc' },
    }),
    db.reorderThresholdOverride.findMany({
      where: { productId },
      select: { warehouseId: true, reorderPoint: true, safetyStockQty: true, reorderQty: true },
    }),
  ])
  if (!product) return null
  const levelByWarehouse = new Map(levels.map((l) => [l.warehouseId, l]))
  return {
    productId: product.id,
    stockUnit: product.stockUnit,
    inherited: {
      reorderPoint: text(product.reorderPoint),
      safetyStockQty: text(product.safetyStockQty),
      reorderQty: text(product.reorderQty),
    },
    warehouses: warehouses.map((w) => {
      const level = levelByWarehouse.get(w.id)
      return {
        warehouseId: w.id,
        warehouseCode: w.code,
        warehouseName: w.name,
        wmsBound: w.wmsBindings.length > 0,
        reorderPoint: text(level?.reorderPoint ?? null),
        safetyStockQty: text(level?.safetyStockQty ?? null),
        reorderQty: text(level?.reorderQty ?? null),
      }
    }),
  }
}

export type SaveWarehouseReorderThresholdsResult =
  | { success: true; changed: number; conflicts: OverrideConflict[]; conflictMessage: string | null }
  | { success: false; error: string; fieldErrors?: Record<string, string> }

export async function saveWarehouseReorderThresholds(
  productId: string,
  rows: OverrideRowInput[],
): Promise<SaveWarehouseReorderThresholdsResult> {
  const session = await requirePermission('inventory.edit')
  const result = await db.$transaction(
    (tx) => applyWarehouseReorderOverrides(tx, { productId, userId: session.user.id ?? null, rows }),
    { maxWait: 5000, timeout: 30000 },
  )
  if (!result.ok) return { success: false, error: result.error, fieldErrors: result.fieldErrors }
  if (result.changes.length > 0) {
    revalidatePath(`/inventory/${productId}`)
    revalidatePath('/analytics/reorder')
  }
  return {
    success: true,
    changed: result.changes.length,
    conflicts: result.conflicts,
    conflictMessage: result.conflicts.length > 0 ? describeOverrideConflict(result.conflicts) : null,
  }
}
