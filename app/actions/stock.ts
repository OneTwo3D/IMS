'use server'

import { revalidatePath } from 'next/cache'
import { cache } from 'react'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { wcFetch } from '@/lib/connectors/woocommerce/api'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import { enqueueStockSync } from '@/lib/shopping'
import { allocateBackordersForProducts } from '@/lib/fulfillment/backorder-allocator'
import { releaseOverallocations } from '@/lib/fulfillment/overallocation-rebalancer'
import type { Prisma } from '@/app/generated/prisma/client'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict, createCostLayer, getAverageUnitCost, getHistoricalAverageUnitCost, lockStockLevelRow } from '@/lib/cost-layers'
import { decimalToNumber } from '@/lib/decimal'
import {
  buildStockLevelMap,
  isEmptyStockLevelMapScope,
  normalizeStockLevelMapScope,
  type StockLevelMap,
  type StockLevelMapScope,
} from '@/lib/domain/inventory/stock-level-map'
import { toInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import { calculateAdjustmentStockDelta, assertAdjustmentEditFifoFeasible, assertStockAdjustmentFeasible } from '@/lib/domain/inventory/stock-adjustment-edit'
import { addMoney, toDecimal } from '@/lib/domain/math/decimal'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
} from '@/lib/domain/inventory/stock-movement-value'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

// cv67: post-commit side effects (backorder allocation, over-allocation release,
// WooCommerce stock-sync enqueue) run best-effort AFTER the adjustment commits, so
// a failure can't roll the adjustment back. Previously these were swallowed with
// console.error only — invisible to operators, so a failed enqueue silently drifted
// store stock. Surface them to the activity log (WARNING) so they're auditable and
// the operator can re-sync. Never throws (the adjustment already committed).
async function logStockSideEffectFailure(action: string, error: unknown): Promise<void> {
  console.error(error)
  try {
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action,
      tag: 'sync',
      level: 'WARNING',
      description: `Post-commit ${action} failed; stock/orders may need re-sync: ${error instanceof Error ? error.message : String(error)}`,
    })
  } catch (logError) {
    console.error(logError)
  }
}

// ---------------------------------------------------------------------------
// Helpers for inventory adjustment accounting journal
// ---------------------------------------------------------------------------


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
  /**
   * The base-currency value the movement actually booked (cbxu): for an addition,
   * qty × the layer unit cost; for a removal, the FIFO cost of the layers consumed.
   * The journal credits/debits Inventory by ROUND(this, 2) so Inventory GL ties to
   * the cost-layer reduction, not a product-wide blended average.
   */
  totalValueBase: number
  note: string | null
}): {
  date: string
  reference: string
  narration: string
  lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>
} | null {
  const { reasonAccountCode, inventoryAccountCode, productSku, productName, warehouseCode, warehouseName, qty, totalValueBase, note } = params
  if (qty === 0 || totalValueBase === 0 || !reasonAccountCode || !inventoryAccountCode) return null

  const totalValue = Math.round(Math.abs(totalValueBase) * 100) / 100
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
  /**
   * Explicit base-currency unit cost for a positive adjustment. When omitted, the
   * cost basis is derived (warehouse average → product historical average). If no
   * basis can be derived (brand-new product, no cost layers anywhere) an explicit
   * cost is REQUIRED — otherwise the addition would silently book £0 stock and
   * later sell at zero COGS (cogs-audit scjz.2). Pass 0 only for genuinely
   * zero-cost stock (samples/consigned).
   */
  unitCostBase?: number | null
  /**
   * 8biu: pre-fetched accounting settings. Pass this from a bulk loop so
   * getAccountingSettings() is read once for the whole batch instead of per line.
   * Omit for single adjustments (fetched on demand only when a reason has an
   * account code).
   */
  settings?: Awaited<ReturnType<typeof getAccountingSettings>>
  /**
   * Optional provenance for the ADJUSTMENT stock movement. Used by stocktake
   * (om9w) to tie variance movements to their count (referenceType 'StockCount',
   * referenceId = count id) so the stock-count report can attribute them.
   */
  referenceType?: string
  referenceId?: string
}

export type AppliedStockAdjustment = {
  movementId: string
  productSku: string
  warehouseName: string
}

export type ApplyOpeningStockInput = {
  tx: Prisma.TransactionClient
  productId: string
  warehouseId: string
  qty: number
  unitCostBase: number
  note?: string | null
}

export async function applyStockAdjustment({
  tx,
  productId,
  warehouseId,
  qty,
  reasonId,
  note,
  unitCostBase,
  settings: providedSettings,
  referenceType,
  referenceId,
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

  const locked = await lockStockLevelRow(tx, productId, warehouseId)

  // ig58: pre-flight availability check against the locked row, before any
  // movement/cost-layer/upsert is written. Rejects an infeasible removal (one
  // that would drive on-hand below the reserved quantity, which includes going
  // negative) with a clear message instead of letting the DB non-negative CHECK
  // abort opaquely — and so the upsert create branch never builds a negative.
  assertStockAdjustmentFeasible({
    signedQty: qty,
    currentQuantity: locked.quantity,
    currentReservedQty: locked.reservedQty,
  })

  let additionUnitCost: number | null = null
  let removalCostBase: number | null = null
  if (isAddition) {
    if (unitCostBase != null && Number.isFinite(unitCostBase) && unitCostBase >= 0) {
      // Operator/caller supplied an explicit cost (0 allowed for sample/consigned stock).
      additionUnitCost = unitCostBase
    } else {
      const warehouseAvgCost = await getAverageUnitCost(tx, productId, warehouseId)
      additionUnitCost = warehouseAvgCost > 0 ? warehouseAvgCost : await getHistoricalAverageUnitCost(tx, productId)
      if (!(additionUnitCost > 0)) {
        // No cost basis anywhere for this product. Booking the layer at £0 would
        // create real on-hand stock valued at £0 and later sell it at zero COGS
        // (cogs-audit scjz.2). Require an explicit unit cost instead.
        throw new Error(
          'Enter a unit cost for this stock addition — no cost basis could be derived (the product has no existing cost layers). Use 0 only for genuinely zero-cost stock such as samples.',
        )
      }
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
      ...(referenceType ? { referenceType } : {}),
      ...(referenceId ? { referenceId } : {}),
      ...(isAddition ? buildStockMovementValueFields({ qty: absQty, unitCostBase: additionUnitCost ?? 0 }) : {}),
    },
  })

  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    // lockStockLevelRow already upserted the row, so the create branch is
    // effectively unreachable; keep it non-negative (a removal that reached it
    // would mean a zero on-hand row, already rejected by the guard above).
    create: {
      productId,
      warehouseId,
      quantity: isAddition ? absQty : '0',
    },
    update: {
      quantity: {
        increment: qty,
      },
    },
  })

  if (isAddition) {
    await createCostLayer(tx, {
      productId,
      warehouseId,
      qty: Math.abs(qty),
      unitCostBase: additionUnitCost ?? 0,
      receivedAt: movement.createdAt,
      isOpeningStock: false,
      adjustmentMovementId: movement.id,
    })
  } else {
    const { consumed } = await consumeFifoLayersStrict(tx, productId, warehouseId, Math.abs(qty))
    // cbxu (Codex): value the GL journal at the SAME totalValueBase the movement
    // actually stores — derived from the consumed layers at the movement's row qty
    // (constraint-consistent) — rather than the raw FIFO sum, which can differ by a
    // cent at scale and drift the GL from the movement ledger. Ties Inventory GL to
    // the cost-layer reduction, not a product-wide blended average.
    const valueFields = buildStockMovementValueFieldsFromConsumed(consumed, absQty)
    removalCostBase = Number(valueFields.totalValueBase)
    await tx.stockMovement.update({
      where: { id: movement.id },
      data: valueFields,
    })
    if (consumed.length > 0) {
      await tx.cogsEntry.createMany({
        data: consumed.map((entry) => cogsEntryDataFromConsumed(movement.id, entry)),
      })
    }
  }

  const [product, warehouse] = await Promise.all([
    tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } }),
    tx.warehouse.findUnique({ where: { id: warehouseId }, select: { code: true, name: true } }),
  ])

  if (accountCode) {
    const settings = providedSettings ?? await getAccountingSettings()
    // Value the GL journal at the value the movement/cost-layer actually booked so
    // Inventory GL ties to the cost-layer change, not a blended product-wide
    // average: additions use qty × the booked layer unit cost (scjz.2); removals
    // use the FIFO cost of the layers consumed (cbxu — the prior product-average
    // basis mis-stated both COGS and inventory, especially across warehouses).
    const totalValueBase = isAddition
      ? Math.abs(qty) * (additionUnitCost ?? 0)
      : (removalCostBase ?? 0)
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode: accountCode,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: warehouse?.code ?? '',
      warehouseName: warehouse?.name ?? '',
      qty,
      totalValueBase,
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
  unitCostBase: z.string().optional().refine(
    (v) => v == null || v === '' || (!isNaN(Number(v)) && Number(v) >= 0),
    { message: 'Unit cost must be zero or greater' },
  ),
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
    unitCostBase: formData.get('unitCostBase') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const { productId, warehouseId, qty, reasonId, note, unitCostBase } = parsed.data
  const unitCostBaseNum = unitCostBase != null && unitCostBase !== '' ? Number(unitCostBase) : undefined
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
        unitCostBase: unitCostBaseNum,
      })
      logSku = applied.productSku
      logWarehouseName = applied.warehouseName
    }, STOCK_TX_OPTIONS)

    revalidatePath(`/inventory/${productId}`)
    revalidatePath('/stock-control')

    if (qtyNum > 0) {
      try {
        await allocateBackordersForProducts([productId], {
          source: 'stock_adjustment',
          referenceId: productId,
          referenceLabel: `stock adjustment (+${qtyNum}) at ${logWarehouseName}`,
        })
      } catch (allocError) {
        await logStockSideEffectFailure('backorder_allocation', allocError)
      }
    } else if (qtyNum < 0) {
      try {
        await releaseOverallocations(
          [{ productId, warehouseId }],
          { source: 'stock_adjustment', referenceId: productId, referenceLabel: `stock adjustment (${qtyNum}) at ${logWarehouseName}` },
        )
      } catch (rebalanceError) {
        await logStockSideEffectFailure('overallocation_release', rebalanceError)
      }
    }

    try {
      await enqueueStockSync([productId], 'IMS_CHANGE')
    } catch (syncError) {
      await logStockSideEffectFailure('stock_sync_enqueue', syncError)
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
    const message = toInventoryConstraintMessage(e, 'Failed to save adjustment. Please try again.')
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: productId,
      action: 'adjusted',
      tag: 'stock',
      level: 'ERROR',
      description: message,
    })

    return { message }
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
  // Optional explicit base-currency unit cost for a positive line. Required (per
  // cogs-audit scjz.2) when the product has no derivable cost basis, otherwise the
  // line throws rather than booking £0 stock. Omit to use the derived average.
  unitCostBase?: number | null
}

export type BulkAdjustFormState = {
  message?: string
  success?: boolean
  count?: number
}

// rfdl: schema for a bulk-adjust line. qty must be finite (0 lines are filtered
// out, not rejected, to match the prior lenient behaviour); unitCostBase, when
// present, must be a finite number >= 0 (or null for the derived average).
const bulkAdjustLineSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  warehouseId: z.string().min(1, 'warehouseId is required'),
  reasonId: z.string(),
  qty: z.number().refine(Number.isFinite, 'qty must be a finite number'),
  unitCostBase: z
    .number()
    .refine(Number.isFinite, 'unitCostBase must be a finite number')
    .nonnegative('unitCostBase must be zero or greater')
    .nullable()
    .optional(),
})

export async function bulkAdjustStock(
  lines: BulkAdjustLine[]
): Promise<BulkAdjustFormState> {
  await requirePermission('stock_control.adjust')

  // rfdl: validate every line (parity with single adjustStock). Reject non-finite
  // qty, negative unitCostBase, and missing/non-string ids before any write.
  const parsed = z.array(bulkAdjustLineSchema).safeParse(lines)
  if (!parsed.success) {
    return { message: parsed.error.issues[0]?.message ?? 'Invalid bulk adjustment line.' }
  }
  const valid = parsed.data.filter((l) => l.qty !== 0 && l.productId && l.warehouseId)

  if (valid.length === 0) {
    return { message: 'No adjustments to save.' }
  }

  // Pre-fetch all unique reasons + accounting settings ONCE for the whole batch
  // (8biu: avoid a per-line getAccountingSettings() inside the transaction loop).
  const reasonIds = [...new Set(valid.map((l) => l.reasonId).filter(Boolean))]
  const [reasons, accountingSettings] = await Promise.all([
    reasonIds.length
      ? db.adjustmentReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, name: true, accountCode: true },
        })
      : Promise.resolve([]),
    getAccountingSettings(),
  ])
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
          unitCostBase: line.unitCostBase,
          settings: accountingSettings,
        })
      }
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control')
    revalidatePath('/inventory')

    const positiveProductIds = [...new Set(valid.filter((l) => l.qty > 0).map((l) => l.productId))]
    const negativePairs = valid
      .filter((l) => l.qty < 0)
      .map((l) => ({ productId: l.productId, warehouseId: l.warehouseId }))

    // Release BEFORE allocate: when a bulk adjustment both removes stock
    // from one warehouse and adds it to another for the same SKU, the
    // old reservation must be freed first. Otherwise a newer backorder
    // could consume the newly-added stock while the older fully-allocated
    // order still looks covered — violating oldest-first allocation.
    if (negativePairs.length > 0) {
      try {
        await releaseOverallocations(negativePairs, {
          source: 'stock_adjustment',
          referenceLabel: `bulk stock adjustment (${valid.length} lines)`,
        })
      } catch (rebalanceError) {
        await logStockSideEffectFailure('overallocation_release', rebalanceError)
      }
    }
    if (positiveProductIds.length > 0) {
      try {
        await allocateBackordersForProducts(positiveProductIds, {
          source: 'stock_adjustment',
          referenceLabel: `bulk stock adjustment (${valid.length} lines)`,
        })
      } catch (allocError) {
        await logStockSideEffectFailure('backorder_allocation', allocError)
      }
    }

    try {
      await enqueueStockSync(
        [...new Set(valid.map((line) => line.productId))],
        'IMS_CHANGE',
      )
    } catch (syncError) {
      await logStockSideEffectFailure('stock_sync_enqueue', syncError)
    }

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action: 'bulk_adjusted',
      tag: 'stock',
      description: `Bulk adjusted stock for ${valid.length} products`,
      // 27f9: record per-line detail so a bulk adjustment is auditable line-by-line
      // (which product/warehouse/qty), not just an opaque "N products" summary.
      metadata: {
        lineCount: valid.length,
        lines: valid.map((l) => ({ productId: l.productId, warehouseId: l.warehouseId, qty: l.qty, reasonId: l.reasonId || null })),
      },
    })

    return { success: true, count: valid.length }
  } catch (e) {
    const message = toInventoryConstraintMessage(e, 'Failed to save adjustments. Please try again.')
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      action: 'bulk_adjusted',
      tag: 'stock',
      level: 'ERROR',
      description: message,
    })

    return { message }
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
            select: { id: true, receivedQty: true, remainingQty: true, unitCostBase: true },
          },
        },
      })
      if (!movement) throw new Error('Movement not found')

      const oldIsAddition = movement.toWarehouseId !== null
      const oldWarehouseId = (oldIsAddition ? movement.toWarehouseId : movement.fromWarehouseId)!
      const oldQty = decimalToNumber(movement.qty)
      const oldSignedQty = oldIsAddition ? oldQty : -oldQty
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

      // ycnj: an in-place edit re-books qty/cost layers/COGS but cannot revise an
      // accounting journal that was already posted for this movement — that would
      // silently drift the GL sub-ledger from inventory. Block the edit once a
      // journal exists; the operator posts a reversing adjustment (which carries
      // its own compensating journal) instead.
      // Ignore CANCELLED rows (deliberately abandoned — never re-queued, so they
      // never reach the ledger). PENDING/PROCESSING/SYNCED block (posted or will
      // post); FAILED also blocks because it can be re-queued by reconciliation
      // and would then post the OLD value, drifting from the edited inventory.
      const postedJournal = await tx.accountingSyncLog.findFirst({
        where: {
          referenceType: 'StockMovement',
          referenceId: id,
          type: 'INVENTORY_ADJUSTMENT',
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      })
      if (postedJournal) {
        throw new Error(
          'This adjustment has been posted to accounting. Create a reversing adjustment ' +
          'instead of editing it in place, so the ledger stays consistent.',
        )
      }

      const newWarehouseId = oldWarehouseId // warehouse can't be changed via edit
      // Take the FOR UPDATE lock before any cost-sensitive read (stock level,
      // candidate layers, average cost) so a concurrent consume between the read
      // and the new layer's creation cannot cost it against stale state. The
      // addition branch previously read getAverageUnitCost unlocked (scjz.3).
      await lockStockLevelRow(tx, movement.productId, newWarehouseId)
      const currentLevel = await tx.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: movement.productId, warehouseId: newWarehouseId } },
        select: { quantity: true, reservedQty: true },
      })
      const { stockDelta, resultingQuantity } = calculateAdjustmentStockDelta({
        oldSignedQty,
        newSignedQty,
        currentQuantity: currentLevel?.quantity,
        currentReservedQty: currentLevel?.reservedQty,
      })

      // audit-H9: validate the edit is feasible BEFORE mutating anything. The
      // old cleanup deleted the existing COGS/restored layers and only then
      // re-ran the strict FIFO consumption, so an impossible edit threw a
      // low-level "insufficient layers" error that just the surrounding
      // transaction rollback saved. Front-loading these checks rejects the edit
      // atomically with a clear, actionable message and zero mutation.
      let restorableConsumedQty: Prisma.Decimal = toDecimal(0)
      let removableLayerQty: Prisma.Decimal = toDecimal(0)
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
        removableLayerQty = toDecimal(layer.remainingQty)
      } else {
        if (movement.cogsEntries.length === 0) {
          throw new Error(
            'This adjustment was created before FIFO edit tracking was enabled. ' +
            'Create a reversing adjustment instead of editing it in place.',
          )
        }
        // Decimal accumulation: avoid IEEE-754 drift across many COGS entries.
        restorableConsumedQty = movement.cogsEntries.reduce(
          (sum, entry) => addMoney(sum, entry.qty),
          toDecimal(0),
        )
      }

      if (!newIsAddition) {
        // Match consumeFifoLayersStrict's filter: only layers with remainingQty > 0 form the pool.
        const layerAgg = await tx.costLayer.aggregate({
          where: { productId: movement.productId, warehouseId: newWarehouseId, remainingQty: { gt: 0 } },
          _sum: { remainingQty: true },
        })
        assertAdjustmentEditFifoFeasible({
          newIsAddition,
          newAbsQty: Math.abs(newSignedQty),
          currentRemainingLayerQty: layerAgg._sum.remainingQty,
          restorableConsumedQty,
          removableLayerQty,
        })
      }

      if (stockDelta !== 0) {
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId: movement.productId, warehouseId: newWarehouseId } },
          create: {
            productId: movement.productId,
            warehouseId: newWarehouseId,
            quantity: resultingQuantity.toString(),
          },
          update: { quantity: { increment: stockDelta } },
        })
      }

      // Cleanup — feasibility and the layer/cogs preconditions were already
      // validated above, so these are pure mutations now.
      if (oldIsAddition) {
        await tx.costLayer.deleteMany({ where: { adjustmentMovementId: id } })
      } else {
        for (const entry of movement.cogsEntries) {
          await tx.costLayer.update({
            where: { id: entry.costLayerId },
            data: { remainingQty: { increment: Number(entry.qty) } },
          })
        }
        await tx.cogsEntry.deleteMany({ where: { movementId: id } })
      }

      let nextMovementValueFields: ReturnType<typeof buildStockMovementValueFields> | ReturnType<typeof buildStockMovementValueFieldsFromConsumed>
      if (newIsAddition) {
        // ycnj: preserve the ORIGINAL addition layer's unit cost on a qty edit, so
        // a re-booked addition isn't silently revalued at the current average
        // (e.g. a £0 sample, or +10 @ £2 → +12, must keep £2 not become average).
        // Only a removal→addition edit (no original addition layer to inherit a
        // cost from) falls back to the derived warehouse/historical average.
        const originalUnitCost = oldIsAddition ? Number(movement.adjustmentLayers[0]?.unitCostBase) : NaN
        let unitCostBase: number
        if (Number.isFinite(originalUnitCost) && originalUnitCost >= 0) {
          unitCostBase = originalUnitCost
        } else {
          const warehouseAvgCost = await getAverageUnitCost(tx, movement.productId, newWarehouseId)
          unitCostBase = warehouseAvgCost > 0 ? warehouseAvgCost : await getHistoricalAverageUnitCost(tx, movement.productId)
        }
        nextMovementValueFields = buildStockMovementValueFields({ qty: Math.abs(newSignedQty), unitCostBase })
        await createCostLayer(tx, {
          productId: movement.productId,
          warehouseId: newWarehouseId,
          qty: Math.abs(newSignedQty),
          unitCostBase,
          receivedAt: movement.createdAt,
          isOpeningStock: false,
          adjustmentMovementId: id,
        })
      } else {
        // Feasibility was pre-checked above against an unlocked aggregate read. If a
        // concurrent movement consumed the pool in between, the strict consume (which
        // locks layers FOR UPDATE) is the source of truth — surface the same actionable
        // message rather than the low-level "insufficient layers" error.
        let consumed: Awaited<ReturnType<typeof consumeFifoLayersStrict>>['consumed']
        try {
          ({ consumed } = await consumeFifoLayersStrict(tx, movement.productId, newWarehouseId, Math.abs(newSignedQty)))
        } catch {
          throw new Error(
            `Cannot edit this adjustment to remove ${Math.abs(newSignedQty)} unit(s): the cost ` +
            `layers were consumed by another movement during the edit. Retry, reverse the later ` +
            `movements first, or create a compensating adjustment instead.`,
          )
        }
        nextMovementValueFields = buildStockMovementValueFieldsFromConsumed(consumed, newAbsQty)
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => cogsEntryDataFromConsumed(id, entry)),
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
          ...nextMovementValueFields,
          note: newNote || null,
        },
      })
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control')
    revalidatePath('/inventory')
    const movement = await db.stockMovement.findUnique({
      where: { id },
      select: { productId: true, fromWarehouseId: true, toWarehouseId: true },
    })
    if (movement?.productId) {
      const netDelta = newSignedQty - oldSignedQtyForLog
      const warehouseId = movement.toWarehouseId ?? movement.fromWarehouseId
      if (netDelta > 0) {
        try {
          await allocateBackordersForProducts([movement.productId], {
            source: 'stock_adjustment',
            referenceId: id,
            referenceLabel: `adjustment edit (net +${netDelta})`,
          })
        } catch (allocError) {
          await logStockSideEffectFailure('backorder_allocation', allocError)
        }
      } else if (netDelta < 0 && warehouseId) {
        try {
          await releaseOverallocations(
            [{ productId: movement.productId, warehouseId }],
            { source: 'stock_adjustment', referenceId: id, referenceLabel: `adjustment edit (net ${netDelta})` },
          )
        } catch (rebalanceError) {
          await logStockSideEffectFailure('overallocation_release', rebalanceError)
        }
      }
      try {
        await enqueueStockSync([movement.productId], 'IMS_CHANGE')
      } catch (syncError) {
        await logStockSideEffectFailure('stock_sync_enqueue', syncError)
      }
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
    const message = toInventoryConstraintMessage(e, 'Failed to update adjustment.')
    console.error(e)

    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'adjustment_updated',
      tag: 'stock',
      level: 'ERROR',
      description: message,
    })

    return { message }
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
    const { data, error } = await wcFetch('/products', { sku, per_page: '1' })
    if (error) return { imageUrl: null, error }
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
    select: { id: true, code: true, name: true, type: true, country: true, contactName: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, postcode: true, isDefault: true },
    orderBy: { code: 'asc' },
  })
}

// ---------------------------------------------------------------------------
// Stock level map (productId → warehouseId → quantity)
// ---------------------------------------------------------------------------

const readScopedStockLevelMap = cache(async (
  productIdsKey: string | null,
  warehouseIdsKey: string | null,
  updatedSinceIso: string | null,
  skip: number | null,
  take: number | null,
): Promise<StockLevelMap> => {
  const productIds = productIdsKey ? JSON.parse(productIdsKey) as string[] : undefined
  const warehouseIds = warehouseIdsKey ? JSON.parse(warehouseIdsKey) as string[] : undefined
  const where: Prisma.StockLevelWhereInput = {}
  if (productIds) where.productId = { in: productIds }
  if (warehouseIds) where.warehouseId = { in: warehouseIds }
  if (updatedSinceIso) where.updatedAt = { gte: new Date(updatedSinceIso) }

  const levels = await db.stockLevel.findMany({
    where,
    select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
    skip: skip ?? undefined,
    take: take ?? undefined,
  })
  return buildStockLevelMap(levels)
})

export async function getScopedStockLevelMap(scope: StockLevelMapScope = {}): Promise<StockLevelMap> {
  await requireAuth()
  if (isEmptyStockLevelMapScope(scope)) return {}

  const normalized = normalizeStockLevelMapScope(scope)
  return readScopedStockLevelMap(
    normalized.productIds ? JSON.stringify(normalized.productIds) : null,
    normalized.warehouseIds ? JSON.stringify(normalized.warehouseIds) : null,
    normalized.updatedSince?.toISOString() ?? null,
    normalized.skip ?? null,
    normalized.take ?? null,
  )
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
  'WMS_RECEIPT_RECONCILIATION',
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
