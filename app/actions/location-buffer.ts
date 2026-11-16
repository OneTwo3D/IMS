'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { logActivity } from '@/lib/activity-log'
import { applyLocationBuffers, type BufferRowInput } from '@/lib/domain/inventory/location-buffer'

export type LocationBufferRow = {
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  /** True when the warehouse is flagged to sync stock to the store, i.e. the buffer actually changes what is pushed. */
  syncsToStore: boolean
  onHand: string
  available: string
  bufferQty: string
}

export type LocationBuffers = { productId: string; stockUnit: string; warehouses: LocationBufferRow[] }

export async function getLocationBuffers(productId: string): Promise<LocationBuffers | null> {
  await requirePermission('inventory')
  const [product, warehouses, levels] = await Promise.all([
    db.product.findUnique({ where: { id: productId }, select: { id: true, stockUnit: true } }),
    db.warehouse.findMany({ where: { active: true }, select: { id: true, code: true, name: true, syncToStore: true }, orderBy: { code: 'asc' } }),
    db.stockLevel.findMany({ where: { productId }, select: { warehouseId: true, quantity: true, reservedQty: true, bufferQty: true } }),
  ])
  if (!product) return null
  const levelByWarehouse = new Map(levels.map((l) => [l.warehouseId, l]))
  return {
    productId: product.id,
    stockUnit: product.stockUnit,
    warehouses: warehouses.map((w) => {
      const level = levelByWarehouse.get(w.id)
      return {
        warehouseId: w.id,
        warehouseCode: w.code,
        warehouseName: w.name,
        syncsToStore: w.syncToStore,
        onHand: (level?.quantity ?? 0).toString(),
        available: Math.max(0, Number(level?.quantity ?? 0) - Number(level?.reservedQty ?? 0)).toString(),
        bufferQty: (level?.bufferQty ?? 0).toString(),
      }
    }),
  }
}

export type SaveLocationBuffersResult =
  | { success: true; changed: number }
  | { success: false; error: string; fieldErrors?: Record<string, string> }

export async function saveLocationBuffers(
  productId: string,
  rows: BufferRowInput[],
  reason: string,
): Promise<SaveLocationBuffersResult> {
  const session = await requirePermission('inventory.edit')
  const result = await db.$transaction(
    (tx) => applyLocationBuffers(tx, { productId, userId: session.user.id ?? null, reason, rows }),
    { maxWait: 5000, timeout: 30000 },
  )
  if (!result.ok) return { success: false, error: result.error, fieldErrors: result.fieldErrors }
  if (result.changes.length > 0) {
    revalidatePath(`/inventory/${productId}`)
    // The existing stock-sync enqueue path, after the commit (the same position app/actions/stock.ts uses): a failed enqueue
    // does not undo the saved buffer, it is logged, and the periodic stock sweep pushes the new figure.
    try {
      await enqueueStockSync([productId], 'IMS_CHANGE')
    } catch (syncError) {
      await logActivity({
        entityType: 'PRODUCT',
        entityId: productId,
        action: 'location_buffer_sync_enqueue_failed',
        tag: 'inventory',
        level: 'WARNING',
        description: `A buffer was saved but the stock push could not be queued: ${syncError instanceof Error ? syncError.message : String(syncError)}`,
      })
    }
  }
  return { success: true, changed: result.changes.length }
}
