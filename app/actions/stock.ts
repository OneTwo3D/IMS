'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { getWcCredentials as getConnectorWcCredentials } from '@/lib/connectors/woocommerce/api'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import { enqueueStockSync } from '@/lib/shopping'
import type { Prisma } from '@/app/generated/prisma/client'
import { consumeFifoLayers, createCostLayer, getAverageUnitCost } from '@/lib/cost-layers'

// ---------------------------------------------------------------------------
// Helpers for inventory adjustment accounting journal
// ---------------------------------------------------------------------------

/**
 * Compute a unit cost (GBP) for a product from its FIFO cost layers.
 * Used to value manual stock adjustments (write-offs, shrinkage, stock found)
 * when queuing the accounting journal. Returns the weighted average of
 * remaining layers; falls back to 0 if no layers exist.
 */
async function getProductUnitCost(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const layers = await tx.costLayer.findMany({
    where: { productId, remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCostBase: true },
  })
  let totalQty = 0
  let totalCost = 0
  for (const l of layers) {
    const q = Number(l.remainingQty)
    totalQty += q
    totalCost += q * Number(l.unitCostBase)
  }
  return totalQty > 0 ? totalCost / totalQty : 0
}

/**
 * Build the journal payload for an inventory adjustment.
 *
 *   qty > 0 (stock added, e.g. "stock found"):
 *     DR Inventory / CR reason.accountCode   — the reason account is a gain
 *
 *   qty < 0 (stock removed, e.g. "write-off", "shrinkage"):
 *     DR reason.accountCode / CR Inventory   — the reason account is an expense
 *
 * Returns null when there is nothing to post (no cost, no reason account,
 * or zero quantity).
 */
function buildInventoryAdjustmentJournal(params: {
  reasonAccountCode: string
  inventoryAccountCode: string
  productSku: string
  productName: string
  warehouseCode: string
  warehouseName: string
  qty: number
  unitCost: number
  note: string | null
}): {
  date: string
  reference: string
  narration: string
  lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
} | null {
  const { reasonAccountCode, inventoryAccountCode, productSku, productName, warehouseCode, warehouseName, qty, unitCost, note } = params
  if (qty === 0 || unitCost === 0 || !reasonAccountCode || !inventoryAccountCode) return null

  const totalValue = Math.round(Math.abs(qty) * unitCost * 100) / 100
  if (totalValue === 0) return null

  const date = new Date().toISOString().slice(0, 10)
  const directionLabel = qty > 0 ? 'increase' : 'decrease'
  const reference = `Adj: ${productSku} ${qty > 0 ? '+' : ''}${qty} @ ${warehouseCode}`
  const narration = [
    `Stock ${directionLabel} — ${productName} @ ${warehouseName}`,
    note,
  ].filter(Boolean).join(' — ')
  const description = `${productSku} ${qty > 0 ? '+' : ''}${qty} @ ${warehouseCode}`

  const lines = qty > 0
    ? [
        { accountCode: inventoryAccountCode, description, debit: totalValue },
        { accountCode: reasonAccountCode, description, credit: totalValue },
      ]
    : [
        { accountCode: reasonAccountCode, description, debit: totalValue },
        { accountCode: inventoryAccountCode, description, credit: totalValue },
      ]

  return { date, reference, narration, lines }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdjustmentFormState = {
  errors?: Record<string, string[]>
  message?: string
  success?: boolean
}

export type ApplyStockAdjustmentInput = {
  tx: Prisma.TransactionClient
  productId: string
  warehouseId: string
  qty: number
  reasonId?: string
  note?: string | null
}

export type AppliedStockAdjustment = {
  movementId: string
  productSku: string
  warehouseName: string
}

export async function applyStockAdjustment({
  tx,
  productId,
  warehouseId,
  qty,
  reasonId,
  note,
}: ApplyStockAdjustmentInput): Promise<AppliedStockAdjustment> {
  const isAddition = qty > 0
  const absQty = Math.abs(qty).toString()

  let reasonName: string | null = note || null
  let accountCode: string | null = null

  if (reasonId) {
    const reason = await tx.adjustmentReason.findUnique({
      where: { id: reasonId },
      select: { name: true, accountCode: true },
    })
    if (reason) {
      reasonName = note ? `${reason.name}: ${note}` : reason.name
      accountCode = reason.accountCode
    }
  }

  const movement = await tx.stockMovement.create({
    data: {
      type: 'ADJUSTMENT',
      productId,
      fromWarehouseId: isAddition ? null : warehouseId,
      toWarehouseId: isAddition ? warehouseId : null,
      qty: absQty,
      note: reasonName,
    },
  })

  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: {
      productId,
      warehouseId,
      quantity: isAddition ? absQty : `-${absQty}`,
    },
    update: {
      quantity: {
        increment: qty,
      },
    },
  })

  if (isAddition) {
    const avgCost = await getAverageUnitCost(tx, productId, warehouseId)
    await createCostLayer(tx, {
      productId,
      warehouseId,
      qty: Math.abs(qty),
      unitCostBase: avgCost,
      receivedAt: movement.createdAt,
      isOpeningStock: false,
      adjustmentMovementId: movement.id,
    })
  } else {
    const { consumed } = await consumeFifoLayers(tx, productId, warehouseId, Math.abs(qty))
    if (consumed.length > 0) {
      await tx.cogsEntry.createMany({
        data: consumed.map((entry) => ({
          costLayerId: entry.costLayerId,
          movementId: movement.id,
          qty: entry.qty,
          unitCostBase: entry.unitCostBase,
          totalCostBase: Math.round(entry.qty * entry.unitCostBase * 1000000) / 1000000,
        })),
      })
    }
  }

  const [product, warehouse] = await Promise.all([
    tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } }),
    tx.warehouse.findUnique({ where: { id: warehouseId }, select: { code: true, name: true } }),
  ])

  if (accountCode) {
    const settings = await getAccountingSettings()
    const unitCost = await getProductUnitCost(tx, productId)
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode: accountCode,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: warehouse?.code ?? '',
      warehouseName: warehouse?.name ?? '',
      qty,
      unitCost,
      note: reasonName,
    })
    if (journal) {
      await queueAccountingSync({
        type: 'INVENTORY_ADJUSTMENT',
        referenceType: 'StockMovement',
        referenceId: movement.id,
        payload: journal as unknown as Record<string, unknown>,
      })
    }
  }

  return {
    movementId: movement.id,
    productSku: product?.sku ?? productId,
    warehouseName: warehouse?.name ?? warehouseId,
  }
}

// ---------------------------------------------------------------------------
// Single product adjustment
// ---------------------------------------------------------------------------

const adjustSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  qty: z.string().refine((v) => !isNaN(Number(v)) && Number(v) !== 0, {
    message: 'Quantity must be a non-zero number',
  }),
  reasonId: z.string().optional(),
  note: z.string().optional(),
})

export async function adjustStock(
  _prev: AdjustmentFormState,
  formData: FormData
): Promise<AdjustmentFormState> {
  await requirePermission('stock_control.adjust')
  const parsed = adjustSchema.safeParse({
    productId: formData.get('productId'),
    warehouseId: formData.get('warehouseId'),
    qty: formData.get('qty'),
    reasonId: formData.get('reasonId') || undefined,
    note: formData.get('note') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const { productId, warehouseId, qty, reasonId, note } = parsed.data
  const qtyNum = Number(qty)

  let logSku = ''
  let logWarehouseName = ''

  try {
    await db.$transaction(async (tx) => {
      const applied = await applyStockAdjustment({
        tx,
        productId,
        warehouseId,
        qty: qtyNum,
        reasonId,
        note,
      })
      logSku = applied.productSku
      logWarehouseName = applied.warehouseName
    })

    revalidatePath(`/inventory/${productId}`)
    revalidatePath('/stock-control')
    try {
      await enqueueStockSync([productId], 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: productId,
      action: 'adjusted',
      tag: 'stock',
      description: `Adjusted stock for ${logSku}: ${qtyNum} units at ${logWarehouseName}`,
    })

    return { success: true }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: productId,
      action: 'adjusted',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to save adjustment.',
    })

    return { message: 'Failed to save adjustment. Please try again.' }
  }
}

// ---------------------------------------------------------------------------
// Bulk adjustment (per-line warehouse + reason)
// ---------------------------------------------------------------------------

export type BulkAdjustLine = {
  productId: string
  warehouseId: string
  reasonId: string   // '' = no reason selected
  qty: number
}

export type BulkAdjustFormState = {
  message?: string
  success?: boolean
  count?: number
}

export async function bulkAdjustStock(
  lines: BulkAdjustLine[]
): Promise<BulkAdjustFormState> {
  await requirePermission('stock_control.adjust')
  const valid = lines.filter((l) => l.qty !== 0 && l.productId && l.warehouseId)

  if (valid.length === 0) {
    return { message: 'No adjustments to save.' }
  }

  // Pre-fetch all unique reasons
  const reasonIds = [...new Set(valid.map((l) => l.reasonId).filter(Boolean))]
  const reasons = reasonIds.length
    ? await db.adjustmentReason.findMany({
        where: { id: { in: reasonIds } },
        select: { id: true, name: true, accountCode: true },
      })
    : []
  const reasonMap = new Map(reasons.map((r) => [r.id, r]))

  try {
    await db.$transaction(async (tx) => {
      for (const line of valid) {
        const reason = line.reasonId ? reasonMap.get(line.reasonId) : null
        await applyStockAdjustment({
          tx,
          productId: line.productId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          reasonId: line.reasonId,
          note: reason?.name ?? null,
        })
      }
    })

    revalidatePath('/stock-control')
    revalidatePath('/inventory')
    try {
      await enqueueStockSync(
        [...new Set(valid.map((line) => line.productId))],
        'IMS_CHANGE',
      )
    } catch (syncError) {
      console.error(syncError)
    }

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action: 'bulk_adjusted',
      tag: 'stock',
      description: `Bulk adjusted stock for ${valid.length} products`,
    })

    return { success: true, count: valid.length }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action: 'bulk_adjusted',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to save adjustments.',
    })

    return { message: 'Failed to save adjustments. Please try again.' }
  }
}

// ---------------------------------------------------------------------------
// Adjustment history
// ---------------------------------------------------------------------------

export type AdjustmentMovementRow = {
  id: string
  productId: string
  productSku: string
  productName: string
  imageUrl: string | null
  warehouseId: string
  warehouseName: string
  warehouseCode: string
  signedQty: number   // positive = addition, negative = removal
  note: string | null
  createdAt: string   // ISO string
}

export async function getAdjustmentHistory(limit = 200): Promise<AdjustmentMovementRow[]> {
  await requireAuth()
  const rows = await db.stockMovement.findMany({
    where: { type: 'ADJUSTMENT' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      productId: true,
      fromWarehouseId: true,
      toWarehouseId: true,
      qty: true,
      note: true,
      createdAt: true,
      product: { select: { sku: true, name: true, imageUrl: true, parent: { select: { imageUrl: true } } } },
      fromWarehouse: { select: { id: true, code: true, name: true } },
      toWarehouse: { select: { id: true, code: true, name: true } },
    },
  })

  return rows.map((r) => {
    const isAddition = r.toWarehouseId !== null
    const warehouse = isAddition ? r.toWarehouse : r.fromWarehouse
    return {
      id: r.id,
      productId: r.productId,
      productSku: r.product.sku,
      productName: r.product.name,
      imageUrl: r.product.imageUrl ?? r.product.parent?.imageUrl ?? null,
      warehouseId: warehouse?.id ?? '',
      warehouseName: warehouse?.name ?? '',
      warehouseCode: warehouse?.code ?? '',
      signedQty: isAddition ? Number(r.qty) : -Number(r.qty),
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }
  })
}

export type UpdateAdjustmentResult = {
  success?: boolean
  message?: string
}

export async function updateAdjustmentMovement(
  id: string,
  newSignedQty: number,
  newNote: string | null
): Promise<UpdateAdjustmentResult> {
  await requirePermission('stock_control.adjust')
  if (newSignedQty === 0) {
    return { message: 'Quantity must be non-zero.' }
  }

  let oldSignedQtyForLog = 0

  try {
    await db.$transaction(async (tx) => {
      const movement = await tx.stockMovement.findUnique({
        where: { id },
        select: {
          id: true,
          productId: true,
          fromWarehouseId: true,
          toWarehouseId: true,
          qty: true,
          createdAt: true,
          cogsEntries: {
            select: { id: true, costLayerId: true, qty: true },
          },
          adjustmentLayers: {
            select: { id: true, receivedQty: true, remainingQty: true },
          },
        },
      })
      if (!movement) throw new Error('Movement not found')

      const oldIsAddition = movement.toWarehouseId !== null
      const oldWarehouseId = (oldIsAddition ? movement.toWarehouseId : movement.fromWarehouseId)!
      const oldSignedQty = oldIsAddition ? Number(movement.qty) : -Number(movement.qty)
      oldSignedQtyForLog = oldSignedQty

      const newIsAddition = newSignedQty > 0
      const newAbsQty = Math.abs(newSignedQty).toString()
      if (newSignedQty === oldSignedQty) {
        await tx.stockMovement.update({
          where: { id },
          data: { note: newNote || null },
        })
        return
      }

      const laterMovementCount = await tx.stockMovement.count({
        where: {
          id: { not: id },
          productId: movement.productId,
          createdAt: { gt: movement.createdAt },
          OR: [
            { fromWarehouseId: oldWarehouseId },
            { toWarehouseId: oldWarehouseId },
          ],
        },
      })
      if (laterMovementCount > 0) {
        throw new Error(
          'This adjustment has later stock movements for the same product and warehouse. ' +
          'Create a reversing adjustment instead of editing it in place.',
        )
      }

      // Reverse old stock delta
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: movement.productId, warehouseId: oldWarehouseId } },
        create: { productId: movement.productId, warehouseId: oldWarehouseId, quantity: '0' },
        update: { quantity: { decrement: oldSignedQty } },
      })

      if (oldIsAddition) {
        const layer = movement.adjustmentLayers[0]
        if (!layer) {
          throw new Error(
            'This adjustment does not have tracked cost-layer history. ' +
            'Create a reversing adjustment instead of editing it in place.',
          )
        }
        const consumedQty = Number(layer.receivedQty) - Number(layer.remainingQty)
        if (consumedQty > 0.000001) {
          throw new Error(
            'This adjustment layer has already been consumed. ' +
            'Create a reversing adjustment instead of editing it in place.',
          )
        }
        await tx.costLayer.deleteMany({ where: { adjustmentMovementId: id } })
      } else {
        if (movement.cogsEntries.length === 0) {
          throw new Error(
            'This adjustment was created before FIFO edit tracking was enabled. ' +
            'Create a reversing adjustment instead of editing it in place.',
          )
        }
        for (const entry of movement.cogsEntries) {
          await tx.costLayer.update({
            where: { id: entry.costLayerId },
            data: { remainingQty: { increment: Number(entry.qty) } },
          })
        }
        await tx.cogsEntry.deleteMany({ where: { movementId: id } })
      }

      // Apply new stock delta
      const newWarehouseId = oldWarehouseId // warehouse can't be changed via edit
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: movement.productId, warehouseId: newWarehouseId } },
        create: { productId: movement.productId, warehouseId: newWarehouseId, quantity: newIsAddition ? newAbsQty : `-${newAbsQty}` },
        update: { quantity: { increment: newSignedQty } },
      })

      if (newIsAddition) {
        const avgCost = await getAverageUnitCost(tx, movement.productId, newWarehouseId)
        await createCostLayer(tx, {
          productId: movement.productId,
          warehouseId: newWarehouseId,
          qty: Math.abs(newSignedQty),
          unitCostBase: avgCost,
          receivedAt: movement.createdAt,
          isOpeningStock: false,
          adjustmentMovementId: id,
        })
      } else {
        const { consumed } = await consumeFifoLayers(tx, movement.productId, newWarehouseId, Math.abs(newSignedQty))
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => ({
              costLayerId: entry.costLayerId,
              movementId: id,
              qty: entry.qty,
              unitCostBase: entry.unitCostBase,
              totalCostBase: Math.round(entry.qty * entry.unitCostBase * 1000000) / 1000000,
            })),
          })
        }
      }

      // Update movement record
      await tx.stockMovement.update({
        where: { id },
        data: {
          fromWarehouseId: newIsAddition ? null : oldWarehouseId,
          toWarehouseId: newIsAddition ? oldWarehouseId : null,
          qty: newAbsQty,
          note: newNote || null,
        },
      })
    })

    revalidatePath('/stock-control')
    revalidatePath('/inventory')
    try {
      const movement = await db.stockMovement.findUnique({
        where: { id },
        select: { productId: true },
      })
      if (movement?.productId) {
        await enqueueStockSync([movement.productId], 'IMS_CHANGE')
      }
    } catch (syncError) {
      console.error(syncError)
    }

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'adjustment_updated',
      tag: 'stock',
      description: `Updated stock adjustment: qty changed from ${oldSignedQtyForLog} to ${newSignedQty}`,
    })

    return { success: true }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'adjustment_updated',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to update adjustment.',
    })

    return { message: 'Failed to update adjustment.' }
  }
}

// ---------------------------------------------------------------------------
// WooCommerce image import
// ---------------------------------------------------------------------------

export async function fetchWcImage(
  sku: string
): Promise<{ imageUrl: string | null; error?: string }> {
  try {
    await requirePermission('stock_control.adjust')
    const credentials = await getConnectorWcCredentials()
    if (!credentials) {
      return { imageUrl: null, error: 'WooCommerce not configured in Settings' }
    }
    const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64')
    const endpoint = `${credentials.url}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`

    const res = await fetch(endpoint, {
      headers: { Authorization: `Basic ${auth}` },
      cache: 'no-store',
    })

    if (!res.ok) {
      return { imageUrl: null, error: `WooCommerce API error: ${res.status}` }
    }

    const data = await res.json()
    const product = Array.isArray(data) ? data[0] : data
    if (!product) return { imageUrl: null, error: `No WooCommerce product found for SKU "${sku}"` }
    const imageUrl = product.images?.[0]?.src ?? product.image?.src ?? null

    return { imageUrl }
  } catch {
    return { imageUrl: null, error: 'Failed to fetch from WooCommerce' }
  }
}

// WC product URL lookup: see lib/connectors/woocommerce/products.ts

// ---------------------------------------------------------------------------
// List warehouses (for forms)
// ---------------------------------------------------------------------------

export async function getWarehouses() {
  await requireAuth()
  return db.warehouse.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, type: true, country: true, contactName: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, postcode: true },
    orderBy: { code: 'asc' },
  })
}

// ---------------------------------------------------------------------------
// Stock level map (productId → warehouseId → quantity)
// ---------------------------------------------------------------------------

export type StockLevelEntry = { total: number; available: number }

export async function getStockLevelMap(): Promise<Record<string, Record<string, StockLevelEntry>>> {
  await requireAuth()
  const levels = await db.stockLevel.findMany({
    select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
  })
  const map: Record<string, Record<string, StockLevelEntry>> = {}
  for (const l of levels) {
    if (!map[l.productId]) map[l.productId] = {}
    const total = Number(l.quantity)
    const reserved = Number(l.reservedQty)
    map[l.productId][l.warehouseId] = { total, available: total - reserved }
  }
  return map
}

/** Avg COGS per product from FIFO cost layers (weighted avg of remaining stock) */
export async function getAvgCogsMap(): Promise<Record<string, number>> {
  await requireAuth()
  const layers = await db.costLayer.findMany({
    where: { remainingQty: { gt: 0 } },
    select: { productId: true, remainingQty: true, unitCostBase: true },
  })
  const totals: Record<string, { cost: number; qty: number }> = {}
  for (const l of layers) {
    const qty = Number(l.remainingQty)
    const cost = Number(l.unitCostBase)
    if (!totals[l.productId]) totals[l.productId] = { cost: 0, qty: 0 }
    totals[l.productId].cost += qty * cost
    totals[l.productId].qty += qty
  }
  const result: Record<string, number> = {}
  for (const [pid, t] of Object.entries(totals)) {
    result[pid] = t.qty > 0 ? t.cost / t.qty : 0
  }
  return result
}

// ---------------------------------------------------------------------------
// List active adjustment reasons (for forms)
// ---------------------------------------------------------------------------

export type AdjustmentReasonOption = {
  id: string
  name: string
  accountCode: string | null
}

export async function getActiveAdjustmentReasons(): Promise<AdjustmentReasonOption[]> {
  await requireAuth()
  return db.adjustmentReason.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, accountCode: true },
  })
}

// ---------------------------------------------------------------------------
// Product stock flow (all movement types for a single product)
// ---------------------------------------------------------------------------

export type StockFlowRow = {
  id: string
  type: string
  fromWarehouse: string | null
  toWarehouse: string | null
  signedQty: number
  note: string | null
  referenceType: string | null
  referenceId: string | null
  createdAt: string
}

export type StockFlowFilters = {
  types?: string[]
  dateFrom?: string
  dateTo?: string
}

const INBOUND_TYPES = new Set([
  'PURCHASE_RECEIPT',
  'RETURN_INBOUND',
  'TRANSFER_IN',
  'PRODUCTION_IN',
  'KIT_ASSEMBLY_IN',
  'OPENING_STOCK',
])

export async function getProductStockFlow(
  productId: string,
  filters?: StockFlowFilters,
  limit = 500
): Promise<StockFlowRow[]> {
  await requireAuth()

  const where: Prisma.StockMovementWhereInput = { productId, referenceType: { notIn: ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] } }
  if (filters?.types?.length) {
    where.type = { in: filters.types as Prisma.StockMovementWhereInput['type'] extends { in?: infer U } ? U : never } as never
  }
  if (filters?.dateFrom || filters?.dateTo) {
    where.createdAt = {}
    if (filters.dateFrom) (where.createdAt as Record<string, unknown>).gte = new Date(filters.dateFrom)
    if (filters.dateTo) (where.createdAt as Record<string, unknown>).lte = new Date(filters.dateTo + 'T23:59:59.999Z')
  }

  const rows = await db.stockMovement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      fromWarehouseId: true,
      toWarehouseId: true,
      qty: true,
      note: true,
      referenceType: true,
      referenceId: true,
      createdAt: true,
      fromWarehouse: { select: { code: true } },
      toWarehouse: { select: { code: true } },
    },
  })

  return rows.map((r) => {
    let isInbound: boolean
    if (r.type === 'ADJUSTMENT') {
      isInbound = r.toWarehouseId !== null
    } else {
      isInbound = INBOUND_TYPES.has(r.type)
    }

    return {
      id: r.id,
      type: r.type,
      fromWarehouse: r.fromWarehouse?.code ?? null,
      toWarehouse: r.toWarehouse?.code ?? null,
      signedQty: isInbound ? Number(r.qty) : -Number(r.qty),
      note: r.note,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      createdAt: r.createdAt.toISOString(),
    }
  })
}
