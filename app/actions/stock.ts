'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import type { Prisma } from '@/app/generated/prisma/client'

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
    select: { remainingQty: true, unitCostGbp: true },
  })
  let totalQty = 0
  let totalCost = 0
  for (const l of layers) {
    const q = Number(l.remainingQty)
    totalQty += q
    totalCost += q * Number(l.unitCostGbp)
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
  const isAddition = qtyNum > 0
  const absQty = Math.abs(qtyNum).toString()

  let logSku = ''
  let logWarehouseName = ''

  try {
    await db.$transaction(async (tx) => {
      // Look up reason (name + optional accounting account code)
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

      // Create stock movement
      await tx.stockMovement.create({
        data: {
          type: 'ADJUSTMENT',
          productId,
          fromWarehouseId: isAddition ? null : warehouseId,
          toWarehouseId: isAddition ? warehouseId : null,
          qty: absQty,
          note: reasonName,
        },
      })

      // Upsert stock level
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId, warehouseId } },
        create: {
          productId,
          warehouseId,
          quantity: isAddition ? absQty : `-${absQty}`,
        },
        update: {
          quantity: {
            increment: qtyNum,
          },
        },
      })

      // Capture info for activity log
      const logProduct = await tx.product.findUnique({ where: { id: productId }, select: { sku: true } })
      const logWarehouse = await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } })
      logSku = logProduct?.sku ?? productId
      logWarehouseName = logWarehouse?.name ?? warehouseId

      // Queue accounting sync — ONLY if the reason has an account code assigned.
      // The reason (configured in Settings → Inventory → Stock Adjustment Reasons)
      // is the single source of truth for the counter-account. There is no global
      // fallback: an adjustment with no reason account simply posts no journal.
      if (accountCode) {
        const settings = await getAccountingSettings()
        const [product, warehouse, unitCost] = await Promise.all([
          tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } }),
          tx.warehouse.findUnique({ where: { id: warehouseId }, select: { code: true, name: true } }),
          getProductUnitCost(tx, productId),
        ])
        const journal = buildInventoryAdjustmentJournal({
          reasonAccountCode: accountCode,
          inventoryAccountCode: settings.inventoryAccount,
          productSku: product?.sku ?? productId,
          productName: product?.name ?? '',
          warehouseCode: warehouse?.code ?? '',
          warehouseName: warehouse?.name ?? '',
          qty: qtyNum,
          unitCost,
          note: reasonName,
        })
        if (journal) {
          await queueAccountingSync({
            type: 'INVENTORY_ADJUSTMENT',
            referenceType: 'StockMovement',
            referenceId: productId,
            payload: journal as unknown as Record<string, unknown>,
          })
        }
      }
    })

    revalidatePath(`/inventory/${productId}`)
    revalidatePath('/stock-control')

    logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: productId,
      action: 'adjusted',
      tag: 'stock',
      description: `Adjusted stock for ${logSku}: ${qtyNum} units at ${logWarehouseName}`,
    })

    return { success: true }
  } catch (e) {
    console.error(e)

    logActivity({
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
    // Resolve the inventory account once — same value for every line.
    const settings = await getAccountingSettings()

    await db.$transaction(async (tx) => {
      for (const line of valid) {
        const { productId, warehouseId, reasonId, qty } = line
        const isAddition = qty > 0
        const absQty = Math.abs(qty).toString()

        const reason = reasonId ? reasonMap.get(reasonId) : null
        const note = reason?.name ?? null

        await tx.stockMovement.create({
          data: {
            type: 'ADJUSTMENT',
            productId,
            fromWarehouseId: isAddition ? null : warehouseId,
            toWarehouseId: isAddition ? warehouseId : null,
            qty: absQty,
            note,
          },
        })

        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId, warehouseId } },
          create: { productId, warehouseId, quantity: isAddition ? absQty : `-${absQty}` },
          update: { quantity: { increment: qty } },
        })

        // Accounting sync: only queue when the reason has an account code.
        // Reason accounts are configured in Settings → Inventory → Stock
        // Adjustment Reasons and are the single source of truth.
        const reasonAccountCode = reason?.accountCode ?? null
        if (reasonAccountCode) {
          const [product, warehouse, unitCost] = await Promise.all([
            tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } }),
            tx.warehouse.findUnique({ where: { id: warehouseId }, select: { code: true, name: true } }),
            getProductUnitCost(tx, productId),
          ])
          const journal = buildInventoryAdjustmentJournal({
            reasonAccountCode,
            inventoryAccountCode: settings.inventoryAccount,
            productSku: product?.sku ?? productId,
            productName: product?.name ?? '',
            warehouseCode: warehouse?.code ?? '',
            warehouseName: warehouse?.name ?? '',
            qty,
            unitCost,
            note,
          })
          if (journal) {
            await queueAccountingSync({
              type: 'INVENTORY_ADJUSTMENT',
              referenceType: 'StockMovement',
              referenceId: productId,
              payload: journal as unknown as Record<string, unknown>,
            })
          }
        }
      }
    })

    revalidatePath('/stock-control')
    revalidatePath('/inventory')

    logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action: 'bulk_adjusted',
      tag: 'stock',
      description: `Bulk adjusted stock for ${valid.length} products`,
    })

    return { success: true, count: valid.length }
  } catch (e) {
    console.error(e)

    logActivity({
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
      product: { select: { sku: true, name: true, imageUrl: true } },
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
      imageUrl: r.product.imageUrl,
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
        select: { id: true, productId: true, fromWarehouseId: true, toWarehouseId: true, qty: true },
      })
      if (!movement) throw new Error('Movement not found')

      const oldIsAddition = movement.toWarehouseId !== null
      const oldWarehouseId = (oldIsAddition ? movement.toWarehouseId : movement.fromWarehouseId)!
      const oldSignedQty = oldIsAddition ? Number(movement.qty) : -Number(movement.qty)
      oldSignedQtyForLog = oldSignedQty

      const newIsAddition = newSignedQty > 0
      const newAbsQty = Math.abs(newSignedQty).toString()

      // Reverse old stock delta
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: movement.productId, warehouseId: oldWarehouseId } },
        create: { productId: movement.productId, warehouseId: oldWarehouseId, quantity: '0' },
        update: { quantity: { decrement: oldSignedQty } },
      })

      // Apply new stock delta
      const newWarehouseId = oldWarehouseId // warehouse can't be changed via edit
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: movement.productId, warehouseId: newWarehouseId } },
        create: { productId: movement.productId, warehouseId: newWarehouseId, quantity: newIsAddition ? newAbsQty : `-${newAbsQty}` },
        update: { quantity: { increment: newSignedQty } },
      })

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

    logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'adjustment_updated',
      tag: 'stock',
      description: `Updated stock adjustment: qty changed from ${oldSignedQtyForLog} to ${newSignedQty}`,
    })

    return { success: true }
  } catch (e) {
    console.error(e)

    logActivity({
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
    const urlSetting = await db.setting.findUnique({ where: { key: 'wc_url' } })
    const keySetting = await db.setting.findUnique({ where: { key: 'wc_consumer_key' } })
    const secretSetting = await db.setting.findUnique({ where: { key: 'wc_consumer_secret' } })

    if (!urlSetting || !keySetting || !secretSetting) {
      return { imageUrl: null, error: 'WooCommerce not configured in Settings' }
    }

    const wcUrl = JSON.parse(urlSetting.value)
    const key = JSON.parse(keySetting.value)
    const secret = JSON.parse(secretSetting.value)
    const auth = Buffer.from(`${key}:${secret}`).toString('base64')

    const endpoint = `${wcUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`

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
  } catch (e) {
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
    select: { id: true, code: true, name: true, type: true, country: true },
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
    select: { productId: true, remainingQty: true, unitCostGbp: true },
  })
  const totals: Record<string, { cost: number; qty: number }> = {}
  for (const l of layers) {
    const qty = Number(l.remainingQty)
    const cost = Number(l.unitCostGbp)
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
