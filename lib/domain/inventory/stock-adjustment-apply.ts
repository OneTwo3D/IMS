import type { Prisma } from '@/app/generated/prisma/client'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict, createCostLayer, getAverageUnitCost, getHistoricalAverageUnitCost, lockStockLevelRow } from '@/lib/cost-layers'
import { assertStockAdjustmentFeasible } from '@/lib/domain/inventory/stock-adjustment-edit'
import {
  buildStockMovementValueFields,
  buildStockMovementValueFieldsFromConsumed,
} from '@/lib/domain/inventory/stock-movement-value'
import { manualStockAdjustmentMovementKey } from '@/lib/domain/inventory/stock-movement-idempotency'

// Extracted from app/actions/stock.ts (6oyu.1) so non-action callers — the WMS
// stock-sync align-down path runs from a cron job — can post an adjustment
// without importing a 'use server' module from lib. Behaviour is unchanged; the
// stock actions call this same implementation.

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
  /**
   * 0tr0: per-submission idempotency token (a stable client-generated UUID that
   * survives retries of one submission). When supplied, the ADJUSTMENT movement key
   * is derived as a content fingerprint of this token plus the adjustment payload
   * (see manualStockAdjustmentMovementKey): a re-submission of the SAME adjustment
   * (network retry / double-click / refresh during pending) is detected under the
   * stock-level lock and skipped, while an edited resubmit gets a fresh key and
   * applies. Backed by StockMovement.idempotencyKey @unique.
   */
  idempotencyToken?: string | null
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
  unitCostBase,
  settings: providedSettings,
  referenceType,
  referenceId,
  idempotencyToken,
}: ApplyStockAdjustmentInput): Promise<AppliedStockAdjustment> {
  const isAddition = qty > 0
  // 0tr0/r9y2: content-addressed key from the per-submission token + payload, so an
  // edited resubmit gets a new key (not deduped) and same-key requests always target
  // the same stock row (serialised by the lock below).
  const idempotencyKey = idempotencyToken
    ? manualStockAdjustmentMovementKey({
        token: idempotencyToken,
        productId,
        warehouseId,
        qty,
        reasonId,
        note,
        unitCostBase,
        referenceType,
        referenceId,
      })
    : null
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

  // 0tr0: idempotency check UNDER the stock-level lock. Same-(product,warehouse)
  // re-submissions serialise here, so a duplicate carrying the same key sees the
  // first submission's committed movement and returns it instead of double-booking.
  if (idempotencyKey) {
    const existing = await tx.stockMovement.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    })
    if (existing) {
      const [product, warehouse] = await Promise.all([
        tx.product.findUnique({ where: { id: productId }, select: { sku: true } }),
        tx.warehouse.findUnique({ where: { id: warehouseId }, select: { name: true } }),
      ])
      return {
        movementId: existing.id,
        productSku: product?.sku ?? productId,
        warehouseName: warehouse?.name ?? warehouseId,
      }
    }
  }

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
      ...(idempotencyKey ? { idempotencyKey } : {}),
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
